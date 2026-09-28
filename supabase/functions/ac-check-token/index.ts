// AllergenCheck – Lizenzcode prüfen. Antwort: {valid, valid_until, plan, name, reason}.
// Gültig bis valid_until + GRACE_DAYS (Zeit für die Überweisung der Verlängerung).
import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const GRACE_DAYS = 3;

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
function ymd(d: unknown): string {
  if (!d) return "";
  if (d instanceof Date) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return String(d).slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const norm = String(body?.token ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm || norm.length > 30) return json({ valid: false, reason: "unknown" });
  // Antwort bewusst ohne JSON → App wertet das als "kurz nicht erreichbar", nicht als ungültig.
  if (!(await rateOk("check", clientIp(req), 60, 60))) return new Response("rate_limited", { status: 429, headers: cors });
  try {
    const rows = await sql`
      select id, status, plan, company, valid_until,
             (valid_until is not null and valid_until + ${GRACE_DAYS}::int >= current_date) as in_time
        from allergencheck.subscriptions
       where token is not null and regexp_replace(upper(token), '[^A-Z0-9]', '', 'g') = ${norm}
       limit 1`;
    if (!rows.length) return json({ valid: false, reason: "unknown" });
    const s = rows[0];
    try { await sql`update allergencheck.subscriptions set last_check_at = now() where id = ${s.id}`; } catch (_e) { /* egal */ }
    const base = { plan: s.plan, valid_until: ymd(s.valid_until), name: s.company };
    if (s.status === "revoked") return json({ valid: false, reason: "revoked" });
    if (s.status === "pending") return json({ valid: false, reason: "not_active" });
    if (!s.in_time) return json({ valid: false, reason: "expired", ...base });
    return json({ valid: true, ...base, cancelled: s.status === "cancelled" });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
