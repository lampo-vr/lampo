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
  const sessions = createSessionCache(() => {}, load, { againMs: 20 });
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
  // `claude agents --json` answers after the list's first second, every time it is asked
  const { sessions, starts, ctx } = harness(() => new Promise((r) => setTimeout(() => r([running]), 1500)));
  sessions.refresh(); // the app warms it at start
  assert.equal(await startAgent(req, ctx, 'reel', review, 'please fix the logo'), null, 'it was running: it hears the request the usual way');
  assert.equal(starts.length, 0);
});

test('an inventory already on its way when Start is pressed is waited out and asked again: a session started meanwhile is not started twice', async () => {
  const pending: ((s: ClaudeSession[]) => void)[] = [];
  let calls = 0;
  const { sessions, starts, ctx } = harness(() => {
    calls++;
    return new Promise((r) => pending.push(r));
  });
  sessions.refresh(); // someone opened the library: the list is being made, and the agent isn't running yet
  // the person starts the session in their terminal, then presses Start while that list is still being made
  const asked = startAgent(req, ctx, 'reel', review, 'please fix the logo');
  await new Promise((r) => setImmediate(r));
  pending.shift()?.([]); // the list from before: it doesn't know the session
  while (!pending.length) await new Promise((r) => setTimeout(r, 5));
  pending.shift()?.([running]); // asked again: it runs
  assert.equal(await asked, null, 'it runs: it hears the request the usual way');
  assert.equal(starts.length, 0, 'never a second copy of a running session');
  assert.equal(calls, 2, 'asked again after the load from before');
});

test('an inventory that fails is never "not running": asked again, and refused when it keeps failing', async () => {
  let calls = 0;
  const flaky = harness(() => (++calls === 2 ? Promise.reject(new Error('claude agents failed')) : Promise.resolve(calls === 1 ? [] : [running])));
  await flaky.sessions.refresh(); // nothing running then
  assert.equal(await minutesLater(() => startAgent(req, flaky.ctx, 'reel', review, 'please fix the logo')), null, 'asked again after the failure');
  assert.equal(flaky.starts.length, 0);
  assert.equal(calls, 3);

  const down = harness(() => Promise.reject(new Error('claude agents failed')));
  await down.sessions.refresh();
  await assert.rejects(
    minutesLater(() => startAgent(req, down.ctx, 'reel', review, 'please fix the logo')),
    (e: Error & { status?: number }) => e.status === 503 && /try again/.test(e.message),
  );
  assert.equal(down.starts.length, 0, 'nothing started on a list that couldn’t be made');
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
