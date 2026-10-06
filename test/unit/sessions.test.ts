// Signing out ends the session on the server, not only in the browser: a copy of the cookie (a shared computer, a
// proxy log) stops working at once, while the person's other devices stay signed in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, must } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const { request } = await startApp({ headers: { Host: 'review.test' } });
before(async () => {
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
});

const signIn = async () => {
  const r = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' }, headers: { Origin: PUBLIC } });
  assert.equal(r.status, 200, r.text);
  return cookieFrom(r);
};
const me = async (cookie: string) => (await request('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status;

test('a cookie copied before sign-out is refused afterwards; the other device stays signed in', async () => {
  const laptop = await signIn();
  const phone = await signIn();
  assert.notEqual(laptop, phone, 'every sign-in is its own session');
  assert.equal(await me(laptop), 200);
  const out = await request('POST', '/api/auth/logout', { headers: { Cookie: laptop, Origin: PUBLIC } });
  assert.equal(out.status, 200);
  assert.equal(await me(laptop), 401, 'the copy of the signed-out cookie');
  assert.equal(await me(phone), 200, 'signing out on one device leaves the others');
});

test('cookies from before session ids keep working until they expire (and "sign out everywhere" still ends them)', async () => {
  const user = auth.findUserByEmail('olivia@example.com');
  assert.ok(user);
  const payload = Buffer.from(JSON.stringify({ u: user.id, e: user.epoch, x: Date.now() + 86400000 })).toString('base64url');
  const crypto = await import('node:crypto');
  const legacy = `vr_session=${payload}.${crypto.createHmac('sha256', auth.secret()).update(payload).digest('base64url')}`;
  assert.equal(await me(legacy), 200);
  auth.signOutEverywhere(user.id);
  assert.equal(await me(legacy), 401);
});

test('a signed-out session stays signed out, however many sign-outs come after it', async () => {
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  const max = must(auth.findUserByEmail('max@example.com'));
  const value = auth.signSession(max, 1);
  const stolen = `vr_session=${value}`;
  assert.equal(await me(stolen), 200);
  auth.revokeSession(value);
  assert.equal(await me(stolen), 401);
  // What ten thousand sign-in / sign-out cycles leave behind: sessions that would have lived longer than this one.
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8'));
  const later = Date.now() + 20 * 86400000;
  f.revoked.push(...Array.from({ length: 10_000 }, (_, i) => ({ s: `cycle${i}`, until: later })), { s: 'long-over', until: Date.now() - 1000 });
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f));
  auth.revokeSession(auth.signSession(max));
  assert.equal(await me(stolen), 401, 'the stolen cookie is not back');
  const kept = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8')).revoked.map((r: { s: string }) => r.s);
  assert.ok(!kept.includes('long-over'), 'sessions that expired anyway are forgotten');
  assert.equal(kept.length, f.revoked.length, 'the new one remembered, the expired one gone, all others kept');
});
