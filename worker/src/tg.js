// Telegram auth (deep-link, без номера телефона) + подписки + оплата через Telegram Stars (XTR).
//
// Поток логина:
//   1. Фронт генерит случайный login_token и открывает t.me/<bot>?start=login_<token>.
//   2. Юзер жмёт Start в TG — бот получает update через webhook /tg/bot-webhook.
//   3. Воркер парсит message.text == "/start login_<token>", берёт from.id/username
//      и сохраняет в KV (`login:<token>` -> user) с TTL 5 мин.
//   4. Фронт пуллит /tg/login/poll?token=<token> раз в 2 сек → получает user.
//
// Поток оплаты (через Telegram Stars, без провайдера/карт/привязок):
//   1. Юзер открывает t.me/<bot>?start=pay_<tg_id> или команды /pay, /subscribe.
//   2. Бот шлёт invoice (currency=XTR, amount=SUB_PRICE_STARS).
//   3. TG → pre_checkout_query → бот отвечает ok=true.
//   4. TG → successful_payment → бот активирует подписку на SUB_PERIOD_DAYS и пишет юзеру.
//
// Секрет для webhook: TG_WEBHOOK_SECRET (CF secret). Передаётся в setWebhook как
// `secret_token`, Telegram шлёт его обратно в заголовке
// `X-Telegram-Bot-Api-Secret-Token` — так мы защищаемся от подделок.

const LOGIN_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 дней
const PLAYLIST_MAX_BYTES = 256 * 1024; // 256 KiB — потолок на случай дурных запросов
const FEATURED_MAX_BYTES = 768 * 1024; // 768 KiB — с запасом на картинку в data-URL
const SUB_FAR_FUTURE = 9999999999; // 2286 год
const SUB_PERIOD_DAYS = 30;
const SUB_PRICE_STARS = 99; // ≈ 99₽ на текущем курсе Telegram Stars.
const SUB_TITLE = "Братан-музончик: подписка на месяц";
const SUB_DESCRIPTION = "Безлимит на прослушивание + скачивание lossless. 30 дней.";

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

