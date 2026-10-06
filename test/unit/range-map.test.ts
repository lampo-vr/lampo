// A range note made on one render, shown on another with a different frame rate: it starts on the frame on screen when
// its first frame starts and runs through the frame on screen when its last frame ends, never past the render's end.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Comment, FrameRange, Review, Version } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const store = await import('../../lib/store.ts');

const NTSC_FILM = 24000 / 1001;
const version = (v: number, fps: number, seconds: number) => ({ v, fps, frames: Math.round(seconds * fps) }) as Version;
/** Where a note's range on v1 (at `from` fps) lands on v2 (at `to` fps). */
function mapped(range: FrameRange, from: number, to: number, seconds = 10): FrameRange | null {
  const review = { versions: [version(1, from, seconds), version(2, to, seconds)] } as Review;
  return store.rangeIn(review, { v: 1, frame: range.in, range } as Comment, 2);
}

test('30 → 60 fps: frames 30–59 (1.0 s to 2.0 s) are frames 60–119', () => {
  assert.deepEqual(mapped({ in: 30, out: 59 }, 30, 60), { in: 60, out: 119 });
  assert.deepEqual(mapped({ in: 30, out: 30 }, 30, 60), { in: 60, out: 61 }, 'one frame at 30 fps is two at 60');
  assert.deepEqual(mapped({ in: 60, out: 119 }, 60, 30), { in: 30, out: 59 }, 'and back');
});

test('23.976 ↔ 25 fps: the last frame covers the range’s end', () => {
  // 1.0 s to 2.0 s at 25 fps; at 23.976 frame 23 is on screen at 1.0 s, frame 47 until 2.002 s.
  assert.deepEqual(mapped({ in: 25, out: 49 }, 25, NTSC_FILM), { in: 23, out: 47 });
  // The first 24 frames at 23.976 end at 1.001 s: at 25 fps that is frames 0–25 (frame 25 starts at 1.0 s).
  assert.deepEqual(mapped({ in: 0, out: 23 }, NTSC_FILM, 25), { in: 0, out: 25 });
  assert.deepEqual(mapped({ in: 48, out: 71 }, NTSC_FILM, 25), { in: 50, out: 75 });
});

test('the same frame rate keeps the range; the end never passes the render’s last frame', () => {
  assert.deepEqual(mapped({ in: 12, out: 40 }, 25, 25), { in: 12, out: 40 });
  // 0–299 at 30 fps is all of 10 s; the other render is 5 s at 60 fps.
  const review = { versions: [version(1, 30, 10), version(2, 60, 5)] } as Review;
  assert.deepEqual(store.rangeIn(review, { v: 1, frame: 200, range: { in: 200, out: 299 } } as Comment, 2), { in: 299, out: 299 });
});

test('the player maps with the same helper (lib/range.ts, browser-safe)', async () => {
  const { rangeOnGrid } = await import('../../lib/range.ts');
  assert.deepEqual(rangeOnGrid({ in: 30, out: 59 }, 30, 60, 600), { in: 60, out: 119 });
  assert.deepEqual(rangeOnGrid({ in: 25, out: 49 }, 25, NTSC_FILM, 240), mapped({ in: 25, out: 49 }, 25, NTSC_FILM));
});
