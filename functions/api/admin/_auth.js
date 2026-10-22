// shared helpers (underscore file: imported, not routed)
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
/** returns null when authorized, else an error Response */
export async function checkAdmin(request, env) {
  if (!env.ADMIN_KEY) return json({ error: "admin not configured" }, 503);
  const key = request.headers.get("X-Admin-Key") || "";
  if (!key || key.length > 256 || !(await safeEqual(key, String(env.ADMIN_KEY)))) return json({ error: "unauthorized" }, 401);
  if (!env.PAIR_SYNC) return json({ error: "kv missing" }, 503);
  return null;
}
export const KEY_RE = /^[a-z0-9]{6,32}$/;
export const MAX_QUESTIONS_BYTES = 20 * 1024 * 1024; // KV value limit is 25 MB
export function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
}
/** keep only the fields the app uses; reject garbage */
export function cleanQuestions(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const q of arr) {
    if (!q || typeof q.stem !== "string" || !q.stem.trim() || q.answer == null) continue;
    const opts = Array.isArray(q.options) ? q.options.map((o) => String(o).slice(0, 2000)).slice(0, 12) : null;
    out.push({
      stem: q.stem.slice(0, 5000),
      answer: String(q.answer).slice(0, 2000),
      options: opts && opts.length ? opts : null,
      explanation: String(q.explanation || "").slice(0, 5000),
      qtype: String(q.qtype || (opts && opts.length ? "choice" : "short")).slice(0, 20),
      raw_qtype: String(q.raw_qtype || "").slice(0, 20),
      tags: String(q.tags || "").slice(0, 200),
      difficulty: q.difficulty == null ? null : Number(q.difficulty) || null,
    });
    if (out.length > 50000) break;
  }
  return out;
}
export function typeCounts(qs) {
  const c = {};
  for (const q of qs) {
    const t = q.raw_qtype || q.qtype || "其他";
    c[t] = (c[t] || 0) + 1;
  }
  return c;
}
export async function listPub(kv) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix: "pubdeck:", cursor, limit: 1000 });
    for (const k of r.keys) {
      const m = k.metadata || (await kv.get(k.name, "json"));
      if (m) out.push(m);
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}