function randomToken(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueSession(env, tgId) {
  if (!env.TIDAL_KV) return null;
  const token = randomToken(24);
  await env.TIDAL_KV.put(`session:${token}`, String(Number(tgId)), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

async function resolveSession(env, token) {
  if (!token || !/^[a-f0-9]{16,128}$/i.test(token)) return null;
  if (!env.TIDAL_KV) return null;
  const raw = await env.TIDAL_KV.get(`session:${token}`);
  if (!raw) return null;
  const tgId = Number(raw);
  return Number.isFinite(tgId) && tgId > 0 ? tgId : null;
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

async function grantSubscription(env, id, days) {
  if (!env.TIDAL_KV) return { subscribed: false, until: 0 };
  const nId = Number(id);
  const now = Math.floor(Date.now() / 1000);
  let base = now;
  try {
    const prev = await env.TIDAL_KV.get(`sub:${nId}`);
    if (prev) {
      const parsed = JSON.parse(prev);
      if (Number(parsed.until || 0) > now) base = Number(parsed.until);
    }
  } catch { /* noop */ }
  const until = base + days * 24 * 60 * 60;
  await env.TIDAL_KV.put(`sub:${nId}`, JSON.stringify({ until, updated: now }));
  return { subscribed: true, until };
}

async function revokeSubscription(env, id) {
  if (!env.TIDAL_KV) return false;
  const nId = Number(id);
  await env.TIDAL_KV.delete(`sub:${nId}`);
  return true;
}

async function listActiveSubs(env, limit = 50) {
  if (!env.TIDAL_KV) return [];
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await env.TIDAL_KV.list({ prefix: "sub:", limit: 1000, cursor });
    for (const k of page.keys) {
      const id = Number(k.name.slice("sub:".length));
      if (!Number.isFinite(id) || id <= 0) continue;
      const raw = await env.TIDAL_KV.get(k.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const until = Number(parsed.until || 0);
        if (until > now) out.push({ id, until });
      } catch { /* noop */ }
      if (out.length >= limit) return out;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

// ---------- Telegram Bot API helpers ----------

async function tgCall(env, method, body) {
  if (!env.TG_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

function tgSendMessage(env, chatId, text, extra) {
  return tgCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(extra || {}),
  });
}

function tgSendInvoice(env, chatId, tgId) {
  // provider_token пустой → Telegram Stars (XTR). Никаких карт / ЮKassa / привязок.
  return tgCall(env, "sendInvoice", {
    chat_id: chatId,
    title: SUB_TITLE,
    description: SUB_DESCRIPTION,
    // payload — вернётся в pre_checkout_query и successful_payment. Кладём tg_id
    // чтобы точно знать кому зачислять подписку, даже если оплата приходит от другого юзера.
    payload: `sub_month:${tgId}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: `Подписка ${SUB_PERIOD_DAYS} дней`, amount: SUB_PRICE_STARS }],
  });
}

function tgAnswerPreCheckout(env, queryId, ok, errorMessage) {
  return tgCall(env, "answerPreCheckoutQuery", {
    pre_checkout_query_id: queryId,
    ok: !!ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

function adminCommandsFor(tgId) {
  return ADMIN_IDS.has(Number(tgId));
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
  const session = await issueSession(env, payload.id);
  return json({ ok: true, user: sanitizeUser(payload), subscription: sub, session });
}

// ---------- Featured track (pinned с кастомной картинкой) ----------

export async function handleTgFeatured(url, request, env) {
  if (!env.TIDAL_KV) return json({ ok: false, error: "kv not bound" }, 503);
  const session = url.searchParams.get("session") || request.headers.get("x-tg-session") || "";
  const tgId = await resolveSession(env, session);
  if (!tgId) return json({ ok: false, error: "bad session" }, 401);

  if (request.method === "GET") {
    const text = (await env.TIDAL_KV.get(`featured:${tgId}`)) || "";
    return json({ ok: true, featured: text });
  }
  if (request.method === "DELETE") {
    await env.TIDAL_KV.delete(`featured:${tgId}`);
    return json({ ok: true });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const text = await request.text();
    if (text.length > FEATURED_MAX_BYTES) return json({ ok: false, error: "too big" }, 413);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return json({ ok: false, error: "not json" }, 400); }
    if (!parsed || !parsed.item || !parsed.item.id || !parsed.item.source) {
      return json({ ok: false, error: "bad shape" }, 400);
    }
    await env.TIDAL_KV.put(`featured:${tgId}`, text);
    return json({ ok: true });
  }
  return json({ ok: false, error: "method not allowed" }, 405);
}

// ---------- Playlist sync (stored as plain text JSON per TG id) ----------

export async function handleTgPlaylist(url, request, env) {
  if (!env.TIDAL_KV) return json({ ok: false, error: "kv not bound" }, 503);
  const session = url.searchParams.get("session") || request.headers.get("x-tg-session") || "";
  const tgId = await resolveSession(env, session);
  if (!tgId) return json({ ok: false, error: "bad session" }, 401);

  if (request.method === "GET") {
    const text = (await env.TIDAL_KV.get(`playlist:${tgId}`)) || "";
    return json({ ok: true, playlist: text });
  }
  if (request.method === "POST" || request.method === "PUT") {
    const text = await request.text();
    if (text.length > PLAYLIST_MAX_BYTES) {
      return json({ ok: false, error: "too big" }, 413);
    }
    // Валидируем, что это JSON-массив; храним ровно тот текст, что прислали.
    let arr;
    try { arr = JSON.parse(text); }
    catch { return json({ ok: false, error: "not json" }, 400); }
    if (!Array.isArray(arr)) return json({ ok: false, error: "not array" }, 400);
    if (arr.length === 0) {
      await env.TIDAL_KV.delete(`playlist:${tgId}`);
    } else {
      await env.TIDAL_KV.put(`playlist:${tgId}`, text);
    }
    return json({ ok: true, count: arr.length });
  }
  return json({ ok: false, error: "method not allowed" }, 405);
}

// ---------- Webhook ----------

export async function handleTgBotWebhook(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  const expected = env.TG_WEBHOOK_SECRET;
  if (expected) {
    const provided = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (provided !== expected) {
      console.log("[wh] bad secret");
      return json({ ok: false, error: "bad secret" }, 403);
    }
  }
  let update;
  try { update = await request.json(); }
  catch { return json({ ok: false, error: "bad json" }, 400); }
  try {
    console.log("[wh] update:", JSON.stringify({
      from: update.message?.from?.id || update.edited_message?.from?.id || null,
      text: (update.message?.text || update.edited_message?.text || "").slice(0, 100),
      pre_checkout: !!update.pre_checkout_query,
      successful_payment: !!update.message?.successful_payment,
    }));
  } catch {}

  // 1) Pre-checkout — надо ответить в течение 10 сек, иначе TG отменит оплату.
  if (update.pre_checkout_query) {
    await tgAnswerPreCheckout(env, update.pre_checkout_query.id, true);
    return json({ ok: true });
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.from) return json({ ok: true });

  const from = msg.from;
  const chatId = msg.chat && msg.chat.id ? msg.chat.id : from.id;

  // 2) Успешная оплата → активируем подписку.
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    // payload формата "sub_month:<tg_id>"; если пришёл левый — зачисляем плательщику.
    let targetId = Number(from.id);
    const m = String(sp.invoice_payload || "").match(/^sub_month:(\d+)$/);
    if (m) targetId = Number(m[1]);
    const { until } = await grantSubscription(env, targetId, SUB_PERIOD_DAYS);
    const untilStr = new Date(until * 1000).toLocaleDateString("ru-RU");
    await tgSendMessage(
      env,
      chatId,
      `✅ Оплата прошла. Подписка активна до <b>${untilStr}</b>.\n\nВозвращайся на сайт — безлимит уже включён.`,
    );
    return json({ ok: true });
  }

  // 3) Обычные команды.
  const text = String(msg.text || "").trim();
  const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
  const payload = startMatch && startMatch[1] ? startMatch[1] : "";

  // /start login_<token> — логин на сайт.
  if (payload.startsWith("login_")) {
    const token = payload.slice("login_".length);
    const tokenOk = /^[a-zA-Z0-9_-]{8,128}$/.test(token);
    console.log(`[wh] login_ payload, token len=${token.length}, ok=${tokenOk}, kv=${!!env.TIDAL_KV}`);
    if (tokenOk && env.TIDAL_KV) {
      const sanitized = sanitizeUser(from);
      try {
        await env.TIDAL_KV.put(`login:${token}`, JSON.stringify(sanitized), {
          expirationTtl: LOGIN_TTL_SECONDS,
        });
        console.log(`[wh] login KV put OK token=${token.slice(0, 6)}… user=${sanitized.id}`);
      } catch (e) {
        console.log(`[wh] login KV put FAIL: ${e && e.message}`);
        await tgSendMessage(env, chatId, "Не удалось сохранить вход на сервере. Попробуй ещё раз.");
        return json({ ok: true });
      }
      const sub = await readSubscription(env, sanitized.id);
      const line = sub.admin
        ? "🛠 Админ-доступ подтверждён. Возвращайся на сайт — там уже всё."
        : sub.subscribed
          ? `✅ Вход подтверждён. Подписка активна до ${new Date(sub.until * 1000).toLocaleDateString("ru-RU")}.`
          : "✅ Вход подтверждён. Возвращайся на сайт — там уже всё.";
      await tgSendMessage(env, chatId, line);
    } else if (env.TIDAL_KV) {
      // Токен невалидный — явно скажем.
      await tgSendMessage(env, chatId, "Некорректная ссылка входа. Попробуй нажать «Войти» на сайте ещё раз.");
    }
    return json({ ok: true });
  }

  // /start pay[_<id>] или /pay, /subscribe, /buy — invoice на 99 Stars.
  const wantsPay =
    payload === "pay" ||
    payload.startsWith("pay_") ||
    /^\/(pay|subscribe|buy)(@\w+)?(\s|$)/i.test(text);
  if (wantsPay) {
    // Если в payload есть конкретный tg_id — зачисление пойдёт туда (чтобы другой
    // человек мог оплатить подписку для тебя). Иначе — плательщику.
    let targetId = Number(from.id);
    const m = payload.match(/^pay_(\d+)$/);
    if (m) targetId = Number(m[1]);
    const sub = await readSubscription(env, targetId);
    if (sub.admin) {
      await tgSendMessage(env, chatId, "🛠 У тебя и так админ-безлимит, оплата не нужна.");
      return json({ ok: true });
    }
    const res = await tgSendInvoice(env, chatId, targetId);
    if (!res || !res.ok) {
      await tgSendMessage(
        env,
        chatId,
        "Не получилось выставить счёт. Попробуй позже или напиши админу.",
      );
    }
    return json({ ok: true });
  }

  // /status — показать состояние подписки.
  if (/^\/status(@\w+)?(\s|$)/i.test(text)) {
    const sub = await readSubscription(env, from.id);
    if (sub.admin) {
      await tgSendMessage(env, chatId, "🛠 Админ-безлимит.");
    } else if (sub.subscribed) {
      const untilStr = new Date(sub.until * 1000).toLocaleDateString("ru-RU");
      await tgSendMessage(env, chatId, `✅ Подписка активна до <b>${untilStr}</b>.`);
    } else {
      await tgSendMessage(
        env,
        chatId,
        "Подписки нет. Команда /pay — оплатить 99 ⭐ за 30 дней безлимита.",
      );
    }
    return json({ ok: true });
  }

  // /playlist — прислать юзеру его плейлист в виде текста.
  if (/^\/playlist(@\w+)?(\s|$)/i.test(text)) {
    const raw = (await env.TIDAL_KV?.get(`playlist:${from.id}`)) || "";
    if (!raw) {
      await tgSendMessage(env, chatId, "📭 Плейлист пустой. Добавь треки на сайте — синк идёт автоматически.");
      return json({ ok: true });
    }
    let arr;
    try { arr = JSON.parse(raw); } catch { arr = null; }
    if (!Array.isArray(arr) || arr.length === 0) {
      await tgSendMessage(env, chatId, "📭 Плейлист пустой.");
      return json({ ok: true });
    }
    const lines = arr
      .slice(0, 50)
      .map((t, i) => `${i + 1}. ${String(t.title || "?").slice(0, 80)} — ${String(t.artist || t.user || "?").slice(0, 50)}`);
    const tail = arr.length > 50 ? `\n… и ещё ${arr.length - 50}.` : "";
    await tgSendMessage(env, chatId, `🎵 Твой плейлист (${arr.length}):\n${lines.join("\n")}${tail}`);
    return json({ ok: true });
  }

  // /help
  if (/^\/help(@\w+)?(\s|$)/i.test(text)) {
    const baseLines = [
      "Команды:",
      "• /pay — оплатить подписку (99 ⭐ / 30 дней)",
      "• /status — состояние подписки",
      "• /playlist — показать свой плейлист с сайта",
      "• /start — приветствие",
    ];
    if (adminCommandsFor(from.id)) {
      baseLines.push(
        "",
        "<b>Админские команды:</b>",
        "• /grant &lt;tg_id&gt; — выдать подписку навсегда (бесплатно)",
        "• /grant &lt;tg_id&gt; &lt;дней&gt; — выдать подписку на N дней",
        "• /unsub &lt;tg_id&gt; — отозвать подписку",
        "• /subs — список активных подписчиков",
        "• /refund &lt;charge_id&gt; — возврат звёзд",
      );
    }
    await tgSendMessage(env, chatId, baseLines.join("\n"));
    return json({ ok: true });
  }

  // /refund <charge_id> — админская команда: возврат звёзд.
  const refundMatch = text.match(/^\/refund(?:@\w+)?\s+(\S+)/i);
  if (refundMatch && adminCommandsFor(from.id)) {
    const chargeId = refundMatch[1];
    const r = await tgCall(env, "refundStarPayment", {
      user_id: Number(from.id),
      telegram_payment_charge_id: chargeId,
    });
    await tgSendMessage(env, chatId, r && r.ok ? "↩️ Возврат оформлен." : "Не получилось оформить возврат.");
    return json({ ok: true });
  }

  // /grant <tg_id> [days|forever] — админская команда: выдать подписку вручную.
  // Без аргумента дней или со словом forever / 0 — выдаём «навсегда» (~100 лет).
  const grantMatch = text.match(/^\/grant(?:@\w+)?\s+(\d+)(?:\s+(\S+))?/i);
  if (grantMatch && adminCommandsFor(from.id)) {
    const targetId = Number(grantMatch[1]);
    const arg = grantMatch[2] ? String(grantMatch[2]).toLowerCase() : "";
    let days;
    if (!arg || arg === "forever" || arg === "0" || arg === "навсегда") {
      days = 36500;
    } else {
      const n = Number(arg);
      days = Number.isFinite(n) && n > 0 ? Math.min(36500, n) : 36500;
    }
    const { until } = await grantSubscription(env, targetId, days);
    const untilStr = days >= 36500 ? "навсегда" : `до ${new Date(until * 1000).toLocaleDateString("ru-RU")}`;
    await tgSendMessage(env, chatId, `✅ Выдал подписку tg_id=<code>${targetId}</code> ${untilStr} (+${days}д). Платить ему не нужно.`);
    // Уведомляем самого юзера, если бот может ему писать (он жал /start раньше).
    if (targetId !== Number(from.id)) {
      await tgSendMessage(env, targetId, `🎁 Тебе выдали безлимитный доступ к «Братан-музончику» ${untilStr}. Открой сайт и войди через Telegram.`).catch?.(() => {});
    }
    return json({ ok: true });
  }

  // /unsub <tg_id> — админская команда: отозвать подписку.
  const unsubMatch = text.match(/^\/unsub(?:@\w+)?\s+(\d+)/i);
  if (unsubMatch && adminCommandsFor(from.id)) {
    const targetId = Number(unsubMatch[1]);
    if (ADMIN_IDS.has(targetId)) {
      await tgSendMessage(env, chatId, `Нельзя отозвать у админа.`);
    } else {
      await revokeSubscription(env, targetId);
      await tgSendMessage(env, chatId, `🗑 Подписка tg_id=<code>${targetId}</code> отозвана.`);
    }
    return json({ ok: true });
  }

  // /subs — админская команда: показать всех активных подписчиков.
  if (/^\/subs(@\w+)?(\s|$)/i.test(text) && adminCommandsFor(from.id)) {
    const subs = await listActiveSubs(env, 100);
    if (!subs.length) {
      await tgSendMessage(env, chatId, "Активных подписчиков нет.");
    } else {
      const lines = subs
        .sort((a, b) => b.until - a.until)
        .map((s) => {
          const date = new Date(s.until * 1000).toLocaleDateString("ru-RU");
          const forever = s.until - Math.floor(Date.now() / 1000) > 365 * 24 * 60 * 60 * 50 ? " (навсегда)" : "";
          return `• <code>${s.id}</code> — до ${date}${forever}`;
        });
      await tgSendMessage(env, chatId, `Активных: ${subs.length}\n${lines.join("\n")}`);
    }
    return json({ ok: true });
  }

  // /start без payload и всё прочее — приветствие.
  if (text.startsWith("/start")) {
    const sub = await readSubscription(env, from.id);
    const tail = sub.admin
      ? "\n\nУ тебя админ-безлимит 🛠"
      : sub.subscribed
        ? `\n\nПодписка активна до ${new Date(sub.until * 1000).toLocaleDateString("ru-RU")}.`
        : "\n\nКоманда /pay — оформить подписку за 99 ⭐ на 30 дней.";
    await tgSendMessage(
      env,
      chatId,
      "Привет! Это бот «Братан-музончика». Чтобы войти на сайт — жми «Войти через Telegram» на сайте." + tail,
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
// POST /tg/subscribe?k=<TG_ADMIN_SECRET>  body: { tg_id, months }
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

  const { until } = await grantSubscription(env, tgId, months * 30);
  return json({ ok: true, subscription: { subscribed: true, until } });
}
