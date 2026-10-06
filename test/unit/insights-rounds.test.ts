// Why so many rounds (lib/insightsRounds.ts): versions to approval, what caused each round (the notes since the version
// before, by topic), what came back as still wrong (by topic and agent), how long a round took and whom it waited on,
// and all agents' fixes right the first time — each with the period before. Plain review objects, "now" pinned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, Reply, Review, Version } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { topicsOf, roundsOf, causesOf, stillWrongOf, toApprovalOf, turnaroundOf, firstTimeOf, TARGET_VERSIONS, MIN_APPROVALS, MIN_ROUNDS, UNTAGGED } =
  await import('../../lib/insightsRounds.ts');
const { roundWaitsOf } = await import('../../lib/insightsFlow.ts');
const { insights, lastActivity } = await import('../../lib/insights.ts');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const reply = (status: Reply['status'], hoursAgo: number, by = 'agent:edit', text = ''): Reply => ({ by, status, text, at: at(hoursAgo) }) as Reply;

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
/** Versions arriving `hoursAgo` each (a `part` one is a partial render of the version before). */
const versions = (...hours: (number | { part: number })[]): Version[] =>
  hours.map((h, i) =>
    typeof h === 'number'
      ? ({ v: i + 1, hash: `h${i}`, registered: at(h) } as Version)
      : ({ v: i + 1, hash: `h${i}`, registered: at(h.part), part: { of: i, at: 0, frames: 10 } } as unknown as Version),
  );
function review(name: string, o: Partial<Review> = {}): Review {
  return {
    video: `/renders/${name}.mp4`,
    project: 'Acme',
    folder: 'Acme',
    added: at(200),
    versions: versions(200),
    comments: [],
    ...o,
  } as unknown as Review;
}

test("a note's topics: its tags (never a kind of note), else what its words suggest", () => {
  assert.deepEqual(topicsOf({ tags: ['sfx', 'idea'], text: 'the whoosh is late' }), ['sfx']);
  assert.deepEqual(topicsOf({ tags: [], text: 'The whoosh is too loud' }), ['sfx'], 'untagged: the words say it');
  assert.deepEqual(topicsOf({ tags: ['love-it'], text: 'perfect, keep this' }), [], 'love-it is a kind, not a topic');
  assert.deepEqual(topicsOf({ tags: [], text: 'hm' }), []);
});

test('rounds: each full version after the first, in the period, with the notes since the version before and those reopened meanwhile', () => {
  const n1 = note({ created: at(95), tags: ['timing'], replies: [reply('fixed', 85)] });
  const reopened = note({ created: at(95), tags: ['sfx'], replies: [reply('fixed', 85), reply('open', 75, 'tester')] });
  const n2 = note({ created: at(70), tags: ['color/grade'] });
  const question = note({ created: at(72), author: 'agent:edit', kind: 'question' } as Partial<Comment> & { created: string });
  // V1 100 h ago · V2 80 h · a partial render 60 h (a quick check, no round) · V4 50 h
  const r = review('spot', { versions: versions(100, 80, { part: 60 }, 50), comments: [n1, reopened, n2, question] });
  const rounds = roundsOf(r, NOW - 1000 * H, NOW);
  assert.deepEqual(
    rounds.map((x) => x.v),
    [2, 4],
    'two rounds: the partial render is none',
  );
  assert.deepEqual(
    rounds[0]?.notes.map((c) => c.id),
    [n1.id, reopened.id],
    'V2 followed the notes written on V1',
  );
  assert.deepEqual(rounds[1]?.notes.map((c) => c.id).sort(), [reopened.id, n2.id].sort(), 'V4: the note reopened on V2 and the new one; no question');
  assert.ok(rounds[1]?.back.has(reopened));
  const sfx = causesOf([r], NOW - 1000 * H, NOW).topics.find((t) => t.tag === 'sfx');
  assert.deepEqual([sfx?.rounds, sfx?.notes, sfx?.back], [2, 1, 1], 'one note behind two rounds, the second time as still wrong');
  assert.deepEqual(
    roundsOf(r, NOW - 55 * H, NOW).map((x) => x.v),
    [4],
    'only rounds that ended in the period',
  );
});

