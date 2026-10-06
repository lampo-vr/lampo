// OAuth sign-in for MCP clients of a hosted server (MCP authorization 2026-07-28), driven by the real SDK client's
// auth(): discovery from the 401 metadata, Dynamic Client Registration and Client ID Metadata Documents (served over
// https with a self-signed certificate), the consent screen's API, PKCE, refresh rotation, revocation, audience binding,
// and scopes capped by the account's role. The server runs in server mode on a random port.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  Client,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  auth as sdkAuth,
} from '@modelcontextprotocol/client';
import type { OAuthRequestView } from '../../lib/types.ts';
import { productionTimeouts, startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { COOKIE } = await import('../../server/auth.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { configureCimd } = await import('../../lib/oauth/clients.ts');
const { verifyAccess } = await import('../../lib/oauth/store.ts');

const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'setup' });

let server: http.Server;
let base = '';
let owner = '';
let reviewer = '';
let admin = '';
let member = '';
const clients: Client[] = [];

// The public URL is only known once the port is: the handler is swapped in after listen.
before(async () => {
  let app: http.RequestListener = (_req, res) => res.end();
  server = productionTimeouts(http.createServer((req, res) => app(req, res)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx = createContext({ cfg: loadConfig({ ...process.env, VR_PUBLIC_URL: base }), token: 'unused' });
  app = createApp(ctx) as unknown as http.RequestListener;
  const cookieOf = async (email: string, name: string, role: 'owner' | 'admin' | 'reviewer' | 'member') =>
    `${COOKIE}=${auth.signSession(await auth.createUser({ email, name, password: 'a long password', role }))}`;
  owner = await cookieOf('olivia@example.com', 'Olivia', 'owner');
  reviewer = await cookieOf('rita@example.com', 'Rita', 'reviewer');
  member = await cookieOf('max@example.com', 'Max', 'member');
  admin = await cookieOf('ada@example.com', 'Ada', 'admin');
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server.closeAllConnections();
  server.close();
});

class MemoryProvider implements OAuthClientProvider {
  info: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = '';
  lastUrl: URL | null = null;
  redirectUrl: string;
  clientMetadataUrl?: string;
  constructor(redirectUrl: string, clientMetadataUrl?: string) {
    this.redirectUrl = redirectUrl;
    if (clientMetadataUrl) this.clientMetadataUrl = clientMetadataUrl;
  }
  get clientMetadata() {
    return {
      client_name: 'Test Agent',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'state-123';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: StoredOAuthClientInformation) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: StoredOAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.lastUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The browser half: the authorize redirect, the consent screen's request, and the decision. */
async function consent(authorizeUrl: URL, cookie: string, allow = true) {
  const first = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } });
  assert.equal(first.status, 302, await first.text());
  const loc = first.headers.get('location') || '';
  const id = /^\/\?consent#\/oauth\/([A-Za-z0-9_-]+)$/.exec(loc)?.[1];
  assert.ok(id, `consent screen route, got ${loc}`);
  const view = await fetch(`${base}/api/oauth/requests/${id}`, { headers: { cookie } });
  assert.equal(view.status, 200, await view.clone().text());
  const decided = await fetch(`${base}/api/oauth/requests/${id}`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ allow }),
  });
  assert.equal(decided.status, 200, await decided.clone().text());
  return { view: (await view.json()) as OAuthRequestView, redirect: new URL(((await decided.json()) as { redirect: string }).redirect), id };
}

async function signInWithSdk(provider: MemoryProvider, cookie: string, scope?: string) {
  const serverUrl = `${base}/mcp`;
  assert.equal(await sdkAuth(provider, { serverUrl, ...(scope ? { scope } : {}) }), 'REDIRECT');
  const { view, redirect } = await consent(provider.lastUrl as URL, cookie);
  assert.equal(redirect.searchParams.get('state'), 'state-123');
  assert.equal(redirect.searchParams.get('iss'), base, 'RFC 9207 issuer in the response');
  const code = redirect.searchParams.get('code') as string;
  assert.equal(await sdkAuth(provider, { serverUrl, authorizationCode: code, iss: base }), 'AUTHORIZED');
  return { view, code };
}

async function connect(provider: OAuthClientProvider): Promise<Client> {
  const c = new Client({ name: 'oauth-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  clients.push(c);
  return c;
}

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

const b64url = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};
const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});
async function register(body: object) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, string> };
}
const authorizeUrl = (q: Record<string, string>) => new URL(`${base}/oauth/authorize?${new URLSearchParams(q)}`);
const REDIRECT = 'http://127.0.0.1:65000/callback';

