// One set of safe-zone numbers (lib/zones.ts): Auto-check flags text under the Instagram Reels zones the player's
// preset and phone view show — today's (2025's rail with its repost button, the 14 % top) — and keeps the words and zone
// names agents read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { TextLine } from '../../lib/qa.ts';
import { inkBoxes, safeZoneItems } from '../../lib/qa.ts';
import type { Version } from '../../lib/types.ts';
import { REELS_CHECKS, REELS_CROP, ZONE_SHAPES } from '../../lib/zones.ts';
import { ZONES } from '../../web/src/player/zones.ts';
import { FFMPEG, tmpdir } from '../lib/helpers.ts';

const ver = { v: 1, hash: 'h', fps: 25, width: 1080, height: 1920, frames: 250 } as Version;
// a line of text seen on two samples (one sample is text flying in or out)
const seen = (text: string, box: { x: number; y: number; w: number; h: number }): TextLine[] =>
  [10, 20].map((frame) => ({ frame, text, key: text.toLowerCase(), conf: 0.9, box, words: [] }));

test('the player draws the numbers Auto-check flags text under', () => {
  for (const [id, shapes] of Object.entries(ZONE_SHAPES))
    assert.deepEqual(
      ZONES()[id]?.map(({ x, y, w, h, type }) => [type, x, y, w, h]),
      shapes.map(({ x, y, w, h, type }) => [type, x, y, w, h]),
      id,
    );
  const reels = (check: string) => REELS_CHECKS.find((z) => z.check === check);
  assert.deepEqual(reels('ig-topbar') && [reels('ig-topbar')?.y, reels('ig-topbar')?.h], [0, 269], 'the top: 14 % of 1920');
  assert.deepEqual(reels('ig-icons') && [reels('ig-icons')?.x, reels('ig-icons')?.y, reels('ig-icons')?.w, reels('ig-icons')?.h], [890, 1100, 138, 800]);
  assert.equal(REELS_CROP, 52);
});

test('Auto-check flags text under today’s Reels zones, in the words agents read', () => {
  // below the old 220 px top bar, under the 269 px one
  const top = safeZoneItems(seen('Summer drop', { x: 300, y: 228, w: 400, h: 34 }), ver);
  assert.deepEqual(
    top.map((x) => [x.zone, x.text]),
    [['ig-topbar', `Text "Summer drop" sits under Instagram's top bar`]],
  );
  // where the rail grew in 2025: left of the old column and above it
  const rail = safeZoneItems(seen('-20%', { x: 893, y: 1110, w: 90, h: 50 }), ver);
  assert.deepEqual(
    rail.map((x) => [x.zone, x.text]),
    [['ig-icons', 'Text "-20%" sits under the Instagram icon column']],
  );
  // the caption block and the side crop as before
  assert.deepEqual(
    safeZoneItems(seen('Link in bio', { x: 100, y: 1700, w: 300, h: 40 }), ver).map((x) => x.zone),
    ['ig-caption'],
  );
  assert.deepEqual(
    safeZoneItems(seen('Edge', { x: 20, y: 900, w: 200, h: 40 }), ver).map((x) => [x.zone, x.text]),
    [['ig-crop', 'Text "Edge" is cut by the 52 px side crop']],
  );
  // the middle of the picture is safe; a landscape video has no Reels zones
  assert.deepEqual(safeZoneItems(seen('Hello', { x: 300, y: 900, w: 300, h: 40 }), ver), []);
  assert.deepEqual(safeZoneItems(seen('Summer drop', { x: 300, y: 10, w: 400, h: 34 }), { ...ver, width: 1920, height: 1080 }), []);
});

// OCR's line box runs wider than the letters: Vision's box for “around 0:12.” at 1080 px starts at x 47–50, its opening
// quote at x 71. Twenty pixels is the whole margin to the 52 px crop, so the edges are measured on the frame.
test('the side crop goes by the letters, not by OCR’s box around them', async () => {
  const dir = tmpdir('vr-ink-');
  // an OCR frame (720 wide for a 1080 × 1920 render): dark ground, three "letters" from 1080-px x 72 to 702
  const frame = (name: string, ground: string, firstX: number) => {
    const file = path.join(dir, `${name}.jpg`);
    const k = 720 / 1080;
    const glyphs = [firstX, 300, 520].map(
      (x, i) =>
        `drawbox=x=${Math.round(x * k)}:y=${Math.round(400 * k)}:w=${Math.round((i === 2 ? 182 : 160) * k)}:h=${Math.round(100 * k)}:color=0xe8590c:t=fill`,
    );
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `${ground}:s=720x1280`, '-frames:v', '1', '-vf', glyphs.join(','), '-y', file]);
    return { frame: 10, file };
  };
  const padded = { x: 47, y: 382, w: 727, h: 145 };
  const lines = (box = padded) => seen('"around 0:12."', box);
  const zones = async (f: { frame: number; file: string }, box = padded) =>
    safeZoneItems(await inkBoxes(lines(box), [f, { ...f, frame: 20 }], ver), ver).map((x) => x.zone);

  // before: OCR's box alone puts the line in the crop
  assert.deepEqual(
    safeZoneItems(lines(), ver).map((x) => x.zone),
    ['ig-crop'],
  );
  // the letters start at x 72: clear of the crop, and the box narrows to them
  const clear = frame('clear', 'color=c=0x0d0d0e', 72);
  assert.deepEqual(await zones(clear), []);
  const [narrowed] = await inkBoxes(lines(), [clear], ver);
  assert.ok(Math.abs(narrowed.box.x - 72) <= 3 && Math.abs(narrowed.box.x + narrowed.box.w - 702) <= 3, JSON.stringify(narrowed.box));
  // letters that do reach into the crop stay a finding
  assert.deepEqual(await zones(frame('cut', 'color=c=0x0d0d0e', 30), { ...padded, x: 20, w: 745 }), ['ig-crop']);
  // over a picture the ground can't be told: OCR's box stands
  assert.deepEqual(await zones(frame('busy', 'testsrc2=d=1', 72)), ['ig-crop']);
  // text away from the edges is never measured, and a landscape render has no crop
  const middle = { x: 300, y: 900, w: 300, h: 40 };
  assert.deepEqual((await inkBoxes(seen('Hello', middle), [{ frame: 10, file: path.join(dir, 'missing.jpg') }], ver))[0].box, middle);
  assert.deepEqual(await inkBoxes(lines(), [clear], { ...ver, width: 1920, height: 1080 }), lines());
});
