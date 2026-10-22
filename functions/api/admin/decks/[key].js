// GET    /api/admin/decks/<key>                      record + questions of the latest version (draft preview)
// PATCH  /api/admin/decks/<key> {name}|{action:"publish"|"withdraw"}
// PUT    /api/admin/decks/<key> {questions}           upload a new version (stays unpublished until 发布)
// DELETE /api/admin/decks/<key>
import { json, checkAdmin, cleanName, cleanQuestions, typeCounts, KEY_RE, MAX_QUESTIONS_BYTES } from "../_auth.js";

async function load(env, key) {
  if (!KEY_RE.test(key)) return null;
  return env.PAIR_SYNC.get(`pubdeck:${key}`, "json");
}
async function save(env, rec) {
  rec.updatedAt = Date.now();
  await env.PAIR_SYNC.put(`pubdeck:${rec.key}`, JSON.stringify(rec), { metadata: rec });
  return rec;
}
export async function onRequest({ request, env, params }) {
  const e = await checkAdmin(request, env);
  if (e) return e;
  const key = String(params.key || "");
  const rec = await load(env, key);
  if (!rec) return json({ error: "not found" }, 404);
  const m = request.method;
  if (m === "GET") {
    const qs = (await env.PAIR_SYNC.get(`pubq:${key}:${rec.version}`, "json")) || [];
    return json({ deck: rec, questions: qs });
  }
  if (m === "DELETE") {
    const kv = env.PAIR_SYNC;
    for (let v = 1; v <= rec.version; v++) await kv.delete(`pubq:${key}:${v}`);
    await kv.delete(`pubdeck:${key}`);
    return json({ ok: true });
  }
  const text = await request.text();
  if (text.length > MAX_QUESTIONS_BYTES) return json({ error: "too large" }, 413);
  let b;
  try {
    b = JSON.parse(text || "{}");
  } catch (_) {
    return json({ error: "bad json" }, 400);
  }
  if (m === "PATCH") {
    if (b.name != null) {
      const n = cleanName(b.name);
      if (!n) return json({ error: "名称为空" }, 400);
      rec.name = n;
    }
    if (b.action === "publish") {
      rec.status = "published";
      rec.publishedVersion = rec.version;
      rec.publishedAt = Date.now();
    } else if (b.action === "withdraw") {
      rec.status = "withdrawn";
    }
    return json({ deck: await save(env, rec) });
  }
  if (m === "PUT") {
    const qs = cleanQuestions(b.questions);
    if (!qs || !qs.length) return json({ error: "没有有效题目" }, 400);
    rec.version += 1;
    await env.PAIR_SYNC.put(`pubq:${key}:${rec.version}`, JSON.stringify(qs));
    rec.count = qs.length;
    rec.types = typeCounts(qs);
    // a new version is a draft again until 发布; the previously published version keeps being served
    if (rec.status === "published") rec.status = "published-pending";
    return json({ deck: await save(env, rec) });
  }
  return json({ error: "method not allowed" }, 405);
}
