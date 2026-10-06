// The Insights page for one period: speed (four numbers, the period before, a sparkline), what needs a push now,
// what the notes are about (only when enough of them say), severity and projects. Built from plain review objects,
// with "now" pinned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment, InsightsBoard, InsightsPeriod, Reply, Review, StageInfo } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { insights, bucketsFor, MIN_POINTS, MIN_COVERAGE, QUIET_HOURS } = await import('../../lib/insights.ts');
const { stageOf } = await import('../../lib/stage.ts');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const at = (daysAgo: number, hoursLater = 0) => new Date(NOW - daysAgo * 86_400_000 + hoursLater * 3_600_000).toISOString();
const reply = (status: Reply['status'], when: string, by = 'agent:edit'): Reply => ({ by, status, text: '', at: when }) as Reply;

let ids = 0;
function note(o: Partial<Comment> & { created: string }): Comment {
  ids++;
  return {
    id: `c_${ids}`,
    v: 1,
    frame: 10 * ids,
    timecode: `00:00:0${ids % 10}:00`,
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
/** A note written `daysAgo`, fixed `fixH` hours later and checked `checkH` hours after that. */
const loop = (daysAgo: number, fixH: number, checkH: number, extra: Partial<Comment> = {}) =>
  note({
    created: at(daysAgo),
    status: 'verified',
    replies: [reply('fixed', at(daysAgo, fixH)), reply('verified', at(daysAgo, fixH + checkH), 'tester')],
    ...extra,
  });

function review(name: string, o: Partial<Review> = {}): Review {
  return {
    video: `/renders/${name}.mp4`,
    project: 'Acme',
    folder: 'Acme',
    added: at(200),
    versions: [{ v: 1, hash: `${name}1`, registered: at(200) }],
    comments: [],
    ...o,
  } as unknown as Review;
}
const board = (reviews: Review[], period: InsightsPeriod = '30d', stageFor?: (r: Review) => StageInfo) => {
  const b = insights(reviews, { now: NOW, period, stageFor }).board;
  assert.ok(b);
  return b;
};

test('the period decides every number: 7 days, 30, 90 and all time', () => {
  // fixes 3, 20 and 60 days ago, taking 2, 10 and 30 hours
  const comments = [loop(3, 2, 1), loop(20, 10, 1), loop(60, 30, 1)];
  const r = [review('spot', { comments })];
  const fix = (p: InsightsPeriod) => board(r, p).speed.fix;
  assert.deepEqual([fix('7d').value, fix('7d').n], [2, 1]);
  assert.deepEqual([fix('30d').value, fix('30d').n], [6, 2], 'median of 2 h and 10 h');
  assert.deepEqual([fix('90d').value, fix('90d').n], [10, 3]);
  assert.deepEqual([fix('all').value, fix('all').n], [10, 3]);
  assert.deepEqual(fix('30d').before, { value: 30, n: 1 }, 'the 30 days before: the fix 60 days ago');
  assert.equal(fix('all').before, null, 'all time has no period before');
  assert.equal(board(r, '30d').days, 30);
  assert.equal(board(r, 'all').days, null);
  assert.equal(board(r, 'all').from, at(60), 'all time starts at the first data');
  // Older, all-time numbers stay as the API had them.
  assert.equal(insights(r, { now: NOW }).turnaround.fixed, 3);
});

test('a trend only when both periods have enough data; lower is a negative change', () => {
  const now = Array.from({ length: MIN_POINTS }, (_, i) => loop(2 + i, 1, 1));
  const before = Array.from({ length: MIN_POINTS }, (_, i) => loop(32 + i, 2, 4));
  const fix = board([review('spot', { comments: [...now, ...before] })]).speed.fix;
  assert.deepEqual([fix.value, fix.before?.value, fix.change], [1, 2, -0.5], 'half the time: -50 %');
  const check = board([review('spot', { comments: [...now, ...before] })]).speed.check;
  assert.equal(check.change, -0.75);
  const few = board([review('spot', { comments: [...now, ...before.slice(1)] })]).speed.fix;
  assert.equal(few.change, null, `${MIN_POINTS - 1} before: no trend`);
  assert.equal(few.before?.n, MIN_POINTS - 1);
  assert.equal(board([review('spot', { comments: [...now, ...before] })]).minPoints, MIN_POINTS);
});

test('sparkline buckets: daily for a week, 3 days for 30, weekly for 90, at least weekly for all time', () => {
  assert.deepEqual(bucketsFor('7d', NOW, null), { bucketDays: 1, count: 7 });
  assert.deepEqual(bucketsFor('30d', NOW, null), { bucketDays: 3, count: 10 });
  assert.deepEqual(bucketsFor('90d', NOW, null), { bucketDays: 7, count: 13 });
  assert.deepEqual(bucketsFor('all', NOW, NOW - 20 * 86_400_000), { bucketDays: 7, count: 3 });
  assert.deepEqual(bucketsFor('all', NOW, NOW - 520 * 86_400_000), { bucketDays: 20, count: 26 }, 'never more than 26 buckets');
  // The board's buckets are whole days back from the viewer's next midnight until the period's start is covered: a
  // week from noon on 22 Sep (NOW is 29 Sep, noon UTC) is 22 Sep (from noon) … 29 Sep (until now) — 8 days.
  // Fixes half a day ago (4 h, on 29 Sep) and six and a half days ago (1 h, 3 h, on 23 Sep).
  const r = [review('spot', { comments: [loop(0.5, 4, 1), loop(6.5, 1, 1), loop(6.5, 3, 1)] })];
  const b = board(r, '7d');
  const spark = b.speed.fix.spark;
  assert.equal(spark.length, 8);
  assert.equal(b.sparkEnd, '2026-09-30T00:00:00.000Z', 'the last bucket ends at the next midnight');
  assert.deepEqual([spark[1], spark[7]], [2, 4], 'oldest first; the median per bucket');
  assert.deepEqual([spark[0], ...spark.slice(2, 7)], [null, null, null, null, null, null], 'no data: a gap, not a zero');
});

test('sparkline days are the viewer’s days (tz): a fix just after local midnight is that day’s', () => {
  // 28 Sep, 23:00 UTC is 29 Sep, 01:00 in UTC+2 (getTimezoneOffset() = -120)
  const late = note({ created: '2026-09-28T22:00:00.000Z', status: 'fixed', replies: [reply('fixed', '2026-09-28T23:00:00.000Z')] });
  const r = [review('spot', { comments: [late] })];
  const utc = insights(r, { now: NOW, period: '7d' }).board as InsightsBoard;
  const berlin = insights(r, { now: NOW, period: '7d', tz: -120 }).board as InsightsBoard;
  assert.equal(berlin.sparkEnd, '2026-09-29T22:00:00.000Z', 'midnight in UTC+2');
  const last = (xs: (number | null)[]) => xs.length - 1;
  assert.equal(utc.speed.fix.spark[last(utc.speed.fix.spark) - 1], 1, 'in UTC: 28 Sep');
  assert.equal(berlin.speed.fix.spark[last(berlin.speed.fix.spark)], 1, 'in UTC+2: 29 Sep, today');
});

test('renders until approval and fixes that came back, by when they happened', () => {
  const approvedNow = review('a', {
    versions: [1, 2, 3].map((v) => ({ v, hash: `a${v}`, registered: at(20 - v) })) as Review['versions'],
    approvals: [{ party: 'team', status: 'approved', v: 3, by: 'tester', at: at(3), note: null }],
  });
  const finalBefore = review('b', {
    versions: [1, 2].map((v) => ({ v, hash: `b${v}`, registered: at(50 - v) })) as Review['versions'],
    final: { v: 2, by: 'tester', at: at(40), note: null },
  });
  const back = note({
    created: at(5),
    status: 'verified',
    replies: [reply('fixed', at(5, 1)), reply('open', at(5, 2), 'tester'), reply('fixed', at(5, 3)), reply('verified', at(5, 4), 'tester')],
  });
  const clean = loop(4, 1, 1);
  const b = board([approvedNow, finalBefore, review('c', { comments: [back, clean] })]);
  assert.deepEqual([b.speed.renders.value, b.speed.renders.n, b.speed.renders.before?.value], [3, 1, 2]);
  assert.deepEqual([b.speed.cameBack.count, b.speed.cameBack.of, b.speed.cameBack.value], [1, 2, 0.5]);
});

test('needs attention: fixes to check, fixes that keep coming back, many renders, quiet — approved and final never', () => {
  const checkMe = review('check', {
    versions: [{ v: 1, hash: 'k1', registered: at(1) }] as Review['versions'],
    comments: [
      note({ created: at(1), frame: 40, status: 'fixed', replies: [reply('fixed', at(0.5))] }),
      note({ created: at(1), frame: 12, status: 'fixed', replies: [reply('fixed', at(0.5))] }),
    ],
  });
  const flaky = review('flaky', {
    versions: [{ v: 1, hash: 'f1', registered: at(1) }] as Review['versions'],
    comments: [0, 1].map(() =>
      note({ created: at(1), status: 'open', severity: 'must', replies: [reply('fixed', at(0.9)), reply('open', at(0.8), 'tester')] }),
    ),
  });
  const settled = review('settled', {
    versions: [{ v: 1, hash: 's1', registered: at(1) }] as Review['versions'],
    comments: [0, 1].map(() =>
      note({ created: at(1), status: 'verified', replies: [reply('fixed', at(0.9)), reply('open', at(0.8), 'tester'), reply('verified', at(0.7), 'tester')] }),
    ),
  });
  const rounds = review('rounds', {
    versions: [1, 2, 3, 4, 5].map((v) => ({ v, hash: `r${v}`, registered: at(1 - v / 10) })) as Review['versions'],
    session: { name: 'promo-edit', id: null, cwd: null, assigned: at(9), by: 'tester' },
    comments: [note({ v: 5, created: at(0.2), severity: 'must' })],
  });
  // five versions, three of them partial renders (quick checks of a few shots): two rounds, not five
  const quick = review('quick', {
    versions: [1, 2, 3, 4, 5].map((v) => ({
      v,
      hash: `p${v}`,
      registered: at(1 - v / 10),
      ...(v > 2 ? { part: { of: v - 1, at: 10, frames: 20, handles: 12 } } : {}),
    })) as Review['versions'],
    session: { name: 'promo-edit', id: null, cwd: null, assigned: at(9), by: 'tester' },
    comments: [note({ v: 5, created: at(0.2), severity: 'must' })],
  });
  const quiet = review('quiet', { versions: [{ v: 1, hash: 'q1', registered: at(5) }] as Review['versions'] });
  const busy = review('busy', { versions: [{ v: 1, hash: 'b1', registered: at(0.5) }] as Review['versions'] });
  // approved on V8 with four fixes that came back and are still open: history, not a problem now
  const approvedFlaky = review('approved', {
    versions: [{ v: 1, hash: 'p1', registered: at(9) }] as Review['versions'],
    approvals: [{ party: 'team', status: 'approved', v: 1, by: 'tester', at: at(8), note: null }],
    comments: [0, 1, 2, 3].map(() =>
      note({ created: at(9), status: 'open', severity: 'nice', replies: [reply('fixed', at(8.9)), reply('open', at(8.8), 'tester')] }),
    ),
  });
  const done = review('done', {
    versions: [{ v: 1, hash: 'd1', registered: at(30) }] as Review['versions'],
    final: { v: 1, by: 'tester', at: at(29), note: null },
  });

  const b = board([checkMe, flaky, settled, rounds, quick, quiet, busy, approvedFlaky, done]);
  const by = Object.fromEntries(b.attention.map((a) => [a.video, a]));
  assert.deepEqual(Object.keys(by).sort(), ['check.mp4', 'flaky.mp4', 'quiet.mp4', 'rounds.mp4']);
  assert.deepEqual([by['check.mp4'].reason, by['check.mp4'].count, by['check.mp4'].waitingOn], ['fixes', 2, 'you']);
  assert.equal(by['check.mp4'].verify, checkMe.comments[1].id, 'verify mode opens at the earliest fix');
  assert.equal(by['check.mp4'].hash, 'k1', 'the newest version for the poster');
  assert.deepEqual([by['flaky.mp4'].reason, by['flaky.mp4'].count, by['flaky.mp4'].waitingOn], ['reopened', 2, 'you'], 'no agent has it: yours to hand on');
  assert.deepEqual([by['rounds.mp4'].reason, by['rounds.mp4'].count, by['rounds.mp4'].waitingOn], ['rounds', 5, 'agents']);
  assert.deepEqual([by['rounds.mp4'].agent, by['check.mp4'].agent], ['promo-edit', null], 'the agent it is handed to, who can be nudged');
  assert.deepEqual([by['quiet.mp4'].reason, by['quiet.mp4'].waitingOn], ['waiting', 'you']);
  assert.ok(by['quiet.mp4'].waitingHours >= QUIET_HOURS);
  assert.equal(by['flaky.mp4'].verify, null);
  assert.deepEqual(
    b.attention.map((a) => a.video),
    ['check.mp4', 'flaky.mp4', 'quiet.mp4', 'rounds.mp4'],
    'you first, the most pressing reason first (fixes to check, fixes coming back, quiet), then agents',
  );
  assert.equal(b.attentionTotal, 4);
  assert.deepEqual(board([checkMe], 'all').attention, board([checkMe], '7d').attention, 'always now, whatever the period');
});

test('needs attention takes the stage from the caller (review links, sessions), like the board', () => {
  const r = review('shared', { versions: [{ v: 1, hash: 's1', registered: at(6) }] as Review['versions'] });
  assert.equal(board([r]).attention[0]?.reason, 'waiting', 'plain stage: to review, quiet for 6 days');
  const withClient = (x: Review): StageInfo => ({
    ...stageOf(x),
    stage: 'with_client',
    next: { kind: 'wait_client', label: "Waiting for the client's verdict" },
  });
  assert.deepEqual(board([r], '30d', withClient).attention, [], 'with the client (approved by the team): nothing to push');
});

test('topics only when enough notes carry one; kinds of note are no topic', () => {
  // A real reviewer's shape: 31 notes, 3 with a topic, two more marked only as idea / love-it
  const plain = Array.from({ length: 26 }, () => note({ created: at(2), text: 'Das Logo ist zu früh' }));
  const tagged = [note({ created: at(2), tags: ['cut'] }), note({ created: at(3), tags: ['timing'] }), note({ created: at(4), tags: ['idea', 'timing'] })];
  const kinds = [note({ created: at(2), tags: ['idea'] }), note({ created: at(2), tags: ['love-it'] })];
  const p = board([review('spot', { comments: [...plain, ...tagged, ...kinds] })]).patterns;
  assert.deepEqual([p.notes, p.tagged, p.minCoverage], [31, 3, MIN_COVERAGE]);
  assert.deepEqual(p.topics, [], '3 of 31 is no pattern');

  const few = Array.from({ length: 6 }, () => note({ created: at(2) }));
  const q = board([review('spot', { comments: [...few, ...tagged, ...kinds.slice(0, 1)] })]).patterns;
  assert.deepEqual([q.notes, q.tagged], [10, 3]);
  assert.deepEqual(
    q.topics.map((x) => [x.tag, x.n]),
    [
      ['timing', 2],
      ['cut', 1],
    ],
    '3 of 10 is a pattern; idea is no topic, a note with idea and timing counts for timing',
  );
});

test('topics: up to 3 real notes, newest first, different videos first, a note under its biggest topic only', () => {
  const a = review('spot', {
    comments: [
      note({ created: at(1), tags: ['timing'], text: 'Logo too early' }),
      note({ created: at(2), tags: ['timing', 'text/typo'], text: 'Title lands too early' }),
      note({ created: at(3), tags: ['timing'], text: '   ' }),
      note({ created: at(0.5), tags: ['timing'], text: 'Frage an dich', author: 'agent:edit', kind: 'question' }),
    ],
  });
  const b = review('teaser', { comments: [note({ created: at(6), tags: ['timing'], text: 'x'.repeat(400) })] });
  const topics = board([a, b]).patterns.topics;
  assert.deepEqual(
    topics.map((x) => [x.tag, x.n]),
    [
      ['timing', 4],
      ['text/typo', 1],
    ],
    'the agent question is no feedback',
  );
  const ex = topics[0].examples;
  assert.deepEqual(
    ex.map((e) => e.text.slice(0, 22)),
    ['Logo too early', 'x'.repeat(22), 'Title lands too early'],
    'blank notes never',
  );
  assert.ok(ex[1].text.length <= 280 && ex[1].text.endsWith('…'), 'long notes are cut');
  assert.deepEqual([ex[0].slug, ex[0].video], ['__renders__spot.mp4', 'spot.mp4']);
  assert.deepEqual(topics[1].examples, [], 'a note appears under its bigger topic only');
});

test('severity and projects count what happened in the period; open is always now', () => {
  const r = review('spot', {
    versions: [1, 2].map((v) => ({ v, hash: `s${v}`, registered: at(v === 1 ? 60 : 3) })) as Review['versions'],
    comments: [
      note({ created: at(2), severity: 'must' }),
      note({ created: at(2), severity: 'idea' }),
      note({ created: at(50), severity: 'must' }),
      note({ created: at(1), severity: 'should', author: 'agent:edit', kind: 'question' }),
    ],
  });
  const other = review('teaser', { folder: 'Studio', project: 'Studio' });
  const b = board([r, other]);
  assert.deepEqual(b.patterns.severity, { must: 1, should: 0, nice: 0, idea: 1 });
  assert.deepEqual(b.projects[0], { project: 'Acme', videos: 1, notes: 2, open: 2, renders: 1, approved: 0 });
  assert.deepEqual(b.projects[1], { project: 'Studio', videos: 1, notes: 0, open: 0, renders: 0, approved: 0 });
  assert.equal(board([r, other], 'all').projects[0].notes, 3);
});

test('an empty store: no numbers, nothing waits, no topics', () => {
  const b = board([review('fresh', { versions: [{ v: 1, hash: 'f1', registered: at(0.1) }] as Review['versions'] })]);
  assert.deepEqual([b.speed.fix.value, b.speed.fix.n, b.speed.fix.change], [null, 0, null]);
  assert.deepEqual([b.speed.cameBack.count, b.speed.cameBack.of, b.speed.cameBack.value], [0, 0, null]);
  assert.deepEqual(b.attention, []);
  assert.deepEqual([b.patterns.notes, b.patterns.topics], [0, []]);
  assert.equal(board([], 'all').from, null);
});
