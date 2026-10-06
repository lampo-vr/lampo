// Where a video stands, decided in one place. Browser-safe (no Node imports): the server, the CLI, the MCP server and
// the UI all call stageOf(), so a video never reads "approved" in one place and "to review" in another.
//
// Precedence (docs/workflow.md):
//   1. final           — marked final and not reopened; newer renders don't move it (flag: final_superseded).
//   2. a verdict on the newest version — the client's newest verdict beats the team's:
//        client approved → client_approved
//        team approved   → with_client once a visitor opened the newest version through a review link covering it
//                          (shared but not opened, or opened only before this render: still team_approved)
//        changes         → in_progress while an agent works on it, else changes
//   3. no verdict on the newest version:
//        required notes open → in_progress while an agent works on it, else changes
//        fixes waiting       → check_fixes
//        fixes verified only on a fix preview (no render has them yet) → in_progress / changes: the next render is due
//        otherwise           → to_review (flags: approval_stale, identical_to_approved)
//   Fixes verified on a preview are resolved for the reviewer, but a video can't be final while one isn't rendered.
//   A partial render (lib/part.ts) is a new version to review like any other ("V8 (part)"), but never final: where
//   "Mark final" would be next, a full render is.
import { ago, compareTime, isQuestion, isRequired, oneLine } from './time.ts';
import type { ApprovalEntry, ApprovalParty, NextStep, PublishedSignal, Review, ShareSignal, Stage, StageInfo } from './types.ts';

export const STAGES: readonly Stage[] = ['to_review', 'changes', 'in_progress', 'check_fixes', 'team_approved', 'with_client', 'client_approved', 'final'];

export const STAGE_LABELS: Record<Stage, string> = {
  to_review: 'To review',
  changes: 'Changes requested',
  in_progress: 'In progress',
  check_fixes: 'Check fixes',
  team_approved: 'Approved',
  with_client: 'Client reviewing',
  client_approved: 'Client approved',
  final: 'Final',
};

/** The five steps a video walks through, for steppers: review → fixes → approved → client → final. */
export const STEPS = ['Review', 'Fixes', 'Approved', 'Client', 'Final'] as const;
export const STAGE_STEP: Record<Stage, number> = {
  to_review: 0,
  changes: 1,
  in_progress: 1,
  check_fixes: 1,
  team_approved: 2,
  with_client: 3,
  client_approved: 3,
  final: 4,
};

/** Board lanes: what needs you, what is being fixed, what is approved, what is done. */
export const LANES = [
  { id: 'needs_you', label: 'Needs you', stages: ['to_review', 'check_fixes'] as Stage[] },
  { id: 'fixing', label: 'Being fixed', stages: ['changes', 'in_progress'] as Stage[] },
  { id: 'approved', label: 'Approved', stages: ['team_approved', 'with_client', 'client_approved'] as Stage[] },
  { id: 'final', label: 'Final', stages: ['final'] as Stage[] },
] as const;

/** Approved in any form (team, with the client, by the client, final). */
export const isApprovedStage = (s: Stage): boolean => s === 'team_approved' || s === 'with_client' || s === 'client_approved' || s === 'final';

export const emptyStageCounts = (): Record<Stage, number> => Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;

/** Verdicts from review links are the client's; everything else is the team's. */
export const partyOf = (by: string): ApprovalParty => (by.startsWith('guest:') ? 'client' : 'team');

/** The verdict history, oldest first. Stores from before the history have one `approval`: it becomes the one entry. */
export function approvalsOf(review: Pick<Review, 'approval' | 'approvals'>): ApprovalEntry[] {
  if (review.approvals) return review.approvals;
  const a = review.approval;
  return a ? [{ party: partyOf(a.by), status: a.status, v: a.v, by: a.by, at: a.at, note: a.note ?? null }] : [];
}

/** A party's standing verdict on a version: its newest entry there, unless that entry withdrew it. */
export function verdictOn(history: ApprovalEntry[], party: ApprovalParty, v: number): ApprovalEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i] as ApprovalEntry;
    if (e.party === party && e.v === v) return e.status === 'withdrawn' ? null : e;
  }
  return null;
}

