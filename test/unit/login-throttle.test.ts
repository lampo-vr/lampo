// Guessing passwords is throttled without handing strangers a way to lock someone out: failures count per address,
// per account and address, and per account across all addresses — but the last one never stops a browser that has
// signed in to that account before (a device cookie), and one address's failures never stop another's sign-in.
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
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
});

const login = (email: string, password: string, ip: string, cookie?: string) =>
  request('POST', '/api/auth/login', { body: { email, password }, headers: { 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) } });
const cookies = (r: { headers: http.IncomingHttpHeaders }) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');

test('one address guessing locks only that address out of the account; the real person elsewhere signs in', async () => {
  let last = 0;
  for (let i = 0; i < 9; i++) last = (await login('mia@example.com', `nope ${i} nope`, '203.0.113.5')).status;
  assert.equal(last, 429, 'the guessing address is stopped');
  assert.equal((await login('mia@example.com', 'mias password 1', '203.0.113.5')).status, 429, 'even with the right password, from there');
  const elsewhere = await login('mia@example.com', 'mias password 1', '198.51.100.7');
  assert.equal(elsewhere.status, 200, `the real person from another address: ${elsewhere.text}`);
});

test('guessing from many addresses stops new browsers, never one that signed in to the account before', async () => {
  const known = cookies(await login('max@example.com', 'maxs password 1', '198.51.100.20'));
  assert.match(known, /vr_device=/, 'a signed-in browser is remembered for this account');
  // Spread over many addresses, each below its own limit.
  let n = 0;
  for (let ip = 1; n < 40; ip++) for (let i = 0; i < 5 && n < 40; i++, n++) await login('max@example.com', `guess ${n}`, `192.0.2.${ip}`);
  assert.equal((await login('max@example.com', 'maxs password 1', '198.51.100.99')).status, 429, 'a new browser waits');
  const again = await login('max@example.com', 'maxs password 1', '198.51.100.21', known);
  assert.equal(again.status, 200, `the person's own browser still signs in: ${again.text}`);
});

test('AUTH-5: a known browser’s cookie copied to many addresses gets few guesses, and exempts nothing without it', async () => {
  await auth.createUser({ email: 'kim@example.com', name: 'Kim', password: 'kims password 1', role: 'member' });
  const deviceOf = (r: { headers: http.IncomingHttpHeaders }) =>
    cookies(r)
      .split('; ')
      .find((c) => c.startsWith('vr_device=')) as string;
  const laptop = deviceOf(await login('kim@example.com', 'kims password 1', '198.51.100.40'));
  const phone = deviceOf(await login('kim@example.com', 'kims password 1', '198.51.100.41'));
  // A copy of the laptop's cookie guessing from a new address each time: its own budget, wherever it comes from.
  const copied: number[] = [];
  for (let i = 0; i < 12; i++) copied.push((await login('kim@example.com', `guess ${i} guess`, `198.18.0.${i + 1}`, laptop)).status);
  assert.deepEqual(copied, [...Array(10).fill(401), 429, 429]);
  // Without a known browser's cookie the account's own limit counts every address (the copy's tries too).
  let n = 0;
  for (let ip = 1; n < 20; ip++) for (let i = 0; i < 4 && n < 20; i++, n++) await login('kim@example.com', `other ${n}`, `198.18.1.${ip}`);
  assert.equal((await login('kim@example.com', 'kims password 1', '198.51.100.42')).status, 429, 'a new browser waits');
  // Kim's other browser still signs in: nobody locks her out.
  const own = await login('kim@example.com', 'kims password 1', '198.51.100.43', phone);
  assert.equal(own.status, 200, own.text);
});

test('one address trying many accounts is stopped', async () => {
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await login(`nobody${i}@example.com`, 'whatever pass', '203.0.113.77')).status;
  assert.equal(last, 429);
});