/** A registered public client that went through consent: its code, verifier and client_id. */
async function manualCode(cookie: string, extra: Record<string, string> = {}) {
  const { json } = await register({ client_name: 'Manual', redirect_uris: [REDIRECT] });
  const { verifier, challenge } = pkce();
  const { redirect } = await consent(
    authorizeUrl({
      response_type: 'code',
      client_id: json.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      resource: `${base}/mcp`,
      ...extra,
    }),
    cookie,
  );
  return { code: redirect.searchParams.get('code') as string, verifier, client_id: json.client_id };
}
async function exchange(o: { code: string; verifier: string; client_id: string }) {
  const r = await fetch(
    `${base}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code: o.code,
      code_verifier: o.verifier,
      client_id: o.client_id,
      redirect_uri: REDIRECT,
      resource: `${base}/mcp`,
    }),
  );
  return { status: r.status, json: (await r.json()) as Record<string, string> };
}
async function mcpList(token: string) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

test('discovery: protected resource metadata (both well-known paths) and authorization server metadata', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const m = (await r.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    assert.equal(m.resource, `${base}/mcp`);
    assert.deepEqual(m.authorization_servers, [base]);
    assert.deepEqual(m.scopes_supported, ['review:read', 'review:comment', 'review:act', 'post:draft']);
  }
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.issuer, base);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`, { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`, { method: 'POST' })).status, 404, 'metadata is read-only');
});

test('SDK client with dynamic registration: 401 → metadata → register → consent → tokens → MCP tools', async () => {
  const p = new MemoryProvider(REDIRECT);
  const { view } = await signInWithSdk(p, owner);
  assert.equal(view.client_name, 'Test Agent');
  assert.equal(view.verified, false, 'a self-registered name is not vouched for');
  assert.equal(view.local_redirect, true);
  assert.deepEqual(view.scopes, ['review:read', 'review:comment', 'review:act', 'post:draft']);
  assert.deepEqual(view.capped, []);
  assert.match(p.saved?.access_token || '', /^vro_/);
  assert.match(p.saved?.refresh_token || '', /^vrr_/);
  const c = await connect(p);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('get_open_notes') && names.includes('mark_fixed'));
  const added = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 3, text: 'Frage per OAuth' } })) as Result;
  assert.ok(!added.isError, textOf(added));
  assert.match(textOf(added), /by agent:oauth-test/, 'an app with review:act writes as the agent it is');
  // The token is for /mcp only: the rest of the API does not take it.
  assert.equal((await fetch(`${base}/api/library`, { headers: { authorization: `Bearer ${p.saved?.access_token}` } })).status, 401);
  // Connected apps list it, and disconnecting stops it at once.
  const { apps } = (await (await fetch(`${base}/api/auth/apps`, { headers: { cookie: owner } })).json()) as {
    apps: { id: string; client_name: string; scopes: string[] }[];
  };
  const mine = apps.find((a) => a.client_name === 'Test Agent');
  assert.ok(mine && mine.scopes.length === 4);
  assert.equal((await fetch(`${base}/api/admin/apps`, { headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/apps`, { headers: { cookie: reviewer } })).status, 403);
  // An admin manages everyone's connected apps but an owner's (like the owner themselves).
  const seen = (await (await fetch(`${base}/api/admin/apps`, { headers: { cookie: admin } })).json()) as { apps: { id: string }[] };
  assert.ok(!seen.apps.some((a) => a.id === mine?.id), 'an owner’s app is not listed to admins');
  assert.equal((await fetch(`${base}/api/admin/apps/${mine?.id}`, { method: 'DELETE', headers: { cookie: admin, origin: base } })).status, 403);
  assert.equal((await fetch(`${base}/api/auth/apps/${mine?.id}`, { method: 'DELETE', headers: { cookie: owner, origin: base } })).status, 200);
  assert.equal((await mcpList(p.saved?.access_token as string)).status, 401, 'revoked in settings');
});

