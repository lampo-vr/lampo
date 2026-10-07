// A live event stream (/api/events) carries every note as it is written: when access ends in this process (a member
// removed from the workspace, a token revoked) its streams end at once, not at the next keep-alive. No keep-alive runs
// here at all.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');

const { ctx, port } = await startApp({ headers: { Connection: 'close' } });
after(() => ctx.hub.closeAll());

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: 'a long password', role: 'reviewer' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: owner.id }).id;
ws.addMember(B, bob.id, 'member');

/** Opens /api/events; resolves `ended` when the server closes the stream. */
function stream(headers: Record<string, string>): Promise<{ ended: Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: 'review.test', ...headers } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      resolve({ ended: new Promise((r) => res.on('end', () => r())), close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}
const within = (p: Promise<void>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);

test('removed from the workspace: the member’s stream there ends at once; another member’s stays', async () => {
  const bobs = await stream({ Authorization: `Bearer ${auth.createToken(bob.id, 'watch', { workspace: B }).token}` });
  const olivias = await stream({ Authorization: `Bearer ${auth.createToken(owner.id, 'watch', { workspace: B }).token}` });
  ws.removeMember(B, bob.id);
  assert.equal(await within(bobs.ended, 1000), true, 'Bob’s stream ended');
  assert.equal(await within(olivias.ended, 300), false, 'Olivia keeps hers');
  olivias.close();
});

test('a revoked token’s stream ends at once', async () => {
  const { token, info } = auth.createToken(owner.id, 'watch again', { workspace: B });
  const s = await stream({ Authorization: `Bearer ${token}` });
  auth.revokeToken(info.id);
  assert.equal(await within(s.ended, 1000), true);
});
