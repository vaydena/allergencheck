// AllergenCheck – Betreiber-API (betreiber.html). Auth per Header x-admin-key (SHA-256 in admin_auth).
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const SITE = "https://allergencheck.vaydena.de";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLANS: Record<string, { cents: number; label: string; per: string }> = {
  month: { cents: 1200, label: "Monatsabo (1 Monat)", per: "1 month" },
  year: { cents: 11900, label: "Jahresabo (12 Monate)", per: "12 months" },
};
const GRACE_DAYS = 3;

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(15));
  let s = "";
  for (let i = 0; i < 15; i++) s += ALPHA[b[i] % ALPHA.length];
  return "AC-" + s.slice(0, 5) + "-" + s.slice(5, 10) + "-" + s.slice(10, 15);
}
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || (req.headers.get("cf-connecting-ip") || "").trim() || "unknown";
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
    return Number(rows[0].hits) <= limit;
  } catch (_e) {
    return true;
  }
}
function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string)); }
function euro(cents: number) { return ((Number(cents) || 0) / 100).toFixed(2).replace(".", ",") + " €"; }
function ymd(d: unknown): string {
  if (!d) return "";
  if (d instanceof Date) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return String(d).slice(0, 10);
}
function dmy(d: unknown) { const s = ymd(d); const p = s.split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : s; }

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
function wrap(title: string, inner: string) {
  return `<div style='font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d2a20;max-width:560px;margin:0 auto'>`
    + `<h2 style='color:#2d6a3e;margin:0 0 12px'>${esc(title)}</h2>${inner}`
    + `<p style='font-size:13px;color:#5d6d61'>Herzliche Grüße<br>Ihr Vaydena-Team &middot; kontakt@vaydena.de</p></div>`;
}
const BTN = "background:#2d6a3e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block";

