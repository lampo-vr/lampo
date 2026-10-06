// The status workflow's sign-off actions (approve / request changes / withdraw, carry an approval over, mark final,
// reopen). A verdict or a final mark shows at once: the stage is worked out here with the same code the server uses
// (lib/stage.ts, from what the stage already says about links and sessions), then the review, the library (its board
// included) and "For you" follow the server's answer (api/live.ts), so a stage never lags behind in one place.
// The board's moves (library/moving.ts) send the same writes through `stageCalls`.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { approvalsOf, stageOf } from '../../../lib/stage.ts';
import type { ApprovalEntry } from '../../../lib/types.ts';
import { api, enc } from '../api/client.ts';
import { guess, useSettle, withEntry } from '../api/mutations.ts';
import { keys } from '../api/queries.ts';
import type { LibraryResponse, Review, ReviewResponse } from '../api/types.ts';

export interface VerdictInput {
  status: 'approved' | 'changes' | null;
  v: number;
  note?: string;
}

export interface FinalInput {
  v?: number;
  note?: string;
  /** Mark final although required notes are still open (the server asks for it with a 409 otherwise). */
  confirm?: boolean;
}

/** The sign-off writes for one video, as plain calls (`keepalive`: a write deferred behind an Undo toast may go out
 * while the tab closes). */
export function stageCalls(slug: string, { keepalive = false } = {}) {
  const base = `/api/review/${enc(slug)}`;
  return {
    /** The team's verdict on a version; status null withdraws it. */
    verdict: ({ status, v, note }: VerdictInput) => api(`${base}/approval`, { method: 'PUT', body: status ? { status, v, note } : { v }, keepalive }),
    carry: () => api(`${base}/approval/carry`, { method: 'POST', body: {}, keepalive }),
    final: (b: FinalInput) => api(`${base}/final`, { method: 'PUT', body: b, keepalive }),
    reopen: (note?: string) => api(`${base}/final`, { method: 'DELETE', body: { note }, keepalive }),
  };
}

/** The review response once `review` changed: its stage worked out again, with what the old stage knew about links. */
function restaged(r: ReviewResponse, review: Review, approvals = r.approvals): ReviewResponse {
  const info = r.summary.stage;
  // The UI's Review is the lenient reading of review.json (older files lack some version fields the stage never reads).
  const stage = stageOf(review as unknown as Parameters<typeof stageOf>[0], {
    linked: info.linked,
    share: info.share ?? null,
    identical: info.identical_to_approved,
    sessionActive: !!r.summary.sessionActive,
  });
  return { ...r, review, approvals, summary: { ...r.summary, stage } };
}

export function useStageActions(slug: string) {
  const qc = useQueryClient();
  const settle = useSettle();
  const key = keys.review(slug);
  const calls = stageCalls(slug);
  // The guessed stage also goes onto the video's card and board lane.
  const optimistic = async (change: (r: ReviewResponse) => ReviewResponse) => {
    let stage: ReviewResponse['summary']['stage'] | null = null;
    const undo = [
      await guess<ReviewResponse>(qc, key, (old) => {
        const next = change(old);
        stage = next.summary.stage;
        return next;
      }),
    ];
    if (stage) {
      const s = stage;
      undo.push(
        await guess<LibraryResponse>(
          qc,
          keys.library,
          withEntry(slug, (v) => ({ ...v, stage: s })),
        ),
      );
    }
    return undo;
  };
  const onError = (_e: unknown, _v: unknown, undo?: (() => void)[]) => {
    for (const u of undo || []) u();
  };
  const onSettled = () => settle.review(slug);
  return {
    /** The team's verdict on a version; status null withdraws it. */
    verdict: useMutation({
      mutationFn: calls.verdict,
      onMutate: ({ status, v, note }: VerdictInput) =>
        optimistic((r) => {
          const entry: ApprovalEntry = {
            party: 'team',
            status: status ?? 'withdrawn',
            v,
            by: r.user,
            at: new Date().toISOString(),
            note: note?.trim() || null,
          };
          const approvals = [...approvalsOf(r.review), entry];
          return restaged(r, { ...r.review, approvals }, [...r.approvals, entry]);
        }),
      onError,
      onSettled,
    }),
    carry: useMutation({ mutationFn: calls.carry, onSettled }),
    final: useMutation({
      mutationFn: calls.final,
      onMutate: (b: FinalInput) =>
        optimistic((r) => {
          const v = b.v ?? r.review.versions.at(-1)?.v ?? 1;
          return restaged(r, { ...r.review, final: { v, by: r.user, at: new Date().toISOString(), note: b.note?.trim() || null } });
        }),
      onError,
      onSettled,
    }),
    reopen: useMutation({
      mutationFn: calls.reopen,
      onMutate: () => optimistic((r) => restaged(r, { ...r.review, final: null })),
      onError,
      onSettled,
    }),
  };
}