test('SDK client with a Client ID Metadata Document served over https', async (t) => {
  const certDir = tmpdir('vr-cimd-');
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
        path.join(certDir, 'k.pem'),
        '-out',
        path.join(certDir, 'c.pem'),
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
    t.skip('openssl is not available');
    return;
  }
  const cert = fs.readFileSync(path.join(certDir, 'c.pem'));
  let doc: object = {};
  const meta = https.createServer({ key: fs.readFileSync(path.join(certDir, 'k.pem')), cert }, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(doc));
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
  const origin = `127.0.0.1:${(meta.address() as AddressInfo).port}`;
  const clientId = `https://${origin}/oauth/client.json`;
  doc = { client_id: clientId, client_name: 'Metadata Agent', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
  try {
    configureCimd({ ca: cert, allowOrigins: [origin] });
    const p = new MemoryProvider(REDIRECT, clientId);
    const { view } = await signInWithSdk(p, owner);
    assert.equal(p.lastUrl?.searchParams.get('client_id'), clientId, 'no registration: the URL is the client_id');
    assert.equal(view.client_name, 'Metadata Agent');
    assert.equal(view.client_host, origin);
    assert.equal(view.verified, true, 'the name comes from a document on that host');
    const c = await connect(p);
    const listed = (await c.callTool({ name: 'list_videos', arguments: {} })) as Result;
    assert.ok(!listed.isError, textOf(listed));
  } finally {
    configureCimd({});
    meta.closeAllConnections();
    meta.close();
  }
});

