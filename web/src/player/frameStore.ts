// The frame on screen while a render plays changes 25–60 times a second. Kept here, outside React state, only what
// shows it — the timecode, the playhead, the "here" mark on notes — renders again per frame, and only when what it
// shows changes; the player itself renders when playback starts, stops or seeks (usePlayback `quiet`).
import { useSyncExternalStore } from 'react';

export interface FrameStore {
  get(): number;
  set(frame: number): void;
  subscribe(fn: () => void): () => void;
}

export function createFrameStore(initial: number): FrameStore {
  let frame = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set(f) {
      if (f === frame) return;
      frame = f;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** The frame on screen, live (renders the caller on every frame while playing). */
export const useFrame = (store: FrameStore): number => useSyncExternalStore(store.subscribe, store.get);

/** Something worked out from the frame on screen: the caller renders only when that result changes. */
export function useFrameValue<T extends string | number | boolean | null>(store: FrameStore, select: (frame: number) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
