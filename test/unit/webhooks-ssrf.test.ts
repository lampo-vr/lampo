// On a hosted server, webhooks go to public addresses only: an admin (or a stolen admin session) must not be able to
// use the server to reach its own network, the cloud's metadata service or localhost, nor probe which internal
// addresses answer through the Test button. The address is checked when the hook is saved and again, pinned, when
// it is delivered (a name can start pointing inward later). Self-hosters with an internal chat server opt in.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const hooks = await import('../../lib/webhooks.ts');
const { loadConfig } = await import('../../lib/config.ts');
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
type ReviewEvent = import('../../lib/types.ts').ReviewEvent;

// A receiver on loopback: the "internal service" an attacker would like to reach.
const hits: http.IncomingHttpHeaders[] = [];
const rx = http.createServer((req, res) => {
  hits.push(req.headers);
  req.resume();
  req.on('end', () => res.writeHead(200).end());
});
let port = 0;
before(async () => {
  await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r));
  port = (rx.address() as AddressInfo).port;
});
after(() => rx.close());

async function app(extra: object = {}): Promise<{ request: Request; close: () => void }> {
  const { port: appPort, close } = await startApp({ cfg: { ...loadConfig(), ...extra } });
  const owner =
    auth.findUserByEmail('olivia@example.com') ??
    (await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' }));
  // Webhooks are set up by a person in the app (an API token makes none: server/permissions.ts PERSON_ONLY).
  const bearer = { Cookie: `vr_session=${auth.signSession(owner)}`, Origin: PUBLIC };
  return { request: client(appPort, { Host: 'review.test', ...bearer }), close };
}

test('Settings refuse webhook URLs that point at private addresses', async () => {
  const { request, close } = await app();
  try {
    for (const url of [
      `http://127.0.0.1:${port}/hook`,
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:9/x',
      `http://localhost:${port}/x`,
      'http://10.1.2.3/x',
    ]) {
      const r = await request('POST', '/api/admin/webhooks', { body: { url } });
      assert.equal(r.status, 400, `${url}: ${r.text}`);
      assert.match(r.json().error, /private/, url);
    }
    assert.equal(hits.length, 0, 'nothing was sent');
  } finally {
    close();
  }
});

test('an instance that opts in (an internal chat server) may use private addresses', async () => {
  const { request, close } = await app({ webhooks_allow_private: true });
  try {
    const r = await request('POST', '/api/admin/webhooks', { body: { url: `http://127.0.0.1:${port}/hook` } });
    assert.equal(r.status, 200, r.text);
    await request('DELETE', `/api/admin/webhooks/${r.json().id}`);
  } finally {
    close();
  }
});

test('delivery checks the address again and connects to exactly the address it checked', async () => {
  // rebind.test "resolves" to loopback now: refused without sending anything.
  const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
  const url = `http://rebind.test:${port}/hook`;
  const quiet = { baseUrl: PUBLIC, retryDelays: [1], log: () => {} };
  const guarded = hooks.createWebhooks({ config: [{ url }], guard: { resolve }, ...quiet });
  const refused = await guarded.test('cfg_0');
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /private/);
  assert.equal(refused.attempts, 1, 'no retries for an address that is not allowed');
  assert.equal(hits.length, 0);
  // With loopback allowed (test only), the request goes to the checked address; the name itself never resolves.
  const pinned = hooks.createWebhooks({ config: [{ url }], guard: { resolve, blocked: (ip) => ip !== '127.0.0.1' }, ...quiet });
  assert.equal((await pinned.test('cfg_0')).ok, true);
  assert.equal(hits.at(-1)?.host, `rebind.test:${port}`);
});

// Last: a second workspace makes work outside one an error for the rest of the file.
test('WS-9: the opt-in is the operator’s own team’s (workspace #1): another workspace stays on public addresses', async () => {
  const ws = await import('../../lib/workspaces.ts');
  const app = await startApp({ cfg: { ...loadConfig(), webhooks_allow_private: true }, headers: { Host: 'review.test' } });
  const { ctx, request } = app;
  try {
    const owner = auth.findUserByEmail('olivia@example.com') as User;
    const bea = await auth.createUser({ email: 'bea@example.com', name: 'Bea', password: 'a long password', role: 'reviewer' });
    const B = ws.createWorkspace({ name: 'Other team', ownerId: bea.id }).id;
    const as = (user: User, w: string) => ({ Cookie: `vr_session=${auth.signSession(user, 1, w)}`, Origin: PUBLIC });
    const url = `http://127.0.0.1:${port}/hook`;
    const inB = await request('POST', '/api/admin/webhooks', { body: { url }, headers: as(bea, B) });
    assert.equal(inB.status, 400, inB.text);
    assert.match(inB.json().error, /private/);
    const inA = await request('POST', '/api/admin/webhooks', { body: { url, events: ['all'] }, headers: as(owner, 'w1') });
    assert.equal(inA.status, 200, inA.text);
    // A hook B kept from before (or written into its file by hand) is checked when it is sent: Test and events alike.
    const kept = ws.inWorkspace(B, () => ctx.webhooks.add({ url, events: ['all'] }, 'Bea'));
    const before = hits.length;
    const tested = await request('POST', `/api/admin/webhooks/${kept.id}/test`, { headers: as(bea, B) });
    assert.equal(tested.status, 200, tested.text);
    assert.equal(tested.json().ok, false);
    assert.match(tested.json().error ?? '', /private/);
    const event = (slug: string): ReviewEvent => ({
      at: new Date().toISOString(),
      type: 'comment',
      by: 'guest:Client',
      video: slug,
      slug,
      session: null,
      text: 'hi',
    });
    ws.inWorkspace(B, () => ctx.webhooks.handle(event('b-video')));
    await ctx.webhooks.idle();
    assert.equal(hits.length, before, 'nothing reached the private address from B');
    ws.inWorkspace('w1', () => ctx.webhooks.handle(event('a-video')));
    await ctx.webhooks.idle();
    assert.equal(hits.length, before + 1, 'workspace #1’s hook is sent');
  } finally {
    ctx.mail.stop();
    await app.close();
  }
});
