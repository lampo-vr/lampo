// Server mode end to end on a real socket: first-run setup, sign-in (throttled), cookies vs API tokens, CSRF and host
// checks, roles, what a hosted server refuses to do, and uploads becoming versions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const store = await import('../../lib/store.ts');
const { THEME_BOOT_HASH } = await import('../../server/guard.ts');

const { ctx, server, request } = await startApp();

const origin = { Origin: PUBLIC };
let owner = '';
let ownerToken = '';

test('a fresh server asks for setup, serves nothing private, and reports its mode', async () => {
  assert.equal((await request('GET', '/healthz')).status, 200);
  const status = (await request('GET', '/api/auth/status')).json();
  assert.equal(status.mode, 'server');
  assert.equal(status.setup, true);
  for (const url of ['/api/library', '/api/reviews', '/api/events', '/api/folders', '/data/x/y.png', '/media/x/v1'])
    assert.equal((await request('GET', url)).status, 401, url);
  const info = (await request('GET', '/api/info')).json();
  assert.equal(info.mode, 'server');
  assert.deepEqual([info.dataDir, info.home, info.root], ['', '', '']);
  assert.equal(info.features.paths, false);
  assert.equal(info.features.accounts, true);
});

test('setup: wrong token refused, right token creates the owner once', async () => {
  const body = { email: 'Owner@Example.com', name: 'Olivia', password: 'correct horse battery' };
  assert.equal((await request('POST', '/api/auth/setup', { body: { ...body, token: 'nope' }, headers: origin })).status, 403);
  assert.equal((await request('POST', '/api/auth/setup', { body: { ...body, token: ctx.setup.token, password: 'short' }, headers: origin })).status, 400);
  const ok = await request('POST', '/api/auth/setup', { body: { ...body, token: ctx.setup.token }, headers: origin });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().user.role, 'owner');
  assert.equal(ok.json().user.email, 'owner@example.com');
  assert.equal(ok.json().user.password, undefined, 'never the hash');
  owner = cookieFrom(ok);
  assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
  assert.equal((await request('POST', '/api/auth/setup', { body: { ...body, token: 'x' }, headers: origin })).status, 409);
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'data/users.json'), 'utf8'));
  assert.match(users.users[0].password, /^scrypt\$/);
  assert.equal(fs.statSync(path.join(dir, 'data/users.json')).mode & 0o777, 0o600);
});

test('cookies need our own origin for writes; foreign hosts and origins are refused', async () => {
  const me = await request('GET', '/api/auth/me', { headers: { Cookie: owner } });
  assert.equal(me.status, 200);
  assert.equal(me.json().name, 'Olivia');
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Acme' }, headers: { Cookie: owner } })).status, 403, 'no Origin');
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Acme' }, headers: { Cookie: owner, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Acme' }, headers: { Cookie: owner, ...origin } })).status, 200);
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: owner, Host: 'evil.example' } })).status, 421, 'DNS rebinding');
  assert.equal(
    (await request('POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'x' }, headers: { Origin: 'https://evil.example' } })).status,
    403,
    'login CSRF',
  );
  const tampered = `${owner.slice(0, -3)}abc`;
  assert.equal((await request('GET', '/api/library', { headers: { Cookie: tampered } })).status, 401);
});

test('security headers', async () => {
  const r = await request('GET', '/api/auth/status');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
  // Scripts only from our origin, plus the one inline script that sets the theme before the first paint.
  assert.match(String(r.headers['content-security-policy']), new RegExp(`script-src 'self' ${THEME_BOOT_HASH.replace(/[+/]/g, '\\$&')};`));
});

