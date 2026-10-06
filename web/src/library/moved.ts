// Moves on their way (library/moving.tsx): the stage a moved video shows until the server says the same, the question
// a move is asking (a confirm, or a sentence for the agent), and the card that just landed. One small store, read by
// the library (every layout and the lane counts see a move at once) and the board's cards; and `useMoves`, the
// library's way to make a move, whose code arrives with the first one.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Action } from '../../../lib/permissions.ts';
import type { StageInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import type { useSettle } from '../api/mutations.ts';
import type { VideoSummary } from '../api/types.ts';
import { loader } from '../lib/lazy.ts';
import type { LaneId } from './model.ts';
import type { Move } from './moves.ts';
import type { MoveDeps, MoveHow } from './moving.tsx';

/** The code of a move (moving.tsx): the runner, its questions and the sentence field. */
export const moveCode = loader(() => import('./moving.tsx'));

/** `move(video, lane, how)` for the library's cards. */
export function useMoves(can: (a: Action) => boolean, settle: ReturnType<typeof useSettle>) {
  const qc = useQueryClient();
  const by = useAuthStatus().data?.user?.name ?? '';
  const deps = useRef<MoveDeps>({ qc, settle, can, by });
  deps.current = { qc, settle, can, by };
  return useCallback((v: VideoSummary, to: LaneId, how: MoveHow = {}) => {
    moveCode
      .load()
      .then((m) => m.move(deps.current, v, to, how))
      .catch(() => {});
  }, []);
}

export interface Ask {
  slug: string;
  name: string;
  move: Move;
  /** A confirm (the app's Confirm), or a sentence for the agent — on the card itself where it is on the board. */
  kind: 'confirm' | 'note';
  inPlace: boolean;
  /** Reopening leaves a YouTube schedule live (publish/held.ts): the confirm says so. */
  held?: boolean;
  answer: (yes: boolean, note?: string) => void;
}

const stages = new Map<string, StageInfo>();
let ask: Ask | null = null;
let landed: string | null = null;
let version = 0;
/** Changes only with the stages (asks and landings don't make the library sort again). */
let stagesVersion = 0;
const subs = new Set<() => void>();
const emit = () => {
  version++;
  for (const f of subs) f();
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const snapshot = () => version;
const stagesSnapshot = () => stagesVersion;

/** Shows `slug` at `stage` (null: as the server has it). */
export function showMoved(slug: string, stage: StageInfo | null) {
  if (stage) stages.set(slug, stage);
  else if (!stages.delete(slug)) return;
  stagesVersion++;
  emit();
}

export const movedStage = (slug: string) => stages.get(slug) ?? null;

export function setAsk(a: Ask | null) {
  ask = a;
  emit();
}
export const currentAsk = () => ask;

let landedTimer = 0;
/** The card that just landed in its lane: it settles in with a short animation, and is an ordinary card again after. */
export function setLanded(slug: string) {
  clearTimeout(landedTimer);
  landedTimer = window.setTimeout(() => {
    landed = null;
    emit();
  }, LANDING_MS);
  landed = slug;
  emit();
}
const LANDING_MS = 900;

/** The question a move asks and the card that just landed, for whoever shows them. */
export function useMoveState(): { ask: Ask | null; landed: string | null } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ask, landed };
}

/** The library's videos with the moves on their way: a moved video stands where the move put it. */
export function useMovedVideos(videos: VideoSummary[] | null): VideoSummary[] | null {
  const ver = useSyncExternalStore(subscribe, stagesSnapshot, stagesSnapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the store's version stands for what it holds
  return useMemo(() => {
    if (!videos || !stages.size) return videos;
    return videos.map((v) => {
      const stage = stages.get(v.slug);
      return stage ? { ...v, stage } : v;
    });
  }, [videos, ver]);
}
