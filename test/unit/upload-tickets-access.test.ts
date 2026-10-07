// A one-time upload URL works for 15 minutes, maybe from a shell elsewhere. Whoever asked for it is checked again when
// it is used: removed from the workspace, the token revoked, the account disabled, or no longer allowed to upload (a
// member made a reviewer) — the PUT is refused and nothing lands in the team's library. Render URLs from the HTTP API
// and from MCP's `request_upload`, and the URLs for a fix preview and a reference on a note, alike (audit A12
// verification: VA2-3).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const workspaces = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
// up here, not by the tests that use them: no top-level await below the first test (test/unit/test-files.test.ts)
const oauth = await import('../../lib/oauth/store.ts');
const { DATA } = await import('../../lib/paths.ts');
const { OPEN_PER_OWNER, OPEN_PER_POOL, createUploadTickets } = await import('../../server/uploadTickets.ts');

let server: http.Server;
let port = 0;
let request: Request;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let note = '';
const clip = makeVideo(path.join(dir, 'src', 'render.mp4'), { dur: 1 });
age(clip);
const enc = encodeURIComponent;

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });

before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  for (const [name, role] of [
    ['Olivia', 'owner'],
    ['Max', 'member'],
    ['Mia', 'member'],
    ['Ben', 'member'],
  ] as const) {
    const u = await auth.createUser({ email: `${name.toLowerCase()}@example.com`, name, password: 'a long password', role });
    ids[name] = u.id;
    tokens[name] = auth.createToken(u.id, 'agent').token;
  }
  const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Reels' }, bearer('Olivia'));
  assert.equal(up.status, 200, up.text);
  const slug = up.json().slug as string;
  const made = await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 3, text: 'Logo kleiner' }, headers: bearer('Olivia') });
  assert.equal(made.status, 200, made.text);
  note = made.json().id;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const local = (url: string) => new URL(url, `http://127.0.0.1:${port}`).pathname;

/** The URLs a member can ask for: a render over HTTP and over MCP, a fix preview and a reference on a note. */
async function urlsOf(who: string): Promise<Record<string, string>> {
  const http1 = await request('POST', '/api/uploads/tickets', { body: { filename: `${who}-http.mp4`, folder: 'Reels' }, headers: bearer(who) });
  assert.equal(http1.status, 200, http1.text);
  const preview = await request('POST', `/api/comments/${note}/previews`, { body: { kind: 'still' }, headers: bearer(who) });
  assert.equal(preview.status, 200, preview.text);
  const ref = await request('POST', `/api/comments/${note}/refs`, { body: { kind: 'image', note: 'like this' }, headers: bearer(who) });
  assert.equal(ref.status, 200, ref.text);
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...bearer(who), Host: 'review.test' } } }),
  );
  try {
    const r = (await c.callTool({ name: 'request_upload', arguments: { filename: `${who}-mcp.mp4`, folder: 'Reels' } })) as { content: { text?: string }[] };
    const mcp = /\n(\S*\/api\/uploads\/direct\/\S+)/.exec(r.content[0]?.text ?? '')?.[1];
    assert.ok(mcp, r.content[0]?.text);
    return { http: http1.json().url, mcp, preview: preview.json().upload.url, ref: ref.json().upload.url };
  } finally {
    await c.close();
  }
}

const put = (url: string, file: string) => request('PUT', local(url), { body: fs.readFileSync(file), headers: { 'content-type': 'application/octet-stream' } });
const library = () => store.listReviews().map((r) => path.basename(r.video));

test('a member removed from the workspace: every URL handed out before is refused, nothing lands', async () => {
  const urls = await urlsOf('Max');
  workspaces.removeMember('w1', ids.Max as string);
  for (const [what, url] of Object.entries(urls)) {
    const r = await put(url, clip);
    assert.equal(r.status, 403, `${what}: ${r.status} ${r.text}`);
  }
  assert.ok(!library().some((n) => n.startsWith('Max-')), library().join(', '));
});