test('the theme choice is kept on the account (light | dark | system), for every device that loads it', async () => {
  const patch = (body: unknown, headers: Record<string, string> = { Cookie: owner, ...origin }) => request('PATCH', '/api/auth/me', { body, headers });
  // a new account starts with its first run (lib/onboarding.ts) and nothing else until a choice is made
  const fresh = (await request('GET', '/api/auth/me', { headers: { Cookie: owner } })).json().user.prefs;
  assert.deepEqual(Object.keys(fresh), ['onboarding']);
  assert.match(fresh.onboarding.since, /^\d{4}-/);
  assert.equal((await patch({ prefs: { theme: 'sepia' } })).status, 400);
  assert.equal((await patch({ prefs: { theme: 'light', font: 'serif' } })).status, 400, 'only known preferences');
  const r = await patch({ prefs: { theme: 'light' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...r.json().user.prefs, onboarding: undefined }, { theme: 'light', onboarding: undefined });
  assert.equal((await patch({ name: 'Olivia' })).json().user.prefs.theme, 'light', 'a profile change leaves it alone');
  const status = (await request('GET', '/api/auth/status', { headers: { Cookie: owner } })).json();
  assert.equal(status.user.prefs.theme, 'light', 'what a signed-in device sees when it starts');
  assert.equal((await patch({ prefs: { theme: 'system' } })).json().user.prefs.theme, 'system');
});

test('the languages you speak into voice notes are kept on the account; none goes back to the server list', async () => {
  const patch = (body: unknown) => request('PATCH', '/api/auth/me', { body, headers: { Cookie: owner, ...origin } });
  assert.equal((await patch({ prefs: { voice_languages: ['German'] } })).status, 400, 'ISO 639-1 codes only');
  assert.equal((await patch({ prefs: { voice_languages: Array(9).fill('de') } })).status, 400, 'a handful, not a list of everything');
  const set = await patch({ prefs: { voice_languages: ['fr', 'en', 'fr'] } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json().user.prefs.voice_languages, ['fr', 'en'], 'in order, once each');
  assert.equal((await patch({ prefs: { theme: 'dark' } })).json().user.prefs.voice_languages.length, 2, 'other choices leave them alone');
  assert.deepEqual((await patch({ prefs: { voice_languages: [] } })).json().user.prefs.voice_languages, [], 'Automatic is a choice of its own');
  assert.equal((await patch({ prefs: { voice_languages: null } })).json().user.prefs.voice_languages, undefined, 'null: the server’s list again');
});

test('API tokens: bearer auth for agents, revocable, shown once', async () => {
  const made = await request('POST', '/api/auth/tokens', { body: { name: 'laptop' }, headers: { Cookie: owner, ...origin } });
  assert.equal(made.status, 200, made.text);
  ownerToken = made.json().token;
  assert.match(ownerToken, /^vr_[\w-]{32}$/);
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  assert.equal((await request('GET', '/api/library', { headers: bearer })).status, 200);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Tokens' }, headers: bearer })).status, 200, 'no Origin needed for tokens');
  const list = (await request('GET', '/api/auth/tokens', { headers: bearer })).json().tokens;
  assert.equal(list[0].hash, undefined);
  assert.equal(list[0].prefix, ownerToken.slice(0, 9));
  // Tokens are made signed in (a token doesn't mint tokens); one is revoked with itself, as `vr logout` does.
  assert.equal((await request('POST', '/api/auth/tokens', { body: { name: 'temp' }, headers: bearer })).status, 403);
  const temp = (await request('POST', '/api/auth/tokens', { body: { name: 'temp' }, headers: { Cookie: owner, ...origin } })).json();
  assert.equal((await request('DELETE', `/api/auth/tokens/${temp.info.id}`, { headers: bearer })).status, 200);
  assert.equal((await request('GET', '/api/library', { headers: { Authorization: `Bearer ${temp.token}` } })).status, 401);
  assert.equal((await request('GET', '/api/library', { headers: { Authorization: 'Bearer vr_forged' } })).status, 401);
});

test('login: wrong password, then throttled per account; `vr login` gets a token', async () => {
  const bad = { email: 'owner@example.com', password: 'wrong wrong wrong' };
  assert.equal((await request('POST', '/api/auth/login', { body: bad })).status, 401);
  const good = await request('POST', '/api/auth/token', { body: { email: 'OWNER@example.com', password: 'correct horse battery', name: 'cli' } });
  assert.equal(good.status, 200, good.text);
  assert.match(good.json().token, /^vr_/);
  // A member account to lock out, so the owner stays usable for the other tests.
  const made = await request('POST', '/api/admin/users', {
    body: { email: 'mia@example.com', name: 'Mia', password: 'mias password 1' },
    headers: { Cookie: owner, ...origin },
  });
  assert.equal(made.status, 200, made.text);
  let last = 0;
  for (let i = 0; i < 9; i++) last = (await request('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: `nope ${i} nope` } })).status;
  assert.equal(last, 429);
  const locked = await request('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: 'mias password 1' } });
  assert.equal(locked.status, 429, 'even the right password waits');
  assert.ok(Number(locked.headers['retry-after']) > 0);
});

test('roles: members cannot manage users, admins cannot touch owners', async () => {
  // People are managed by people, signed in in the app (an API token manages no one: server/permissions.ts PERSON_ONLY).
  const ownerSession = { Cookie: owner, ...origin };
  const admin = (
    await request('POST', '/api/admin/users', {
      body: { email: 'ada@example.com', name: 'Ada', password: 'adas password 1', role: 'admin' },
      headers: ownerSession,
    })
  ).json().user;
  const adaToken = (await request('POST', '/api/auth/token', { body: { email: 'ada@example.com', password: 'adas password 1' } })).json().token;
  const adaLogin = await request('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'adas password 1' }, headers: origin });
  const ada = { Cookie: cookieFrom(adaLogin), ...origin };
  const users = (await request('GET', '/api/admin/users', { headers: { Authorization: `Bearer ${adaToken}` } })).json().users;
  const ownerId = users.find((u: { role: string }) => u.role === 'owner').id;
  assert.equal((await request('PATCH', `/api/admin/users/${ownerId}`, { body: { disabled: true }, headers: ada })).status, 403);
  assert.equal(
    (await request('POST', '/api/admin/users', { body: { email: 'x@example.com', name: 'X', password: 'xxxxxxxxxxxx', role: 'owner' }, headers: ada })).status,
    403,
  );
  const member = (
    await request('POST', '/api/admin/users', { body: { email: 'max@example.com', name: 'Max', password: 'maxs password 1' }, headers: ada })
  ).json().user;
  const maxToken = (await request('POST', '/api/auth/token', { body: { email: 'max@example.com', password: 'maxs password 1' } })).json().token;
  assert.equal((await request('GET', '/api/admin/users', { headers: { Authorization: `Bearer ${maxToken}` } })).status, 403);
  // Disabling signs out and kills tokens.
  assert.equal((await request('PATCH', `/api/admin/users/${member.id}`, { body: { disabled: true }, headers: ada })).status, 200);
  assert.equal((await request('GET', '/api/library', { headers: { Authorization: `Bearer ${maxToken}` } })).status, 401);
  assert.equal((await request('DELETE', `/api/admin/users/${ownerId}`, { headers: ada })).status, 403);
  assert.ok(admin.id);
});

test('a hosted server never touches its own disk for clients', async () => {
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  assert.equal((await request('GET', '/api/browse?dir=/', { headers: bearer })).status, 403);
  assert.equal((await request('POST', '/api/library', { body: { path: '/etc/hosts' }, headers: bearer })).status, 403);
  assert.equal((await request('POST', '/api/tunnel/start', { headers: bearer })).status, 403);
  for (const f of ['users.json', 'secret.key', 'events.jsonl', '..%2Fusers.json'])
    assert.equal((await request('GET', `/data/x/${f}`, { headers: bearer })).status, 404, f);
  assert.equal((await request('GET', '/data/..%2F..%2Fetc/passwd', { headers: bearer })).status, 404);
  assert.equal((await request('PUT', '/api/review/..%2F..%2Ftmp/approval', { body: { status: 'approved' }, headers: bearer })).status, 404);
});

test('uploads: first upload creates the review, the next one is v2 with notes carried, same bytes are a no-op', async () => {
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const a = makeVideo(path.join(dir, 'in/spot.mp4'), { w: 320, h: 180, dur: 1 });
  const up = await tusUpload(request, a, { filename: '../../spot.mp4', folder: 'Acme/Reels' }, bearer);
  assert.equal(up.status, 200, up.text);
  const res = up.json();
  assert.deepEqual([res.v, res.created, res.duplicate, res.video], [1, true, false, '/@uploads/Acme/Reels/spot.mp4']);
  const review = store.loadReview(res.slug);
  assert.equal(review?.source?.kind, 'upload');
  assert.equal(review?.folder, 'Acme/Reels');
  assert.equal(review?.added_by, 'Olivia');
  assert.equal(store.versionFile(review as NonNullable<typeof review>, 1) !== null, true);

  const note = await request('POST', `/api/review/${encodeURIComponent(res.slug)}/comments`, { body: { frame: 10, text: 'Logo größer' }, headers: bearer });
  assert.equal(note.status, 200, note.text);
  assert.equal(note.json().author, 'Olivia');
  const agentNote = await request('POST', `/api/review/${encodeURIComponent(res.slug)}/comments`, {
    body: { frame: 3, text: 'Frage', by: 'agent:promo-edit' },
    headers: bearer,
  });
  assert.equal(agentNote.json().author, 'agent:promo-edit');
  const png = await request('GET', `/data/${encodeURIComponent(res.slug)}/${note.json().shots.marked}`, { headers: bearer });
  assert.equal(png.status, 200);
  const inbox = (await request('GET', '/api/inbox.md', { headers: bearer })).text;
  assert.ok(inbox.includes('Logo größer') && inbox.includes('/data/'), 'the note is in the inbox with a screenshot URL');
  assert.ok(!inbox.includes(dir), 'no server paths for remote agents');
  const prompt = (await request('GET', `/api/review/${encodeURIComponent(res.slug)}/prompt`, { headers: bearer })).text;
  assert.ok(prompt.includes(`vr login ${PUBLIC}`) && prompt.includes('vr show c_'), prompt);
  assert.ok(!prompt.includes(dir), '"Copy for an agent" has no server paths either');

  const again = await tusUpload(request, a, { filename: 'spot.mp4', folder: 'Acme/Reels' }, bearer);
  assert.equal(again.json().duplicate, true);

  const b = makeVideo(path.join(dir, 'in/spot-v2.mp4'), { w: 320, h: 180, dur: 1, freq: 660 });
  const v2 = await tusUpload(request, b, { filename: 'spot.mp4', folder: 'Acme/Reels' }, bearer);
  assert.equal(v2.status, 200, v2.text);
  assert.deepEqual([v2.json().v, v2.json().created, v2.json().slug], [2, false, res.slug]);
  const after = store.loadReview(res.slug);
  assert.equal(after?.comments.find((c) => c.id === note.json().id)?.check_again, true);

  const media = await request('GET', `/media/${encodeURIComponent(res.slug)}/v2`, { headers: { ...bearer, Range: 'bytes=0-99' } });
  assert.equal(media.status, 206);
  const byUpload = await tusUpload(request, b, { filename: 'other-name.mp4', slug: res.slug }, bearer);
  assert.equal(byUpload.json().duplicate, true, 'explicit slug targets that review');
});

test('the live event stream (browsers, remote `vr watch`) carries screenshot URLs, never server paths', async () => {
  const { startServerFeed } = await import('../../server/feed.ts');
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/feed.mp4'), { w: 320, h: 180, dur: 1 }), { filename: 'feed.mp4' }, bearer);
  const slug = up.json().slug;
  const feed = startServerFeed(ctx, 25);
  let stream = '';
  const sse = http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/events', headers: bearer }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      stream += d;
    });
  });
  try {
    const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 4, text: 'Zu dunkel' }, headers: bearer });
    assert.equal(note.status, 200, note.text);
    const comment = () =>
      stream
        .split('\n\n')
        .filter((m) => m.startsWith('event: event\n'))
        .map((m) => JSON.parse(m.slice(m.indexOf('data: ') + 6)))
        .find((e) => e.type === 'comment' && e.id === note.json().id);
    for (let i = 0; i < 100 && !comment(); i++) await new Promise((r) => setTimeout(r, 20));
    const e = comment();
    assert.ok(e, 'the note arrived on the stream');
    assert.match(e.shots.marked, new RegExp(`^/data/${encodeURIComponent(slug)}/[\\w-]+\\.png$`));
    assert.ok(!stream.includes(dir), 'no server paths on the stream');
  } finally {
    sse.destroy();
    feed.stop();
  }
});

