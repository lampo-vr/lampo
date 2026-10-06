// Check mode's queue (useVerify.ts), pure. The notes are the one source of truth: a fix is in the queue while it waits
// to be checked (marked fixed, or carried to a new version to look at again), wherever it is settled — the check card,
// the note's card in the panel, another person, an agent — it leaves at once. A session only remembers the order it
// started with and where it stands; everything else is read from the notes as they are now.
import type { CommentStatus as Status } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';

/** A verdict as PATCH /api/comments/:id takes it (CommentPatch in api/mutations.ts, which this stays clear of: Node
 * unit tests import this file). */
export type Verdict = { status: 'verified' | 'open'; note: string } | { ack: true; note: string };

/** A fix to check: marked fixed, or an open note carried to a new version to look at again. */
export const waitsForCheck = (c: { status: Status; check_again?: boolean }): boolean => c.status === 'fixed' || (c.status === 'open' && !!c.check_again);

/**
 * The write for a verdict on a fix to check — the same from check mode's card and the note's card in the panel. Looks
 * right: checked (on a carried note the words say where). Still wrong: a fixed note reopens with the reason; a carried
 * one stays open, marked looked at (`ack`), the reason as its reply. `v`: the version it was checked on.
 */
export function checkVerdict(c: { status: Status }, ok: boolean, note: string | undefined, v: number): Verdict {
  if (ok) return { status: 'verified', note: c.status === 'open' ? t('Looks right in V{latestV}.', { latestV: v }) : '' };
  const why = note?.trim() || t('Still wrong in V{latestV}.', { latestV: v });
  return c.status === 'fixed' ? { status: 'open', note: why } : { ack: true, note: why };
}

/** A check session: the fixes in the order they are walked (timeline order when it started), and the one it is on. */
export interface CheckSession {
  order: string[];
  at: string;
}

export interface CheckPlace {
  /** The fix on the card, or null when none is left after the one it was on (the session is over). */
  current: string | null;
  /** Its number, from 0: the fixes settled so far (anywhere) and those skipped before it. */
  index: number;
  /** Every fix of the session: the ones it started with and any that came to be checked since. */
  total: number;
}

/** The session's order with fixes that came to be checked since it started (an agent marked one fixed) at the end. */
export function sessionOrder(s: CheckSession, waiting: readonly string[]): string[] {
  const known = new Set(s.order);
  return [...s.order, ...waiting.filter((id) => !known.has(id))];
}

/**
 * Where a session stands. `waiting`: the fixes waiting to be checked now. The one it is on stays while it waits; once
 * it is settled, the next that waits after it (in the session's order) takes its place.
 */
export function checkPlace(s: CheckSession, waiting: readonly string[]): CheckPlace {
  const order = sessionOrder(s, waiting);
  const open = new Set(waiting);
  const at = order.indexOf(s.at);
  const i = open.has(s.at) ? at : order.findIndex((id, k) => k > at && open.has(id));
  if (i < 0) return { current: null, index: order.length, total: order.length };
  // still to come: this one and every waiting fix after it; all before it were settled or skipped
  const ahead = order.slice(i).filter((id) => open.has(id)).length;
  return { current: order[i], index: order.length - ahead, total: order.length };
}

/** The fix after the current one that waits (S skips to it), or null at the end. */
export function nextWaiting(s: CheckSession, waiting: readonly string[]): string | null {
  const { current } = checkPlace(s, waiting);
  if (!current) return null;
  const order = sessionOrder(s, waiting);
  const open = new Set(waiting);
  const i = order.indexOf(current);
  return order.find((id, k) => k > i && open.has(id)) ?? null;
}