test('consent: deny sends access_denied with state and iss; the request is used up; API tokens cannot consent', async () => {
  const { json } = await register({ client_name: 'Denied', redirect_uris: [REDIRECT] });
  const { challenge } = pkce();
  const url = authorizeUrl({
    response_type: 'code',
    client_id: json.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const { redirect, id } = await consent(url, owner, false);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  assert.equal(redirect.searchParams.get('iss'), base);
  assert.equal(redirect.searchParams.get('code'), null);
  const again = await fetch(`${base}/api/oauth/requests/${id}`, {
    method: 'POST',
    headers: { cookie: owner, origin: base, 'content-type': 'application/json' },
    body: '{"allow":true}',
  });
  assert.equal(again.status, 404, 'one decision per request');
  // A request can't be approved with an API token, or from a foreign page with the cookie.
  const u2 = await fetch(url, { redirect: 'manual' });
  const id2 = /#\/oauth\/(.+)$/.exec(u2.headers.get('location') || '')?.[1];
  const api = auth.createToken(auth.findUserByEmail('olivia@example.com')?.id as string, 'api').token;
  assert.equal((await fetch(`${base}/api/oauth/requests/${id2}`, { headers: { authorization: `Bearer ${api}` } })).status, 403);
  const foreign = await fetch(`${base}/api/oauth/requests/${id2}`, {
    method: 'POST',
    headers: { cookie: owner, origin: 'https://evil.test', 'content-type': 'application/json' },
    body: '{"allow":true}',
  });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${base}/api/oauth/requests/${id2}`)).status, 401, 'signed out: the app shows sign-in first');
});

// An app may run the sign-in in a popup and hear the answer through window.opener. Cross-Origin-Opener-Policy:
// same-origin on the consent page would cut the popup from its opener for good, and the connection would hang after
// Allow (A12 WEB-10). The consent page is the one document that lets an opener keep its popup; every other answer
// keeps same-origin.
test('the consent page keeps a popup’s opener; every other page cuts it', async () => {
  const { json } = await register({ client_name: 'Popup', redirect_uris: [REDIRECT] });
  const { challenge } = pkce();
  const first = await fetch(
    authorizeUrl({ response_type: 'code', client_id: json.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
    { redirect: 'manual', headers: { cookie: owner } },
  );
  // browsers apply the policy at every hop of a navigation: the redirect that leads to the page as well
  assert.equal(first.headers.get('cross-origin-opener-policy'), 'unsafe-none', 'the authorize hop');
  const loc = first.headers.get('location') || '';
  assert.match(loc, /^\/\?consent#\/oauth\/[A-Za-z0-9_-]+$/, 'the consent page, marked for its own policy');
  const page = await fetch(`${base}${loc.split('#')[0]}`, { headers: { cookie: owner } });
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'unsafe-none', 'the opener keeps its popup');
  for (const p of ['/', '/?other', '/api/auth/status', '/oauth/token', '/api/oauth/requests/x'])
    assert.equal((await fetch(`${base}${p}`, { redirect: 'manual' })).headers.get('cross-origin-opener-policy'), 'same-origin', p);
});

test('authorization request checks: every problem before the person decides is shown on our own page, never sent to the app', async () => {
  const { json } = await register({ client_name: 'Checks', redirect_uris: [REDIRECT] });
  const go = async (q: Record<string, string>) => (await fetch(authorizeUrl(q), { redirect: 'manual' })).headers.get('location') || '';
  const { challenge } = pkce();
  const ok = { response_type: 'code', client_id: json.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'q' };
  // The error page is told a code and nothing else: no description, no address, no state.
  const shown = async (q: Record<string, string>) => {
    const loc = await go(q);
    const m = /^\/#\/oauth\/error\?error=([a-z_]+)$/.exec(loc);
    assert.ok(m, `the app's own error page with a code only, got ${loc}`);
    return m[1];
  };
  assert.equal(await shown({ ...ok, client_id: 'vrc_nope' }), 'invalid_client');
  assert.equal(await shown({ ...ok, redirect_uri: 'https://evil.test/cb' }), 'invalid_request', 'never sent to an unregistered address');
  assert.equal(await shown({ ...ok, code_challenge_method: 'plain' }), 'invalid_request');
  const { code_challenge: _c, ...noPkce } = ok;
  assert.equal(await shown(noPkce), 'invalid_request');
  assert.equal(await shown({ ...ok, response_type: 'token' }), 'unsupported_response_type');
  assert.equal(await shown({ ...ok, resource: 'https://other.example/mcp' }), 'invalid_target');
  assert.equal(await shown({ ...ok, scope: 'admin everything' }), 'invalid_scope');
  // A native app may pick its loopback port at runtime (RFC 8252); only the port may differ.
  assert.match(await go({ ...ok, redirect_uri: 'http://127.0.0.1:51234/callback' }), /^\/\?consent#\/oauth\/[A-Za-z0-9_-]+$/);
  assert.equal(await shown({ ...ok, redirect_uri: 'http://127.0.0.1:51234/other' }), 'invalid_request');
});

test('A12 WEB-3: an openly registered https address is never a redirect target before the person decides', async () => {
  // Anyone may register a client with an address of their choosing; the authorize URL must not become a link to it.
  const landing = 'https://evil.example/landing';
  const { status, json } = await register({ client_name: 'Claude', redirect_uris: [landing], token_endpoint_auth_method: 'none' });
  assert.equal(status, 201, JSON.stringify(json));
  const { challenge } = pkce();
  const good = { response_type: 'code', client_id: json.client_id, redirect_uri: landing, code_challenge: challenge, code_challenge_method: 'S256' };
  const bad: Record<string, string>[] = [
    { client_id: json.client_id, redirect_uri: landing },
    { ...good, response_type: 'token' },
    { ...good, code_challenge_method: 'plain' },
    { ...good, resource: 'https://elsewhere.example/mcp' },
    { ...good, scope: 'nothing-real' },
    { ...good, state: 'Your workspace was suspended. Pay at evil.example' },
  ];
  for (const q of bad.slice(0, 5)) {
    const r = await fetch(authorizeUrl(q), { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    assert.equal(r.status, 302);
    assert.match(loc, /^\/#\/oauth\/error\?error=[a-z_]+$/, `shown on our own page: ${JSON.stringify(q)} → ${loc}`);
    assert.ok(!loc.includes('evil'), 'the registered address is never in it');
  }
  // A valid request goes to the consent screen (where the person sees the address); only their decision sends them there.
  const consentLoc = (await fetch(authorizeUrl(bad[5]), { redirect: 'manual' })).headers.get('location') || '';
  assert.match(consentLoc, /^\/\?consent#\/oauth\/[A-Za-z0-9_-]{16,64}$/);
  const denied = await consent(authorizeUrl(bad[5]), owner, false);
  assert.equal(denied.view.verified, false, 'shown as a self-named app');
  assert.equal(denied.redirect.origin, 'https://evil.example', 'after the person decided, the answer goes to the address the screen showed');
  assert.equal(denied.redirect.searchParams.get('error'), 'access_denied');
});

test('token endpoint: PKCE, redirect_uri and client must match; a code works once and its reuse revokes what it made', async () => {
  const bad = await manualCode(owner);
  const wrong = await exchange({ ...bad, verifier: pkce().verifier });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal((await exchange(bad)).json.error, 'invalid_grant', 'a failed redemption uses the code up');

  const good = await manualCode(owner);
  const first = await exchange(good);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.token_type, 'Bearer');
  assert.equal((await mcpList(first.json.access_token)).status, 200);
  const replay = await exchange(good);
  assert.equal(replay.json.error, 'invalid_grant');
  assert.equal((await mcpList(first.json.access_token)).status, 401, 'tokens from a reused code are revoked');

  const other = await manualCode(owner);
  const r = await fetch(
    `${base}/oauth/token`,
    form({
      grant_type: 'authorization_code',
      code: other.code,
      code_verifier: other.verifier,
      client_id: other.client_id,
      redirect_uri: 'http://127.0.0.1:65000/elsewhere',
    }),
  );
  assert.equal(((await r.json()) as { error: string }).error, 'invalid_grant');
  assert.equal(
    ((await (await fetch(`${base}/oauth/token`, form({ grant_type: 'password', client_id: other.client_id }))).json()) as { error: string }).error,
    'unsupported_grant_type',
  );
});

test('refresh tokens rotate; replaying an old one revokes the connection; revoke ends it', async () => {
  const refresh = (rt: string, client_id: string) => fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: rt, client_id }));
  const own = await manualCode(owner);
  const t1 = (await exchange(own)).json;
  const stranger = (await register({ client_name: 'Stranger', redirect_uris: [REDIRECT] })).json.client_id;
  assert.equal(((await (await refresh(t1.refresh_token, stranger)).json()) as { error: string }).error, 'invalid_grant', 'another client cannot use it');
  const r2 = await refresh(t1.refresh_token, own.client_id);
  assert.equal(r2.status, 200);
  const t2 = (await r2.json()) as Record<string, string>;
  assert.notEqual(t2.refresh_token, t1.refresh_token, 'rotated');
  assert.equal((await mcpList(t2.access_token)).status, 200);
  const replay = await refresh(t1.refresh_token, own.client_id);
  assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');
  assert.equal((await mcpList(t2.access_token)).status, 401, 'a replayed refresh token revokes the whole connection');

  const own2 = await manualCode(owner);
  const t3 = (await exchange(own2)).json;
  assert.equal((await fetch(`${base}/oauth/revoke`, form({ token: t3.refresh_token, client_id: own2.client_id }))).status, 200);
  assert.equal((await mcpList(t3.access_token)).status, 401);
  assert.equal((await fetch(`${base}/oauth/revoke`, form({ token: 'vrr_unknown', client_id: own2.client_id }))).status, 200, 'unknown tokens are no error');
});

test('a refresh that asks for less scope gets an access token with exactly that scope', async () => {
  const own = await manualCode(owner);
  const t1 = (await exchange(own)).json;
  const r = await fetch(
    `${base}/oauth/token`,
    form({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: own.client_id, scope: 'review:read' }),
  );
  const t2 = (await r.json()) as Record<string, string>;
  assert.equal(t2.scope, 'review:read');
  assert.deepEqual(verifyAccess(t2.access_token, `${base}/mcp`)?.scopes, ['review:read'], 'what the token says is what it may do');
});

test('audience: a token is only valid for the resource it was issued for', async () => {
  const t = (await exchange(await manualCode(owner))).json;
  assert.ok(verifyAccess(t.access_token, `${base}/mcp`));
  assert.equal(verifyAccess(t.access_token, 'https://other.example/mcp'), null);
  assert.equal(verifyAccess(`${t.access_token}x`, `${base}/mcp`), null);
});

test('scopes are capped by the role: a reviewer with review:act still cannot mark fixed; a read-only app gets a scope challenge', async () => {
  const p = new MemoryProvider(REDIRECT);
  const { view } = await signInWithSdk(p, reviewer, 'review:read review:comment review:act');
  assert.deepEqual(view.capped, ['review:act'], 'the consent screen says the role limits it');
  const c = await connect(p);
  const note = (await c.callTool({ name: 'add_note', arguments: { video: 'spot.mp4', frame: 2, text: 'Rita per App' } })) as Result;
  assert.ok(!note.isError, textOf(note));
  assert.match(textOf(note), /by Rita/, 'a reviewer writes as themselves, never as an agent');
  const id = /(c_[0-9a-f]{6})/.exec(textOf(note))?.[1];
  const fixed = (await c.callTool({ name: 'mark_fixed', arguments: { id, note: 'x' } })) as Result;
  assert.ok(fixed.isError && /may not/.test(textOf(fixed)), textOf(fixed));

  const read = (await exchange(await manualCode(member, { scope: 'review:read' }))).json;
  assert.equal(read.scope, 'review:read');
  const call = (headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${read.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'add_note', arguments: { video: 'spot.mp4', frame: 1, text: 'x' } },
      }),
    });
  const variants: Record<string, string>[] = [{}, { 'mcp-method': 'tools/call', 'mcp-name': 'add_note' }];
  for (const headers of variants) {
    const r = await call(headers);
    assert.equal(r.status, 403);
    const h = r.headers.get('www-authenticate') || '';
    assert.match(h, /error="insufficient_scope"/);
    assert.match(h, /scope="review:comment"/);
    assert.match(h, /resource_metadata="/);
  }
});

