// Items already off the list on screen while their change waits for Undo or is on its way: a refetch in that moment
// (the event stream, another tab) would put them back for a blink. The list, the bell and the tally read the response
// through `visibleOf`, so they agree.
import { useMemo, useSyncExternalStore } from 'react';
import { useForYou } from '../api/queries.ts';
import type { ForYouItem, ForYouResponse } from '../api/types.ts';

const hidden = new Set<string>();
const subs = new Set<() => void>();
let snap: ReadonlySet<string> = new Set();
const emit = () => {
  snap = new Set(hidden);
  for (const f of subs) f();
};

export function hide(keys: string[]): void {
  for (const k of keys) hidden.add(k);
  emit();
}
export function unhide(keys: string[]): void {
  for (const k of keys) hidden.delete(k);
  emit();
}
export const useHidden = (): ReadonlySet<string> =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snap,
    () => snap,
  );

export interface VisibleForYou {
  items: ForYouItem[];
  later: ForYouItem[];
  /** When the first item put aside comes back. */
  wake?: string;
  /** The bell's number: what waits, minus what is on its way off. */
  total: number;
  stalled: number;
}

export function visibleOf(d: ForYouResponse | undefined, gone: ReadonlySet<string>): VisibleForYou | null {
  if (!d) return null;
  if (!gone.size) return { items: d.items, later: d.later ?? [], wake: d.wake, total: d.counts.total, stalled: d.counts.stalled };
  const items = d.items.filter((i) => !gone.has(i.key));
  const off = d.items.filter((i) => gone.has(i.key));
  return {
    items,
    later: (d.later ?? []).filter((i) => !gone.has(i.key)),
    wake: d.wake,
    total: Math.max(0, d.counts.total - off.filter((i) => i.kind !== 'stalled').length),
    stalled: Math.max(0, d.counts.stalled - off.filter((i) => i.kind === 'stalled').length),
  };
}

/** What the inbox shows: the server's answer minus what is on its way off. */
export function useVisibleForYou(enabled = true) {
  const q = useForYou(enabled);
  const gone = useHidden();
  const data = useMemo(() => visibleOf(q.data, gone), [q.data, gone]);
  return { data, error: q.error };
}
