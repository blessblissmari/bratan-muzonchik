// БРАТАН-музончик — бесплатный музыкальный плеер на базе SoundCloud.
// Фронтенд статический (GitHub Pages), бэкенд — Cloudflare Worker-прокси
// (https://github.com/blessblissmari/bratan-muzonchik/tree/main/worker),
// нужен потому что api-v2.soundcloud.com не отдаёт CORS. Воркер также
// автоматически подтягивает свежий client_id из soundcloud.com JS и кеширует
// его на час, так что фронту о нём знать не надо.
//
// Официал-фильтр: берём только tracks с verified-артиста ИЛИ с заполненным
// `publisher_metadata.artist` (т.е. это релиз через лейбл), плюс режем по словарю
// cover/karaoke/sped up/slowed/nightcore/mashup/fan edit/lyric video/etc.
// Стрим — plain HLS MP3 128 kbps (без DRM), играется через hls.js в любом браузере.

(() => {
  'use strict';

  // Cloudflare Worker (прокси SoundCloud + CORS). Если фронт раскатан на другом
  // инстансе, подмени этот URL на свой.
  const API_BASE = 'https://bratan-muzonchik.bratan-muzonchik.workers.dev';

  const LS_KEY_PLAYLIST = 'bratan:playlist:v2';
  const LS_KEY_VOLUME = 'bratan:volume:v1';
  const LS_KEY_LOOP = 'bratan:loop:v1';

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
  };

  // ---------- State ----------
  const state = {
    results: [],
    playlist: loadPlaylist(),
    currentId: null,         // SoundCloud track id (number) of currently-loaded track
    currentSource: null,     // 'playlist' | 'results'
    isPlaying: false,
    loop: localStorage.getItem(LS_KEY_LOOP) === '1',
    volume: clampInt(parseInt(localStorage.getItem(LS_KEY_VOLUME) || '80', 10), 0, 100),
    consecutiveErrors: 0,
    currentReqToken: 0,      // cancels stale stream-resolve fetches when the user jumps tracks
    hls: null,               // active Hls.js instance (if any)
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
  function savePlaylist() { localStorage.setItem(LS_KEY_PLAYLIST, JSON.stringify(state.playlist)); }
  function loadPlaylist() {
    try {
      const raw = localStorage.getItem(LS_KEY_PLAYLIST);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => x && (typeof x.id === 'number' || typeof x.id === 'string'));
    } catch { return []; }
  }
  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, mode: 'cors' }).finally(() => clearTimeout(t));
  }

  // ---------- Official-only filter ----------
  // SoundCloud позволяет кому угодно залить перезалив/ускоренку/ремикс — фильтруем
  // жёстче чем Piped. На вход попадает уже нормализованный item.
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
    /\bremix\b/i,              // все ремиксы — мимо официала
    /\binstrumental\b/i,
    /\bacapella\b/i, /\ba\s*capella\b/i,
    /\btype\s*beat\b/i,
    /\bfull\s*album\b/i,
  ];
  function looksLikeReupload(title, artist) {
    const t = (title || '') + ' ' + (artist || '');
    return REUPLOAD_PATTERNS.some((re) => re.test(t));
  }

  function isOfficialSCTrack(tr) {
    if (!tr || tr.kind !== 'track') return false;
    if (tr.state !== 'finished') return false;
    if (tr.streamable === false) return false;
    if (tr.sharing && tr.sharing !== 'public') return false;
    const user = tr.user || {};
    const pm = tr.publisher_metadata || null;
    const verified = user.verified === true;
    // publisher_metadata с artist/label означает релиз через лейбл (даже если аккаунт
    // сам не верифицирован — типа Rick Astley's own "Remastered 2022" uploads).
    const hasPublisherReleaseInfo = !!(pm && (pm.artist || pm.album_title || pm.isrc));
    if (!verified && !hasPublisherReleaseInfo) return false;
    if (looksLikeReupload(tr.title, user.username)) return false;
    // Нужен HLS MP3 транскодинг (не DRM-зашифрованный AAC)
    if (!pickHlsMp3Transcoding(tr)) return false;
    return true;
  }

  function pickHlsMp3Transcoding(tr) {
    const list = (tr && tr.media && Array.isArray(tr.media.transcodings)) ? tr.media.transcodings : [];
    // Plain HLS MP3 — без DRM, играется через hls.js
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
    // в SC часто отдают "-large" (100x100) — заменим на "-t300x300" если шаблон совпал
    if (thumb) thumb = thumb.replace(/-large(\.[a-z]+)$/i, '-t300x300$1');
    return {
      id: tr.id,                                    // numeric SoundCloud track id
      urn: tr.urn || `soundcloud:tracks:${tr.id}`,
      title: (tr.title || '').trim() || '(без названия)',
      artist,
      thumb,
      duration: tr.duration ? Math.round(tr.duration / 1000) : null,  // SC duration is ms
      verified: (user.verified === true),
      permalink: tr.permalink_url || '',
      transcoding: pickHlsMp3Transcoding(tr)?.url || null,
    };
  }

  // ---------- Search ----------
  async function searchSoundCloud(query) {
    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=40`;
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.collection) ? data.collection : [];
  }

  async function runSearch() {
    const q = els.search.value.trim();
    if (!q) return;
    els.results.innerHTML = '';
    setStatus('Ищу официал на SoundCloud…');
    try {
      const raw = await searchSoundCloud(q);
      const official = raw.filter(isOfficialSCTrack).map(normalizeSCTrack);
      state.results = official;
      renderResults();
      const dropped = raw.length - official.length;
      if (official.length === 0 && raw.length > 0) {
        setStatus('Нашёл только перезаливы/каверы — уточни запрос (артист + трек).');
      } else if (official.length === 0) {
        setStatus('Ничего не нашёл, бро.');
      } else if (dropped > 0) {
        setStatus(`Найдено: ${official.length} официальных · отсеял ${dropped} не-официальных.`);
      } else {
        setStatus(`Найдено: ${official.length} официальных треков.`);
      }
    } catch (e) {
      console.error(e);
      setStatus('Поиск не удался: ' + (e && e.message ? e.message : 'сеть'));
    }
  }

  // ---------- Rendering ----------
  function renderResults() {
    els.results.innerHTML = '';
    if (!state.results.length) {
      els.results.innerHTML = '<li class="empty">Чё, бро? Введи запрос сверху — найдём официал.</li>';
      return;
    }
    const tpl = document.getElementById('tpl-result');
    for (const item of state.results) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      fillRow(node, item);
      node.querySelector('.play').addEventListener('click', () => playItem(item, 'results'));
      node.querySelector('.add').addEventListener('click', (ev) => {
        ev.stopPropagation();
        addToPlaylist(item);
      });
      node.addEventListener('dblclick', () => playItem(item, 'results'));
      if (state.currentId === item.id) node.classList.add('playing');
      els.results.appendChild(node);
    }
  }

  function renderPlaylist() {
    els.playlist.innerHTML = '';
    if (!state.playlist.length) {
      els.playlist.innerHTML = '<li class="empty">Плейлист пуст. Добавляй треки кнопкой ＋ из результатов.</li>';
      return;
    }
    const tpl = document.getElementById('tpl-plitem');
    state.playlist.forEach((item, idx) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      fillRow(node, item);
      node.dataset.id = String(item.id);
      node.dataset.index = String(idx);
      node.querySelector('.play').addEventListener('click', () => playItem(item, 'playlist'));
      node.querySelector('.remove').addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeFromPlaylist(item.id);
      });
      node.addEventListener('dblclick', () => playItem(item, 'playlist'));
      attachDragHandlers(node);
      if (state.currentId === item.id && state.currentSource === 'playlist') node.classList.add('playing');
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
    node.querySelector('.sub').textContent = item.artist + badge + durStr;
  }

  // ---------- Playlist mgmt ----------
  function addToPlaylist(item) {
    if (state.playlist.some((x) => x.id === item.id)) {
      setStatus(`«${item.title}» уже в плейлисте.`);
      return;
    }
    state.playlist.push({
      id: item.id,
      urn: item.urn,
      title: item.title,
      artist: item.artist,
      thumb: item.thumb,
      duration: item.duration || null,
      verified: !!item.verified,
      permalink: item.permalink || '',
      transcoding: item.transcoding || null,
    });
    savePlaylist();
    renderPlaylist();
    setStatus(`Добавил в плейлист: ${item.title}`);
  }

  function removeFromPlaylist(id) {
    state.playlist = state.playlist.filter((x) => x.id !== id);
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
        const clean = arr.filter((x) => x && (typeof x.id === 'number' || typeof x.id === 'string') && typeof x.title === 'string');
        const seen = new Set(state.playlist.map((x) => x.id));
        for (const it of clean) if (!seen.has(it.id)) { state.playlist.push(it); seen.add(it.id); }
        savePlaylist();
        renderPlaylist();
        setStatus(`Импортировал ${clean.length} треков.`);
      } catch (e) {
        setStatus('Не смог прочитать файл плейлиста.');
      }
    };
    reader.readAsText(file);
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

  // ---------- Audio player ----------
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
      const dur = els.audio.duration || 0;
      if (dur > 0 && isFinite(dur)) els.durTime.textContent = fmtTime(dur);
    });
    els.audio.addEventListener('error', () => {
      onStreamError('Стрим отвалился');
    });
    updateLoopBtn();
  }

  function onStreamError(reason) {
    const title = els.nowTitle.textContent || 'трек';
    setStatus(`${reason} на «${title}». Переключаюсь дальше…`);
    state.consecutiveErrors++;
    if (state.consecutiveErrors > 6) {
      setStatus('Много подряд проблемных треков — притормозил. Попробуй другой запрос.');
      state.consecutiveErrors = 0;
      return;
    }
    onTrackEnded();
  }

  function teardownHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch {}
      state.hls = null;
    }
  }

  // Resolve SoundCloud HLS playlist URL through the Worker (the Worker re-signs
  // it with a fresh client_id and returns a wrapped /hls?url=... link so the
  // m3u8 segments also go through the CORS-enabled proxy).
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
      hls.loadSource(m3u8Url);
      hls.attachMedia(els.audio);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data && data.fatal) onStreamError('HLS fatal: ' + (data.details || data.type || ''));
      });
      return new Promise((resolve, reject) => {
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          els.audio.play().then(resolve).catch(reject);
        });
      });
    }
    // Safari / iOS поддерживает HLS нативно
    if (els.audio.canPlayType('application/vnd.apple.mpegurl')) {
      els.audio.src = m3u8Url;
      return els.audio.play();
    }
    throw new Error('браузер не умеет HLS');
  }

  async function playItem(item, source) {
    state.currentId = item.id;
    state.currentSource = source;
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
    setStatus(`Граблю аудио «${item.title}»…`);
    try {
      let transcoding = item.transcoding;
      // Если плейлист был импортирован со старой версии — transcoding мог не сохраниться.
      // Попробуем дёрнуть track по id заново.
      if (!transcoding) {
        const tr = await refetchTrack(item.id);
        if (token !== state.currentReqToken) return;
        const pick = pickHlsMp3Transcoding(tr);
        if (!pick) throw new Error('у трека нет plain-HLS (DRM)');
        transcoding = pick.url;
        // запишем в playlist чтобы в следующий раз было быстрее
        const pi = state.playlist.find((x) => x.id === item.id);
        if (pi) { pi.transcoding = transcoding; savePlaylist(); }
      }
      const m3u8 = await resolveSCStream(transcoding);
      if (token !== state.currentReqToken) return;
      try {
        await attachPlaylistUrl(m3u8);
      } catch (e) {
        if (token !== state.currentReqToken) return;
        onStreamError('Не удалось запустить'); return;
      }
      els.audio.volume = state.volume / 100;
      els.quality.textContent = '128 kbps · mp3 · HLS';
      setStatus(`Играю «${item.title}» (128 kbps · mp3)`);
    } catch (e) {
      if (token !== state.currentReqToken) return;
      console.error(e);
      onStreamError('Не достал стрим');
    }
  }

  async function refetchTrack(id) {
    // Worker currently exposes only /search + /resolve + /hls. For a legacy
    // playlist item that was stored without a `transcoding` URL, fallback to
    // searching by id via /search (SoundCloud returns track-id lookups there).
    const res = await fetchWithTimeout(`${API_BASE}/search?q=${encodeURIComponent(String(id))}&limit=1`, 10000);
    if (!res.ok) throw new Error('track refetch HTTP ' + res.status);
    const data = await res.json();
    const arr = Array.isArray(data.collection) ? data.collection : [];
    const hit = arr.find((t) => t.id === id) || arr[0];
    if (!hit) throw new Error('track not found');
    return hit;
  }

  function currentList() {
    if (state.currentSource === 'playlist') return state.playlist;
    if (state.currentSource === 'results') return state.results;
    return [];
  }

  function onTrackEnded() {
    const list = currentList();
    if (!list.length) return;
    const idx = list.findIndex((x) => x.id === state.currentId);
    if (idx < 0) return;
    let nextIdx = idx + 1;
    if (nextIdx >= list.length) {
      if (state.loop && state.currentSource === 'playlist') nextIdx = 0;
      else return;
    }
    playItem(list[nextIdx], state.currentSource);
  }

  function playPrev() {
    const list = currentList();
    if (list.length && state.currentId != null) {
      const idx = list.findIndex((x) => x.id === state.currentId);
      let prev = idx - 1;
      if (prev < 0) {
        prev = (state.loop && state.currentSource === 'playlist') ? list.length - 1 : 0;
      }
      playItem(list[prev], state.currentSource);
    } else if (state.playlist.length) {
      playItem(state.playlist[0], 'playlist');
    }
  }
  function playNext() {
    const list = currentList();
    if (list.length && state.currentId != null) {
      const idx = list.findIndex((x) => x.id === state.currentId);
      let next = idx + 1;
      if (next >= list.length) {
        next = (state.loop && state.currentSource === 'playlist') ? 0 : list.length - 1;
      }
      playItem(list[next], state.currentSource);
    } else if (state.playlist.length) {
      playItem(state.playlist[0], 'playlist');
    }
  }
  function togglePlay() {
    if (state.currentId == null) {
      if (state.playlist.length) playItem(state.playlist[0], 'playlist');
      return;
    }
    if (els.audio.paused) { els.audio.play().catch(() => {}); }
    else els.audio.pause();
  }
  function updateLoopBtn() {
    els.loopBtn.classList.toggle('active', state.loop);
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

    els.seek.addEventListener('input', () => {
      els.seek._dragging = true;
      setRangeFill(els.seek);
    });
    els.seek.addEventListener('change', () => {
      els.seek._dragging = false;
      const dur = els.audio.duration || 0;
      if (dur > 0 && isFinite(dur)) {
        const pct = parseInt(els.seek.value, 10) / 1000;
        try { els.audio.currentTime = dur * pct; } catch {}
      }
    });
    els.volume.value = state.volume;
    setRangeFill(els.volume);
    els.volume.addEventListener('input', () => {
      state.volume = clampInt(els.volume.value, 0, 100);
      localStorage.setItem(LS_KEY_VOLUME, String(state.volume));
      setRangeFill(els.volume);
      els.audio.volume = state.volume / 100;
    });

    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target && e.target.tagName) || '')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight' && e.shiftKey) playNext();
      else if (e.key === 'ArrowLeft' && e.shiftKey) playPrev();
    });
  }

  // ---------- Boot ----------
  initAudio();
  wire();
  renderResults();
  renderPlaylist();
  setStatus('');
})();
