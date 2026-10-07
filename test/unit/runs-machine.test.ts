// A run this machine started, from the outside: its process is stopped from the machine itself only (as at
// /api/agent-runs/:id/stop) — the LAN link and an API token can't end it, the machine can; its start joins the run its
// agent has open on the video instead of opening a second one; and what Lampo says of the process (started, finished)
// is a step, never the run's state. The `claude` here is a stand-in: the real CLI is never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Run } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// The stand-in: waits while ./hold exists, then exits.
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(stub, `#!/bin/sh\nd="$(dirname "$0")"\nwhile [ -f "$d/hold" ]; do sleep 0.05; done\nexit 0\n`, { mode: 0o755 });
process.env.VR_CLAUDE_BIN = stub;
const hold = path.join(dir, 'bin', 'hold');

const store = await import('../../lib/store.ts');
const auth = await import('../../lib/auth.ts');
const lib = await import('../../lib/runs.ts');
const { slugify } = await import('../../lib/paths.ts');
const { words } = await import('../../lib/activityText.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const project = path.join(dir, 'proj');
const video = makeVideo(path.join(project, 'export/spot.mp4'), { dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
store.assignSession(slug, { name: 'spot-edit', sessionId: ID, cwd: project, agent: 'claude-code' }, 'tester');

const LAN = 'lan-token-runs';
const { ctx, port } = await startApp({ lan: true, token: LAN, loadSessions: async () => [], feed: 30 });
after(() => {
  fs.rmSync(hold, { force: true });
  ctx.agentRuns.stopAll();
});

function request(method: string, url: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; json: () => { run?: Run & { id: string } } }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
const remote = { 'x-forwarded-for': '203.0.113.9' };
const phone = { ...remote, cookie: `vr_t=${LAN}`, origin: `http://127.0.0.1:${port}` };

test('a process this machine runs for a run is stopped from the machine only: never the LAN link or a token', async () => {
  fs.writeFileSync(hold, '');
  const started = await request('POST', `/api/review/${encodeURIComponent(slug)}/request`, { body: { text: 'Go', start: true } });
  assert.equal(started.status, 200);
  const id = started.json().run?.id as string;
  await until(() => ctx.agentRuns.get(id)?.state === 'running', 'the process');
  // the phone on the LAN link (the person, signed in by the link) and an API token: refused, nothing changes
  await request('GET', `/api/library?t=${LAN}`, { headers: remote });
  const lan = await request('POST', `/api/runs/${id}/stop`, { headers: phone, body: {} });
  assert.equal(lan.status, 403);
  const owner = auth.localOwner();
  assert.ok(owner);
  const token = await request('POST', `/api/runs/${id}/stop`, { headers: { authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` }, body: {} });
  assert.equal(token.status, 403);
  assert.equal(ctx.agentRuns.get(id)?.state, 'running');
  assert.equal(ctx.runs.find(id)?.run.ended, null, 'the run goes on');
  // the machine itself stops it, process and all
  const here = await request('POST', `/api/runs/${id}/stop`, { body: {} });
  assert.equal(here.status, 200);
  assert.equal(here.json().run?.state, 'stopped');
  await until(() => ctx.agentRuns.get(id)?.state === 'stopped', 'the process to end');
  fs.rmSync(hold, { force: true });
});

test('a start for an agent with a run open on the video joins that run; Lampo’s lines about its process are steps', async () => {
  // the agent is at the video (its own write opened its run), then the machine starts it for a request without a run
  ctx.activity.record({ at: new Date().toISOString(), agent: 'spot-edit', kind: 'note', ...words('Added a note'), target: null, video: slug });
  const open = ctx.runs.list(slug).find((r) => r.ended === null && r.agent.name === 'spot-edit') as Run;
  assert.ok(open);
  fs.writeFileSync(hold, '');
  const id = ctx.runs.machineStarted(
    { id: 'run_aaaaaaaaaaaa', slug, name: 'spot-edit', session_id: ID, cwd: project, by: 'tester', started: '', ended: null, state: 'running', exit: null },
    undefined,
  );
  assert.equal(id, open.id, 'one open run per agent and video');
  assert.equal(ctx.runs.list(slug).filter((r) => r.ended === null && r.agent.name === 'spot-edit').length, 1);
  // "Started by Lampo" while it starts: a step; its state stays the process's
  const r = lib.newRun({ slug, agent: lib.runAgent('x'), opened_by: { who: 'tester', how: 'request' }, delivery: 'machine', state: 'starting' });
  assert.deepEqual(lib.applySign(r, { at: Date.now(), kind: 'run', words: words('Started by Lampo') }), []);
  assert.equal(r.state, 'starting');
  assert.equal(r.steps.at(-1)?.key, 'Started by Lampo');
  fs.rmSync(hold, { force: true });
  ctx.runs.stop(open.id, 'tester');
});
