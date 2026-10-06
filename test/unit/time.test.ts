import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTime, fmtDuration, frameSeekTime, frameToTime, isAgent, parseFramePosition, presentedFrame, timecode, timeToFrame } from '../../lib/time.ts';
import type { Review } from '../../lib/types.ts';

const NTSC = 30000 / 1001;
const FILM = 24000 / 1001;

test('timecode at integer fps (mm:ss:ff)', () => {
  assert.equal(timecode(0, 30), '00:00:00');
  assert.equal(timecode(29, 30), '00:00:29');
  assert.equal(timecode(30, 30), '00:01:00');
  assert.equal(timecode(363, 30), '00:12:03'); // the brief's example
  assert.equal(timecode(1520, 30), '00:50:20');
  assert.equal(timecode(24, 25), '00:00:24');
  assert.equal(timecode(25, 25), '00:01:00');
});

test('timecode adds hours only past an hour', () => {
  assert.equal(timecode(30 * 3599, 30), '59:59:00');
  assert.equal(timecode(30 * 3600, 30), '1:00:00:00');
  assert.equal(timecode(30 * 3600 + 363, 30), '1:00:12:03');
});

test('timecode at 29.97 never shows ff >= 30 and rolls over at the right frame', () => {
  assert.equal(timecode(29, NTSC), '00:00:29');
  assert.equal(timecode(30, NTSC), '00:01:00');
  assert.equal(timecode(899, NTSC), '00:29:29');
  assert.equal(timecode(900, NTSC), '00:30:00');
  for (let f = 0; f < 20000; f++) {
    const ff = Number(timecode(f, NTSC).split(':').at(-1));
    assert.ok(ff < 30, `frame ${f} → ${timecode(f, NTSC)}`);
  }
});

test('timecode at 23.976 (incl. the rounded fps ffprobe reports)', () => {
  assert.equal(timecode(23, FILM), '00:00:23');
  assert.equal(timecode(24, FILM), '00:01:00');
  assert.equal(timecode(95, 23.97602), '00:03:23');
  assert.equal(timecode(71, 23.97602), '00:02:23');
});

test('parseFramePosition accepts timecode, seconds and f-numbers', () => {
  assert.equal(parseFramePosition('00:12:03', 30), 363);
  assert.equal(parseFramePosition('1:00:12:03', 30), 108363);
  assert.equal(parseFramePosition('f363', 30), 363);
  assert.equal(parseFramePosition('12.1', 30), 363);
  assert.equal(parseFramePosition('12.1s', 30), 363);
  assert.equal(parseFramePosition('00:02:23', 23.97602), 71);
  assert.equal(parseFramePosition('nonsense', 30), null);
});

test('timecode and parseFramePosition round-trip for every frame', () => {
  for (const fps of [24, 25, 30, 50, 60, FILM, NTSC, 23.97602, 29.97003, 59.94006]) {
    for (let f = 0; f < 6000; f++) assert.equal(parseFramePosition(timecode(f, fps), fps), f, `fps ${fps} frame ${f}`);
  }
});

test('frame ↔ time helpers', () => {
  assert.equal(frameToTime(363, 30), 12.1);
  assert.equal(timeToFrame(12.1, 30), 363);
  assert.equal(timeToFrame(-1, 30), 0);
  // Seeking to the middle of a frame keeps the browser off frame boundaries.
  assert.equal(frameSeekTime(0, 30), 0.5 / 30);
  for (let f = 0; f < 3000; f++) assert.equal(Math.floor(frameSeekTime(f, NTSC) * NTSC), f);
});

test('fmtDuration and isAgent', () => {
  assert.equal(fmtDuration(50.7), '50.7s');
  assert.equal(fmtDuration(84), '1:24.0');
  assert.equal(fmtDuration(NaN), '–');
  assert.equal(isAgent('agent:promo-edit'), true);
  assert.equal(isAgent('alex'), false);
  assert.equal(isAgent(undefined), false);
});

// Notes store `t` rounded to the millisecond; mapping it back must land on the same frame at every common fps
// (this used to floor frame 1 @30fps: t=0.033 → 0.99 → 0).
test('frameToTime → timeToFrame round-trips at all common frame rates', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60])
    for (let f = 0; f < 2000; f++) assert.equal(timeToFrame(frameToTime(f, fps), fps), f, `frame ${f} @${fps}`);
});

