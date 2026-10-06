// The conversion moments' few requests (server/routes/moments.ts): what this person put away and what waits for them
// (`GET /api/moments`), putting a moment away for 14 days and bringing it back (Undo), marking a one-time moment shown,
// and counting what a moment did (first-party, per week, never who: lib/funnel.ts). Loaded with the moments, never in the
// first paint. Counting is best effort: a count that can't be sent is dropped, it never shows an error.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MomentEvent, MomentId, MomentsState } from '../../../lib/types.ts';
import { api } from '../api/client.ts';
import { useSSE } from '../api/events.ts';
import { DAY } from './facts.ts';

/** "Not now" puts a moment away this long, per person and workspace, on every device. */
export const HIDE_DAYS = 14;

export const momentsKey = ['moments'] as const;

/** What this person put away and what waits for them; refreshed when the server tells them a moment waits (SSE). */
export function useMoments(enabled = true) {
  const qc = useQueryClient();
  useSSE('moment', () => void qc.invalidateQueries({ queryKey: momentsKey }));
  return useQuery({ queryKey: momentsKey, queryFn: () => api<MomentsState>('/api/moments'), enabled, staleTime: 60_000 });
}

/** Put away until then (null: bring it back). */
export async function hideMoment(id: MomentId, until: string | null): Promise<void> {
  await api(`/api/moments/${id}`, { method: 'PUT', body: { until } });
}

/** Put away for 14 days; the returned function brings it back (the toast's Undo). */
export function hideFor14Days(id: MomentId, now = Date.now()): { until: string; send: () => Promise<void>; undo: () => Promise<void> } {
  const until = new Date(now + HIDE_DAYS * DAY).toISOString();
  return { until, send: () => hideMoment(id, until), undo: () => hideMoment(id, null) };
}

/** Whether this person put the moment away (and it isn't back yet). */
export const isHidden = (s: MomentsState | undefined, id: MomentId, now = Date.now()): boolean => {
  const until = s?.hidden[id];
  return !!until && Date.parse(until) > now;
};

/** A one-time moment was shown: it never waits again, for anyone in the workspace. */
export const markSeen = (id: 'loop' | 'link_open') => api(`/api/moments/${id}/seen`, { method: 'POST' }).catch(() => {});

/** Counts what a moment did (shown, used, put away, made room instead) and where: per week, never who. */
export function momentEvent(e: MomentEvent, id: MomentId, where?: string): void {
  void api('/api/moments/event', { method: 'POST', body: where ? { e, id, where } : { e, id } }).catch(() => {});
}
