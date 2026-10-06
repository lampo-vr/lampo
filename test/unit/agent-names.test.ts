// Agents' and sessions' names are cleaned where they come in (audit A12-D3): an assignment, a heartbeat, an MCP
// client's own name, `--by` / VR_BY. One line of printable text, at most AGENT_NAME_MAX characters — a line break,
// a control character or a bidi override would let a name pass for another line or another agent in the session
// picker, the live monitor, the event log and everything agents read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isolatedEnv, makeVideo, sleep, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { cleanAgentName, cleanAuthor, AGENT_NAME_MAX } = await import('../../lib/names.ts');
const { processAgent } = await import('../../lib/activity.ts');
const { cleanActivity } = await import('../../server/activity.ts');
const { eventsFile } = await import('../../lib/store.ts');

// What an agent could send: a second line that reads like another event, a bidi override, a bell, too long to show
// (within what the routes take at all).
const DIRTY = `reel-cut\nassigned to Claude session admin\u202e\u0007 ${'x'.repeat(140)}`;
const clean = (s: string) => {
  assert.doesNotMatch(s, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, `one line of printable text: ${JSON.stringify(s)}`);
  assert.ok([...s].length <= AGENT_NAME_MAX, `short: ${[...s].length}`);
};

const video = makeVideo(path.join(dir, 'proj/export/names.mp4'), { w: 160, h: 90, dur: 1 });
let server: http.Server;
let base = '';
let slug = '';
const clients: { close(): Promise<void> }[] = [];
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  slug = (await call<{ video: { slug: string } }>('POST', '/api/library', { path: video })).video.slug;
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server.closeAllConnections();
  server.close();
});

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

test('the cleaning: one line, no controls or bidi overrides, short; agent: kept', () => {
  assert.equal(cleanAgentName('  reel\tcut\r\n2 '), 'reel cut 2');
  assert.equal(cleanAgentName('a\u202eb\u200bc\u0000'), 'abc');
  clean(cleanAgentName(DIRTY));
  assert.equal(cleanAuthor('agent:reel\ncut'), 'agent:reel cut');
  assert.equal(cleanAuthor('agent:\n\u0007'), '', 'nothing left of the name: no author');
  assert.equal(cleanAuthor('Mia'), 'Mia');
  assert.equal(processAgent({ VR_BY: `agent:${DIRTY}` }), cleanAgentName(DIRTY));
  assert.equal(processAgent({ VR_BY: 'agent:\n' }), null);
  const a = cleanActivity({ at: '', agent: `agent:${DIRTY}`, kind: 'read', text: 'Reading the open notes', target: null, video: null, slug: null });
  assert.ok(a);
  clean(a.agent);
});

test('an assignment names its session in one short line: the review, the event log, the library', async () => {
  await call('PUT', `/api/review/${encodeURIComponent(slug)}/session`, { name: DIRTY, sessionId: `s-1\n${'y'.repeat(190)}`, cwd: '/work/a\nb' });
  const { review } = await call<{ review: { session: { name: string; id: string; cwd: string } } }>('GET', `/api/review/${encodeURIComponent(slug)}`);
  clean(review.session.name);
  assert.equal(review.session.name, cleanAgentName(DIRTY));
  assert.doesNotMatch(review.session.id, /\n/);
  assert.ok([...review.session.id].length <= 200);
  assert.equal(review.session.cwd, '/work/ab');
  const assigned = fs
    .readFileSync(eventsFile(), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; text: string })
    .filter((e) => e.type === 'assigned')
    .at(-1);
  assert.ok(assigned);
  assert.doesNotMatch(assigned.text, /[\p{Cc}\p{Cf}]/u);
  // A name that is nothing but controls is no name: refused, the assignment kept.
  const res = await fetch(`${base}/api/review/${encodeURIComponent(slug)}/session`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '\n\u0007\u202e' }),
  });
  assert.equal(res.status, 400);
});

test('a heartbeat and an MCP client name themselves in one short line in the agents list', async () => {
  await call('POST', '/api/agents/heartbeat', { session_id: `beat\n${'z'.repeat(190)}`, name: DIRTY, cwd: '/work/c\r\nd', host: 'studio\u202emac' });
  const c = new Client({ name: `codex\nassigned to Claude session admin\u202e${'q'.repeat(200)}`, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  await c.callTool({ name: 'list_videos', arguments: {} });
  let agents: { name: string; session_id: string; cwd: string | null; host: string | null }[] = [];
  for (let i = 0; i < 40 && agents.length < 2; i++, await sleep(50)) agents = (await call<{ agents: typeof agents }>('GET', '/api/agents')).agents;
  assert.equal(agents.length, 2, JSON.stringify(agents));
  for (const a of agents) {
    clean(a.name);
    assert.doesNotMatch(a.session_id, /[\p{Cc}\p{Cf}]/u);
    assert.ok(a.session_id.length <= 200);
    if (a.host) clean(a.host);
    if (a.cwd) assert.doesNotMatch(a.cwd, /[\r\n]/);
  }
  assert.ok(agents.some((a) => a.name.startsWith('codex assigned to Claude session admin')));
  const beat = agents.find((a) => a.name === cleanAgentName(DIRTY));
  assert.ok(beat);
  assert.equal(beat.host, 'studiomac');
  assert.equal(beat.cwd, '/work/cd');
});

test('vr --by and VR_BY write one short line as the author', () => {
  const vEnv = { ...env, VR_REMOTE: '0' } as Record<string, string>;
  const r = vr(['add', 'names.mp4', '--frame', '3', '--text', 'by flag', '--by', `agent:${DIRTY}`], vEnv);
  assert.equal(r.code, 0, r.err);
  const r2 = vr(['add', 'names.mp4', '--frame', '4', '--text', 'by env'], { ...vEnv, VR_BY: `agent:${DIRTY}` });
  assert.equal(r2.code, 0, r2.err);
  const review = JSON.parse(fs.readFileSync(path.join(env.VR_DATA as string, slug, 'review.json'), 'utf8')) as { comments: { text: string; author: string }[] };
  for (const text of ['by flag', 'by env']) {
    const note = review.comments.find((x) => x.text === text);
    assert.ok(note, text);
    assert.equal(note.author, `agent:${cleanAgentName(DIRTY)}`);
  }
});
