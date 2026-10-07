// The live agent monitor end to end on the server: an agent's MCP calls over HTTP show as activity on the video, a
// hosted server takes batches from an agent's token (only the kinds an agent's calls make), reviewers don't read it,
// and a run Lampo started has its stream-json read into its step, tokens and stated cost. The `claude` here is a
// stand-in that prints a fixture: the real CLI is never run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ActivityRecord } from '../../lib/activity.ts';
import type { AgentActivityResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, sleep } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const auth = await import('../../lib/auth.ts');
const { createAgentRuns } = await import('../../server/agentRuns.ts');
const { createActivityStore } = await import('../../server/activity.ts');

const video = makeVideo(path.join(dir, 'proj/export/live.mp4'), { w: 160, h: 90, dur: 1 });
let slug = '';
const clients: { close(): Promise<void> }[] = [];
// Registered before the servers' own, so the MCP clients close first.
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});
const { base } = await startApp({ token: 'test-token', loadSessions: async () => [] });
const { base: hostedBase } = await startApp({ cfg: { ...loadConfig(), mode: 'server' }, loadSessions: async () => [] });

before(async () => {
  slug = (await call<{ video: { slug: string } }>('POST', '/api/library', { path: video })).video.slug;
});

async function call<T>(
  method: string,
  url: string,
  body?: unknown,
  { to = base, headers = {} }: { to?: string; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(to + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`), { status: res.status });
  return json as T;
}
const statusOf = async (p: Promise<unknown>) => p.then(() => 200).catch((e: { status?: number }) => e.status ?? 0);
const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 6000): Promise<T> => {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(50)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('an agent’s MCP calls over HTTP become activity on the video, in order, under the name its connection is listed by', async () => {
  const note = await call<{ id: string }>('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { frame: 5, text: 'Logo too late' });
  const c = new Client({ name: 'live-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  await c.callTool({ name: 'get_open_notes', arguments: { video: slug } });
  await c.callTool({ name: 'get_note', arguments: { id: note.id } });
  // A write signed as an agent doesn't split the connection's story into two names.
  await c.callTool({ name: 'mark_fixed', arguments: { id: note.id, note: 'Logo comes in on frame 3 now', by: 'agent:reel-cut' } });
  const live = await until(async () => {
    const r = await call<AgentActivityResponse>('GET', `/api/agent-activity?slug=${encodeURIComponent(slug)}`);
    const a = r.agents.find((x) => x.agent === 'live-test');
    return a && a.recent.length >= 3 ? a : null;
  }, 'three lines of activity');
  assert.deepEqual(
    live.recent.map((a) => a.text),
    [`Fixed ${note.id} “Logo comes in on frame 3 now”`, `Reading note ${note.id}`, 'Reading the open notes'],
  );
  assert.equal(live.current?.kind, 'fix');
  assert.equal(live.recent[1].slug, slug, 'a note id finds its video');
  assert.equal(live.recent[2].slug, slug, 'so does a slug');
  assert.ok(live.recent.every((a) => a.agent === 'live-test'));
  // Every agent's latest, for the sidebar.
  const all = await call<AgentActivityResponse>('GET', '/api/agent-activity');
  assert.equal(all.agents.find((a) => a.agent === 'live-test')?.recent.length, 1);
  // A failed call is not activity.
  await c.callTool({ name: 'get_note', arguments: { id: 'c_00000000' } }).catch(() => {});
  await sleep(200);
  const again = await call<AgentActivityResponse>('GET', `/api/agent-activity?slug=${encodeURIComponent(slug)}`);
  assert.equal(again.agents.find((a) => a.agent === 'live-test')?.current?.kind, 'fix');
});

test('hosted: an agent’s token posts batches; only the kinds an agent’s calls make; reviewers can’t read activity', async () => {
  const owner = await auth.createUser({ email: 'owner@example.test', name: 'Olivia', password: 'a-long-password-1', role: 'owner' });
  const reviewer = await auth.createUser({ email: 'rev@example.test', name: 'Rafa', password: 'a-long-password-2', role: 'reviewer' });
  const agentToken = { authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` };
  const reviewerToken = { authorization: `Bearer ${auth.createToken(reviewer.id, 'phone').token}` };
  const entries: ActivityRecord[] = [
    { at: new Date().toISOString(), agent: 'cloud-cut', kind: 'read', text: 'Reading the open notes', key: 'Reading the open notes' },
    { at: new Date().toISOString(), agent: 'cloud-cut', kind: 'wait', text: 'Watching for feedback', key: 'Watching for feedback' },
  ];
  await call('POST', '/api/agents/activity', { entries }, { to: hostedBase, headers: agentToken });
  // Listed as whose it is, like an MCP client's connection (`client · account`): a posted name can't pass for another's.
  const got = await until(async () => {
    const r = await call<AgentActivityResponse>('GET', '/api/agent-activity', undefined, { to: hostedBase, headers: agentToken });
    return r.agents.find((a) => a.agent === 'cloud-cut · Olivia');
  }, 'the batch');
  assert.equal(got.current?.text, 'Watching for feedback');
  // Lampo's own observations (a run, a render on disk) can't be posted.
  const run = { ...entries[0], kind: 'run', text: 'Started by Lampo' };
  assert.equal(await statusOf(call('POST', '/api/agents/activity', { entries: [run] }, { to: hostedBase, headers: agentToken })), 400);
  assert.equal(await statusOf(call('POST', '/api/agents/activity', { entries: Array(21).fill(entries[0]) }, { to: hostedBase, headers: agentToken })), 400);
  assert.equal(await statusOf(call('GET', '/api/agent-activity', undefined, { to: hostedBase, headers: reviewerToken })), 403);
  assert.equal(await statusOf(call('POST', '/api/agents/activity', { entries }, { to: hostedBase, headers: reviewerToken })), 403);
});

