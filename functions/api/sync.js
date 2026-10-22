/**
 * Pair cloud sync — GET/PUT /api/sync
 * Header: X-Pair-Sync-Code (or ?code=)
 * KV binding: PAIR_SYNC  key = sync:<sha256(code)>
 */

const CODE_RE = /^[A-Za-z0-9]{16,128}$/;
const MAX_BODY = 20 * 1024 * 1024; // stay under KV 25MB
const MIN_WRITE_GAP_MS = 400;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const url = new URL(request.url);
  // Same-origin preferred; allow pages.dev preview origins of this project
  const allow =
    !origin ||
    origin === url.origin ||
    /\.meihua-tiku\.pages\.dev$/.test(origin) ||
    origin === "https://meihua-tiku.pages.dev";
  return {
    "Access-Control-Allow-Origin": allow ? origin || url.origin : url.origin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pair-Sync-Code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
      ...extra,
    },
  });
}

function getCode(request) {
  const h = request.headers.get("X-Pair-Sync-Code");
  if (h) return h.trim().replace(/\s+/g, "");
  const url = new URL(request.url);
  const q = url.searchParams.get("code");
  return q ? q.trim().replace(/\s+/g, "") : "";
}

function validateCode(code) {
  return CODE_RE.test(code);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function kvKey(code) {
  return "sync:" + (await sha256Hex(code));
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.PAIR_SYNC) {
    return json({ error: "KV binding PAIR_SYNC missing" }, 500, request);
  }
  const code = getCode(request);
  if (!validateCode(code)) {
    return json({ error: "invalid sync code" }, 400, request);
  }
  const key = await kvKey(code);
  const raw = await env.PAIR_SYNC.get(key);
  if (!raw) {
    return json({ error: "not found" }, 404, request);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "corrupt store" }, 500, request);
  }
  return json(
    { updatedAt: parsed.updatedAt || 0, data: parsed.data },
    200,
    request
  );
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!env.PAIR_SYNC) {
    return json({ error: "KV binding PAIR_SYNC missing" }, 500, request);
  }
  const code = getCode(request);
  if (!validateCode(code)) {
    return json({ error: "invalid sync code" }, 400, request);
  }

  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) {
    return json({ error: "body too large" }, 413, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, request);
  }
  if (!body || typeof body !== "object" || body.data == null) {
    return json({ error: "need { updatedAt, data }" }, 400, request);
  }
  const clientAt = Number(body.updatedAt) || 0;
  if (!clientAt || clientAt < 0) {
    return json({ error: "invalid updatedAt" }, 400, request);
  }

  const key = await kvKey(code);
  const existingRaw = await env.PAIR_SYNC.get(key);
  let existing = null;
  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = null;
    }
  }

  const remoteAt = existing ? Number(existing.updatedAt) || 0 : 0;
  if (existing && remoteAt > clientAt) {
    return json(
      { error: "remote newer", updatedAt: remoteAt, data: existing.data },
      409,
      request
    );
  }

  // light rate limit: reject rapid overwrite with same or older stamp already handled;
  // also reject if last write was < MIN_WRITE_GAP_MS ago and same updatedAt
  if (existing && existing._writtenAt && Date.now() - existing._writtenAt < MIN_WRITE_GAP_MS) {
    if (clientAt <= remoteAt) {
      return json({ error: "rate limited", updatedAt: remoteAt }, 429, request);
    }
  }

  const record = {
    updatedAt: clientAt,
    data: body.data,
    _writtenAt: Date.now(),
  };
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_BODY) {
    return json({ error: "payload too large for KV" }, 413, request);
  }

  await env.PAIR_SYNC.put(key, serialized);
  return json({ ok: true, updatedAt: clientAt }, 200, request);
}
