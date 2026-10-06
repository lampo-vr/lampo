// Web Push: encryption against RFC 8291's example, VAPID signatures, which endpoints are accepted, subscriptions and
// preferences, and the notifier (bundling, categories, urgency, cleanup of dead subscriptions, one retry) against a
// mock push service whose requests are decrypted with the "browser's" key.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import type { PushState, ReviewEvent } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const wp = await import('../../lib/push/webpush.ts');
const push = await import('../../lib/push/index.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

// The receiving side, as a browser does it (RFC 8291 §3.4 in reverse).
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const prkKey = hmac(auth, ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const ct = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return plain.subarray(0, end).toString('utf8');
}

test('encryption matches RFC 8291 §5 byte for byte, and decrypts back', () => {
  const expected = Buffer.from(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    'base64url',
  );
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const out = wp.encrypt(Buffer.from('When I grow up, I want to be a watermelon'), keys, {
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    senderPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
  });
  assert.equal(out.toString('base64url'), expected.toString('base64url'));
  const text = decrypt(
    out,
    Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'),
    Buffer.from(keys.p256dh, 'base64url'),
    Buffer.from(keys.auth, 'base64url'),
  );
  assert.equal(text, 'When I grow up, I want to be a watermelon');
  assert.throws(() => wp.encrypt(Buffer.alloc(5000), keys), /too large/);
  assert.throws(() => wp.encrypt(Buffer.from('x'), { p256dh: 'AAAA', auth: keys.auth }), /P-256/);
});

test('VAPID: an ES256 JWT for the push service origin, verifiable with the public key', () => {
  const keys = wp.generateVapidKeys();
  const now = 1_800_000_000;
  const header = wp.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.com', now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: 'mailto:ops@example.com' });
  assert.equal(m[4], keys.publicKey);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
  assert.equal(ok, true);
});

test('only browser push services are accepted as endpoints', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/QGx',
    'https://wns2-db5p.notify.windows.com/w/?token=x',
  ])
    assert.equal(wp.isPushEndpoint(ok), true, ok);
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://127.0.0.1/x',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'not a url',
  ])
    assert.equal(wp.isPushEndpoint(bad), false, bad);
});

// A browser: its own key pair and auth secret.
function browser(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    read: (body: Buffer) => JSON.parse(decrypt(body, ecdh.getPrivateKey(), ecdh.getPublicKey(), auth)),
  };
}

// A push service: records requests, answers with a status per endpoint.
function service(status: (url: string) => number = () => 201) {
  const got: { url: string; headers: Headers; body: Buffer }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    got.push({ url: String(url), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
    return new Response(null, { status: status(String(url)) });
  }) as typeof fetch;
  return { got, fetchImpl };
}

// The stand-in push services' names, as a resolver says them: a public address (never a DNS lookup from a test).
const PUBLIC = async () => [{ address: '142.250.74.10', family: 4 }];

// Every test starts without devices.
const reset = () => {
  for (const [, sub] of push.listSubs()) push.unsubscribe(sub.endpoint, sub.user);
};

let n = 0;
const ev = (e: Partial<ReviewEvent>): ReviewEvent => ({
  at: new Date().toISOString(),
  type: 'comment',
  by: 'agent:promo-edit',
  video: '/work/Acme/spot.mp4',
  slug: 'spot',
  session: null,
  id: `c_${String(++n).padStart(6, '0')}`,
  ...e,
});

