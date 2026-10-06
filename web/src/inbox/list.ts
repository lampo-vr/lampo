// The inbox's groups as shown and the rows the keys walk: by video or by kind (group.ts), long videos folded where room
// is short (the bell's popover, the phone's sheet). Light, for the inbox view's first paint; the rows are Rows.tsx.
import { useMemo, useState } from 'react';
import type { ForYouItem } from '../api/types.ts';
import { folded, groupsOf, type InboxGroup, type InboxMode } from './group.ts';

export interface InboxList {
  groups: InboxGroup[];
  /** What ↑/↓ walk: a folded group's hidden items aren't among them. */
  rows: ForYouItem[];
  mode: InboxMode;
  unfold: (key: string) => void;
}

/** `items` in the mode's order; `compact`: fold long video groups (`keep`: the item open in the preview stays out). */
export function useInboxList(items: ForYouItem[], mode: InboxMode, { compact = false, keep = null }: { compact?: boolean; keep?: string | null } = {}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const all = useMemo(() => groupsOf(items, mode), [items, mode]);
  const groups = useMemo(() => (compact && mode === 'video' ? folded(all, open, keep) : all), [all, compact, mode, open, keep]);
  const rows = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  return { groups, rows, mode, unfold: (key: string) => setOpen((o) => new Set([...o, key])) } satisfies InboxList;
}