test('compareTime orders instants, not strings: mixed offsets and the hour the clocks go back', () => {
  // 21:30 UTC written by a laptop in summer time, 22:00 UTC written by a container: the string order is backwards.
  assert.equal(compareTime('2026-09-28T23:30:00+02:00', '2026-09-28T22:00:00Z'), -1);
  // 25 Oct 2026 in Europe: 02:30 summer time (00:30 UTC) comes before 02:10 winter time (01:10 UTC).
  assert.equal(compareTime('2026-10-25T02:30:00+02:00', '2026-10-25T02:10:00+01:00'), -1);
  assert.equal(compareTime('2026-09-28T22:00:00Z', '2026-09-29T00:00:00+02:00'), 0);
  assert.equal(compareTime(null, '2026-09-28T22:00:00Z'), -1, 'missing times sort first');
  assert.equal(compareTime(undefined, ''), 0);
  const sorted = ['2026-09-28T22:00:00Z', '2026-09-28T23:30:00+02:00', '2026-09-28T21:45:00+00:00'].sort(compareTime);
  assert.deepEqual(sorted, ['2026-09-28T23:30:00+02:00', '2026-09-28T21:45:00+00:00', '2026-09-28T22:00:00Z']);
});

test('no code orders ISO times as strings: localeCompare on a time field (A12 INV-10)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '../..');
  const TIME_FIELD = /\.(?:\w*_at|at|\w*seen|created|updated|modified|added|since|until|expires|when|time)\??\.localeCompare\(/;
  const offenders: string[] = [];
  for (const dir of ['lib', 'server', 'mcp', 'web/src'])
    for (const f of fs.globSync('**/*.{ts,tsx}', { cwd: path.join(root, dir) }))
      fs.readFileSync(path.join(root, dir, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (TIME_FIELD.test(line)) offenders.push(`${dir}/${f}:${i + 1}`);
        });
  assert.deepEqual(offenders, [], 'sort times with compareTime (lib/time.ts): a string order is wrong across offsets and DST');
});

test('insights count a verification written in another offset than the fix', async () => {
  const { insights } = await import('../../lib/insights.ts');
  const reply = (status: string, by: string, at: string) => ({ by, status, text: '', at });
  const review = {
    video: '/x/spot.mp4',
    project: 'Acme',
    versions: [{ v: 1, hash: 'h1' }],
    comments: [
      {
        id: 'c_1',
        v: 1,
        frame: 0,
        severity: 'must',
        status: 'verified',
        author: 'tester',
        created: '2026-09-28T20:30:00+00:00',
        replies: [reply('fixed', 'agent:edit', '2026-09-28T23:30:00+02:00'), reply('verified', 'tester', '2026-09-28T22:00:00Z')],
      },
    ],
  } as unknown as Review;
  const t = insights([review]).turnaround;
  assert.equal(t.fixHours, 1);
  assert.equal(t.verifyHours, 0.5, 'verified 30 minutes after the fix, although its string sorts before it');
});

test('presentedFrame: the frame on screen, whether the browser reports its start (Chrome, WebKit) or the seek target (Firefox)', () => {
  for (const fps of [24, 25, 29.97, 30, 50, 59.94, 60]) {
    for (const n of [0, 1, 2, 3, 47, 300, 1799]) {
      assert.equal(presentedFrame(n / fps, fps), n, `start of ${n} @${fps}`);
      assert.equal(presentedFrame(frameSeekTime(n, fps), fps), n, `middle of ${n} @${fps} (Firefox reports the seek target)`);
      assert.equal(presentedFrame(n / fps - 1e-4 / fps, fps), n, `a hair before ${n} @${fps} (timebase rounding)`);
      assert.equal(presentedFrame((n + 0.94) / fps, fps), n, `late in ${n} @${fps}`);
    }
  }
  // Rounding read Firefox's middle of frame 3 at 25 fps (0.14 s) as frame 4: the cause of the rocking picture.
  assert.equal(presentedFrame(0.14, 25), 3);
  assert.equal(presentedFrame(-0.001, 25), 0);
});
