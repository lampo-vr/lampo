// Forwarding headers (the client's address, https) are believed only from the proxy's own address, never from
// whoever connects: a client reaching the app directly could otherwise name its own address and slip past every
// per-address limit (sign-in, invites, link passwords, OAuth, MCP).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test', VR_TRUST_PROXY: 'true' } });
const { loadConfig, trustProxy } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

test('addresses, subnets and named ranges; never "anyone"', () => {
  assert.deepEqual(trustProxy('loopback'), { value: 'loopback', legacy: false });
  assert.deepEqual(trustProxy('10.0.0.5, 172.18.0.0/16,fd00::/8'), { value: '10.0.0.5, 172.18.0.0/16, fd00::/8', legacy: false });
  assert.deepEqual(trustProxy('false'), { value: false, legacy: false });
  assert.deepEqual(trustProxy(false), { value: false, legacy: false });
  assert.throws(() => trustProxy('everyone'), /VR_TRUST_PROXY/);
  assert.throws(() => trustProxy('10.0.0.0/33'), /VR_TRUST_PROXY/);
});

test('the old forms (true, a hop count) mean a proxy on this machine or a private network, with a warning', () => {
  for (const old of ['true', '1', '2', true, 1] as const) assert.deepEqual(trustProxy(old), { value: 'loopback, uniquelocal', legacy: true }, String(old));
  const cfg = loadConfig();
  assert.equal(cfg.trust_proxy, 'loopback, uniquelocal');
  assert.equal(cfg.trust_proxy_legacy, true);
});

test('the app believes forwarding headers from the proxy only, not from a client on the internet', () => {
  const app = createApp(createContext({ cfg: loadConfig(), token: 'unused' }));
  const trusts = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
  assert.equal(trusts('127.0.0.1', 0), true, 'Caddy on this machine');
  assert.equal(trusts('172.18.0.2', 0), true, 'Caddy in the compose network');
  assert.equal(trusts('203.0.113.9', 0), false, 'a client talking to the app directly');
});
