// bratan-muzonchik Cloudflare Worker
// Proxies SoundCloud + Piped (YouTube) + Tidal APIs and adds CORS headers so
// the static GitHub Pages frontend can call it directly from the browser.
import {
  handleTidalHealth,
  handleTidalSearch,
  handleTidalTrack,
  handleTidalAudio,
  handleTidalDownload,
} from "./tidal.js";
import {
  handleTgLoginPoll,
  handleTgBotWebhook,
  handleTgStatus,
  handleTgSubscribe,
  handleTgPlaylist,
} from "./tg.js";
//
// Endpoints:
//   GET  /search?q=<query>&limit=<n>       -> SoundCloud /search/tracks JSON
//   GET  /resolve?url=<transcoding_url>    -> { url: "<m3u8 url>" }
//   GET  /hls?url=<encoded m3u8 or mp3>    -> raw playlist/segment bytes
//   GET  /yt/search?q=<query>              -> { items: [...] }  Piped music_songs
//   GET  /yt/streams?id=<videoId>          -> { title, duration, audio: [{url,bitrate,codec,mime}] }
//   GET  /ytaudio?url=<encoded>            -> raw audio bytes (googlevideo / piped proxy)
//   GET  /health                           -> { ok: true }
//
// client_id is scraped from soundcloud.com JS bundles and cached in-memory
// for the lifetime of the isolate (+ Cache API with 1h TTL to persist longer).

const SC_ORIGIN = "https://api-v2.soundcloud.com";
const SC_HLS_ALLOWED_HOSTS = [/^(.+\.)?sndcdn\.com$/i];
const YT_AUDIO_ALLOWED_HOSTS = [
  /^(.+\.)?googlevideo\.com$/i,
  /^pipedproxy\..+$/i,          // e.g. pipedproxy.kavin.rocks, pipedproxy.adminforge.de
  /^proxy\.piped\..+$/i,         // e.g. proxy.piped.private.coffee, proxy.piped.projectsegfau.lt
];
const CLIENT_ID_REGEX = /client_id[:=]"([A-Za-z0-9]{32})"/;
const CLIENT_ID_CACHE_KEY = "https://bratan.internal/client-id";
const CLIENT_ID_TTL_SECONDS = 3600;

// Piped instances. Tried in order; first that returns valid JSON wins.
// Keep short — only include instances observed to respond on mainstream queries.
const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
];

let memoClientId = null;
let memoClientIdAt = 0;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type, Range",
  "access-control-expose-headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges",
  "access-control-max-age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// ---------- SoundCloud ----------

async function fetchClientIdFresh() {
  const html = await fetch("https://soundcloud.com/", {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  }).then((r) => r.text());
  const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/gi)).map(
    (m) => m[1],
  );
  if (!scripts.length) {
    const any = Array.from(html.matchAll(/<script[^>]+src="([^"]+\.js)"/gi)).map((m) => m[1]);
    scripts.push(...any);
  }
  for (const src of scripts) {
    try {
      const body = await fetch(src).then((r) => r.text());
      const m = body.match(CLIENT_ID_REGEX);
      if (m && m[1]) return m[1];
    } catch {
      /* try next */
    }
  }
  throw new Error("client_id not found in soundcloud.com JS bundles");
}

async function getClientId(ctx) {
  const now = Date.now();
  if (memoClientId && now - memoClientIdAt < CLIENT_ID_TTL_SECONDS * 1000) return memoClientId;
  const cache = caches.default;
  const cached = await cache.match(CLIENT_ID_CACHE_KEY);
  if (cached) {
    const id = await cached.text();
    if (id) {
      memoClientId = id;
      memoClientIdAt = now;
      return id;
    }
  }
  const id = await fetchClientIdFresh();
  memoClientId = id;
  memoClientIdAt = now;
  const resp = new Response(id, {
    headers: { "cache-control": `public, max-age=${CLIENT_ID_TTL_SECONDS}` },
  });
  ctx.waitUntil(cache.put(CLIENT_ID_CACHE_KEY, resp));
  return id;
}

async function invalidateClientId() {
  memoClientId = null;
  memoClientIdAt = 0;
  await caches.default.delete(CLIENT_ID_CACHE_KEY);
}

async function withClientId(ctx, fn) {
  let id = await getClientId(ctx);
  let resp = await fn(id);
  if (resp.status === 401 || resp.status === 403) {
    await invalidateClientId();
    id = await getClientId(ctx);
    resp = await fn(id);
  }
  return resp;
}