test('AGENT-10: a posted line is its poster’s: another member’s agent name gets the poster’s, and its time is now-ish', async () => {
  const mallory = await auth.createUser({ email: 'mal@example.test', name: 'Mallory', password: 'a-long-password-3', role: 'member' });
  const token = { authorization: `Bearer ${auth.createToken(mallory.id, 'agent').token}` };
  const now = Date.now();
  const entries: ActivityRecord[] = [
    // another member's agent, as the MCP endpoint names it
    { at: new Date(now).toISOString(), agent: 'Codex · Olivia', kind: 'read', text: 'Running rm -rf', key: 'Reading the open notes' },
    // a name long enough that the account would be cut off the end
    { at: new Date(now).toISOString(), agent: `${'x'.repeat(79)}`, kind: 'read', text: 'long', key: 'Reading the open notes' },
    // its own name, already saying whose it is
    { at: new Date(now).toISOString(), agent: 'cut · Mallory', kind: 'read', text: 'own', key: 'Reading the open notes' },
    // pinned to the future, and to long ago
    { at: '2099-01-01T00:00:00Z', agent: 'future', kind: 'read', text: 'future', key: 'Reading the open notes' },
    { at: '2001-01-01T00:00:00Z', agent: 'past', kind: 'read', text: 'past', key: 'Reading the open notes' },
  ];
  await call('POST', '/api/agents/activity', { entries }, { to: hostedBase, headers: token });
  const names = await until(async () => {
    const r = await call<AgentActivityResponse>('GET', '/api/agent-activity', undefined, { to: hostedBase, headers: token });
    const mine = r.agents.filter((a) => a.agent.endsWith(' · Mallory'));
    return mine.length >= 5 ? r.agents : null;
  }, 'the batch');
  const by = (n: string) => names.find((a) => a.agent === n);
  assert.ok(by('Codex · Olivia · Mallory'), names.map((a) => a.agent).join(', '));
  assert.ok(!names.some((a) => a.agent === 'Codex · Olivia'), 'nothing under the other member’s agent');
  assert.ok(by('cut · Mallory'), 'its own name stays as it is');
  const long = names.find((a) => a.agent.startsWith('xxx'));
  assert.ok(long?.agent.endsWith(' · Mallory') && long.agent.length <= 80, long?.agent);
  for (const n of ['future · Mallory', 'past · Mallory']) {
    const at = Date.parse(by(n)?.current?.at ?? '');
    assert.ok(at <= Date.now() + 1000 && at >= now - 5 * 60_000 - 1000, `${n}: ${by(n)?.current?.at}`);
  }
});

