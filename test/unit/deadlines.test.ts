// Every tool Lampo runs has a deadline (A12 INV-7). The readiness check ran `ffmpeg -version` with none: a hung ffmpeg
// kept `/readyz` hanging, and the hosted health check waited instead of failing. `claude agents --json` ran under the
// one-hour media limit, and the library's first load waited for it on the machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// Never this machine's own Claude Code sessions: the fallback reads ~/.claude/sessions.
process.env.HOME = path.join(dir, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
// Stand-ins that never answer.
const bin = tmpdir();
const hang = path.join(bin, 'hang');
fs.writeFileSync(hang, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
process.env.VR_FFMPEG = hang;
process.env.VR_CLAUDE_BIN = hang;

const { createReadiness, READY_LIMITS } = await import('../../server/ready.ts');
const { listSessions } = await import('../../lib/sessions.ts');
const { createSessionCache } = await import('../../server/sessionCache.ts');

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

test('INV-7: a hung ffmpeg makes /readyz say "not ready" in time, instead of hanging', async () => {
  const was = READY_LIMITS.toolMs;
  READY_LIMITS.toolMs = 400;
  try {
    const readiness = createReadiness({ minFree: 0, stopping: () => false, cacheMs: 0 });
    const t = Date.now();
    const r = await within(readiness.check(), 5000);
    assert.equal(r.checks.ffmpeg, false);
    assert.equal(r.ok, false);
    assert.match(r.details.ffmpeg ?? '', /took longer than/);
    assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
  } finally {
    READY_LIMITS.toolMs = was;
  }
});

test('INV-7: a hung `claude agents` gives up and falls back to the session files', async () => {
  const t = Date.now();
  assert.deepEqual(await within(listSessions({ timeoutMs: 300 }), 5000), []);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});

test('INV-7: the first ask for the sessions waits a moment, not for the CLI', async () => {
  let told = 0;
  const cache = createSessionCache(
    () => {
      told++;
    },
    () => new Promise(() => {}),
    { firstWaitMs: 200 },
  );
  const t = Date.now();
  assert.deepEqual(await within(cache.get(), 5000), []);
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  assert.equal(cache.refreshing, true, 'the list keeps loading in the background');
  assert.equal(told, 0);
});
