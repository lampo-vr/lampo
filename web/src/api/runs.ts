// An agent's work on a video, as the server keeps it (lib/types.ts "runs"): the video's runs for the player's strip,
// note rows, timeline and version picker, one run's kept steps for the Agent view, and the person's three writes —
// Stop (at once, put back if the server says no), Try again and Nudge. SSE `run` refetches only that video's runs and
// that run's steps where they are shown (api/live.ts); the library's cards read the brief on their entry.
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, enc } from './client.ts';
import { guess, withEntry } from './mutations.ts';
import { keys } from './queries.ts';
import type { LibraryResponse, ReviewResponse, Run, RunBrief, RunDetail, RunsResponse, RunWriteResponse } from './types.ts';

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

/** What the cards need of a run (lib/types.ts RunBrief), from the whole run. */
export function briefOf(r: Run): RunBrief {
  const answered = r.plan.filter((p) => p.state !== 'todo' && p.state !== 'doing').length;
  return {
    id: r.id,
    agent: r.agent,
    state: r.state,
    started: r.started,
    ended: r.ended,
    worked_s: r.worked_s,
    now: r.now,
    progress: r.progress,
    result: r.result,
    error: r.error,
    needs: r.needs,
    planned: r.plan.length,
    answered,
  };
}

/** Every cached copy of one run changed the same way: the video's list, its steps, its card and the review's summary. */
function guessRun(qc: QueryClient, slug: string, id: string, patch: Partial<Pick<Run, 'state' | 'ended' | 'progress'>>): Promise<(() => void)[]> {
  const brief = (b: RunBrief | null | undefined) => (b && b.id === id ? { ...b, ...patch } : b);
  return Promise.all([
    guess<RunsResponse>(qc, runKeys.of(slug), (old) => ({ ...old, runs: old.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    guess<RunDetail>(qc, runKeys.one(id), (old) => ({ ...old, run: { ...old.run, ...patch } })),
    guess<LibraryResponse>(
      qc,
      keys.library,
      withEntry(slug, (v) => ({ ...v, run: brief(v.run) })),
    ),
    guess<ReviewResponse>(qc, keys.review(slug), (old) => ({ ...old, summary: { ...old.summary, run: brief(old.summary.run) } })),
  ]);
}

/** The server's answer in every cached copy (the follow-up run of Try again joins the video's list at the top). */
function settleRun(qc: QueryClient, slug: string, run: Run) {
  qc.setQueryData<RunsResponse>(runKeys.of(slug), (old) =>
    old ? { ...old, runs: old.runs.some((r) => r.id === run.id) ? old.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...old.runs] } : old,
  );
  qc.setQueryData<RunDetail>(runKeys.one(run.id), (old) => (old ? { ...old, run } : old));
  const b = briefOf(run);
  qc.setQueryData<LibraryResponse>(keys.library, (old) => (old ? withEntry(slug, (v) => ({ ...v, run: b }))(old) : old));
  qc.setQueryData<ReviewResponse>(keys.review(slug), (old) => (old ? { ...old, summary: { ...old.summary, run: b } } : old));
}

/** Stop, Try again (a failed or stopped run: the follow-up on the notes still open) and Nudge (one gone quiet). */
export function useRunActions(slug: string) {
  const qc = useQueryClient();
  const write = (what: 'stop' | 'retry' | 'nudge') => (id: string) => api<RunWriteResponse>(`/api/runs/${enc(id)}/${what}`, { method: 'POST' });
  const stop = useMutation({
    mutationFn: write('stop'),
    // stopped at once: the strip, the card and the Agent view say so before the server answers
    onMutate: (id: string) => guessRun(qc, slug, id, { state: 'stopped', ended: new Date().toISOString(), progress: null }),
    onError: (_e, _id, undo) => {
      for (const u of undo || []) u();
    },
    onSuccess: (d) => settleRun(qc, slug, d.run),
  });
  const retry = useMutation({ mutationFn: write('retry'), onSuccess: (d) => settleRun(qc, slug, d.run) });
  const nudge = useMutation({ mutationFn: write('nudge'), onSuccess: (d) => settleRun(qc, slug, d.run) });
  return { stop, retry, nudge };
}
