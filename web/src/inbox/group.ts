// How the inbox reads: by video (each video one group with everything it waits on, the default) or by kind (questions,
// fixes, renders to review… — the inbox before). Pure and browser-safe, so the order the keys walk is the order the
// list shows, and the unit tests read it without a browser.
import { compareTime } from '../../../lib/time.ts';
import type { ForYouItem, ForYouKind, ForYouResponse } from '../../../lib/types.ts';

export type InboxMode = 'video' | 'kind';

/** Most urgent first: what someone waits on (questions, an agent's work that needs you, fixes, renders), then what
 * informs, stalled last. */
export const KIND_ORDER: ForYouKind[] = [
  'question',
  'blocked',
  'failed',
  'verify',
  'review',
  'post',
  'client',
  'playbook',
  'approval',
  'answer',
  'version',
  'stalled',
];

export interface InboxGroup {
  /** `kind:<kind>` or `video:<slug>` (a playbook suggestion: `playbook:<scope>`). */
  key: string;
  /** By kind: the kind. */
  kind?: ForYouKind;
  /** By video: the video (empty for a playbook's suggestions). */
  slug?: string;
  /** By video: the video's file name, or the playbook's name. */
  name?: string;
  folder?: string | null;
  items: ForYouItem[];
  /** Folded (the bell's popover and the phone's sheet): the items under the first, until the group is opened. */
  hidden?: ForYouItem[];
  /** The newest thing in the group. */
  latest: string;
}

const rank = (k: ForYouKind) => KIND_ORDER.indexOf(k);
/** Within a group: by kind, then newest first (stalled keep the server's order: longest waiting first). */
const byKindThenNewest = (a: ForYouItem, b: ForYouItem) => rank(a.kind) - rank(b.kind) || (a.kind === 'stalled' ? 0 : compareTime(b.at, a.at));
const newest = (items: ForYouItem[]) => items.reduce((m, i) => (compareTime(i.at, m) > 0 ? i.at : m), items[0]?.at ?? '');

export function groupByKind(items: ForYouItem[]): InboxGroup[] {
  return KIND_ORDER.flatMap((kind) => {
    const group = items.filter((i) => i.kind === kind);
    return group.length ? [{ key: `kind:${kind}`, kind, items: group, latest: newest(group) }] : [];
  });
}

/** One group per video, the most urgent first (the most urgent item it holds), then the one that moved last. */
export function groupByVideo(items: ForYouItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const i of items) {
    // Without a video: a playbook's suggestions, or questions asked on a folder before any render.
    const key = i.slug ? `video:${i.slug}` : i.kind === 'playbook' ? `playbook:${i.scope ?? i.folder ?? ''}` : `folder:${i.folder ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, slug: i.slug, name: i.video, folder: i.folder, items: [], latest: i.at };
      groups.set(key, g);
    }
    g.items.push(i);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.items.sort(byKindThenNewest);
    g.latest = newest(g.items);
  }
  const urgency = (g: InboxGroup) => Math.min(...g.items.map((i) => rank(i.kind)));
  return out.sort((a, b) => urgency(a) - urgency(b) || compareTime(b.latest, a.latest));
}

export const groupsOf = (items: ForYouItem[], mode: InboxMode): InboxGroup[] => (mode === 'kind' ? groupByKind(items) : groupByVideo(items));

/** A video with this many items folds to its head and its most urgent item where room is short. */
export const FOLD_FROM = 3;

/** Long groups folded, except those opened (`open`) and the one holding `keep` (the item open in the preview). */
export function folded(groups: InboxGroup[], open: ReadonlySet<string>, keep: string | null): InboxGroup[] {
  return groups.map((g) =>
    g.items.length < FOLD_FROM || open.has(g.key) || g.items.some((i) => i.key === keep) ? g : { ...g, items: g.items.slice(0, 1), hidden: g.items.slice(1) },
  );
}

/** The items in the order the list shows them — what ↑/↓ walk. */
export const orderedBy = (items: ForYouItem[], mode: InboxMode): ForYouItem[] => groupsOf(items, mode).flatMap((g) => g.items);

/** What a group holds, kind by kind with how many ("3 questions · 3 fixes · V4 to review" in the UI's words). */
export function tallyOf(items: ForYouItem[]): { kind: ForYouKind; n: number; v?: number }[] {
  return KIND_ORDER.flatMap((kind) => {
    const of = items.filter((i) => i.kind === kind);
    if (!of.length) return [];
    const v = Math.max(0, ...of.map((i) => i.v ?? 0));
    return [{ kind, n: of.length, ...(v ? { v } : {}) }];
  });
}

/** What "Done" does to an item, if anything: a question closes (no answer), what informs is waved through ("Got it").
 * An agent's failure has none: it leaves with Try again, or once it was opened (inbox/seen.ts). */
export type DoneKind = 'close' | 'dismiss' | null;
export const doneOf = (i: Pick<ForYouItem, 'kind' | 'dismissible'>): DoneKind =>
  i.kind === 'question' ? 'close' : i.dismissible && i.kind !== 'failed' ? 'dismiss' : null;

/** Tomorrow 9:00 in the browser's own day ("Later"), as an ISO time. */
export function laterUntil(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** The inbox with these items put aside until `until`: off the list and its counts, into `later` (Later's optimism). */
export function aside(d: ForYouResponse, gone: string[], until: string): ForYouResponse {
  const set = new Set(gone);
  const moved = d.items.filter((i) => set.has(i.key));
  if (!moved.length) return d;
  const counts = { ...d.counts, later: (d.counts.later ?? 0) + moved.length };
  for (const i of moved) {
    counts[i.kind] -= 1;
    // stalled videos aren't in the bell's number
    if (i.kind !== 'stalled') counts.total -= 1;
  }
  return {
    ...d,
    items: d.items.filter((i) => !set.has(i.key)),
    later: [...(d.later ?? []), ...moved.map((i) => ({ ...i, snoozed: until }))],
    counts,
    wake: d.wake && Date.parse(d.wake) <= Date.parse(until) ? d.wake : until,
  };
}