test('a member who may no longer upload (now a reviewer), and a revoked token: refused', async () => {
  const mia = await urlsOf('Mia');
  await workspaces.setMemberRole('w1', ids.Mia as string, 'reviewer');
  for (const what of ['http', 'mcp', 'preview'] as const) {
    const r = await put(mia[what] as string, clip);
    assert.equal(r.status, 403, `Mia's ${what}: ${r.status} ${r.text}`);
  }
  const ben = await urlsOf('Ben');
  auth.revokeTokensOf(ids.Ben as string);
  for (const [what, url] of Object.entries(ben)) {
    const r = await put(url, clip);
    assert.equal(r.status, 403, `Ben's ${what} after his token was revoked: ${r.status} ${r.text}`);
  }
  assert.ok(!library().some((n) => n.startsWith('Mia-') || n.startsWith('Ben-')), library().join(', '));
});

test('a member who still may: the URL works as before', async () => {
  const r = await request('POST', '/api/uploads/tickets', { body: { filename: 'Olivia-http.mp4', folder: 'Reels' }, headers: bearer('Olivia') });
  const done = await put(r.json().url, clip);
  assert.equal(done.status, 200, done.text);
  assert.ok(library().includes('Olivia-http.mp4'));
});

// One URL, one upload: two PUTs sent at once while the plan's check waits on a lookup (a billing module's) don't both
// land (sweep 2 MH-3). A PUT the plan refuses takes nothing, and the URL works once it may.
test('a one-time URL takes one upload, also two sent at once while the plan check waits; a refused one keeps it', async () => {
  const check = ctx.extension.check;
  const slow = (refuse: boolean) => async () => {
    await new Promise((r) => setTimeout(r, 150));
    if (refuse) throw Object.assign(new Error('This workspace has used its storage.'), { status: 402 });
  };
  try {
    const one = await request('POST', '/api/uploads/tickets', { body: { filename: 'Olivia-once.mp4', folder: 'Reels' }, headers: bearer('Olivia') });
    assert.equal(one.status, 200, one.text);
    ctx.extension.check = slow(false);
    const [a, b] = await Promise.all([put(one.json().url, clip), put(one.json().url, clip)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 410], `two PUTs at once on one URL: ${a.status} ${a.text} · ${b.status} ${b.text}`);
    const slug = (a.status === 200 ? a : b).json().slug as string;
    assert.equal(store.loadReview(slug)?.versions.length, 1, 'one version from one URL');

    const two = await request('POST', '/api/uploads/tickets', { body: { filename: 'Olivia-later.mp4', folder: 'Reels' }, headers: bearer('Olivia') });
    ctx.extension.check = slow(true);
    const refused = await put(two.json().url, clip);
    assert.equal(refused.status, 402, refused.text);
    assert.ok(!library().includes('Olivia-later.mp4'));
    ctx.extension.check = check;
    const again = await put(two.json().url, clip);
    assert.equal(again.status, 200, `the same URL once the plan allows it: ${again.text}`);
    assert.equal((await put(two.json().url, clip)).status, 410, 'and then it is used');
  } finally {
    ctx.extension.check = check;
  }
});

// An OAuth app's access tokens live an hour and are refreshed; the URL it asked for is the app's for its 15 minutes
// whichever access token is current — checked again by the app's grant, not the access token it asked with (A12
// VE2b-3). And a URL keeps who asked as identifiers only, each account holding at most OPEN_PER_OWNER open (VE2b-4).
const GRANTS = path.join(DATA, 'oauth', 'grants.json');

/** An app the person allowed (review:act): its access token, and its grant's id. */
async function appOf(userId: string): Promise<{ access: string; grant: string }> {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id: `app-${userId}`, kind: 'dcr', name: 'Render bot', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:act'],
    resource: 'http://review.test/mcp',
  });
  const user = auth.getUser(userId);
  assert.ok(user);
  const tokens = oauth.redeemCode({
    code: oauth.createCode(asked, user, 'w1'),
    client_id: `app-${userId}`,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: 'http://review.test/mcp',
  });
  const [app] = oauth.listApps(userId, 'w1');
  assert.ok(app);
  return { access: tokens.access_token, grant: app.id };
}

