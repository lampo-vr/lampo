// covers: mcp/loop.ts mcp/core.ts mcp/toolkit.ts mcp/format.ts mcp/tools/read.ts mcp/tools/videos.ts lib/handoff.ts server/routes/mcp.ts server/uploadTickets.ts server/routes/uploads.ts lib/store.ts server/agents.ts server/runs.ts
// The whole loop, driven as an MCP agent drives it on a hosted server after the person says "use Lampo": it connects
// (and the person sees it at once, before any video), reads the instructions, finds the person's project, puts up V1
// itself, waits; the person writes two notes and sends them; the wait hands them over, the agent puts up V2 and marks
// both fixed, its run ends done with the version it made, and it waits again. At every step Lampo's answer says what
// comes next — the loop never ends on a read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { cookieFrom, type Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const oauth = await import('../../lib/oauth/store.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const { base, request } = await startApp({ feed: 50, headers: { Host: 'review.test' } });
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

// the person: an owner of the workspace, signed in in the browser
const PASSWORD = ['a', 'long', 'password', 'here'].join(' ');
const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: PASSWORD }, headers: { Origin: PUBLIC } });
assert.equal(login.status, 200, login.text);
const sessionCookie = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_session=')) || cookieFrom(r);
const person = { Cookie: sessionCookie(login), Origin: PUBLIC };

/** An app connected through OAuth, as Claude Code or Claude connects: its access token. */
function appToken(name: string): string {
  const client_id = `cid-${crypto.randomBytes(4).toString('hex')}`;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id, kind: 'dcr', name, host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read', 'review:comment', 'review:act'],
    resource: `${PUBLIC}/mcp`,
  });
  return oauth.redeemCode({
    code: oauth.createCode(asked, owner),
    client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  }).access_token;
}

