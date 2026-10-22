/** Admin stats — GET /api/admin/stats, header X-Admin-Key must equal env.ADMIN_KEY */
const DAY_MS = 86400000;
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
function day(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function onRequestGet({ request, env }) {
  if (!env.ADMIN_KEY) return json({ error: "admin not configured" }, 503);
  const key = request.headers.get("X-Admin-Key") || "";
  if (!key || key.length > 256 || !(await safeEqual(key, String(env.ADMIN_KEY)))) return json({ error: "unauthorized" }, 401);
  const kv = env.PAIR_SYNC;
  if (!kv) return json({ error: "kv missing" }, 503);

  const devices = [];
  let cursor;
  do {
    const r = await kv.list({ prefix: "dev:", cursor, limit: 1000 });
    for (const k of r.keys) {
      let m = k.metadata;
      if (!m) m = await kv.get(k.name, "json");
      if (m) devices.push({ id: k.name.slice(4), ...m });
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);

  const now = Date.now();
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(day(now - i * DAY_MS));
  const dayLists = await Promise.all(days.map((d) => kv.get("day:" + d, "json")));
  const daily = days.map((d, i) => ({ date: d, active: Array.isArray(dayLists[i]) ? dayLists[i].length : 0 }));
  const newPerDay = Object.fromEntries(days.map((d) => [d, 0]));
  const platforms = {};
  let standalone = 0, syncBound = 0, a7 = 0, a30 = 0;
  const today = day(now);
  let activeToday = 0;
  for (const d of devices) {
    const fd = day(d.firstSeen || 0);
    if (fd in newPerDay) newPerDay[fd]++;
    platforms[d.platform || "other"] = (platforms[d.platform || "other"] || 0) + 1;
    if (d.standalone) standalone++;
    if (d.syncBound) syncBound++;
    if (now - d.lastSeen < 7 * DAY_MS) a7++;
    if (now - d.lastSeen < 30 * DAY_MS) a30++;
    if (day(d.lastSeen || 0) === today) activeToday++;
  }
  devices.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return json(
    {
      generatedAt: now,
      totalDevices: devices.length,
      activeToday,
      active7d: a7,
      active30d: a30,
      daily,
      newPerDay: days.map((d) => ({ date: d, count: newPerDay[d] })),
      platforms,
      standalone,
      syncBound,
      devices: devices.map((d) => ({
        id: d.id.slice(0, 6),
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
        opens: d.opens || 0,
        answered: d.answered || 0,
        decks: d.decks || 0,
        build: d.build || "",
        platform: d.platform || "",
        standalone: !!d.standalone,
        country: d.country || "",
      })),
    },
    200
  );
}
export async function onRequest() {
  return json({ error: "method not allowed" }, 405);
}
