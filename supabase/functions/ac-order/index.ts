// AllergenCheck – Bestellung (Neukunde) bzw. Verlängerung mit vorhandenem Lizenzcode.
// Legt Abo (pending) + Rechnung an und schickt die Rechnungs-Mail mit Zahlungslink.
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const SITE = "https://allergencheck.vaydena.de";
const PLANS: Record<string, { cents: number; label: string }> = {
  month: { cents: 1200, label: "Monatsabo (1 Monat)" },
  year: { cents: 11900, label: "Jahresabo (12 Monate)" },
};
const MIN_FILL_MS = 3000;
const GLOBAL_PER_HOUR = 60;
const IP_PER_DAY = 10;
const AGB_VERSION = "2026-09";
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|ru|cn|xyz|top|info|biz|io|de)\b\/?)/i;

function clientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0] || req.headers.get("x-real-ip") || "").trim();
}
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashIp(ip: string) {
  if (!ip) return "";
  const salt = Deno.env.get("IP_HASH_SALT") || Deno.env.get("SUPABASE_DB_URL") || "";
  return (await sha256hex(salt + "|" + ip)).slice(0, 32);
}
async function rateOk(bucket: string, ip: string, limit: number, windowSecs: number): Promise<boolean> {
  try {
    const iph = (await sha256hex(ip)).slice(0, 40);
    const rows = await sql`
      insert into allergencheck.rate_hits (bucket, iphash, reset_at, hits)
      values (${bucket}, ${iph}, now() + make_interval(secs => ${windowSecs}), 1)
      on conflict (bucket, iphash) do update set
        hits = case when allergencheck.rate_hits.reset_at < now() then 1 else allergencheck.rate_hits.hits + 1 end,
        reset_at = case when allergencheck.rate_hits.reset_at < now() then now() + make_interval(secs => ${windowSecs}) else allergencheck.rate_hits.reset_at end
      returning hits`;
    if (Math.random() < 0.02) {
      try { await sql`delete from allergencheck.rate_hits where reset_at < now() - interval '1 day'`; } catch (_e) { /* egal */ }
    }
    return Number(rows[0].hits) <= limit;
  } catch (_e) {
    return true; // fail-open
  }
}

function str(v: unknown, max?: number) { return (typeof v === "string" ? v : "").trim().slice(0, max || 500); }
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string)); }
function euro(cents: number) { return ((Number(cents) || 0) / 100).toFixed(2).replace(".", ",") + " €"; }
function dmy(d: unknown) { if (!d) return ""; const s = d instanceof Date ? d.toISOString() : String(d); const p = s.slice(0, 10).split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : s; }

