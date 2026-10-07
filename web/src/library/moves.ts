// Moving a card on the board is the sign-off that puts it there (docs/workflow.md, "Moving cards on the board"). Pure:
// which lanes a video may go to and for whom, which of the existing writes a move sends (status/api.ts `stageCalls`),
// what it asks first, and where the video lands. The landing is worked out with lib/stage.ts on what the library
// already knows about the video (its summary), so the board shows a move at once and never offers a lane the move
// wouldn't reach: a move whose result lands elsewhere (the client's word beats the team's, open notes keep a video
// being fixed) is no move. What only matters once a move is made (composing it with one still waiting, the words of a
// drag) is library/moveSteps.ts, loaded with the drag and the move's code.
import type { Action } from '../../../lib/permissions.ts';
import { LANES, stageOf } from '../../../lib/stage.ts';
import type { ApprovalEntry, StageInfo } from '../../../lib/types.ts';
import type { VideoSummary } from '../api/types.ts';
import { type LaneId, laneOf } from './model.ts';

export type StepKind = 'approve' | 'changes' | 'withdraw' | 'final' | 'reopen';

/** One write: a team verdict on a version (approve / changes / withdraw), marking it final, or reopening a final. */
export interface Step {
  kind: StepKind;
  /** The version it is about: the newest for a verdict or a final mark, the final one for a reopen. */
  v: number;
  /** A change request's words for the agent. */
  note?: string;
}

/** What each write needs (lib/permissions.ts; the server checks the same). */
export const STEP_NEEDS: Record<StepKind, Action> = { approve: 'approve', changes: 'approve', withdraw: 'approve', final: 'finalize', reopen: 'finalize' };

export interface Move {
  from: LaneId;
  to: LaneId;
  /** The writes, in the order they are sent. */
  steps: Step[];
  /** The newest version: what a verdict or a final mark is about. */
  v: number;
  /** Where the video lands: its stage once the steps are done. */
  stage: StageInfo;
  /** Asked first, with the app's Confirm: marking final, reopening a final, approving over open must-fix notes. */
  confirm: 'final' | 'reopen' | 'musts' | null;
  /** Open must-fix notes. */
  musts: number;
  /** Required notes still open (a final mark over them is a confirmed one). */
  open: number;
  /** A change request with nothing open for an agent to do: a sentence is asked for. */
  note: boolean;
}

type Staged = Parameters<typeof stageOf>[0];

/**
 * What stageOf reads, rebuilt from a library entry: its stage's counts stand in for the notes, its verdicts on the
 * newest version (and an older approval) for the history, its final mark, agent status and session as they are.
 */
export function summaryReview(v: VideoSummary): Staged {
  const s = v.stage;
  const notes = (n: number, note: object) => Array.from({ length: n }, () => ({ kind: 'feedback', severity: 'must', author: 'team', ...note }));
  return {
    versions: [{ v: s.v }],
    comments: [
      ...notes(s.open, { status: 'open' }),
      ...notes(s.to_verify, { status: 'fixed' }),
      ...notes(s.questions, { status: 'open', kind: 'question' }),
      ...notes(s.on_preview ?? 0, { status: 'verified', verified_on: { v: s.v } }),
    ],
    approvals: [s.approval_stale, s.team, s.client].filter((e): e is ApprovalEntry => !!e),
    approval: null,
    final: s.final,
    agent_status: v.agent_status ?? undefined,
    session: v.session,
  } as unknown as Staged;
}

function applyStep(r: Staged, step: Step, by: string, at: string): Staged {
  if (step.kind === 'reopen') return { ...r, final: null };
  if (step.kind === 'final') return { ...r, final: { v: step.v, by, at, note: null } };
  const status = step.kind === 'approve' ? 'approved' : step.kind === 'changes' ? 'changes' : 'withdrawn';
  const entry: ApprovalEntry = { party: 'team', status, v: step.v, by, at, note: step.note?.trim() || null };
  return { ...r, approvals: [...(r.approvals ?? []), entry] };
}

export interface MoveOptions {
  /** Who moves it (the guessed history entry's name until the server answers). */
  by?: string;
  now?: number;
}

/** Where `v` stands once `steps` are done, worked out by lib/stage.ts as the server would. */
export function stageAfter(v: VideoSummary, steps: Step[], { by = '', now = Date.now() }: MoveOptions = {}): StageInfo {
  const at = new Date(now).toISOString();
  const review = steps.reduce((r, s) => applyStep(r, s, by, at), summaryReview(v));
  return stageOf(review, {
    linked: v.stage.linked,
    share: v.stage.share ?? null,
    identical: v.stage.identical_to_approved,
    sessionActive: !!v.sessionActive,
    now,
  });
}

/**
 * The move of `v` to lane `to`, or null where there is none for this person. A final video is reopened first; then
 * Approved = the team approves the newest version, Being fixed = the team requests changes on it, To review = the
 * team's word on it is withdrawn; Final = marked final, only from Approved (where the player offers it) and never
 * while a fix exists only on a preview. Each write needs its action (`can`).
 */
export function planMove(v: VideoSummary, to: LaneId, can: (a: Action) => boolean, o: MoveOptions = {}): Move | null {
  // nothing moves in an archived project (lib/archived.ts), nor a removed video
  if (v.archived || v.project_archived) return null;
  const s = v.stage;
  const from = laneOf(s.stage);
  if (from === to) return null;
  const steps: Step[] = [];
  let stage = s;
  const run = (step: Step) => {
    steps.push(step);
    stage = stageAfter(v, steps, o);
  };
  if (s.final) run({ kind: 'reopen', v: s.final.v });
  if (to === 'final') {
    if (from !== 'approved' || (s.on_preview ?? 0) > 0) return null;
    run({ kind: 'final', v: s.v });
  } else if (laneOf(stage.stage) !== to) {
    if (to === 'approved') run({ kind: 'approve', v: s.v });
    else if (to === 'fixing') run({ kind: 'changes', v: s.v });
    else if (stage.team) run({ kind: 'withdraw', v: s.v });
    else return null;
  }
  if (laneOf(stage.stage) !== to || !steps.every((x) => can(STEP_NEEDS[x.kind]))) return null;
  const kinds = new Set(steps.map((x) => x.kind));
  const musts = v.counts.must;
  return {
    from,
    to,
    steps,
    v: s.v,
    stage,
    confirm: kinds.has('reopen') ? 'reopen' : kinds.has('final') ? 'final' : kinds.has('approve') && musts > 0 ? 'musts' : null,
    musts,
    open: s.open,
    note: kinds.has('changes') && s.open === 0,
  };
}

/** Every move this person may make with `v`, in lane order. */
export const movesOf = (v: VideoSummary, can: (a: Action) => boolean, o?: MoveOptions): Move[] =>
  LANES.map((l) => planMove(v, l.id, can, o)).filter((m): m is Move => !!m);

/** The nearest lane `v` may move to on one side (⌥← / ⌥→), skipping the ones it can't. */
export function nextMove(v: VideoSummary, dir: -1 | 1, can: (a: Action) => boolean, o?: MoveOptions): Move | null {
  const ids = LANES.map((l) => l.id as LaneId);
  for (let i = ids.indexOf(laneOf(v.stage.stage)) + dir; i >= 0 && i < ids.length; i += dir) {
    const m = planMove(v, ids[i] as LaneId, can, o);
    if (m) return m;
  }
  return null;
}
