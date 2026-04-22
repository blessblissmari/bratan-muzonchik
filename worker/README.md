# bratan-muzonchik — Cloudflare Worker

Прокси SoundCloud API v2 + HLS для статического фронтенда на GitHub Pages.
Нужен потому что `api-v2.soundcloud.com` не шлёт CORS-заголовки — браузер не
может ходить туда напрямую. Воркер добавляет `Access-Control-Allow-Origin: *`,
автоматически подтягивает актуальный `client_id` из JS-бандлов soundcloud.com
(раз в час или при 401/403) и переписывает m3u8-плейлисты так, чтобы сегменты
тоже шли через него.

## Endpoints

| Метод | Путь | Описание |
|------|------|----------|
| GET  | `/search?q=...&limit=30` | JSON как `api-v2.soundcloud.com/search/tracks` |
| GET  | `/resolve?url=<transcoding url>` | `{ "url": "<m3u8>" }` — resolve HLS playlist URL |
| GET  | `/hls?url=<m3u8 или segment>` | Proxy для m3u8/mp3 сегментов. Playlist переписывается так что сегменты тоже идут через `/hls` |
| GET  | `/health` | health-check |

## Деплой

```bash
cd worker
npm install
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy
```

После первого деплоя URL будет вида
`https://bratan-muzonchik.<твой-аккаунт>.workers.dev` — его надо прописать во
фронтенде (`app.js`, константа `API_BASE`).

## Лимиты Free-плана Cloudflare Workers

- 100 000 запросов/день
- 10 мс CPU на запрос (достаточно, поскольку это тонкий прокси)

Про лимиты не заморачиваемся — для домашнего плеера это overkill.
