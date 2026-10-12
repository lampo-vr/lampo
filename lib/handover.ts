// What a video's notes hand the person, counted one way wherever it is said — the stage (lib/stage.ts), the player's
// "Fixes to check" and check mode (web/src/player/fixCheck.ts), what agents read (mcp/, lib/cli.ts): a fix is the
// person's to check once a version that carries it exists. A new version doesn't turn open notes into fixes; a fix marked
// before its version rides with the next one (lib/store.ts). Shared with the browser: no Node imports.
import { compareTime, fixWaits, isAgent, isRequired, noteKind } from './time.ts';
import type { Comment, Version } from './types.ts';

type Note = Pick<Comment, 'status' | 'kind' | 'author' | 'severity' | 'check_again' | 'fix_pending'>;

/** Marked fixed before a version carried the fix (lib/time.ts, where the stage reads it). */
export { fixWaits };

/**
 * A fix the person checks now: marked fixed in a version that exists — or, in a store from before fixes were tied to
 * versions, an open note carried to a newer one (`check_again`). Never a question or an info note: they ask, they fix
 * nothing.
 */
export const waitsForCheck = (c: Pick<Note, 'status' | 'kind' | 'author' | 'check_again' | 'fix_pending'>): boolean =>
  noteKind(c) === 'feedback' && (c.status === 'fixed' || (c.status === 'open' && !!c.check_again && !c.fix_pending));

export interface Handover {
  /** Fixes in a version that exists, waiting for the person's check (with an older store's carried notes). */
  toCheck: number;
  /** Fixes marked before their version: they come to be checked with the next one. */
  waiting: number;
  /** Required notes nobody has answered: the agent's work still to do. */
  withAgent: number;
}

export function handover(comments: readonly Note[]): Handover {
  const h: Handover = { toCheck: 0, waiting: 0, withAgent: 0 };
  for (const c of comments) {
    if (waitsForCheck(c)) h.toCheck++;
    else if (fixWaits(c)) h.waiting++;
    else if (c.status === 'open' && isRequired(c)) h.withAgent++;
  }
  return h;
}

/**
 * What an agent's list of a video's open notes says after the work (lampo open, get_open_notes): the fixes it marked
 * before their version, and those the person checks now. Neither is work, so neither is listed as a note to fix.
 */
export function handedOverLines(comments: readonly Pick<Comment, 'id' | 'status' | 'fix_pending' | 'fixed_in_v'>[]): string[] {
  const riding = comments.filter(fixWaits).map((c) => c.id);
  const toCheck = comments.filter((c) => c.status === 'fixed').map((c) => `${c.id} (v${c.fixed_in_v})`);
  return [
    ...(riding.length ? [`Fixed, riding with your next version (put it up; no work item): ${riding.join(', ')}`] : []),
    ...(toCheck.length ? [`Fixed, waiting for the person's check (no work item): ${toCheck.join(', ')}`] : []),
  ];
}

/** How an agent's note line says a fix marked before its version (lampo, MCP, review.md): it comes with the next one. */
export const ridingFlag = (versions: readonly Pick<Version, 'v'>[]): string => `fixed, riding with v${(versions.at(-1)?.v ?? 0) + 1}`;

/**
 * The version a fix of this note has to be newer than: its own, or the one it was found still wrong in (the version its
 * Still wrong names; for a reopen from before they named one, the newest when a person last reopened it). A fix can't
 * be in the version the note is about.
 */
export function fixBase(versions: readonly Pick<Version, 'v' | 'registered'>[], c: Pick<Comment, 'v' | 'replies'>): number {
  let base = c.v;
  const reopened = [...(c.replies || [])].reverse().find((r) => r.status === 'open' && !isAgent(r.by));
  // A Still wrong names the version it was said on (Reply.on_v): that one, never a guess from times — a version that
  // came in the same second as the reopen isn't the one the person looked at.
  if (reopened?.on_v) return Math.max(base, reopened.on_v);
  if (reopened) for (const x of versions) if (x.v > base && x.registered && compareTime(x.registered, reopened.at) <= 0) base = x.v;
  return base;
}

/** Whether a note lies inside a partial render's stretch (frames of the version it patches): only those it can fix. */
export function inPart(c: Pick<Comment, 'frame' | 'range' | 'scope'>, part: { at: number; frames: number }): boolean {
  if (c.scope === 'video') return false;
  const end = part.at + part.frames - 1;
  if (c.range) return c.range.in <= end && c.range.out >= part.at;
  return c.frame >= part.at && c.frame <= end;
}
