// What moves agents' runs on the machine (server/runs.ts): every recorded activity joins the open run of its agent ×
// video (a read never opens one, an agent's own write does); LAMPO_RUN is a hint taken only for the same agent and
// video; a run sent to the video's agent is taken by the agent that turns up; the events every process writes (a
// version, statuses, the agent's question, the person's answer) move its plan and state; a run this machine starts
// carries LAMPO_RUN, keeps a log, ends by its process and stops through the runs API; over MCP, the wait that hands the
// work over begins it, and notes sent meanwhile end the agent's next answer with one line, once. `vr watch --all` gets
// lines of its own; INBOX.md and wait_for_feedback never carry run events. The `claude` here is a stand-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Run, RunDetail } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// The stand-in: writes down its environment, then waits while ./hold exists.
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(stub, `#!/bin/sh\nd="$(dirname "$0")"\nenv > "$d/last.env"\nwhile [ -f "$d/hold" ]; do sleep 0.1; done\nexit 0\n`, { mode: 0o755 });
process.env.VR_CLAUDE_BIN = stub;
const hold = path.join(dir, 'bin', 'hold');

const store = await import('../../lib/store.ts');
const lib = await import('../../lib/runs.ts');
const { slugify } = await import('../../lib/paths.ts');
const { words } = await import('../../lib/activityText.ts');
const { eventLine, isFeedback, isInboxEvent } = await import('../../lib/eventLine.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const project = path.join(dir, 'proj');
const mk = (name: string) => {
  const v = makeVideo(path.join(project, `export/${name}.mp4`), { dur: 1 });
  age(v);
  store.createOrGetReview(v, { by: 'tester' });
  return { file: v, slug: slugify(path.resolve(v)) };
};
const A = mk('spot');
const B = mk('teaser');
const C = mk('promo');
store.assignSession(A.slug, { name: 'spot-edit', sessionId: ID, cwd: project, agent: 'claude-code' }, 'tester');

const clients: { close(): Promise<void> }[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  // a stand-in left holding (a failed test) would keep the process alive
  fs.rmSync(hold, { force: true });
  ctx.agentRuns.stopAll();
});
const { ctx, base } = await startApp({ loadSessions: async () => [], feed: 30 });

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}
const runsOf = (slug: string) => ctx.runs.list(slug);
const openOf = (slug: string, agent: string) => runsOf(slug).find((r) => r.ended === null && r.agent.name === agent);
const act = (o: { agent: string; kind: string; w: ReturnType<typeof words>; slug?: string; target?: string; run?: string }) =>
  ctx.activity.record({
    at: new Date().toISOString(),
    agent: o.agent,
    kind: o.kind as never,
    ...o.w,
    target: o.target ?? null,
    video: o.slug ?? null,
    ...(o.run ? { run: o.run } : {}),
  });
const note = (slug: string, text: string, author = 'tester', kind?: 'question') =>
  store.addComment(slug, { frame: 3, text, author, severity: 'must', ...(kind ? { kind } : {}) });