test('subscriptions: stored privately, one per endpoint, preferences per device', () => {
  reset();
  const b = browser('https://fcm.googleapis.com/fcm/send/device-1');
  const { id, sub } = push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null, name: 'iPhone' });
  assert.deepEqual(sub.prefs, push.DEFAULT_PREFS);
  assert.equal(push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null }).id, id, 'the same device again');
  assert.equal(fs.statSync(path.join(dir, 'data/push/subscriptions.json')).mode & 0o777, 0o600);
  push.vapidKeys();
  assert.equal(fs.statSync(path.join(dir, 'data/push/vapid.json')).mode & 0o777, 0o600, 'made on first use, kept private');
  assert.equal(push.vapidKeys().publicKey, push.vapidKeys().publicKey, 'and kept');
  assert.equal(push.updatePrefs(b.endpoint, null, { versions: true })?.prefs.versions, true);
  assert.equal(push.updatePrefs(b.endpoint, 'someone-else', { versions: false }), null, 'only its owner changes it');
  assert.throws(() => push.subscribe({ endpoint: 'https://internal.example/hook', keys: b.keys, user: null }), /push service/);
  assert.throws(() => push.subscribe({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AA', auth: 'BB' }, user: null }), /malformed/);
  assert.equal(push.unsubscribe(b.endpoint, null), true);
  assert.equal(push.listSubs().length, 0);
});

test('a render with six fixes is one notification; lone versions only for those who want them', async () => {
  reset();
  const b = browser('https://fcm.googleapis.com/fcm/send/device-2');
  push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null, name: 'Pixel' });
  const svc = service();
  const p = push.createPush({
    subject: 'mailto:ops@example.com',
    fetchImpl: svc.fetchImpl,
    resolve: PUBLIC,
    windows: { release: 40, question: 20, client: 20, answer: 20 },
  });
  for (let i = 0; i < 6; i++)
    p.handle(
      ev({ type: 'status', status: 'fixed', text: `Fix ${i}`, reply: { by: 'agent:promo-edit', text: 'done', status: 'fixed', fixed_in_v: 3, at: '' } }),
    );
  p.handle(ev({ type: 'version', v: 3, id: undefined, by: 'system' }));
  await new Promise((r) => setTimeout(r, 120));
  await p.idle();
  assert.equal(svc.got.length, 1, 'bundled');
  const msg = b.read(svc.got[0].body);
  assert.equal(msg.title, 'spot.mp4 V3 is ready', 'a version is always "V3" for people');
  assert.equal(msg.body, '6 fixes to check', 'fixes are checked, never "verified", in what people read');
  assert.match(msg.url, /^#\/v\/spot\?verify=c_\d+$/);
  const h = svc.got[0].headers;
  assert.match(h.get('authorization') || '', /^vapid t=.+, k=/);
  assert.equal(h.get('content-encoding'), 'aes128gcm');
  assert.ok(Number(h.get('ttl')) > 0);
  assert.match(h.get('topic') || '', /^vr[\w-]{28}$/, 'a newer bundle replaces an undelivered one');

  svc.got.length = 0;
  p.handle(ev({ type: 'version', v: 4, id: undefined, by: 'system' }));
  p.flush();
  await p.idle();
  assert.equal(svc.got.length, 0, 'new versions are off by default');
  push.updatePrefs(b.endpoint, null, { versions: true });
  p.handle(ev({ type: 'version', v: 4, id: undefined, by: 'system' }));
  p.flush();
  await p.idle();
  assert.equal(b.read(svc.got[0].body).title, 'spot.mp4: V4 is in');
  push.unsubscribe(b.endpoint, null);
});

test('questions go out fast and urgent; clients and answers get their own words; the badge count rides along', async () => {
  reset();
  const b = browser('https://fcm.googleapis.com/fcm/send/device-3');
  push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null });
  const svc = service();
  const p = push.createPush({ subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: PUBLIC, count: () => 7 });
  p.handle(ev({ type: 'comment', kind: 'question', text: 'Soll das Logo hier schon stehen?' }));
  p.handle(ev({ type: 'comment', by: 'guest:Mia', text: 'Bitte heller', slug: 'teaser', video: '/work/teaser.mp4' }));
  p.handle(
    ev({
      type: 'reply',
      text: 'Logo größer',
      reply: { by: 'agent:promo-edit', text: 'Ist jetzt 20 % größer', at: '' },
      slug: 'other',
      video: '/work/other.mp4',
    }),
  );
  p.handle(ev({ type: 'comment', by: 'tester', text: 'my own note' }));
  p.flush();
  await p.idle();
  const byTitle = Object.fromEntries(svc.got.map((g) => [b.read(g.body).title, { msg: b.read(g.body), urgency: g.headers.get('urgency') }]));
  assert.deepEqual(
    Object.keys(byTitle).sort(),
    ['Mia on teaser.mp4', 'promo-edit asks about spot.mp4', 'promo-edit replied on other.mp4'],
    'the reviewer’s own note stays quiet',
  );
  assert.equal(byTitle['promo-edit asks about spot.mp4'].urgency, 'high');
  assert.equal(byTitle['promo-edit asks about spot.mp4'].msg.body, '“Soll das Logo hier schon stehen?”');
  assert.equal(byTitle['promo-edit replied on other.mp4'].msg.body, '“Ist jetzt 20 % größer”');
  assert.equal(byTitle['Mia on teaser.mp4'].msg.count, 7);
  push.unsubscribe(b.endpoint, null);
});

