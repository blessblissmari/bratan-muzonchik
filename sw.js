// БРАТАН-музончик service worker — минимальный оффлайн-shell + сеть для API.
const CACHE = 'bratan-shell-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js?v=5',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL).catch(() => undefined)
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache media/audio streams or worker API responses — always go to network.
  if (
    url.pathname.startsWith('/tidal/audio') ||
    url.pathname.startsWith('/tidal/download') ||
    url.pathname.startsWith('/hls') ||
    url.pathname.startsWith('/ytaudio') ||
    url.pathname.includes('playlist.m3u8') ||
    url.pathname.endsWith('.flac') ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.m4a') ||
    url.hostname.endsWith('.workers.dev') ||
    url.hostname.endsWith('.sndcdn.com') ||
    url.hostname.endsWith('.googlevideo.com') ||
    url.hostname.endsWith('audio.tidal.com')
  ) {
    return;
  }

  // Static shell — cache-first, falling back to network.
  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          if (!resp || resp.status !== 200 || resp.type === 'opaque') return resp;
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
