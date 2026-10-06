// API tokens can be made to expire (`days`, `vr login --expires 90d`); an expired token is refused like a revoked one.
// Tokens without an expiry (all tokens from before, and the default) keep working until they are revoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const { tokenDays } = await import('../../lib/cliAccount.ts');

const { request } = await startApp({ headers: { Host: 'review.test' } });
before(async () => {
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
});

const whoami = async (token: string) => (await request('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status;

// Moves a token's expiry into the past, as time would.
function expire(id: string) {
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8'));
  const t = f.tokens.find((x: { id: string }) => x.id === id);
  t.expires = '2020-01-01T00:00:00+00:00';
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(f));
}

test('`vr login` with days: the token says when it expires, works until then, and is refused after', async () => {
  const r = await request('POST', '/api/auth/token', { body: { email: 'olivia@example.com', password: 'a long password', name: 'ci', days: 30 } });
  assert.equal(r.status, 200, r.text);
  const { token, info } = r.json() as { token: string; info: { id: string; expires?: string } };
  assert.ok(info.expires, 'the answer says when');
  const inDays = (Date.parse(info.expires) - Date.now()) / 86400000;
  assert.ok(inDays > 29.9 && inDays <= 30, `about 30 days: ${inDays}`);
  assert.equal(await whoami(token), 200);
  expire(info.id);
  assert.equal(await whoami(token), 401, 'an expired token works nowhere');
  assert.equal(auth.verifyToken(token), null);
});

test('without days a token works until revoked, as before; out-of-range days are refused', async () => {
  const { token, info } = auth.createToken((auth.listUsers()[0] as { id: string }).id, 'forever');
  assert.equal(info.expires, undefined);
  assert.ok(auth.verifyToken(token));
  assert.throws(() => auth.createToken(info.user, 'x', { days: 0 }), /1 to 3650 days/);
  const bad = await request('POST', '/api/auth/token', { body: { email: 'olivia@example.com', password: 'a long password', days: 9999 } });
  assert.equal(bad.status, 400);
});

test('vr login --expires takes days', () => {
  assert.equal(tokenDays(undefined), null);
  assert.equal(tokenDays('90d'), 90);
  assert.equal(tokenDays('7'), 7);
  assert.throws(() => tokenDays('2w'), /takes days/);
  assert.throws(() => tokenDays('0d'), /takes days/);
});
