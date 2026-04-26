import { useEffect, useRef, useCallback, useState, useSyncExternalStore } from 'react';
import { usePlayerStore } from '@/store/player';
import { api } from '@/lib/api';

interface StreamResponse {
  url: string;
  source: string;
}

interface AudioBundle {
  audio: HTMLAudioElement;
  ctx: AudioContext | null;
  analyser: AnalyserNode | null;
  filters: BiquadFilterNode[];
  source: MediaElementAudioSourceNode | null;
  ctxFailed: boolean;
}

let bundle: AudioBundle | null = null;

export const EQ_BANDS = [60, 170, 350, 1000, 3500, 10000] as const;

function getBundle(): AudioBundle {
  if (!bundle) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    bundle = { audio, ctx: null, analyser: null, filters: [], source: null, ctxFailed: false };
  }
  return bundle;
}

function ensureAudioGraph(): AudioBundle {
  const b = getBundle();
  if (b.ctx || b.ctxFailed) return b;

  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      b.ctxFailed = true;
      return b;
    }
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(b.audio);

    const filters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.frequency.value = freq;
      f.gain.value = 0;
      f.Q.value = 1;
      f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      return f;
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;

    const chain: AudioNode[] = [source, ...filters, analyser, ctx.destination];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a && b) a.connect(b);
    }

    b.ctx = ctx;
    b.analyser = analyser;
    b.filters = filters;
    b.source = source;
  } catch {
    b.ctxFailed = true;
  }
  return b;
}

/**
 * Owns ALL audio side effects: loading tracks, play/pause, listener wiring,
 * media-session integration. Must be mounted EXACTLY ONCE at the app root —
 * mounting it in multiple components causes parallel `audio.src = url`
 * writes which abort each other's `audio.play()` with an AbortError
 * ("The fetching process for the media resource was aborted by the user
 * agent at the user's request.").
 */
export function useAudioController() {
  const {
    currentTrack,
    isPlaying,
    volume,
    muted,
    repeat,
    setProgress,
    setDuration,
    setError,
    pause,
    next,
  } = usePlayerStore();

  const loadingRef = useRef<string | null>(null);
  const loadedTrackRef = useRef<string | null>(null);

  const loadTrack = useCallback(async (trackId: string) => {
    const { audio } = getBundle();
    loadingRef.current = trackId;
    setError(null);
    try {
      const { url } = await api.get<StreamResponse>(`/tracks/${trackId}/stream`);
      if (loadingRef.current !== trackId) return;
      audio.src = url;
      audio.load();
      loadedTrackRef.current = trackId;
      ensureAudioGraph();
      const b = getBundle();
      if (b.ctx && b.ctx.state === 'suspended') {
        await b.ctx.resume().catch(() => {});
      }
      await audio.play();
    } catch (err) {
      if (loadingRef.current !== trackId) return;
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') return;
      const message = err instanceof Error ? err.message : String(err);
      console.error('[stream]', message);
      setError(message);
      pause();
    }
  }, [pause, setError]);

  useEffect(() => {
    if (!currentTrack) return;
    if (currentTrack.id !== loadedTrackRef.current && currentTrack.id !== loadingRef.current) {
      loadTrack(currentTrack.id);

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.artist,
          artwork: currentTrack.coverUrl
            ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
            : [],
        });
      }
    }
  }, [currentTrack, loadTrack]);

  useEffect(() => {
    const { audio } = getBundle();
    if (!audio.src || loadedTrackRef.current !== currentTrack?.id) return;
    if (isPlaying) {
      const b = ensureAudioGraph();
      if (b.ctx && b.ctx.state === 'suspended') {
        b.ctx.resume().catch(() => {});
      }
      audio.play().catch((err) => {
        const name = err instanceof Error ? err.name : '';
        if (name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Не удалось воспроизвести');
        pause();
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTrack?.id, pause, setError]);

  useEffect(() => {
    const { audio } = getBundle();
    audio.volume = muted ? 0 : volume;
  }, [volume, muted]);

  useEffect(() => {
    const { audio } = getBundle();

    const onTimeUpdate = () => setProgress(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      if (repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      } else {
        next();
      }
    };
    const onError = () => {
      const code = audio.error?.code;
      if (code === 1) return; // MEDIA_ERR_ABORTED — обычно при смене трека, не ошибка для юзера
      const messages: Record<number, string> = {
        2: 'Сетевая ошибка',
        3: 'Не удалось декодировать',
        4: 'Формат не поддерживается',
      };
      setError(messages[code ?? 0] ?? 'Ошибка плеера');
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [repeat, next, setProgress, setDuration, setError]);

  useEffect(() => {
    if ('mediaSession' in navigator) {
      const store = usePlayerStore.getState();
      navigator.mediaSession.setActionHandler('play', () => store.play());
      navigator.mediaSession.setActionHandler('pause', () => store.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => store.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => store.next());
    }
  }, []);
}

/**
 * Read-only view: subscribes to progress and exposes seek().
 * Safe to call from any number of components — does NOT touch audio.src
 * or trigger loads.
 */
export function useAudioPlayer() {
  const progress = useSyncExternalStore(
    (cb) => {
      const { audio } = getBundle();
      audio.addEventListener('timeupdate', cb);
      return () => audio.removeEventListener('timeupdate', cb);
    },
    () => getBundle().audio.currentTime,
    () => 0,
  );
  const setProgress = usePlayerStore((s) => s.setProgress);

  const seek = useCallback((time: number) => {
    const { audio } = getBundle();
    audio.currentTime = time;
    setProgress(time);
  }, [setProgress]);

  return { progress, seek };
}

export function setEqGain(bandIndex: number, gainDb: number): boolean {
  const b = ensureAudioGraph();
  if (!b.filters[bandIndex]) return false;
  b.filters[bandIndex].gain.value = gainDb;
  return true;
}

export function getEqGain(bandIndex: number): number {
  const b = getBundle();
  return b.filters[bandIndex]?.gain.value ?? 0;
}

export function isEqAvailable(): boolean {
  const b = ensureAudioGraph();
  return Boolean(b.ctx && !b.ctxFailed && b.filters.length > 0);
}

export function useAnalyserData(active: boolean, bins = 32) {
  const [data, setData] = useState<Uint8Array>(() => new Uint8Array(bins));

  useEffect(() => {
    if (!active) return;
    const b = ensureAudioGraph();
    if (!b.analyser) return;
    const analyser = b.analyser;
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      const step = Math.floor(buffer.length / bins) || 1;
      const out = new Uint8Array(bins);
      for (let i = 0; i < bins; i++) out[i] = buffer[i * step] ?? 0;
      setData(out);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, bins]);

  return data;
}
