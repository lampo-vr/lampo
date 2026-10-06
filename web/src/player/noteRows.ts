// The notes list's rules, without React or the DOM (test/unit/note-rows.test.ts): which rows start a group (who wrote
// them and when, said once like a chat), which tags the list offers as filters and how many notes each has, the note
// the playhead is at, and the next note for ↑ / ↓.
import { autoTags } from '../../../lib/autotag.ts';

/** Notes by one person written within this of each other read as one sitting: one group header. */
export const SITTING_MS = 30 * 60 * 1000;

interface Authored {
  id: string;
  author: string;
  author_id?: string | null;
  created: string;
}

const who = (c: Authored) => c.author_id || c.author;

/** The ids of the rows a group header goes above: the first, and every row whose author differs from the row above,
 * or whose note was written in another sitting (more than `gap` apart). */
export function groupStarts<T extends Authored>(list: readonly T[], gap = SITTING_MS): Set<string> {
  const out = new Set<string>();
  let prev: T | null = null;
  for (const c of list) {
    const apart = prev ? Math.abs(Date.parse(c.created) - Date.parse(prev.created)) : Number.POSITIVE_INFINITY;
    if (!prev || who(c) !== who(prev) || !(apart <= gap)) out.add(c.id);
    prev = c;
  }
  return out;
}

interface Tagged {
  tags?: string[] | null;
  text?: string | null;
}

/** A note's tags: the ones it carries, else what its words suggest (lib/autotag.ts, the walkie-talkie's rules). */
export const noteTags = (c: Tagged): string[] => (c.tags?.length ? c.tags : autoTags(c.text));

/** The tags in `list` with how many notes carry each, the most used first (then by name, for a stable row). */
export function tagCounts(list: readonly Tagged[]): [string, number][] {
  const n = new Map<string, number>();
  for (const c of list) for (const tag of new Set(noteTags(c))) n.set(tag, (n.get(tag) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
}

/** The notes with `tag` (all of them without one). */
export const withTag = <T extends Tagged>(list: readonly T[], tag: string | null): T[] => (tag ? list.filter((c) => noteTags(c).includes(tag)) : [...list]);

interface Placed {
  id: string;
  scope?: string | null;
  frameHere: number;
  rangeHere?: { in: number; out: number } | null;
}

/**
 * The note the playhead is at: inside its section, on its frame, or — `hold` frames — just past it (a note on one frame
 * is there for 1/25 s while playing; the hold keeps it marked long enough to see). The latest such note wins; notes
 * about the whole video have no moment.
 */
export function noteAt<T extends Placed>(list: readonly T[], frame: number, hold = 0): string | null {
  let best: T | null = null;
  for (const c of list) {
    if (c.scope === 'video') continue;
    const from = c.rangeHere ? c.rangeHere.in : c.frameHere;
    const to = c.rangeHere ? Math.max(c.rangeHere.out, c.frameHere + hold) : c.frameHere + hold;
    if (frame < from || frame > to) continue;
    if (!best || from >= (best.rangeHere ? best.rangeHere.in : best.frameHere)) best = c;
  }
  return best?.id ?? null;
}

/** ↑ / ↓: the note before or after `selected` in the list as shown; nothing selected → the first (↓) or last (↑). */
export function stepNote<T extends { id: string }>(list: readonly T[], selected: string | null, dir: 1 | -1): T | null {
  if (!list.length) return null;
  const i = selected ? list.findIndex((c) => c.id === selected) : -1;
  if (i < 0) return dir > 0 ? (list[0] as T) : (list[list.length - 1] as T);
  return list[i + dir] ?? null;
}

/** The text's first line, for a row (the full text is the opened card's). */
export const firstLine = (text: string | null | undefined): string => (text || '').trim().split(/\r?\n/, 1)[0] ?? '';
