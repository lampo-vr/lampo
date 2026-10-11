// Check mode's queue (useVerify.ts), pure. The notes are the one source of truth: a fix is in the queue while it waits
// to be checked (marked fixed in a version that exists; in an older store, carried to look at again), wherever it is settled — the check card,
// the note's card in the panel, another person, an agent — it leaves at once. A session only remembers the order it
// started with and where it stands; everything else is read from the notes as they are now.
import type { Reply, Shape, CommentStatus as Status } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';

/** Still wrong said on a version: which one, and what the person drew on it there (Reply.on_v, on_frame, drawing). */
export type SaidOn = { v: number; frame?: number; drawing?: Shape[] };

/** A verdict as PATCH /api/comments/:id takes it (CommentPatch in api/mutations.ts, which this stays clear of: Node
 * unit tests import this file). */
export type Verdict = { status: 'verified'; note: string } | { status: 'open'; note: string; on: SaidOn } | { ack: true; note: string; on: SaidOn };

/** A fix to check: marked fixed in a version that exists (or, in an older store, an open note carried to a new version
 * to look at again); never a question, never a fix still riding with the next version — the rule the stage and what
 * agents read count by too (lib/handover.ts). */
export { waitsForCheck } from '../../../lib/handover.ts';

/**
 * The write for a verdict on a fix to check — the same from check mode's card and the note's card in the panel. Looks
 * right: checked (on a carried note the words say where). Still wrong: a fixed note reopens with the reason; a carried
 * one (an older store's: new versions carry nothing) stays open, marked looked at (`ack`), the reason as its reply.
 * `v`: the version it was checked on; Still wrong names it (`on`), with what was drawn on it there (check mode's
 * `drawn`): the reply's picture for the agent.
 */
export function checkVerdict(
  c: { status: Status },
  ok: boolean,
  note: string | undefined,
  v: number,
  drawn?: { frame: number; drawing: Shape[] } | null,
): Verdict {
  if (ok) return { status: 'verified', note: c.status === 'open' ? t('Looks right in V{latestV}.', { latestV: v }) : '' };
  const why = note?.trim() || t('Still wrong in V{latestV}.', { latestV: v });
  const on: SaidOn = drawn?.drawing.length ? { v, frame: drawn.frame, drawing: drawn.drawing } : { v };
  return c.status === 'fixed' ? { status: 'open', note: why, on } : { ack: true, note: why, on };
}

/** A reply as both the server's and the app's types have it (the app's words may be missing). */
type Said = Pick<Reply, 'on_v' | 'on_frame' | 'drawing'> & { status?: Status | null; fixed_in_v?: number | string | null; text?: string | null };

/**
 * The last Still wrong on a note: its reply and the version it was said on — named (`on_v`), or, for one said before
 * replies named it, the version of the fix it reopened. Null when none was said, or the fix was found right since.
 */
export function lastStillWrong(c: { replies?: Said[] }): { reply: Said; v: number } | null {
  const replies = c.replies || [];
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i];
    // checked and found right since: what was said before is history, not what this check answers
    if (r.status === 'verified') return null;
    if (r.on_v) return { reply: r, v: r.on_v };
    if (r.status === 'open') {
      const fix = replies.slice(0, i).findLast((x) => x.status === 'fixed');
      return fix?.fixed_in_v ? { reply: r, v: Number(fix.fixed_in_v) } : null;
    }
  }
  return null;
}

/**
 * The version a fix is checked against: the one it was last found still wrong on (Still wrong in V2, fixed in V3: V2 →
 * V3), else the note's own. Null when that is the version being checked or no longer exists (nothing to compare).
 */
export function comparedWith(c: { v: number; replies?: Said[] }, versions: readonly number[], latestV: number): number | null {
  const wrong = lastStillWrong(c)?.v;
  const from = wrong && wrong !== latestV && versions.includes(wrong) ? wrong : c.v;
  return from !== latestV && versions.includes(from) ? from : null;
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
