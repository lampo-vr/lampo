// The sidebar's Recent (web/src/lib/recent.ts): newest first, once each, capped, per account, and gone videos leave.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, opened, parseKept, RECENT_KEEP, recentFor, without } from '../../web/src/lib/recentList.ts';

test('opening a video puts it first, once, and the list stays at most RECENT_KEEP long', () => {
  let k = EMPTY;
  for (const s of ['a', 'b', 'c']) k = opened(k, 'u1', s);
  assert.deepEqual(k, { who: 'u1', slugs: ['c', 'b', 'a'] });
  k = opened(k, 'u1', 'a');
  assert.deepEqual(k.slugs, ['a', 'c', 'b'], 'opening one again moves it to the front');
  const same = opened(k, 'u1', 'a');
  assert.equal(same, k, 'already first: the same object, nothing written');
  for (let i = 0; i < 20; i++) k = opened(k, 'u1', `v${i}`);
  assert.equal(k.slugs.length, RECENT_KEEP);
  assert.equal(k.slugs[0], 'v19');
});

test("another account's list is nobody's here; a list from before anyone was known is adopted", () => {
  const theirs = { who: 'u1', slugs: ['a', 'b'] };
  assert.deepEqual(recentFor(theirs, 'u2'), []);
  assert.deepEqual(recentFor(theirs, 'u1'), ['a', 'b']);
  assert.deepEqual(opened(theirs, 'u2', 'x'), { who: 'u2', slugs: ['x'] }, "the next account starts its own list, never adding to someone else's");
  const early = { who: null, slugs: ['a'] };
  assert.deepEqual(recentFor(early, 'u2'), ['a']);
  assert.deepEqual(opened(early, 'u2', 'b'), { who: 'u2', slugs: ['b', 'a'] });
});

test('gone videos leave; nothing gone leaves the list as it was', () => {
  const k = { who: 'u1', slugs: ['a', 'b', 'c'] };
  assert.deepEqual(without(k, (s) => s === 'b').slugs, ['a', 'c']);
  assert.equal(
    without(k, () => false),
    k,
  );
});

test('what is kept is read defensively: junk, duplicates and odd types give a clean list', () => {
  assert.deepEqual(parseKept(null), EMPTY);
  assert.deepEqual(parseKept('not json'), EMPTY);
  assert.deepEqual(parseKept('{"slugs":"a"}'), EMPTY);
  assert.deepEqual(parseKept(JSON.stringify({ who: 7, slugs: ['a', 'a', 3, '', 'b'] })), { who: null, slugs: ['a', 'b'] });
  const many = JSON.stringify({ who: 'u', slugs: Array.from({ length: 30 }, (_, i) => `s${i}`) });
  assert.equal(parseKept(many).slugs.length, RECENT_KEEP);
});