test("reviewers don't see where connected agents run (folders on people's machines, host names)", async () => {
  const auth = await import('../../lib/auth.ts');
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  const asRita = { Authorization: `Bearer ${auth.createToken(rita.id, 'test').token}` };
  const cwd = '/Users/someone/Projects/secret-client';
  const beat = await request('POST', '/api/agents/heartbeat', { body: { session_id: 's-1', name: 'promo-edit', cwd, host: 'studio-mac' }, headers: bearer });
  assert.equal(beat.status, 200, beat.text);
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/agent.mp4'), { w: 160, h: 90, dur: 1 }), { filename: 'agent.mp4' }, bearer);
  const s = encodeURIComponent(up.json().slug);
  const assign = await request('PUT', `/api/review/${s}/session`, { body: { name: 'promo-edit', sessionId: 's-1', cwd }, headers: bearer });
  assert.equal(assign.status, 200, assign.text);
  const note = (await request('POST', `/api/review/${s}/comments`, { body: { frame: 3, text: 'Logo' }, headers: bearer })).json();
  const urls = ['/api/agents', '/api/sessions', '/api/library', `/api/review/${s}`, '/api/reviews', `/api/comments/${note.id}`, `/api/review/${s}/md`];
  for (const url of urls) {
    const asOwner = await request('GET', url, { headers: bearer });
    assert.ok(asOwner.text.includes(cwd), `the owner sees it: ${url}`);
    const asReviewer = await request('GET', url, { headers: asRita });
    assert.equal(asReviewer.status, 200, url);
    assert.ok(!asReviewer.text.includes(cwd) && !asReviewer.text.includes('studio-mac'), `hidden from reviewers: ${url}`);
  }
  const agents = (await request('GET', '/api/agents', { headers: asRita })).json().agents;
  // (named with whose it is: a heartbeat speaks for the account that posts it)
  assert.equal(agents[0].name, 'promo-edit · Olivia', 'the agent itself is still listed');
});

