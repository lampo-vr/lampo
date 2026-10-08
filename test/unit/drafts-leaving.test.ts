// A draft that was sent leaves "Not sent yet" with a motion, however soon the list drops it (the server's answer, the
// drafts event): web/src/player/drafts/leaving.ts puts the leaving ones back where they stood until the motion ends —
// one sent alone, several at once, one of a recording's drafts, a recording whose drafts all went — and the ones a send
// took, while it is out, when the drafts event drops them before the send's answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inPlace, recordingsLeaving, withLeaving } from '../../web/src/player/drafts/leaving.ts';

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join(' ');
const of = (s: string) => s.split(' ').map((id) => ({ id }));

test('nothing leaving: the list as it is (the same array)', () => {
  const now = of('a b c');
  assert.equal(withLeaving(of('a b c d'), now, new Set()), now);
  assert.equal(withLeaving([], now, new Set(['x'])), now);
  assert.equal(withLeaving(of('a b c'), now, new Set(['b'])), now, 'a leaving draft still in the list needs no help');
});

test('one sent from the middle keeps its place while it leaves', () => {
  assert.equal(ids(withLeaving(of('a b c d'), of('a c d'), new Set(['b']))), 'a b c d');
  assert.equal(ids(withLeaving(of('a b c d'), of('b c d'), new Set(['a']))), 'a b c d', 'the first');
  assert.equal(ids(withLeaving(of('a b c d'), of('a b c'), new Set(['d']))), 'a b c d', 'the last');
});

test('several at once (Send all) keep their order, and only the leaving ones come back', () => {
  assert.equal(ids(withLeaving(of('a b c'), [], new Set(['a', 'b', 'c']))), 'a b c');
  assert.equal(ids(withLeaving(of('a b c d e'), of('b e'), new Set(['a', 'c', 'd']))), 'a b c d e');
  assert.equal(ids(withLeaving(of('a b c d'), of('a d'), new Set(['b']))), 'a b d', 'c was deleted, not sent: it stays gone');
});

test('a draft saved meanwhile stays where the list has it', () => {
  assert.equal(ids(withLeaving(of('a b c'), of('a c n'), new Set(['b']))), 'a b c n');
});

test("recordings: a draft sent alone keeps its place in its recording; a recording whose drafts all went stays until they've left", () => {
  const before = [
    { id: 'r1', drafts: of('d1 d2 d3') },
    { id: 'r2', drafts: of('d4') },
  ];
  const now1 = [
    { id: 'r1', drafts: of('d1 d3') },
    { id: 'r2', drafts: of('d4') },
  ];
  const shown1 = recordingsLeaving(before, now1, new Set(['d2']));
  assert.deepEqual(
    shown1.map((r) => [r.id, ids(r.drafts)]),
    [
      ['r1', 'd1 d2 d3'],
      ['r2', 'd4'],
    ],
  );
  assert.equal(shown1[1], now1[1], 'a recording with nothing leaving is the one in the list');
  const shown2 = recordingsLeaving(before, [{ id: 'r1', drafts: of('d1 d2 d3') }], new Set(['d4']));
  assert.deepEqual(
    shown2.map((r) => [r.id, ids(r.drafts)]),
    [
      ['r1', 'd1 d2 d3'],
      ['r2', 'd4'],
    ],
    'r2 sent whole: kept while d4 leaves',
  );
  const now3 = [{ id: 'r1', drafts: of('d1 d2 d3') }];
  assert.equal(recordingsLeaving(before, now3, new Set()), now3);
});

test('being sent: the drafts event dropping them before the answer takes none off the screen, nor a recording', () => {
  const none = new Set<string>();
  assert.equal(inPlace(none, null), none, 'nothing out: the leaving ones alone (the same set)');
  assert.equal(inPlace(none, new Set()), none);
  const all = inPlace(none, new Set(['a', 'b', 'c']));
  assert.equal(ids(withLeaving(of('a b c'), [], all)), 'a b c', 'Send all: every card where it stood');
  assert.equal(ids(withLeaving(of('a b c'), of('a c'), inPlace(none, new Set(['b'])))), 'a b c', 'one sent alone');
  assert.equal(ids(withLeaving(of('x a b'), [], inPlace(new Set(['x']), new Set(['a', 'b'])))), 'x a b', 'one still leaving from before, too');
  // the answer: leaving now, from the same places
  assert.equal(ids(withLeaving(of('a b c'), [], inPlace(new Set(['a', 'b', 'c']), null))), 'a b c');
  const now = of('a b c');
  assert.equal(withLeaving(of('a b c'), now, inPlace(none, null)), now, 'a failed send: the list as it is, nothing kept back');
  const recs = [
    { id: 'r1', drafts: of('d1 d2') },
    { id: 'r2', drafts: of('d3') },
  ];
  assert.deepEqual(
    recordingsLeaving(recs, [], inPlace(none, new Set(['d1', 'd2', 'd3']))).map((r) => [r.id, ids(r.drafts)]),
    [
      ['r1', 'd1 d2'],
      ['r2', 'd3'],
    ],
    "what the recordings said, the recordings' event first: kept too",
  );
});