/** The newest approval (not a change request) of an older version, from either party. */
function newestOlderApproval(history: ApprovalEntry[], latest: number): ApprovalEntry | null {
  let best: ApprovalEntry | null = null;
  for (const party of ['team', 'client'] as const) {
    const vs = [...new Set(history.filter((e) => e.party === party && e.v < latest).map((e) => e.v))];
    for (const v of vs) {
      const e = verdictOn(history, party, v);
      if (e?.status === 'approved' && (!best || e.v > best.v || (e.v === best.v && compareTime(e.at, best.at) > 0))) best = e;
    }
  }
  return best;
}

export interface StageContext {
  /** An active review link covers the video. */
  linked?: boolean;
  /** What the client did with that link (lib/stageContext.ts). Without it a covering link reads as shared, not seen. */
  share?: ShareSignal | null;
  /** The newest version is identical to the approved older one (from the version diff). */
  identical?: boolean;
  /** The assigned Claude session is running (an agent status that hasn't run out counts as working anyway). */
  sessionActive?: boolean;
  /** The video's posts on platforms (lib/publish/posts.ts postSignal): carried as `published`, the stage stays final. */
  published?: PublishedSignal;
  now?: number;
}

/** "opened by Mia 2 h ago" · "opened 3×, last 2 h ago". */
function openedBy(s: ShareSignal, now: number): string {
  const when = s.last_opened ? ` ${ago(s.last_opened, now)}` : '';
  if (s.by) return `opened by ${s.by}${when}`;
  return s.opens > 1 ? `opened ${s.opens}×${when ? `, last${when}` : ''}` : `opened${when}`;
}

/** 'shared via "Client link" · not opened yet' · '… · V6 not seen yet' (they looked at an older render). */
function notOpened(s: ShareSignal | null | undefined, v: number): string {
  if (!s) return 'shared · not opened yet';
  const via = `shared via "${s.label}"`;
  return s.seen_v !== null || s.opens ? `${via} · V${v} not seen yet` : `${via} · not opened yet`;
}

const who = (e: ApprovalEntry) => (e.party === 'client' ? `client: ${e.by.replace(/^guest:/, '')}` : 'team');

