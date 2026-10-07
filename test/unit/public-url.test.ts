// A hosted server needs to know its own URL: without it any Host header is served (DNS rebinding), the OAuth issuer
// comes from the request, and cookies may not be marked Secure behind a TLS proxy. It refuses to start without one,
// unless a local test says so explicitly; /readyz tells either way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server' } });
const { loadConfig, startupProblems } = await import('../../lib/config.ts');

test('server mode without VR_PUBLIC_URL is refused, unless explicitly allowed for a local test', () => {
  const cfg = loadConfig({ VR_MODE: 'server' });
  const [why] = startupProblems(cfg, {});
  assert.match(why ?? '', /LAMPO_PUBLIC_URL/);
  assert.match(why ?? '', /LAMPO_ALLOW_NO_PUBLIC_URL/, 'says how to run a local test anyway');
  assert.deepEqual(startupProblems(cfg, { VR_ALLOW_NO_PUBLIC_URL: '1' }), []);
  assert.deepEqual(startupProblems(loadConfig({ VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'loopback' }), {}), []);
  assert.deepEqual(startupProblems(loadConfig({}), {}), [], 'local mode has no public URL');
});

test('/readyz reports a missing public URL (not ready), and a set one', async () => {
  for (const [url, ready] of [
    [null, false],
    ['https://review.example.com', true],
  ] as const) {
    const cfg = { ...loadConfig({ VR_MODE: 'server' }), public_url: url };
    const app = await startApp({ cfg, headers: { Host: url ? 'review.example.com' : '127.0.0.1' } });
    try {
      const r = await app.request('GET', '/readyz');
      assert.equal(r.json().checks.public_url, ready, String(url));
      if (!ready) assert.equal(r.status, 503);
    } finally {
      await app.close();
    }
  }
});
