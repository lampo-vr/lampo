// lib/stage.ts: every stage and every flag, from the smallest review that produces it (docs/workflow.md explains the
// precedence). Pure: no store, no ffmpeg.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalsOf, isApprovedStage, STAGE_STEP, STAGES, stageOf, verdictOn } from '../../lib/stage.ts';
import type { ApprovalEntry, Comment, Review, ShareSignal, Stage, StageInfo } from '../../lib/types.ts';

type R = Parameters<typeof stageOf>[0];
const T = '2026-09-28T10:00:00+02:00';
const later = (min: number) => `2026-09-28T10:${String(min).padStart(2, '0')}:00+02:00`;

const review = (o: Partial<Review> & { v?: number } = {}): R => ({
  versions: Array.from({ length: o.v ?? 1 }, (_, i) => ({ v: i + 1 }) as Review['versions'][number]),
  comments: o.comments ?? [],
  approval: o.approval,
  approvals: o.approvals,
  final: o.final,
  agent_status: o.agent_status,
  session: o.session ?? null,
});
const note = (o: Partial<Comment> = {}): Comment =>
  ({ id: 'c_1', v: 1, frame: 0, severity: 'should', status: 'open', author: 'alex', replies: [], ...o }) as Comment;
const verdict = (
  party: ApprovalEntry['party'],
  status: ApprovalEntry['status'],
  v: number,
  at = T,
  by = party === 'client' ? 'guest:Mia' : 'alex',
): ApprovalEntry => ({
  party,
  status,
  v,
  by,
  at,
  note: null,
});
const session = { name: 'promo-edit', id: 's1', cwd: null, assigned: T, by: 'alex' };
const link = (o: Partial<ShareSignal> = {}): ShareSignal => ({
  label: 'Client link',
  kind: 'video',
  opened: false,
  opens: 0,
  last_opened: null,
  seen_v: null,
  by: null,
  reviewers: [],
  ...o,
});

interface Case {
  name: string;
  r: R;
  ctx?: Parameters<typeof stageOf>[1];
  stage: Stage;
  check?: (s: StageInfo) => void;
}

