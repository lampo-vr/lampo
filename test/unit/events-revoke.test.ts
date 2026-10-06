// A live event stream (/api/events) carries every note as it is written. Signing out, revoking a token or disabling
// the account ends the streams it opened (on the next keep-alive), not only the requests that come after.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const { ctx, request, port } = await startApp({ headers: { Connection: 'close' } });
before(async () => {
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
  ctx.hub.startPing(100);
});
after(() => ctx.hub.closeAll());

/** Opens /api/events; resolves `ended` when the server closes the stream. */
function stream(headers: Record<string, string>): Promise<{ ended: Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      resolve({ ended: new Promise((r) => res.on('end', () => r())), close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}
const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);

test('signing out ends the session’s open stream; another session’s stays', async () => {
  const login = async () =>
    cookieFrom(await request('POST', '/api/auth/login', { body: { email: 'max@example.com', password: 'maxs password 1' }, headers: { Origin: PUBLIC } }));
  const [a, b] = [await login(), await login()];
  const sa = await stream({ Cookie: a });
  const sb = await stream({ Cookie: b });
  assert.equal((await request('POST', '/api/auth/logout', { headers: { Cookie: a, Origin: PUBLIC } })).status, 200);
  assert.equal(await within(sa.ended, 1500), true, 'the signed-out session’s stream ended');
  assert.equal(await within(sb.ended, 400), false, 'the other session keeps its stream');
  sb.close();
});

test('revoking a token, or disabling the account, ends its streams', async () => {
  const max = auth.listUsers().find((u) => u.name === 'Max');
  assert.ok(max);
  const { token, info } = auth.createToken(max.id, 'watch');
  const s = await stream({ Authorization: `Bearer ${token}` });
  auth.revokeToken(info.id);
  assert.equal(await within(s.ended, 1500), true, 'the revoked token’s stream ended');

  const again = auth.createToken(max.id, 'watch again');
  const s2 = await stream({ Authorization: `Bearer ${again.token}` });
  await auth.updateUser(max.id, { disabled: true });
  assert.equal(await within(s2.ended, 1500), true, 'the disabled account’s stream ended');
});