test('what caused the rounds: per topic the rounds whose notes raised it (a round counts for each of its topics), the worst severity, untagged and note-less rounds', () => {
  const a = review('a', {
    versions: versions(100, 90, 80, 70),
    comments: [
      // round V2: sfx (must) + timing
      note({ created: at(95), tags: ['sfx'], severity: 'must', text: 'The whoosh lands early' }),
      note({ created: at(94), tags: ['timing'] }),
      // round V3: sfx again
      note({ created: at(85), tags: ['sfx'], text: 'The click is too loud' }),
      // round V4: a note without a topic, nice to have
      note({ created: at(75), tags: [], severity: 'nice', text: 'hm, not sure' }),
    ],
  });
  // a round without notes (the agent sent a new version on its own)
  const b = review('b', { folder: 'Northwind', versions: versions(100, 60), comments: [] });
  const c = causesOf([a, b], NOW - 1000 * H, NOW, (scope) => (scope === 'Acme' ? '- Timing: hold the end card 2 s' : ''));
  assert.equal(c.rounds, 4);
  assert.equal(c.withNotes, 3);
  assert.equal(c.untagged, 1);
  assert.deepEqual(c.severity, { must: 1, should: 1, nice: 1, idea: 0 });
  assert.deepEqual(
    c.topics.map((t) => [t.tag, t.rounds, t.share, t.notes, t.must]),
    [
      ['sfx', 2, 0.67, 2, 1],
      ['timing', 1, 0.33, 1, 0],
    ],
  );
  const sfx = c.topics[0];
  assert.equal(sfx?.scope, 'Acme', 'all its rounds in one project: that playbook');
  assert.equal(sfx?.covered, false);
  assert.equal(c.topics[1]?.covered, true, 'a rule there says it already');
  assert.deepEqual(
    sfx?.examples.map((x) => x.text),
    ['The click is too loud', 'The whoosh lands early'],
    'newest first',
  );
  assert.equal(c.minRounds, MIN_ROUNDS);
  assert.equal(c.before, null, 'all time has no period before');
});

test('what caused the rounds, against the period before; topics across projects go to the House playbook', () => {
  const old = review('old', {
    folder: 'Acme',
    versions: versions(40 * 24, 39 * 24),
    comments: [note({ created: at(39.5 * 24), tags: ['timing'] })],
  });
  const one = review('one', { folder: 'Acme', versions: versions(100, 90), comments: [note({ created: at(95), tags: ['sfx'] })] });
  const two = review('two', { folder: 'Northwind', versions: versions(100, 90), comments: [note({ created: at(95), tags: ['sfx'] })] });
  const c = causesOf([old, one, two], NOW - 30 * D, NOW, () => '', 30 * D);
  assert.equal(c.topics[0]?.tag, 'sfx');
  assert.equal(c.topics[0]?.scope, '', 'two projects: the House');
  assert.deepEqual(c.before, { rounds: 1, withNotes: 1, top: { tag: 'timing', rounds: 1, share: 1 } });
});

