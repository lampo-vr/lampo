// Picking frames by number with ffmpeg's `select` (lib/probe.ts `selectFrames`): Auto-check's samples (lib/qa.ts
// `extractFrames`) and footage search's keyframes. FFmpeg 5.1.9, 7.1.4, 8.0.2 and later refuse an expression nested more
// than 100 deep; the old `eq(n,a)+eq(n,b)+…` nested one level per frame, so every video over about 50 s failed its
// Auto-check ("Error reinitializing filters!") on a server with such an ffmpeg. The expression must stay shallow and
// still pick exactly the frames asked for. VR_FFMPEG=<an ffmpeg with the limit> runs the clip test against it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Version } from '../../lib/types.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { selectFrames, probeSync, quickHash } = await import('../../lib/probe.ts');
const { extractFrames } = await import('../../lib/qa.ts');

/** FFmpeg's limit on an expression's depth (libavutil/eval.c MAX_DEPTH). */
const MAX_DEPTH = 100;

interface Node {
  depth: number;
  value: (n: number) => number;
}

/**
 * The part of FFmpeg's expression language `select` sees here (libavutil/eval.c), read the way it reads it: a number or
 * a name is 0 deep, a function one more than its deepest argument, `a+b` and `a*b` one more than the deeper side,
 * parentheses add nothing. The filter graph's `\,` is a plain comma by the time the expression is parsed.
 */
function parse(src: string): Node {
  const s = src.replace(/\\,/g, ',').replace(/\s+/g, '');
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`${why} at ${i} in ${s.slice(0, 80)}`);
  };
  const bin = (a: Node, b: Node, op: (x: number, y: number) => number): Node => ({
    depth: Math.max(a.depth, b.depth) + 1,
    value: (n) => op(a.value(n), b.value(n)),
  });
  const FUNCS: Record<string, (a: number[]) => number> = {
    eq: ([a, b]) => Number(a === b),
    between: ([x, a, b]) => Number((a as number) <= (x as number) && (x as number) <= (b as number)),
    mod: ([a, b]) => (a as number) - Math.floor((a as number) / (b as number)) * (b as number),
    not: ([a]) => Number(a === 0),
  };
  function primary(): Node {
    let sign = 1;
    if (s[i] === '-' || s[i] === '+') sign = s[i++] === '-' ? -1 : 1;
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      const v = sign * Number(num[0]);
      return { depth: 0, value: () => v };
    }
    if (s[i] === '(') {
      i++;
      const inner = sum();
      if (s[i++] !== ')') fail("missing ')'");
      return sign < 0 ? { depth: inner.depth, value: (n) => -inner.value(n) } : inner;
    }
    const name = /^[a-z]+/.exec(s.slice(i))?.[0] ?? fail('a name');
    i += name.length;
    if (name === 'n' && s[i] !== '(') return { depth: 0, value: (n) => sign * n };
    const f = FUNCS[name] ?? fail(`unknown function ${name}`);
    if (s[i++] !== '(') fail("missing '('");
    const args = [sum()];
    while (s[i] === ',') {
      i++;
      args.push(sum());
    }
    if (s[i++] !== ')') fail("missing ')'");
    return { depth: Math.max(...args.map((a) => a.depth + 1)), value: (n) => sign * f(args.map((a) => a.value(n))) };
  }
  function product(): Node {
    let a = primary();
    while (s[i] === '*') {
      i++;
      a = bin(a, primary(), (x, y) => x * y);
    }
    return a;
  }
  function sum(): Node {
    let a = product();
    // a '-' is the next term's sign, as in FFmpeg: a + (-b)
    while (s[i] === '+' || s[i] === '-') {
      if (s[i] === '+') i++;
      a = bin(a, product(), (x, y) => x + y);
    }
    return a;
  }
  const root = sum();
  if (i !== s.length) fail('left over');
  return root;
}

/** The frames an expression passes, from 0 to `to`. */
const passes = (expr: string, to: number): number[] => {
  const e = parse(expr);
  const out: number[] = [];
  for (let n = 0; n <= to; n++) if (e.value(n) !== 0) out.push(n);
  return out;
};

const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

