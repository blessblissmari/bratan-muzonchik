// Telegram Login Widget verification + simple subscription status.
//
// Flow:
//   Frontend opens official Telegram Login Widget configured with our bot
//   username. On success TG returns a signed payload. We verify the HMAC in the
//   worker (bot_token is a CF secret, never shipped to the browser), then
//   answer with a sanitized user object the frontend can persist.
//
// Spec: https://core.telegram.org/widgets/login#checking-authorization

const TG_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60; // 24h per TG recommendation

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-max-age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTgHash(payload, botToken) {
  const { hash, ...rest } = payload;
  if (!hash || typeof hash !== "string") return { ok: false, reason: "missing hash" };
  const keys = Object.keys(rest).sort();
  const dataCheckString = keys.map((k) => `${k}=${rest[k]}`).join("\n");

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.digest("SHA-256", enc.encode(botToken));
  const key = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(dataCheckString));
  const computed = hex(mac);

  if (computed.length !== hash.length) return { ok: false, reason: "bad hash" };
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: "bad hash" };

  const authDate = Number(rest.auth_date || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > TG_AUTH_MAX_AGE_SECONDS) {
    return { ok: false, reason: "auth_date expired" };
  }
  return { ok: true };
}

function sanitizeUser(u) {
  return {
    id: Number(u.id),
    username: u.username ? String(u.username) : null,
    first_name: u.first_name ? String(u.first_name) : null,
    last_name: u.last_name ? String(u.last_name) : null,
    photo_url: u.photo_url ? String(u.photo_url) : null,
    auth_date: Number(u.auth_date),
  };
}

async function readSubscription(env, id) {
  if (!env.TIDAL_KV) return { subscribed: false, until: 0 };
  try {
    const raw = await env.TIDAL_KV.get(`sub:${id}`);
    if (!raw) return { subscribed: false, until: 0 };
    const parsed = JSON.parse(raw);
    const until = Number(parsed.until || 0);
    return { subscribed: until > Math.floor(Date.now() / 1000), until };
  } catch {
    return { subscribed: false, until: 0 };
  }
}

export async function handleTgVerify(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  if (!env.TG_BOT_TOKEN) return json({ ok: false, error: "TG_BOT_TOKEN secret not set on worker" }, 503);
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  if (!payload || typeof payload !== "object") return json({ ok: false, error: "invalid payload" }, 400);

  const check = await verifyTgHash(payload, env.TG_BOT_TOKEN);
  if (!check.ok) return json({ ok: false, error: check.reason }, 401);

  const user = sanitizeUser(payload);
  const sub = await readSubscription(env, user.id);
  return json({ ok: true, user, subscription: sub });
}

export async function handleTgStatus(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  const sub = await readSubscription(env, id);
  return json({ ok: true, subscription: sub });
}

// Minimal webhook the bot can point at to flip subscription state.
// Protected by a shared secret `TG_WEBHOOK_SECRET` passed via `?k=...` or
// `x-webhook-secret` header. Expected body: { tg_id, months }.
export async function handleTgWebhook(url, request, env) {
  const secret = env.TG_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: "TG_WEBHOOK_SECRET not set" }, 503);
  const provided = url.searchParams.get("k") || request.headers.get("x-webhook-secret") || "";
  if (provided !== secret) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  if (!env.TIDAL_KV) return json({ ok: false, error: "KV not bound" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const tgId = Number(body && body.tg_id);
  const months = Math.max(1, Math.min(24, Number((body && body.months) || 1)));
  if (!tgId) return json({ ok: false, error: "missing tg_id" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const existing = await env.TIDAL_KV.get(`sub:${tgId}`);
  let base = now;
  if (existing) {
    try {
      const prev = JSON.parse(existing);
      if (Number(prev.until || 0) > now) base = Number(prev.until);
    } catch { /* noop */ }
  }
  const until = base + months * 30 * 24 * 60 * 60;
  await env.TIDAL_KV.put(`sub:${tgId}`, JSON.stringify({ until, updated: now }));
  return json({ ok: true, subscription: { subscribed: true, until } });
}
