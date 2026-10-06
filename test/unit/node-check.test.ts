// `npm start` / `npm test` on a Node that can't run TypeScript (an nvm default of 20 is common) must say what's wrong
// instead of dying on the first import with ERR_UNKNOWN_FILE_EXTENSION. A Node with type stripping switched off
// stands in for an old one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const check = path.join(ROOT, 'scripts/node-check.mjs');
const run = (args: string[], event: string) =>
  spawnSync(process.execPath, [...args, check], { encoding: 'utf8', env: { ...process.env, npm_lifecycle_event: event } });

test('a Node without TypeScript support gets the version it needs and the command to run instead', () => {
  const r = run(['--no-experimental-strip-types'], 'pretest');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node\.js 22\.18 or newer/);
  assert.match(r.stderr, /npm test|nvm install 24/, r.stderr);
  assert.equal(r.stdout, '');
});

test('a capable Node passes silently', () => {
  const r = run([], 'prestart');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
});