test('the mirror of FFmpeg reads depth as FFmpeg does: the old flat sum of 101 frames is past the limit', () => {
  const flat = Array.from({ length: 101 }, (_, k) => `eq(n\\,${k * 15})`).join('+');
  assert.equal(parse(flat).depth, 101, 'one level per frame (and one for eq itself)');
  assert.equal(parse('eq(n\\,3)').depth, 1);
  assert.equal(parse('(eq(n\\,3)+eq(n\\,4))').depth, 2, 'parentheses add nothing');
  assert.deepEqual(
    passes(flat, 1600),
    Array.from({ length: 101 }, (_, k) => k * 15),
  );
});

test('selectFrames passes exactly the frames asked for, a few levels deep however many', () => {
  let seed = 7;
  const rand = (k: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % k;
  };
  const cases: number[][] = [
    [0],
    [5],
    [3, 3, 3],
    [10, 2],
    [0, 1, 2, 3, 4],
    [4, 8, 12, 13, 14, 15, 30, 31],
    Array.from({ length: 107 }, (_, k) => k * 15), // Auto-check's samples of 1,600 frames at 30 fps
    Array.from({ length: 2000 }, (_, k) => k * 12), // a long video's
    Array.from({ length: 150 }, () => rand(5000)), // frames after cuts: anywhere
    [...Array.from({ length: 40 }, (_, k) => k * 15), ...Array.from({ length: 60 }, () => rand(3000)), 2999, 3000, 3001],
  ];
  for (const frames of cases) {
    const expr = selectFrames(frames);
    const want = sorted(frames);
    const last = want.at(-1) as number;
    assert.deepEqual(passes(expr, last + 40), want, `exactly ${want.slice(0, 8).join(', ')}…`);
    assert.ok(parse(expr).depth <= 30, `depth ${parse(expr).depth} for ${want.length} frames`);
  }
  // a four-hour render at 240 fps, sampled every 120 frames, stays far from the limit
  const huge = Array.from({ length: 28_800 }, (_, k) => k * 120);
  assert.ok(parse(selectFrames(huge)).depth < 10);
  const scattered = Array.from({ length: 30_000 }, (_, k) => k * 7 + (k % 3));
  assert.ok(parse(selectFrames(scattered)).depth < MAX_DEPTH / 3, `scattered: ${parse(selectFrames(scattered)).depth}`);
});

test("Auto-check's samples of a video over 50 s: exactly the frames asked for, with a select ffmpeg accepts", { timeout: 120_000 }, async () => {
  // 1,602 frames at 30 fps: every 15th frame is 107 samples, past the old sum's 100
  const file = makeVideo(path.join(dir, 'long.mp4'), { w: 160, h: 90, fps: 30, dur: 53.4, audio: false, pattern: 'testsrc2' });
  const m = probeSync(file);
  const ver: Version = {
    ...{ v: 1, hash: quickHash(file), mtime: '', size: fs.statSync(file).size, registered: '' },
    ...{ fps: m.fps, width: m.width, height: m.height, frames: m.frames, duration: m.duration },
  };
  assert.ok(ver.frames > 1600, `${ver.frames} frames`);
  const work = fs.mkdtempSync(path.join(dir, 'frames-'));
  const regular: number[] = [];
  for (let f = 0; f < ver.frames; f += 15) regular.push(f);
  // frames after cuts are anywhere (lib/qa.ts: a few frames into each shot, unless a regular sample is close)
  const extra = Array.from({ length: 107 }, (_, k) => k * 15 + 4 + (k % 8)).filter((f) => f < ver.frames && !regular.some((r) => Math.abs(r - f) <= 3));
  assert.ok(extra.length > 100, `${extra.length} frames after cuts`);
  for (const [prefix, frames] of [
    ['r', regular],
    ['c', extra],
  ] as const) {
    const got = await extractFrames(file, ver, frames, work, prefix);
    assert.deepEqual(
      got.map((x) => x.frame),
      sorted(frames),
      `${prefix}: the frames asked for`,
    );
    for (const x of got) assert.ok(fs.statSync(x.file).size > 0);
    const script = fs.readFileSync(path.join(work, `${prefix}.filter`), 'utf8');
    const expr = /^select='([^']*)'/.exec(script)?.[1] ?? '';
    assert.ok(parse(expr).depth <= MAX_DEPTH, `${prefix}: select is ${parse(expr).depth} deep, FFmpeg refuses more than ${MAX_DEPTH}`);
  }
});