test('what came back: fixes reopened as still wrong, by topic with its agents and by agent with its topics, the newest note and why', () => {
  const x = note({
    created: at(90),
    tags: ['timing'],
    text: 'Hold the end card',
    replies: [reply('fixed', 80, 'agent:launch-edit'), reply('open', 70, 'tester', 'Still a beat short'), reply('fixed', 60, 'agent:launch-edit')],
  });
  const y = note({
    created: at(90),
    tags: ['timing', 'sfx'],
    replies: [reply('fixed', 50, 'agent:codex-cuts'), reply('open', 40, 'tester'), reply('fixed', 30, 'agent:codex-cuts'), reply('open', 20, 'tester')],
  });
  const z = note({ created: at(90), tags: [], text: 'hm', replies: [reply('fixed', 50, 'agent:launch-edit'), reply('verified', 40, 'tester')] });
  const r = review('spot', { comments: [x, y, z] });
  const s = stillWrongOf([r], NOW - 1000 * H, NOW, new Map([['launch-edit', 'claude-code' as const]]));
  assert.equal(s.count, 3, 'three reopenings (one note came back twice)');
  assert.equal(s.fixes, 5);
  assert.deepEqual(
    s.topics.map((t) => [t.tag, t.n, t.agents.map((a) => `${a.name}×${a.n}`).join(' ')]),
    [
      ['timing', 3, 'codex-cuts×2 launch-edit×1'],
      ['sfx', 2, 'codex-cuts×2'],
    ],
  );
  assert.deepEqual(
    s.agents.map((a) => [a.name, a.kind ?? null, a.n, a.topics.map((t) => t.tag).join()]),
    [
      ['codex-cuts', null, 2, 'sfx,timing'],
      ['launch-edit', 'claude-code', 1, 'timing'],
    ],
  );
  assert.equal(s.agents[1]?.example?.reason, 'Still a beat short', 'what the person said when they reopened it');
  assert.equal(s.topics[0]?.example?.id, y.id, 'the newest reopening');
  // an untagged note that came back goes under "untagged" unless its words suggest a topic
  const u = note({ created: at(90), text: 'hm', replies: [reply('fixed', 50), reply('open', 40, 'tester')] });
  assert.deepEqual(
    stillWrongOf([review('u', { comments: [u] })], NOW - 1000 * H, NOW).topics.map((t) => t.tag),
    [UNTAGGED],
  );
});

test('versions to approval: mean and median of the period, a partial render no version, per project, open videos, the period before', () => {
  const approved = (name: string, folder: string, hours: (number | { part: number })[], approvedAgo: number) => {
    const r = review(name, { folder, versions: versions(...hours) });
    return [r, { v: r.versions.length, at: at(approvedAgo) }] as const;
  };
  const list = [
    approved('a', 'Acme', [100, 90, 80, 70, 60, 50, 40, 30, 20], 10), // 9
    approved('b', 'Acme', [100, 90, 80, 70, 60], 10), // 5
    approved('c', 'Northwind', [100, 90, { part: 85 }, 80], 10), // 3 (the part is no version)
    approved('old', 'Northwind', [40 * 24, 39 * 24], 38 * 24), // in the period before
  ] as const;
  const open = review('open', { folder: 'Globex', versions: versions(100, 50, 5) });
  const quiet = review('quiet', { folder: 'Globex', versions: versions(60 * 24), added: at(60 * 24) });
  const reviews = [...list.map(([r]) => r), open, quiet];
  const approvals = new Map<Review, { v: number; at: string } | null>([...list.map(([r, a]) => [r, a] as const), [open, null], [quiet, null]]);
  const x = toApprovalOf(reviews, approvals, NOW - 30 * D, NOW, lastActivity, 30 * D);
  assert.deepEqual([x.mean, x.median, x.n], [5.7, 5, 3]);
  assert.deepEqual(x.before, { mean: 2, median: 2, n: 1 });
  assert.equal(x.target, TARGET_VERSIONS);
  assert.equal(x.minApprovals, MIN_APPROVALS);
  assert.deepEqual(
    x.projects.map((p) => [p.project, p.mean, p.n, p.open, p.openMean]),
    [
      ['Acme', 7, 2, 0, null],
      ['Northwind', 3, 1, 0, null],
      ['Globex', null, 0, 1, 3],
    ],
    'the most versions first (approved before open ones at the same); a project with only open videos by the version they are on',
  );
  assert.deepEqual(x.open, { videos: 1, mean: 3 }, 'a video that did not move in the period is not open work');
});

