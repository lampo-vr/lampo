// Several videos at once in the library's List and Grid, the Files tab's way: a box at each row's start (under the
// pointer, on the row the keys are on, on every row once one is ticked), the box or ⌘/Ctrl-click ticks one, ⇧-click
// ticks the run from the last one, ⌘A every video in view, Esc none. On a touch screen a tap ticks while picking (a
// video's ⋯ or the Display panel's "Select videos" starts it). What is ticked belongs to the view: another view, filter
// or the board starts with none. The bar that acts on them is a chunk of its own (SelectBar.tsx).
// Rows and cards are told only whether they are ticked; `picks` reads the state through a ref, so ticking one row
// renders that row and the bar, never the whole library.
import { useMemo, useRef, useState } from 'react';
import { TOUCH } from '../lib/media.ts';

const NONE: ReadonlySet<string> = new Set();

export interface Picks {
  /** A row's or card's click: true when it was the selection's (⌘/Ctrl, ⇧, a tap while picking on a touch screen). */
  click: (slug: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => boolean;
  /** The box: one more or one less; with ⇧ the run from the last one. */
  box: (slug: string, shift: boolean) => void;
}

interface State {
  /** The view (and filters) it was made in: in another one nothing is ticked. */
  key: string;
  on: ReadonlySet<string>;
  anchor: string | null;
  /** A touch screen's selection mode, ticked or not. */
  mode: boolean;
  /** What the bar's last action left ticked, and why (a sentence), until the selection changes. */
  why: string | null;
}

const between = (order: string[], a: string, b: string): string[] => {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  return i < 0 || j < 0 ? [b] : order.slice(Math.min(i, j), Math.max(i, j) + 1);
};

/**
 * `order`: the videos in view as they are shown (what ⇧ and ⌘A reach); `key`: the view and its filters; `on`: false
 * where nothing is picked (the board).
 */
export function useLibrarySelection(order: string[], view: string, on: boolean) {
  // the board picks nothing: going there lets go of what was ticked, and coming back starts with none
  const key = on ? view : '';
  const [raw, setRaw] = useState<State>({ key, on: NONE, anchor: null, mode: false, why: null });
  // another view: what was ticked is let go (during the render, so no frame shows it in the new view)
  if (raw.key !== key) setRaw({ key, on: NONE, anchor: null, mode: false, why: null });
  const s = on && raw.key === key ? raw : null;
  // only what is in view counts (a video filtered out, or gone)
  const checked = useMemo(() => {
    if (!s?.on.size) return NONE;
    const here = new Set(order);
    const kept = [...s.on].filter((k) => here.has(k));
    return kept.length === s.on.size ? s.on : new Set(kept);
  }, [s, order]);
  const picking = checked.size > 0 || !!s?.mode;
  const now = useRef({ checked, order, key, picking, mode: !!s?.mode, anchor: s?.anchor ?? null });
  now.current = { checked, order, key, picking, mode: !!s?.mode, anchor: s?.anchor ?? null };

  const set = (list: Iterable<string>, extra: Partial<State> = {}) =>
    setRaw({ key: now.current.key, on: new Set(list), anchor: null, mode: now.current.mode, why: null, ...extra });
  const [picks] = useState<Picks>(() => {
    const toggle = (slug: string, shift: boolean) => {
      const { checked: c, order: o, anchor, key: k, mode } = now.current;
      if (shift && anchor) {
        setRaw({ key: k, on: new Set(between(o, anchor, slug)), anchor, mode, why: null });
        return;
      }
      const next = new Set(c);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      setRaw({ key: k, on: next, anchor: slug, mode, why: null });
    };
    return {
      click: (slug, e) => {
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || (now.current.picking && matchMedia(TOUCH).matches))) return false;
        toggle(slug, e.shiftKey);
        return true;
      },
      box: toggle,
    };
  });

  return {
    checked,
    /** The boxes show on every row: something is ticked, or a touch screen asked to pick. */
    picking,
    why: s?.why ?? null,
    picks,
    /** None ticked, the mode left. */
    clear: () => set([], { mode: false }),
    all: () => set(now.current.order, { anchor: now.current.order.at(-1) ?? null }),
    /** What an action left ticked, and why. */
    keep: (slugs: string[], why: string | null) => set(slugs, { anchor: slugs.at(-1) ?? null, why }),
    /** A touch screen's "Select videos": the boxes, nothing ticked yet. */
    start: () => set([], { mode: true }),
  };
}
