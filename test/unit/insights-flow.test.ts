// Where the loop's time goes (a video's history replayed: whom its stage waited on between the moments something
// happened), how each agent's fixes hold up (right the first time, time to fix, what came back), and what keeps
// coming back across videos (with the playbook a rule would go into). Plain review objects, "now" pinned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Reply, Review } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { waitsOf, waitingSince, flowOf, agentsOf, repeatsOf, asOf, partyOf } = await import('../../lib/insightsFlow.ts');
const { insights } = await import('../../lib/insights.ts');
const { stageOf } = await import('../../lib/stage.ts');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const H = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const reply = (status: Reply['status'], hoursAgo: number, by = 'agent:edit'): Reply => ({ by, status, text: '', at: at(hoursAgo) }) as Reply;

let ids = 0;
function note(o: Partial<Comment> & { created: string }): Comment {
  ids++;
  return {
    id: `c_${String(ids).padStart(6, '0')}`,
    v: 1,
    frame: 10 * ids,
    timecode: '00:00:01:00',
    t: 0,
    range: null,
    text: `note ${ids}`,
    tags: [],
    severity: 'should',
    drawing: [],
    shots: null,
    voice: null,
    status: 'open',
    author: 'tester',
    replies: [],
    ...o,
  } as Comment;
}
function review(name: string, o: Partial<Review> = {}): Review {
  return {
    video: `/renders/${name}.mp4`,
    project: 'Acme',
    folder: 'Acme',
    added: at(100),
    versions: [{ v: 1, hash: `${name}1`, registered: at(100) }],
    comments: [],
    ...o,
  } as unknown as Review;
}
const slug = (r: Review) => r.video;

test('whom a next step waits for: you, the agents, the client — or nobody once the work is approved', () => {
  assert.equal(partyOf('review'), 'you');
  assert.equal(partyOf('verify'), 'you');
  assert.equal(partyOf('fix'), 'agents');
  assert.equal(partyOf('wait_agent'), 'agents');
  assert.equal(partyOf('wait_client'), 'client');
  assert.equal(partyOf('send'), null, 'approved and not sent: nothing in the loop waits');
  assert.equal(partyOf('none'), null);
});

test('a video as it stood: notes, replies and verdicts that existed then, statuses as their replies had set them', () => {
  const c = note({ created: at(50), status: 'verified', replies: [reply('fixed', 40), reply('verified', 30, 'tester')] });
  const r = review('spot', { comments: [c] });
  assert.equal(asOf(r, NOW - 60 * H).comments.length, 0, 'before the note');
  assert.equal(asOf(r, NOW - 45 * H).comments[0]?.status, 'open');
  assert.equal(asOf(r, NOW - 35 * H).comments[0]?.status, 'fixed');
  assert.equal(asOf(r, NOW).comments[0]?.status, 'verified');
  assert.equal(stageOf(asOf(r, NOW - 35 * H)).stage, 'check_fixes');
});

test('where time goes: a note waits on the agent until the fix, the fix on you until the check, the approval on the client', () => {
  // 100 h ago: V1 to review (you). 90 h: a note (agents). 70 h: fixed (you, to check). 60 h: checked → to review
  // again (you). 50 h: approved with a review link covering it → the client. 20 h: the client approved → nobody.
  const c = note({ created: at(90), status: 'verified', replies: [reply('fixed', 70), reply('verified', 60, 'tester')] });
  const r = review('spot', {
    comments: [c],
    session: { name: 'edit' } as Review['session'],
    approvals: [
      { party: 'team', status: 'approved', v: 1, by: 'tester', at: at(50), note: null },
      { party: 'client', status: 'approved', v: 1, by: 'guest:Mia', at: at(20), note: null },
    ],
  });
  const links = [{ slug: slug(r), created: at(55) }];
  const w = waitsOf(r, slug(r), NOW - 200 * H, NOW, links);
  assert.equal(Math.round(w.you), 30, 'V1 to review 10 h, the fix to check 10 h, then to review again 10 h');
  assert.equal(Math.round(w.agents), 20);
  assert.equal(Math.round(w.client), 30);
  // only the period counts: the last 40 hours hold 20 h on the client and nothing after the client's approval
  const late = waitsOf(r, slug(r), NOW - 40 * H, NOW, links);
  assert.deepEqual([Math.round(late.you), Math.round(late.agents), Math.round(late.client)], [0, 0, 20]);
  // without a link, an approved video isn't waiting on anyone (sending it is up to you, not a wait in the loop)
  const unlinked = waitsOf(r, slug(r), NOW - 200 * H, NOW, []);
  assert.equal(Math.round(unlinked.client), 0);
});

test('all videos together: hours per party, and on average per video that waited on it', () => {
  const a = review('a', { comments: [note({ created: at(10) })], session: { name: 'edit' } as Review['session'] });
  const b = review('b', { comments: [note({ created: at(30) })], session: { name: 'edit' } as Review['session'] });
  const f = flowOf(
    [a, b].map((r) => ({ r, slug: slug(r) })),
    NOW - 40 * H,
    NOW,
  );
  // a: 30 h to review, 10 h on the agent; b: 10 h to review, 30 h on the agent
  assert.deepEqual(f.hours, { you: 40, agents: 40, client: 0 });
  assert.deepEqual(f.videos, { you: 2, agents: 2, client: 0 });
  assert.deepEqual(f.perVideo, { you: 20, agents: 20, client: null });
});