export function stageOf(
  review: Pick<Review, 'versions' | 'comments' | 'approval' | 'approvals' | 'final' | 'agent_status' | 'session'>,
  ctx: StageContext = {},
): StageInfo {
  const v = review.versions.at(-1)?.v ?? 1;
  const history = approvalsOf(review);
  const team = verdictOn(history, 'team', v);
  const client = verdictOn(history, 'client', v);
  let open = 0;
  let toVerify = 0;
  let questions = 0;
  let onPreview = 0;
  for (const c of review.comments) {
    if (c.status === 'verified' && c.verified_on && c.verified_on.v >= v) onPreview++;
    if (c.status === 'fixed') toVerify++;
    else if (c.status === 'open') {
      if (isRequired(c)) open++;
      else if (isQuestion(c)) questions++;
    }
  }
  const now = ctx.now ?? Date.now();
  const newest = review.versions.at(-1);
  const part = newest?.part ? { of: newest.part.of, at: newest.part.at, frames: newest.part.frames } : null;
  // The newest version as people read it: a partial render says so.
  const V = (n: number) => (part && n === v ? `V${n} (part)` : `V${n}`);
  const status = review.agent_status;
  const agentWorking = (!!status && (!status.until || Date.parse(status.until) > now)) || (!!review.session && !!ctx.sessionActive);
  const final = review.final ?? null;
  const base = {
    v,
    team,
    client,
    final,
    approval_stale: null as ApprovalEntry | null,
    identical_to_approved: false,
    final_superseded: null as number | null,
    open,
    to_verify: toVerify,
    questions,
    on_preview: onPreview,
    linked: !!ctx.linked || !!ctx.share,
    ...(ctx.share !== undefined ? { share: ctx.share } : {}),
    ...(part ? { part } : {}),
    ...(ctx.published ? { published: ctx.published } : {}),
  };
  const make = (stage: Stage, detail: string, next: NextStep, extra: Partial<StageInfo> = {}): StageInfo => ({ ...base, ...extra, stage, detail, next });
  const onPreviewText = `${onPreview} fix${onPreview === 1 ? '' : 'es'} checked on a preview`;
  const stillOpen = (open ? ` · ${open} note${open === 1 ? '' : 's'} still open` : '') + (onPreview ? ` · ${onPreviewText}, not rendered yet` : '');
  const renderPreviews: NextStep = { kind: 'fix', label: 'Render the fixes checked on previews' };
  const renderFull: NextStep = { kind: 'fix', label: 'Render it in full for final' };
  const working = (detail: string) =>
    agentWorking
      ? make('in_progress', status?.text ? oneLine(`${status.text} (${status.by.replace(/^agent:/, '')})`) : detail, {
          kind: 'wait_agent',
          label: 'An agent is on it',
        })
      : make(
          'changes',
          detail,
          review.session ? { kind: 'fix', label: oneLine(`Waiting for fixes from ${review.session.name}`) } : { kind: 'assign', label: 'Hand it to an agent' },
        );

  // 1. final
  if (final) {
    const superseded = v > final.v ? v : null;
    return make(
      'final',
      superseded ? `Final V${final.v} · V${superseded} arrived since` : `Final V${final.v} · marked by ${final.by}`,
      superseded ? { kind: 'reopen', label: `Reopen to review V${superseded}` } : { kind: 'none', label: 'Done' },
      { final_superseded: superseded },
    );
  }

  // 2. a verdict on the newest version: the client's word beats the team's
  const verdict = client ?? team;
  if (verdict?.status === 'approved') {
    if (verdict.party === 'client')
      return make(
        'client_approved',
        `Client approved ${V(v)} (${verdict.by.replace(/^guest:/, '')})${stillOpen}`,
        onPreview ? renderPreviews : part ? renderFull : { kind: 'finalize', label: 'Mark final' },
      );
    const share = ctx.share;
    if (share?.opened)
      return make('with_client', `Approved ${V(v)} · ${openedBy(share, now)}${stillOpen}`, { kind: 'wait_client', label: "Waiting for the client's verdict" });
    if (share || ctx.linked)
      return make('team_approved', `Approved ${V(v)} · ${notOpened(share, v)}${stillOpen}`, {
        kind: 'wait_client',
        label: 'Waiting for the client to open the link',
      });
    return make('team_approved', `Approved ${V(v)} by the team${stillOpen}`, { kind: 'send', label: 'Send to the client' });
  }
  if (verdict?.status === 'changes') return working(`Changes requested on ${V(v)} (${who(verdict)})${verdict.note ? `: ${oneLine(verdict.note)}` : ''}`);

  // 3. no verdict on the newest version
  if (open) return working(`${open} note${open === 1 ? '' : 's'} open on ${V(v)}`);
  if (toVerify)
    return make('check_fixes', `${toVerify} fix${toVerify === 1 ? '' : 'es'} to check in ${V(v)}`, {
      kind: 'verify',
      label: `Check ${toVerify} fix${toVerify === 1 ? '' : 'es'}`,
    });
  // Everything checked, but some fixes exist only in the project: the next render is the agent's move.
  if (onPreview) return working(`${onPreviewText} · V${v + 1} to render`);
  const stale = newestOlderApproval(history, v);
  if (stale && ctx.identical)
    return make(
      'to_review',
      `${V(v)} is identical to approved V${stale.v}`,
      { kind: 'carry', label: `Carry the approval over to V${v}` },
      { approval_stale: stale, identical_to_approved: true },
    );
  if (stale) return make('to_review', `V${stale.v} approved · ${V(v)} new`, { kind: 'review', label: `Review V${v}` }, { approval_stale: stale });
  return make('to_review', `${V(v)} to review`, { kind: 'review', label: `Review V${v}` });
}