test('a round took from one version to the next, and waited on you to write notes, on the agent to fix them', () => {
  // V1 100 h ago; a note 90 h (10 h on you); the agent's fix with V2 80 h (10 h on agents); checked 79 h (1 h on you)
  // and a note 70 h (9 h more); its fix with V3 60 h (10 h on agents).
  const n1 = note({ created: at(90), status: 'verified', replies: [reply('fixed', 80), reply('verified', 79, 'tester')] });
  const n2 = note({ created: at(70), status: 'fixed', replies: [reply('fixed', 60)] });
  const r = review('spot', { versions: versions(100, 80, 60), comments: [n1, n2], session: { name: 'edit' } as Review['session'] });
  const w = roundWaitsOf(r, r.video, NOW - 1000 * H, NOW);
  assert.deepEqual(
    w.map((x) => [x.total, x.hours.you, x.hours.agents, x.hours.client]),
    [
      [20, 10, 10, 0],
      [20, 10, 10, 0],
    ],
  );
  const t = turnaroundOf([{ r, slug: r.video }], NOW - 1000 * H, NOW);
  assert.deepEqual([t.rounds, t.median, t.parties.you, t.parties.agents, t.parties.client], [2, 20, 10, 10, 0]);
  assert.deepEqual(t.share, { you: 0.5, agents: 0.5, client: 0 });
  assert.equal(t.before, null);
});

test('right the first time across agents, and the period before', () => {
  const a = { name: 'a', fixes: 5, checked: 4, right: 3, rate: 0.75, fixHours: 1, questions: 0, wrongTopics: [] };
  const b = { name: 'b', fixes: 2, checked: 2, right: 1, rate: 0.5, fixHours: 1, questions: 0, wrongTopics: [] };
  assert.deepEqual(firstTimeOf([a, b], [b]), { checked: 6, right: 4, rate: 0.67, before: { checked: 2, right: 1, rate: 0.5 } });
  assert.deepEqual(firstTimeOf([]), { checked: 0, right: 0, rate: null, before: null });
});

test('the board carries why so many rounds, each with the period before; an empty store says nothing', () => {
  const n = note({ created: at(95), tags: ['sfx'], severity: 'must', replies: [reply('fixed', 92, 'agent:edit'), reply('verified', 91, 'tester')] });
  const r = review('spot', {
    versions: versions(100, 90),
    comments: [n],
    approvals: [{ party: 'team', status: 'approved', v: 2, by: 'tester', at: at(80), note: null }],
    approval: { status: 'approved', v: 2, by: 'tester', at: at(80), note: null },
    session: { name: 'edit', assigned: at(100) } as Review['session'],
  });
  const b = insights([r], { now: NOW, period: '30d' }).board;
  assert.deepEqual([b?.toApproval?.mean, b?.toApproval?.n, b?.toApproval?.before?.n], [2, 1, 0]);
  assert.deepEqual([b?.causes?.rounds, b?.causes?.topics[0]?.tag, b?.causes?.before?.rounds], [1, 'sfx', 0]);
  assert.deepEqual([b?.turnaround?.rounds, b?.turnaround?.median], [1, 10]);
  assert.deepEqual([b?.firstTime?.checked, b?.firstTime?.right, b?.firstTime?.before?.checked], [1, 1, 0]);
  assert.deepEqual([b?.stillWrong?.count, b?.stillWrong?.fixes], [0, 1]);
  assert.equal(b?.flow?.rounds.value, 2, 'the older answers stay for API users');
  const empty = insights([], { now: NOW, period: 'all' }).board;
  assert.deepEqual(
    [empty?.toApproval?.mean, empty?.toApproval?.n, empty?.causes?.rounds, empty?.turnaround?.median, empty?.firstTime?.rate, empty?.stillWrong?.count],
    [null, 0, 0, null, null, 0],
  );
  assert.equal(empty?.causes?.before, null, 'all time: no period before');
});
