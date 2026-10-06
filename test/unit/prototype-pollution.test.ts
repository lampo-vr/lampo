// JSON bodies with "__proto__" or "constructor.prototype" keys (JSON.parse makes them plain own keys, a careless merge
// turns them into prototype writes). Every write route parses bodies with zod objects, which keep declared keys only;
// this keeps it that way for the routes that store or merge what they are sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const { DATA } = await import('../../lib/paths.ts');
const { COOKIE } = await import('../../server/auth.ts');

const { request } = await startApp({ headers: { Host: 'review.test' } });
let token = '';
let cookie = '';
before(async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  token = auth.createToken(owner.id, 'test').token;
  cookie = `${COOKIE}=${auth.signSession(owner)}`;
});

// Written as text: an object literal with __proto__ would set the prototype instead of sending the key.
const poison = (fields: string) =>
  `{${fields}, "__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}, "prototype": {"polluted": "yes"}}`;
const send = (method: string, url: string, body: string) =>
  request(method, url, { body, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
// Tokens are made signed in, in the app (an API token doesn't mint tokens).
const signedIn = (method: string, url: string, body: string) =>
  request(method, url, { body, headers: { Cookie: cookie, Origin: 'http://review.test', 'content-type': 'application/json' } });

test('poisoned bodies reach no prototype and nothing of them is stored', async () => {
  const replies = [
    await send('PATCH', '/api/auth/me', poison('"name": "Olivia", "prefs": {"theme": "dark"}')),
    await send('PATCH', '/api/auth/me', `{"prefs": {"theme": "dark", "__proto__": {"polluted": "yes"}}}`),
    await send('POST', '/api/folders', poison('"path": "Acme"')),
    await signedIn('POST', '/api/folder-shares', poison('"folder": "Acme", "label": "Acme room"')),
    await signedIn('POST', '/api/auth/tokens', poison('"name": "ci"')),
    await request('POST', '/oauth/register', {
      body: poison('"redirect_uris": ["http://127.0.0.1:9/cb"], "client_name": "x", "token_endpoint_auth_method": "none"'),
    }),
  ];
  // The writes themselves go through (the poison is dropped, not the request); prefs are strict and refuse extra keys.
  assert.deepEqual(
    replies.map((r) => r.status),
    [200, 400, 200, 200, 200, 201],
    replies.map((r) => r.text).join('\n'),
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype untouched');
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  for (const f of fs.readdirSync(DATA).filter((n) => n.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(DATA, f), 'utf8');
    assert.doesNotMatch(text, /polluted|__proto__/, `${f} keeps none of it`);
  }
});