async function handleSearch(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") || "30"), 50);
  if (!q) return json({ error: "missing q" }, 400);
  const resp = await withClientId(ctx, async (id) => {
    const u = new URL(SC_ORIGIN + "/search/tracks");
    u.searchParams.set("q", q);
    u.searchParams.set("client_id", id);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("facet", "genre");
    return fetch(u.toString(), { headers: { accept: "application/json" } });
  });
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

async function handleResolveTranscoding(url, ctx) {
  const transUrl = url.searchParams.get("url");
  if (!transUrl) return json({ error: "missing url" }, 400);
  if (!/^https:\/\/api-v2\.soundcloud\.com\/media\//.test(transUrl))
    return json({ error: "url must be a soundcloud transcoding url" }, 400);
  const resp = await withClientId(ctx, async (id) => {
    const u = new URL(transUrl);
    u.searchParams.set("client_id", id);
    return fetch(u.toString(), { headers: { accept: "application/json" } });
  });
  if (!resp.ok) return json({ error: "sc resolve failed", status: resp.status }, 502);
  const data = await resp.json();
  if (!data?.url) return json({ error: "no m3u8 url in sc response" }, 502);
  const wrapped = `${url.origin}/hls?url=${encodeURIComponent(data.url)}`;
  return json({ url: wrapped });
}

async function handleHls(url, req) {
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "missing url" }, 400);
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "invalid url" }, 400);
  }
  if (parsed.protocol !== "https:") return json({ error: "https only" }, 400);
  const host = parsed.hostname.toLowerCase();
  if (!SC_HLS_ALLOWED_HOSTS.some((re) => re.test(host))) return json({ error: "host not allowed" }, 400);
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetch(target, { headers });
  const outHeaders = new Headers();
  for (const k of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ]) {
    const v = upstream.headers.get(k);
    if (v) outHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v);

  const ct = upstream.headers.get("content-type") || "";
  if (ct.includes("mpegurl") || target.endsWith(".m3u8")) {
    let text = await upstream.text();
    text = rewriteM3u8(text, target);
    outHeaders.set("content-type", "application/vnd.apple.mpegurl");
    outHeaders.delete("content-length");
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

function rewriteM3u8(text, baseUrl) {
  const base = new URL(baseUrl);
  const selfOrigin = "__WORKER__";
  const lines = text.split(/\r?\n/).map((line) => {
    if (!line || line.startsWith("#")) return line;
    try {
      const abs = new URL(line, base).toString();
      return `${selfOrigin}/hls?url=${encodeURIComponent(abs)}`;
    } catch {
      return line;
    }
  });
  return lines.join("\n");
}

// ---------- YouTube (via Piped) ----------

async function pipedFetchJson(path) {
  // try instances in order; return first response that parses as JSON and looks valid
  let lastErr = null;
  for (const origin of PIPED_INSTANCES) {
    try {
      const res = await fetch(origin + path, {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0 bratan-muzonchik" },
        cf: { cacheTtl: 0 },
      });
      if (!res.ok) { lastErr = new Error("piped " + origin + " HTTP " + res.status); continue; }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { lastErr = new Error("piped " + origin + " non-json"); continue; }
      if (data && data.error) { lastErr = new Error("piped " + origin + " err: " + data.error); continue; }
      return { origin, data };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no piped instance responded");
}

// YouTube-ID regex: exactly 11 chars A-Za-z0-9_-
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
function isYoutubeId(s) { return typeof s === "string" && YT_ID_RE.test(s); }

function normalizeYtSearchItem(it) {
  // Piped search item: { type: "stream", url: "/watch?v=xxx", title, uploaderName, uploaderUrl, uploaderVerified, duration, thumbnail }
  if (!it || it.type !== "stream" || !it.url) return null;
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(it.url);
  if (!m) return null;
  return {
    id: m[1],
    title: (it.title || "").trim(),
    uploader: (it.uploaderName || "").trim(),
    uploaderUrl: it.uploaderUrl || "",
    verified: !!it.uploaderVerified,
    duration: typeof it.duration === "number" ? it.duration : null,  // seconds
    thumbnail: it.thumbnail || "",
  };
}

async function handleYtSearch(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  try {
    const { data } = await pipedFetchJson("/search?q=" + encodeURIComponent(q) + "&filter=music_songs");
    const items = Array.isArray(data.items) ? data.items.map(normalizeYtSearchItem).filter(Boolean) : [];
    return json({ items });
  } catch (e) {
    return json({ error: "piped_unreachable", detail: String(e && e.message || e) }, 502);
  }
}

async function handleYtStreams(url, reqUrl) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!isYoutubeId(id)) return json({ error: "bad id" }, 400);
  let pickedOrigin = null;
  let data = null;
  try {
    const res = await pipedFetchJson("/streams/" + id);
    pickedOrigin = res.origin;
    data = res.data;
  } catch (e) {
    return json({ error: "piped_unreachable", detail: String(e && e.message || e) }, 502);
  }
  if (!data || data.error || !Array.isArray(data.audioStreams) || data.audioStreams.length === 0) {
    // YouTube often returns "sign-in to confirm you're not a bot" for all Piped instances.
    return json({
      error: "no_audio",
      detail: String((data && data.error) || "youtube bot-blocked"),
    }, 502);
  }
  // Pick highest bitrate; prefer opus/m4a
  const ranked = data.audioStreams.slice().sort((a, b) => {
    const br = (b.bitrate || 0) - (a.bitrate || 0);
    if (br !== 0) return br;
    const codecRank = (x) => (x.codec || x.mimeType || "").includes("opus") ? 2 : 1;
    return codecRank(b) - codecRank(a);
  });
  const best = ranked[0];
  if (!best || !best.url) return json({ error: "no audio url" }, 502);
  const proxied = `${reqUrl.origin}/ytaudio?url=${encodeURIComponent(best.url)}`;
  return json({
    id,
    title: data.title || "",
    uploader: data.uploader || "",
    duration: data.duration || null,
    thumbnail: data.thumbnailUrl || "",
    audio: {
      url: proxied,
      bitrate: best.bitrate || null,
      codec: best.codec || "",
      mime: best.mimeType || "",
      format: best.format || "",
    },
    source_instance: pickedOrigin,
  });
}

async function handleYtAudio(url, req) {
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "missing url" }, 400);
  let parsed;
  try { parsed = new URL(target); } catch { return json({ error: "invalid url" }, 400); }
  if (parsed.protocol !== "https:") return json({ error: "https only" }, 400);
  const host = parsed.hostname.toLowerCase();
  if (!YT_AUDIO_ALLOWED_HOSTS.some((re) => re.test(host))) return json({ error: "host not allowed" }, 400);
  const headers = new Headers();
  const range = req.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetch(target, { headers });
  const outHeaders = new Headers();
  for (const k of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ]) {
    const v = upstream.headers.get(k);
    if (v) outHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// ---------- Router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "access-control-allow-methods": "GET, POST, OPTIONS" } });

    try {
      let resp;
      if (url.pathname === "/" || url.pathname === "/health") {
        resp = json({ ok: true, service: "bratan-muzonchik" });
      } else if (url.pathname === "/search") {
        resp = await handleSearch(url, ctx);
      } else if (url.pathname === "/resolve") {
        resp = await handleResolveTranscoding(url, ctx);
      } else if (url.pathname === "/hls") {
        resp = await handleHls(url, request);
      } else if (url.pathname === "/yt/search") {
        resp = await handleYtSearch(url);
      } else if (url.pathname === "/yt/streams") {
        resp = await handleYtStreams(url, url);
      } else if (url.pathname === "/ytaudio") {
        resp = await handleYtAudio(url, request);
      } else if (url.pathname === "/tidal/health") {
        resp = await handleTidalHealth(env, ctx);
      } else if (url.pathname === "/tidal/search") {
        resp = await handleTidalSearch(url, env, ctx);
      } else if (url.pathname === "/tidal/track") {
        resp = await handleTidalTrack(url, env, ctx);
      } else if (url.pathname === "/tidal/audio") {
        resp = await handleTidalAudio(url, request);
      } else if (url.pathname === "/tidal/download") {
        resp = await handleTidalDownload(url, request, env, ctx);
      } else if (url.pathname === "/tg/login/poll") {
        resp = await handleTgLoginPoll(url, env);
      } else if (url.pathname === "/tg/bot-webhook") {
        resp = await handleTgBotWebhook(request, env);
      } else if (url.pathname === "/tg/status") {
        resp = await handleTgStatus(url, env);
      } else if (url.pathname === "/tg/subscribe") {
        resp = await handleTgSubscribe(url, request, env);
      } else if (url.pathname === "/tg/playlist") {
        resp = await handleTgPlaylist(url, request, env);
      } else {
        resp = json({ error: "not found" }, 404);
      }

      if (resp.headers.get("content-type")?.includes("mpegurl")) {
        const selfOrigin = url.origin;
        const body = await resp.text();
        const rewritten = body.replace(/__WORKER__/g, selfOrigin);
        const headers = new Headers(resp.headers);
        return new Response(rewritten, { status: resp.status, headers });
      }
      return resp;
    } catch (err) {
      return json({ error: String(err && err.message) || "internal error" }, 500);
    }
  },
};
