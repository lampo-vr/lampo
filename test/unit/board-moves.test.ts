// Moving cards on the board (web/src/library/moves.ts, moveSteps.ts): which lane a video may go to and for whom, which
// of the existing writes a move sends, what it asks first, where the video lands (worked out with lib/stage.ts from the
// library's summary), and how a move made while another waits behind its Undo toast goes to the server. Pure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { type Action, ROLE_ACTIONS } from '../../lib/permissions.ts';
import { stageOf } from '../../lib/stage.ts';
import type { ApprovalEntry, Comment, Review, Role, ShareSignal } from '../../lib/types.ts';
import type { VideoSummary } from '../../web/src/api/types.ts';
import { laneOf } from '../../web/src/library/model.ts';
import { compose, dropWords } from '../../web/src/library/moveSteps.ts';
import { movesOf, nextMove, planMove, type Step, stageAfter } from '../../web/src/library/moves.ts';

type R = Parameters<typeof stageOf>[0];
const T = '2026-09-28T10:00:00+02:00';
const NOW = Date.parse('2026-09-28T12:00:00+02:00');

const review = (o: Partial<Review> & { v?: number } = {}): R => ({
  versions: Array.from({ length: o.v ?? 1 }, (_, i) => ({ v: i + 1 }) as Review['versions'][number]),
  comments: o.comments ?? [],
  approval: null,
  approvals: o.approvals ?? [],
  final: o.final ?? null,
  agent_status: o.agent_status,
  session: o.session ?? null,
});
const note = (o: Partial<Comment> = {}): Comment =>
  ({ id: 'c', v: 1, frame: 0, severity: 'must', status: 'open', author: 'alex', replies: [], ...o }) as Comment;
const verdict = (party: ApprovalEntry['party'], status: ApprovalEntry['status'], v: number): ApprovalEntry => ({
  party,
  status,
  v,
  by: party === 'client' ? 'guest:Mia' : 'alex',
  at: T,
  note: null,
});
const opened: ShareSignal = { label: 'Client link', kind: 'video', opened: true, opens: 1, last_opened: T, seen_v: 1, by: 'Mia', reviewers: ['Mia'] };

/** A library entry as the server builds it (server/helpers.ts summary) from a review. */
function video(r: R, o: { share?: ShareSignal; archived?: boolean; sessionActive?: boolean } = {}): VideoSummary {
  const must = r.comments.filter((c) => c.status === 'open' && c.severity === 'must' && !c.kind).length;
  return {
    slug: 'spot',
    name: 'spot.mp4',
    stage: stageOf(r, { linked: !!o.share, share: o.share, now: NOW, sessionActive: o.sessionActive }),
    counts: { must },
    agent_status: r.agent_status ?? null,
    session: r.session,
    sessionActive: o.sessionActive ?? null,
    archived: o.archived ? T : null,
  } as unknown as VideoSummary;
}

const roleCan = (role: Role) => (a: Action) => ROLE_ACTIONS[role].has(a);
const owner = roleCan('owner');
const reviewer = roleCan('reviewer');
const kinds = (s: Step[] | undefined) => s?.map((x) => `${x.kind} V${x.v}`).join(', ') ?? 'no move';
const plan = (v: VideoSummary, to: Parameters<typeof planMove>[1], can = owner) => planMove(v, to, can, { by: 'Sam', now: NOW });

