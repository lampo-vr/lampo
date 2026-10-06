// Several items picked at once (a checkbox on the row, ⇧-click for a run, X on the keyboard's row, ⌘A for all): the
// selection bar acts on them together. Keys that leave the list leave the selection.
import { useMemo, useRef, useState } from 'react';
import type { ForYouItem } from '../api/types.ts';

const NONE: ReadonlySet<string> = new Set();

export function useSelection(items: ForYouItem[]) {
  const [raw, setRaw] = useState<ReadonlySet<string>>(NONE);
  const anchor = useRef<string | null>(null);
  const keys = useMemo(() => {
    if (!raw.size) return NONE;
    const here = new Set(items.map((i) => i.key));
    const kept = [...raw].filter((k) => here.has(k));
    return kept.length === raw.size ? raw : new Set(kept);
  }, [items, raw]);
  const picked = useMemo(() => (keys.size ? items.filter((i) => keys.has(i.key)) : []), [items, keys]);
  /** One more or one less; `range`: everything from the last one picked to this one, on. */
  const toggle = (i: ForYouItem, range = false) => {
    const from = range && anchor.current ? items.findIndex((x) => x.key === anchor.current) : -1;
    const to = items.indexOf(i);
    const next = new Set(keys);
    if (from >= 0 && to >= 0) for (const x of items.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x.key);
    else if (next.has(i.key)) next.delete(i.key);
    else next.add(i.key);
    anchor.current = i.key;
    setRaw(next);
  };
  const set = (list: ForYouItem[]) => {
    anchor.current = list.at(-1)?.key ?? null;
    setRaw(new Set(list.map((i) => i.key)));
  };
  const clear = () => {
    anchor.current = null;
    setRaw(NONE);
  };
  return { keys, picked, toggle, set, clear, all: () => set(items) };
}

export type Selection = ReturnType<typeof useSelection>;