test('/readyz: one boolean per check and no details (public), 503 while stopping', async () => {
  const ready = await request('GET', '/readyz');
  assert.equal(ready.status, 200, ready.text);
  assert.deepEqual(ready.json(), { ok: true, stopping: false, checks: { data: true, disk: true, ffmpeg: true, storage: true, public_url: true } });
  ctx.stopping = true;
  try {
    const draining = await request('GET', '/readyz');
    assert.equal(draining.status, 503);
    assert.equal(draining.json().stopping, true);
  } finally {
    ctx.stopping = false;
  }
  const { createReadiness } = await import('../../server/ready.ts');
  const full = await createReadiness({ minFree: Number.MAX_SAFE_INTEGER, stopping: () => false }).check();
  assert.equal(full.ok, false);
  assert.equal(full.checks.disk, false);
  assert.match(full.details.disk || '', /GB free \(minimum/, 'the log says why');
});

test('uploads that would leave less than the free-disk reserve are refused up front', async () => {
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const clip = makeVideo(path.join(dir, 'in/big-one.mp4'), { w: 160, h: 90, dur: 1 });
  const reserve = ctx.cfg.min_free_bytes;
  ctx.cfg.min_free_bytes = Number.MAX_SAFE_INTEGER;
  try {
    const r = await tusUpload(request, clip, { filename: 'big-one.mp4' }, bearer);
    assert.equal(r.status, 507, r.text);
    assert.match(r.text, /not enough disk space/);
  } finally {
    ctx.cfg.min_free_bytes = reserve;
  }
  assert.equal((await tusUpload(request, clip, { filename: 'big-one.mp4' }, bearer)).status, 200);
});

test('a hosted server does no path-tracking work for uploads and does not rewrite INBOX.md on every event', async () => {
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/quiet.mp4'), { w: 160, h: 90, dur: 1 }), { filename: 'quiet.mp4' }, bearer);
  const slug = up.json().slug;
  assert.equal(store.isUploadSlug(slug), true, 'the periodic re-check skips it');
  assert.equal(store.isUploadSlug(path.join(dir, 'in/quiet.mp4').split('/').join('__')), false);
  const inbox = path.join(dir, 'data/INBOX.md');
  fs.rmSync(inbox, { force: true });
  store.setInboxFile(false);
  try {
    const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 2, text: 'Ton lauter' }, headers: bearer });
    assert.equal(note.status, 200);
    assert.equal(fs.existsSync(inbox), false);
    assert.match((await request('GET', '/api/inbox.md', { headers: bearer })).text, /Ton lauter/, 'rendered on request instead');
  } finally {
    store.setInboxFile(true);
  }
});