const cases: Case[] = [
  { name: 'a fresh render with nothing on it', r: review(), stage: 'to_review', check: (s) => assert.equal(s.next.kind, 'review') },
  {
    name: 'ideas, questions and info notes are no work',
    r: review({ comments: [note({ severity: 'idea' }), note({ kind: 'question', author: 'agent:x' }), note({ kind: 'info', author: 'agent:x' })] }),
    stage: 'to_review',
    check: (s) => assert.equal(s.questions, 1),
  },
  {
    name: 'an open required note, nobody on it',
    r: review({ comments: [note()] }),
    stage: 'changes',
    check: (s) => assert.deepEqual([s.open, s.next.kind], [1, 'assign']),
  },
  {
    name: 'an open note with a session assigned but not running',
    r: review({ comments: [note()], session }),
    stage: 'changes',
    check: (s) => assert.equal(s.next.kind, 'fix'),
  },
  { name: 'an open note and the assigned session is running', r: review({ comments: [note()], session }), ctx: { sessionActive: true }, stage: 'in_progress' },
  {
    name: 'an open note and an agent status',
    r: review({ comments: [note()], agent_status: { text: 'rendering v2', by: 'agent:promo-edit', at: T } }),
    stage: 'in_progress',
    check: (s) => assert.match(s.detail, /rendering v2 \(promo-edit\)/),
  },
  {
    name: 'an agent status that has run out does not count',
    r: review({ comments: [note()], agent_status: { text: 'rendering', by: 'agent:x', at: T, until: '2020-01-01T00:00:00Z' } }),
    stage: 'changes',
  },
  {
    name: 'fixes waiting, nothing open',
    r: review({ comments: [note({ status: 'fixed', fixed_in_v: 1 })] }),
    stage: 'check_fixes',
    check: (s) => assert.equal(s.next.kind, 'verify'),
  },
  { name: 'open notes win over fixes to check', r: review({ comments: [note({ status: 'fixed' }), note({ id: 'c_2' })] }), stage: 'changes' },
  {
    name: 'the team approved the newest version',
    r: review({ approvals: [verdict('team', 'approved', 1)] }),
    stage: 'team_approved',
    check: (s) => assert.equal(s.next.kind, 'send'),
  },
  {
    name: 'approved and shared, but nobody opened the link: shared is not seen',
    r: review({ approvals: [verdict('team', 'approved', 1)] }),
    ctx: { linked: true, share: link() },
    stage: 'team_approved',
    check: (s) => {
      assert.equal(s.detail, 'Approved V1 · shared via "Client link" · not opened yet');
      assert.deepEqual(s.next, { kind: 'wait_client', label: 'Waiting for the client to open the link' });
      assert.equal(s.share?.opened, false);
      assert.equal(s.linked, true);
    },
  },
  {
    name: 'a caller that only knows a link exists: shared, not seen',
    r: review({ approvals: [verdict('team', 'approved', 1)] }),
    ctx: { linked: true },
    stage: 'team_approved',
    check: (s) => assert.equal(s.next.kind, 'wait_client'),
  },
  {
    name: 'approved and a visitor opened the newest version',
    r: review({ approvals: [verdict('team', 'approved', 1)] }),
    ctx: { linked: true, share: link({ opened: true, opens: 2, seen_v: 1, by: 'Mia', last_opened: later(0) }), now: Date.parse(later(0)) + 2 * 3600_000 },
    stage: 'with_client',
    check: (s) => {
      assert.equal(s.detail, 'Approved V1 · opened by Mia 2 h ago');
      assert.deepEqual(s.next, { kind: 'wait_client', label: "Waiting for the client's verdict" });
    },
  },
  {
    name: 'opened, no name given',
    r: review({ approvals: [verdict('team', 'approved', 1)] }),
    ctx: { share: link({ opened: true, opens: 3, seen_v: 1, last_opened: later(0) }), now: Date.parse(later(5)) },
    stage: 'with_client',
    check: (s) => assert.equal(s.detail, 'Approved V1 · opened 3×, last 5 min ago'),
  },
  {
    name: 'the client saw V1, V2 is approved but not opened yet',
    r: review({ v: 2, approvals: [verdict('team', 'approved', 2)] }),
    ctx: { share: link({ opened: false, opens: 1, seen_v: 1, last_opened: later(0) }) },
    stage: 'team_approved',
    check: (s) => assert.equal(s.detail, 'Approved V2 · shared via "Client link" · V2 not seen yet'),
  },
  { name: 'the client approved (without the team)', r: review({ approvals: [verdict('client', 'approved', 1)] }), stage: 'client_approved' },
  {
    name: "the client's change request beats the team's approval",
    r: review({ approvals: [verdict('team', 'approved', 1), verdict('client', 'changes', 1, later(5))] }),
    stage: 'changes',
    check: (s) => assert.match(s.detail, /client: Mia/),
  },
  {
    name: "the team's newest verdict counts",
    r: review({ approvals: [verdict('team', 'changes', 1), verdict('team', 'approved', 1, later(5))] }),
    stage: 'team_approved',
  },
  {
    name: 'a withdrawn approval is no approval',
    r: review({ approvals: [verdict('team', 'approved', 1), verdict('team', 'withdrawn', 1, later(5))] }),
    stage: 'to_review',
  },
  {
    name: 'an explicit approval wins over open notes, which stay visible',
    r: review({ comments: [note()], approvals: [verdict('team', 'approved', 1)] }),
    stage: 'team_approved',
    check: (s) => assert.match(s.detail, /1 note still open/),
  },
  {
    name: 'changes requested while an agent works on it',
    r: review({ approvals: [verdict('client', 'changes', 1)], session }),
    ctx: { sessionActive: true },
    stage: 'in_progress',
  },
  {
    name: 'an approval of an older version goes stale',
    r: review({ v: 2, approvals: [verdict('team', 'approved', 1)] }),
    stage: 'to_review',
    check: (s) => {
      assert.equal(s.approval_stale?.v, 1);
      assert.equal(s.detail, 'V1 approved · V2 new');
      assert.equal(s.identical_to_approved, false);
    },
  },
  {
    name: 'an identical new render offers carrying the approval over',
    r: review({ v: 2, approvals: [verdict('team', 'approved', 1)] }),
    ctx: { identical: true },
    stage: 'to_review',
    check: (s) => assert.deepEqual([s.identical_to_approved, s.next.kind], [true, 'carry']),
  },
  { name: 'final', r: review({ final: { v: 1, by: 'alex', at: T, note: null } }), stage: 'final', check: (s) => assert.equal(s.next.kind, 'none') },
  {
    name: 'a render after final does not move it',
    r: review({ v: 2, final: { v: 1, by: 'alex', at: T, note: null }, comments: [note({ v: 2 })] }),
    stage: 'final',
    check: (s) => {
      assert.equal(s.final_superseded, 2);
      assert.equal(s.detail, 'Final V1 · V2 arrived since');
      assert.equal(s.next.kind, 'reopen');
    },
  },
  {
    name: 'a store from before the history: the one team approval',
    r: review({ approval: { status: 'approved', v: 1, by: 'alex', at: T, note: null } }),
    stage: 'team_approved',
  },
  {
    name: 'a store from before the history: a client approval',
    r: review({ approval: { status: 'approved', v: 1, by: 'guest:Mia', at: T, note: null } }),
    stage: 'client_approved',
  },
];

for (const c of cases)
  test(`stage: ${c.name} → ${c.stage}`, () => {
    const s = stageOf(c.r, c.ctx);
    assert.equal(s.stage, c.stage, s.detail);
    c.check?.(s);
  });

test('every stage is covered above, maps to a step, and "approved" means what it says', () => {
  assert.deepEqual([...new Set(cases.map((c) => c.stage))].sort(), [...STAGES].sort());
  for (const s of STAGES) assert.ok(STAGE_STEP[s] >= 0 && STAGE_STEP[s] <= 4, s);
  assert.deepEqual(STAGES.filter(isApprovedStage), ['team_approved', 'with_client', 'client_approved', 'final']);
});

test('the history: legacy approval as one entry; standing verdicts per party and version', () => {
  assert.deepEqual(approvalsOf({ approval: null }), []);
  const legacy = approvalsOf({ approval: { status: 'changes', v: 3, by: 'guest:Ana', at: T, note: 'heller' } });
  assert.deepEqual(legacy, [{ party: 'client', status: 'changes', v: 3, by: 'guest:Ana', at: T, note: 'heller' }]);
  const h = [verdict('team', 'approved', 1), verdict('team', 'changes', 2), verdict('client', 'approved', 2), verdict('team', 'withdrawn', 2, later(9))];
  assert.equal(verdictOn(h, 'team', 1)?.status, 'approved');
  assert.equal(verdictOn(h, 'team', 2), null, 'withdrawn');
  assert.equal(verdictOn(h, 'client', 2)?.status, 'approved');
  assert.equal(approvalsOf({ approval: { status: 'approved', v: 1, by: 'x', at: T, note: null }, approvals: h }), h, 'the history wins once it exists');
});
