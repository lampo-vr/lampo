// Starting the assigned agent decides "is it running already?" from the sessions as they are now, never from the list
// the app shows (server/sessionCache.ts: refreshed only when someone looks, and the first look answers after a second
// with whatever it has). The inventory here is a stand-in (the real one runs `claude agents --json`, never run here);
// the server context holds only what startAgent reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeSession } from '../../lib/types.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const { createSessionCache } = await import('../../server/sessionCache.ts');
const { startAgent } = await import('../../server/wake.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const running = { name: 'cut-agent', sessionId: ID, pid: 4242, cwd: dir, kind: 'interactive', status: 'working' } as ClaudeSession;
const review = { video: `${dir}/reel.mp4`, versions: [{ v: 1 }], session: { id: ID, name: 'cut-agent', cwd: dir, agent: 'claude-code' } } as never;
const req = { auth: { via: 'local' } } as never;

function harness(load: () => Promise<ClaudeSession[]>) {
  const sessions = createSessionCache(() => {}, load);
  const starts: unknown[] = [];
  const ctx = {
    hosted: false,
    capabilities: { wakeAgents: true },
    sessions,
    actor: () => 'owner',
    agentRuns: {
      start: (o: unknown) => {
        starts.push(o);
        return { id: `run_${starts.length}` };
      },
    },
  } as never;
  return { sessions, starts, ctx };
}

/** Pretends the list was last asked for long ago (nothing refreshes it on a timer). */
async function minutesLater<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test('the first inventory takes longer than the list’s first wait: Start waits for it and starts nothing when the agent runs', async () => {
  let release: (s: ClaudeSession[]) => void = () => {};
  const { sessions, starts, ctx } = harness(() => new Promise((r) => (release = r)));
  sessions.refresh(); // the app warms it at start
  const asked = startAgent(req, ctx, 'reel', review, 'please fix the logo');
  setTimeout(() => release([running]), 1500); // `claude agents --json` answers after the list's first second
  assert.equal(await asked, null, 'it was running: it hears the request the usual way');
  assert.equal(starts.length, 0);
});

test('a list last asked for minutes ago doesn’t know a session started since: Start asks again and starts nothing', async () => {
  let calls = 0;
  const { sessions, starts, ctx } = harness(() => Promise.resolve(++calls === 1 ? [] : [running]));
  await sessions.refresh(); // nothing running then
  assert.equal(await minutesLater(() => startAgent(req, ctx, 'reel', review, 'please fix the logo')), null);
  assert.equal(starts.length, 0);
  assert.equal(calls, 2, 'asked afresh');
});

test('a session that ended since the list was made is started', async () => {
  let calls = 0;
  const { sessions, starts, ctx } = harness(() => Promise.resolve(++calls === 1 ? [running] : []));
  await sessions.refresh(); // it was running then
  const got = await minutesLater(() => startAgent(req, ctx, 'reel', review, 'please fix the logo'));
  assert.deepEqual(got, { id: 'run_1' });
  assert.equal(starts.length, 1);
});
