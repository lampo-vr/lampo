// Auto-check's freezes on synthetic footage (lib/media.ts `freezes`, lib/qa.ts, lib/findings.ts `holdVerdict`): a small
// thing moving on a still screen is motion, not a freeze; a hold the motion eases into and out of looks intended,
// whatever the sound does; a stall — copies of one frame in the middle of motion, then a catch-up jump — still looks
// like a problem; and the holds of every kind Auto-check told apart before are told apart as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { QaItem, Version } from '../../lib/types.ts';
import { encodeOnce, isolatedEnv, makeFreezeVideo, must } from '../lib/helpers.ts';

// no text engines: the picture and sound checks are what this is about
const { dir } = isolatedEnv({ vars: { VR_OCR: 'off' } });
const { runQa } = await import('../../lib/qa.ts');
const { freezes } = await import('../../lib/media.ts');
const { stallMark } = await import('../../lib/findings.ts');
const { probeSync, quickHash } = await import('../../lib/probe.ts');

const W = 540;
const H = 960;
const FPS = 24;
const DUR = 3;

// A screen of a product demo, in boxes (no fonts): a grey ground, a white card with a heading and two lines of text.
const SCREEN = [
  `drawbox=x=40:y=120:w=460:h=260:color=white:t=fill`,
  `drawbox=x=70:y=150:w=250:h=20:color=0x333333:t=fill`,
  `drawbox=x=70:y=190:w=350:h=12:color=0x999999:t=fill`,
  `drawbox=x=70:y=215:w=320:h=12:color=0x999999:t=fill`,
].join(',');

const TONE = `sine=frequency=440:sample_rate=48000:duration=${DUR}`;
// a music bed: two notes and a beat, never silent
const MUSIC = `aevalsrc=0.15*sin(2*PI*220*t)+0.1*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*2*t)):s=48000:d=${DUR}`;

/**
 * A clip of the screen with a blue card (and a cursor) moving over it: `card` and `cursor` are overlay x expressions
 * of the frame number n; `graph` adds filters after them (the stall's copies).
 */