test('waiting since: when the party it waits on now took over', () => {
  const r = review('spot', {
    comments: [note({ created: at(30), status: 'fixed', replies: [reply('fixed', 12)] })],
    session: { name: 'edit' } as Review['session'],
  });
  const w = waitingSince(r, slug(r), NOW);
  assert.equal(w?.party, 'you');
  assert.equal(Math.round((NOW - (w?.since ?? 0)) / H), 12, 'the fix handed it to you 12 hours ago');
});

test('agents: fixes, right the first time, time to fix, questions, and what came back', () => {
  const good = note({ created: at(20), tags: ['timing'], status: 'verified', replies: [reply('fixed', 18), reply('verified', 10, 'tester')] });
  const bad = note({
    created: at(20),
    tags: ['logo'],
    status: 'verified',
    replies: [reply('fixed', 19), reply('open', 15, 'tester'), reply('fixed', 12), reply('verified', 5, 'tester')],
  });
  const other = note({ created: at(20), tags: ['logo'], status: 'fixed', replies: [reply('fixed', 16, 'agent:cut')] });
  const asked = note({ created: at(8), author: 'agent:edit', kind: 'question' });
  const r = review('spot', { comments: [good, bad, other, asked] });
  const [edit, cut] = agentsOf([r], NOW - 48 * H, NOW);
  assert.equal(edit?.name, 'edit');
  assert.equal(edit?.fixes, 3, 'every fix counts, the second try too');
  assert.deepEqual([edit?.checked, edit?.right, edit?.rate], [2, 1, 0.5], 'the note that came back was not right the first time');
  // fix times: 2 h, 1 h, and 3 h after the reopening
  assert.equal(edit?.fixHours, 2);
  assert.equal(edit?.questions, 1);
  assert.deepEqual(edit?.wrongTopics, [{ tag: 'logo', n: 1 }]);
  assert.equal(cut?.name, 'cut');
  assert.deepEqual([cut?.fixes, cut?.checked, cut?.rate], [1, 0, null], 'nothing checked yet: no rate');
  assert.equal(edit?.kind, undefined, 'no video and no connection says what kind of agent it is');
});

test("agents: each one's kind, from the video it is assigned to, else from an agent connected under its name", () => {
  const fixed = (by: string) => note({ created: at(20), status: 'fixed', replies: [reply('fixed', 18, by)] });
  const a = review('a', { comments: [fixed('agent:edit')], session: { name: 'edit', id: 'mcp-1', agent: 'codex' } as Review['session'] });
  // an assignment from before kinds were stored: a Claude Code session
  const b = review('b', { comments: [fixed('agent:cut')], session: { name: 'cut', id: 'abc' } as Review['session'] });
  const c = review('c', { comments: [fixed('agent:grade'), fixed('agent:stray')] });
  const list = agentsOf([a, b, c], NOW - 48 * H, NOW, new Map([['grade', 'cursor' as const]]));
  const kind = Object.fromEntries(list.map((x) => [x.name, x.kind]));
  assert.deepEqual(kind, { edit: 'codex', cut: 'claude-code', grade: 'cursor', stray: undefined });
});

test('repeats: a topic on three notes or more, the project it belongs to, and whether a rule says it already', () => {
  const tagged = (tag: string, h: number) => note({ created: at(h), tags: [tag] });
  const a = review('a', { folder: 'Acme/Reels', comments: [tagged('logo', 5), tagged('timing', 6)] });
  const b = review('b', { folder: 'Acme', comments: [tagged('logo', 7), tagged('timing', 8)] });
  const c = review('c', {
    folder: 'Globex',
    comments: [tagged('logo', 9), tagged('timing', 10), note({ created: at(11), tags: ['logo'], author: 'agent:edit' })],
  });
  const d = review('d', { folder: 'Acme', comments: [tagged('color', 5), tagged('color', 6), tagged('color', 7)] });
  const rules = (scope: string) => (scope === 'Acme' ? '- Keep the color grade warm' : '');
  const list = repeatsOf([a, b, c, d], NOW - 48 * H, NOW, rules);
  const by = Object.fromEntries(list.map((x) => [x.tag, x]));
  assert.equal(by.logo?.count, 3, "an agent's note isn't feedback someone keeps giving");
  assert.equal(by.logo?.videos, 3);
  assert.equal(by.logo?.scope, '', 'across projects: the House playbook');
  assert.equal(by.color?.scope, 'Acme', 'one project: its playbook');
  assert.equal(by.color?.covered, true, 'the rule is written already');
  assert.equal(by.logo?.covered, false);
  assert.equal(repeatsOf([a, b, c, d], NOW - 5.5 * H, NOW).length, 0, 'the period decides');
});

test('the board carries all four answers', () => {
  const r = review('spot', { comments: [note({ created: at(10) })], session: { name: 'edit' } as Review['session'] });
  const b = insights([r], { now: NOW, period: '7d', watching: () => ({ videos: [], people: [], unopened: [], viewers: 0, views: 0, secs: 0 }) }).board;
  assert.ok(b?.flow && b.agents && b.repeats && b.watching);
  assert.equal(b.flow.stuck[0]?.waitingOn, 'agents');
  assert.equal(Math.round(b.flow.stuck[0]?.hours ?? 0), 10);
  assert.ok(b.flow.stuck[0]?.label, "the stage's words say what it waits for");
});
