// Who may ask for access: Client ID Metadata Documents are URLs chosen by strangers, so fetching them is guarded against
// SSRF (public addresses only, pinned, no redirects, small, fast); redirect URIs follow OAuth 2.1 / RFC 8252; dynamic
// registrations are validated. Metadata documents are served over https with a self-signed certificate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { cachedClients, checkRedirectUri, configureCimd, redirectMatches, registerClient, resolveClient, ClientError } = await import(
  '../../lib/oauth/clients.ts'
);
const { isBlockedAddress } = await import('../../lib/netguard.ts');

test('private, loopback, link-local and reserved addresses are never fetched', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('redirect URIs: https, loopback http or an app scheme; never scripts, files, fragments or plain http elsewhere', () => {
  for (const ok of [
    'https://app.example.com/cb',
    'http://127.0.0.1:3000/cb',
    'http://localhost/cb',
    'http://[::1]:8080/cb',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'com.example.app:/cb',
  ])
    assert.equal(checkRedirectUri(ok), ok);
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'http://evil.test/cb',
    'https://app.example.com/cb#frag',
    'https://u:p@app.example.com/cb',
    'not a url',
  ])
    assert.throws(() => checkRedirectUri(bad), ClientError, bad);
  // Exact match, except a loopback port chosen at runtime (RFC 8252 §7.3).
  assert.equal(redirectMatches(['https://app.example.com/cb'], 'https://app.example.com/cb'), true);
  assert.equal(redirectMatches(['https://app.example.com/cb'], 'https://app.example.com/cb/'), false);
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:49152/cb'), true);
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:49152/other'), false);
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://localhost:49152/cb'), false, 'the host may not change');
});

test('dynamic registration validates what a stranger may register', () => {
  const r = registerClient({ client_name: 'CLI\u202e\u0000 Agent', redirect_uris: ['http://127.0.0.1:1234/cb'] });
  assert.equal(r.client_name, 'CLI Agent', 'control and bidi characters are stripped from the shown name');
  assert.equal(r.application_type, 'native');
  assert.equal(r.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in r, false);
  assert.throws(() => registerClient({ redirect_uris: [] }), /redirect_uris/);
  assert.throws(() => registerClient({ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'private_key_jwt' }), /not supported/);
  assert.throws(() => registerClient({ redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] }), /grant_types/);
  assert.throws(() => registerClient({ redirect_uris: ['http://localhost/cb'], application_type: 'web' }), /native/);
});

test('a flood of registrations never pushes out an app someone is connected with', async () => {
  const { knownClientIds } = await import('../../lib/oauth/clients.ts');
  const reg = (name: string, inUse: (id: string) => boolean = () => false) =>
    registerClient({ client_name: name, redirect_uris: ['http://127.0.0.1:1234/cb'] }, { max: 3, inUse }).client_id as string;
  const before = new Set(knownClientIds());
  const live = reg('Connected app');
  const connected = (id: string) => id === live || before.has(id);
  const idle = reg('Idle app', connected);
  for (let i = 0; i < 5; i++) reg(`Flood ${i}`, connected);
  const kept = knownClientIds();
  assert.ok(kept.includes(live), 'the app with a live grant stays');
  assert.ok(!kept.includes(idle), 'idle registrations make room');
  assert.throws(() => reg('One too many', () => true), /too many/, 'full of live apps: refused, nobody evicted');
});

// ---------------------------------------------------------------- metadata documents over https

let server: https.Server | null = null;
let origin = '';
let cert: Buffer | null = null;
const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();

