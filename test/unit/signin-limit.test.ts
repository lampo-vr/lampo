// Successful sign-ins are limited too (30 an hour per account and per address): every sign-in makes a session, and
// every sign-out one more id the server remembers until that session would have ended. A browser that signed in
// before is not exempt from this one; failed sign-ins keep their own limits (login-throttle.test.ts).
import assert from 'node:assert/strict';
import type http from 'node:http';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
// The test talks from 127.0.0.1 and names the "client" in X-Forwarded-For, like a proxy on the same machine would.
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });
const auth = await import('../../lib/auth.ts');

const { request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC } });
before(async () => {
  await auth.createUser({ email: 'mia@example.com', name: 'Mia', password: 'mias password 1', role: 'member' });
  for (let i = 0; i < 31; i++) await auth.createUser({ email: `p${i}@example.com`, name: `Person ${i}`, password: 'a long password', role: 'member' });
});

const login = (email: string, password: string, ip: string, cookie?: string) =>
  request('POST', '/api/auth/login', { body: { email, password }, headers: { 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) } });
const device = (r: { headers: http.IncomingHttpHeaders }) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_device=')) || '';

test('the 31st sign-in to one account within an hour waits, from any address and browser', async () => {
  const first = await login('mia@example.com', 'mias password 1', '198.51.100.1');
  assert.equal(first.status, 200, first.text);
  const known = device(first);
  for (let i = 2; i <= 30; i++) assert.equal((await login('mia@example.com', 'mias password 1', `198.51.100.${i}`, known)).status, 200, `sign-in ${i}`);
  const more = await login('mia@example.com', 'mias password 1', '198.51.100.31', known);
  assert.equal(more.status, 429, more.text);
  assert.ok(Number(more.headers['retry-after']) > 0);
  // `vr login` makes a token the same way: it counts and waits too.
  const token = await request('POST', '/api/auth/token', {
    body: { email: 'mia@example.com', password: 'mias password 1' },
    headers: { 'X-Forwarded-For': '198.51.100.32' },
  });
  assert.equal(token.status, 429, token.text);
});

test('the 31st sign-in from one address within an hour waits, whichever account', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await login(`p${i}@example.com`, 'a long password', '203.0.113.50')).status, 200, `sign-in ${i + 1}`);
  assert.equal((await login('p30@example.com', 'a long password', '203.0.113.50')).status, 429);
  assert.equal((await login('p30@example.com', 'a long password', '203.0.113.51')).status, 200, 'another address is not held up');
});
