// What the composer points at on the timeline while you point at the composer: the note's range lit (its head hovered
// or focused) and the range an action would make (the action hovered or focused), drawn as a ghost. One composer and
// one timeline per page, so one store; the timeline redraws when it changes, nothing else renders.
import { useSyncExternalStore } from 'react';
import type { FrameRange } from '../../../lib/types.ts';

export interface RangeHint {
  lit: boolean;
  ghost: FrameRange | null;
}

const IDLE: RangeHint = { lit: false, ghost: null };
let hint = IDLE;
const listeners = new Set<() => void>();

export function setRangeHint(next: Partial<RangeHint>): void {
  const merged = { ...hint, ...next };
  if (merged.lit === hint.lit && merged.ghost?.in === hint.ghost?.in && merged.ghost?.out === hint.ghost?.out) return;
  hint = merged.lit || merged.ghost ? merged : IDLE;
  for (const fn of listeners) fn();
}

export const clearRangeHint = () => setRangeHint(IDLE);

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const useRangeHint = (): RangeHint => useSyncExternalStore(subscribe, () => hint);

/** Pointer and focus on the composer's head light the note's moment on the timeline. */
export const litHandlers = {
  onPointerEnter: () => setRangeHint({ lit: true }),
  onPointerLeave: () => setRangeHint({ lit: false }),
  onFocus: () => setRangeHint({ lit: true }),
  onBlur: () => setRangeHint({ lit: false }),
};
