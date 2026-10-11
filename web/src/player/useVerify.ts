// Check mode (⇧V): walks through every note an agent marked fixed (or that was carried to a new render), showing the
// version it was written on — or the one it was last found still wrong on — next to the newest one. The queue is the notes themselves (fixCheck.ts): a fix settled in
// the panel, by someone else or here leaves it at once, and the card moves on or stays where it is.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommentActions } from '../api/mutations.ts';
import type { PlacedComment, Review, Shape } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useStableCallback } from '../lib/hooks.ts';
import { toast, toastError } from '../lib/toast.ts';
import { type CheckSession, checkPlace, checkVerdict, comparedWith, nextWaiting, waitsForCheck } from './fixCheck.ts';

export type CompareMode = 'side' | 'wipe' | 'overlay';
/** A/B: what B is (`v:<n>` a version, `s:<slug>` a sibling render), how the two are shown, the wipe position and the
 * overlay's blend (difference: what changed lights up; onion: B faded over A at `opacity`). */
export type AbState = { key: string; mode: CompareMode; pos: number; blend: 'difference' | 'onion'; opacity: number } | null;
export const compareState = (key: string, mode: CompareMode = 'side'): NonNullable<AbState> => ({ key, mode, pos: 0.5, blend: 'difference', opacity: 0.5 });

interface VerifyOptions {
  slug: string;
  review: Review;
  placed: PlacedComment[];
  latestV: number;
  showLatest: () => void;
  onStart: () => void;
  focus: (c: PlacedComment) => void;
  setAb: (ab: AbState) => void;
}

export function useVerify({ slug, review, placed, latestV, showLatest, onStart, focus, setAb }: VerifyOptions) {
  // The session: the order it walks and the fix it stands on. Which fixes still wait is read from the notes (fixCheck.ts),
  // so whatever settles one anywhere — this card, the note's card in the panel, someone else — takes it out at once.
  const [session, setSession] = useState<CheckSession | null>(null);
  const last = useRef<CheckSession | null>(null);
  if (session) last.current = session;
  const { patch } = useCommentActions(slug);
  const queue = useMemo(
    () =>
      placed
        .filter(waitsForCheck)
        .sort((a, b) => a.frameHere - b.frameHere)
        .map((c) => c.id),
    [placed],
  );
  const place = session ? checkPlace(session, queue) : null;
  const current = place?.current ?? null;
  const item = current ? placed.find((c) => c.id === current) || null : null;
  // what it is compared with: the version it was last found still wrong on (V2 → V3), else the one it was written on
  const before = item
    ? comparedWith(
        item,
        review.versions.map((x) => x.v),
        latestV,
      )
    : null;

  // The fix it stood on was settled: it stands on the next one now, so one before it that comes back to be checked
  // (an agent marks it fixed again) doesn't pull the card back. Nothing left after it: the session is done.
  useEffect(() => {
    if (!session) return;
    if (current && current !== session.at) setSession({ ...session, at: current });
    if (!current) {
      toast(t('Every fix checked'), 'ok');
      setAb(null);
      setSession(null);
    }
  }, [session, current, setAb]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: move only when the fix on the card changes, not on every data refresh
  useEffect(() => {
    if (!session || !item) return;
    focus(item);
  }, [current]);
  // what it is compared with follows the notes: a version or a Still wrong that arrives while the card is on the fix
  // (the page opened on data from before them) changes the before picture, never the place
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the fix or the version it is compared with changes
  useEffect(() => {
    if (!session || !item) return;
    setAb(before ? compareState(`v:${before}`) : null);
  }, [current, before]);

  // Stable: the memoised top bar gets it, and a new function every render (every frame while playing) re-rendered it.
  const start = useStableCallback(() => {
    if (!queue.length) return toast(t('No fixes to check'));
    showLatest();
    onStart();
    setSession({ order: queue, at: queue[0] });
  });
  /** Verify mode opened at one note (a "check this fix" link from For you or a notification). */
  const startAt = (id: string) => {
    if (!queue.includes(id)) return;
    showLatest();
    onStart();
    setSession({ order: queue, at: id });
  };
  const exit = () => {
    setSession(null);
    setAb(null);
  };
  /** S: on to the next fix that waits, this one left for later; past the last one the session ends. */
  const advance = () => {
    if (!session) return;
    const next = nextWaiting(session, queue);
    if (next) return setSession({ ...session, at: next });
    toast(t('Every fix checked'), 'ok');
    setAb(null);
    setSession(null);
  };
  // One verdict at a time: a second key press while the first is saved would answer the next fix, which the card shows
  // at once (the note changes before the server answers), before anyone looked at it.
  const deciding = useRef(false);
  /** `drawn`: Still wrong drawn on the version being checked, on that frame (the reply's picture). */
  const decide = async (ok: boolean, note?: string, drawn?: { frame: number; drawing: Shape[] } | null) => {
    const c = item;
    if (!c || deciding.current) return;
    deciding.current = true;
    try {
      await patch.mutateAsync({ id: c.id, ...checkVerdict(c, ok, note, latestV, drawn) });
      toast(ok ? t('Looks right') : t('Still wrong: back to the agent'), 'ok');
    } catch (e) {
      toastError(e);
      // the note is as it was (the guess rolled back): the card goes back to it, the session too if that was its last
      const s = session ?? last.current;
      if (s) setSession({ ...s, at: c.id });
    } finally {
      deciding.current = false;
    }
  };

  return {
    active: !!session && !!current,
    index: place?.index ?? 0,
    total: place?.total ?? 0,
    item,
    before,
    queue,
    busy: patch.isPending,
    start,
    startAt,
    exit,
    advance,
    decide,
  };
}
