// Links that leave the server name their workspace (A12 WS-11): a notification, a chat webhook's message and an
// agent's "open in the player" link open the video in the workspace it belongs to — two teams can hold a video of the
// same name —, as `w=<id>` on the app route once a server has more than one workspace. With one, links are as before.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ReviewEvent } from '../../lib/types.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const scope = await import('../../lib/scope.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const push = await import('../../lib/push/index.ts');
const hooks = await import('../../lib/webhooks.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });

// A browser's push subscription, read back as the browser would (RFC 8291 §3.4).
const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();
function device(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const secret = crypto.randomBytes(16);
  const read = (body: Buffer): { url: string } => {
    const salt = body.subarray(0, 16);
    const idlen = body[20] as number;
    const keyid = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const ecdhSecret = ecdh.computeSecret(keyid);
    const ikm = hmac(hmac(secret, ecdhSecret), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), keyid, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
  };
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: secret.toString('base64url') }, read };
}
const ev = (slug: string): ReviewEvent => ({
  at: new Date().toISOString(),
  type: 'comment',
  by: 'agent:promo-edit',
  video: `/@uploads/Reels/${slug}`,
  slug,
  session: null,
  id: 'c_000001',
  kind: 'question',
  text: 'Which logo?',
});

test('one workspace: links are as they always were', () => {
  assert.equal(scope.routeIn('#/v/spot?c=c_1'), '#/v/spot?c=c_1');
  assert.equal(scope.routeIn('#/inbox'), '#/inbox');
});

let B = '';
test('WS-11: with two workspaces, a route names its workspace', async () => {
  const bo = await auth.createUser({ email: 'bo@example.com', name: 'Bo', password: 'a long password', role: 'reviewer' });
  B = ws.createWorkspace({ name: 'Bravo', ownerId: bo.id }).id;
  assert.equal(
    scope.inWorkspace(B, () => scope.routeIn('#/v/spot?c=c_1')),
    `#/v/spot?c=c_1&w=${B}`,
  );
  assert.equal(
    scope.inWorkspace('w1', () => scope.routeIn('#/folder/Reels')),
    '#/folder/Reels?w=w1',
  );
});

test('WS-11: a notification about B’s video opens it in B; one about #1’s in #1', async () => {
  const phone = device('https://fcm.googleapis.com/fcm/send/deep-links');
  push.subscribe({ endpoint: phone.endpoint, keys: phone.keys, user: null, name: 'Phone' });
  const got: Buffer[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    got.push(Buffer.from(init?.body as Uint8Array));
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const p = push.createPush({ subject: 'mailto:ops@example.com', fetchImpl });
  scope.inWorkspace(B, () => p.handle(ev('spot.mp4')));
  scope.inWorkspace('w1', () => p.handle(ev('other.mp4')));
  p.flush();
  await p.idle();
  const urls = got.map((b) => phone.read(b).url).sort();
  assert.deepEqual(urls, [`#/v/other.mp4?c=c_000001&w=w1`, `#/v/spot.mp4?c=c_000001&w=${B}`].sort());
  push.unsubscribe(phone.endpoint, null);
});

test('WS-11: a chat webhook’s link names the workspace its event is from', async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const w = hooks.createWebhooks({ baseUrl: PUBLIC, fetchImpl, retryDelays: [1], log: () => {} });
  scope.inWorkspace(B, () => w.add({ url: 'https://hooks.example.com/b', events: ['all'] }, 'Bo'));
  scope.inWorkspace(B, () => w.handle(ev('spot.mp4')));
  await w.idle();
  assert.equal(JSON.parse(bodies[0] as string).url, `${PUBLIC}/#/v/spot.mp4?c=c_000001&w=${B}`);
});

test('WS-11: an agent’s “open in the player” link (show_review) names the workspace', async () => {
  const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
  const server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = new Client({ name: 'deep-links', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 1 });
    age(video);
    scope.inWorkspace(B, () => store.createOrGetReview(video, { by: 'setup' }));
    const bo = auth.findUserByEmail('bo@example.com') as import('../../lib/auth.ts').User;
    const { token } = auth.createToken(bo.id, 'agent', { workspace: B });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const card = (await c.callTool({ name: 'show_review', arguments: { video: 'spot.mp4' } })) as { structuredContent?: { playerUrl?: string } };
    assert.match(String(card.structuredContent?.playerUrl), new RegExp(`^${PUBLIC}/#/v/.+\\?f=\\d+&w=${B}$`));
  } finally {
    await c.close().catch(() => {});
    ctx.mail.stop();
    server.closeAllConnections();
    server.close();
  }
});