const toReview = video(review({ v: 3 }));
const musts = video(review({ v: 2, comments: [note(), note({ id: 'c2' }), note({ id: 'c3', severity: 'should' })] }));
const teamChanges = video(review({ v: 2, approvals: [verdict('team', 'changes', 2)] }));
const approved = video(review({ v: 4, approvals: [verdict('team', 'approved', 4)] }));
const approvedOverNotes = video(review({ v: 4, comments: [note({ severity: 'should' })], approvals: [verdict('team', 'approved', 4)] }));
const withClient = video(review({ v: 2, approvals: [verdict('team', 'approved', 2)] }), { share: opened });
const clientApproved = video(review({ v: 2, approvals: [verdict('team', 'approved', 2), verdict('client', 'approved', 2)] }));
const clientChanges = video(review({ v: 2, approvals: [verdict('client', 'changes', 2)] }));
const final = video(review({ v: 5, approvals: [verdict('team', 'approved', 5)], final: { v: 5, by: 'alex', at: T, note: null } }));
const superseded = video(review({ v: 6, approvals: [verdict('team', 'approved', 5)], final: { v: 5, by: 'alex', at: T, note: null } }));
const onPreview = video(
  review({ v: 3, comments: [note({ status: 'verified', verified_on: { v: 3, preview: 'p_1' } })], approvals: [verdict('team', 'approved', 3)] }),
);

test('the library entry stands for its review: the stage worked out from it is the server’s', () => {
  const reviews: [string, R, Parameters<typeof video>[1]?][] = [
    ['fresh', review()],
    ['musts open', review({ v: 2, comments: [note(), note({ id: 'c2', severity: 'should' })] })],
    ['fixes to check', review({ v: 2, comments: [note({ status: 'fixed' })] })],
    ['a question', review({ comments: [note({ kind: 'question' })] })],
    ['an agent on it', review({ comments: [note()], agent_status: { text: 'rendering v2', by: 'agent:edit', at: T } })],
    ['team approved, shared', review({ v: 2, approvals: [verdict('team', 'approved', 2)] }), { share: { ...opened, opened: false, opens: 0, seen_v: null } }],
    ['with the client', review({ v: 2, approvals: [verdict('team', 'approved', 2)] }), { share: opened }],
    ['client approved', review({ approvals: [verdict('client', 'approved', 1)] })],
    ['client wants changes', review({ approvals: [verdict('team', 'approved', 1), verdict('client', 'changes', 1)] })],
    ['older approval', review({ v: 3, approvals: [verdict('team', 'approved', 2)] })],
    ['final', review({ v: 2, final: { v: 2, by: 'alex', at: T, note: null } })],
    ['final, newer render', review({ v: 3, final: { v: 2, by: 'alex', at: T, note: null } })],
    ['fixes only on a preview', review({ v: 3, comments: [note({ status: 'verified', verified_on: { v: 3, preview: 'p_1' } })] })],
  ];
  for (const [name, r, o] of reviews) {
    const v = video(r, o);
    const again = stageAfter(v, [], { now: NOW });
    assert.equal(again.stage, v.stage.stage, `${name}: ${again.stage}`);
    assert.equal(again.next.kind, v.stage.next.kind, `${name}: next ${again.next.kind}`);
    assert.equal(again.detail, v.stage.detail, `${name}: detail`);
  }
});

test('→ Approved: the team approves the newest version; over open must-fix notes it asks first', () => {
  const m = plan(toReview, 'approved');
  assert.equal(kinds(m?.steps), 'approve V3');
  assert.equal(m?.confirm, null, 'nothing to ask');
  assert.equal(m?.stage.stage, 'team_approved');
  const anyway = plan(musts, 'approved');
  assert.equal(kinds(anyway?.steps), 'approve V2');
  assert.equal(anyway?.confirm, 'musts');
  assert.equal(anyway?.musts, 2, 'the must-fix notes, not the should one');
  assert.equal(kinds(plan(teamChanges, 'approved')?.steps), 'approve V2', 'the team changes its mind');
  // the client asked for changes on this version: the client's word beats the team's, the card would stay where it is
  assert.equal(plan(clientChanges, 'approved'), null);
  // opened by the client through a link: approving lands it with the client
  const shared = video(review({ v: 2 }), { share: opened });
  assert.equal(plan(shared, 'approved')?.stage.stage, 'with_client');
});