// deno-lint-ignore no-explicit-any
async function mailInvoice(s: any, inv: any) {
  const link = SITE + "/zahlung.html?r=" + inv.access_token;
  const renewal = inv.kind === "renewal";
  const period = inv.period_from ? dmy(inv.period_from) + " – " + dmy(inv.period_to) : (inv.plan === "year" ? "12 Monate ab Zahlungseingang" : "1 Monat ab Zahlungseingang");
  const text = `Guten Tag ${s.name},

${renewal ? "Ihr AllergenCheck-Zugang läuft am " + dmy(s.valid_until) + " ab. Anbei die Rechnung für den nächsten Zeitraum." : "anbei Ihre Rechnung für AllergenCheck."}

Rechnungsnummer: ${inv.number}
Leistung: AllergenCheck ${PLANS[inv.plan].label}
Zeitraum: ${period}
Betrag: ${euro(inv.amount_cents)} (gemäß § 19 UStG ohne Umsatzsteuer)

Rechnung, Bankdaten und QR-Code für Ihre Banking-App:
${link}

Nach Zahlungseingang verlängert sich Ihr Zugang automatisch – in der App ist nichts zu tun.
Sie möchten nicht verlängern? Dann einfach nicht überweisen und kurz an kontakt@vaydena.de schreiben.

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;
  const html = wrap(renewal ? "Rechnung für den nächsten Zeitraum" : "Ihre Rechnung",
    `<p>Guten Tag ${esc(s.name)},</p><p>${renewal ? "Ihr AllergenCheck-Zugang läuft am <b>" + dmy(s.valid_until) + "</b> ab. Anbei die Rechnung für den nächsten Zeitraum." : "anbei Ihre Rechnung für AllergenCheck."}</p>`
    + `<table style='font-size:15px;border-collapse:collapse'><tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Rechnungsnummer</td><td><b>${esc(inv.number)}</b></td></tr>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Zeitraum</td><td>${esc(period)}</td></tr>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5d6d61'>Betrag</td><td><b>${esc(euro(inv.amount_cents))}</b></td></tr></table>`
    + `<p style='margin:22px 0'><a href='${esc(link)}' style='${BTN}'>Rechnung ansehen &amp; bezahlen</a></p>`
    + `<p style='font-size:13px;color:#5d6d61'>Nach Zahlungseingang verlängert sich Ihr Zugang automatisch. Sie möchten nicht verlängern? Dann einfach nicht überweisen und kurz Bescheid geben.</p>`);
  const r = await sendMail(s.email, "Ihre AllergenCheck-Rechnung " + inv.number, text, html);
  if (r.ok) await sql`update allergencheck.invoices set mailed_at = now() where id = ${inv.id}`;
  return r;
}
// deno-lint-ignore no-explicit-any
async function mailCode(s: any) {
  const link = SITE + "/app.html?k=" + encodeURIComponent(s.token);
  const text = `Guten Tag ${s.name},

vielen Dank – Ihre Zahlung ist eingegangen. Ihr AllergenCheck-Abo ist aktiv bis ${dmy(s.valid_until)}.

Ihr Lizenzcode: ${s.token}

So aktivieren Sie ihn:
1) Öffnen Sie AllergenCheck auf dem Gerät, auf dem Sie bisher gearbeitet haben
2) Mehr → Lizenz → Code eingeben: ${s.token}

Oder direkt per Ein-Klick-Link (auf dem Gerät mit Ihren Daten öffnen):
${link}

Ihre Rezepturen bleiben dabei unverändert auf Ihrem Gerät. Den Code können Sie
auf allen Geräten Ihres Betriebs verwenden. Bitte vertraulich behandeln.

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;
  const html = wrap("AllergenCheck ist freigeschaltet",
    `<p>Guten Tag ${esc(s.name)},</p><p>vielen Dank – Ihre Zahlung ist eingegangen. Ihr Abo ist aktiv bis <b>${dmy(s.valid_until)}</b>.</p>`
    + `<p style='font-size:14px;color:#5d6d61;margin:0 0 4px'>Ihr Lizenzcode:</p>`
    + `<p style='font-size:24px;font-weight:800;letter-spacing:.06em;color:#2d6a3e;background:#e8f4e8;border-radius:10px;padding:14px 18px;text-align:center;font-family:ui-monospace,Consolas,monospace'>${esc(s.token)}</p>`
    + `<p style='margin:22px 0'><a href='${esc(link)}' style='${BTN}'>AllergenCheck öffnen &amp; aktivieren</a></p>`
    + `<p style='font-size:14px;color:#5d6d61'>Oder in der App unter <b>Mehr → Lizenz</b> den Code eingeben. Bitte den Link auf dem Gerät öffnen, auf dem Ihre Rezepturen gespeichert sind – die Daten bleiben unverändert.</p>`);
  return await sendMail(s.email, "Ihr AllergenCheck-Lizenzcode", text, html);
}
// deno-lint-ignore no-explicit-any
async function mailExtended(s: any, inv: any) {
  const text = `Guten Tag ${s.name},

vielen Dank – Ihre Zahlung zur Rechnung ${inv.number} ist eingegangen.
Ihr AllergenCheck-Zugang ist jetzt gültig bis ${dmy(s.valid_until)}.
In der App ist nichts zu tun (sie aktualisiert sich beim nächsten Online-Start).

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;
  const html = wrap("Zahlung erhalten – vielen Dank",
    `<p>Guten Tag ${esc(s.name)},</p><p>Ihre Zahlung zur Rechnung <b>${esc(inv.number)}</b> ist eingegangen. Ihr Zugang ist jetzt gültig bis <b>${dmy(s.valid_until)}</b>.</p><p style='font-size:14px;color:#5d6d61'>In der App ist nichts zu tun – sie aktualisiert sich beim nächsten Online-Start.</p>`);
  return await sendMail(s.email, "AllergenCheck verlängert bis " + dmy(s.valid_until), text, html);
}

