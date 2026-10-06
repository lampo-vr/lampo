// Range notes: how a range reads for people and agents, which frames stand for it, and what the store accepts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRange, formatRange, formatSeconds, frameInRange, normalizeRange, rangeFrames, rangeRows, rangeSeconds, stripFrames } from '../../lib/range.ts';

test('a range reads as timecodes, frames and seconds; both end frames count', () => {
  const r = { in: 300, out: 357 };
  assert.equal(rangeFrames(r), 58);
  assert.equal(rangeSeconds(r, 25), 2.32);
  assert.equal(formatRange(r, 25), '00:12:00 → 00:14:07 · 2.3 s');
  assert.equal(describeRange(r, 25), '00:12:00 → 00:14:07 (f300–f357, 2.3 s)');
  assert.equal(formatRange({ in: 10, out: 10 }, 25), '00:00:10 → 00:00:10 · 0.04 s', 'one frame is a range too');
});

test('seconds: two decimals under a second, one under ten, whole seconds, then minutes', () => {
  assert.equal(formatSeconds(0.52), '0.52 s');
  assert.equal(formatSeconds(0.7), '0.7 s', 'no trailing zero');
  assert.equal(formatSeconds(2.32), '2.3 s');
  assert.equal(formatSeconds(12.4), '12 s');
  assert.equal(formatSeconds(65), '1:05 min');
});

test('the strip: first and last frame and evenly between them, at most six, every frame of a short range', () => {
  assert.deepEqual(stripFrames({ in: 360, out: 372 }), [360, 362, 365, 367, 370, 372]);
  assert.deepEqual(stripFrames({ in: 0, out: 3 }), [0, 1, 2, 3], 'shorter than six frames: all of them');
  assert.deepEqual(stripFrames({ in: 5, out: 5 }), [5]);
  assert.deepEqual(stripFrames({ in: 0, out: 1000 }, 4), [0, 333, 667, 1000]);
  const s = stripFrames({ in: 17, out: 23 });
  assert.equal(s[0], 17);
  assert.equal(s.at(-1), 23);
  assert.deepEqual(
    s,
    [...s].sort((a, b) => a - b),
    'ascending',
  );
  assert.equal(new Set(s).size, s.length, 'no frame twice');
});

test('the store keeps whole frames, in ≤ out, inside the render; past the end is refused', () => {
  assert.equal(normalizeRange(null, 100), null);
  assert.deepEqual(normalizeRange({ in: 40.4, out: 10 }, 100), { in: 10, out: 40 }, 'backwards is turned round, frames are whole');
  assert.deepEqual(normalizeRange({ in: 0, out: 99 }, 100), { in: 0, out: 99 }, 'the whole render');
  assert.throws(() => normalizeRange({ in: 90, out: 100 }, 100), /ends after the last frame/);
  assert.throws(() => normalizeRange({ in: -3, out: 10 }, 100), /before the first frame/);
  assert.throws(() => normalizeRange({ in: Number.NaN, out: 10 }, 100), /two frame numbers/);
});

test('a range note sits where it was written when that is inside its range, else at the range start', () => {
  assert.equal(frameInRange(50, { in: 40, out: 60 }), 50);
  assert.equal(frameInRange(10, { in: 40, out: 60 }), 40);
  assert.equal(frameInRange(10, null), 10);
});

test('timeline rows: overlapping or touching ranges never share a row; apart they all sit on the first', () => {
  const r = (id: string, a: number, b: number) => ({ id, rangeHere: { in: a, out: b } });
  const apart = rangeRows([r('a', 0, 10), r('b', 20, 30), { id: 'p' }]);
  assert.deepEqual(
    [...apart.entries()],
    [
      ['a', 0],
      ['b', 0],
    ],
    'a point note has no row',
  );
  const stacked = rangeRows([r('c', 60, 90), r('a', 12, 42), r('b', 30, 60), r('d', 75, 95)]);
  assert.equal(stacked.get('a'), 0);
  assert.equal(stacked.get('b'), 1, 'overlaps a');
  assert.equal(stacked.get('c'), 0, 'starts after a ended');
  assert.equal(stacked.get('d'), 1, 'overlaps c');
  assert.equal(rangeRows([r('a', 0, 10), r('b', 10, 20)]).get('b'), 1, 'touching ends are two ranges');
});
