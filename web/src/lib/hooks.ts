import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pad } from './format.ts';

// A callback with a stable identity that always runs the latest closure: lets memoised children skip the
// player's per-frame re-renders without stale state.
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** "Try again in 04:12" while the server throttles attempts (sign-in, a review link's password). */
export function useCooldown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // One ticker for the whole wait, not one per tick.
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [until]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return {
    left,
    label: `${pad(Math.floor(left / 60))}:${pad(left % 60)}`,
    start: (seconds: number) => {
      const n = Date.now();
      setNow(n);
      setUntil(n + seconds * 1000);
    },
  };
}

/**
 * A scrolling box's edges: whether there is more beyond what shows — left/right of a sideways strip (`more-l` /
 * `more-r`, controls.css), above/below in a column that scrolls (`axis` 'y': `more-t` / `more-b`, a board lane) — for a
 * soft edge that says so, kept up as it scrolls and as it or its children change size. Scrolled to its end, the last
 * item shows whole, not faded.
 */
export function useScrollEdges<T extends HTMLElement>(axis: 'x' | 'y' = 'x'): [(el: T | null) => void, string] {
  const [edges, setEdges] = useState('');
  const cleanup = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the axis is fixed for a box's life
  const ref = useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const measure = () => {
      if (axis === 'y') {
        const top = el.scrollTop > 1;
        const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
        setEdges(`${top ? 'more-t' : ''} ${bottom ? 'more-b' : ''}`.trim());
        return;
      }
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges(`${left ? 'more-l' : ''} ${right ? 'more-r' : ''}`.trim());
    };
    // The observer reports every element once right after the next layout: measuring here as well would force a layout
    // of the whole page in the middle of rendering it.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    // what arrives later (the dock's chips once their data is in) is watched too: it widens the strip, not the box
    const mo = new MutationObserver(() => {
      for (const child of el.children) ro.observe(child);
    });
    mo.observe(el, { childList: true });
    el.addEventListener('scroll', measure, { passive: true });
    cleanup.current = () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, []);
  return [ref, edges];
}

// A field the loading page drew, then handed to the real page (AuthGate's skeleton → the screen): a different element in
// another place of the tree, so React mounts it anew. Someone already typing in it keeps typing: the new field takes the
// focus and the caret the old one had when it went (only straight after, and only when nothing else has the focus).
const carried = new Map<string, { start: number | null; end: number | null; at: number }>();
export function useCarriedFocus(ref: RefObject<HTMLInputElement | null>, key: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    const was = carried.get(key);
    carried.delete(key);
    const free = !document.activeElement || document.activeElement === document.body;
    if (el && was && free && performance.now() - was.at < 2000) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(was.start, was.end);
    }
    return () => {
      if (el && document.activeElement === el) carried.set(key, { start: el.selectionStart, end: el.selectionEnd, at: performance.now() });
    };
  }, [ref, key]);
}
