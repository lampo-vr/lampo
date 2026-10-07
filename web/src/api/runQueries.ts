// Reading an agent's work on a video (lib/types.ts "runs"): the video's runs and one run's kept steps. Apart from the
// writes (api/runs.ts), so the Agent view's own chunk reads them without carrying the writes' code along.
import { useQuery } from '@tanstack/react-query';
import { api, enc } from './client.ts';
import type { Run, RunDetail, RunsResponse } from './types.ts';

export const runKeys = {
  of: (slug: string) => ['runs', slug] as const,
  one: (id: string) => ['run', id] as const,
};

/** The video's runs, newest first (asked for only where shown). `at`: when the answer came (the strip counts on). */
export function useRuns(slug: string, enabled: boolean): { runs: Run[] | undefined; at: number } {
  const q = useQuery({
    queryKey: runKeys.of(slug),
    queryFn: () => api<RunsResponse>(`/api/runs?slug=${enc(slug)}`),
    enabled,
    staleTime: 5_000,
  });
  return { runs: q.data?.runs, at: q.dataUpdatedAt };
}

/** One run with its kept steps (the Agent view). */
export function useRunDetail(id: string | null, enabled: boolean): RunDetail | undefined {
  return useQuery({
    queryKey: runKeys.one(id ?? ''),
    queryFn: () => api<RunDetail>(`/api/runs/${enc(id ?? '')}`),
    enabled: enabled && !!id,
    staleTime: 5_000,
  }).data;
}
