// Auto-check's black frames on synthetic footage (lib/qa.ts, lib/findings.ts `BLACK`): a dark night sky is dark, not
// black, at limited and at full range; a few black frames are a gap only between shots (bright or dark ones); a dark
// scene cut to a dark scene is no gap; a fade to black and back is a dip, a fade inside a dark shot isn't. Every range
// is checked against the frames ffmpeg decodes at those numbers (`select=eq(n,N)`).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FrameRange, QaItem, Version } from '../../lib/types.ts';
import { encodeOnce, FFMPEG, isolatedEnv, must, rawRgb } from '../lib/helpers.ts';

// no text engines: the picture is what this is about
const { dir } = isolatedEnv({ vars: { VR_OCR: 'off' } });
const { runQa, cachedQa, QA_VERSION } = await import('../../lib/qa.ts');
const { BLACK, LIMITS } = await import('../../lib/findings.ts');
const { analysisRows, probeSync, quickHash } = await import('../../lib/probe.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { cacheDir } = await import('../../lib/paths.ts');

const W = 640;
const H = 360;
const FPS = 25;
const ROWS = analysisRows(64, W, H);

// A night sky: dark navy (an average luma of about 28 as signalstats reads it), grain, a few stars, and a comet that
// climbs up and to the right — a bright head and a tail that shrinks for a few frames every 2.4 s. Under the rule
// before this one (98 % of the picture below a tenth of full luma) those few frames were black.
const STARS = [
  [50, 40, 3],
  [210, 90, 2],
  [400, 30, 3],
  [560, 120, 2],
  [120, 200, 2],
  [330, 170, 3],
]
  .map(([x, y, s]) => `drawbox=x=${x}:y=${y}:w=${s}:h=${s}:color=0xd0d8ff:t=fill`)
  .join(',');
const TAIL = '(300-240*exp(-pow((mod(N\\,60)-30)/2\\,2)))';
const sky = (dur: number) => [
  ...['-f', 'lavfi', '-i', `color=c=0x060c22:s=${W}x${H}:r=${FPS}:d=${dur}`],
  ...[
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=320x40:r=${FPS}:d=${dur},format=rgba,geq=r=255:g=244:b=224:a='255*clip(1-(W-1-X)/${TAIL}\\,0\\,1)*clip(1-abs(Y-20)/20\\,0\\,1)'`,
  ],
];
const SKY = `[0:v]noise=alls=6:allf=t,${STARS}[bg];[bg][1:v]overlay=x='20+n*1.6':y='280-n*0.9':shortest=1[sky]`;
// a dark room: brown-black with grain and one small lamp
const room = (dur: number) => ['-f', 'lavfi', '-i', `color=c=0x0d0a08:s=${W}x${H}:r=${FPS}:d=${dur}`];
const ROOM = (input: number) => `[${input}:v]noise=alls=8:allf=t,drawbox=x=500:y=120:w=24:h=30:color=0xffd890:t=fill[room]`;
const blackOn = (from: number, to: number) => `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,${from},${to})'`;

const LIMITED = ['-pix_fmt', 'yuv420p', '-color_range', 'tv'];
// full range: the picture scaled to it, and said so
const FULL_GRAPH = ',scale=out_range=pc,format=yuv420p';
const FULL = ['-pix_fmt', 'yuv420p', '-color_range', 'pc'];

function encode(name: string, inputs: string[], graph: string, out: string[] = ['-pix_fmt', 'yuv420p']): string {
  return encodeOnce(path.join(dir, `${name}.mp4`), [
    ...['-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[v]'],
    ...['-c:v', 'libx264', '-crf', '20', '-g', '50', ...out],
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

async function blacks(file: string): Promise<{ ver: Version; items: QaItem[] }> {
  const { ver, meta } = versionOf(file);
  const r = await runQa(file, ver, meta);
  return { ver, items: r.items.filter((x) => x.kind === 'black-frames') };
}

const said = (items: QaItem[]) => JSON.stringify(items.map(({ key, severity, likely, why, range, text }) => ({ key, severity, likely, why, range, text })));

/** Mean luma (0–255) and lit share of one frame, as ffmpeg decodes frame `n` (the scan's size and scaling). */
function frameAt(file: string, n: number): { mean: number; lit: number } {
  const rgb = rawRgb(['-i', file, '-vf', `select=eq(n\\,${n}),scale=64:${ROWS}:flags=area`]);
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const y = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    sum += y;
    if (y >= BLACK.lit) lit++;
  }
  return { mean: sum / (rgb.length / 3), lit: lit / (rgb.length / 3) };
}
const blackAt = (file: string, n: number) => {
  const f = frameAt(file, n);
  return f.mean <= BLACK.mean && f.lit <= BLACK.litShare;
};

/** The finding's range is the black frames ffmpeg decodes at those numbers: black from its first to its last, not around it. */
function exact(file: string, r: FrameRange): void {
  for (const n of [r.in, r.out]) assert.ok(blackAt(file, n), `frame ${n} decodes black: ${JSON.stringify(frameAt(file, n))}`);
  for (const n of [r.in - 1, r.out + 1]) assert.ok(!blackAt(file, n), `frame ${n} decodes as picture: ${JSON.stringify(frameAt(file, n))}`);
}

/** Runs the rule before this one took for black (≥ 98 % of the picture below luma 25.5), inside the video's edges. */
function oldRuleRuns(file: string): FrameRange[] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `scale=64:${ROWS}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1 << 28,
  });
  const size = 64 * ROWS * 3;
  const dark: boolean[] = [];
  for (let o = 0; o + size <= raw.length; o += size) {
    let below = 0;
    for (let i = o; i < o + size; i += 3) if (0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2] < 25.5) below++;
    dark.push(below / (size / 3) >= 0.98);
  }
  const edge = Math.round(LIMITS.edgeSeconds * FPS);
  const runs: FrameRange[] = [];
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i]) continue;
    let j = i;
    while (j + 1 < dark.length && dark[j + 1]) j++;
    if (j > i && i >= edge && j < dark.length - edge) runs.push({ in: i, out: j });
    i = j;
  }
  return runs;
}

/** The average luma signalstats reads (Y, 0–255 code values): what an agent measuring the render sees. */
function yavg(file: string): number {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const v = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return v.reduce((a, b) => a + b, 0) / v.length;
}

test('a dark night sky with a comet climbing through it, 10 s in one shot, has no black frames', async () => {
  const file = encode('sky', sky(10), `${SKY};[sky]null[v]`);
  // the shape of the false finding: an average luma of about 28, and frames the earlier rule took for black gaps
  const y = yavg(file);
  assert.ok(y > 24 && y < 32, `an average luma of about 28: ${y}`);
  const old = oldRuleRuns(file);
  assert.ok(
    old.some((r) => r.out - r.in + 1 <= Math.round(FPS * LIMITS.blackGapSeconds)),
    `the earlier rule saw a black gap in it: ${JSON.stringify(old)}`,
  );
  const { ver, items } = await blacks(file);
  assert.equal(ver.frames, 250);
  assert.deepEqual(items, [], `no black frames: ${said(items)}`);
});

test('the same dark sky at limited and at full range: no black frames, the same picture', async () => {
  const limited = encode('sky-limited', sky(10), `${SKY};[sky]null[v]`, LIMITED);
  const full = encode('sky-full', sky(10), `${SKY};[sky]null${FULL_GRAPH}[v]`, FULL);
  assert.equal(probeSync(full).color_range, 'pc');
  for (const file of [limited, full]) {
    const { items } = await blacks(file);
    assert.deepEqual(items, [], `${path.basename(file)}: ${said(items)}`);
  }
  // scaled to RGB, the full-range sky reads within a few levels of the limited one, far above a black frame's mean
  for (const n of [0, 30, 140]) {
    const a = frameAt(limited, n);
    const b = frameAt(full, n);
    assert.ok(Math.abs(a.mean - b.mean) < 2.5 && Math.min(a.mean, b.mean) > 2 * BLACK.mean, `frame ${n}: ${JSON.stringify({ limited: a, full: b })}`);
  }
});

test('two black frames between two shots are a gap, at limited and at full range', async () => {
  // shot A (testsrc2) up to frame 99, black 100–101, shot B (colour bars) from 102
  const inputs = ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=5`, '-f', 'lavfi', '-i', `smptehdbars=s=${W}x${H}:r=${FPS}:d=5`];
  const graph = `[0:v][1:v]overlay=enable='gte(n,102)'[ab];[ab]${blackOn(100, 101)}`;
  const files = [encode('gap', inputs, `${graph}[v]`, LIMITED), encode('gap-full', inputs, `${graph}${FULL_GRAPH}[v]`, FULL)];
  for (const file of files) {
    const { items } = await blacks(file);
    assert.deepEqual(
      items.map(({ key, kind, severity, frame, range, text, likely, why }) => ({ key, kind, severity, frame, range, text, likely, why })),
      [
        {
          key: 'black:100',
          kind: 'black-frames',
          severity: 'should',
          frame: 100,
          range: { in: 100, out: 101 },
          text: 'Black gap of 2 frames between shots',
          likely: 'problem',
          why: 'black-gap',
        },
      ],
      path.basename(file),
    );
    exact(file, must(items[0].range));
  }
});

test('two black frames between two dark shots are a gap too', async () => {
  // the night sky up to frame 99, black 100–101, the dark room from 102: the steps to and from black are small, but
  // each is many times what the shot beside it moves
  const file = encode('dark-gap', [...sky(6), ...room(6)], `${SKY};${ROOM(2)};[sky][room]overlay=enable='gte(n,102)'[sr];[sr]${blackOn(100, 101)}[v]`);
  const { items } = await blacks(file);
  assert.deepEqual(
    items.map(({ key, range, why }) => ({ key, range, why })),
    [{ key: 'black:100', range: { in: 100, out: 101 }, why: 'black-gap' }],
    said(items),
  );
  exact(file, must(items[0].range));
});

test('a dark scene cut to a dark scene, nothing black between: no black frames', async () => {
  const file = encode('dark-cut', [...sky(6), ...room(6)], `${SKY};${ROOM(2)};[sky][room]overlay=enable='gte(n,75)'[v]`);
  assert.ok(oldRuleRuns(file).length > 0, 'the earlier rule saw black in it');
  const { items } = await blacks(file);
  assert.deepEqual(items, [], said(items));
});

test('a fade to black and back is a dip; a fade inside a dark shot is not', async () => {
  // testsrc2 fades out over frames 50–59 and back in over 75–84 (each fade only where it belongs: a fade out blackens
  // every frame after it, a fade in every frame before it)
  const dip = encode(
    'dip',
    ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=6`],
    "[0:v]fade=t=out:s=50:n=10:enable='lt(n,75)',fade=t=in:s=75:n=10:enable='gte(n,60)'[v]",
  );
  const { items } = await blacks(dip);
  assert.equal(items.length, 1, said(items));
  const d = items[0];
  assert.deepEqual([d.severity, d.likely, d.why], ['nice', 'intended', 'black-dip']);
  const r = must(d.range);
  assert.ok(r.in >= 58 && r.in <= 61 && r.out >= 74 && r.out <= 76, `the black between the fades: ${said(items)}`);
  assert.equal(d.key, `black:${r.in}`);
  assert.equal(d.text, `Dip to black for ${Math.round(((r.out - r.in + 1) / FPS) * 100) / 100} s: intended?`);
  exact(dip, r);

  // the night sky dims to half its light over half a second, stays there a second and comes back: the same shot
  const fade = (t: string, s: number) => `fade=t=${t}:s=${s}:n=12:c=0x04081a`;
  const dim = encode('sky-dims', sky(10), `${SKY};[sky]${fade('out', 100)}:enable='lt(n,137)',${fade('in', 137)}:enable='gte(n,112)'[v]`);
  assert.ok(
    oldRuleRuns(dim).some((x) => x.in <= 120 && x.out >= 130),
    'the earlier rule saw a dip in it',
  );
  const dark = await blacks(dim);
  assert.deepEqual(dark.items, [], said(dark.items));
});

test('a check from before this rule is made again: its false black gap goes', async () => {
  const file = encode('sky', sky(10), `${SKY};[sky]null[v]`);
  const { ver, meta } = versionOf(file);
  const cached = path.join(cacheDir(), 'qa', `${renderKey(ver)}.json`);
  const gap: QaItem = {
    key: 'black:29',
    kind: 'black-frames',
    severity: 'should',
    tags: ['cut'],
    frame: 29,
    range: { in: 29, out: 31 },
    text: 'Black gap of 3 frames between shots',
    likely: 'problem',
    why: 'black-gap',
  };
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, JSON.stringify({ qa_version: 3, hash: ver.hash, at: '', duration_ms: 0, samples: 0, text_language: null, items: [gap] }));
  assert.equal(cachedQa(ver), null, 'a result by the rules before is not used');
  const r = await runQa(file, ver, meta);
  assert.equal(r.qa_version, QA_VERSION);
  assert.deepEqual(
    r.items.filter((x) => x.kind === 'black-frames'),
    [],
  );
  assert.equal(must(cachedQa(ver)).qa_version, QA_VERSION);
});
