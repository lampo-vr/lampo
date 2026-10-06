// A review link's password gate: guessing is throttled per visitor and per address, but strangers with the URL can't
// lock the client out by guessing wrong on purpose, and checking a guess never blocks the server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback', VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const { checkPassword, hashPassword } = await import('../../lib/shares.ts');

const { request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC } });
let token = '';
before(async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const bearer = { Authorization: `Bearer ${auth.createToken(owner.id, 'test').token}` };
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/spot.mp4'), { w: 160, h: 90, dur: 1 }), { filename: 'spot.mp4' }, bearer);
  // review links are a person's to make (server/permissions.ts PERSON_ONLY): signed in, not with the token
  const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' } });
  assert.equal(login.status, 200, login.text);
  const session = { Cookie: String([login.headers['set-cookie']].flat()[0]).split(';')[0] };
  const link = await request('POST', `/api/review/${encodeURIComponent(up.json().slug)}/shares`, { body: { password: 'right one' }, headers: session });
  assert.equal(link.status, 200, link.text);
  token = link.json().token;
});

const unlock = (password: string, ip: string) => request('POST', `/api/g/${token}/unlock`, { body: { password }, headers: { 'X-Forwarded-For': ip } });

test('wrong guesses from several addresses don’t keep the client out', async () => {
  for (let ip = 1; ip <= 6; ip++) for (let i = 0; i < 5; i++) assert.equal((await unlock(`guess ${ip}-${i}`, `192.0.2.${ip}`)).status, 403);
  const client = await unlock('right one', '198.51.100.7');
  assert.equal(client.status, 200, `the client, from their own address: ${client.text}`);
});

test('one visitor gets five tries, then waits', async () => {
  for (let i = 0; i < 5; i++) await unlock(`again ${i}`, '203.0.113.9');
  assert.equal((await unlock('right one', '203.0.113.9')).status, 429, 'that visitor waits, even with the right password');
});

test('checking a guess runs off the event loop', async () => {
  const stored = hashPassword('right one');
  const pending = checkPassword('right one', stored);
  assert.ok(pending instanceof Promise, 'scrypt in the thread pool, not scryptSync');
  assert.equal(await pending, true);
  assert.equal(await checkPassword('wrong', stored), false);
});
