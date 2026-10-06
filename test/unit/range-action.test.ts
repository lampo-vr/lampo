// The composer's range action (web/src/player/rangeAction.ts): from the frame on screen, the one action that changes
// the note's moment — and the frame it names — or nothing to do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rangeAction } from '../../web/src/player/rangeAction.ts';

const FPS = 25;
const FRAMES = 250; // frames 0–249

test('one frame: "Until" a second later, from the frame on screen', () => {
  assert.deepEqual(rangeAction(100, null, FPS, FRAMES), { kind: 'until', range: { in: 100, out: 125 }, at: 125 });
});

test('one frame too close to the end for a second: "From" a second earlier, ending on it', () => {
  assert.deepEqual(rangeAction(240, null, FPS, FRAMES), { kind: 'from', range: { in: 215, out: 240 }, at: 215 });
  assert.deepEqual(rangeAction(10, null, FPS, 12), { kind: 'from', range: { in: 0, out: 10 }, at: 0 });
});

test('a range: the frame on screen after its start (not its end) moves the end — inside or past it', () => {
  const r = { in: 50, out: 100 };
  assert.deepEqual(rangeAction(80, r, FPS, FRAMES), { kind: 'end', range: { in: 50, out: 80 }, at: 80 });
  assert.deepEqual(rangeAction(160, r, FPS, FRAMES), { kind: 'end', range: { in: 50, out: 160 }, at: 160 });
});

test('a range: the frame on screen before its start moves the start', () => {
  assert.deepEqual(rangeAction(20, { in: 50, out: 100 }, FPS, FRAMES), { kind: 'start', range: { in: 20, out: 100 }, at: 20 });
});

test('a range: on its first or last frame there is nothing to do', () => {
  assert.deepEqual(rangeAction(50, { in: 50, out: 100 }, FPS, FRAMES), { kind: 'at-start' });
  assert.deepEqual(rangeAction(100, { in: 50, out: 100 }, FPS, FRAMES), { kind: 'at-end' });
});

test('the frame an action names is the frame it sets', () => {
  for (const [now, range] of [
    [100, null],
    [240, null],
    [80, { in: 50, out: 100 }],
    [20, { in: 50, out: 100 }],
  ] as const) {
    const a = rangeAction(now, range, FPS, FRAMES);
    assert.ok('range' in a);
    if (a.kind === 'until' || a.kind === 'end') assert.equal(a.at, a.range.out);
    else assert.equal(a.at, a.range.in);
    assert.ok(a.range.in <= a.range.out && a.range.out <= FRAMES - 1);
  }
});