test('a client downloading a whole folder is one notification that opens the folder', () => {
  const e = ev({
    type: 'download',
    by: 'guest:Mia',
    video: 'Acme/Reels',
    slug: '',
    folder: 'Acme/Reels',
    text: 'downloaded all 6 videos of Acme/Reels (3.4 GB, originals)',
  });
  assert.equal(push.bucketOf(e), 'client');
  const msg = push.message('client', [e]);
  assert.equal(msg.title, 'Mia on Reels');
  assert.equal(msg.body, 'Mia downloaded all 6 videos of Acme/Reels (3.4 GB, originals)');
  assert.equal(msg.url, '#/folder/Acme%2FReels');
});

test('locally, the owner hears about what others did, not about their own fixes', async () => {
  reset();
  const b = browser('https://fcm.googleapis.com/fcm/send/device-own');
  push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null });
  const svc = service();
  const p = push.createPush({ subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: PUBLIC, eligible: push.notFrom('Sam') });
  const fixed = (by: string, slug: string) =>
    ev({ type: 'status', status: 'fixed', by, slug, video: `/work/${slug}.mp4`, reply: { by, text: '', status: 'fixed', fixed_in_v: 1, at: '' } });
  p.handle(fixed('Sam', 'mine'));
  p.handle(fixed('agent:promo-edit', 'theirs'));
  p.flush();
  await p.idle();
  assert.deepEqual(
    svc.got.map((g) => b.read(g.body).title),
    ['theirs.mp4 V1 is ready'],
  );
  push.unsubscribe(b.endpoint, null);
});

test('dead subscriptions are dropped; a busy push service gets one retry', async () => {
  reset();
  const gone = browser('https://fcm.googleapis.com/fcm/send/gone');
  const busy = browser('https://fcm.googleapis.com/fcm/send/busy');
  push.subscribe({ endpoint: gone.endpoint, keys: gone.keys, user: null });
  push.subscribe({ endpoint: busy.endpoint, keys: busy.keys, user: null });
  const svc = service((url) => (url.endsWith('/gone') ? 410 : 503));
  const logs: string[] = [];
  const p = push.createPush({ subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: PUBLIC, retryDelayMs: 5, log: (m) => logs.push(m) });
  p.handle(ev({ type: 'comment', kind: 'question', text: 'x' }));
  p.flush();
  await p.idle();
  assert.equal(svc.got.filter((g) => g.url.endsWith('/gone')).length, 1);
  assert.equal(svc.got.filter((g) => g.url.endsWith('/busy')).length, 2, 'retried once');
  assert.deepEqual(
    push.listSubs().map(([, s]) => s.endpoint),
    [busy.endpoint],
    '410 means gone for good',
  );
  push.unsubscribe(busy.endpoint, null);
});

test('MEDIA-4: a push service whose name resolves to a private address gets nothing, and is not asked twice', async () => {
  reset();
  const vapid = wp.generateVapidKeys();
  const b = browser('https://x.push.apple.com/3/device/abc');
  for (const answer of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.0.0.7', family: 4 }],
    [{ address: '::ffff:169.254.169.254', family: 6 }],
    [
      { address: '17.253.144.10', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ],
  ]) {
    const svc = service();
    await assert.rejects(
      wp.sendPush(b.endpoint, b.keys, '{}', { vapid, subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: async () => answer }),
      /private address/,
      JSON.stringify(answer),
    );
    assert.equal(svc.got.length, 0, 'nothing sent');
  }
  const svc = service();
  const ok = await wp.sendPush(b.endpoint, b.keys, '{}', { vapid, subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: PUBLIC });
  assert.equal(ok.ok, true);
  assert.equal(svc.got.length, 1, 'a public address is sent to');
  // The notifier: refused once, said once, not retried, and the device stays (a name can resolve elsewhere tomorrow).
  push.subscribe({ endpoint: b.endpoint, keys: b.keys, user: null });
  const logs: string[] = [];
  const quiet = service();
  const p = push.createPush({
    subject: 'mailto:ops@example.com',
    fetchImpl: quiet.fetchImpl,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    retryDelayMs: 5,
    log: (m) => logs.push(m),
  });
  p.handle(ev({ type: 'comment', kind: 'question', text: 'x' }));
  p.flush();
  await p.idle();
  assert.equal(quiet.got.length, 0);
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0] as string, /private address/);
  assert.equal(push.listSubs().length, 1);
  push.unsubscribe(b.endpoint, null);
});

