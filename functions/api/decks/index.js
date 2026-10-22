// GET /api/decks — public manifest of PUBLISHED decks only (drafts are never listed)
import { json, listPub } from "../admin/_auth.js";
export async function onRequestGet({ env }) {
  if (!env.PAIR_SYNC) return json([], 200);
  const list = await listPub(env.PAIR_SYNC);
  const out = list
    .filter((d) => (d.status === "published" || d.status === "published-pending") && d.publishedVersion > 0)
    .map((d) => ({ key: "pub_" + d.key, name: d.name, version: d.publishedVersion, file: `/api/decks/${d.key}?v=${d.publishedVersion}` }));
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
