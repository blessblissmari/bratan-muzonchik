// bratan-muzonchik Cloudflare Worker
// Proxies SoundCloud API v2 + HLS streams and adds CORS headers so the
// static GitHub Pages frontend can call it directly from the browser.
//
// Endpoints:
//   GET  /search?q=<query>&limit=<n>       -> SoundCloud /search/tracks JSON
//   GET  /resolve?url=<transcoding_url>    -> { url: "<m3u8 url>" }
//   GET  /hls?url=<encoded m3u8 or mp3>    -> raw playlist/segment bytes
//
// client_id is scraped from soundcloud.com JS bundles and cached in-memory
// for the lifetime of the isolate (+ Cache API with 1h TTL to persist longer).

const SC_ORIGIN = "https://api-v2.soundcloud.com";
const SC_HLS_ALLOW = [/\.sndcdn\.com(\/|$)/i];
const CLIENT_ID_REGEX = /client_id[:=]"([A-Za-z0-9]{32})"/;
const CLIENT_ID_CACHE_KEY = "https://bratan.internal/client-id";
const CLIENT_ID_TTL_SECONDS = 3600;

let memoClientId = null;
let memoClientIdAt = 0;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type, Range",
  "access-control-expose-headers": "Content-Length, Content-Type, Content-Range, Accept-Ranges",
  "access-control-max-age": "86400",
};

function corsify(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

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

function invalidateClientId(ctx) {
  memoClientId = null;
  memoClientIdAt = 0;
  ctx.waitUntil(caches.default.delete(CLIENT_ID_CACHE_KEY));
}

async function withClientId(ctx, fn) {
  let id = await getClientId(ctx);
  let resp = await fn(id);
  if (resp.status === 401 || resp.status === 403) {
    invalidateClientId(ctx);
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
  if (!SC_HLS_ALLOW.some((re) => re.test(target))) return json({ error: "host not allowed" }, 400);
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

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