// deno-lint-ignore no-explicit-any
async function createInvoice(tx: any, s: any, plan: string, kind: string) {
  const seq = await tx`select nextval('allergencheck.invoice_seq') as v`;
  const number = "AC-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
  const per = PLANS[plan].per;
  const rows = kind === "renewal"
    ? await tx`insert into allergencheck.invoices (number, subscription_id, kind, plan, amount_cents, period_from, period_to)
        values (${number}, ${s.id}, 'renewal', ${plan}, ${PLANS[plan].cents},
                greatest(coalesce(${s.valid_until}::date + 1, current_date), current_date),
                greatest(coalesce(${s.valid_until}::date + 1, current_date), current_date) + ${per}::interval - interval '1 day')
        returning *`
    : await tx`insert into allergencheck.invoices (number, subscription_id, kind, plan, amount_cents)
        values (${number}, ${s.id}, 'first', ${plan}, ${PLANS[plan].cents}) returning *`;
  return rows[0];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await rateOk("admin", clientIp(req), 120, 300))) return json({ error: "rate_limited" }, 429);

  const key = req.headers.get("x-admin-key") ?? "";
  if (!key) return json({ error: "unauthorized" }, 401);
  try {
    const hash = await sha256hex(key);
    let auth = await sql`select secret_sha256 from allergencheck.admin_auth where id = 1 limit 1`;
    if (!auth.length) { try { auth = await sql`select secret_sha256 from mediscan.admin_auth where id = 1 limit 1`; } catch (_e) { auth = [] as any; } }
    if (!auth.length || !safeEqual(String(auth[0].secret_sha256), hash)) return json({ error: "unauthorized" }, 401);
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();
  const sid = String(body?.subscription_id ?? "");
  const iid = String(body?.invoice_id ?? "");

  try {
    if (action === "list") {
      const subs = await sql`select id, token, plan, status, valid_until, company, name, email, billing, notes, created_at, activated_at, cancelled_at, revoked_at, last_check_at
                               from allergencheck.subscriptions order by created_at desc limit 1000`;
      const invs = await sql`select id, number, subscription_id, access_token, kind, plan, amount_cents, period_from, period_to, status, created_at, mailed_at, paid_at
                               from allergencheck.invoices order by created_at desc limit 3000`;
      return json({
        ok: true, today: ymd(new Date()),
        subscriptions: subs.map((s: any) => ({ ...s, valid_until: ymd(s.valid_until) })),
        invoices: invs.map((i: any) => ({ ...i, period_from: ymd(i.period_from), period_to: ymd(i.period_to), pay_link: SITE + "/zahlung.html?r=" + i.access_token })),
      });
    }

    if (action === "set_paid") {
      if (!UUID_RE.test(iid)) return json({ error: "bad_id" }, 400);
      const res = await sql.begin(async (tx: any) => {
        const ir = await tx`select * from allergencheck.invoices where id = ${iid} for update`;
        if (!ir.length) return { error: "not_found" };
        const inv = ir[0];
        if (inv.status === "paid") return { error: "already_paid" };
        if (inv.status === "cancelled") return { error: "is_cancelled" };
        const sr = await tx`select * from allergencheck.subscriptions where id = ${inv.subscription_id} for update`;
        const s = sr[0];
        if (s.status === "revoked") return { error: "is_revoked" };
        const per = PLANS[inv.plan].per;
        // Beginn: direkt anschließend, wenn noch gültig (inkl. Kulanz), sonst ab heute.
        const st = await tx`select case when ${s.valid_until}::date is not null and ${s.valid_until}::date + ${GRACE_DAYS}::int >= current_date
                                        then ${s.valid_until}::date + 1 else current_date end as start`;
        const start = st[0].start;
        const up = await tx`update allergencheck.invoices set status = 'paid', paid_at = now(),
                               period_from = ${start}::date, period_to = (${start}::date + ${per}::interval - interval '1 day')::date
                             where id = ${iid} returning *`;
        const first = !s.token;
        const token = s.token || genCode();
        const us = await tx`update allergencheck.subscriptions set token = ${token}, plan = ${inv.plan},
                               status = case when status = 'cancelled' and ${inv.kind} = 'first' then 'cancelled' else 'active' end,
                               cancelled_at = case when ${inv.kind} = 'renewal' then null else cancelled_at end,
                               activated_at = coalesce(activated_at, now()),
                               valid_until = greatest(coalesce(valid_until, ${up[0].period_to}::date), ${up[0].period_to}::date)
                             where id = ${s.id} returning *`;
        return { first, s: us[0], inv: up[0] };
      });
      if ((res as any).error) return json({ error: (res as any).error }, 409);
      const r = res as any;
      const mail = r.first ? await mailCode(r.s) : await mailExtended(r.s, r.inv);
      return json({ ok: true, first: r.first, token: r.s.token, valid_until: ymd(r.s.valid_until), emailed: mail.ok, mail_error: mail.ok ? undefined : mail.err });
    }

    if (action === "renew") {
      if (!UUID_RE.test(sid)) return json({ error: "bad_id" }, 400);
      const plan = String(body?.plan || "");
      const res = await sql.begin(async (tx: any) => {
        const sr = await tx`select * from allergencheck.subscriptions where id = ${sid} for update`;
        if (!sr.length) return { error: "not_found" };
        const s = sr[0];
        if (s.status === "revoked") return { error: "is_revoked" };
        if (!s.token) return { error: "not_active_yet" };
        const open = await tx`select 1 from allergencheck.invoices where subscription_id = ${sid} and status = 'open' limit 1`;
        if (open.length) return { error: "open_invoice_exists" };
        const inv = await createInvoice(tx, s, PLANS[plan] ? plan : s.plan, "renewal");
        return { s, inv };
      });
      if ((res as any).error) return json({ error: (res as any).error }, 409);
      const mail = await mailInvoice((res as any).s, (res as any).inv);
      return json({ ok: true, number: (res as any).inv.number, emailed: mail.ok, mail_error: mail.ok ? undefined : mail.err });
    }

    if (action === "renew_due") {
      const days = Math.max(1, Math.min(60, Number(body?.days) || 14));
      const due = await sql`select s.* from allergencheck.subscriptions s
                             where s.status = 'active' and s.token is not null and s.valid_until is not null
                               and s.valid_until <= current_date + ${days}::int
                               and s.valid_until + ${GRACE_DAYS}::int >= current_date
                               and not exists (select 1 from allergencheck.invoices i where i.subscription_id = s.id and i.status = 'open')
                             order by s.valid_until limit 200`;
      const out: unknown[] = [];
      for (const s of due) {
        const inv = await sql.begin(async (tx: any) => await createInvoice(tx, s, s.plan, "renewal"));
        const m = await mailInvoice(s, inv);
        out.push({ company: s.company, number: inv.number, emailed: m.ok });
      }
      return json({ ok: true, created: out.length, items: out });
    }

    if (action === "resend") {
      if (!UUID_RE.test(iid)) return json({ error: "bad_id" }, 400);
      const ir = await sql`select * from allergencheck.invoices where id = ${iid}`;
      if (!ir.length) return json({ error: "not_found" }, 404);
      const sr = await sql`select * from allergencheck.subscriptions where id = ${ir[0].subscription_id}`;
      const m = await mailInvoice(sr[0], ir[0]);
      return json({ ok: m.ok, emailed: m.ok, mail_error: m.ok ? undefined : m.err });
    }

    if (action === "resend_code") {
      if (!UUID_RE.test(sid)) return json({ error: "bad_id" }, 400);
      const sr = await sql`select * from allergencheck.subscriptions where id = ${sid}`;
      if (!sr.length) return json({ error: "not_found" }, 404);
      if (!sr[0].token) return json({ error: "no_code_yet" }, 409);
      if (sr[0].status === "revoked") return json({ error: "is_revoked" }, 409);
      const m = await mailCode(sr[0]);
      return json({ ok: m.ok, emailed: m.ok, mail_error: m.ok ? undefined : m.err });
    }

    if (action === "cancel_invoice") {
      if (!UUID_RE.test(iid)) return json({ error: "bad_id" }, 400);
      const r = await sql`update allergencheck.invoices set status = 'cancelled', cancelled_at = now() where id = ${iid} and status = 'open' returning id`;
      return r.length ? json({ ok: true }) : json({ error: "not_open" }, 409);
    }

    if (action === "cancel" || action === "uncancel" || action === "revoke" || action === "unrevoke") {
      if (!UUID_RE.test(sid)) return json({ error: "bad_id" }, 400);
      let r;
      if (action === "cancel") {
        r = await sql`update allergencheck.subscriptions set status = 'cancelled', cancelled_at = now() where id = ${sid} and status in ('active','pending') returning id`;
        await sql`update allergencheck.invoices set status = 'cancelled', cancelled_at = now() where subscription_id = ${sid} and status = 'open' and kind = 'renewal'`;
      } else if (action === "uncancel") {
        r = await sql`update allergencheck.subscriptions set status = case when token is null then 'pending' else 'active' end, cancelled_at = null where id = ${sid} and status = 'cancelled' returning id`;
      } else if (action === "revoke") {
        r = await sql`update allergencheck.subscriptions set status = 'revoked', revoked_at = now() where id = ${sid} and status <> 'revoked' returning id`;
        await sql`update allergencheck.invoices set status = 'cancelled', cancelled_at = now() where subscription_id = ${sid} and status = 'open'`;
      } else {
        r = await sql`update allergencheck.subscriptions set status = case when token is null then 'pending' else 'active' end, revoked_at = null where id = ${sid} and status = 'revoked' returning id`;
      }
      return r.length ? json({ ok: true }) : json({ error: "no_change" }, 409);
    }

    if (action === "set_valid_until") {
      if (!UUID_RE.test(sid)) return json({ error: "bad_id" }, 400);
      const d = String(body?.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "bad_date" }, 400);
      const r = await sql`update allergencheck.subscriptions set valid_until = ${d}::date where id = ${sid} returning id`;
      return r.length ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    if (action === "set_note") {
      if (!UUID_RE.test(sid)) return json({ error: "bad_id" }, 400);
      await sql`update allergencheck.subscriptions set notes = ${String(body?.notes || "").slice(0, 2000)} where id = ${sid}`;
      return json({ ok: true });
    }

    if (action === "export") {
      const rows = await sql`select i.number, i.kind, i.plan, i.amount_cents, i.status, i.created_at, i.paid_at, i.period_from, i.period_to,
                                    s.company, s.name, s.email, s.billing, s.token
                               from allergencheck.invoices i join allergencheck.subscriptions s on s.id = i.subscription_id
                              order by i.created_at`;
      return json({ ok: true, exported_at: new Date().toISOString(), invoices: rows.map((r: any) => ({ ...r, period_from: ymd(r.period_from), period_to: ymd(r.period_to) })) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    try { console.log("admin error", action, String((e as Error)?.message || e)); } catch (_x) { /* ignore */ }
    return json({ error: "server_error" }, 500);
  }
});