function withTimeout<T>(p: Promise<T>, ms: number) {
  let t: number;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
async function sendMail(to: string, subject: string, text: string, html: string) {
  const user = Deno.env.get("MAIL_USER");
  const pass = Deno.env.get("MAIL_PASSWORD");
  if (!user || !pass) return { ok: false, err: "mail_not_configured" };
  const host = Deno.env.get("MAIL_SMTP_HOST") || "smtp.hostinger.com";
  const port = Number(Deno.env.get("MAIL_SMTP_PORT") || "465");
  const from = Deno.env.get("MAIL_FROM") || user;
  // deno-lint-ignore no-explicit-any
  let SMTPClient: any;
  try { ({ SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts")); }
  catch (e) { return { ok: false, err: "smtp_module:" + String((e && (e as Error).message) || e) }; }
  const client = new SMTPClient({ connection: { hostname: host, port, tls: true, auth: { username: user, password: pass } } });
  try {
    await withTimeout(client.send({ from: "AllergenCheck <" + from + ">", to, subject, content: text, html }), 20000);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && (e as Error).message) || e) };
  } finally {
    try { await withTimeout(client.close(), 5000); } catch (_e) { /* ignore */ }
  }
}

function invoiceMail(p: { name: string; number: string; cents: number; plan: string; renewal: boolean; period?: string; link: string }) {
  const planLabel = PLANS[p.plan].label;
  const text = `Guten Tag ${p.name},

vielen Dank für ${p.renewal ? "Ihre Verlängerung" : "Ihre Bestellung"} von AllergenCheck.

Rechnungsnummer: ${p.number}
Leistung: AllergenCheck ${planLabel}${p.period ? "\nZeitraum: " + p.period : ""}
Betrag: ${euro(p.cents)} (gemäß § 19 UStG ohne Umsatzsteuer)

Bitte überweisen Sie den Betrag innerhalb von 14 Tagen. Ihre Rechnung mit
allen Bankdaten und einem QR-Code für Ihre Banking-App finden Sie hier:
${p.link}

${p.renewal ? "Nach Zahlungseingang verlängert sich Ihr Zugang automatisch – in der App ist nichts zu tun." : "Sobald Ihre Zahlung eingegangen ist, erhalten Sie Ihren Lizenzcode per E-Mail.\nBis dahin können Sie die kostenlose Testphase uneingeschränkt weiter nutzen."}

Es gibt keine automatische Abbuchung. Vor Ablauf des Zeitraums senden wir
Ihnen rechtzeitig die Rechnung für den nächsten Zeitraum.

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;
  const html = `<div style='font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2a20;max-width:560px;margin:0 auto'>`
    + `<h2 style='color:#2d6a3e;margin:0 0 12px'>${p.renewal ? "Ihre Verlängerung" : "Vielen Dank für Ihre Bestellung"}</h2>`
    + `<p>Guten Tag ${esc(p.name)},</p><p>vielen Dank für ${p.renewal ? "Ihre Verlängerung" : "Ihre Bestellung"} von AllergenCheck.</p>`
    + `<table style='font-size:15px;border-collapse:collapse'>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Rechnungsnummer</td><td><b>${esc(p.number)}</b></td></tr>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Leistung</td><td>AllergenCheck ${esc(planLabel)}</td></tr>`
    + (p.period ? `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Zeitraum</td><td>${esc(p.period)}</td></tr>` : "")
    + `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Betrag</td><td><b>${esc(euro(p.cents))}</b></td></tr></table>`
    + `<p style='margin:22px 0'><a href='${esc(p.link)}' style='background:#2d6a3e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block'>Rechnung ansehen &amp; bezahlen</a></p>`
    + `<p style='font-size:14px;color:#5d6d61'>Oder Link kopieren:<br><span style='word-break:break-all'>${esc(p.link)}</span></p>`
    + `<p style='font-size:13px;color:#5d6d61'>${p.renewal ? "Nach Zahlungseingang verlängert sich Ihr Zugang automatisch." : "Nach Zahlungseingang erhalten Sie Ihren <b>Lizenzcode</b> per E-Mail. Bis dahin läuft Ihre Testphase normal weiter."} Keine automatische Abbuchung.</p>`
    + `<p style='font-size:13px;color:#5d6d61'>Herzliche Grüße<br>Ihr Vaydena-Team &middot; kontakt@vaydena.de</p></div>`;
  return { text, html };
}

async function notifyOperator(subject: string, lines: string[]) {
  const opTo = Deno.env.get("MAIL_FROM") || Deno.env.get("MAIL_USER") || "";
  if (!opTo) return;
  const t = lines.join("\n");
  try { await sendMail(opTo, subject, t, `<pre style='font-family:inherit;white-space:pre-wrap'>${esc(t)}</pre>`); } catch (_e) { /* ignore */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (str(body?.hp, 100)) return json({ ok: true, spam: true });
  const elapsed = Number(body?.elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return json({ error: "too_fast" }, 400);

  const plan = str(body?.plan, 10);
  if (!PLANS[plan]) return json({ error: "bad_plan" }, 400);
  const ip = clientIp(req) || "unknown";
  if (!(await rateOk("order", ip, 6, 3600))) return json({ error: "rate_limited" }, 429);

  // ---- Verlängerung mit vorhandenem Lizenzcode ----
  const tokenNorm = str(body?.token, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (tokenNorm) {
    try {
      const subs = await sql`select * from allergencheck.subscriptions
                              where token is not null and regexp_replace(upper(token), '[^A-Z0-9]', '', 'g') = ${tokenNorm} limit 1`;
      if (!subs.length) return json({ error: "unknown_token" }, 404);
      const s = subs[0];
      if (s.status === "revoked") return json({ error: "revoked" }, 409);
      const open = await sql`select number, access_token from allergencheck.invoices where subscription_id = ${s.id} and status = 'open' order by created_at desc limit 1`;
      if (open.length) return json({ ok: true, existing: true, number: open[0].number, pay_link: SITE + "/zahlung.html?r=" + open[0].access_token });
      const inv = await sql.begin(async (tx: any) => {
        const seq = await tx`select nextval('allergencheck.invoice_seq') as v`;
        const number = "AC-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
        const per = plan === "year" ? "12 months" : "1 month";
        const rows = await tx`insert into allergencheck.invoices (number, subscription_id, kind, plan, amount_cents, period_from, period_to)
          values (${number}, ${s.id}, 'renewal', ${plan}, ${PLANS[plan].cents},
                  greatest(coalesce(${s.valid_until}::date + 1, current_date), current_date),
                  greatest(coalesce(${s.valid_until}::date + 1, current_date), current_date) + ${per}::interval - interval '1 day')
          returning number, access_token, period_from, period_to`;
        return rows[0];
      });
      const link = SITE + "/zahlung.html?r=" + inv.access_token;
      const m = invoiceMail({ name: s.name, number: inv.number, cents: PLANS[plan].cents, plan, renewal: true, period: dmy(inv.period_from) + " – " + dmy(inv.period_to), link });
      const sent = await sendMail(s.email, "Ihre AllergenCheck-Rechnung " + inv.number, m.text, m.html);
      if (sent.ok) await sql`update allergencheck.invoices set mailed_at = now() where number = ${inv.number}`;
      await notifyOperator("AllergenCheck: Verlängerung angefordert " + inv.number, ["Kunde: " + s.company + " (" + s.email + ")", "Tarif: " + PLANS[plan].label, "Betrag: " + euro(PLANS[plan].cents), "Zahlseite: " + link]);
      return json({ ok: true, renewal: true, number: inv.number, pay_link: link, emailed: sent.ok });
    } catch (_e) {
      return json({ error: "server_error" }, 500);
    }
  }

  // ---- Neubestellung ----
  const company = str(body?.company, 160);
  const name = str(body?.name, 120);
  const email = str(body?.email, 160).toLowerCase();
  const street = str(body?.street, 160), zip = str(body?.zip, 20), city = str(body?.city, 120), country = str(body?.country, 60) || "Deutschland";
  const vat_id = str(body?.vat_id, 30);
  if (company.length < 2) return json({ error: "bad_company" }, 400);
  if (name.length < 2) return json({ error: "bad_name" }, 400);
  if (!isEmail(email)) return json({ error: "bad_email" }, 400);
  if (street.length < 3 || zip.length < 4 || city.length < 2) return json({ error: "bad_address" }, 400);
  if ([company, name, street, zip, city, country, vat_id].some((v) => URL_RE.test(v))) return json({ error: "bad_input" }, 400);
  if (body?.b2b !== true) return json({ error: "b2b_required" }, 400);
  if (body?.agb !== true) return json({ error: "agb_required" }, 400);
  if (body?.privacy !== true) return json({ error: "consent_required" }, 400);

  const consents = { b2b: true, agb: true, privacy: true, agb_version: AGB_VERSION, at: new Date().toISOString() };
  const billing = { company, name, street, zip, city, country, vat_id, email };
  const ip_hash = await hashIp(ip);

  let inv: { number: string; access_token: string };
  try {
    const res = await sql.begin(async (tx: any) => {
      await tx`select pg_advisory_xact_lock(hashtext('allergencheck-order'))`;
      const byMail = await tx`select count(*)::int as c from allergencheck.subscriptions where lower(email) = ${email} and created_at > now() - interval '1 day'`;
      if (byMail[0].c >= 5) return { limited: true };
      const global = await tx`select count(*)::int as c from allergencheck.subscriptions where created_at > now() - interval '1 hour'`;
      if (global[0].c >= GLOBAL_PER_HOUR) return { limited: true };
      if (ip_hash) {
        const byIp = await tx`select count(*)::int as c from allergencheck.order_attempts where ip_hash = ${ip_hash} and created_at > now() - interval '1 day'`;
        if (byIp[0].c >= IP_PER_DAY) return { limited: true };
        await tx`insert into allergencheck.order_attempts (ip_hash) values (${ip_hash})`;
        await tx`delete from allergencheck.order_attempts where created_at < now() - interval '7 days'`;
      }
      const sub = await tx`insert into allergencheck.subscriptions (plan, company, name, email, billing, consents, notes)
        values (${plan}, ${company}, ${name}, ${email}, ${billing}::jsonb, ${consents}::jsonb, 'Selbstbestellung')
        returning id`;
      const seq = await tx`select nextval('allergencheck.invoice_seq') as v`;
      const number = "AC-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
      const rows = await tx`insert into allergencheck.invoices (number, subscription_id, kind, plan, amount_cents)
        values (${number}, ${sub[0].id}, 'first', ${plan}, ${PLANS[plan].cents}) returning number, access_token`;
      return { limited: false, row: rows[0] };
    });
    if (res.limited) return json({ error: "rate_limited" }, 429);
    inv = res.row;
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }

  const link = SITE + "/zahlung.html?r=" + inv.access_token;
  const m = invoiceMail({ name, number: inv.number, cents: PLANS[plan].cents, plan, renewal: false, period: plan === "year" ? "12 Monate ab Zahlungseingang" : "1 Monat ab Zahlungseingang", link });
  const sent = await sendMail(email, "Ihre AllergenCheck-Rechnung " + inv.number, m.text, m.html);
  if (sent.ok) { try { await sql`update allergencheck.invoices set mailed_at = now() where number = ${inv.number}`; } catch (_e) { /* egal */ } }
  try { console.log("order mail", sent.ok, sent.err || ""); } catch (_e) { /* ignore */ }
  await notifyOperator("Neue AllergenCheck-Bestellung: " + inv.number, [
    "Firma: " + company, "Ansprechpartner: " + name, "E-Mail: " + email,
    "Anschrift: " + street + ", " + zip + " " + city + ", " + country + (vat_id ? " · USt-IdNr. " + vat_id : ""),
    "Tarif: " + PLANS[plan].label, "Betrag: " + euro(PLANS[plan].cents), "Zahlseite: " + link, "",
    "-> Nach Zahlungseingang im Betreiber-Bereich 'Bezahlt' klicken (versendet den Lizenzcode).",
  ]);
  return json({ ok: true, number: inv.number, pay_link: link, amount_cents: PLANS[plan].cents, emailed: sent.ok });
});
