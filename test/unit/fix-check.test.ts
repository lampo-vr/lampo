// Check mode's queue (web/src/player/fixCheck.ts): read from the notes as they are, so a fix settled anywhere — the
// panel's card, another person, an agent — leaves it at once, the card keeps the fix it is on while that one waits, and
// moves on to the next waiting one when it is settled; fixes that come to be checked meanwhile join at the end.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixBase } from '../../lib/handover.ts';
import { checkPlace, checkVerdict, comparedWith, lastStillWrong, nextWaiting, sessionOrder } from '../../web/src/player/fixCheck.ts';

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

// Still wrong names the version it was said on, with what was drawn there; the next check compares that version with
// the new one (V2 → V3), not the note's own.
const BOX = { type: 'box' as const, x: 10, y: 10, w: 40, h: 20 };
const at = '2026-10-11T10:00:00.000Z';

test('Still wrong names the version it was checked on, and carries the drawing made there', () => {
  assert.deepEqual(checkVerdict({ status: 'fixed' }, false, 'touches the logo', 2, { frame: 20, drawing: [BOX] }), {
    status: 'open',
    note: 'touches the logo',
    on: { v: 2, frame: 20, drawing: [BOX] },
  });
  // nothing drawn: the version alone; a carried note stays open, looked at
  assert.deepEqual(checkVerdict({ status: 'open' }, false, '', 3, { frame: 5, drawing: [] }), { ack: true, note: 'Still wrong in V3.', on: { v: 3 } });
  assert.deepEqual(checkVerdict({ status: 'fixed' }, true, '', 3), { status: 'verified', note: '' }, 'Looks right names no version');
});

test('the next check compares the version it was found still wrong on with the new one', () => {
  const fixedIn = (v: number) => ({ by: 'agent:claude-ai', text: 'done', status: 'fixed' as const, fixed_in_v: v, at });
  const note = {
    v: 1,
    replies: [fixedIn(2), { by: 'Mia', text: 'touches the logo', status: 'open' as const, on_v: 2, on_frame: 20, drawing: [BOX], at }, fixedIn(3)],
  };
  assert.equal(lastStillWrong(note)?.v, 2);
  assert.equal(comparedWith(note, [1, 2, 3], 3), 2, 'V2 → V3');
  // never fixed in between: the note's own version, as before
  assert.equal(comparedWith({ v: 1, replies: [fixedIn(3)] }, [1, 2, 3], 3), 1);
  // a reopen from before replies named their version: the version of the fix it turned down
  const older = { v: 1, replies: [fixedIn(2), { by: 'Mia', text: 'no', status: 'open' as const, at }, fixedIn(3)] };
  assert.equal(comparedWith(older, [1, 2, 3], 3), 2);
  // said on the version being checked (no newer one yet), or a version that is gone: the note's own
  assert.equal(comparedWith(note, [1, 2], 2), 1);
  assert.equal(comparedWith(note, [1, 3], 3), 1);
  // nothing to compare: written on the version being checked
  assert.equal(comparedWith({ v: 3, replies: [] }, [1, 2, 3], 3), null);
  // the fix after it must be newer than V2, the version the Still wrong names, even when V3 came in the same second
  const versions = [1, 2, 3].map((v) => ({ v, registered: at }));
  const reopenedOnV2 = { v: 1, replies: [fixedIn(2), { by: 'Mia', text: 'no', status: 'open' as const, on_v: 2, at }] };
  assert.equal(fixBase(versions, reopenedOnV2), 2);
  assert.equal(fixBase(versions, { ...reopenedOnV2, replies: [fixedIn(2), { by: 'Mia', text: 'no', status: 'open' as const, at }] }), 3, 'unnamed: by time');
  // found right since: what was said before is history, the check compares with the note's own version again
  const settled = { v: 1, replies: [...note.replies, { by: 'Mia', text: '', status: 'verified' as const, at }, fixedIn(4)] };
  assert.equal(lastStillWrong(settled), null);
  assert.equal(comparedWith(settled, [1, 2, 3, 4], 4), 1);
});