test('→ Being fixed: the team requests changes; with nothing open it asks for a sentence for the agent', () => {
  const m = plan(toReview, 'fixing');
  assert.equal(kinds(m?.steps), 'changes V3');
  assert.equal(m?.note, true, 'nothing open: the agent needs words');
  assert.equal(m?.stage.stage, 'changes');
  const notes = plan(approvedOverNotes, 'fixing');
  assert.equal(kinds(notes?.steps), 'changes V4');
  assert.equal(notes?.note, false, 'the open note is the agent’s work');
  // an agent at work: the card lands in progress, still the same lane
  const working = video(review({ v: 2, session: { name: 'edit', id: 's', cwd: null, assigned: T, by: 'alex' } }), { sessionActive: true });
  assert.equal(plan(working, 'fixing')?.stage.stage, 'in_progress');
  assert.equal(plan(clientApproved, 'fixing'), null, 'the client approved it: the team’s change request would not move it');
  assert.equal(plan(withClient, 'fixing')?.stage.stage, 'changes', 'the client opened it but has not decided');
});

test('→ To review: the team’s word is withdrawn, only where that puts it back to review', () => {
  assert.equal(kinds(plan(approved, 'needs_you')?.steps), 'withdraw V4');
  assert.equal(plan(approved, 'needs_you')?.stage.stage, 'to_review');
  assert.equal(kinds(plan(teamChanges, 'needs_you')?.steps), 'withdraw V2');
  assert.equal(plan(musts, 'needs_you'), null, 'open notes keep it being fixed');
  assert.equal(plan(approvedOverNotes, 'needs_you'), null, 'withdrawn, its open note would put it in Being fixed');
  assert.equal(plan(clientApproved, 'needs_you'), null, 'the client’s approval stands');
  assert.equal(plan(clientChanges, 'needs_you'), null, 'the client’s change request stands');
});

test('→ Final: only from Approved, behind a confirm, never with a fix only on a preview', () => {
  for (const v of [approved, withClient, clientApproved]) {
    const m = plan(v, 'final');
    assert.equal(kinds(m?.steps), `final V${v.stage.v}`);
    assert.equal(m?.confirm, 'final');
    assert.equal(m?.stage.stage, 'final');
  }
  assert.equal(plan(approvedOverNotes, 'final')?.open, 1, 'the confirm names the open note');
  assert.equal(plan(toReview, 'final'), null, 'the player offers it only once approved');
  assert.equal(plan(musts, 'final'), null);
  assert.equal(plan(onPreview, 'final'), null, 'a fix that exists only in the project can’t ship');
});

test('out of Final: reopened first, behind a confirm', () => {
  const back = plan(final, 'needs_you');
  assert.equal(kinds(back?.steps), 'reopen V5, withdraw V5', 'not final, and the approval withdrawn');
  assert.equal(back?.confirm, 'reopen');
  assert.equal(back?.stage.stage, 'to_review');
  assert.equal(kinds(plan(final, 'approved')?.steps), 'reopen V5', 'the approval stands');
  const fix = plan(final, 'fixing');
  assert.equal(kinds(fix?.steps), 'reopen V5, changes V5');
  assert.equal(fix?.note, true);
  // a newer render arrived since: reopening alone puts it back to review; approving it is the newest version's
  assert.equal(kinds(plan(superseded, 'needs_you')?.steps), 'reopen V5');
  assert.equal(kinds(plan(superseded, 'approved')?.steps), 'reopen V5, approve V6');
});

test('only what the role may do, and nothing for an archived video', () => {
  assert.equal(kinds(plan(approved, 'needs_you', reviewer)?.steps), 'withdraw V4', 'reviewers approve and withdraw');
  assert.equal(plan(approved, 'final', reviewer), null, 'marking final is the finalize action');
  assert.equal(movesOf(final, reviewer).length, 0, 'reopening too');
  assert.deepEqual(
    movesOf(toReview, owner).map((m) => m.to),
    ['fixing', 'approved'],
  );
  assert.equal(movesOf(video(review(), { archived: true }), owner).length, 0);
  assert.equal(plan(toReview, 'needs_you'), null, 'its own lane is no move');
});