before(async () => {
  const dir = tmpdir('vr-cimd-cert-');
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    return;
  }
  cert = fs.readFileSync(path.join(dir, 'c.pem'));
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => {
    const route = routes.get(req.url || '');
    if (route) route(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  configureCimd({});
  server?.closeAllConnections();
  server?.close();
});

const serve = (p: string, doc: unknown, headers: Record<string, string> = {}) =>
  routes.set(p, (res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(typeof doc === 'string' ? doc : JSON.stringify(doc));
  });
const good = (id: string) => ({ client_id: id, client_name: 'Doc Agent', redirect_uris: ['http://127.0.0.1:7777/cb'] });

test('a metadata document is fetched over https and validated', async (t) => {
  if (!server || !cert) return t.skip('openssl is not available');
  configureCimd({ ca: cert, allowOrigins: [origin] });
  const id = `https://${origin}/ok.json`;
  serve('/ok.json', good(id), { 'cache-control': 'max-age=600' });
  const c = await resolveClient(id);
  assert.equal(c.kind, 'cimd');
  assert.equal(c.name, 'Doc Agent');
  assert.equal(c.host, origin);
  assert.deepEqual(c.redirect_uris, ['http://127.0.0.1:7777/cb']);

  const refuse = async (p: string, doc: unknown, why: RegExp) => {
    const u = `https://${origin}${p}`;
    serve(p, typeof doc === 'function' ? (doc as (u: string) => unknown)(u) : doc);
    await assert.rejects(resolveClient(u), why, p);
  };
  await refuse('/other-id.json', { ...good('https://elsewhere.example/c.json') }, /different client_id/);
  await refuse('/secret.json', (u: string) => ({ ...good(u), client_secret: 'x' }), /secret/);
  await refuse('/confidential.json', (u: string) => ({ ...good(u), token_endpoint_auth_method: 'private_key_jwt' }), /public clients/);
  await refuse('/no-redirects.json', (u: string) => ({ ...good(u), redirect_uris: [] }), /redirect_uris/);
  await refuse('/bad-redirect.json', (u: string) => ({ ...good(u), redirect_uris: ['javascript:alert(1)'] }), /redirect/);
  await refuse('/no-name.json', (u: string) => ({ ...good(u), client_name: '' }), /client_name/);
  await refuse('/not-json.json', 'nope', /not JSON/);
  await refuse('/huge.json', (u: string) => ({ ...good(u), padding: 'x'.repeat(40_000) }), /too large/);
  routes.set('/moved.json', (res) => res.writeHead(302, { location: `https://${origin}/ok.json` }).end());
  await assert.rejects(resolveClient(`https://${origin}/moved.json`), /answered 302/, 'redirects are not followed');
});

test('a document that trickles in is dropped at the deadline, however busy it keeps the connection', async (t) => {
  if (!server || !cert) return t.skip('openssl is not available');
  configureCimd({ ca: cert, allowOrigins: [origin], timeoutMs: 400 });
  routes.set('/drip.json', (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const drip = setInterval(() => res.write(' '), 100);
    res.on('close', () => clearInterval(drip));
  });
  const t0 = Date.now();
  const outcome = await Promise.race([
    resolveClient(`https://${origin}/drip.json`).then(
      () => 'loaded',
      (e: Error) => e.message,
    ),
    new Promise<string>((r) => setTimeout(() => r('still loading after 10 s'), 10_000).unref()),
  ]);
  assert.match(outcome, /in time/);
  // The drip would go on for ever without the 400 ms deadline; seconds, not the deadline itself, so load can't fail it.
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  configureCimd({});
});

test('the metadata cache keeps a bounded number of clients, however many ids strangers try', async () => {
  configureCimd({ resolve: async () => [{ address: '10.0.0.7', family: 4 }] });
  for (let i = 0; i < 600; i++) await assert.rejects(resolveClient(`https://metadata.example/c${i}.json`));
  assert.ok(cachedClients() <= 500, `${cachedClients()} cached`);
  configureCimd({});
});

test('SSRF: a client_id that resolves to a private address is refused, even mixed with a public one', async (t) => {
  if (!server || !cert) return t.skip('openssl is not available');
  // No allowOrigins: the loopback test server itself must be unreachable.
  configureCimd({ ca: cert });
  await assert.rejects(resolveClient(`https://${origin}/ok.json`), /private address/);
  configureCimd({ ca: cert, resolve: async () => [{ address: '10.0.0.7', family: 4 }] });
  await assert.rejects(resolveClient('https://metadata.example/client.json'), /private address/);
  configureCimd({
    ca: cert,
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  await assert.rejects(resolveClient('https://rebind.example/client.json'), /private address/, 'every resolved address must be public');
  configureCimd({});
});

test('client_id URLs: https with a path, normalized, no fragment, credentials or dot segments', async () => {
  for (const id of [
    'https://example.com/',
    'https://example.com',
    'https://u:p@example.com/c.json',
    'https://example.com/a/../c.json',
    'https://EXAMPLE.com/c.json',
  ])
    await assert.rejects(resolveClient(id), ClientError, id);
  await assert.rejects(resolveClient('http://example.com/c.json'), /unknown client_id/, 'plain http is not a metadata document');
});
