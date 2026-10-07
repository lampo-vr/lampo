// Stopping an agent's work, and what needs the person: a Stop of an agent that listens is told with its next Lampo
// answer — one appended line, once, whichever way it calls (MCP over HTTP, `vr`), never to another agent — and the
// UI hears "stop pending" until then; an agent Lampo started is stopped by SIGINT, then SIGTERM, then SIGKILL, to its
// process group; a permission it is refused (its own stream-json says so) makes it need the person with the exact rule
// to copy; failures, refusals and agents gone quiet are inbox items for people with the agents right only, and pings.
// The `claude` here is a stand-in: the real CLI is never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as StdioClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ForYouResponse, LibraryResponse, Run } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, ROOT, until, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
// The stand-in: prints ./stream.jsonl (its stream-json) when there is one, waits while ./hold exists, then exits.
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(
  stub,
  `#!/bin/sh\nd="$(dirname "$0")"\n[ -f "$d/stream.jsonl" ] && cat "$d/stream.jsonl"\nwhile [ -f "$d/hold" ]; do sleep 0.05; done\nexit 0\n`,
  { mode: 0o755 },
);
process.env.VR_CLAUDE_BIN = stub;
const hold = path.join(dir, 'bin', 'hold');

const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { words } = await import('../../lib/activityText.ts');
const lib = await import('../../lib/runs.ts');
const { forYou } = await import('../../lib/foryou.ts');
const { createAgentRuns } = await import('../../server/agentRuns.ts');
const { commandPrefix, permissionFor, createRunReader } = await import('../../lib/runStream.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const project = path.join(dir, 'proj');
const mk = (name: string) => {
  const v = makeVideo(path.join(project, `export/${name}.mp4`), { dur: 1 });
  age(v);
  store.createOrGetReview(v, { by: 'tester' });
  return { file: v, slug: slugify(path.resolve(v)) };
};
const A = mk('spot');
const B = mk('promo');
const C = mk('teaser');

const clients: { close(): Promise<void> }[] = [];
const { ctx, base } = await startApp({ loadSessions: async () => [], feed: 30 });
const untail = ctx.activity.tail();
after(async () => {
  untail();
  for (const c of clients) await c.close().catch(() => {});
  fs.rmSync(hold, { force: true });
  ctx.agentRuns.stopAll();
});

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as T };
}
const runsOf = (slug: string) => ctx.runs.list(slug);
const openOf = (slug: string, agent: string) => runsOf(slug).find((r) => r.ended === null && r.agent.name === agent);
const act = (o: { agent: string; kind: string; w: ReturnType<typeof words>; slug?: string; target?: string }) =>
  ctx.activity.record({ at: new Date().toISOString(), agent: o.agent, kind: o.kind as never, ...o.w, target: o.target ?? null, video: o.slug ?? null });