test('MEDIA-4: a push goes to the address that was checked (never resolved again), over TLS', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const tls = path.join(dir, 'tls');
  fs.mkdirSync(tls, { recursive: true });
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tls, 'k.pem'), '-out', path.join(tls, 'c.pem'), '-days', '1'].concat([
        '-subj',
        '/CN=push.example.test',
        '-addext',
        'subjectAltName=DNS:push.example.test',
      ]),
      { stdio: 'ignore' },
    );
  } catch {
    return t.skip('openssl is not available');
  }
  const cert = fs.readFileSync(path.join(tls, 'c.pem'));
  const got: { url: string; host: string; body: Buffer }[] = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(tls, 'k.pem')), cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      got.push({ url: req.url || '', host: String(req.headers.host), body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    const b = browser(`https://push.example.test:${port}/wpush/v2/abc`);
    let asked = 0;
    // The name exists only in this resolver: a request that resolved it again would fail.
    const resolve = async () => {
      asked++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const vapid = wp.generateVapidKeys();
    const out = { vapid, subject: 'mailto:ops@example.com', resolve, ca: cert };
    await assert.rejects(wp.sendPush(b.endpoint, b.keys, '{"title":"x"}', out), /private address/);
    assert.equal(got.length, 0);
    const res = await wp.sendPush(b.endpoint, b.keys, '{"title":"x"}', { ...out, blocked: () => false });
    assert.deepEqual(res, { status: 201, ok: true, gone: false });
    assert.equal(asked, 2, 'resolved once per push');
    assert.equal(got.length, 1);
    assert.equal(got[0]?.url, '/wpush/v2/abc');
    assert.equal(got[0]?.host, `push.example.test:${port}`);
    assert.equal(b.read(got[0]?.body as Buffer).title, 'x');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---------------------------------------------------------------- the API

const ctx = createContext({ cfg: loadConfig(), token: 't', loadSessions: async () => [] });
const svc = service();
ctx.push = push.createPush({ subject: 'mailto:ops@example.com', fetchImpl: svc.fetchImpl, resolve: PUBLIC });
const { port } = await startApp({ ctx });
const api = (method: string, url: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

test('API: key, subscribe, preferences, a test notification, unsubscribe', async () => {
  reset();
  const b = browser('https://fcm.googleapis.com/fcm/send/device-api');
  const first = (await (await api('GET', `/api/push?endpoint=${encodeURIComponent(b.endpoint)}`)).json()) as PushState;
  assert.equal(Buffer.from(first.publicKey, 'base64url').length, 65);
  assert.equal(first.subscription, null);
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://10.0.0.5/x', keys: b.keys } })).status, 400);
  const sub = (await (
    await api('POST', '/api/push/subscribe', { subscription: { endpoint: b.endpoint, keys: b.keys }, name: 'iPhone', prefs: { answers: false } })
  ).json()) as PushState;
  assert.equal(sub.subscription?.name, 'iPhone');
  assert.equal(sub.subscription?.prefs.answers, false);
  assert.equal(sub.devices, 1);
  const prefs = (await (await api('PATCH', '/api/push/prefs', { endpoint: b.endpoint, prefs: { versions: true } })).json()) as PushState;
  assert.equal(prefs.subscription?.prefs.versions, true);
  assert.equal((await api('POST', '/api/push/test', { endpoint: b.endpoint })).status, 200);
  assert.equal(b.read(svc.got.at(-1)?.body as Buffer).title, 'Notifications are on');
  assert.equal(((await (await api('POST', '/api/push/unsubscribe', { endpoint: b.endpoint })).json()) as PushState).devices, 0);
  assert.equal((await api('POST', '/api/push/test', { endpoint: b.endpoint })).status, 404);
});
