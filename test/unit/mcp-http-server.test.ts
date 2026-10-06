// MCP over Streamable HTTP on a hosted server: an API token is required (401 with a Bearer challenge without one),
// the tool set is the hosted one (no filesystem paths), authorship can't be forged, and feedback never carries
// server paths. Real SDK v2 client (2026-07-28) against the app in server mode on a random port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { startFeed } = await import('../../server/feed.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'setup' });
const slug = slugOf(video);

const { ctx, base } = await startApp();
const feed = startFeed(ctx.broadcast, { interval: 50 });
let token = '';
const clients: Client[] = [];

before(async () => {
  const u = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  token = auth.createToken(u.id, 'mcp test').token;
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  feed.stop();
});

async function connect(bearer = token): Promise<Client> {
  const c = new Client({ name: 'hosted-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  clients.push(c);
  return c;
}

type Result = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

test('no token: 401 with a Bearer challenge that points at the OAuth metadata; a wrong token says invalid_token', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const none = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(none.status, 401);
  assert.equal(
    none.headers.get('www-authenticate'),
    `Bearer realm="video-review", resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp", scope="review:read review:comment review:act post:draft"`,
    'clients can discover the OAuth sign-in from the challenge (RFC 9728)',
  );
  const wrong = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer vr_forged' }, body });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate') || '', /error="invalid_token"/);
});

test('with a token: the hosted tool set, no paths, and authorship that cannot be forged', async () => {
  const c = await connect();
  assert.equal(c.getNegotiatedProtocolVersion(), '2026-07-28');
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('track_video'), 'no tracking of server paths');
  assert.ok(names.includes('get_open_notes') && names.includes('wait_for_feedback'));

  const forged = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 3, text: 'x', by: 'Somebody Else' } })) as Result;
  assert.ok(forged.isError);
  assert.match(textOf(forged), /by must be agent:<name>/);
  const byPath = (await c.callTool({ name: 'add_note', arguments: { video: '/etc/hosts', frame: 0, text: 'x' } })) as Result;
  assert.ok(byPath.isError, 'a hosted server never adds files from its own disk');

  const added = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 4, text: 'Frage vom Agenten' } })) as Result;
  assert.match(textOf(added), /pinned at .* by agent:hosted-test\nkind: question$/, "an agent's note is a question by default");
  assert.ok(!textOf(added).includes(dir), 'no screenshot path from the server');
});

