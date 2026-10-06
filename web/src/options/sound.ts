// The audition's sound: one item plays at a time, each at the gain that levels its group (lib/options.ts levelGains),
// applied while it plays — the file stays as sent. Where the page may route the sound through Web Audio (the file is
// served by this server), a GainNode turns it up or down; where it comes from a bucket's URL, the element's volume,
// which only turns down: the same balance, the loudest at 1 (volumesOf). A/B: the last two things played swap at the
// same position, so a take is compared with the other on the same word.
import { useSyncExternalStore } from 'react';
import { dbToGain } from '../../../lib/options.ts';

export interface Track {
  key: string;
  src: string;
  /** dB through Web Audio (`gain`), or the element's volume 0–1 (`volume`). */
  gain: number;
  mode: 'gain' | 'volume';
}

interface State {
  playing: string | null;
  /** The last two keys played, the newest last (what A/B swaps between). */
  recent: string[];
  /** Seconds into each track and its length, while it plays and after. */
  at: Record<string, { t: number; d: number }>;
}

let audioCtx: AudioContext | null = null;
const routed = new WeakMap<HTMLMediaElement, GainNode>();

function gainNode(el: HTMLMediaElement): GainNode | null {
  const known = routed.get(el);
  if (known) return known;
  try {
    audioCtx ??= new AudioContext();
    const node = audioCtx.createGain();
    audioCtx.createMediaElementSource(el).connect(node).connect(audioCtx.destination);
    routed.set(el, node);
    return node;
  } catch {
    return null;
  }
}

export interface Deck {
  play(track: Track, at?: number): void;
  stop(): void;
  toggle(track: Track): void;
  /** Swaps to the other of the last two played, at the same position; false when fewer than two were played. */
  ab(tracks: Map<string, Track>): boolean;
  subscribe(fn: () => void): () => void;
  state(): State;
  dispose(): void;
}

export function createDeck(): Deck {
  const els = new Map<string, HTMLAudioElement>();
  const subs = new Set<() => void>();
  let s: State = { playing: null, recent: [], at: {} };
  const set = (next: Partial<State>) => {
    s = { ...s, ...next };
    for (const f of subs) f();
  };
  const element = (track: Track): HTMLAudioElement => {
    let el = els.get(track.key);
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      el.src = track.src;
      const me = el;
      const tick = () => set({ at: { ...s.at, [track.key]: { t: me.currentTime, d: Number.isFinite(me.duration) ? me.duration : 0 } } });
      el.addEventListener('timeupdate', tick);
      el.addEventListener('loadedmetadata', tick);
      el.addEventListener('ended', () => {
        tick();
        if (s.playing === track.key) set({ playing: null });
      });
      els.set(track.key, el);
    }
    return el;
  };
  const level = (el: HTMLMediaElement, track: Track) => {
    if (track.mode === 'gain') {
      const node = gainNode(el);
      if (node) {
        node.gain.value = dbToGain(track.gain);
        el.volume = 1;
        return;
      }
    }
    el.volume = Math.max(0, Math.min(1, track.mode === 'gain' ? Math.min(1, dbToGain(track.gain)) : track.gain));
  };
  const stopAll = () => {
    for (const el of els.values()) if (!el.paused) el.pause();
  };
  const deck: Deck = {
    play(track, at) {
      stopAll();
      const el = element(track);
      level(el, track);
      if (at !== undefined) el.currentTime = Math.min(at, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.05) : at);
      else if (el.ended) el.currentTime = 0;
      void audioCtx?.resume();
      el.play().catch(() => set({ playing: null }));
      const recent = [...s.recent.filter((k) => k !== track.key), track.key].slice(-2);
      set({ playing: track.key, recent });
    },
    stop() {
      stopAll();
      set({ playing: null });
    },
    toggle(track) {
      if (s.playing === track.key) deck.stop();
      else deck.play(track);
    },
    ab(tracks) {
      const [a, b] = s.recent;
      if (!a || !b) return false;
      const from = s.playing ?? b;
      const to = from === b ? a : b;
      const target = tracks.get(to);
      if (!target) return false;
      const pos = els.get(from)?.currentTime ?? 0;
      deck.play(target, pos);
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    state: () => s,
    dispose() {
      stopAll();
      for (const el of els.values()) el.removeAttribute('src');
      els.clear();
      subs.clear();
    },
  };
  return deck;
}

export const useDeck = (deck: Deck): State => useSyncExternalStore(deck.subscribe, deck.state);
