// Long lists render only what is near the view. A library of 1,000 videos is 1,000 cards, each with its menus and
// poster: switching the layout or typing in the filter rebuilt all of them (seconds on a slow laptop). Here a list
// keeps its full height with a spacer above and below the rows it renders, so the scrollbar, scrolling, focus moving
// on with the arrow keys and "scroll into view" behave as if every row were there; what is rendered follows the scroll
// position, with a generous margin so fast scrolling doesn't show gaps. Short lists render whole, exactly as before.
// A list that has just appeared (the first paint, a layout switch) renders only what is in view, and its margin once
// the browser is idle: the rows beyond the view would cost the screen its first frame otherwise.
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { whenIdle } from './lazy.ts';

/** Libraries (or lanes) up to this many videos render whole: nothing is measured, nothing changes for them. */
export const WINDOW_FROM = 120;
/** Rendered beyond the view on both sides, in px (MARGIN_FIRST until the list has painted). */
const MARGIN = 800;
const MARGIN_FIRST = 0;

// Every window that appeared grows its margin in the same idle moment: one render for a library of twenty sections.
const growing = new Set<() => void>();
let cancelGrow: (() => void) | null = null;
function growWhenIdle(grow: () => void): () => void {
  growing.add(grow);
  cancelGrow ??= whenIdle(() => {
    cancelGrow = null;
    const all = [...growing];
    growing.clear();
    for (const g of all) g();
  });
  return () => {
    growing.delete(grow);
    if (!growing.size && cancelGrow) {
      cancelGrow();
      cancelGrow = null;
    }
  };
}

export interface Windowed {
  /** Rows to render, first to last (inclusive). */
  first: number;
  last: number;
  /** Space the rows above and below take, in px. */
  before: number;
  after: number;
  /** false: everything is rendered. */
  on: boolean;
}

/** The nearest ancestor that scrolls vertically (the library's main column, a board lane's cards), or the window. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/** Whether range `a` holds every row of `b` (an empty `b` is held by anything). */
const covers = (a: [number, number], b: [number, number]) => b[1] < b[0] || (a[0] <= b[0] && a[1] >= b[1]);

// Lists that appear in one render (one task: a page's first render and a layout switch render synchronously) share the
// window's height, top to bottom, for their first guess; the next task starts afresh.
let batch: { left: number } | null = null;
/** A section's head and the space above its rows, roughly: what a list after the first one starts below. */
const BETWEEN = 48;
function guessFirst(tops: number[], beside = false): [number, number] {
  // Lists side by side (a board's lanes) each start at the top: each guesses the window's height for itself.
  if (beside) return typeof window === 'undefined' ? [0, -1] : [0, rowAt(tops, window.innerHeight)];
  if (!batch) {
    batch = { left: typeof window === 'undefined' ? 0 : window.innerHeight };
    setTimeout(() => {
      batch = null;
    });
  }
  const b = batch;
  if (b.left <= 0) return [0, -1];
  const range: [number, number] = [0, rowAt(tops, b.left)];
  b.left -= (tops.at(-1) as number) + BETWEEN;
  return range;
}

/** The first i with tops[i + 1] > y (tops has rows + 1 entries, the last one being the total height). */
function rowAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] as number) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * Which of `rows` rows of the list at `ref` to render (`enabled`: the list is part of a long one; a library of many
 * short sections windows each of them). `height(i)` is row i's height (measured, or a guess), `gap` the space between
 * rows; `version` changes when measurements do. Rerenders only when the rendered range changes.
 */
export function useWindowed(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    rows,
    height,
    gap,
    version,
    reveal = null,
    beside = false,
  }: {
    enabled: boolean;
    rows: number;
    height: (i: number) => number;
    gap: number;
    version?: unknown;
    /** A row that must come into view (the keyboard's): when it isn't rendered, the list scrolls to where it would be. */
    reveal?: number | null;
    /** The list stands beside others that appear with it (a board's lanes), not under them: see guessFirst. */
    beside?: boolean;
  },
): Windowed {
  const on = enabled && rows > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for what `height` measured
  const tops = useMemo(() => {
    const t = [0];
    for (let i = 0; i < rows; i++) t.push((t[i] as number) + height(i) + (i < rows - 1 ? gap : 0));
    return t;
  }, [rows, gap, version]);
  // A first guess, before the list knows where it is: the rows that would fill the window if the lists appearing
  // together stacked from its top (guessFirst). The layout effect below then keeps it when it holds every row in view,
  // so a page's first paint (or a layout switch) renders once, not once empty and again with its rows.
  const [range, setRange] = useState<[number, number]>(() => (on ? guessFirst(tops, beside) : [0, -1]));
  const guessed = useRef(on);
  const topsRef = useRef(tops);
  topsRef.current = tops;
  // Only the view until the list has painted; the margin once the browser is idle (growWhenIdle).
  const margin = useRef(MARGIN_FIRST);

  // biome-ignore lint/correctness/useExhaustiveDependencies: new row positions (tops) mean a new range, read through topsRef
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const scroller = scrollerOf(el);
    let frame = 0;
    const update = () => {
      frame = 0;
      const t = topsRef.current;
      const listTop = el.getBoundingClientRect().top;
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
      const from = viewTop - listTop - margin.current;
      const to = viewTop + viewHeight - listTop + margin.current;
      const next: [number, number] = to < 0 || from > (t.at(-1) as number) ? [0, -1] : [rowAt(t, from), rowAt(t, to)];
      // The first guess holds every row in view: rows beyond it cost less than rendering the list a second time.
      const keep = guessed.current;
      guessed.current = false;
      setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : keep && covers(r, next) ? r : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const grown =
      margin.current === MARGIN
        ? null
        : growWhenIdle(() => {
            margin.current = MARGIN;
            update();
          });
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      grown?.();
      cancelAnimationFrame(frame);
      target.removeEventListener('scroll', schedule);
      ro.disconnect();
    };
  }, [on, ref, tops]);

  // A row asked for that the window won't render where the list stands: scroll to where it would be; the window
  // follows the scroll and renders it (the caller brings it fully into view once it is there).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el || reveal === null || reveal < 0 || reveal >= rows) return;
    const scroller = scrollerOf(el);
    const t = topsRef.current;
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const top = el.getBoundingClientRect().top + (t[reveal] as number);
    const bottom = el.getBoundingClientRect().top + (t[reveal + 1] as number);
    if (bottom >= viewTop - margin.current && top <= viewTop + viewHeight + margin.current) return;
    (scroller ?? document.scrollingElement)?.scrollBy(0, top - viewTop - viewHeight / 2);
  }, [on, ref, reveal, rows]);

  if (!on) return { first: 0, last: rows - 1, before: 0, after: 0, on: false };
  const first = Math.min(range[0], rows - 1);
  const last = Math.min(range[1], rows - 1);
  if (last < first) return { first: 0, last: -1, before: tops[rows] as number, after: 0, on: true };
  // tops[i] counts the gap after every row before i; the rendered rows keep their own gaps between them.
  const after = last + 1 < rows ? (tops[rows] as number) - (tops[last + 1] as number) + gap : 0;
  return { first, last, before: tops[first] as number, after, on: true };
}

