// The timeline's window on the video (web/src/player/timelineView.ts): zooming, Z, following the playhead, what the
// zoom control says, the overview's box, a remembered window and where the marked section's chip goes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aroundFrame,
  CELL_PX,
  chipLeft,
  clampView,
  followFrame,
  isFit,
  MIN_SPAN,
  minSpan,
  overviewBox,
  panTo,
  restoredView,
  sectionView,
  zoomAround,
  zoomLevel,
  zoomTarget,
} from '../../web/src/player/timelineView.ts';

const FRAMES = 3750; // 150 s at 25 fps

test('a window stays inside the video and never narrower than ten frames (or the whole of a shorter one)', () => {
  assert.deepEqual(clampView(-40, 100, FRAMES), [0, 100]);
  assert.deepEqual(clampView(3700, 100, FRAMES), [3650, 3750]);
  assert.deepEqual(clampView(500, 2, FRAMES), [500, 500 + MIN_SPAN]);
  assert.deepEqual(clampView(0, 1e6, FRAMES), [0, FRAMES]);
  assert.equal(minSpan(6), 6);
  assert.deepEqual(clampView(3, 2, 6), [0, 6]);
});

test('zooming keeps the anchor frame where it is on screen', () => {
  const v = zoomAround([0, FRAMES], 0.5, 1000, FRAMES);
  assert.equal(v[1] - v[0], FRAMES / 2);
  // 1000 sat at 1000/3750 of the width before and still does
  assert.ok(Math.abs((1000 - v[0]) / (v[1] - v[0]) - 1000 / FRAMES) < 1e-9);
  // in as far as it goes: ten frames, never fewer
  let w: readonly [number, number] = [0, FRAMES];
  for (let i = 0; i < 20; i++) w = zoomAround(w, 0.5, 1962, FRAMES);
  assert.equal(w[1] - w[0], MIN_SPAN);
  assert.ok(1962 >= w[0] && 1962 < w[1]);
  // and out again to the whole video
  for (let i = 0; i < 20; i++) w = zoomAround(w, 2, 1962, FRAMES);
  assert.ok(isFit(w, FRAMES));
});

test('Z: the marked section with room for both handles, else a second around the playhead; again: the whole video', () => {
  const section = { in: 1750, out: 1962 };
  const s = zoomTarget([0, FRAMES], section, 100, 25, FRAMES);
  assert.ok(s[0] < 1750 && s[1] > 1963, `both ends inside ${s}`);
  assert.ok((s[1] - s[0]) / 213 > 1.2 && (s[1] - s[0]) / 213 < 1.4, `a little room either side: ${s}`);
  assert.deepEqual(zoomTarget(s, section, 100, 25, FRAMES), [0, FRAMES], 'pressed again: fit');
  const p = zoomTarget([0, FRAMES], null, 1962, 25, FRAMES);
  assert.equal(p[1] - p[0], 25);
  assert.ok(1962 > p[0] + 10 && 1962 < p[1] - 10, `the playhead in the middle: ${p}`);
  // a one-frame section still opens to ten frames
  const one = sectionView({ in: 40, out: 40 }, FRAMES);
  assert.equal(one[1] - one[0], MIN_SPAN);
  assert.ok(40 >= one[0] && 41 <= one[1]);
  // near the start the window doesn't go before frame 0
  assert.deepEqual(aroundFrame(2, 25, FRAMES), [0, 25]);
});

test('following the playhead: the same window while it is inside, the next page when it leaves', () => {
  const v = [1000, 1100] as const;
  assert.equal(followFrame(v, 1050, FRAMES), v);
  assert.deepEqual(followFrame(v, 1100, FRAMES), [1090, 1190]);
  assert.deepEqual(followFrame(v, 900, FRAMES), [890, 990]);
  assert.deepEqual(followFrame(v, 3749, FRAMES), [3650, 3750]);
});

test('the zoom control says Fit, the frames across, or how many times closer', () => {
  assert.deepEqual(zoomLevel([0, FRAMES], FRAMES), { kind: 'fit' });
  assert.deepEqual(zoomLevel([0, FRAMES / 4], FRAMES), { kind: 'times', z: '4' });
  assert.deepEqual(zoomLevel([0, FRAMES / 2.5], FRAMES), { kind: 'times', z: '2.5' });
  assert.deepEqual(zoomLevel([0, 117], FRAMES), { kind: 'times', z: '32' });
  assert.deepEqual(zoomLevel([100, 112], FRAMES), { kind: 'frames', n: 12 });
  assert.deepEqual(zoomLevel([100.3, 125.6], FRAMES), { kind: 'frames', n: 25 });
});

test('the overview: the window as a box on the whole video; dragging it pans', () => {
  assert.deepEqual(overviewBox([0, FRAMES], FRAMES, 1000), { x: 0, w: 1000 });
  assert.deepEqual(overviewBox([1875, 2250], FRAMES, 1000), { x: 500, w: 100 });
  // a ten-frame window is still a box you can take
  assert.equal(overviewBox([100, 110], FRAMES, 1000).w, 4);
  assert.deepEqual(panTo([0, 100], 2000, FRAMES), [1950, 2050]);
  assert.deepEqual(panTo([0, 100], 3740, FRAMES), [3650, 3750]);
});

test('a remembered window comes back only while it fits the version', () => {
  assert.deepEqual(restoredView([100, 200], FRAMES), [100, 200]);
  assert.equal(restoredView([0, FRAMES], FRAMES), null, 'the whole video is no zoom');
  assert.equal(restoredView([100, 5000], FRAMES), null, 'past a shorter version’s end');
  assert.equal(restoredView('100-200', FRAMES), null);
  assert.equal(restoredView([200, 100], FRAMES), null);
});

test('the section’s chip: over the section when it fits, else beside a handle, always inside the timeline', () => {
  assert.equal(chipLeft(100, 500, 200, 1000), 200);
  // narrow: after the end handle
  assert.equal(chipLeft(100, 120, 200, 1000), 128);
  // narrow at the right edge: before the start handle
  assert.equal(chipLeft(900, 920, 200, 1000), 692);
  // never past either edge
  assert.equal(chipLeft(-50, 10, 200, 1000), 18);
  assert.equal(chipLeft(0, 1000, 1200, 1000), 2);
  assert.ok(CELL_PX >= 20, 'a frame number fits a cell');
});