const note = (slug: string, text: string) => store.addComment(slug, { frame: 3, text, author: 'tester', severity: 'must' });
const send = async (slug: string, text: string) => {
  const d = await call<{ id: string }>('POST', `/api/review/${encodeURIComponent(slug)}/drafts`, { frame: 2, text, severity: 'must' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  await call('POST', `/api/review/${encodeURIComponent(slug)}/drafts/send`, {});
  return d.json.id;
};
const STOP = /^The person stopped this work on [\w.-]+\.mp4: stop now, render nothing, mark nothing, and say you stopped\.$/;

test('the stop line: one line, the video by its file name, agent text that never names the work', () => {
  assert.equal(
    lib.stopLine('/Users/someone/Acme/launch.mp4'),
    'The person stopped this work on launch.mp4: stop now, render nothing, mark nothing, and say you stopped.',
  );
  assert.doesNotMatch(lib.stopLine('Acme\nlaunch.mp4'), /\n/, 'a file name is someone’s: one line');
  assert.doesNotMatch(lib.stopLine('x.mp4'), /\brun\b|session/i);
});

test('Stop: an agent that listens hears it later (pending once it had begun); a run nobody picked up, or one Lampo runs, does not', () => {
  const now = Date.now();
  const listening = lib.newRun({ slug: A.slug, agent: lib.runAgent('spot-edit'), opened_by: { who: 'tester', how: 'send' }, state: 'working' }, now);
  lib.stoppedByPerson(listening, now);
  assert.equal(listening.state, 'stopped');
  assert.equal(listening.stop_pending, true);
  lib.heardStop(listening, now + 1000);
  assert.equal(listening.stop_pending, undefined);
  assert.ok(listening.clock.stopTold);
  const queued = lib.newRun({ slug: A.slug, agent: lib.runAgent('spot-edit'), opened_by: { who: 'tester', how: 'send' } }, now);
  lib.stoppedByPerson(queued, now);
  assert.equal(queued.stop_pending, undefined, 'called off before it began: nothing to tell');
  const machine = lib.newRun(
    { slug: A.slug, agent: lib.runAgent('spot-edit'), opened_by: { who: 'tester', how: 'send' }, delivery: 'machine', state: 'starting' },
    now,
  );
  lib.stoppedByPerson(machine, now);
  assert.equal(machine.stop_pending, undefined, 'a process Lampo runs is ended by signal');
  // one telling per run on this machine, whoever tells it
  assert.equal(lib.claimStop(listening.id), true);
  assert.equal(lib.claimStop(listening.id), false);
  assert.equal(lib.claimStop('run_not-an-id'), false);
});

test('over MCP: the agent’s next answer ends with the stop line, once; the UI hears stop_pending until then; a write right after opens nothing', async () => {
  const c = new Client({ name: 'stop-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  store.assignSession(B.slug, { name: 'stop-test', sessionId: 'mcp-0123456789ab' }, 'tester');
  const first = (await c.callTool({ name: 'wait_for_feedback', arguments: { video: B.slug, timeout_s: 0 } })) as CallToolResult;
  const cursor = (/cursor: (\S+)/.exec((first.content[0] as { text: string }).text) || [])[1] as string;
  const id = await send(B.slug, 'Logo too late');
  await c.callTool({ name: 'wait_for_feedback', arguments: { video: B.slug, since: cursor, timeout_s: 5 } });
  const run = await until(() => (openOf(B.slug, 'stop-test')?.state === 'working' ? openOf(B.slug, 'stop-test') : null), 'the hand-over to begin it');
  const stopped = await call<{ run: Run }>('POST', `/api/runs/${run.id}/stop`, {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.run.state, 'stopped');
  assert.equal(stopped.json.run.stop_pending, true, 'the UI says it will notice at its next step');
  const lib1 = (await call<LibraryResponse>('GET', `/api/library?slug=${encodeURIComponent(B.slug)}`)).json;
  assert.equal(lib1.videos[0]?.run?.stop_pending, true, 'the card’s brief too');
  // another agent calling about the video hears nothing of it
  act({ agent: 'someone-else', kind: 'read', w: words('Reading the open notes'), slug: B.slug });
  assert.equal(ctx.runs.find(run.id)?.run.stop_pending, true);
  const text = async (name: string, args: Record<string, unknown>) =>
    ((await c.callTool({ name, arguments: args })) as CallToolResult).content.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text);
  const got = await text('get_note', { id });
  assert.match(got.at(-1) as string, STOP, 'appended to its answer');
  assert.ok(got.length >= 2, 'appended, the answer itself unchanged');
  const after1 = ctx.runs.find(run.id)?.run as Run;
  assert.equal(after1.stop_pending, undefined, 'heard');
  assert.equal(after1.state, 'stopped');
  const again = await text('get_note', { id });
  assert.doesNotMatch(again.join('\n'), /The person stopped/, 'told once');
  // a write it made before it read the line: kept with the stopped work, nothing new opened
  await c.callTool({ name: 'mark_fixed', arguments: { id, note: 'moved it' } });
  assert.equal(openOf(B.slug, 'stop-test'), undefined, 'no run opened for it');
  const detail = ctx.runs.detail(run.id)?.detail;
  assert.ok(
    detail?.steps.some((s) => s.key === 'Fixed {id}'),
    'the step kept with the stopped work',
  );
});

test('lampo: the line after the command’s own output, once; the app clears it from the call it tails; never another agent’s', async () => {
  const n = note(C.slug, 'Too dark');
  store.assignSession(C.slug, { name: 'cut-cli', sessionId: 'cli-0123456789ab' }, 'tester');
  act({ agent: 'cut-cli', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(C.slug, 'cut-cli'), 'its run');
  assert.equal((await call('POST', `/api/runs/${run.id}/stop`, {})).status, 200);
  await until(() => fs.readFileSync(lib.runsFile(C.slug), 'utf8').includes('"stop_pending":true'), 'the stop written');
  const other = vr(['open', C.file], { ...env, VR_BY: 'agent:another-cut' });
  assert.equal(other.code, 0, other.err);
  assert.doesNotMatch(other.out, /The person stopped/, 'another agent hears nothing');
  const own = vr(['open', C.file], { ...env, VR_BY: 'agent:cut-cli' });
  assert.equal(own.code, 0, own.err);
  const lines = own.out.trim().split('\n');
  assert.match(lines.at(-1) as string, STOP, 'its last line');
  const twice = vr(['open', C.file], { ...env, VR_BY: 'agent:cut-cli' });
  assert.doesNotMatch(twice.out, /The person stopped/, 'told once');
  await until(() => ctx.runs.find(run.id)?.run.stop_pending === undefined, 'the app hears the call and clears it');
  assert.equal(openOf(C.slug, 'cut-cli'), undefined, 'and opens nothing for it');
});

test('the stdio MCP server on this machine: its next answer about the video ends with the line, once', async () => {
  const n = note(A.slug, 'Slower fade');
  store.assignSession(A.slug, { name: 'stdio-cut', sessionId: 'cli-3123456789ab' }, 'tester');
  act({ agent: 'stdio-cut', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(A.slug, 'stdio-cut'), 'its run');
  assert.equal((await call('POST', `/api/runs/${run.id}/stop`, {})).status, 200);
  await until(() => fs.readFileSync(lib.runsFile(A.slug), 'utf8').includes('"stop_pending":true'), 'the stop written');
  const c = new StdioClient({ name: 'stdio-stop', version: '1.0.0' });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'bin/vr-mcp')],
      env: { ...env, VR_BY: 'agent:stdio-cut' } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  clients.push(c);
  const text = async () =>
    ((await c.callTool({ name: 'get_open_notes', arguments: { video: A.file } })) as CallToolResult).content
      .filter((x) => x.type === 'text')
      .map((x) => (x as { text: string }).text);
  assert.match((await text()).at(-1) as string, STOP);
  assert.doesNotMatch((await text()).join('\n'), /The person stopped/, 'told once');
  await until(() => ctx.runs.find(run.id)?.run.stop_pending === undefined, 'the app hears the call and clears it');
});

test('a new Send to the same agent outweighs a stop it hasn’t heard: it hears the new work instead', async () => {
  const n = note(C.slug, 'Logo bigger');
  store.assignSession(C.slug, { name: 'redo-cli', sessionId: 'cli-2123456789ab' }, 'tester');
  act({ agent: 'redo-cli', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(C.slug, 'redo-cli'), 'its run');
  await call('POST', `/api/runs/${run.id}/stop`, {});
  assert.equal(ctx.runs.find(run.id)?.run.stop_pending, true);
  await send(C.slug, 'One more thing');
  assert.equal(ctx.runs.find(run.id)?.run.stop_pending, undefined);
  assert.equal(act({ agent: 'redo-cli', kind: 'read', w: words('Reading the open notes'), slug: C.slug }), null, 'no stop line');
  assert.equal(openOf(C.slug, 'redo-cli')?.state, 'working', 'the new work begins');
  await call('POST', `/api/runs/${openOf(C.slug, 'redo-cli')?.id}/stop`, {});
});

test('"Tell it…" while it works joins that work: its words the request, a step of its own; nothing else opens', async () => {
  const n = note(A.slug, 'Faster');
  store.assignSession(A.slug, { name: 'spot-cli', sessionId: 'cli-1123456789ab' }, 'tester');
  act({ agent: 'spot-cli', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(A.slug, 'spot-cli'), 'its run');
  const r = await call('POST', `/api/review/${encodeURIComponent(A.slug)}/request`, { text: 'Keep the\nlogo where it is' });
  assert.equal(r.status, 200);
  const runs = runsOf(A.slug).filter((x) => x.agent.name === 'spot-cli');
  assert.equal(runs.length, 1, 'one run');
  assert.equal(runs[0]?.id, run.id);
  assert.equal(runs[0]?.request, 'Keep the ↵ logo where it is');
  const step = ctx.runs.detail(run.id)?.detail.steps.find((s) => s.key === '{name} asked');
  assert.equal(step?.quote, 'Keep the ↵ logo where it is');
  assert.ok(
    store.readEvents({ limit: 50 }).some((e) => e.type === 'request' && /logo where it is/.test(e.text ?? '')),
    'the agent hears it as today',
  );
  await call('POST', `/api/runs/${run.id}/stop`, {});
});

test('the permission rule: the start of a command, never its paths or values; Lampo’s tools at once; the rest by name', () => {
  assert.equal(commandPrefix('npx remotion render src/index.ts Main out/launch.mp4'), 'npx remotion render');
  assert.equal(commandPrefix('cd /Users/someone/promo && vr render --to promo.mp4 -- npx remotion render'), 'vr render');
  assert.equal(commandPrefix('FOO=1 ffmpeg -y -i in.mov out.mp4'), 'ffmpeg');
  assert.equal(commandPrefix('python3 render.py --fast'), 'python3 render.py');
  assert.deepEqual(permissionFor('Bash', { command: 'npx remotion render src/index.ts Main out.mp4' }), {
    words: words('Needs permission to run {command}', { command: 'npx remotion render' }),
    allow: 'Bash(npx remotion render:*)',
  });
  assert.equal(permissionFor('mcp__lampo__mark_fixed', {}).allow, 'mcp__lampo');
  assert.equal(permissionFor('mcp__video-review__get_frame', {}).allow, 'mcp__video-review');
  assert.equal(permissionFor('mcp__figma__export', {}).allow, 'mcp__figma__export');
  assert.equal(permissionFor('Write', { file_path: '/Users/someone/x' }).allow, 'Edit');
  assert.equal(permissionFor('WebFetch', { url: 'https://example.com/a' }).allow, 'WebFetch(domain:example.com)');
});

const stream = (...lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
const denial = [
  {
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npx remotion render src/index.ts Main out.mp4' } }] },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'Claude requested permissions to use Bash, but you haven’t granted it yet.' },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    result: 'I could not render: the command needs your permission.',
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'npx remotion render src/index.ts Main out.mp4' } }],
  },
];

test('the stream reader: a refused call is one `denied` step with the rule, told once (its result lists it again)', () => {
  const reader = createRunReader(project);
  const steps = reader.feed(stream(...denial));
  const denied = steps.filter((s) => s.kind === 'denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0]?.allow, 'Bash(npx remotion render:*)');
  assert.equal(denied[0]?.key, 'Needs permission to run {command}');
  // an error of the command itself is not a refusal
  const plain = createRunReader(project).feed(
    stream(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: './render.sh' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'sh: ./render.sh: Permission denied' }] } },
    ),
  );
  assert.equal(plain.filter((s) => s.kind === 'denied').length, 0);
});

test('a run Lampo started that is refused a permission needs you, with the rule; the inbox lists it ahead of fixes, a ping goes out', async () => {
  const pings: { kind: string; allow?: string; video: string }[] = [];
  ctx.push.run = (n) => pings.push(n);
  store.assignSession(A.slug, { name: 'spot-edit', sessionId: ID, cwd: project, agent: 'claude-code' }, 'tester');
  fs.writeFileSync(path.join(dir, 'bin', 'stream.jsonl'), stream(...denial));
  const woke = await call<{ run: { id: string } | null }>('POST', `/api/review/${encodeURIComponent(A.slug)}/wake`, { text: 'render it' });
  assert.equal(woke.status, 200, JSON.stringify(woke.json));
  const run = await until(() => runsOf(A.slug).find((r) => r.needs?.kind === 'permission'), 'the refusal to reach the run', 15_000);
  assert.equal(run.needs?.allow, 'Bash(npx remotion render:*)');
  await until(() => runsOf(A.slug).find((r) => r.id === run.id)?.ended, 'its process to end', 15_000);
  const ended = runsOf(A.slug).find((r) => r.id === run.id) as Run;
  assert.equal(ended.state, 'needs_you', 'it ended waiting for the person');
  assert.equal(ended.result?.asked ?? 0, 0, 'a permission is not a question it asked');
  await until(() => pings.some((p) => p.kind === 'permission'), 'the ping');
  assert.equal(pings.find((p) => p.kind === 'permission')?.allow, 'Bash(npx remotion render:*)');
  const fy = (await call<ForYouResponse>('GET', '/api/for-you')).json;
  const item = fy.items.find((i) => i.kind === 'blocked');
  assert.equal(item?.run?.needs?.allow, 'Bash(npx remotion render:*)');
  assert.equal(item?.dismissible, false, 'work: no Got it');
  const firstOther = fy.items.findIndex((i) => i.kind === 'verify' || i.kind === 'review' || i.kind === 'stalled');
  assert.ok(firstOther === -1 || fy.items.findIndex((i) => i.key === item?.key) < firstOther, 'ahead of fixes, renders to review and stalled videos');
  assert.ok(fy.counts.blocked >= 1 && fy.counts.total >= 1, 'it counts for the bell and the badge');
  // Send again: the follow-up; the block leaves the list
  fs.rmSync(path.join(dir, 'bin', 'stream.jsonl'));
  const again = await call<{ run: Run }>('POST', `/api/runs/${run.id}/retry`, { start: true });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.run.follows, run.id);
  const after2 = (await call<ForYouResponse>('GET', '/api/for-you')).json;
  assert.ok(!after2.items.some((i) => i.key === item?.key), 'a newer run of the agent takes it off');
  await until(() => runsOf(A.slug).every((r) => r.ended), 'the second process to end', 15_000);
});

