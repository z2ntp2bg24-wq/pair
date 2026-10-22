/**
 * Anonymous usage ping — POST /api/ping
 * Stores no IP / personal data. KV (PAIR_SYNC):
 *   dev:<deviceId>   per-device record (metadata copy for cheap listing)
 *   day:YYYY-MM-DD   JSON array of device ids active that day (Asia/Shanghai), TTL 120d
 */
const ID_RE = /^[a-f0-9]{32}$/;
const MAX_BODY = 2048;
const MIN_GAP_MS = 5 * 60 * 1000; // per-device rate limit for full writes
const DAY_TTL = 120 * 86400;
const PLATFORMS = ["iOS", "Android", "desktop"];

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function shanghaiDay(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function int(v, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
}

export async function onRequestPost({ request, env }) {
  const kv = env.PAIR_SYNC;
  if (!kv) return json({ error: "kv missing" }, 503);
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return json({ error: "too large" }, 413);
  let text;
  try {
    text = await request.text();
  } catch (_) {
    return json({ error: "bad body" }, 400);
  }
  if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
  let b;
  try {
    b = JSON.parse(text);
  } catch (_) {
    return json({ error: "bad json" }, 400);
  }
  if (!b || typeof b !== "object" || !ID_RE.test(String(b.deviceId || ""))) return json({ error: "bad deviceId" }, 400);
  const id = b.deviceId;
  const now = Date.now();
  const key = "dev:" + id;
  const prev = (await kv.get(key, "json")) || null;
  if (prev && now - (prev.lastSeen || 0) < MIN_GAP_MS) return json({ ok: true, throttled: true }, 429);

  const country = request.cf && typeof request.cf.country === "string" ? request.cf.country.slice(0, 2) : "";
  const rec = {
    firstSeen: prev && prev.firstSeen ? prev.firstSeen : now,
    lastSeen: now,
    opens: (prev ? int(prev.opens, 1e9) : 0) + 1,
    build: String(b.build || "").replace(/[^\w.-]/g, "").slice(0, 16),
    platform: PLATFORMS.includes(b.platform) ? b.platform : "other",
    standalone: !!b.standalone,
    syncBound: !!b.syncBound,
    decks: int(b.decks, 1000),
    answered: int(b.answered, 1e7),
    country,
  };
  await kv.put(key, JSON.stringify(rec), { metadata: rec });

  const day = shanghaiDay(now);
  const dk = "day:" + day;
  const list = (await kv.get(dk, "json")) || [];
  if (Array.isArray(list) && !list.includes(id) && list.length < 50000) {
    list.push(id);
    await kv.put(dk, JSON.stringify(list), { expirationTtl: DAY_TTL });
  }
  return json({ ok: true }, 200);
}

export async function onRequest({ request }) {
  if (request.method === "POST") return json({ error: "unreachable" }, 500);
  return json({ error: "method not allowed" }, 405);
}
