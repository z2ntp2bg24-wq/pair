// GET  /api/admin/decks          list all (draft / published / withdrawn)
// POST /api/admin/decks {name, questions}   create a DRAFT
import { json, checkAdmin, cleanName, cleanQuestions, typeCounts, listPub, MAX_QUESTIONS_BYTES } from "../_auth.js";

export async function onRequestGet({ request, env }) {
  const e = await checkAdmin(request, env);
  if (e) return e;
  const list = await listPub(env.PAIR_SYNC);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return json({ decks: list });
}
export async function onRequestPost({ request, env }) {
  const e = await checkAdmin(request, env);
  if (e) return e;
  const text = await request.text();
  if (text.length > MAX_QUESTIONS_BYTES) return json({ error: "题库太大（超过 20MB）" }, 413);
  let b;
  try {
    b = JSON.parse(text);
  } catch (_) {
    return json({ error: "bad json" }, 400);
  }
  const name = cleanName(b && b.name);
  const qs = cleanQuestions(b && b.questions);
  if (!name) return json({ error: "缺少名称" }, 400);
  if (!qs || !qs.length) return json({ error: "没有有效题目" }, 400);
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes, (x) => (x % 36).toString(36)).join("") + Date.now().toString(36).slice(-3);
  const now = Date.now();
  const rec = { key, name, status: "draft", version: 1, count: qs.length, types: typeCounts(qs), createdAt: now, updatedAt: now, publishedAt: null, publishedVersion: 0 };
  await env.PAIR_SYNC.put(`pubq:${key}:1`, JSON.stringify(qs));
  await env.PAIR_SYNC.put(`pubdeck:${key}`, JSON.stringify(rec), { metadata: rec });
  return json({ deck: rec });
}
