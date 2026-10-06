// One app: on a person's own machine the app is the hosted app (accounts, invites, tokens, uploads) with the machine's
// extras on top — and its owner is signed in automatically, but only from the machine itself. A store made before
// (path-tracked renders, notes, review links, dismissed For-you items) opens as it was, with its owner account added.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify, VERSIONS } = await import('../../lib/paths.ts');
const auth = await import('../../lib/auth.ts');
const { dismiss } = await import('../../lib/foryou.ts');
const { loadConfig } = await import('../../lib/config.ts');

// A store the way the machine made it before it had accounts: a linked render with a note, and a dismissed item.
const video = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
const note = store.addComment(slug, { frame: 3, text: 'Logo später', author: 'tester' });
dismiss('owner', [`ver:${slug}:1`]);
const versionsBefore = fs.readdirSync(VERSIONS, { recursive: true }).sort();
const usersBefore = fs.existsSync(auth.USERS_FILE);

const LAN = 'lan-token-123';
const { port } = await startApp({ lan: true, token: LAN, loadSessions: async () => [] });
const { port: hostedPort } = await startApp({ cfg: { ...loadConfig(), mode: 'server' }, loadSessions: async () => [] });

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function request(
  method: string,
  url: string,
  { body, headers = {}, to = port }: { body?: unknown; headers?: Record<string, string>; to?: number } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: to, method, path: url, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
// What a proxy, the tunnel or another device looks like to the server: not the machine itself.
const remote = { 'x-forwarded-for': '203.0.113.9' };

test('the first start adds the owner account, named like the notes; nothing else in the store changes', () => {
  assert.equal(usersBefore, false, 'the store had no accounts before');
  const users = auth.listUsers();
  assert.equal(users.length, 1);
  assert.deepEqual([users[0]?.name, users[0]?.role, users[0]?.local, users[0]?.password], ['tester', 'owner', true, '']);
  assert.deepEqual(fs.readdirSync(VERSIONS, { recursive: true }).sort(), versionsBefore, 'versions/ untouched');
});

test('from the machine itself the owner is signed in: the library, the notes, the For-you state as before', async () => {
  const status = (await request('GET', '/api/auth/status')).json();
  assert.equal(status.user.name, 'tester');
  assert.equal(status.via, 'local');
  assert.equal(status.user.has_password, false);
  const lib = (await request('GET', '/api/library')).json();
  assert.deepEqual(
    lib.videos.map((v: { slug: string }) => v.slug),
    [slug],
  );
  const review = (await request('GET', `/api/review/${encodeURIComponent(slug)}`)).json();
  assert.equal(review.review.comments[0].id, note.id);
  assert.ok(review.dataDir, 'the owner at the machine sees where the files are');
  const fy = (await request('GET', '/api/for-you')).json();
  assert.ok(!fy.items.some((i: { key: string }) => i.key === `ver:${slug}:1`), 'what the owner dismissed stays dismissed');
});

test('anything that is not the machine itself signs in: proxies, the tunnel, another device', async () => {
  assert.equal((await request('GET', '/api/library', { headers: remote })).status, 401);
  assert.equal((await request('GET', '/api/library', { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 401, 'the tunnel');
  assert.equal((await request('GET', '/api/auth/status', { headers: remote })).json().user, null);
  const info = (await request('GET', '/api/info', { headers: remote })).json();
  assert.deepEqual([info.dataDir, info.home, info.urls.length], ['', '', 0], 'no paths and no LAN link for strangers');
  assert.equal(info.capabilities.linkFiles, true, 'what the machine can do is not a secret');
  // A token that doesn't check out is nobody, even from the machine itself.
  assert.equal((await request('GET', '/api/library', { headers: { authorization: 'Bearer vr_not-a-real-token' } })).status, 401);
});

test('the LAN link signs a phone in as the owner (HttpOnly cookie), but it never links files or sets a first password', async () => {
  const first = await request('GET', `/api/library?t=${LAN}`, { headers: remote });
  assert.equal(first.status, 200, 'the link itself works on the first request');
  const cookie = String(first.headers['set-cookie']);
  assert.match(cookie, new RegExp(`vr_t=${LAN}; .*HttpOnly`));
  const phone = { ...remote, cookie: `vr_t=${LAN}` };
  assert.equal((await request('GET', '/api/auth/status', { headers: phone })).json().via, 'lan');
  assert.equal((await request('GET', '/api/library', { headers: { ...remote, cookie: 'vr_t=wrong' } })).status, 401);
  const link = await request('POST', '/api/library', { headers: phone, body: { path: video } });
  assert.equal(link.status, 403, 'a path on the machine is named from the machine itself');
  // (writes from the app's own page: its origin, so what answers is the rule, not the guard)
  const write = { ...phone, origin: `http://127.0.0.1:${port}` };
  const pw = await request('PATCH', '/api/auth/me', { headers: write, body: { password: 'a-new-password-1' } });
  assert.equal(pw.status, 403, 'the first password is set at the machine');
  assert.match(pw.json().error, /current password/);
  // VA-2: nor through the admin route on the owner itself — the link would become a password that works without it.
  const owner = auth.localOwner() as import('../../lib/auth.ts').User;
  const adm = await request('PATCH', `/api/admin/users/${owner.id}`, {
    headers: write,
    body: { password: 'set from the phone 1', email: 'phone@example.net' },
  });
  assert.equal(adm.status, 403, JSON.stringify(adm.json()));
  assert.match(adm.json().error, /current password/);
  assert.deepEqual([auth.localOwner()?.password, auth.localOwner()?.email], ['', owner.email], 'no password, the address as it was');
});

test('an invited teammate is an account like on a hosted server: signs in, never names a path on the machine', async () => {
  const member = await auth.createUser({ email: 'sam@example.com', name: 'Sam', password: 'correct horse battery', role: 'member' });
  const sam = { ...remote, cookie: `vr_session=${auth.signSession(member)}` };
  const me = (await request('GET', '/api/auth/me', { headers: sam })).json();
  assert.deepEqual([me.name, me.via], ['Sam', 'cookie']);
  assert.equal((await request('GET', '/api/library', { headers: sam })).status, 200);
  assert.equal((await request('GET', `/api/browse?dir=${encodeURIComponent(dir)}`, { headers: sam })).status, 403);
  assert.equal((await request('POST', '/api/library', { headers: sam, body: { path: video } })).status, 403);
  const review = (await request('GET', `/api/review/${encodeURIComponent(slug)}`, { headers: sam })).json();
  assert.equal(review.dataDir, '', "the store's folder is the owner's business");
});

test('the owner sets a first password at the machine, then signs in from anywhere with it', async () => {
  const set = await request('PATCH', '/api/auth/me', { body: { email: 'owner@example.com', password: 'a-long-new-password' } });
  assert.equal(set.status, 200, JSON.stringify(set.json()));
  assert.equal(set.json().user.has_password, true);
  const login = await request('POST', '/api/auth/login', { headers: remote, body: { email: 'owner@example.com', password: 'a-long-new-password' } });
  assert.equal(login.status, 200);
  // From now on a change needs the current password, like anywhere else.
  assert.equal((await request('PATCH', '/api/auth/me', { body: { password: 'another-password-9' } })).status, 403);
});

test('invites work on the machine too', async () => {
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', days: 3 } });
  assert.equal(inv.status, 200);
  const token = /#\/invite\/(.+)$/.exec(inv.json().url)?.[1] as string;
  const peek = await request('POST', '/api/auth/invite/peek', { headers: remote, body: { token } });
  assert.equal(peek.json().role, 'reviewer');
});

test('a hosted server never signs anyone in automatically, not even from its own loopback', async () => {
  assert.equal((await request('GET', '/api/library', { to: hostedPort })).status, 401);
  assert.equal((await request('GET', '/api/auth/status', { to: hostedPort })).json().user, null);
  const info = (await request('GET', '/api/info', { to: hostedPort })).json();
  assert.deepEqual(
    Object.values(info.capabilities),
    Object.values(info.capabilities).map(() => false),
    'no machine extras',
  );
  assert.equal(info.dataDir, '');
});