test('⌥← / ⌥→: the nearest lane it may go to on that side', () => {
  assert.equal(nextMove(toReview, 1, owner)?.to, 'fixing');
  assert.equal(nextMove(toReview, -1, owner), null);
  assert.equal(nextMove(approved, 1, owner)?.to, 'final');
  assert.equal(nextMove(approved, -1, owner)?.to, 'fixing');
  // a reviewer can't mark final: right of Approved there is nothing for them
  assert.equal(nextMove(approved, 1, reviewer), null);
  // open notes: To review is not a place for it, Approved (over them) is
  assert.equal(nextMove(musts, -1, owner), null);
  assert.equal(nextMove(musts, 1, owner)?.to, 'approved');
  assert.equal(laneOf(final.stage.stage), 'final');
  assert.equal(nextMove(final, -1, owner)?.to, 'approved');
});

test('a move made while another waits for its toast: the writes as they reach the server', () => {
  const approve: Step = { kind: 'approve', v: 3 };
  const withdraw: Step = { kind: 'withdraw', v: 3 };
  assert.deepEqual(compose(toReview, [approve, withdraw]), [], 'dragged to Approved and back: nothing to send');
  assert.deepEqual(
    compose(toReview, [approve, { kind: 'changes', v: 3, note: 'Logo later' }]),
    [{ kind: 'changes', v: 3, note: 'Logo later' }],
    'the last word',
  );
  assert.deepEqual(
    compose(approved, [
      { kind: 'final', v: 4 },
      { kind: 'reopen', v: 4 },
    ]),
    [],
    'final and reopened again',
  );
  assert.deepEqual(
    compose(final, [
      { kind: 'reopen', v: 5 },
      { kind: 'final', v: 5 },
    ]),
    [],
    'reopened and final again',
  );
  assert.deepEqual(compose(toReview, [approve, { kind: 'final', v: 3 }]), [approve, { kind: 'final', v: 3 }], 'approved, then final');
  assert.deepEqual(
    compose(final, [
      { kind: 'reopen', v: 5 },
      { kind: 'withdraw', v: 5 },
      { kind: 'approve', v: 5 },
    ]),
    [{ kind: 'reopen', v: 5 }],
    'the approval it had is back: only the reopening goes',
  );
  assert.deepEqual(compose(teamChanges, [{ kind: 'changes', v: 2 }]), [], 'the change request it has');
  assert.deepEqual(compose(teamChanges, [{ kind: 'changes', v: 2, note: 'and the end card' }]).length, 1, 'with new words it is a new request');
  // where the composed writes put it, from where it stood
  assert.equal(stageAfter(toReview, compose(toReview, [approve, { kind: 'final', v: 3 }]), { now: NOW }).stage, 'final');
});

test('what dropping does, said where the card would land', () => {
  const words = (v: VideoSummary, to: Parameters<typeof planMove>[1]) => {
    const m = plan(v, to);
    assert.ok(m, `${to}: a move`);
    return dropWords(m);
  };
  assert.equal(words(toReview, 'approved'), 'Drop to approve V3');
  assert.equal(words(toReview, 'fixing'), 'Drop to request changes on V3');
  assert.equal(words(approved, 'final'), 'Drop to mark V4 final');
  assert.equal(words(approved, 'needs_you'), 'Drop to withdraw the approval of V4');
  assert.equal(words(teamChanges, 'needs_you'), 'Drop to withdraw the change request on V2');
  assert.equal(words(final, 'approved'), 'Drop to reopen V5');
  assert.equal(words(final, 'needs_you'), 'Drop to reopen for review');
  assert.equal(words(superseded, 'approved'), 'Drop to reopen and approve V6');
  assert.equal(words(final, 'fixing'), 'Drop to reopen and request changes');
});
