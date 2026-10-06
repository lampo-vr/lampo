// Check mode's queue (web/src/player/fixCheck.ts): read from the notes as they are, so a fix settled anywhere — the
// panel's card, another person, an agent — leaves it at once, the card keeps the fix it is on while that one waits, and
// moves on to the next waiting one when it is settled; fixes that come to be checked meanwhile join at the end.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPlace, nextWaiting, sessionOrder } from '../../web/src/player/fixCheck.ts';

const s = { order: ['a', 'b', 'c', 'd', 'e', 'f'], at: 'a' };

test('a session starts on its first fix: 1 of 6', () => {
  assert.deepEqual(checkPlace(s, ['a', 'b', 'c', 'd', 'e', 'f']), { current: 'a', index: 0, total: 6 });
});

test('a fix settled on the card moves the session to the next waiting one', () => {
  assert.deepEqual(checkPlace(s, ['b', 'c', 'd', 'e', 'f']), { current: 'b', index: 1, total: 6 });
});

test('a fix settled elsewhere leaves at once; the card keeps the one it is on', () => {
  const on5 = { ...s, at: 'e' };
  assert.deepEqual(checkPlace(on5, ['e', 'f']), { current: 'e', index: 4, total: 6 });
  // the sixth reopened in the panel: still on the fifth, which is now the last to check
  assert.deepEqual(checkPlace(on5, ['e']), { current: 'e', index: 5, total: 6 });
  // and when the fifth is settled too, nothing is left
  assert.deepEqual(checkPlace(on5, []), { current: null, index: 6, total: 6 });
});

test('the one on the card settled elsewhere: the next waiting after it, never one before it', () => {
  // b was skipped (still waits), the card is on d; d settled in the panel and f by an agent: e is next
  assert.deepEqual(checkPlace({ ...s, at: 'd' }, ['b', 'e']), { current: 'e', index: 5, total: 6 });
  assert.equal(checkPlace({ ...s, at: 'f' }, ['b']).current, null, 'past the end: over, a skipped one is not brought back');
});

test('skipping goes to the next that waits; at the end there is none', () => {
  assert.equal(nextWaiting(s, ['a', 'c', 'f']), 'c');
  assert.equal(nextWaiting({ ...s, at: 'f' }, ['a', 'f']), null);
  assert.equal(nextWaiting({ ...s, at: 'b' }, ['a', 'd']), null, 'the one on the card settled: the next after d');
});

test('a fix that comes to be checked during the session joins at the end', () => {
  assert.deepEqual(sessionOrder(s, ['a', 'g', 'b']), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(checkPlace({ ...s, at: 'f' }, ['g']), { current: 'g', index: 6, total: 7 });
});