async function connect(client: string, app: string): Promise<Client> {
  const c = new Client({ name: client, version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appToken(app)}`, Host: 'review.test' } } }),
  );
  clients.push(c);
  return c;
}

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: Result) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const lastLine = (r: Result) => textOf(r).trimEnd().split('\n').at(-1) ?? '';
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = (await c.callTool({ name, arguments: args })) as Result;
  assert.ok(!r.isError, `${name}: ${textOf(r)}`);
  return r;
}
/** "Nothing waiting for you: …, then call wait_for_feedback with since "<cursor>"." — the next step after a read. */
const NEXT = /^Nothing waiting for you: put up any version you have, then call wait_for_feedback with since "(\S+#\d+)"\.$/;
const WAIT = /^Now call wait_for_feedback with since "(\S+#\d+)": the person's notes arrive together when they press Send\.$/;

/** One PUT to an upload URL request_upload handed out, as `curl -T` sends it. */
async function put(r: Result, file: string): Promise<Record<string, unknown>> {
  const url = /https?:\/\/\S+\/api\/uploads\/direct\/vrup_[\w-]+/.exec(textOf(r))?.[0];
  assert.ok(url, textOf(r));
  const bytes = fs.readFileSync(file);
  const res = await fetch(url.replace(PUBLIC, base), { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

interface Agent {
  name: string;
  session_id: string;
  kind?: string;
  state?: string;
}
const agents = async () => ((await request('GET', '/api/agents', { headers: person })).json().agents ?? []) as Agent[];
/** The person's Get started: which of its steps are done (they tick from what happened, never from a click). */
const ticked = async () =>
  ((await request('GET', '/api/onboarding', { headers: person })).json().steps as { id: string; done: boolean }[]).filter((x) => x.done).map((x) => x.id);

test('a chat app is told the loop the MCP way only: never a vr command', async () => {
  const chat = await connect('claude-ai', 'Claude');
  await chat.listTools();
  const told = chat.getInstructions() ?? '';
  assert.ok(told.length <= 2048, `instructions ${told.length} characters: Claude Code cuts at 2048`);
  assert.match(told, /request_upload/);
  assert.doesNotMatch(told, /\bvr\b/, told);
  await chat.close();
});

test('the loop, end to end: connect, project, V1, notes, V2, fixed, wait again — each answer says what comes next', async () => {
  // 1. The agent connects (the person added Claude Code and said "use Lampo"): it shows at once, before any video.
  const c = await connect('claude-code', 'Claude Code');
  await c.listTools();
  const me = await until(async () => (await agents()).find((a) => a.name === 'claude-code · Olivia'), 'the agent listed as connected');
  assert.equal(me.state, 'idle', 'connected, not waiting yet');
  assert.equal(me.kind, 'claude-code');
  assert.equal((await request('GET', '/api/library', { headers: person })).json().videos.length, 0, 'no video yet');
  // the person's first run is agent work: a project, the agent, its V1 — and the agent's step ticked by its call
  const intro = (await request('GET', '/api/onboarding', { headers: person })).json().steps.map((x: { id: string }) => x.id);
  assert.deepEqual(intro.slice(0, 3), ['project', 'agent', 'agent_video']);
  assert.deepEqual(await ticked(), ['agent']);

  // 2. What it reads first: the whole loop, for a coding agent (renders through vr render, else request_upload).
  const told = c.getInstructions() ?? '';
  assert.ok(told.length <= 2048, `instructions ${told.length} characters: Claude Code cuts at 2048`);
  for (const step of [
    /list_folders/,
    /put up V1 yourself/,
    /vr render --to <video>/,
    /--folder <project>/,
    /request_upload/,
    /get_playbook/,
    /mark_fixed/,
    /wait_for_feedback/,
    /until they approve/,
  ])
    assert.match(told, step);

  // 3. The person made their project first (the setup's first step): the agent finds it, empty, and is told what's next.
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Launch film' }, headers: person })).status, 200);
  const folders = await call(c, 'list_folders');
  assert.match(textOf(folders), /^Launch film {2}\(0 videos, 0 open\) {2}\[Launch film\]/);
  assert.match(lastLine(folders), NEXT, 'an empty project: put up V1, then wait');
  assert.deepEqual(await ticked(), ['project', 'agent']);
  const mine = await call(c, 'list_videos', { session: 'me' });
  assert.match(textOf(mine), /^No videos match\./);
  assert.match(lastLine(mine), NEXT, 'nothing assigned yet: the next step, not silence');

  // 4. It puts up V1 itself, into the project: one request_upload and one PUT. The video is the agent's from V1 on.
  const v1 = await put(
    await call(c, 'request_upload', { filename: 'launch.mp4', folder: 'Launch film' }),
    makeVideo(path.join(dir, 'r/v1.mp4'), { w: 160, h: 90, dur: 1 }),
  );
  assert.deepEqual([v1.v, v1.created], [1, true]);
  assert.match(String(v1.next), WAIT, 'the PUT says: wait now');
  const slug = v1.slug as string;
  const review = store.loadReview(slug);
  assert.equal(review?.folder, 'Launch film');
  assert.equal(review?.session?.name, 'claude-code · Olivia', 'its own V1 is assigned to it');
  assert.equal(review?.session?.id, me.session_id);
  assert.equal(review?.session?.agent, 'claude-code');
  assert.deepEqual(await ticked(), ['project', 'agent', 'agent_video'], '“Claude Code puts up V1” ticks when its version lands');

  // 5. It waits, from the cursor the PUT gave: the person sees it waiting for their notes.
  const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { since: v1.cursor, timeout_s: 60 } }) as Promise<Result>;
  await until(async () => (await agents()).find((a) => a.session_id === me.session_id)?.state === 'listening', 'listening');

  // 6. The person writes two notes (drafts on an agent's video) and sends them together.
  const notes: string[] = [];
  for (const [frame, text] of [
    [3, 'Title comes in too late'],
    [12, 'Logo a touch smaller'],
  ] as const) {
    const d = await request('POST', `/api/review/${encodeURIComponent(slug)}/drafts`, { body: { frame, text, severity: 'must' }, headers: person });
    assert.equal(d.status, 200, d.text);
    notes.push(d.json().id);
  }
  const sent = await request('POST', `/api/review/${encodeURIComponent(slug)}/drafts/send`, { body: {}, headers: person });
  assert.equal(sent.status, 200, sent.text);
  const ids = (sent.json().notes as { id: string }[]).map((n) => n.id);
  assert.equal(ids.length, 2);

  // 7. The wait hands both over, with a cursor for the next one.
  const heard = await waiting;
  assert.ok(!heard.isError, textOf(heard));
  assert.match(textOf(heard), /^2 new:/);
  for (const id of ids) assert.match(textOf(heard), new RegExp(id));
  assert.match(textOf(heard), /\ncursor: \S+#\d+\n/, 'and the cursor to wait from next');
  const run = await until(async () => {
    const r = (await request('GET', `/api/runs?slug=${encodeURIComponent(slug)}`, { headers: person })).json().runs?.[0];
    return r?.state === 'working' ? r : null;
  }, 'its run working on the two notes');
  assert.deepEqual(run.plan.map((p: { id: string }) => p.id).sort(), [...ids].sort());

  // 8. It reads them (work to do: no next-step line), fixes, puts up V2, and marks each fixed.
  const open = await call(c, 'get_open_notes', { video: slug, images: 'none' });
  for (const id of ids) assert.match(textOf(open), new RegExp(`${id} OPEN`));
  assert.doesNotMatch(textOf(open), /Nothing waiting/);
  const v2 = await put(
    await call(c, 'request_upload', { filename: 'launch.mp4', video: slug }),
    makeVideo(path.join(dir, 'r/v2.mp4'), { w: 160, h: 90, dur: 1, freq: 700 }),
  );
  assert.deepEqual([v2.v, v2.slug], [2, slug]);
  const first = await call(c, 'mark_fixed', { id: ids[0], note: 'title in at 0:00:02' });
  assert.equal(lastLine(first), '1 note still open on this video.', 'one left: no waiting yet');
  const last = await call(c, 'mark_fixed', { id: ids[1], note: 'logo at 80 %' });
  const cursor = WAIT.exec(lastLine(last))?.[1];
  assert.ok(cursor, `the last fix hands over: wait now (${lastLine(last)})`);

  // 9. Its run is done, with the version it made; V2 names the run.
  const done = await until(async () => {
    const r = (await request('GET', `/api/runs/${run.id}`, { headers: person })).json().run;
    return r?.state === 'done' ? r : null;
  }, 'the run done');
  assert.equal(done.result?.v, 2);
  assert.equal(done.result?.fixed, 2);
  assert.equal(store.loadReview(slug)?.versions.find((v) => v.v === 2)?.run, run.id, 'V2 came from that run');

  // 10. Nothing left to do on the video: reading it says to wait; and it waits again.
  const settled = await call(c, 'get_open_notes', { video: slug, images: 'none' });
  assert.match(lastLine(settled), NEXT);
  const again = await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 1 });
  assert.match(textOf(again), /^No new feedback in 1 s\.\ncursor: \S+\n.*call wait_for_feedback again now/s);
});

test('an agent that only reads is told to wait: the reads that leave nothing to do end with the next step', async () => {
  const c = await connect('codex-mcp-client', 'Codex');
  // the loop's video has nothing open now: every list says so, and what to do
  for (const [tool, args] of [
    ['list_folders', {}],
    ['list_videos', {}],
    ['list_videos', { session: 'me' }],
  ] as const) {
    const r = await call(c, tool, args);
    assert.match(lastLine(r), NEXT, `${tool} ${JSON.stringify(args)}: ${textOf(r)}`);
  }
  // reading the playbook leaves the work it is read for: no line there
  assert.doesNotMatch(textOf(await call(c, 'get_playbook', { folder: 'Launch film' })), /Nothing waiting/);
  // a video with work open: no line on its list
  const video = store.listReviews()[0];
  assert.ok(video, 'the loop put one up');
  const slug = slugify(video.video);
  store.addComment(slug, { frame: 5, text: 'One more thing', severity: 'should', author: 'Olivia' });
  const busy = await call(c, 'list_videos', {});
  assert.doesNotMatch(textOf(busy), /Nothing waiting/);
});