test('wait_for_feedback returns human feedback with URLs, not server paths; the card links the public URL', async () => {
  const c = await connect();
  const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 15 } }) as Promise<Result>;
  await new Promise((r) => setTimeout(r, 300));
  const res = await fetch(`${base}/api/review/${encodeURIComponent(slug)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ frame: 6, text: 'Bitte heller' }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const got = await waiting;
  const t = textOf(got);
  // The line names no files; the event in structuredContent carries the screenshot's URL.
  assert.match(t, /NEW SHOULD .* — "Bitte heller"\n/);
  const event = (got.structuredContent as { events: { shots?: { marked?: string } }[] }).events[0];
  assert.match(String(event.shots?.marked), /^\/data\//);
  // Uploaded videos have virtual names; this one was registered from a file for brevity, so only the store matters.
  const storePath = path.join(dir, 'data');
  assert.ok(!t.includes(storePath), t);
  assert.ok(!JSON.stringify(got.structuredContent).includes(storePath));
  // Nor does a note in full: its pictures come along, its files stay the server's.
  const one = (await c.callTool({ name: 'get_note', arguments: { id: (event as { id?: string }).id } })) as Result;
  assert.match(textOf(one), /Bitte heller/);
  assert.ok(!textOf(one).includes(storePath), textOf(one));

  const card = (await c.callTool({ name: 'show_review', arguments: { video: 'spot.mp4' } })) as Result;
  assert.match(String((card.structuredContent as { playerUrl: string }).playerUrl), /^http:\/\/review\.test\/#\/v\//);

  // The inbox resource is rendered for the client too: screenshot URLs, no server paths.
  const inbox = await c.readResource({ uri: 'vr://inbox' });
  const md = inbox.contents.map((x) => ('text' in x ? x.text : '')).join('');
  assert.match(md, /Bitte heller/);
  assert.match(md, /\/data\//);
  assert.ok(!md.includes(storePath), md);
});

test('a reviewer over MCP gets exactly the app role: read, comment as themselves, no fixing, no posing as an agent', async () => {
  const u = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'another long password', role: 'reviewer' });
  const c = await connect(auth.createToken(u.id, 'reviewer mcp').token);
  const list = (await c.callTool({ name: 'list_videos', arguments: {} })) as Result;
  assert.ok(!list.isError, textOf(list));

  const mine = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 4, text: 'Logo größer' } })) as Result;
  assert.ok(!mine.isError, textOf(mine));
  const id = /(c_[0-9a-f]{6})/.exec(textOf(mine))?.[1];
  const note = store.findComment(id as string)?.comment;
  assert.equal(note?.author, 'Rita', 'written as the reviewer');
  assert.equal(note?.kind, undefined, "a person's note is feedback");

  const fixed = (await c.callTool({ name: 'mark_fixed', arguments: { id, note: 'done' } })) as Result;
  assert.ok(fixed.isError && /may not/.test(textOf(fixed)), textOf(fixed));
  const posing = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 5, text: 'x', by: 'agent:someone' } })) as Result;
  assert.ok(posing.isError && /may not write as an agent/.test(textOf(posing)), textOf(posing));

  // A reference on someone else's note comes with a reply saying what it is for, as over HTTP.
  const theirs = store.addComment(slug, { frame: 2, text: 'Farbe', author: 'Olivia' });
  const bare = (await c.callTool({ name: 'attach_reference', arguments: { id: theirs.id, url: 'https://example.com/like-this' } })) as Result;
  assert.ok(bare.isError && /only its author/.test(textOf(bare)), textOf(bare));
  const said = (await c.callTool({ name: 'attach_reference', arguments: { id: theirs.id, url: 'https://example.com/like-this', note: 'wie hier' } })) as Result;
  assert.ok(!said.isError, textOf(said));
  assert.equal(store.findComment(theirs.id)?.comment.replies.at(-1)?.by, 'Rita', 'it came as Rita’s reply');

  // Where the assigned agent works is for those who work with agents: review.md over MCP leaves it out for a reviewer.
  const cwd = '/Users/someone/Projects/secret-client';
  store.createOrGetReview(video, { session: { name: 'promo-edit', sessionId: 's-1', cwd } });
  const md = async (client: Client) => {
    const r = await client.readResource({ uri: `vr://review/${encodeURIComponent(slug)}` });
    return String((r.contents[0] as { text: string }).text);
  };
  assert.ok(!(await md(c)).includes(cwd), 'hidden from the reviewer');
  assert.ok((await md(await connect())).includes(cwd), 'the owner sees it');
});

test('a hosted MCP client is a connected agent while it talks: videos can be handed to it (reviewers are not listed)', async () => {
  const bearer = { Authorization: `Bearer ${token}` };
  await connect();
  const agents = (await (await fetch(`${base}/api/agents`, { headers: bearer })).json()) as { agents: { session_id: string; name: string; user: string }[] };
  const me = agents.agents.find((a) => a.name === 'hosted-test · Olivia');
  assert.ok(me, JSON.stringify(agents));
  assert.equal(me.user, 'Olivia');
  const sessions = (await (await fetch(`${base}/api/sessions`, { headers: bearer })).json()) as { sessions: { sessionId: string }[] };
  assert.ok(
    sessions.sessions.some((x) => x.sessionId === me.session_id),
    'in the "assign to" list',
  );
  // Handed to it, the video reads "an agent is on it" while the client is connected.
  const assign = await fetch(`${base}/api/review/${encodeURIComponent(slug)}/session`, {
    method: 'PUT',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ name: me.name, sessionId: me.session_id }),
  });
  assert.equal(assign.status, 200);
  const lib = (await (await fetch(`${base}/api/library`, { headers: bearer })).json()) as { videos: { slug: string; sessionActive: boolean | null }[] };
  assert.equal(lib.videos.find((v) => v.slug === slug)?.sessionActive, true);

  const rita = auth.listUsers().find((x) => x.name === 'Rita');
  assert.ok(rita, 'created by the reviewer test');
  await connect(auth.createToken(rita.id, 'reviewer agent').token);
  const again = (await (await fetch(`${base}/api/agents`, { headers: bearer })).json()) as { agents: { name: string }[] };
  assert.ok(!again.agents.some((a) => a.name.endsWith('· Rita')), 'reviewers do not hand work to agents');
});