test('uploads: not a video, bad names and folders are refused', async () => {
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const fake = path.join(dir, 'in/fake.mp4');
  fs.writeFileSync(fake, '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1,\nfile:///etc/passwd\n');
  const r = await tusUpload(request, fake, { filename: 'fake.mp4' }, bearer);
  assert.equal(r.status, 422, r.text);
  assert.equal((await tusUpload(request, fake, { filename: 'notes.txt' }, bearer)).status, 400);
  assert.equal((await tusUpload(request, fake, { filename: 'x.mp4', folder: 'a/../b' }, bearer)).status, 400);
  assert.equal((await tusUpload(request, fake, { filename: 'x.mp4' })).status, 401, 'needs sign-in');
  assert.equal(fs.readdirSync(path.join(dir, 'cache/uploads')).length, 0, 'failed uploads leave nothing behind');
});

test('5xx answers hide internals in server mode', async () => {
  const { createErrorHandler } = await import('../../server/http.ts');
  const sent: { status?: number; body?: { error: string } } = {};
  const res = {
    headersSent: false,
    setHeader() {},
    status(s: number) {
      sent.status = s;
      return this;
    },
    json(b: { error: string }) {
      sent.body = b;
    },
  };
  const log = console.error;
  console.error = () => {};
  createErrorHandler({ hosted: true })(new Error('ffmpeg exited 1: /srv/secret/path'), { method: 'GET', path: '/x' } as never, res as never, () => {});
  console.error = log;
  assert.equal(sent.status, 500);
  assert.doesNotMatch(sent.body?.error || '', /secret/);
  assert.match(sent.body?.error || '', /ref \w+/);
});
