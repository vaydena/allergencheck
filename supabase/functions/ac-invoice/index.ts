// AllergenCheck – Rechnungsdaten für zahlung.html (per access_token aus dem Zahlungslink).
import postgres from "npm:postgres@3";
import QRCode from "npm:qrcode@1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

const BANK = { holder: "Karl-Heinz Bicker", iban: "DE95700510030000785303", bic: "BYLADEM1FSI" };
const ISSUER = {
  name: "Vaydena - Softwarelösungen",
  owner: "Karl-Heinz Bicker",
  street: "Biberstraße 27",
  zip: "85354",
  city: "Freising",
  email: "kontakt@vaydena.de",
  tel: "0151-24012554",
};
const TAX_NOTE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";
const ITEMS: Record<string, string> = {
  month: "AllergenCheck – Monatsabo (Allergenkennzeichnung, 1 Monat)",
  year: "AllergenCheck – Jahresabo (Allergenkennzeichnung, 12 Monate)",
};

function formatIban(iban: string) { return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim(); }
function dmy(s: unknown): string {
  if (!s) return "";
  const str = (s instanceof Date) ? s.toISOString() : String(s);
  const p = str.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : str;
}
// Datum (date-Spalte) als lokales YYYY-MM-DD, ohne Zeitzonenverschiebung
function ymd(d: unknown): string {
  if (!d) return "";
  if (d instanceof Date) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return String(d).slice(0, 10);
}

function buildEpcPayload(p: { holder: string; iban: string; bic: string; amount: number; reference: string }): string | null {
  const holder = p.holder.trim();
  const iban = p.iban.replace(/\s+/g, "").toUpperCase();
  const bic = (p.bic || "").replace(/\s+/g, "").toUpperCase();
  const reference = (p.reference || "").trim();
  if (!holder || holder.length > 70 || !iban || iban.length > 34) return null;
  if (bic && bic.length !== 8 && bic.length !== 11) return null;
  if (reference.length > 140 || !Number.isFinite(p.amount)) return null;
  const amount = Math.round(p.amount * 100) / 100;
  if (amount < 0.01) return null;
  const payload = ["BCD", "002", "1", "SCT", bic, holder, iban, `EUR${amount.toFixed(2)}`, "", "", reference].join("\n");
  if (new TextEncoder().encode(payload).length > 331) return null;
  return payload;
}
function buildGiro(p: { holder: string; iban: string; bic: string; amount: number; reference: string }) {
  const payload = buildEpcPayload(p);
  if (!payload) return null;
  try {
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size, data = qr.modules.data, quiet = 4;
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (data[r * n + c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return { path, size: n + quiet * 2 };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const token = String(body?.access_token ?? "").trim();
  if (!/^[0-9a-f]{48}$/.test(token)) return json({ found: false });
  try {
    const rows = await sql`
      select i.number, i.kind, i.plan, i.amount_cents, i.period_from, i.period_to, i.status, i.created_at, i.paid_at,
             s.company, s.name, s.billing, s.valid_until
        from allergencheck.invoices i join allergencheck.subscriptions s on s.id = i.subscription_id
       where i.access_token = ${token} limit 1`;
    if (!rows.length) return json({ found: false });
    const l = rows[0];
    const amount = l.amount_cents / 100;
    const isOpen = l.status === "open";
    const reference = String(l.number).slice(0, 140);
    const bill = (l.billing && typeof l.billing === "object") ? l.billing : {};
    const period = l.period_from && l.period_to
      ? dmy(ymd(l.period_from)) + " – " + dmy(ymd(l.period_to))
      : (l.plan === "year" ? "12 Monate ab Zahlungseingang" : "1 Monat ab Zahlungseingang");
    return json({
      found: true,
      number: l.number,
      kind: l.kind,
      plan: l.plan,
      amount,
      unit_count: 1,
      unit_price: amount,
      item: ITEMS[l.plan] || "AllergenCheck",
      period,
      status: l.status,
      paid_at: l.paid_at,
      paid_at_dmy: dmy(l.paid_at),
      issued: l.created_at,
      issued_dmy: dmy(l.created_at),
      valid_until_dmy: l.valid_until ? dmy(ymd(l.valid_until)) : "",
      buyer_name: l.company,
      reference,
      bank: isOpen ? { holder: BANK.holder, iban: formatIban(BANK.iban), bic: BANK.bic } : null,
      giro: isOpen ? buildGiro({ ...BANK, amount, reference }) : null,
      billing: {
        recipient: String(bill.company || l.company || ""),
        contact: String(bill.name || l.name || ""),
        street: String(bill.street || ""),
        zip: String(bill.zip || ""),
        city: String(bill.city || ""),
        country: String(bill.country || ""),
        vat_id: String(bill.vat_id || ""),
      },
      issuer: ISSUER,
      tax_note: TAX_NOTE,
    });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
