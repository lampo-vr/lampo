// Drafts that were just sent leave the holding area with a motion (record.css `draft-leave`), however soon the server's
// answer or the drafts event takes them off the list: what is shown is the list now, with the leaving ones (and the ones
// a send took, until its answer) put back where they stood until their motion has ended. Pure, so the order is tested
// (test/unit/drafts-leaving.test.ts).

/** How long a sent draft keeps its place while it leaves: the motion's length (`--dur`), a little over. */
export const LEAVE_MS = 200;

/**
 * What keeps its place: the drafts leaving, and while a send is out the ones it took. The server tells the drafts event
 * before it answers a send, so the list can drop them first: they stay on screen, being sent, until they leave.
 */
export const inPlace = (leaving: ReadonlySet<string>, sending?: ReadonlySet<string> | null): ReadonlySet<string> =>
  sending?.size ? new Set([...leaving, ...sending]) : leaving;

/** `now`, with the items of `before` that are `leaving` (and gone from `now`) back after the item they followed. */
export function withLeaving<T extends { id: string }>(before: readonly T[], now: readonly T[], leaving: ReadonlySet<string>): T[] {
  if (!leaving.size || !before.length) return now as T[];
  const here = new Set(now.map((x) => x.id));
  // each leaving item follows the nearest item before it that is still here (null: the list's start)
  const after = new Map<string | null, T[]>();
  let anchor: string | null = null;
  for (const b of before) {
    if (here.has(b.id)) anchor = b.id;
    else if (leaving.has(b.id)) after.set(anchor, [...(after.get(anchor) ?? []), b]);
  }
  if (!after.size) return now as T[];
  const out = [...(after.get(null) ?? [])];
  for (const x of now) out.push(x, ...(after.get(x.id) ?? []));
  return out;
}

/** Recordings as shown: each with its leaving drafts back in place, and one whose drafts all left kept until they have. */
export function recordingsLeaving<D extends { id: string }, R extends { id: string; drafts: D[] }>(
  before: readonly R[],
  now: readonly R[],
  leaving: ReadonlySet<string>,
): R[] {
  if (!leaving.size || !before.length) return now as R[];
  const was = new Map(before.map((r) => [r.id, r]));
  const going = new Set(before.filter((r) => r.drafts.some((d) => leaving.has(d.id))).map((r) => r.id));
  return withLeaving(before, now, going).map((r) => {
    const old = was.get(r.id);
    if (!old || !going.has(r.id)) return r;
    const drafts = withLeaving(old.drafts, r.drafts, leaving);
    return drafts === r.drafts ? r : { ...r, drafts };
  });
}
