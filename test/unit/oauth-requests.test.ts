// covers: lib/oauth/store.ts server/routes/oauth.ts
// Pending authorization requests are made by anyone signed out (GET /oauth/authorize) and kept 10 minutes: a bare Map
// with a copy of the client's every redirect URI in each (~20 KB), bounded only by 120 a minute per address, filled
// +49 MB by 2,400 requests from 20 IPv6 /64s (A13 AUTH-2). Now they are a `Recent` (listed with `keptInMemory`) of slim
// entries, and one address (an IPv6 /64) may have at most 50 waiting in ten minutes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_TRUST_PROXY: 'loopback' } });
const grants = await import('../../lib/oauth/store.ts');
const { Recent } = await import('../../lib/rateLimit.ts');
const { guestMemory } = await import('../../server/routes/shares/access.ts');
const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });

// one registration (anyone may register) with redirect URIs as long as they may be
const uris = Array.from({ length: 7 }, (_, i) => `https://app.example.org/cb/${i}/${'a'.repeat(1960)}`);
const reg = await request('POST', '/oauth/register', { body: { client_name: 'x', redirect_uris: uris, token_endpoint_auth_method: 'none' } });
assert.equal(reg.status, 201, reg.text);
const clientId = reg.json().client_id as string;
const challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url');
const ask = (from: string, n: number) =>
  request(
    'GET',
    `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: uris[0] as string, code_challenge: challenge, code_challenge_method: 'S256', state: `${n}`.padEnd(1000, 's') })}`,
    { headers: { 'X-Forwarded-For': from } },
  );
const pendingId = (location: unknown) => /^\/\?consent#\/oauth\/(.+)$/.exec(String(location))?.[1] ?? null;

test('one address (an IPv6 /64) has at most 50 authorization requests waiting in ten minutes', async () => {
  const made: string[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await ask(`2001:db8:7:1::${(i + 1).toString(16)}`, i);
    const id = pendingId(r.headers.location);
    assert.ok(id, `request ${i}: ${r.status} ${r.headers.location}`);
    made.push(id);
  }
  const more = await ask('2001:db8:7:1::ffff', 50);
  assert.equal(pendingId(more.headers.location), null, `the 51st from the same /64 waits: ${more.headers.location}`);
  assert.match(String(more.headers.location), /slow_down/);
  assert.ok(pendingId((await ask('2001:db8:8:1::1', 51)).headers.location), 'another /64 still may');
  // a pending request keeps what the consent screen shows, not the client's registration
  const kept = grants.getRequest(made[0] as string) as unknown as { client: Record<string, unknown> };
  assert.equal(kept.client.redirect_uris, undefined, 'no copy of every redirect URI per request');
  assert.equal(kept.client.name, 'x');
});

test('the pending requests are a bounded map, listed with what the app keeps in memory', () => {
  const pending = guestMemory.get(ctx)?.oauthRequests;
  assert.ok(pending instanceof Recent, 'a Recent, listed with keptInMemory');
  const client = { client_id: clientId, kind: 'dcr' as const, name: 'x', host: null, redirect_uris: uris, auth: 'none' as const };
  for (let i = 0; i < 10_050; i++)
    grants.createRequest({
      client,
      redirect_uri: uris[0] as string,
      state: null,
      code_challenge: challenge,
      scopes: ['review:read'],
      resource: `${PUBLIC}/mcp`,
    });
  assert.ok(pending.size <= 10_000, `${pending.size} requests kept`);
});