test('a read never opens a run; an agent’s own write opens one: by the agent, working, its plan the video’s open notes', async () => {
  const n = note(B.slug, 'Too dark');
  act({ agent: 'reel-cut', kind: 'read', w: words('Reading the open notes'), slug: B.slug });
  act({ agent: 'reel-cut', kind: 'wait', w: words('Watching for feedback') });
  assert.deepEqual(runsOf(B.slug), [], 'reading and waiting open nothing');
  act({ agent: 'reel-cut', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(B.slug, 'reel-cut'), 'the implicit run');
  assert.equal(run.opened_by.how, 'agent');
  assert.equal(run.opened_by.who, 'reel-cut');
  assert.equal(run.state, 'working');
  assert.deepEqual(
    run.plan.map((p) => [p.id, p.state]),
    [[n.id, 'fixed']],
  );
  assert.ok(store.readEvents({ limit: 500 }).some((e) => e.type === 'run' && e.run === run.id && e.phase === 'opened' && e.by === 'agent:reel-cut'));
  // its further activity joins the same run (one per agent and video), a wait included
  act({ agent: 'reel-cut', kind: 'read', w: words('Reading the transcript'), slug: B.slug });
  assert.equal(runsOf(B.slug).length, 1);
  assert.equal(openOf(B.slug, 'reel-cut')?.now?.text, 'Reading the transcript');
});

test('LAMPO_RUN is a hint: taken for the same agent and video only; another agent naming it, or another video, binds by agent × video', async () => {
  const r = ctx.runs.machineStarted(
    {
      id: 'run_aaaaaaaaaaaa',
      slug: C.slug,
      name: 'render-bot',
      session_id: ID,
      cwd: project,
      by: 'tester',
      started: '',
      ended: null,
      state: 'running',
      exit: null,
    },
    undefined,
  );
  const run = () => ctx.runs.find(r)?.run as Run;
  assert.equal(run().state, 'starting');
  assert.equal(run().delivery, 'machine');
  // another agent naming it: not its run (a read: nothing opened either)
  act({ agent: 'intruder', kind: 'read', w: words('Reading the open notes'), slug: C.slug, run: r });
  assert.equal(run().state, 'starting');
  assert.equal(run().now, null);
  // the same agent on another video, naming it: that video's own story
  act({ agent: 'render-bot', kind: 'note', w: words('Added a note'), slug: B.slug, run: r });
  assert.equal(run().now, null);
  assert.equal(openOf(B.slug, 'render-bot')?.opened_by.how, 'agent', 'its write opened its own run on B');
  // a write by another agent naming it opens that agent's own run, never touches this one
  act({ agent: 'intruder', kind: 'note', w: words('Added a note'), slug: C.slug, run: r });
  assert.equal(run().now, null);
  assert.ok(openOf(C.slug, 'intruder'));
  // the agent itself, naming no video: its run
  act({ agent: 'render-bot', kind: 'tool', w: words('Running {command}', { command: 'npm run render' }), run: r });
  assert.equal(run().state, 'working');
  assert.equal(run().now?.text, 'Running npm run render');
  // a run id nobody has binds nothing; with two runs open (C and B), a sign that names no video only says it is alive
  act({ agent: 'render-bot', kind: 'read', w: words('Reading the transcript'), run: 'run_000000000000' });
  assert.equal(run().now?.text, 'Running npm run render');
  assert.equal(openOf(B.slug, 'render-bot')?.now?.text, 'Added a note');
});

test('a run sent to the video’s agent and begun by nobody is taken by the agent that turns up, under its own name', async () => {
  const r = await call<{ ok: boolean }>('POST', `/api/review/${encodeURIComponent(A.slug)}/request`, { text: 'Tighten the cut' });
  assert.equal(r.status, 200);
  const queued = openOf(A.slug, 'spot-edit') as Run;
  assert.equal(queued.state, 'queued');
  assert.equal(queued.opened_by.how, 'request');
  assert.equal(queued.request, 'Tighten the cut');
  act({ agent: 'vr-agent', kind: 'read', w: words('Reading the open notes'), slug: A.slug });
  const taken = ctx.runs.find(queued.id)?.run as Run;
  assert.equal(taken.agent.name, 'vr-agent');
  assert.equal(taken.state, 'working');
  ctx.runs.stop(queued.id, 'tester');
});

test('events move it: the version its agent registers names it and is its result; statuses move the plan; its question needs you; the answer sends it on', async () => {
  const n1 = note(A.slug, 'Logo late');
  const n2 = note(A.slug, 'Caption low');
  const sent = await call<{ ok: boolean }>('POST', `/api/review/${encodeURIComponent(A.slug)}/request`, { text: 'Fix these', nudge: true });
  assert.equal(sent.status, 200);
  const run = openOf(A.slug, 'spot-edit') as Run;
  assert.equal(run.opened_by.how, 'nudge');
  assert.deepEqual(run.plan.map((p) => p.id).sort(), [n1.id, n2.id].sort(), 'a nudge is about the open notes');
  act({ agent: 'spot-edit', kind: 'read', w: words('Reading note {id}', { id: n1.id }), target: n1.id });
  store.updateComment(n1.id, { status: 'fixed', note: 'entry on frame 3', by: 'agent:spot-edit' });
  await until(() => ctx.runs.find(run.id)?.run.plan.find((p) => p.id === n1.id)?.state === 'fixed', 'the fix in the plan');
  // its question: needs you (from the note event, whichever comes first)
  const q = note(A.slug, 'Cut the last shot?', 'agent:spot-edit', 'question');
  await until(() => ctx.runs.find(run.id)?.run.state === 'needs_you', 'needs you');
  assert.deepEqual(ctx.runs.find(run.id)?.run.needs, { kind: 'question', note: q.id });
  const phases = () =>
    store
      .readEvents({ limit: 500 })
      .filter((e) => e.type === 'run' && e.run === run.id)
      .map((e) => e.phase);
  assert.ok(phases().includes('needs_you'));
  // the person answers on the frame (the inbox's Answer): it works again, no follow-up while it is open
  const answered = await call<unknown>('PATCH', `/api/comments/${q.id}`, { status: 'verified', note: 'Yes, cut it' });
  assert.equal(answered.status, 200);
  assert.equal(ctx.runs.find(run.id)?.run.state, 'working');
  assert.equal(runsOf(A.slug).filter((r) => r.ended === null).length, 1);
  // a re-render on disk while it works: V2 names it, and lands as its result
  fs.copyFileSync(makeVideo(path.join(dir, 'other/spot-v2.mp4'), { dur: 1, pattern: 'rgbtestsrc' }), A.file);
  age(A.file);
  const s = store.sync(A.slug);
  assert.equal(s?.version?.run, run.id);
  await until(() => ctx.runs.find(run.id)?.run.result?.v === 2, 'the version as its result');
  // the last note answered with a version in: done (agents Lampo can't see end)
  store.updateComment(n2.id, { status: 'wontfix', note: 'kept on purpose', by: 'agent:spot-edit' });
  const done = await until(() => (ctx.runs.find(run.id)?.run.state === 'done' ? ctx.runs.find(run.id)?.run : null), 'done');
  assert.deepEqual([done.result?.v, done.result?.fixed, done.result?.wontfix, done.result?.asked], [2, 1, 1, 1]);
  assert.deepEqual(done.plan.find((p) => p.id === n1.id)?.v, 2);
  assert.ok(phases().includes('ended'));
  // an answer after it ended (with words, by a person with the agents right) opens the follow-up
  const q2 = note(A.slug, 'Warmer?', 'agent:spot-edit', 'question');
  await call('PATCH', `/api/comments/${q2.id}`, { status: 'verified', note: 'A little' });
  const next = openOf(A.slug, 'spot-edit') as Run;
  assert.equal(next.opened_by.how, 'answer');
  ctx.runs.stop(next.id, 'tester');
});

test('this machine’s run: LAMPO_RUN in its environment, a log, its exit ends it; Stop through the runs API ends the process', async () => {
  fs.writeFileSync(hold, '');
  const r = await call<{ run: { id: string } }>('POST', `/api/review/${encodeURIComponent(A.slug)}/request`, { text: 'Go', start: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const proc = r.json.run.id;
  const run = openOf(A.slug, 'spot-edit') as Run;
  assert.equal(run.id, proc, 'the process and its run share one id');
  assert.equal(run.delivery, 'machine');
  assert.equal(run.log, true);
  const env = await until(
    () => (fs.existsSync(path.join(dir, 'bin/last.env')) ? fs.readFileSync(path.join(dir, 'bin/last.env'), 'utf8') : null),
    'the stand-in',
  );
  assert.match(env, new RegExp(`^LAMPO_RUN=${run.id}$`, 'm'));
  const log = await fetch(`${base}/api/runs/${run.id}/log`);
  assert.equal(log.status, 200);
  await log.text();
  const stopped = await call<{ run: Run }>('POST', `/api/runs/${run.id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.run.state, 'stopped');
  await until(() => ctx.agentRuns.get(proc)?.state === 'stopped', 'the process to stop');
  fs.rmSync(hold, { force: true });
  // started again: it exits 0 by itself → done
  const again = await call<{ run: { id: string } }>('POST', `/api/review/${encodeURIComponent(A.slug)}/request`, { text: 'Again', start: true });
  const id = again.json.run.id;
  const ended = await until(() => (ctx.runs.find(id)?.run.ended ? ctx.runs.find(id)?.run : null), 'the run to end with its process');
  assert.equal(ended.state, 'done');
  const steps = ((await call<RunDetail>('GET', `/api/runs/${id}`)).json as RunDetail).steps.map((s) => s.key);
  assert.ok(steps.includes('Started by Lampo'), steps.join());
});

test('`vr watch --all` lines of their own; INBOX.md and wait_for_feedback never carry run events', () => {
  const evs = store.readEvents({ limit: 2000 }).filter((e) => e.type === 'run');
  assert.ok(evs.length >= 4);
  for (const e of evs) {
    assert.equal(isFeedback(e), false);
    assert.equal(isInboxEvent(e), false);
  }
  const line = (phase: string) => eventLine(evs.find((e) => e.phase === phase) as never);
  assert.match(line('opened'), /\] AGENT RUN OPENED \S+ \S+\.mp4 v\d by \S+ \(\w+\) · run run_[0-9a-f]{12}/);
  assert.match(line('started'), /\] AGENT RUN WORKING \S+ \S+ · run run_/);
  assert.match(line('needs_you'), /\] AGENT RUN NEEDS YOU spot-edit spot\.mp4 · run run_/);
  assert.match(line('ended'), /\] AGENT RUN ENDED (DONE|STOPPED|FAILED|NEEDS_YOU) \S+ \S+ · run run_/);
  assert.doesNotMatch(store.renderInbox(store.inboxEvents()), /AGENT RUN|run_[0-9a-f]{12}/);
});

test('over MCP: the wait that hands the work over begins it; notes sent meanwhile end its next answer with one line, once', async () => {
  const c = new Client({ name: 'live-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  store.assignSession(B.slug, { name: 'live-test', sessionId: 'mcp-0123456789ab' }, 'tester');
  const first = (await c.callTool({ name: 'wait_for_feedback', arguments: { video: B.slug, timeout_s: 0 } })) as CallToolResult;
  const cursor = (/cursor: (\S+)/.exec((first.content[0] as { text: string }).text) || [])[1] as string;
  const d1 = await call<{ id: string }>('POST', `/api/review/${encodeURIComponent(B.slug)}/drafts`, { frame: 2, text: 'Music too loud', severity: 'must' });
  assert.equal(d1.status, 200, JSON.stringify(d1.json));
  await call('POST', `/api/review/${encodeURIComponent(B.slug)}/drafts/send`, {});
  const run = openOf(B.slug, 'live-test') as Run;
  assert.equal(run.state, 'queued');
  const handed = (await c.callTool({ name: 'wait_for_feedback', arguments: { video: B.slug, since: cursor, timeout_s: 5 } })) as CallToolResult;
  assert.match((handed.content[0] as { text: string }).text, /new:/);
  assert.doesNotMatch((handed.content[0] as { text: string }).text, /AGENT RUN|new notes? on/, 'the wait carries no run lines');
  await until(() => ctx.runs.find(run.id)?.run.state === 'working', 'the hand-over to begin it');
  // the person sends one more while it works
  const d2 = await call<{ id: string }>('POST', `/api/review/${encodeURIComponent(B.slug)}/drafts`, { frame: 4, text: 'And the logo', severity: 'should' });
  await call('POST', `/api/review/${encodeURIComponent(B.slug)}/drafts/send`, {});
  assert.equal(ctx.runs.find(run.id)?.run.plan.find((p) => p.id === d2.json.id)?.added, true);
  const text = async (name: string, args: Record<string, unknown>) =>
    ((await c.callTool({ name, arguments: args })) as CallToolResult).content.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text);
  const got = await text('get_note', { id: d1.json.id });
  assert.match(got.at(-1) as string, /^1 new note on teaser\.mp4 since you started \(\d\d:\d\d:\d\d[^)]*\): get_open_notes since "[^"]+"\.$/);
  const again = await text('get_note', { id: d1.json.id });
  assert.doesNotMatch(again.join('\n'), /new note/, 'told once');
});