test('hosted: vr render posts its progress, its failure and its run; bounded by the schema, a stranger’s shapes refused', async () => {
  const owner = await auth.createUser({ email: 'render@example.test', name: 'Rhea', password: 'a-long-password-4', role: 'owner' });
  const token = { authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` };
  const at = new Date().toISOString();
  const progress = { what: 'render', stage: 'rendering', pct: 42, frames: [378, 900], eta_s: 61, tool: 'remotion', v: 4 };
  const quote = `Error: ${'x'.repeat(280)}`;
  const entries: ActivityRecord[] = [
    {
      at,
      agent: 'render-cut',
      kind: 'render',
      text: 'Rendering a new version',
      key: 'Rendering a new version',
      pct: 42,
      progress: progress as never,
      run: 'run_0123456789ab',
    },
    {
      at,
      agent: 'render-cut',
      kind: 'error',
      text: 'The render failed (exit 1)',
      key: 'The render failed (exit {code})',
      vars: { code: 1 },
      quote,
      progress: progress as never,
      run: 'run_0123456789ab',
    },
  ];
  await call('POST', '/api/agents/activity', { entries }, { to: hostedBase, headers: token });
  const got = await until(async () => {
    const r = await call<AgentActivityResponse>('GET', '/api/agent-activity', undefined, { to: hostedBase, headers: token });
    return r.agents.find((a) => a.agent === 'render-cut · Rhea' && a.current?.kind === 'error');
  }, 'the render’s lines');
  assert.equal(got.current?.quote, quote, 'a failure keeps its words (≤ 300)');
  assert.deepEqual(got.current?.progress, progress);
  assert.equal(got.current?.run, 'run_0123456789ab');
  const refused = async (patch: Record<string, unknown>) =>
    statusOf(call('POST', '/api/agents/activity', { entries: [{ ...entries[0], ...patch }] }, { to: hostedBase, headers: token }));
  // only the contract's words, sane numbers, a run id's shape and no fields of its own
  assert.equal(await refused({ progress: { ...progress, stage: 'hacking' } }), 400);
  assert.equal(await refused({ progress: { ...progress, tool: 'sh' } }), 400);
  assert.equal(await refused({ progress: { ...progress, pct: 101 } }), 400);
  assert.equal(await refused({ progress: { ...progress, eta_s: 8 * 24 * 3600 } }), 400);
  assert.equal(await refused({ progress: { ...progress, frames: [1.5, 2] } }), 400);
  assert.equal(await refused({ progress: { ...progress, path: '/etc/passwd' } }), 400);
  assert.equal(await refused({ run: '../../x' }), 400);
  assert.equal(await refused({ quote: 'q'.repeat(301) }), 400);
  assert.equal(await refused({ kind: 'run' }), 400, 'what Lampo sees itself still can’t be posted');
});

test('a run Lampo started: its stream-json becomes the live step, tokens and the cost it states; each step is activity', async () => {
  const bin = path.join(dir, 'bin', 'claude-stream');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const cwd = path.join(dir, 'proj');
  const lines = [
    { type: 'system', subtype: 'init', cwd },
    {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${cwd}/src/Logo.tsx` } }],
        usage: { input_tokens: 900, output_tokens: 40 },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'm2',
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/Logo.tsx` } }],
        usage: { input_tokens: 950, output_tokens: 120 },
      },
    },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 1850, output_tokens: 160 } },
  ];
  const fixture = path.join(dir, 'bin', 'stream.jsonl');
  fs.writeFileSync(fixture, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  // Prints the fixture a line at a time, like a run that takes a moment per step.
  fs.writeFileSync(bin, `#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.8; done < "${fixture}"\n`, { mode: 0o755 });
  const seen: ActivityRecord[] = [];
  const activity = createActivityStore(() => {});
  const runs = createAgentRuns({
    broadcast: () => {},
    bin: () => bin,
    dir: path.join(dir, 'runs'),
    activity: (a) => {
      seen.push(a);
      activity.record(a);
    },
  });
  const run = runs.start({ slug, name: 'reel-cut', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', cwd, by: 'tester', prompt: 'Lampo: fix the logo' });
  const mid = await until(async () => (runs.get(run.id)?.live?.step?.text === 'Editing src/Logo.tsx' ? runs.get(run.id) : null), 'the second step');
  assert.equal(mid?.live?.cost_usd, null, 'no cost before the run states one');
  assert.equal(mid?.live?.tokens.output, 160, 'the messages so far add up');
  const done = await until(async () => (runs.get(run.id)?.state === 'finished' ? runs.get(run.id) : null), 'the run to finish');
  assert.equal(done?.live?.cost_usd, 0.0123);
  assert.deepEqual(done?.live?.tokens, { input: 1850, output: 160, cache_read: 0, cache_write: 0 });
  assert.deepEqual(
    seen.map((a) => [a.kind, a.text]),
    [
      ['run', 'Started by Lampo'],
      ['tool', 'Reading src/Logo.tsx'],
      ['tool', 'Editing src/Logo.tsx'],
      ['run', seen.at(-1)?.text],
    ],
  );
  assert.match(String(seen.at(-1)?.text), /^Finished after \d+ s$/);
  assert.ok(!JSON.stringify(seen).includes(cwd), 'paths are relative to the session folder');
  assert.equal(activity.live(slug)[0].current?.key, 'Finished after {time}');
});