test('request_upload: a one-time URL that takes one plain PUT and becomes a video, then its next version', async () => {
  const c = await connect();
  const put = async (url: string, file: string) => {
    const bytes = fs.readFileSync(file);
    const r = await fetch(url.replace(PUBLIC, base), { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const urlOf = (r: Result) => /https?:\/\/\S+\/api\/uploads\/direct\/vrup_[\w-]+/.exec(textOf(r))?.[0] as string;

  const first = (await c.callTool({ name: 'request_upload', arguments: { filename: 'agent-cut.mp4', folder: 'Acme/Agent' } })) as Result;
  assert.ok(!first.isError, textOf(first));
  const url = urlOf(first);
  assert.ok(url?.startsWith(`${PUBLIC}/api/uploads/direct/`), textOf(first));
  assert.match(textOf(first), /curl -fT 'agent-cut\.mp4'/);
  const clip = makeVideo(path.join(dir, 'agent/agent-cut.mp4'), { w: 160, h: 90, dur: 1 });
  const done = await put(url, clip);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual([done.json.v, done.json.created, done.json.duplicate], [1, true, false]);
  // The agent reads this from curl's output: the person reviews it now, so it waits now, with a cursor from this moment
  // (lib/handoff.ts) — a note the person writes before its next call is heard all the same.
  const cursor = done.json.cursor as string;
  assert.match(cursor, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z#\d+$/, JSON.stringify(done.json));
  assert.equal(done.json.next, `Now call wait_for_feedback with since "${cursor}": the person's notes arrive together when they press Send.`);
  const early = store.addComment(done.json.slug as string, { frame: 2, text: 'Before the agent waits', severity: 'must', author: 'Olivia' });
  const heard = (await c.callTool({ name: 'wait_for_feedback', arguments: { since: cursor, timeout_s: 5 } })) as Result;
  assert.match(textOf(heard), new RegExp(`^1 new:\\n.*${early.id}`), textOf(heard));
  const review = store.loadReview(done.json.slug as string);
  assert.equal(review?.folder, 'Acme/Agent');
  assert.equal(review?.added_by, 'Olivia', 'the upload is by whoever asked for the URL');
  const status = await fetch(url.replace(PUBLIC, base));
  assert.deepEqual(await status.json(), done.json, 'GET on the URL reports the outcome');
  assert.equal((await put(url, clip)).status, 410, 'one use only');

  const next = (await c.callTool({ name: 'request_upload', arguments: { filename: 'agent-cut.mp4', video: 'agent-cut.mp4' } })) as Result;
  const v2 = await put(urlOf(next), makeVideo(path.join(dir, 'agent/agent-cut-2.mp4'), { w: 160, h: 90, dur: 1, freq: 700 }));
  assert.deepEqual([v2.status, v2.json.v, v2.json.slug], [200, 2, done.json.slug]);
  // An agent whose own network refuses the PUT (a chat app's sandbox) hands the person the app's page for the same upload:
  // the folder in the library for a new video, the video's page for its next version, the library without a folder.
  const pageOf = (r: Result) => /the person can upload it in the app: (\S+)$/.exec(textOf(r))?.[1];
  assert.equal(pageOf(first), `${PUBLIC}/#/folder/${encodeURIComponent('Acme/Agent')}`, textOf(first));
  assert.equal(pageOf(next), `${PUBLIC}/#/v/${encodeURIComponent(done.json.slug as string)}`, textOf(next));
  const loose = (await c.callTool({ name: 'request_upload', arguments: { filename: 'loose.mp4', folder: ' Acme / Agent ' } })) as Result;
  assert.equal(pageOf(loose), `${PUBLIC}/#/folder/${encodeURIComponent('Acme/Agent')}`, 'the folder as the upload will name it');
  const unsorted = (await c.callTool({ name: 'request_upload', arguments: { filename: 'loose.mp4' } })) as Result;
  assert.equal(pageOf(unsorted), `${PUBLIC}/#/`, textOf(unsorted));

  assert.equal((await fetch(`${base}/api/uploads/direct/vrup_${'x'.repeat(32)}`, { method: 'PUT', body: 'x' })).status, 404);
  const bad = (await c.callTool({ name: 'request_upload', arguments: { filename: 'notes.txt' } })) as Result;
  assert.ok(bad.isError, 'not a video name');
});
