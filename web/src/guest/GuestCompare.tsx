// Compare on a review link: the version on screen (A, the one the notes and the verdict are about) beside another the
// link shows (B, the reference), side by side or as a wipe, playing, stepping and scrubbing to the same frame (the
// owner's CompareBar, Stage and usePlayback's B side). Only a link that shows every version has it; B's media comes from
// GET /api/g/:token/review/:slug/compare, which such a link alone answers.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { api, enc } from '../api/client.ts';
import type { GuestCompare, GuestReview } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import type { BSource } from '../player/usePlayback.ts';
import type { AbState, CompareMode } from '../player/useVerify.ts';

export type CompareState = NonNullable<AbState>;

/** The ways a review link compares: side by side and the wipe (overlay and onion skin are the team's tools). */
export const GUEST_MODES: CompareMode[] = ['side', 'wipe'];
const MODE = 'vr.guestCompareMode';

/** Whether this page can compare: a link that shows every version, and a video with two of them at least. */
export const canCompare = (d: GuestReview): boolean => d.perms.versions === 'all' && d.versions.length > 1;

/** The version B is by default: the newest older one the visitor wrote notes on (what they reviewed last), else the
 * one before A, else (A is the oldest) the newest. */
export function defaultB(d: GuestReview, name: string): number {
  const others = d.versions.map((x) => x.v).filter((x) => x !== d.v);
  const older = others.filter((x) => x < d.v);
  const reviewed = (who: (author: string) => boolean) =>
    d.notes
      .filter((n) => n.mine && n.v < d.v && who(n.author) && others.includes(n.v))
      .map((n) => n.v)
      .sort((a, b) => a - b)
      .at(-1);
  const me = name.trim();
  return (me ? reviewed((a) => a === me) : undefined) ?? reviewed(() => true) ?? older.at(-1) ?? (others.at(-1) as number);
}

/** A compare starting now: B as above, in the way this browser last compared (side by side the first time). */
export function startCompare(d: GuestReview, name: string): CompareState {
  let mode: CompareMode = 'side';
  try {
    const kept = localStorage.getItem(MODE);
    if (kept === 'wipe') mode = 'wipe';
  } catch {}
  return { key: `v:${defaultB(d, name)}`, mode, pos: 0.5, blend: 'difference', opacity: 0.5 };
}

/** The way of comparing is remembered in this browser (a review link keeps no account). */
export function keepMode(mode: CompareMode): void {
  try {
    localStorage.setItem(MODE, mode);
  } catch {}
}

export const bOf = (cmp: CompareState | null): number | null => (cmp?.key.startsWith('v:') ? Number(cmp.key.slice(2)) : null);

/** The compare open on a video, kept for this tab: a reload (or the browser's back from another video) brings it back. */
export function useCompareKept(where: string): [CompareState | null, (c: CompareState | null) => void] {
  const key = `vr.guestCompare.${where}`;
  const [cmp, setCmp] = useState<CompareState | null>(() => {
    try {
      const kept = JSON.parse(sessionStorage.getItem(key) || 'null') as CompareState | null;
      return kept && /^v:\d+$/.test(kept.key) && (kept.mode === 'side' || kept.mode === 'wipe')
        ? { ...kept, pos: Math.min(1, Math.max(0, Number(kept.pos) || 0.5)) }
        : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (c: CompareState | null) => {
      setCmp(c);
      try {
        if (c) sessionStorage.setItem(key, JSON.stringify(c));
        else sessionStorage.removeItem(key);
      } catch {}
    },
    [key],
  );
  return [cmp, set];
}

/**
 * B for usePlayback: what to play and where it stands. Its frame size is known from the link's versions before its media
 * arrives, so its picture holds its place from the start (nothing moves when the video comes). `note` says what is
 * happening while there is no video yet.
 */
export function useCompareSide(token: string, d: GuestReview, cmp: CompareState | null) {
  const bv = bOf(cmp);
  const on = cmp !== null && bv !== null && canCompare(d);
  const q = useQuery({
    queryKey: ['guest', token, 'compare', d.slug, bv ?? 0],
    queryFn: () => api<GuestCompare>(`/api/g/${token}/review/${enc(d.slug)}/compare?v=${bv}`),
    enabled: on,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // while its copy is being made, ask again soon; once it plays, its address stays as it is
    refetchInterval: (x) => (x.state.data?.busy ? 15_000 : x.state.data?.preparing ? 3000 : false),
  });
  const known = d.versions.find((x) => x.v === bv);
  const data = q.data && q.data.v === bv ? q.data : null;
  const W = data?.width ?? known?.width ?? d.width;
  const H = data?.height ?? known?.height ?? d.height;
  const src = data?.media ?? null;
  const fps = data?.fps ?? d.fps;
  const frames = data?.frames ?? d.frames;
  // usePlayback keys B's sync on this object: the same one while nothing about B changed
  const b = useMemo<BSource | null>(() => (on && bv !== null ? { src, W, H, fps, frames, label: `V${bv}` } : null), [on, bv, src, W, H, fps, frames]);
  const note = !on
    ? null
    : q.error
      ? t('client::V{v} can’t be played right now.', { v: bv })
      : data && !data.media
        ? t('client::Getting V{v} ready…', { v: bv })
        : null;
  return { b, bv: on ? bv : null, note };
}
