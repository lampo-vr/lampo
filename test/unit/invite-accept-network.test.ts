// Taking an invite counts against the caller's network like a failed sign-in, and an IPv6 network is one caller: its
// /64 holds more addresses than any limit could count one by one (addressKey). Tries from one /64, each from a new
// address, run out as tries from one IPv4 address do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback', VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { request } = await startApp({ headers: { Host: 'review.test', Origin: PUBLIC, Connection: 'close' } });

const nadia = await auth.createUser({ email: 'nadia@example.com', name: 'Nadia', password: 'a long password', role: 'reviewer' });
const team = ws.createWorkspace({ name: 'Nadia Films', ownerId: nadia.id });
const asNadia = { headers: { Cookie: `vr_session=${auth.signSession(nadia, 30, team.id)}` } };
async function invite(): Promise<string> {
  const r = await request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, ...asNadia });
  assert.equal(r.status, 200, r.text);
  return String(r.json().url).split('#/invite/')[1] as string;
}
const accept = (token: string, i: number, from: string) =>
  request('POST', '/api/auth/invite/accept', {
    body: { token, name: `Guest ${i}`, email: `guest${i}@example.org`, password: 'a long password' },
    headers: { 'X-Forwarded-For': from },
  });

test('invite tries from one IPv6 /64, a new address each time, run out like one address’s', async () => {
  const seen: number[] = [];
  let token = await invite();
  for (let i = 0; i < 24 && !seen.includes(429); i++) {
    if (i && i % 15 === 0) token = await invite(); // an invite holds a few claims at once
    seen.push((await accept(token, i, `2001:db8:1:2::${(i + 1).toString(16)}`)).status);
  }
  assert.ok(seen.includes(429), `never refused: ${seen}`);
  // another network is not held back by it
  const other = await accept(await invite(), 99, '2001:db8:9:9::1');
  assert.notEqual(other.status, 429, other.text);
});
