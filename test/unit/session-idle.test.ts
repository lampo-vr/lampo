// Sessions end after VR_SESSION_IDLE_DAYS (14) without use and after VR_SESSION_DAYS (30) in any case. A session in
// use slides: the server hands back the same session with a fresh "last active" at most twice a day.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const DAY = 86400000;
const { request } = await startApp({ headers: { Host: 'review.test' } });
let user: Awaited<ReturnType<typeof auth.createUser>>;
before(async () => {
  user = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
});

// A cookie as the server signs it, with chosen times (what a browser would hold after days of use or none).
function cookie(claims: object): string {
  const payload = Buffer.from(JSON.stringify({ u: user.id, e: user.epoch, s: crypto.randomBytes(12).toString('base64url'), ...claims })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', auth.secret()).update(payload).digest('base64url')}`;
}
const claimsOf = (value: string) => JSON.parse(Buffer.from(value.split('.')[0] as string, 'base64url').toString('utf8'));

test('unused for longer than the idle limit: signed out; used within it: the session slides on', () => {
  const t0 = Date.now();
  const fresh = auth.signSession(user);
  assert.equal(auth.checkSession(fresh, t0)?.refresh, null, 'a fresh cookie needs no refresh');
  assert.equal(auth.checkSession(fresh, t0 + 15 * DAY), null, '15 days without use');
  const later = auth.checkSession(fresh, t0 + 13 * DAY);
  assert.ok(later?.refresh, 'used on day 13: a fresher cookie comes back');
  const slid = later.refresh.value;
  assert.equal(claimsOf(slid).s, claimsOf(fresh).s, 'the same session (sign-out still finds it)');
  assert.equal(claimsOf(slid).x, claimsOf(fresh).x, 'the hard end stays where it was');
  assert.ok(auth.checkSession(slid, t0 + 26 * DAY), 'used on day 13, still fine on day 26');
  assert.equal(auth.checkSession(slid, t0 + 31 * DAY), null, 'never past the absolute limit');
});

test('cookies from before idle timeouts (no "last active") run until their end, as they did', () => {
  const legacy = cookie({ x: Date.now() + 30 * DAY });
  assert.ok(auth.checkSession(legacy, Date.now() + 20 * DAY));
  assert.equal(auth.checkSession(legacy, Date.now() + 20 * DAY)?.refresh, null);
});

test('over HTTP: an idle session is refused, a session in use gets its cookie back with a fresh clock', async () => {
  const me = (c: string) => request('GET', '/api/auth/me', { headers: { Cookie: `vr_session=${c}` } });
  assert.equal((await me(cookie({ x: Date.now() + 10 * DAY, a: Date.now() - 15 * DAY }))).status, 401);
  const r = await me(cookie({ x: Date.now() + 10 * DAY, a: Date.now() - 2 * DAY }));
  assert.equal(r.status, 200);
  const set = ([] as string[]).concat(r.headers['set-cookie'] || []).find((h) => h.startsWith('vr_session='));
  assert.ok(set, 'a refreshed session cookie');
  assert.match(set, /HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const value = (set.split(';')[0] as string).slice('vr_session='.length);
  assert.ok(Date.now() - claimsOf(value).a < 60000, 'its clock restarted now');
});
