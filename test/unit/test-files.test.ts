// What node:test needs from a unit test file on every Node we support (engines: 22.18 and newer). A file's top-level
// after() runs once the tests registered so far are done, and on Node 22 that can be while a later top-level await is
// still pending: the hook closes its server or client, and the tests below the await fail on it ("Not connected" from
// the MCP client in one-line.test.ts on CI's Node 22.18; Node 24 waited for the file). So a file with a top-level
// after() — startApp() registers one too (test/lib/app.ts) — awaits nothing at the top level below its first test
// once that hook is in place: imports go up with the others.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const UNIT = path.join(ROOT, 'test/unit');
// Biome formats every file: a top-level statement starts in the first column, and nothing inside a block does.
const TEST = /^test(\.(only|skip|todo))?\(/;
const HOOK = /^(after|afterEach)\(|^(const|let) .*= await startApp\(|^await startApp\(/;
const AWAITS = /^(const|let|var|await)\b.*\bawait\b/;

/** `file:line` for every top-level await below the first test with an after() registered above it. */
function lateAwaits(file: string, src: string): string[] {
  const lines = src.split('\n');
  const first = lines.findIndex((l) => TEST.test(l));
  if (first < 0) return [];
  const out: string[] = [];
  let hooked = lines.slice(0, first).some((l) => HOOK.test(l));
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (hooked && AWAITS.test(line)) out.push(`${file}:${i + 1}: ${line.slice(0, 80)}`);
    if (HOOK.test(line)) hooked = true;
  }
  return out;
}

test('no top-level await below the first test once an after() is registered (node:test on Node 22)', () => {
  const found = fs
    .readdirSync(UNIT)
    .filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) => lateAwaits(f, fs.readFileSync(path.join(UNIT, f), 'utf8')));
  assert.deepEqual(found, []);
});

test('the check finds the shape that failed, and lets a late startApp() and a hook-free file be', () => {
  const failed = [
    "const a = await import('a.ts');",
    "test('one', () => {});",
    'after(() => mcp.close());',
    "test('two', async () => {});",
    "const b = await import('b.ts');",
    "test('three', async () => {});",
  ].join('\n');
  assert.deepEqual(lateAwaits('x.test.ts', failed), ["x.test.ts:5: const b = await import('b.ts');"]);
  const startApp = ["test('one', () => {});", 'const { port } = await startApp();', "test('two', async () => {});"].join('\n');
  assert.deepEqual(lateAwaits('y.test.ts', startApp), [], 'its own after() comes with it, after the await');
  const twice = [startApp, 'const other = await startApp();'].join('\n');
  assert.equal(lateAwaits('z.test.ts', twice).length, 1, 'a second one waits while the first one’s after() is in place');
  const noHook = ["test('one', () => {});", "const b = await import('b.ts');"].join('\n');
  assert.deepEqual(lateAwaits('w.test.ts', noHook), []);
});
