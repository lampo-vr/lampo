// Who may follow the live event stream on a hosted instance. Every account sees the whole instance by design (clients
// get review links, not accounts), so the lines to hold are: no stream without an account, none through a review link,
// and an app's OAuth token (bound to /mcp, capped by its scopes) opens nothing else.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const shares = await import('../../lib/shares.ts');
const oauth = await import('../../lib/oauth/store.ts');

const { port } = await startApp();
let reviewerToken = '';
let appToken = '';
let linkToken = '';
before(async () => {
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  reviewerToken = auth.createToken(rita.id, 'rita').token;
  linkToken = shares.createShare({ folder: 'Acme' }, { label: 'Acme room', by: 'Olivia' }).token;
  // An app Rita connected with read access only (what the consent screen would have granted).
  const verifier = crypto.randomBytes(32).toString('base64url');
  const redirect_uri = 'http://127.0.0.1:9/cb';
  const client = { client_id: 'vrc_test', kind: 'dcr' as const, name: 'Test app', host: null, redirect_uris: [redirect_uri], auth: 'none' as const };
  const code = oauth.createCode(
    {
      id: 'req',
      client,
      redirect_uri,
      state: null,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['review:read'],
      resource: `${PUBLIC}/mcp`,
      expires: Date.now() + 60000,
    },
    rita,
  );
  appToken = oauth.redeemCode({ code, client_id: client.client_id, redirect_uri, code_verifier: verifier, resource: `${PUBLIC}/mcp` }).access_token;
});

// The status of an event stream request (a 200 stream is closed as soon as it answers).
function streamStatus(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Host: 'review.test', Accept: 'text/event-stream', ...headers } }, (res) => {
      resolve(res.statusCode || 0);
      req.destroy();
    });
    req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
  });
}

test('no account, no stream: signed out, through a review link, or with an app token meant for /mcp', async () => {
  assert.equal(await streamStatus('/api/events'), 401);
  assert.equal(await streamStatus(`/api/events?token=${linkToken}`), 401, 'a link token in the URL is not an account');
  assert.equal(await streamStatus('/api/events', { Cookie: `vr_g_x=1; vr_session=${linkToken}` }), 401);
  assert.notEqual(await streamStatus(`/api/g/${linkToken}/events`), 200, 'review links have no event stream');
  assert.equal(await streamStatus('/api/events', { Authorization: `Bearer ${appToken}` }), 401, 'OAuth tokens open /mcp only');
  assert.equal(await streamStatus('/api/events', { Authorization: `Bearer ${linkToken}` }), 401);
});

// (What an app token may do inside /mcp — its scopes ∩ the account's role — is test/unit/oauth.test.ts's.)
test('an account (any role) follows the stream; a review link is no MCP credential', async () => {
  assert.equal(await streamStatus('/api/events', { Authorization: `Bearer ${reviewerToken}` }), 200);
  const mcp = (token: string, body: object) =>
    new Promise<number>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/mcp',
          headers: {
            Host: 'review.test',
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
          },
        },
        (res) => {
          resolve(res.statusCode || 0);
          res.resume();
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  assert.equal(await mcp(linkToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), 401, 'a review link is no MCP credential');
});
