// GET /api/decks/<key> — questions of the published version; 404 for drafts / withdrawn / unknown
import { json, KEY_RE } from "../admin/_auth.js";
export async function onRequestGet({ env, params }) {
  const key = String(params.key || "");
  if (!KEY_RE.test(key) || !env.PAIR_SYNC) return json({ error: "not found" }, 404);
  const rec = await env.PAIR_SYNC.get(`pubdeck:${key}`, "json");
  if (!rec || !(rec.status === "published" || rec.status === "published-pending") || !(rec.publishedVersion > 0)) return json({ error: "not found" }, 404);
  const body = await env.PAIR_SYNC.get(`pubq:${key}:${rec.publishedVersion}`);
  if (!body) return json({ error: "not found" }, 404);
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" } });
}
