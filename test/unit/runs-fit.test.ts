// A runs file over its bytes always comes back within them, quickly — whatever it holds: open runs at work (never
// dropped) with two steps or fifty, and a runs.jsonl already too big on disk (one written before the bounds) on its
// first write. Each case runs in a child process with a time limit, so a write that never returns fails the test
// instead of holding the suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, ROOT } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const runs = await import('../../lib/runs.ts');

const video = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));

/** Runs `body` (TypeScript, with `lib` = lib/runs.ts) in a child on this store; its last line is JSON. */
function child(body: string): { status: number | null; out: Record<string, number> | null; err: string } {
  const file = path.join(dir, `fit-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, `const lib = await import(${JSON.stringify(path.join(ROOT, 'lib/runs.ts'))});\n${body}\n`);
  // SIGKILL: a busy loop never gets to Node's own SIGTERM handling
  const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  return { status: r.status, out: last.startsWith('{') ? JSON.parse(last) : null, err: `${r.stderr}${r.error ? String(r.error) : ''}` };
}

/**
 * Open runs at work, `steps` steps each: what no rule may drop but their steps. Their first and newest steps hold `bytes`
 * of words (what halving keeps longest), the ones between a little.
 */
const atWork = (count: number, steps: number, bytes: number) => `
const now = Date.now();
const list = Array.from({ length: ${count} }, (_, i) => {
  const r = lib.newRun({ slug: ${JSON.stringify(slug)}, agent: lib.runAgent('agent-' + i), opened_by: { who: 'tester', how: 'send' }, state: 'working' }, now);
  r.steps = Array.from({ length: ${steps} }, (_, n) => ({ text: 'x'.repeat(n === 0 || n === ${steps} - 1 ? ${bytes} : 100) + n, at: new Date(now).toISOString(), type: 'action' }));
  return r;
});`;

for (const [steps, bytes] of [
  [2, 18_500],
  [50, 18_500],
] as const)
  test(`open runs at work with ${steps} steps each, over the bytes: back within them, quickly`, () => {
    const r = child(`${atWork(30, steps, bytes)}
const h = { runs: list, raw: [] };
const t = Date.now();
const lines = lib.fitRuns(h, lib.RUN_LIMITS.runs, now);
const size = lines.reduce((n, l) => n + l.length + 1, 0);
console.log(JSON.stringify({ ms: Date.now() - t, size, kept: h.runs.length, steps: h.runs.reduce((n, x) => n + x.steps.length, 0) }));`);
    assert.equal(r.status, 0, `the write never came back (or failed): ${r.err.slice(0, 400)}`);
    assert.ok(r.out);
    assert.ok(r.out.size <= runs.RUN_LIMITS.fileBytes, `${r.out.size} bytes`);
    assert.equal(r.out.kept, 30, 'no run at work is dropped: only steps go');
    assert.ok(r.out.ms < 5000, `${r.out.ms} ms`);
  });

test('open runs whose heads alone are over the bytes (nothing left to take): written as they are, and the write returns', () => {
  // nothing a pass may drop or shorten: every one is at work and has no steps; only the guard ends the loop
  const r = child(`${atWork(30, 0, 0)}
for (const x of list) x.request = 'r'.repeat(40_000);
const h = { runs: list, raw: [] };
const t = Date.now();
const lines = lib.fitRuns(h, lib.RUN_LIMITS.runs, now);
console.log(JSON.stringify({ ms: Date.now() - t, size: lines.reduce((n, l) => n + l.length + 1, 0), kept: h.runs.length }));`);
  assert.equal(r.status, 0, `the write never came back (or failed): ${r.err.slice(0, 400)}`);
  assert.ok(r.out);
  assert.ok(r.out.size > runs.RUN_LIMITS.fileBytes, 'over, as it was: nothing of runs at work is dropped');
  assert.equal(r.out.kept, 30);
});

test('the bytes are counted as the file holds them (UTF-8), not as characters', () => {
  // 30 open runs whose steps say "€" (three bytes each in the file, one character): over the bytes, under in characters
  const r = child(`import fs from 'node:fs';
${atWork(30, 50, 0)}
for (const x of list) x.steps = x.steps.map((s, n) => ({ ...s, text: '€'.repeat(n === 0 || n === 49 ? 6_000 : 30) }));
fs.writeFileSync(lib.runsFile(${JSON.stringify(slug)}), '');
lib.changeRuns(${JSON.stringify(slug)}, (all) => all.splice(0, all.length, ...list));
lib.flushRuns(${JSON.stringify(slug)});
console.log(JSON.stringify({ size: fs.statSync(lib.runsFile(${JSON.stringify(slug)})).size }));`);
  assert.equal(r.status, 0, r.err.slice(0, 400));
  assert.ok(r.out);
  assert.ok(r.out.size <= runs.RUN_LIMITS.fileBytes, `${r.out.size} bytes on disk`);
});

test('a runs.jsonl already over its bytes on disk loads, and its first write comes back within them', () => {
  const r = child(
    `${atWork(30, 2, 18_500)}
fs.writeFileSync(lib.runsFile(${JSON.stringify(slug)}), list.map((x) => JSON.stringify(x)).join('\\n') + '\\n');
const before = fs.statSync(lib.runsFile(${JSON.stringify(slug)})).size;
const t = Date.now();
lib.changeRuns(${JSON.stringify(slug)}, () => {});
lib.flushRuns(${JSON.stringify(slug)});
console.log(JSON.stringify({ before, ms: Date.now() - t, size: fs.statSync(lib.runsFile(${JSON.stringify(slug)})).size, kept: lib.readRuns(${JSON.stringify(slug)}).length }));`.replace(
      /^/,
      "import fs from 'node:fs';\n",
    ),
  );
  assert.equal(r.status, 0, `the write never came back (or failed): ${r.err.slice(0, 400)}`);
  assert.ok(r.out);
  assert.ok(r.out.before > runs.RUN_LIMITS.fileBytes, 'it was over to begin with');
  assert.ok(r.out.size <= runs.RUN_LIMITS.fileBytes, `${r.out.size} bytes`);
  assert.equal(r.out.kept, 30);
});

test('halving steps always leaves fewer: the first and the newest, none of two or one', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `s${i}`, at: '', type: 'action' as const }));
  assert.deepEqual(runs.halved(s(1)), []);
  assert.deepEqual(runs.halved(s(2)), []);
  assert.deepEqual(
    runs.halved(s(3)).map((x) => x.text),
    ['s0', 's2'],
  );
  assert.deepEqual(
    runs.halved(s(50)).map((x) => x.text),
    ['s0', ...Array.from({ length: 24 }, (_, i) => `s${26 + i}`)],
  );
  for (let n = 1; n <= 300; n++) assert.ok(runs.halved(s(n)).length < n, `${n}`);
});
