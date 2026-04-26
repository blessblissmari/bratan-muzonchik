// БРАТАН-музончик — музыкальный плеер.
// Три источника:
//   Tidal       — основной. Lossless FLAC 16/44.1 через OAuth-refresh в воркере.
//                 Играем прямо в <audio>, тот же URL используем для скачивания.
//   SoundCloud — стрим через Cloudflare-воркер (прокси SoundCloud v2 + CORS).
//                 Plain HLS MP3 128 kbps без DRM, играется через hls.js.
//   YouTube    — поиск через воркер /yt/search (проксированный Piped music_songs),
//                 воспроизведение через официальный YouTube iframe-embed.
// Плейлист — localStorage, треки могут быть смешанные из всех источников.

(() => {
  'use strict';

  const API_BASE = 'https://bratan-muzonchik.bratan-muzonchik.workers.dev';

  const LS_KEY_PLAYLIST = 'bratan:playlist:v2';
  const LS_KEY_VOLUME = 'bratan:volume:v1';
  const LS_KEY_LOOP = 'bratan:loop:v1';
  const LS_KEY_SOURCE = 'bratan:source:v1';
  const LS_KEY_OFFICIAL_ONLY = 'bratan:official-only:v1';
  const LS_KEY_FEATURED = 'bratan:featured:v1';

  const SOURCES = { SC: 'soundcloud', YT: 'youtube', TD: 'tidal' };
  const VALID_SOURCES = new Set(Object.values(SOURCES));

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const els = {
    search: $('#search'),
    searchBtn: $('#searchBtn'),
    results: $('#results'),
    playlist: $('#playlist'),
    statusLine: $('#statusLine'),
    quality: $('#qualityBadge'),
    audio: $('#audioEl'),
    nowThumb: $('#nowThumb'),
    nowTitle: $('#nowTitle'),
    nowArtist: $('#nowArtist'),
    prevBtn: $('#prevBtn'),
    playBtn: $('#playBtn'),
    nextBtn: $('#nextBtn'),
    loopBtn: $('#loopBtn'),
    seek: $('#seek'),
    volume: $('#volume'),
    curTime: $('#curTime'),
    durTime: $('#durTime'),
    shuffleBtn: $('#shuffleBtn'),
    exportBtn: $('#exportBtn'),
    importBtn: $('#importBtn'),
    clearBtn: $('#clearBtn'),
    importFile: $('#importFile'),
    sourceSel: $('#sourceSel'),
    ytWrap: $('#ytEmbedWrap'),
    payBtn: $('#payBtn'),
    installBtn: $('#installBtn'),
    tgLoginBtn: $('#tgLoginBtn'),
    tgUserPill: $('#tgUserPill'),
    tgUserPhoto: $('#tgUserPhoto'),
    tgUserName: $('#tgUserName'),
    tgAdminBadge: $('#tgAdminBadge'),
    tgLogoutBtn: $('#tgLogoutBtn'),
    paywallModal: $('#paywallModal'),
    paywallCta: $('#paywallCta'),
    officialToggle: $('#officialToggle'),
    resultTabs: $('#resultTabs'),
    featuredCard: $('#featuredCard'),
    featuredImg: $('#featuredImg'),
    featuredTitle: $('#featuredTitle'),
    featuredArtist: $('#featuredArtist'),
    featuredPlay: $('#featuredPlay'),
    featuredChangeImg: $('#featuredChangeImg'),
    featuredRemove: $('#featuredRemove'),
    featuredImgFile: $('#featuredImgFile'),
  };

  // Paywall + Telegram auth.
  // Flow: кнопка "Войти через TG" открывает t.me/<bot>?start=login_<token>.
  // Бот отправляет update на наш Cloudflare Worker /tg/bot-webhook, тот кладёт
  // юзера в KV по ключу login:<token>. Фронт пуллит /tg/login/poll?token=<token>.
  // Никакого номера телефона / SMS — только Start в TG.
  const TG_BOT_USERNAME = 'bratan_muzonchik_bot';
  const PAYWALL_TG_URL = `https://t.me/${TG_BOT_USERNAME}?start=pay`;
  const PAYWALL_PRICE_LABEL = 'Оплатить 99 ₽/мес';
  const LS_KEY_TG_USER = 'bratan:tg_user:v1';
  const LS_KEY_TG_SESSION = 'bratan:tg_session:v1';
  const LS_KEY_PLAYS = 'bratan:plays:v1';
  const FREE_DAILY_LIMIT = 3;
  // Админы — безлимитный доступ. Должен совпадать со списком в worker/src/tg.js.
  const ADMIN_TG_IDS = new Set([898846950, 422896004]);
  const TG_LOGIN_POLL_INTERVAL_MS = 2000;
  const TG_LOGIN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const LS_KEY_TG_PENDING = 'bratan:tg_pending_login:v1';

  // ---------- State ----------
  const state = {
    source: loadSource(),       // 'soundcloud' | 'youtube' | 'tidal'
    officialOnly: loadOfficialOnly(), // фильтр «только официал», по умолчанию OFF
    resultTab: 'tracks',        // 'tracks' | 'albums' | 'playlists' (только SC)
    results: [],
    sets: [],                   // список альбомов/плейлистов SoundCloud
    featured: loadFeaturedLocal(), // {item, image} | null — закреплённый трек со своей картинкой
    playlist: loadPlaylist(),
    currentId: null,            // id of currently-loaded track (SC numeric / YT 11-char)
    currentItem: null,          // full item (we need item.source to route play)
    currentList: null,          // 'playlist' | 'results'
    isPlaying: false,
    loop: localStorage.getItem(LS_KEY_LOOP) === '1',
    volume: clampInt(parseInt(localStorage.getItem(LS_KEY_VOLUME) || '80', 10), 0, 100),
    consecutiveErrors: 0,
    currentReqToken: 0,         // cancels stale stream-resolve fetches on track change
    hls: null,                  // active Hls.js instance (SC)
    ytPlayer: null,             // active YT.Player instance (YT)
    ytReadyP: null,             // promise that resolves when YT IFrame API loaded
    ytTimer: null,              // interval to poll currentTime (YT has no timeupdate)
  };

  // ---------- Helpers ----------
  function clampInt(n, min, max) { n = parseInt(n, 10); if (isNaN(n)) return min; return Math.max(min, Math.min(max, n)); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  function setStatus(text) { els.statusLine.textContent = text || ''; }
  function setRangeFill(input) {
    const min = parseFloat(input.min || 0), max = parseFloat(input.max || 100);
    const val = parseFloat(input.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--pct', pct + '%');
  }
  function savePlaylist() {
    localStorage.setItem(LS_KEY_PLAYLIST, JSON.stringify(state.playlist));
    scheduleServerPlaylistPush();
  }
  function loadPlaylist() {
    try {
      const raw = localStorage.getItem(LS_KEY_PLAYLIST);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && (typeof x.id === 'number' || typeof x.id === 'string'))
        // Старые версии не ставили `source` — там был только SoundCloud.
        .map((x) => {
          const src = VALID_SOURCES.has(x.source) ? x.source : SOURCES.SC;
          return { ...x, source: src };
        });
    } catch { return []; }
  }
  function loadSource() {
    const s = localStorage.getItem(LS_KEY_SOURCE);
    if (s && VALID_SOURCES.has(s)) return s;
    return SOURCES.TD; // Tidal — основной движок
  }
  function saveSource(s) { localStorage.setItem(LS_KEY_SOURCE, s); }

  function loadOfficialOnly() {
    return localStorage.getItem(LS_KEY_OFFICIAL_ONLY) === '1';
  }
  function saveOfficialOnly(v) {
    localStorage.setItem(LS_KEY_OFFICIAL_ONLY, v ? '1' : '0');
  }

  function loadFeaturedLocal() {
    try {
      const s = localStorage.getItem(LS_KEY_FEATURED);
      if (!s) return null;
      const f = JSON.parse(s);
      if (f && f.item && f.item.id && f.item.source) return f;
    } catch {}
    return null;
  }
  function saveFeaturedLocal(f) {
    if (f && f.item) localStorage.setItem(LS_KEY_FEATURED, JSON.stringify(f));
    else localStorage.removeItem(LS_KEY_FEATURED);
  }

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, mode: 'cors' }).finally(() => clearTimeout(t));
  }

  // ---------- Official-only filter (SoundCloud) ----------
  const REUPLOAD_PATTERNS = [
    /\breupload(ed)?\b/i,
    /\bkaraoke\b/i,
    /\bcover\b/i,
    /\bsped\s*up\b/i, /\bspedup\b/i,
    /\bslowed\b/i,
    /\breverb\b/i,
    /\b8d\s*(audio|version)\b/i,
    /\bnightcore\b/i,
    /\bfan\s*(made|edit|remix|version)\b/i,
    /\bmashup\b/i,
    /\blyric(s)?\s*video\b/i,
    /\bremix\b/i,
    /\binstrumental\b/i,
    /\bacapella\b/i, /\ba\s*capella\b/i,
    /\btype\s*beat\b/i,
    /\bfull\s*album\b/i,
  ];
  function looksLikeReupload(title, artist) {
    const t = (title || '') + ' ' + (artist || '');
    return REUPLOAD_PATTERNS.some((re) => re.test(t));
  }

  function isPlayableSCTrack(tr) {
    if (!tr || tr.kind !== 'track') return false;
    if (tr.state !== 'finished') return false;
    if (tr.streamable === false) return false;
    if (tr.sharing && tr.sharing !== 'public') return false;
    if (!pickHlsMp3Transcoding(tr)) return false;
    return true;
  }

  function isOfficialSCTrack(tr) {
    if (!isPlayableSCTrack(tr)) return false;
    const user = tr.user || {};
    const pm = tr.publisher_metadata || null;
    const verified = user.verified === true;
    const hasPublisherReleaseInfo = !!(pm && (pm.artist || pm.album_title || pm.isrc));
    if (!verified && !hasPublisherReleaseInfo) return false;
    if (looksLikeReupload(tr.title, user.username)) return false;
    return true;
  }

  function pickHlsMp3Transcoding(tr) {
    const list = (tr && tr.media && Array.isArray(tr.media.transcodings)) ? tr.media.transcodings : [];
    return list.find((t) => {
      const fmt = t.format || {};
      return fmt.protocol === 'hls' && fmt.mime_type === 'audio/mpeg';
    }) || null;
  }

  function normalizeSCTrack(tr) {
    const user = tr.user || {};
    const pm = tr.publisher_metadata || {};
    const artist = (pm.artist || user.username || 'Неизвестный исполнитель').trim();
    let thumb = tr.artwork_url || user.avatar_url || '';
    if (thumb) thumb = thumb.replace(/-large(\.[a-z]+)$/i, '-t300x300$1');
    return {
      source: SOURCES.SC,
      id: tr.id,
      urn: tr.urn || `soundcloud:tracks:${tr.id}`,
      title: (tr.title || '').trim() || '(без названия)',
      artist,
      thumb,
      duration: tr.duration ? Math.round(tr.duration / 1000) : null,
      verified: (user.verified === true),
      permalink: tr.permalink_url || '',
      transcoding: pickHlsMp3Transcoding(tr)?.url || null,
    };
  }

  // ---------- YouTube official-only filter ----------
  // Piped `filter=music_songs` уже возвращает только тред YouTube Music Songs
  // (т.е. курируемый официал). Всё равно режем по тому же словарю на всякий случай.
  function normalizeYtItem(it) {
    return {
      source: SOURCES.YT,
      id: it.id,
      title: (it.title || '').trim() || '(без названия)',
      artist: (it.uploader || 'YouTube').replace(/\s*-\s*Topic$/i, ''),
      thumb: it.thumbnail || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
      duration: typeof it.duration === 'number' ? it.duration : null,
      verified: !!it.verified || /-?\s*Topic$/i.test(it.uploader || ''),
      permalink: `https://music.youtube.com/watch?v=${it.id}`,
    };
  }

  function isPlayableYt(item) {
    if (!item || !item.id) return false;
    if (item.duration != null && item.duration < 30) return false;
    return true;
  }

  function isOfficialYt(item) {
    if (!isPlayableYt(item)) return false;
    if (looksLikeReupload(item.title, item.artist)) return false;
    return true;
  }

  // ---------- Search ----------
  async function searchSoundCloud(query) {
    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=40`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.collection) ? data.collection : [];
  }

  async function searchYouTube(query) {
    const url = `${API_BASE}/yt/search?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) {
      let body = {}; try { body = await res.json(); } catch {}
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  async function searchTidal(query) {
    const url = `${API_BASE}/tidal/search?q=${encodeURIComponent(query)}&limit=30`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) {
      let body = {}; try { body = await res.json(); } catch {}
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  function normalizeTidalItem(it) {
    return {
      source: SOURCES.TD,
      id: it.id,
      title: (it.title || '').trim() || '(без названия)',
      artist: it.artist || (it.artists && it.artists[0]) || 'Tidal',
      thumb: it.cover || '',
      duration: typeof it.duration === 'number' ? it.duration : null,
      verified: true,
      permalink: `https://tidal.com/browse/track/${it.id}`,
      audioQuality: it.audioQuality || null,
      explicit: !!it.explicit,
    };
  }

  function isOfficialTidal(item) {
    // Tidal catalog is label-sourced — all results are "официал".
    // Но всё-равно дропаем инструменталки/ремиксы при строгом совпадении в title.
    if (!item || !item.id) return false;
    if (item.duration != null && item.duration < 30) return false;
    return true;
  }

  async function searchScSets(query, kind) {
    const url = `${API_BASE}/sc/${kind}?q=${encodeURIComponent(query)}&limit=30`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.collection) ? data.collection : [];
  }

  async function fetchScSet(id) {
    const url = `${API_BASE}/sc/set?id=${encodeURIComponent(id)}`;
    const res = await fetchWithTimeout(url, 20000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function normalizeScSet(s) {
    const user = s.user || {};
    let thumb = s.artwork_url || (user.avatar_url || '');
    if (thumb) thumb = thumb.replace(/-large(\.[a-z]+)$/i, '-t300x300$1');
    return {
      id: s.id,
      title: (s.title || '').trim() || '(без названия)',
      artist: (user.username || '').trim() || 'SoundCloud',
      thumb,
      trackCount: s.track_count || 0,
      kind: s.set_type || (s.is_album ? 'album' : 'playlist'),
    };
  }

  async function runSearch() {
    const q = els.search.value.trim();
    if (!q) return;
    els.results.innerHTML = '';
    const srcLabel = state.source === SOURCES.TD ? 'Tidal (lossless)'
      : state.source === SOURCES.YT ? 'YouTube Music'
      : 'SoundCloud';
    setStatus(`Ищу на ${srcLabel}…`);
    const showTabs = state.source === SOURCES.SC;
    if (els.resultTabs) els.resultTabs.hidden = !showTabs;
    if (!showTabs) state.resultTab = 'tracks';
    try {
      if (state.source === SOURCES.TD) {
        const raw = await searchTidal(q);
        const items = raw.map(normalizeTidalItem).filter(isOfficialTidal);
        state.results = items; state.sets = [];
        renderResults();
        if (!items.length) setStatus('Ничего не нашёл, бро.');
        else setStatus(`Найдено: ${items.length} треков (Tidal).`);
      } else if (state.source === SOURCES.YT) {
        const raw = await searchYouTube(q);
        const passes = state.officialOnly ? isOfficialYt : isPlayableYt;
        const items = raw.map(normalizeYtItem).filter(passes);
        state.results = items; state.sets = [];
        renderResults();
        const dropped = raw.length - items.length;
        if (!items.length && raw.length) setStatus('Нашёл только перезаливы/каверы — уточни запрос.');
        else if (!items.length) setStatus('Ничего не нашёл, бро.');
        else if (state.officialOnly && dropped > 0) setStatus(`Найдено: ${items.length} официальных · отсеял ${dropped}.`);
        else setStatus(`Найдено: ${items.length} треков (YouTube).`);
      } else if (state.resultTab === 'tracks') {
        const raw = await searchSoundCloud(q);
        const passes = state.officialOnly ? isOfficialSCTrack : isPlayableSCTrack;
        const items = raw.filter(passes).map(normalizeSCTrack);
        state.results = items; state.sets = [];
        renderResults();
        const dropped = raw.length - items.length;
        if (!items.length && raw.length && state.officialOnly) setStatus('Нашёл только перезаливы/каверы — выключи «только официал» или уточни запрос.');
        else if (!items.length) setStatus('Ничего не нашёл, бро.');
        else if (state.officialOnly && dropped > 0) setStatus(`Найдено: ${items.length} официальных · отсеял ${dropped}.`);
        else setStatus(`Найдено: ${items.length} треков (SoundCloud).`);
      } else {
        // SC albums / playlists
        const kind = state.resultTab; // 'albums' | 'playlists'
        const raw = await searchScSets(q, kind);
        const sets = raw.map(normalizeScSet).filter((s) => s.id);
        state.sets = sets; state.results = [];
        renderResults();
        const label = kind === 'albums' ? 'альбомов' : 'плейлистов';
        if (!sets.length) setStatus(`Не нашёл ${label}.`);
        else setStatus(`Найдено: ${sets.length} ${label}.`);
      }
    } catch (e) {
      console.error(e);
      const msg = (e && e.message) || 'сеть';
      if (state.source === SOURCES.YT && /piped|unreachable|bot/i.test(msg)) {
        setStatus('YouTube временно недоступен. Переключись на Tidal/SoundCloud.');
      } else if (state.source === SOURCES.TD) {
        setStatus('Tidal недоступен: ' + msg + '.');
      } else {
        setStatus('Поиск не удался: ' + msg);
      }
    }
  }

  // ---------- Rendering ----------
  function itemKey(item) { return `${item.source}:${item.id}`; }

  function renderResults() {
    els.results.innerHTML = '';
    if (state.sets && state.sets.length) {
      renderSets();
      return;
    }
    if (!state.results.length) {
      els.results.innerHTML = '<li class="empty">Чё, бро? Введи запрос сверху.</li>';
      return;
    }
    const tpl = document.getElementById('tpl-result');
    const curKey = state.currentItem ? itemKey(state.currentItem) : null;
    for (const item of state.results) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      fillRow(node, item);
      node.querySelector('.play').addEventListener('click', () => playItem(item, 'results'));
      node.querySelector('.add').addEventListener('click', (ev) => {
        ev.stopPropagation();
        addToPlaylist(item);
      });
      node.addEventListener('dblclick', () => playItem(item, 'results'));
      if (curKey && itemKey(item) === curKey) node.classList.add('playing');
      els.results.appendChild(node);
    }
  }

  function renderSets() {
    const tpl = document.getElementById('tpl-set');
    for (const s of state.sets) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const img = node.querySelector('.thumb');
      img.src = s.thumb || '';
      img.loading = 'lazy';
      node.querySelector('.title').textContent = s.title;
      const countLabel = s.trackCount ? ` · ${s.trackCount} трек.` : '';
      node.querySelector('.sub').textContent = `${s.artist}${countLabel}`;
      node.querySelector('.open-set').addEventListener('click', () => openScSet(s));
      els.results.appendChild(node);
    }
  }

  async function openScSet(s) {
    setStatus(`Открываю «${s.title}»…`);
    try {
      const data = await fetchScSet(s.id);
      const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
      const tracks = rawTracks.filter(isPlayableSCTrack).map(normalizeSCTrack);
      if (!tracks.length) { setStatus('В этом наборе нет воспроизводимых треков.'); return; }
      let added = 0;
      for (const t of tracks) {
        if (!state.playlist.some((x) => itemKey(x) === itemKey(t))) {
          state.playlist.push({
            source: t.source, id: t.id, urn: t.urn, title: t.title,
            artist: t.artist, thumb: t.thumb, duration: t.duration,
            verified: !!t.verified, permalink: t.permalink, transcoding: t.transcoding,
          });
          added++;
        }
      }
      savePlaylist();
      renderPlaylist();
      setStatus(`Добавил в плейлист ${added} из ${tracks.length} треков из «${s.title}».`);
    } catch (e) {
      setStatus('Не смог открыть набор: ' + ((e && e.message) || 'ошибка'));
    }
  }

  function renderPlaylist() {
    els.playlist.innerHTML = '';
    if (!state.playlist.length) {
      els.playlist.innerHTML = '<li class="empty">Плейлист пуст. Добавляй треки кнопкой ＋ из результатов.</li>';
      return;
    }
    const tpl = document.getElementById('tpl-plitem');
    const curKey = state.currentItem ? itemKey(state.currentItem) : null;
    const featKey = state.featured && state.featured.item ? itemKey(state.featured.item) : null;
    state.playlist.forEach((item, idx) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      fillRow(node, item);
      node.dataset.id = String(item.id);
      node.dataset.index = String(idx);
      node.querySelector('.play').addEventListener('click', () => playItem(item, 'playlist'));
      node.querySelector('.remove').addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeFromPlaylist(item);
      });
      const pinBtn = node.querySelector('.pin');
      if (pinBtn) {
        pinBtn.hidden = false;
        if (featKey && itemKey(item) === featKey) pinBtn.classList.add('active');
        pinBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pinTrackAsFeatured(item);
        });
      }
      node.addEventListener('dblclick', () => playItem(item, 'playlist'));
      attachDragHandlers(node);
      if (curKey && itemKey(item) === curKey && state.currentList === 'playlist') node.classList.add('playing');
      els.playlist.appendChild(node);
    });
  }

  function fillRow(node, item) {
    const img = node.querySelector('.thumb');
    img.src = item.thumb || '';
    img.loading = 'lazy';
    img.alt = '';
    node.querySelector('.title').textContent = item.title;
    const durStr = item.duration ? ' · ' + fmtTime(item.duration) : '';
    const badge = item.verified ? ' ✓' : '';
    const srcTag = item.source === SOURCES.YT ? '[YT] '
      : item.source === SOURCES.TD ? '[Tidal] '
      : '';
    const qTag = (item.source === SOURCES.TD && item.audioQuality)
      ? ' · ' + tidalQualityLabel(item.audioQuality)
      : '';
    node.querySelector('.sub').textContent = srcTag + item.artist + badge + durStr + qTag;

    const dl = node.querySelector('.dl');
    if (dl) {
      if (item.source === SOURCES.TD) {
        dl.hidden = false;
        dl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          downloadTidal(item);
        });
      } else {
        dl.hidden = true;
      }
    }
  }

  function tidalQualityLabel(q) {
    switch ((q || '').toUpperCase()) {
      case 'HI_RES_LOSSLESS': return 'HiRes FLAC';
      case 'HI_RES': return 'MQA';
      case 'LOSSLESS': return 'FLAC 16/44';
      case 'HIGH': return 'AAC 320';
      case 'LOW': return 'AAC 96';
      default: return q;
    }
  }

  function downloadTidal(item) {
    if (!item || item.source !== SOURCES.TD) return;
    const url = `${API_BASE}/tidal/download?id=${encodeURIComponent(item.id)}&quality=LOSSLESS`;
    const a = document.createElement('a');
    a.href = url;
    a.download = ''; // use server-provided filename via Content-Disposition
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`Качаю «${item.title}»…`);
  }

  // ---------- Playlist mgmt ----------
  function addToPlaylist(item) {
    if (state.playlist.some((x) => itemKey(x) === itemKey(item))) {
      setStatus(`«${item.title}» уже в плейлисте.`);
      return;
    }
    state.playlist.push({
      source: item.source,
      id: item.id,
      urn: item.urn || null,
      title: item.title,
      artist: item.artist,
      thumb: item.thumb,
      duration: item.duration || null,
      verified: !!item.verified,
      permalink: item.permalink || '',
      transcoding: item.transcoding || null,
      audioQuality: item.audioQuality || null,
    });
    savePlaylist();
    renderPlaylist();
    setStatus(`Добавил в плейлист: ${item.title}`);
  }

  function removeFromPlaylist(item) {
    const key = itemKey(item);
    state.playlist = state.playlist.filter((x) => itemKey(x) !== key);
    savePlaylist();
    renderPlaylist();
  }

  function clearPlaylist() {
    if (!state.playlist.length) return;
    if (!confirm('Точно снести весь плейлист?')) return;
    state.playlist = [];
    savePlaylist();
    renderPlaylist();
  }

  function shufflePlaylist() {
    const arr = state.playlist.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    state.playlist = arr;
    savePlaylist();
    renderPlaylist();
  }

  function exportPlaylist() {
    const blob = new Blob([JSON.stringify(state.playlist, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bratan-playlist.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importPlaylist(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result);
        if (!Array.isArray(arr)) throw new Error('not array');
        const clean = arr
          .filter((x) => x && (typeof x.id === 'number' || typeof x.id === 'string') && typeof x.title === 'string')
          .map((x) => ({ source: x.source || SOURCES.SC, ...x, source: x.source || SOURCES.SC }));
        const seen = new Set(state.playlist.map(itemKey));
        for (const it of clean) if (!seen.has(itemKey(it))) { state.playlist.push(it); seen.add(itemKey(it)); }
        savePlaylist();
        renderPlaylist();
        setStatus(`Импортировал ${clean.length} треков.`);
      } catch (e) {
        setStatus('Не смог прочитать файл плейлиста.');
      }
    };
    reader.readAsText(file);
  }

  // ---------- Featured (pinned) track ----------
  function normalizeFeaturedItem(item) {
    return {
      source: item.source, id: item.id, urn: item.urn || null,
      title: item.title, artist: item.artist, thumb: item.thumb || '',
      duration: item.duration || null, verified: !!item.verified,
      permalink: item.permalink || '', transcoding: item.transcoding || null,
      audioQuality: item.audioQuality || null,
    };
  }

  function pinTrackAsFeatured(item) {
    const prevImage = (state.featured && state.featured.item && itemKey(state.featured.item) === itemKey(item))
      ? (state.featured.image || '') : '';
    state.featured = { item: normalizeFeaturedItem(item), image: prevImage };
    saveFeaturedLocal(state.featured);
    renderFeatured();
    renderPlaylist();
    scheduleServerFeaturedPush();
    setStatus(`Закрепил «${item.title}». Можешь залить свою картинку.`);
  }

  function removeFeatured() {
    state.featured = null;
    saveFeaturedLocal(null);
    renderFeatured();
    renderPlaylist();
    scheduleServerFeaturedPush(true);
  }

  async function setFeaturedImageFromFile(file) {
    if (!file) return;
    if (!/^image\//i.test(file.type)) { setStatus('Нужен файл-картинка.'); return; }
    if (file.size > 600 * 1024) {
      try {
        const dataUrl = await resizeImageToDataUrl(file, 600);
        applyFeaturedImage(dataUrl);
      } catch { setStatus('Не смог прочитать картинку.'); }
      return;
    }
    const reader = new FileReader();
    reader.onload = () => applyFeaturedImage(String(reader.result || ''));
    reader.onerror = () => setStatus('Не смог прочитать картинку.');
    reader.readAsDataURL(file);
  }

  function applyFeaturedImage(dataUrl) {
    if (!state.featured) return;
    state.featured.image = dataUrl || '';
    saveFeaturedLocal(state.featured);
    renderFeatured();
    scheduleServerFeaturedPush();
    setStatus('Картинка закреплена.');
  }

  async function resizeImageToDataUrl(file, maxSide) {
    const blobUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = blobUrl;
      });
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.85);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  function renderFeatured() {
    const card = els.featuredCard;
    if (!card) return;
    const user = loadTgUser();
    const f = state.featured;
    if (!user || !f || !f.item) { card.hidden = true; return; }
    card.hidden = false;
    if (els.featuredImg) {
      if (f.image) { els.featuredImg.src = f.image; els.featuredImg.style.filter = ''; }
      else if (f.item.thumb) { els.featuredImg.src = f.item.thumb; els.featuredImg.style.filter = 'blur(8px)'; }
      else { els.featuredImg.removeAttribute('src'); els.featuredImg.style.filter = 'blur(8px)'; }
    }
    if (els.featuredTitle) els.featuredTitle.textContent = f.item.title || '';
    if (els.featuredArtist) els.featuredArtist.textContent = f.item.artist || '';
  }

  // ---------- Server featured sync ----------
  let featuredPushTimer = null;
  let lastPushedFeaturedJson = null;

  function scheduleServerFeaturedPush(immediate) {
    const session = loadTgSession();
    if (!session) return;
    if (featuredPushTimer) clearTimeout(featuredPushTimer);
    featuredPushTimer = setTimeout(pushServerFeatured, immediate ? 0 : 1200);
  }

  async function pushServerFeatured() {
    const session = loadTgSession();
    if (!session) return;
    try {
      if (!state.featured || !state.featured.item) {
        const r = await fetch(`${API_BASE}/tg/featured?session=${encodeURIComponent(session)}`, { method: 'DELETE' });
        if (r.ok) lastPushedFeaturedJson = '';
        else if (r.status === 401) saveTgSession(null);
        return;
      }
      const body = JSON.stringify({ item: state.featured.item, image: state.featured.image || '' });
      if (body === lastPushedFeaturedJson) return;
      const r = await fetch(`${API_BASE}/tg/featured?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (r.ok) lastPushedFeaturedJson = body;
      else if (r.status === 401) saveTgSession(null);
    } catch { /* transient */ }
  }

  async function pullServerFeatured() {
    const session = loadTgSession();
    if (!session) return;
    try {
      const r = await fetch(`${API_BASE}/tg/featured?session=${encodeURIComponent(session)}`);
      if (!r.ok) { if (r.status === 401) saveTgSession(null); return; }
      const data = await r.json().catch(() => null);
      if (!data || !data.ok) return;
      const text = String(data.featured || '');
      if (!text) { lastPushedFeaturedJson = ''; return; }
      let remote;
      try { remote = JSON.parse(text); } catch { return; }
      if (!remote || !remote.item || !remote.item.id) return;
      state.featured = { item: remote.item, image: remote.image || '' };
      saveFeaturedLocal(state.featured);
      renderFeatured();
      renderPlaylist();
      lastPushedFeaturedJson = JSON.stringify(state.featured);
    } catch { /* noop */ }
  }

  // ---------- Drag & drop reorder ----------
  let dragSrcIndex = null;
  function attachDragHandlers(node) {
    node.addEventListener('dragstart', (e) => {
      dragSrcIndex = parseInt(node.dataset.index, 10);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragSrcIndex)); } catch {}
      node.style.opacity = '0.5';
    });
    node.addEventListener('dragend', () => { node.style.opacity = ''; dragSrcIndex = null; });
    node.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = dragSrcIndex;
      const to = parseInt(node.dataset.index, 10);
      if (from == null || isNaN(to) || from === to) return;
      const item = state.playlist.splice(from, 1)[0];
      state.playlist.splice(to, 0, item);
      savePlaylist();
      renderPlaylist();
    });
  }

  // ---------- Audio player (SoundCloud branch) ----------
  function initAudio() {
    els.audio.volume = state.volume / 100;
    els.audio.addEventListener('play', () => {
      state.isPlaying = true;
      els.playBtn.textContent = '⏸';
    });
    els.audio.addEventListener('playing', () => {
      state.isPlaying = true;
      state.consecutiveErrors = 0;
      els.playBtn.textContent = '⏸';
    });
    els.audio.addEventListener('pause', () => {
      state.isPlaying = false;
      els.playBtn.textContent = '▶';
    });
    els.audio.addEventListener('ended', () => {
      state.isPlaying = false;
      els.playBtn.textContent = '▶';
      onTrackEnded();
    });
    els.audio.addEventListener('timeupdate', () => {
      if (state.currentItem && state.currentItem.source === SOURCES.YT) return;
      const cur = els.audio.currentTime || 0;
      const dur = els.audio.duration || 0;
      els.curTime.textContent = fmtTime(cur);
      if (dur > 0 && isFinite(dur)) {
        els.durTime.textContent = fmtTime(dur);
        if (!els.seek._dragging) {
          els.seek.value = Math.floor((cur / dur) * 1000);
          setRangeFill(els.seek);
        }
      }
    });
    els.audio.addEventListener('loadedmetadata', () => {
      if (state.currentItem && state.currentItem.source === SOURCES.YT) return;
      const dur = els.audio.duration || 0;
      if (dur > 0 && isFinite(dur)) els.durTime.textContent = fmtTime(dur);
    });
    els.audio.addEventListener('error', () => {
      // YouTube ошибки идут через YT IFrame onError; SC/Tidal — через <audio>.
      if (state.currentItem && state.currentItem.source === SOURCES.YT) return;
      onStreamError('Стрим отвалился');
    });
  }

  function teardownHls() {
    if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; }
  }

  function stopCurrent() {
    teardownHls();
    try { els.audio.pause(); } catch {}
    els.audio.removeAttribute('src');
    els.audio.load();
    stopYt();
  }

  function onStreamError(message) {
    state.consecutiveErrors++;
    setStatus(`${message}. Переключаюсь дальше…`);
    if (state.consecutiveErrors > 6) {
      setStatus('Слишком много подряд недоступных треков — стоп. Выбери другой.');
      return;
    }
    setTimeout(() => autoAdvance(), 300);
  }

  async function resolveSCStream(transcodingUrl) {
    const url = `${API_BASE}/resolve?url=${encodeURIComponent(transcodingUrl)}`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) throw new Error('stream resolve HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.url) throw new Error('нет m3u8 url');
    return data.url;
  }

  function attachPlaylistUrl(m3u8Url) {
    teardownHls();
    const Hls = window.Hls;
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
      state.hls = hls;
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve();
        };
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data && data.fatal) {
            done(new Error('HLS fatal: ' + (data.details || data.type || '')));
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          els.audio.play().then(() => done()).catch(done);
        });
        hls.loadSource(m3u8Url);
        hls.attachMedia(els.audio);
      });
    }
    if (els.audio.canPlayType('application/vnd.apple.mpegurl')) {
      els.audio.src = m3u8Url;
      return els.audio.play();
    }
    throw new Error('браузер не умеет HLS');
  }

  async function refetchSCTrack(id) {
    const res = await fetchWithTimeout(`${API_BASE}/search?q=${encodeURIComponent(String(id))}&limit=10`, 10000);
    if (!res.ok) throw new Error('track refetch HTTP ' + res.status);
    const data = await res.json();
    const arr = Array.isArray(data.collection) ? data.collection : [];
    const hit = arr.find((t) => t.id === id);
    if (!hit) throw new Error('track not found');
    return hit;
  }

  // ---------- Audio player (Tidal branch) ----------
  async function playTidal(item, token) {
    const url = `${API_BASE}/tidal/track?id=${encodeURIComponent(item.id)}&quality=LOSSLESS`;
    const res = await fetchWithTimeout(url, 20000);
    if (token !== state.currentReqToken) return;
    if (!res.ok) {
      let body = {}; try { body = await res.json(); } catch {}
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    if (!data.stream) throw new Error('нет stream url');
    teardownHls();
    els.audio.src = data.stream;
    els.audio.volume = state.volume / 100;
    try { await els.audio.play(); } catch (e) { throw e; }
    const codec = (data.codec || '').toLowerCase();
    const qLabel = tidalQualityLabel(data.quality || data.audioQuality);
    const bits = data.bitDepth && data.sampleRate
      ? ` · ${data.bitDepth}bit/${Math.round(data.sampleRate/1000)}kHz`
      : '';
    els.quality.textContent = `Tidal · ${qLabel}${bits}`;
    setStatus(`Играю «${item.title}» (${qLabel})`);
  }

  async function playSoundCloud(item, token) {
    let transcoding = item.transcoding;
    if (!transcoding) {
      const tr = await refetchSCTrack(item.id);
      if (token !== state.currentReqToken) return;
      const pick = pickHlsMp3Transcoding(tr);
      if (!pick) throw new Error('у трека нет plain-HLS (DRM)');
      transcoding = pick.url;
      const pi = state.playlist.find((x) => itemKey(x) === itemKey(item));
      if (pi) { pi.transcoding = transcoding; savePlaylist(); }
    }
    const m3u8 = await resolveSCStream(transcoding);
    if (token !== state.currentReqToken) return;
    await attachPlaylistUrl(m3u8);
    els.audio.volume = state.volume / 100;
    els.quality.textContent = '128 kbps · mp3 · HLS';
    setStatus(`Играю «${item.title}» (128 kbps · mp3)`);
  }

  // ---------- Audio player (YouTube branch, iframe API) ----------
  function ensureYtApi() {
    if (state.ytReadyP) return state.ytReadyP;
    state.ytReadyP = new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch {} }
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    });
    return state.ytReadyP;
  }

  function stopYtTimer() { if (state.ytTimer) { clearInterval(state.ytTimer); state.ytTimer = null; } }

  function stopYt() {
    stopYtTimer();
    if (state.ytPlayer) {
      try { state.ytPlayer.stopVideo(); } catch {}
    }
    els.ytWrap.hidden = true;
  }

  function startYtTimer() {
    stopYtTimer();
    state.ytTimer = setInterval(() => {
      const p = state.ytPlayer;
      if (!p || !p.getCurrentTime) return;
      let cur = 0, dur = 0;
      try { cur = p.getCurrentTime() || 0; dur = p.getDuration() || 0; } catch {}
      els.curTime.textContent = fmtTime(cur);
      if (dur > 0) {
        els.durTime.textContent = fmtTime(dur);
        if (!els.seek._dragging) {
          els.seek.value = Math.floor((cur / dur) * 1000);
          setRangeFill(els.seek);
        }
      }
    }, 500);
  }

  function playYouTube(item, token) {
    return new Promise(async (resolve, reject) => {
      try {
        await ensureYtApi();
        if (token !== state.currentReqToken) return resolve();
        els.ytWrap.hidden = false;
        // YouTube IFrame API полностью пересоздаёт iframe при каждом new Player
        // — чтобы не копить DOM, убиваем старый и ставим свежий.
        if (state.ytPlayer) { try { state.ytPlayer.destroy(); } catch {} state.ytPlayer = null; }
        const frame = document.createElement('div');
        frame.id = 'ytFrame';
        els.ytWrap.innerHTML = '';
        els.ytWrap.appendChild(frame);

        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve();
        };

        state.ytPlayer = new window.YT.Player('ytFrame', {
          width: '100%',
          height: '100%',
          videoId: item.id,
          playerVars: {
            autoplay: 1,
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            rel: 0,
            fs: 0,
          },
          events: {
            onReady: (ev) => {
              try {
                ev.target.setVolume(state.volume);
                ev.target.playVideo();
              } catch {}
              startYtTimer();
              els.quality.textContent = 'YouTube';
              setStatus(`Играю «${item.title}»`);
              done();
            },
            onStateChange: (ev) => {
              // 0=ended 1=playing 2=paused 3=buffering 5=cued
              const s = ev.data;
              if (s === 1) { state.isPlaying = true; els.playBtn.textContent = '⏸'; state.consecutiveErrors = 0; }
              else if (s === 2) { state.isPlaying = false; els.playBtn.textContent = '▶'; }
              else if (s === 0) { state.isPlaying = false; els.playBtn.textContent = '▶'; onTrackEnded(); }
            },
            onError: (ev) => {
              // 2=bad id, 5=html5 player err, 100=removed, 101/150=embed-blocked by label
              const code = ev && ev.data;
              const embedBlocked = code === 101 || code === 150;
              done(new Error(embedBlocked ? 'лейбл запретил embed' : 'YouTube err ' + code));
            },
          },
        });
      } catch (e) { reject(e); }
    });
  }

  // ---------- Paywall / daily free limit ----------
  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function readPlays() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY_PLAYS) || 'null');
      if (raw && raw.date === todayKey() && Array.isArray(raw.ids)) return raw;
    } catch { /* noop */ }
    return { date: todayKey(), ids: [] };
  }

  function writePlays(plays) {
    try { localStorage.setItem(LS_KEY_PLAYS, JSON.stringify(plays)); } catch { /* noop */ }
  }

  function isSubscribed() {
    const user = loadTgUser();
    if (!user) return false;
    if (ADMIN_TG_IDS.has(Number(user.id))) return true;
    const sub = user.subscription;
    if (!sub) return false;
    if (sub.subscribed === true) return true;
    if (sub.until && Number(sub.until) > Math.floor(Date.now() / 1000)) return true;
    return false;
  }

  function freePlaysLeft() {
    const plays = readPlays();
    return Math.max(0, FREE_DAILY_LIMIT - plays.ids.length);
  }

  function canPlay(item) {
    if (isSubscribed()) return true;
    const plays = readPlays();
    const key = itemKey(item);
    if (plays.ids.includes(key)) return true; // don't double-count replays of same track
    return plays.ids.length < FREE_DAILY_LIMIT;
  }

  function recordPlay(item) {
    if (isSubscribed()) return;
    const plays = readPlays();
    const key = itemKey(item);
    if (!plays.ids.includes(key)) {
      plays.ids.push(key);
      writePlays(plays);
    }
  }

  function showPaywall() {
    if (!els.paywallModal) return;
    if (els.paywallCta) els.paywallCta.href = els.payBtn ? els.payBtn.href : PAYWALL_TG_URL;
    els.paywallModal.hidden = false;
    els.paywallModal.setAttribute('aria-hidden', 'false');
  }

  function hidePaywall() {
    if (!els.paywallModal) return;
    els.paywallModal.hidden = true;
    els.paywallModal.setAttribute('aria-hidden', 'true');
  }

  function setupPaywallModal() {
    if (!els.paywallModal) return;
    els.paywallModal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && (t.hasAttribute('data-close') || t.closest('[data-close]'))) hidePaywall();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.paywallModal.hidden) hidePaywall();
    });
  }

  // ---------- Unified play / navigation ----------
  async function playItem(item, listHint) {
    if (!canPlay(item)) {
      setStatus(`Лимит: ${FREE_DAILY_LIMIT} трека в день на бесплатном тарифе`);
      showPaywall();
      return;
    }
    recordPlay(item);
    state.currentId = item.id;
    state.currentItem = item;
    state.currentList = listHint;
    els.nowThumb.src = item.thumb || '';
    els.nowTitle.textContent = item.title;
    els.nowArtist.textContent = item.artist;
    els.curTime.textContent = '0:00';
    els.durTime.textContent = item.duration ? fmtTime(item.duration) : '0:00';
    els.seek.value = 0; setRangeFill(els.seek);
    els.quality.textContent = '';
    for (const li of document.querySelectorAll('.row.playing')) li.classList.remove('playing');
    renderResults(); renderPlaylist();

    const token = ++state.currentReqToken;

    // stop the other source's player cleanly
    if (item.source === SOURCES.YT) {
      teardownHls();
      try { els.audio.pause(); } catch {}
      els.audio.removeAttribute('src');
      els.audio.load();
    } else {
      stopYt();
    }

    setStatus(`Граблю аудио «${item.title}»…`);
    try {
      if (item.source === SOURCES.YT) {
        await playYouTube(item, token);
      } else if (item.source === SOURCES.TD) {
        await playTidal(item, token);
      } else {
        await playSoundCloud(item, token);
      }
      if (token !== state.currentReqToken) return;
    } catch (e) {
      if (token !== state.currentReqToken) return;
      console.error(e);
      const msg = (e && e.message) || 'ошибка';
      if (/embed|piped|unreachable|bot|151?0?/i.test(msg)) {
        onStreamError('Этот трек недоступен для плеера');
      } else {
        onStreamError('Не достал стрим');
      }
    }
  }

  function listFor() {
    if (state.currentList === 'playlist') return state.playlist;
    if (state.currentList === 'results') return state.results;
    return [];
  }

  function currentIndex(list) {
    if (!state.currentItem) return -1;
    const key = itemKey(state.currentItem);
    return list.findIndex((x) => itemKey(x) === key);
  }

  function autoAdvance() {
    const list = listFor();
    if (!list.length) return;
    const idx = currentIndex(list);
    if (idx < 0) return;
    const nextIdx = idx + 1;
    if (nextIdx >= list.length) {
      if (state.loop && state.currentList === 'playlist') { playItem(list[0], state.currentList); return; }
      setStatus('Доехали до конца списка.');
      return;
    }
    playItem(list[nextIdx], state.currentList);
  }

  function onTrackEnded() {
    state.consecutiveErrors = 0;
    autoAdvance();
  }

  function playPrev() {
    const list = listFor();
    if (list.length && state.currentItem) {
      const idx = currentIndex(list);
      let prev = idx - 1;
      if (prev < 0) prev = (state.loop && state.currentList === 'playlist') ? list.length - 1 : 0;
      playItem(list[prev], state.currentList);
    } else if (state.playlist.length) {
      playItem(state.playlist[0], 'playlist');
    }
  }
  function playNext() {
    const list = listFor();
    if (list.length && state.currentItem) {
      const idx = currentIndex(list);
      let next = idx + 1;
      if (next >= list.length) next = (state.loop && state.currentList === 'playlist') ? 0 : list.length - 1;
      playItem(list[next], state.currentList);
    } else if (state.playlist.length) {
      playItem(state.playlist[0], 'playlist');
    }
  }

  function togglePlay() {
    if (!state.currentItem) {
      if (state.playlist.length) playItem(state.playlist[0], 'playlist');
      return;
    }
    if (state.currentItem.source === SOURCES.YT) {
      const p = state.ytPlayer;
      if (!p) return;
      try {
        const s = p.getPlayerState();
        if (s === 1 || s === 3) p.pauseVideo(); else p.playVideo();
      } catch {}
    } else {
      if (els.audio.paused) els.audio.play().catch(() => {});
      else els.audio.pause();
    }
  }

  function seekTo(pct) {
    pct = Math.max(0, Math.min(1, pct));
    if (state.currentItem && state.currentItem.source === SOURCES.YT) {
      const p = state.ytPlayer;
      if (!p) return;
      try { const dur = p.getDuration() || 0; if (dur > 0) p.seekTo(dur * pct, true); } catch {}
    } else {
      const dur = els.audio.duration || 0;
      if (dur > 0 && isFinite(dur)) { try { els.audio.currentTime = dur * pct; } catch {} }
    }
  }

  function setVolume(v) {
    state.volume = clampInt(v, 0, 100);
    localStorage.setItem(LS_KEY_VOLUME, String(state.volume));
    els.audio.volume = state.volume / 100;
    if (state.ytPlayer) { try { state.ytPlayer.setVolume(state.volume); } catch {} }
  }

  function updateLoopBtn() { els.loopBtn.classList.toggle('active', state.loop); }

  function applySourceToUi() {
    els.sourceSel.value = state.source;
    // Clear results when switching source — они от прежнего провайдера.
    state.results = [];
    state.sets = [];
    state.resultTab = 'tracks';
    if (els.resultTabs) {
      els.resultTabs.hidden = state.source !== SOURCES.SC;
      for (const t of els.resultTabs.querySelectorAll('.tab')) {
        t.classList.toggle('active', t.dataset.tab === 'tracks');
      }
    }
    renderResults();
    const ph = state.source === SOURCES.TD
      ? 'Ищем на Tidal — трек, артист, альбом…'
      : state.source === SOURCES.YT
        ? 'Ищем на YouTube Music — трек, артист, альбом…'
        : 'Чё слушаем, бро? Забей трек, артиста, альбом…';
    els.search.placeholder = ph;
    setStatus('');
  }

  // ---------- Wiring ----------
  function wire() {
    els.searchBtn.addEventListener('click', runSearch);
    els.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    els.playBtn.addEventListener('click', togglePlay);
    els.prevBtn.addEventListener('click', playPrev);
    els.nextBtn.addEventListener('click', playNext);
    els.loopBtn.addEventListener('click', () => {
      state.loop = !state.loop;
      localStorage.setItem(LS_KEY_LOOP, state.loop ? '1' : '0');
      updateLoopBtn();
    });
    els.shuffleBtn.addEventListener('click', shufflePlaylist);
    els.clearBtn.addEventListener('click', clearPlaylist);
    els.exportBtn.addEventListener('click', exportPlaylist);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importPlaylist(f);
      els.importFile.value = '';
    });

    els.seek.addEventListener('input', () => { els.seek._dragging = true; setRangeFill(els.seek); });
    els.seek.addEventListener('change', () => {
      els.seek._dragging = false;
      seekTo(parseInt(els.seek.value, 10) / 1000);
    });
    els.volume.value = state.volume;
    setRangeFill(els.volume);
    els.volume.addEventListener('input', () => {
      setVolume(els.volume.value);
      setRangeFill(els.volume);
    });

    els.sourceSel.addEventListener('change', () => {
      const v = els.sourceSel.value;
      state.source = VALID_SOURCES.has(v) ? v : SOURCES.TD;
      saveSource(state.source);
      applySourceToUi();
    });

    if (els.officialToggle) {
      els.officialToggle.checked = !!state.officialOnly;
      els.officialToggle.addEventListener('change', () => {
        state.officialOnly = !!els.officialToggle.checked;
        saveOfficialOnly(state.officialOnly);
        if (els.search.value.trim()) runSearch();
      });
    }

    if (els.resultTabs) {
      els.resultTabs.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.tab');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (!tab) return;
        // Альбомы и плейлисты есть только у SoundCloud — авто-переключаем источник.
        if ((tab === 'albums' || tab === 'playlists') && state.source !== SOURCES.SC) {
          state.source = SOURCES.SC;
          saveSource(state.source);
          applySourceToUi();
        }
        if (tab === state.resultTab) return;
        state.resultTab = tab;
        for (const t of els.resultTabs.querySelectorAll('.tab')) {
          t.classList.toggle('active', t.dataset.tab === tab);
        }
        if (els.search.value.trim()) runSearch();
      });
    }

    if (els.featuredPlay) {
      els.featuredPlay.addEventListener('click', () => {
        if (state.featured && state.featured.item) playItem(state.featured.item, 'playlist');
      });
    }
    if (els.featuredChangeImg && els.featuredImgFile) {
      els.featuredChangeImg.addEventListener('click', () => els.featuredImgFile.click());
      els.featuredImgFile.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) setFeaturedImageFromFile(f);
        els.featuredImgFile.value = '';
      });
    }
    if (els.featuredRemove) {
      els.featuredRemove.addEventListener('click', () => removeFeatured());
    }

    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target && e.target.tagName) || '')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight' && e.shiftKey) playNext();
      else if (e.key === 'ArrowLeft' && e.shiftKey) playPrev();
    });
  }

  // ---------- Telegram login ----------
  function loadTgUser() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_TG_USER) || 'null'); }
    catch { return null; }
  }
  function saveTgUser(u) {
    if (u) localStorage.setItem(LS_KEY_TG_USER, JSON.stringify(u));
    else localStorage.removeItem(LS_KEY_TG_USER);
  }
  function loadTgSession() {
    try { return localStorage.getItem(LS_KEY_TG_SESSION) || null; } catch { return null; }
  }
  function saveTgSession(s) {
    if (s) localStorage.setItem(LS_KEY_TG_SESSION, s);
    else localStorage.removeItem(LS_KEY_TG_SESSION);
  }

  // ---------- Server playlist sync (stored as text in TG bot KV by TG id) ----------
  let serverPushTimer = null;
  let lastPushedPlaylistJson = null;

  function scheduleServerPlaylistPush() {
    const session = loadTgSession();
    if (!session) return;
    if (serverPushTimer) clearTimeout(serverPushTimer);
    serverPushTimer = setTimeout(pushServerPlaylist, 1500);
  }

  async function pushServerPlaylist() {
    const session = loadTgSession();
    if (!session) return;
    const body = JSON.stringify(state.playlist || []);
    if (body === lastPushedPlaylistJson) return;
    try {
      const r = await fetch(`${API_BASE}/tg/playlist?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (r.ok) lastPushedPlaylistJson = body;
      else if (r.status === 401) saveTgSession(null);
    } catch { /* transient */ }
  }

  async function pullServerPlaylist() {
    const session = loadTgSession();
    if (!session) return;
    try {
      const r = await fetch(`${API_BASE}/tg/playlist?session=${encodeURIComponent(session)}`);
      if (!r.ok) { if (r.status === 401) saveTgSession(null); return; }
      const data = await r.json().catch(() => null);
      if (!data || !data.ok) return;
      const text = String(data.playlist || '');
      if (!text) { lastPushedPlaylistJson = JSON.stringify(state.playlist || []); return; }
      let remote;
      try { remote = JSON.parse(text); } catch { return; }
      if (!Array.isArray(remote)) return;
      // Мерджим: всё что есть у сервера + недостающее локальное (сохраняем порядок сервера).
      const seen = new Set();
      const merged = [];
      for (const it of remote) {
        if (!it || !it.source || !it.id) continue;
        const k = itemKey(it);
        if (!seen.has(k)) { seen.add(k); merged.push(it); }
      }
      for (const it of (state.playlist || [])) {
        const k = itemKey(it);
        if (!seen.has(k)) { seen.add(k); merged.push(it); }
      }
      state.playlist = merged;
      localStorage.setItem(LS_KEY_PLAYLIST, JSON.stringify(merged));
      renderPlaylist();
      lastPushedPlaylistJson = JSON.stringify(merged);
      // Если локально было что-то, чего нет на сервере — запушим мердж обратно.
      if (merged.length !== remote.length) scheduleServerPlaylistPush();
    } catch { /* noop */ }
  }

  function renderAuthUi() {
    const user = loadTgUser();
    if (user) {
      if (els.tgLoginBtn) els.tgLoginBtn.hidden = true;
      if (els.tgUserPill) els.tgUserPill.hidden = false;
      if (els.tgUserName) els.tgUserName.textContent = user.username ? '@' + user.username : (user.first_name || 'you');
      if (els.tgUserPhoto) {
        if (user.photo_url) els.tgUserPhoto.src = user.photo_url;
        else els.tgUserPhoto.removeAttribute('src');
      }
      if (els.tgAdminBadge) els.tgAdminBadge.hidden = !ADMIN_TG_IDS.has(Number(user.id));
      if (els.payBtn) {
        const url = new URL(PAYWALL_TG_URL);
        url.searchParams.set('start', 'pay_' + user.id);
        els.payBtn.href = url.toString();
      }
    } else {
      if (els.tgLoginBtn) {
        els.tgLoginBtn.hidden = false;
        els.tgLoginBtn.classList.remove('loading');
      }
      if (els.tgUserPill) els.tgUserPill.hidden = true;
      if (els.tgAdminBadge) els.tgAdminBadge.hidden = true;
      if (els.payBtn) els.payBtn.href = PAYWALL_TG_URL;
    }
    renderFeatured();
  }

  function genLoginToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  let tgPollTimer = null;
  let tgPollDeadline = 0;
  let tgPollToken = null;

  function loadPendingLogin() {
    try {
      const raw = localStorage.getItem(LS_KEY_TG_PENDING);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.token || !obj.deadline) return null;
      if (Date.now() > Number(obj.deadline)) return null;
      return obj;
    } catch { return null; }
  }
  function savePendingLogin(token, deadline) {
    try { localStorage.setItem(LS_KEY_TG_PENDING, JSON.stringify({ token, deadline })); } catch {}
  }
  function clearPendingLogin() {
    try { localStorage.removeItem(LS_KEY_TG_PENDING); } catch {}
  }

  function stopTgPoll() {
    if (tgPollTimer) { clearTimeout(tgPollTimer); tgPollTimer = null; }
    tgPollToken = null;
    if (els.tgLoginBtn) els.tgLoginBtn.classList.remove('loading');
  }

  async function pollOnce(token) {
    try {
      const r = await fetch(`${API_BASE}/tg/login/poll?token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      if (data && data.ok && data.user) {
        saveTgUser({ ...data.user, subscription: data.subscription || null });
        if (data.session) saveTgSession(data.session);
        renderAuthUi();
        hidePaywall();
        setStatus('Вошёл как @' + (data.user.username || data.user.first_name || data.user.id));
        pullServerPlaylist();
        pullServerFeatured();
        return true;
      }
    } catch { /* transient — продолжим пуллить */ }
    return false;
  }

  function schedulePoll(token) {
    tgPollToken = token;
    if (Date.now() > tgPollDeadline) {
      clearPendingLogin();
      stopTgPoll();
      setStatus('Время на вход вышло. Нажми «Войти через Telegram» ещё раз.');
      return;
    }
    tgPollTimer = setTimeout(async () => {
      const ok = await pollOnce(token);
      if (ok) { clearPendingLogin(); stopTgPoll(); return; }
      schedulePoll(token);
    }, TG_LOGIN_POLL_INTERVAL_MS);
  }

  // На мобилках при возврате из TG браузер может быть убит; резюмируем поллинг.
  async function resumePendingLogin() {
    const pending = loadPendingLogin();
    if (!pending) return;
    if (loadTgUser()) { clearPendingLogin(); stopTgPoll(); return; }
    // Сразу бьём один раз — вдруг юзер уже нажал Start.
    if (await pollOnce(pending.token)) { clearPendingLogin(); stopTgPoll(); return; }
    // Продолжаем периодический поллинг до истечения deadline.
    if (tgPollTimer) return;
    tgPollDeadline = Number(pending.deadline);
    if (els.tgLoginBtn) els.tgLoginBtn.classList.add('loading');
    setStatus('Ждём подтверждения в Telegram…');
    schedulePoll(pending.token);
  }

  function startTgLogin() {
    stopTgPoll();
    const token = genLoginToken();
    tgPollDeadline = Date.now() + TG_LOGIN_POLL_TIMEOUT_MS;
    savePendingLogin(token, tgPollDeadline);
    const url = `https://t.me/${TG_BOT_USERNAME}?start=login_${token}`;
    // Открываем в той же вкладке — это надёжнее на мобилках, где popup блокируется
    // и браузер может убить фоновую вкладку. Токен хранится в localStorage,
    // поллинг возобновляется на visibilitychange.
    if (els.tgLoginBtn) els.tgLoginBtn.classList.add('loading');
    setStatus('Открываем Telegram… После Start вернись на эту вкладку.');
    schedulePoll(token);
    // Требуем user-gesture: location.assign держит локальный state и возвратит в history.
    window.location.href = url;
  }

  async function refreshSubscription() {
    const user = loadTgUser();
    if (!user || !user.id) return;
    // Админы безлимитные и без обращения к сети.
    if (ADMIN_TG_IDS.has(Number(user.id))) {
      saveTgUser({ ...user, subscription: { subscribed: true, until: 9999999999, admin: true } });
      renderAuthUi();
      return;
    }
    try {
      const r = await fetch(`${API_BASE}/tg/status?id=${encodeURIComponent(user.id)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.ok) {
        saveTgUser({ ...user, subscription: data.subscription || null });
        renderAuthUi();
      }
    } catch { /* noop */ }
  }

  function setupAuth() {
    renderAuthUi();
    if (loadTgUser()) refreshSubscription();
    if (els.tgLoginBtn) els.tgLoginBtn.addEventListener('click', startTgLogin);
    if (els.tgLogoutBtn) {
      els.tgLogoutBtn.addEventListener('click', () => {
        stopTgPoll();
        saveTgUser(null);
        saveTgSession(null);
        lastPushedPlaylistJson = null;
        lastPushedFeaturedJson = null;
        renderAuthUi();
        renderFeatured();
      });
    }
    // При возвращении на сайт с активной сессией — подтянуть серверный плейлист + featured.
    if (loadTgSession()) { pullServerPlaylist(); pullServerFeatured(); }
    renderFeatured();
    // Если юзер вышел в TG и вернулся — возобновляем опрос сервера.
    resumePendingLogin();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resumePendingLogin();
    });
    window.addEventListener('focus', resumePendingLogin);
    window.addEventListener('pageshow', resumePendingLogin);
  }

  // ---------- PWA ----------
  function setupPwa() {
    if (els.payBtn) {
      els.payBtn.href = PAYWALL_TG_URL;
      els.payBtn.textContent = PAYWALL_PRICE_LABEL;
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell optional */ });
      });
    }

    let deferredPrompt = null;
    const installBtn = els.installBtn;
    const isStandalone = () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (installBtn && !isStandalone()) installBtn.hidden = false;
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        installBtn.disabled = true;
        try {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
        } catch { /* no-op */ }
        deferredPrompt = null;
        installBtn.hidden = true;
        installBtn.disabled = false;
      });
    }

    window.addEventListener('appinstalled', () => {
      if (installBtn) installBtn.hidden = true;
      deferredPrompt = null;
    });
  }

  // ---------- Boot ----------
  initAudio();
  applySourceToUi();
  wire();
  renderPlaylist();
  setStatus('');
  updateLoopBtn();
  setupPwa();
  setupAuth();
  setupPaywallModal();
})();
