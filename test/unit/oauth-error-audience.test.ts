// What an OAuth caller (an app, signed in to nobody) is told when the server itself fails under the OAuth endpoints:
// RFC 6749's `server_error` with a sentence and a ref, never an errno, a path on the server or a quote of a damaged
// file — the store unreadable at registration, at the token endpoint (its client lookup too) and at revocation. What the
// caller got wrong still says so in its own words. Real HTTP through the hosted app; the store is obstructed on purpose.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });
const { request } = await startApp({ headers: { Connection: 'close', Host: 'review.test', Origin: PUBLIC } });
const OAUTH = path.join(dir, 'data', 'oauth');

// every call from an address of its own: the endpoints' rate limits stay out of the way
let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const register = (body: Record<string, unknown> = {}) =>
  request('POST', '/oauth/register', {
    body: { redirect_uris: ['https://client.example/callback'], client_name: 'Synthetic app', token_endpoint_auth_method: 'none', ...body },
    headers: somewhere(),
  });
const token = (client_id: string) =>
  request('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: 'x', client_id }, headers: somewhere() });
const revoke = (client_id: string) => request('POST', '/oauth/revoke', { body: { token: 'x', client_id }, headers: somewhere() });

/** A server fault as an OAuth caller must get it, and nothing of the server's insides. */
function serverError(r: { status: number; text: string; json: () => { error?: string; error_description?: string } }, what: string) {
  assert.equal(r.status, 500, `${what}: ${r.text}`);
  assert.equal(r.json().error, 'server_error', what);
  assert.match(r.json().error_description ?? '', /^something went wrong on the server \(ref [0-9a-f]{8}\)$/, what);
  assert.ok(!r.text.includes(dir), `${what}: no path on the server`);
  assert.doesNotMatch(r.text, /\b(ENOTDIR|EISDIR|EACCES|ENOENT|EPERM)\b|JSON|SYNTHETIC/, `${what}: no errno, no quote of the file`);
}

let clientId = '';
test('a working store: registration is 201, and what a caller gets wrong says so', async () => {
  const r = await register();
  assert.equal(r.status, 201, r.text);
  clientId = r.json().client_id;
  const bad = await register({ redirect_uris: ['not a url'] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error, 'invalid_redirect_uri');
  assert.match(bad.json().error_description, /redirect URI is not an absolute URL/);
  const unknown = await token('c_unknown');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json().error, 'invalid_client');
  assert.match(unknown.json().error_description, /unknown client_id/);
});

test('a grants file that can’t be parsed: registration, token and revocation answer server_error', async () => {
  fs.writeFileSync(path.join(OAUTH, 'grants.json'), '{"grants":[{"id":"g_x","access":[{"hash":"SYNTHETIC0123456789"}] oops');
  try {
    serverError(await register(), 'register');
    serverError(await token(clientId), 'token');
    serverError(await revoke(clientId), 'revoke');
  } finally {
    fs.rmSync(path.join(OAUTH, 'grants.json'));
  }
});

test('the clients file unreadable: the token endpoint’s client lookup is the server’s fault, not invalid_client', async () => {
  fs.renameSync(path.join(OAUTH, 'clients.json'), path.join(OAUTH, 'clients.json.kept'));
  fs.mkdirSync(path.join(OAUTH, 'clients.json'));
  try {
    serverError(await token(clientId), 'token');
    serverError(await revoke(clientId), 'revoke');
  } finally {
    fs.rmdirSync(path.join(OAUTH, 'clients.json'));
    fs.renameSync(path.join(OAUTH, 'clients.json.kept'), path.join(OAUTH, 'clients.json'));
  }
});

test('the OAuth folder a file (ENOTDIR): registration answers server_error', async () => {
  const kept = `${OAUTH}.kept`;
  fs.renameSync(OAUTH, kept);
  fs.writeFileSync(OAUTH, 'an obstruction');
  try {
    serverError(await register(), 'register');
  } finally {
    fs.rmSync(OAUTH);
    fs.renameSync(kept, OAUTH);
  }
  assert.equal((await register()).status, 201, 'and works again once the store is back');
});