test('a failed render is an inbox item with its error, for the agents right only; Try again or opening it takes it off', async () => {
  const pings: { kind: string }[] = [];
  ctx.push.run = (n) => pings.push(n);
  const n = note(B.slug, 'Font wrong');
  act({ agent: 'promo-cli', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  await until(() => openOf(B.slug, 'promo-cli'), 'its run');
  act({
    agent: 'promo-cli',
    kind: 'error',
    w: words('The render failed (exit {code})', { code: 1 }, 'Rendering frame 312 ↵ Error: font Inter Display not found'),
    slug: B.slug,
  });
  const run = await until(() => runsOf(B.slug).find((r) => r.agent.name === 'promo-cli' && r.state === 'failed'), 'the failure');
  await until(() => pings.some((p) => p.kind === 'failed'), 'the ping');
  const owner = forYou({ key: 'owner', name: 'tester', role: 'owner' });
  const item = owner.items.find((i) => i.key === `failed:${run.id}`);
  assert.equal(item?.kind, 'failed');
  assert.equal(item?.run?.error?.key, 'The render failed (exit {code})');
  assert.equal(item?.dismissible, true, 'it leaves once opened');
  for (const role of ['reviewer'] as const) {
    const theirs = forYou({ key: `r-${role}`, name: 'Rafa', role });
    assert.ok(!theirs.items.some((i) => i.kind === 'failed' || i.kind === 'blocked' || i.run), `${role}: none of an agent’s work`);
  }
  // opened (seen): dismissed for that person
  const d = await call<ForYouResponse>('POST', '/api/for-you/dismiss', { keys: [item?.key] });
  assert.ok(!d.json.items.some((i) => i.key === item?.key));
});

test('an agent gone quiet is a stalled video with its run; a ping after 30 min of silence only for whom asked; time alone moves it', async () => {
  const pings: { kind: string; run: string; minutes?: number }[] = [];
  ctx.push.run = (n) => pings.push(n);
  const n = note(C.slug, 'Shorter');
  act({ agent: 'quiet-cut', kind: 'fix', w: words('Fixed {id}', { id: n.id }), target: n.id });
  const run = await until(() => openOf(C.slug, 'quiet-cut'), 'its run');
  const later = Date.now() + lib.RUN_TIMES.lostCalls + 60_000;
  const fy = forYou({ key: 'owner', name: 'tester', role: 'owner' }, { now: later });
  const item = fy.items.find((i) => i.key === `lost:${run.id}`);
  assert.equal(item?.kind, 'stalled');
  assert.equal(item?.reason, 'lost');
  assert.equal(item?.run?.state, 'lost', 'seen as of now, never written by a read');
  assert.ok(fy.counts.stalled >= 1, 'listed as stalled, which the bell doesn’t count');
  ctx.runs.sweep(later);
  assert.equal(ctx.runs.find(run.id)?.run.state, 'lost');
  const quiet = () => pings.filter((p) => p.kind === 'quiet' && p.run === run.id);
  assert.equal(quiet().length, 0, 'not before 30 min of silence');
  ctx.runs.sweep(Date.parse(ctx.runs.find(run.id)?.run.seen ?? '') + 31 * 60_000);
  assert.equal(quiet().length, 1);
  assert.equal(quiet()[0]?.minutes, 31);
  ctx.runs.sweep(Date.parse(ctx.runs.find(run.id)?.run.seen ?? '') + 32 * 60_000);
  assert.equal(quiet().length, 1, 'once');
  // its next call revives it: off the list
  act({ agent: 'quiet-cut', kind: 'read', w: words('Reading the open notes'), slug: C.slug });
  assert.equal(ctx.runs.find(run.id)?.run.state, 'working');
});

test('Stop of a run Lampo started: SIGINT, SIGTERM after the grace, SIGKILL after another, to the whole group', async () => {
  // a stand-in that notes each signal and stays (only SIGKILL ends it)
  const trap = path.join(dir, 'bin', 'trap');
  const said = path.join(dir, 'bin', 'signals');
  fs.writeFileSync(
    trap,
    `#!/bin/sh\ntrap 'echo INT >> "${said}"' INT\ntrap 'echo TERM >> "${said}"' TERM\n: > "${said}.ready"\nwhile :; do sleep 0.05 || true; done\n`,
    { mode: 0o755 },
  );
  const runs = createAgentRuns({ broadcast: () => {}, bin: () => trap, dir: path.join(dir, 'runs-ladder'), graceMs: 400 });
  const r = runs.start({ slug: A.slug, name: 'spot-edit', sessionId: ID, cwd: project, by: 'tester', prompt: 'Lampo: go' });
  await until(() => runs.running(ID)?.id === r.id && fs.existsSync(`${said}.ready`), 'it to run, its traps set');
  const t0 = Date.now();
  runs.stop(r.id, 'tester');
  await until(() => runs.get(r.id)?.state === 'stopped', 'SIGKILL to end it', 10_000);
  const took = Date.now() - t0;
  const got = fs.readFileSync(said, 'utf8').trim().split('\n');
  assert.equal(got[0], 'INT', 'asked first');
  assert.ok(got.includes('TERM'), 'then told');
  assert.ok(got.indexOf('TERM') > got.indexOf('INT'));
  assert.ok(took >= 800, `SIGKILL only after both graces (${took} ms)`);
});
