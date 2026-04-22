// Telegram auth (deep-link, без номера телефона) + подписки.
//
// Поток логина:
//   1. Фронт генерит случайный login_token и открывает t.me/<bot>?start=login_<token>.
//   2. Юзер жмёт Start в TG — бот получает update через webhook /tg/bot-webhook.
//   3. Воркер парсит message.text == "/start login_<token>", берёт from.id/username
//      и сохраняет в KV (`login:<token>` -> user) с TTL 5 мин.
//   4. Фронт пуллит /tg/login/poll?token=<token> раз в 2 сек → получает user.
//
// Секрет для webhook: TG_WEBHOOK_SECRET (CF secret). Передаётся в setWebhook как
// `secret_token`, Telegram шлёт его обратно в заголовке
// `X-Telegram-Bot-Api-Secret-Token` — так мы защищаемся от подделок.

const LOGIN_TTL_SECONDS = 5 * 60;
const SUB_FAR_FUTURE = 9999999999; // 2286 год

// Админы — безлимитный доступ, модалка 3/день не срабатывает.
const ADMIN_IDS = new Set([898846950, 422896004]);

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

function sanitizeUser(u) {
  return {
    id: Number(u.id),
    username: u.username ? String(u.username) : null,
    first_name: u.first_name ? String(u.first_name) : null,
    last_name: u.last_name ? String(u.last_name) : null,
    photo_url: u.photo_url ? String(u.photo_url) : null,
  };
}

async function readSubscription(env, id) {
  const nId = Number(id);
  if (ADMIN_IDS.has(nId)) return { subscribed: true, until: SUB_FAR_FUTURE, admin: true };
  if (!env.TIDAL_KV) return { subscribed: false, until: 0 };
  try {
    const raw = await env.TIDAL_KV.get(`sub:${nId}`);
    if (!raw) return { subscribed: false, until: 0 };
    const parsed = JSON.parse(raw);
    const until = Number(parsed.until || 0);
    return { subscribed: until > Math.floor(Date.now() / 1000), until };
  } catch {
    return { subscribed: false, until: 0 };
  }
}

async function tgSendMessage(env, chatId, text) {
  if (!env.TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch { /* noop */ }
}

// ---------- Login via deep-link ----------

export async function handleTgLoginPoll(url, env) {
  const token = (url.searchParams.get("token") || "").trim();
  if (!token || !/^[a-zA-Z0-9_-]{8,128}$/.test(token)) return json({ ok: false, error: "bad token" }, 400);
  if (!env.TIDAL_KV) return json({ ok: false, error: "kv not bound" }, 503);
  const raw = await env.TIDAL_KV.get(`login:${token}`);
  if (!raw) return json({ ok: false, pending: true });
  let payload;
  try { payload = JSON.parse(raw); }
  catch { return json({ ok: false, error: "corrupt" }, 500); }
  // One-shot: удаляем, чтобы токен нельзя было переиспользовать.
  await env.TIDAL_KV.delete(`login:${token}`);
  const sub = await readSubscription(env, payload.id);
  return json({ ok: true, user: sanitizeUser(payload), subscription: sub });
}

export async function handleTgBotWebhook(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  const expected = env.TG_WEBHOOK_SECRET;
  if (expected) {
    const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (provided !== expected) return json({ ok: false, error: "bad secret" }, 403);
  }
  let update;
  try { update = await request.json(); }
  catch { return json({ ok: false, error: "bad json" }, 400); }

  const msg = update && (update.message || update.edited_message);
  if (!msg || !msg.from) return json({ ok: true });

  const from = msg.from;
  const text = String(msg.text || "").trim();
  const startMatch = text.match(/^\/start(?:@\w+)?\s+(\S+)/);
  const payload = startMatch ? startMatch[1] : "";

  if (payload.startsWith("login_")) {
    const token = payload.slice("login_".length);
    if (/^[a-zA-Z0-9_-]{8,128}$/.test(token) && env.TIDAL_KV) {
      const sanitized = sanitizeUser(from);
      await env.TIDAL_KV.put(`login:${token}`, JSON.stringify(sanitized), {
        expirationTtl: LOGIN_TTL_SECONDS,
      });
      const sub = await readSubscription(env, sanitized.id);
      const line = sub.admin
        ? "🛠 Админ-доступ подтверждён. Возвращайся на сайт — там уже всё."
        : sub.subscribed
          ? "✅ Вход подтверждён. Подписка активна до " + new Date(sub.until * 1000).toLocaleDateString("ru-RU") + "."
          : "✅ Вход подтверждён. Возвращайся на сайт — там уже всё.";
      await tgSendMessage(env, from.id, line);
    }
    return json({ ok: true });
  }

  if (payload.startsWith("pay_") || text.startsWith("/pay")) {
    await tgSendMessage(
      env,
      from.id,
      "💸 Подписка 99 ₽/мес. Напиши админу для активации — как только оплата пройдёт, подписка включится автоматически.",
    );
    return json({ ok: true });
  }

  if (text.startsWith("/start")) {
    await tgSendMessage(
      env,
      from.id,
      "Привет! Это бот музончика. Чтобы войти на сайт — жми «Войти через Telegram» там, откуда пришёл, не здесь.",
    );
    return json({ ok: true });
  }

  return json({ ok: true });
}

// ---------- Subscription status ----------

export async function handleTgStatus(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "missing id" }, 400);
  const sub = await readSubscription(env, id);
  return json({ ok: true, subscription: sub });
}

// ---------- Manual subscription webhook (for bot admin) ----------
// POST /tg/webhook?k=<TG_ADMIN_SECRET>  body: { tg_id, months }
export async function handleTgSubscribe(url, request, env) {
  const secret = env.TG_ADMIN_SECRET;
  if (!secret) return json({ ok: false, error: "TG_ADMIN_SECRET not set" }, 503);
  const provided = url.searchParams.get("k") || request.headers.get("x-admin-secret") || "";
  if (provided !== secret) return json({ ok: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  if (!env.TIDAL_KV) return json({ ok: false, error: "KV not bound" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "invalid json" }, 400); }
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