/**
 * A long list of rows of different heights (a video's notes): `ref` holds exactly the rendered rows, its padding stands
 * for the others. Each row's height is remembered by `keyOf` once it has been on screen; the others count as the
 * average of those (`guess` before any). A new width measures everything again.
 */
export function useMeasuredWindow<T>(
  ref: RefObject<HTMLElement | null>,
  items: T[],
  keyOf: (item: T) => string,
  { enabled, guess, reveal = null }: { enabled: boolean; guess: number; reveal?: number | null },
): Windowed {
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState({ version: 0, gap: 0 });
  const shown = useRef<Windowed | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const w = shown.current;
    if (!enabled || !el || !w) return;
    let changed = false;
    const rows = el.children;
    for (let i = 0; i < rows.length; i++) {
      const item = items[w.first + i];
      if (item === undefined) break;
      const h = (rows[i] as HTMLElement).offsetHeight;
      const key = keyOf(item);
      if (heights.current.get(key) !== h) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    const gap = Number.parseFloat(getComputedStyle(el).rowGap) || 0;
    if (changed || gap !== measured.gap) setMeasured((m) => ({ version: m.version + 1, gap }));
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      heights.current.clear();
      setMeasured((m) => ({ ...m, version: m.version + 1 }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new identity whenever the rows or their measurements change is the point
  const version = useMemo(() => ({}), [items, measured.version]);
  const known = [...heights.current.values()];
  const average = known.length ? known.reduce((a, b) => a + b, 0) / known.length : guess;
  const w = useWindowed(ref, {
    enabled,
    rows: items.length,
    height: (i) => heights.current.get(keyOf(items[i] as T)) ?? average,
    gap: measured.gap,
    version,
    reveal,
  });
  shown.current = w;
  return w;
}

type GridSize = { cols: number; rowHeight: number; gap: number };
// The last measurement of each kind of grid at each window width, also kept for the next visit: a page's first render
// then lays out its cards in the right columns at once (a guess of one column would take another render to correct).
const GRID_KEY = 'vr.grid';
let measuredGrids: Record<string, GridSize> | null = null;
function gridSizes(): Record<string, GridSize> {
  if (!measuredGrids) {
    try {
      measuredGrids = JSON.parse(localStorage.getItem(GRID_KEY) || '{}') as Record<string, GridSize>;
    } catch {
      measuredGrids = {};
    }
  }
  return measuredGrids;
}
const gridKey = (kind: string) => `${kind}@${typeof window === 'undefined' ? 0 : window.innerWidth}`;
function keepGridSize(kind: string, size: GridSize) {
  const all = gridSizes();
  const k = gridKey(kind);
  const old = all[k];
  if (old && old.cols === size.cols && old.rowHeight === size.rowHeight && old.gap === size.gap) return;
  all[k] = size;
  try {
    // a handful of widths is plenty: the newest ones stay
    const keys = Object.keys(all);
    for (const drop of keys.slice(0, Math.max(0, keys.length - 12))) delete all[drop];
    localStorage.setItem(GRID_KEY, JSON.stringify(all));
  } catch {}
}

/** A grid's columns (known before any card is in it) and the height of one row of cards (the first rendered card),
 * measured after every render. */
export function useGridMetrics(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  /** Grids of one kind share their last measurement: one that appears again (a layout switch back) starts from it
   * instead of from a guess it corrects in another render. */
  kind = '',
): { cols: number; rowHeight: number; gap: number; version: number } {
  const [m, setM] = useState(() => ({ ...(gridSizes()[gridKey(kind)] ?? { cols: 0, rowHeight: 0, gap: 0 }), version: 0 }));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const cols = cs.gridTemplateColumns.split(' ').filter((x) => x && x !== 'none').length || 1;
      const gap = Number.parseFloat(cs.rowGap) || 0;
      const card = el.querySelector<HTMLElement>(':scope > :not([data-spacer])');
      setM((o) => {
        const rowHeight = card?.offsetHeight || o.rowHeight;
        if (rowHeight) keepGridSize(kind, { cols, rowHeight, gap });
        return o.cols === cols && o.rowHeight === rowHeight && o.gap === gap ? o : { cols, rowHeight, gap, version: o.version + 1 };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return m;
}
