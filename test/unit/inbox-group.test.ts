// How the inbox reads (web/src/inbox/group.ts): by video — one group per video, the most urgent video first, then
// the one that moved last; inside, questions → fixes → to review → what informs — or by kind; what "Done" does to
// each kind; when "Later" ends; and how long videos fold in the bell's popover.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForYouItem, ForYouKind } from '../../lib/types.ts';
import { aside, doneOf, folded, groupByKind, groupByVideo, laterUntil, orderedBy, tallyOf } from '../../web/src/inbox/group.ts';

let n = 0;
const item = (kind: ForYouKind, slug: string, at: string, more: Partial<ForYouItem> = {}): ForYouItem => ({
  key: `${kind}:${++n}`,
  kind,
  at,
  slug,
  video: `${slug}.mp4`,
  folder: 'Acme/Spring',
  dismissible: !['question', 'verify', 'review', 'playbook'].includes(kind),
  ...more,
});

const T = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
const items = [
  item('version', 'a', T(9), { v: 3 }),
  item('question', 'b', T(8)),
  item('client', 'a', T(10)),
  item('verify', 'a', T(7), { v: 3 }),
  item('answer', 'c', T(11)),
  item('verify', 'b', T(6), { v: 2 }),
  item('question', 'b', T(5)),
  item('review', 'd', T(12), { v: 4 }),
  item('stalled', 'e', T(1)),
];

test('by video: one group per video, the most urgent first, then the one that moved last', () => {
  const g = groupByVideo(items);
  assert.deepEqual(
    g.map((x) => x.slug),
    ['b', 'a', 'd', 'c', 'e'],
    'b holds a question; a a fix (and moved after b, but a question comes first); d a version to review; c only informs; stalled last',
  );
  assert.deepEqual(
    g[0]?.items.map((i) => i.kind),
    ['question', 'question', 'verify'],
  );
  assert.deepEqual(
    g[0]?.items.map((i) => i.at),
    [T(8), T(5), T(6)],
    'newest first within a kind',
  );
  assert.deepEqual(
    g[1]?.items.map((i) => i.kind),
    ['verify', 'client', 'version'],
  );
  assert.equal(g[1]?.latest, T(10), 'the group’s newest moment');
  assert.equal(g[1]?.name, 'a.mp4');
  assert.equal(g[1]?.folder, 'Acme/Spring');
});

test('two videos as urgent as each other: the one that moved last first', () => {
  const g = groupByVideo([item('question', 'x', T(1)), item('question', 'y', T(3)), item('verify', 'y', T(4))]);
  assert.deepEqual(
    g.map((x) => x.slug),
    ['y', 'x'],
  );
});

test('playbook suggestions group by their playbook', () => {
  const g = groupByVideo([item('playbook', '', T(1), { scope: 'house', video: 'House' }), item('playbook', '', T(2), { scope: 'house', video: 'House' })]);
  assert.equal(g.length, 1);
  assert.equal(g[0]?.name, 'House');
});

test('by kind: the groups of before, in their order', () => {
  assert.deepEqual(
    groupByKind(items).map((g) => g.kind),
    ['question', 'verify', 'review', 'client', 'answer', 'version', 'stalled'],
  );
});

test('the keys walk the list as it reads', () => {
  assert.deepEqual(
    orderedBy(items, 'video').map((i) => i.slug),
    ['b', 'b', 'b', 'a', 'a', 'a', 'd', 'c', 'e'],
  );
  assert.deepEqual(
    orderedBy(items, 'kind').map((i) => i.kind),
    ['question', 'question', 'verify', 'verify', 'review', 'client', 'answer', 'version', 'stalled'],
  );
});

test('what a video holds, kind by kind (the newest version named)', () => {
  assert.deepEqual(tallyOf(groupByVideo(items)[1]?.items ?? []), [
    { kind: 'verify', n: 1, v: 3 },
    { kind: 'client', n: 1 },
    { kind: 'version', n: 1, v: 3 },
  ]);
});

test('"Done": a question closes, what informs is waved through, work stays', () => {
  assert.equal(doneOf({ kind: 'question', dismissible: false }), 'close');
  assert.equal(doneOf({ kind: 'client', dismissible: true }), 'dismiss');
  assert.equal(doneOf({ kind: 'stalled', dismissible: true }), 'dismiss');
  assert.equal(doneOf({ kind: 'verify', dismissible: false }), null);
  assert.equal(doneOf({ kind: 'review', dismissible: false }), null);
});

test('"Later" ends tomorrow at 9:00 in the browser’s own day', () => {
  const evening = new Date(2026, 9, 1, 23, 30);
  const until = new Date(laterUntil(evening));
  assert.equal(until.getDate(), 2);
  assert.equal(until.getHours(), 9);
  assert.equal(until.getMinutes(), 0);
  const early = new Date(2026, 9, 31, 6, 0);
  const next = new Date(laterUntil(early));
  assert.deepEqual([next.getMonth(), next.getDate(), next.getHours()], [10, 1, 9], 'over a month’s end');
});

test('folding: a video with three or more items shows its most urgent one, unless opened or holding the preview', () => {
  const g = groupByVideo(items);
  const f = folded(g, new Set(), null);
  assert.deepEqual(
    f[0]?.items.map((i) => i.kind),
    ['question'],
  );
  assert.equal(f[0]?.hidden?.length, 2);
  assert.equal(f[2]?.hidden, undefined, 'one item: nothing to fold');
  assert.equal(folded(g, new Set([g[0]?.key ?? '']), null)[0]?.hidden, undefined, 'opened');
  const third = g[0]?.items[2]?.key ?? null;
  assert.equal(folded(g, new Set(), third)[0]?.hidden, undefined, 'the item in the preview stays in view');
});

test('Later is optimistic: the items leave the list and its counts at once and wait in "later", the earliest wake kept', () => {
  const q = item('question', 'b', T(8));
  const s = item('stalled', 'e', T(4));
  const v = item('verify', 'a', T(7));
  const base = {
    items: [q, s, v],
    counts: { question: 1, verify: 1, review: 0, client: 0, playbook: 0, approval: 0, answer: 0, version: 0, stalled: 1, total: 2 },
  } as unknown as Parameters<typeof aside>[0];
  const until = T(30);
  const d = aside(base, [q.key, s.key], until);
  assert.deepEqual(
    d.items.map((i) => i.key),
    [v.key],
  );
  assert.deepEqual(
    d.later?.map((i) => [i.key, i.snoozed]),
    [
      [q.key, until],
      [s.key, until],
    ],
  );
  assert.equal(d.counts.total, 1, 'the bell counts one less (stalled videos were never in it)');
  assert.equal(d.counts.question, 0);
  assert.equal(d.counts.later, 2);
  assert.equal(d.wake, until);
  assert.equal(aside({ ...base, wake: T(20) }, [v.key], until).wake, T(20), 'an earlier wake stays');
  assert.equal(aside(base, ['gone'], until), base, 'nothing to move: the same object');
});
