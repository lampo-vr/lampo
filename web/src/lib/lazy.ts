// Code that loads on demand, read without waiting on React's Suspense when it is already here. A lazy() component
// suspends on its first render even when its chunk has long arrived, and content that replaces a Suspense fallback is
// held back until 300 ms after that fallback showed (React's fallback throttle): a screen or a menu whose code is here
// would still wait. A loader remembers its promise's outcome, so `use()` reads a loaded module at once, and
// `useLoaded` renders without it (and again when it arrives) instead of suspending.
import { type ComponentType, createElement, use, useEffect, useReducer, useState } from 'react';

type Tracked<T> = Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown };

export interface Loader<T> {
  /** Starts loading (once; again after a failure) and returns the promise. */
  load: () => Promise<T>;
  /** The module, once it is here. */
  readonly ready: T | undefined;
}

export function loader<T>(importer: () => Promise<T>): Loader<T> {
  let p: Tracked<T> | null = null;
  return {
    load() {
      if (!p) {
        const q: Tracked<T> = importer();
        q.status = 'pending';
        q.then(
          (v) => {
            q.status = 'fulfilled';
            q.value = v;
          },
          (e) => {
            q.status = 'rejected';
            q.reason = e;
            // A chunk that failed to arrive (offline, a new build) is asked for again next time.
            if (p === q) p = null;
          },
        );
        p = q;
      }
      return p;
    },
    get ready() {
      return p?.status === 'fulfilled' ? p.value : undefined;
    },
  };
}

/** The module once it is here (loading starts when `want`); undefined until then, with a render when it arrives. */
export function useLoaded<T>(l: Loader<T>, want = true): T | undefined {
  const [, arrived] = useReducer((n: number) => n + 1, 0);
  const mod = l.ready;
  useEffect(() => {
    if (!want || mod) return;
    let live = true;
    l.load().then(
      () => live && arrived(),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [l, want, mod]);
  return mod;
}

/** A screen whose code loads on demand: rendered at once when it is here, suspending (like lazy()) only when not. */
export function screen<P extends object>(l: Loader<{ default: ComponentType<P> }>): ComponentType<P> {
  return function Screen(props: P) {
    return createElement(use(l.load()).default, props);
  };
}

/** Runs `fn` once the browser has nothing more urgent to do (Safari has no requestIdleCallback: a moment later). */
export function whenIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof requestIdleCallback !== 'function') {
    const t = setTimeout(fn, 300);
    return () => clearTimeout(t);
  }
  const id = requestIdleCallback(fn, { timeout });
  return () => cancelIdleCallback(id);
}

/** Runs `fn` right after the next frame is painted (a task after the frame, so it doesn't delay it). */
export function afterPaint(fn: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const raf = requestAnimationFrame(() => {
    t = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(t);
  };
}

/** false until the browser was idle once after the first render: for what the first paint doesn't need. */
export function useIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  return idle;
}

/** false until the page painted its content (its first contentful paint) and the browser was idle after it: for asking
 * for data the first paint doesn't show. An idle moment or a frame alone can come before it, while fonts and data
 * load; a page that never paints (a hidden tab) gets there after a few seconds. `after` holds the wait back until it
 * is true (the content it decorates is there): then a frame and an idle moment after that. */
export function usePainted(after = true): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!after) return;
    let stop = () => {};
    const ready = () => {
      stop();
      stop = whenIdle(() => setDone(true));
    };
    const painted = () => performance.getEntriesByType('paint').some((p) => p.name === 'first-contentful-paint');
    if (painted() || typeof PerformanceObserver === 'undefined') {
      stop = afterPaint(ready);
      return () => stop();
    }
    const po = new PerformanceObserver(() => painted() && ready());
    try {
      po.observe({ type: 'paint', buffered: true });
    } catch {
      stop = afterPaint(ready);
      return () => stop();
    }
    const later = setTimeout(ready, 4000);
    stop = () => {
      po.disconnect();
      clearTimeout(later);
    };
    return () => stop();
  }, [after]);
  return done;
}