test('dynamic registration: bad redirect URIs refused; confidential clients must authenticate', async () => {
  assert.equal((await register({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] })).json.error, 'invalid_redirect_uri');
  assert.equal((await register({ client_name: 'x', redirect_uris: ['http://evil.test/cb'] })).json.error, 'invalid_redirect_uri');
  assert.equal((await register({ client_name: 'x', redirect_uris: [REDIRECT], application_type: 'web' })).json.error, 'invalid_redirect_uri');
  const conf = await register({
    client_name: 'Confidential',
    redirect_uris: ['https://app.example.com/cb'],
    token_endpoint_auth_method: 'client_secret_basic',
  });
  assert.equal(conf.status, 201);
  assert.match(conf.json.client_secret, /^vrs_/);
  const { verifier, challenge } = pkce();
  const { redirect } = await consent(
    authorizeUrl({
      response_type: 'code',
      client_id: conf.json.client_id,
      redirect_uri: 'https://app.example.com/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
    owner,
  );
  const code = redirect.searchParams.get('code') as string;
  const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://app.example.com/cb' };
  const noSecret = await fetch(`${base}/oauth/token`, form({ ...body, client_id: conf.json.client_id }));
  assert.equal(noSecret.status, 401, 'a confidential client must authenticate');
  assert.equal(((await noSecret.json()) as { error: string }).error, 'invalid_client');
  const basic = Buffer.from(`${conf.json.client_id}:${conf.json.client_secret}`).toString('base64');
  const r = await fetch(`${base}/oauth/token`, {
    ...form(body),
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
  });
  assert.equal(r.status, 200, 'client authentication failed before the code was looked at, so it still works');
  assert.match(((await r.json()) as { access_token: string }).access_token, /^vro_/);
});

// The registration body is checked by a schema like every other input (A12 INV-9): a list given as one string (an
// implicit-flow `response_types: "token"`) was let through as "not a list, so not asked for". RFC 7591's error codes
// stay; metadata this server doesn't know is ignored, as the RFC asks.
test('dynamic registration: the body is checked by its schema, lists are lists, unknown metadata is ignored', async () => {
  const bad = async (extra: object) => (await register({ client_name: 'x', redirect_uris: [REDIRECT], ...extra })).json.error;
  assert.equal(await bad({ response_types: 'token' }), 'invalid_client_metadata', 'response_types as one string');
  assert.equal(await bad({ grant_types: 'implicit' }), 'invalid_client_metadata', 'grant_types as one string');
  assert.equal(await bad({ token_endpoint_auth_method: ['none'] }), 'invalid_client_metadata', 'a list where one value belongs');
  assert.equal(await bad({ client_uri: 42 }), 'invalid_client_metadata');
  assert.equal((await register({ client_name: 'x', redirect_uris: 'http://127.0.0.1:65000/callback' })).json.error, 'invalid_redirect_uri');
  const ok = await register({ client_name: 'Fine', redirect_uris: [REDIRECT], logo_uri: 'https://app.example/logo.png', contacts: ['a@b.c'] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
});

test('browser clients may call token, register and revoke from their own origin (CORS, no cookies)', async () => {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://inspector.example' },
    body: JSON.stringify({ client_name: 'Inspector', redirect_uris: ['https://inspector.example/cb'] }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${base}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://inspector.example' } })).status, 204);
});

test("on a person's own machine: the machine itself needs no sign-in, another device signs in through OAuth", async () => {
  const { base: url, close } = await startApp({ cfg: { ...loadConfig(), mode: 'local', public_url: null } });
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const mcp = (headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(list),
    });
  try {
    assert.equal((await mcp()).status, 200, 'an agent on the machine connects as its owner');
    const remote = await mcp({ 'x-forwarded-for': '203.0.113.9' });
    assert.equal(remote.status, 401, 'anything through a proxy or the tunnel is another device');
    assert.match(remote.headers.get('www-authenticate') || '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal((await fetch(`${url}/.well-known/oauth-authorization-server`)).status, 200, 'OAuth is advertised for other devices');
  } finally {
    await close();
  }
});