async function mcpUpload(headers: Record<string, string>, filename: string): Promise<string> {
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...headers, Host: 'review.test' } } }),
  );
  try {
    const r = (await c.callTool({ name: 'request_upload', arguments: { filename, folder: 'Reels' } })) as { content: { text?: string }[] };
    const url = /\n(\S*\/api\/uploads\/direct\/\S+)/.exec(r.content[0]?.text ?? '')?.[1];
    assert.ok(url, r.content[0]?.text);
    return url;
  } finally {
    await c.close();
  }
}

test('an OAuth app’s URL outlives the access token it asked with; it ends with the app’s grant', async () => {
  const ana = await auth.createUser({ email: 'ana@example.com', name: 'Ana', password: 'a long password', role: 'member' });
  const app = await appOf(ana.id);
  const first = await mcpUpload({ Authorization: `Bearer ${app.access}` }, 'Ana-app-1.mp4');
  const second = await mcpUpload({ Authorization: `Bearer ${app.access}` }, 'Ana-app-2.mp4');
  // the hour of that access token runs out while the URL is still valid (the app goes on with a refreshed one)
  const file = JSON.parse(fs.readFileSync(GRANTS, 'utf8')) as { grants: { access: { expires: number }[] }[] };
  for (const g of file.grants) for (const a of g.access) a.expires = Date.now() - 1000;
  fs.writeFileSync(GRANTS, JSON.stringify(file));
  const done = await put(first, clip);
  assert.equal(done.status, 200, `the app is still allowed: ${done.text}`);
  // the person disconnects the app: its URL ends with it
  assert.ok(oauth.revokeApp(app.grant, ana.id));
  const after = await put(second, clip);
  assert.equal(after.status, 403, after.text);
});

test('an account holds at most OPEN_PER_OWNER upload URLs open at once', async () => {
  const sam = await auth.createUser({ email: 'sam@example.com', name: 'Sam', password: 'a long password', role: 'member' });
  const headers = { Authorization: `Bearer ${auth.createToken(sam.id, 'agent').token}` };
  const codes: number[] = [];
  let last: Awaited<ReturnType<typeof request>> | null = null;
  for (let i = 0; i <= OPEN_PER_OWNER; i++) {
    last = await request('POST', '/api/uploads/tickets', { body: { filename: `Sam-${i}.mp4`, folder: 'Reels' }, headers });
    codes.push(last.status);
  }
  assert.ok(
    codes.slice(0, OPEN_PER_OWNER).every((c) => c === 200),
    codes.join(','),
  );
  assert.equal(codes.at(-1), 429, 'one more is refused until some are used or expire');
  // it says why, so a client waits and asks again instead of taking it for a file's day of versions
  assert.equal(last?.json().reason, 'tickets', last?.text);
  assert.equal(last?.json().retry_after, 60);
});

test('a workspace’s team holds at most OPEN_PER_POOL open together, and one review link’s visitors together', () => {
  const t = createUploadTickets();
  const ask = (owner: string, pool: string) => {
    try {
      t.issue({ filename: 'a.mp4' }, 'x', null, undefined, { owner, pool });
      return 200;
    } catch (e) {
      return (e as { status?: number }).status ?? 0;
    }
  };
  const codes: number[] = [];
  for (let i = 0; i < OPEN_PER_POOL; i++) codes.push(ask(`user:u${Math.floor(i / OPEN_PER_OWNER)}`, 'team'));
  assert.ok(codes.every((c) => c === 200));
  assert.equal(ask('user:someone-else', 'team'), 429, 'the team’s pool is full');
  assert.equal(ask('guest:link|a', 'link:one'), 200, 'a link’s visitors have a pool of their own');
});