function clip(name: string, { card, cursor, audio, graph = '' }: { card: string; cursor?: string; audio: string; graph?: string }): string {
  const v = [`[0:v]${SCREEN}[bg]`, `[bg][1:v]overlay=x='${card}':y=500[c]`];
  if (cursor) v.push(`[c][2:v]overlay=x='${cursor}':y=760[m]`);
  const last = cursor ? 'm' : 'c';
  v.push(graph ? `[${last}]${graph}[v]` : `[${last}]null[v]`);
  const audioIn = cursor ? 3 : 2;
  return encodeOnce(path.join(dir, `${name}.mp4`), [
    ...['-v', 'error', '-f', 'lavfi', '-i', `color=c=0xeeeeee:s=${W}x${H}:r=${FPS}:d=${DUR}`],
    ...['-f', 'lavfi', '-i', `color=c=0x2060ff:s=200x150:r=${FPS}:d=${DUR}`],
    ...(cursor ? ['-f', 'lavfi', '-i', `color=c=black:s=12x12:r=${FPS}:d=${DUR}`] : []),
    ...['-f', 'lavfi', '-i', audio],
    ...['-filter_complex', v.join(';'), '-map', '[v]', '-map', `${audioIn}:a`],
    ...['-c:v', 'libx264', '-crf', '20', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  ]);
}

function versionOf(file: string): { ver: Version; meta: object } {
  const m = probeSync(file);
  const ver: Version = {
    v: 1,
    hash: quickHash(file),
    mtime: '',
    size: fs.statSync(file).size,
    registered: '',
    fps: m.fps,
    width: m.width,
    height: m.height,
    frames: m.frames,
    duration: m.duration,
  };
  return { ver, meta: { codec: m.codec, pix_fmt: m.pix_fmt, color_space: m.color_space, color_range: m.color_range, audio: m.audio } };
}

async function check(file: string): Promise<{ ver: Version; items: QaItem[] }> {
  const { ver, meta } = versionOf(file);
  const r = await runQa(file, ver, meta);
  return { ver, items: r.items.filter((x) => x.kind === 'freeze') };
}

const said = (items: QaItem[]) => JSON.stringify(items.map(({ key, severity, likely, why, range }) => ({ key, severity, likely, why, range })));

test('a cursor moving over a still screen is motion: no freeze while it moves', async () => {
  // the card slides in (frames 0–23) and on again from 34; in between only a cursor-sized square moves, for 0.4 s
  const file = clip('cursor', {
    card: '-200+10*min(n\\,24)+10*max(0\\,n-34)',
    cursor: '100+20*max(0\\,min(n\\,34)-24)',
    audio: TONE,
  });
  const { ver, items } = await check(file);
  assert.deepEqual(items, [], `no freeze finding: ${said(items)}`);
  const scan = await freezes(file, ver);
  assert.ok(!scan.ranges.some((r) => r.in <= 33 && r.out >= 25), `nothing holds while the cursor moves: ${JSON.stringify(scan.ranges)}`);
});

test('a hold the motion eases into and out of looks intended, with music under it', async () => {
  // the card eases in (cubic, 18 frames), rests 10 frames truly still (18–27), eases out (cubic) and leaves
  const file = clip('eased', {
    card: 'if(lt(n\\,18)\\,-200+260*(1-pow(1-n/18\\,3))\\,if(lt(n\\,28)\\,60\\,60+480*pow((n-28)/18\\,3)))',
    audio: MUSIC,
  });
  const { ver, items } = await check(file);
  assert.ok(!items.some((x) => x.severity === 'should' || x.severity === 'must'), `not a problem: ${said(items)}`);
  for (const x of items) assert.equal(x.likely, 'intended', said(items));
  const eased = items.find((x) => x.range && x.range.in <= 18 && x.range.out >= 27);
  if (eased) assert.equal(eased.why, 'eased', said(items));
  // the hold itself is still there (the timeline marks it), with how the picture moves at its edges
  const scan = await freezes(file, ver);
  const m = must(must(scan.ranges.find((r) => r.in <= 18 && r.out >= 27)).motion);
  assert.ok(m.before >= 1 && stallMark(m) === null, `moving before it, no stall: ${JSON.stringify(m)}`);
});

test('a stall in the middle of motion, then a catch-up jump, still looks like a problem while the sound goes on', async () => {
  // the card moves 10 px a frame; frames 31–38 are copies of frame 30, and 39 is where the card should be by then
  const file = clip('stall', {
    card: '-200+10*n',
    audio: TONE,
    graph: 'split[a][b];[a][b]freezeframes=first=31:last=38:replace=30',
  });
  const { ver, items } = await check(file);
  const stall = must(items.find((x) => x.key === 'freeze:30'));
  assert.equal(stall.severity, 'should');
  assert.equal(stall.likely, 'problem');
  assert.equal(stall.why, 'sound-continues');
  assert.match(stall.text, /^Picture freezes for 9 frames \(0\.38 s\) while the sound goes on/);
  const scan = await freezes(file, ver);
  const hold = must(scan.ranges.find((r) => r.in === 30));
  assert.equal(hold.out, 38);
  const m = must(hold.motion);
  assert.ok(m.inside <= 0.25, `copies of one frame: ${JSON.stringify(m)}`);
  assert.ok(m.steady >= 1 && m.lead >= 0.5 * m.before && m.jump >= 2 * Math.max(m.before, m.after), `stops dead, then jumps: ${JSON.stringify(m)}`);
  assert.equal(stallMark(m), 'jump');
});

test('the holds of every kind Auto-check tells apart: a stall, a hitch, a pause, an end card', async () => {
  // test/lib/helpers.ts makeFreezeVideo: testsrc2 moving every frame, a tone except 5.0–6.2 s
  const file = makeFreezeVideo(path.join(dir, 'holds.mp4'));
  const { ver, items } = await check(file);
  const scan = await freezes(file, ver);
  assert.deepEqual(
    scan.ranges.map((r) => r.in),
    [40, 75, 128, 170],
  );
  assert.deepEqual(
    scan.ranges.slice(0, 3).map((r) => r.out),
    [55, 78, 148],
  );
  const byKey = Object.fromEntries(items.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(byKey).sort(), ['freeze:128', 'freeze:40', 'freeze:short'], said(items));
  assert.deepEqual([byKey['freeze:40'].severity, byKey['freeze:40'].likely, byKey['freeze:40'].why], ['should', 'problem', 'sound-continues']);
  assert.deepEqual(byKey['freeze:short'].holds, [{ in: 75, out: 78 }]);
  assert.deepEqual([byKey['freeze:short'].likely, byKey['freeze:short'].why], ['problem', 'repeated']);
  assert.deepEqual([byKey['freeze:128'].severity, byKey['freeze:128'].likely, byKey['freeze:128'].why], ['nice', 'intended', 'pause']);
});
