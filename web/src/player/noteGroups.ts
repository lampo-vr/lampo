// The notes list grouped by where each note stands, Linear's way: what needs the person (an agent's questions), the
// fixes to check (lib/handover.ts waitsForCheck, as the stage and check mode count them), the open notes, and the done
// ones at the end, folded. The groups are the list itself: no filter bar, no banner. Shared by the panel and its tests'
// expectations; no React here.
import { waitsForCheck } from '../../../lib/handover.ts';
import { isQuestion } from '../../../lib/time.ts';
import type { PlacedComment } from '../api/types.ts';

export type GroupId = 'needs' | 'check' | 'open' | 'done';
export const GROUPS: readonly GroupId[] = ['needs', 'check', 'open', 'done'];

/** Where a note stands in the list. */
export function groupOf(c: Pick<PlacedComment, 'status' | 'kind' | 'author' | 'check_again' | 'fix_pending'>): GroupId {
  if (c.status === 'verified' || c.status === 'wontfix') return 'done';
  if (c.status === 'open' && isQuestion(c)) return 'needs';
  if (waitsForCheck(c)) return 'check';
  return 'open';
}

export interface Grouped {
  /** The rows in their groups' order (the done ones only while that group is open). */
  rows: PlacedComment[];
  /** The first row of each shown group: its header goes above it. */
  firsts: Map<string, GroupId>;
  counts: Record<GroupId, number>;
}

/** `list` (already in the order the panel wants within a group) in its groups; `doneOpen`: the done ones shown. */
export function grouped(list: readonly PlacedComment[], doneOpen: boolean): Grouped {
  const by: Record<GroupId, PlacedComment[]> = { needs: [], check: [], open: [], done: [] };
  for (const c of list) by[groupOf(c)].push(c);
  const rows: PlacedComment[] = [];
  const firsts = new Map<string, GroupId>();
  for (const g of GROUPS) {
    if (g === 'done' && !doneOpen) continue;
    const first = by[g][0];
    if (first) firsts.set(first.id, g);
    rows.push(...by[g]);
  }
  return { rows, firsts, counts: { needs: by.needs.length, check: by.check.length, open: by.open.length, done: by.done.length } };
}
