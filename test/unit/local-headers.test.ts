// Local mode sends the same protective headers as a hosted server: any web page the owner visits could otherwise
// frame http://127.0.0.1:4747 and drive clicks on share, delete and approve (clickjacking), and review pages opened
// through the tunnel would run without a content policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { staticUi } = await import('../../server/app.ts');
const { THEME_BOOT_HASH } = await import('../../server/guard.ts');

const dist = tmpdir('vr-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>shell</title>');
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'assets', 'instrument-sans-latin-standard-normal-abc123.woff2'), 'wOF2');
fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'export {}');

const { request } = await startApp({ token: 'test-token', loadSessions: async () => [], ui: staticUi(dist) });
// A billing module's payment sources are for the hosted app only: on the person's own machine they never widen the policy.
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { NO_EXTENSION } = await import('../../server/extension.ts');
const moduleCtx = createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] });
moduleCtx.extension = {
  ...NO_EXTENSION,
  name: 'billing',
  billing: true,
  contentSecurity: { script: ['https://js.stripe.com'], frame: ['https://hooks.stripe.com'] },
};
const withModule = await startApp({ ctx: moduleCtx, ui: staticUi(dist) });

test('the owner UI and the API can’t be framed, sniffed or run foreign scripts', async () => {
  for (const url of ['/', '/api/info', '/api/library']) {
    const r = await request('GET', url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers['x-frame-options'], 'DENY', url);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /frame-ancestors 'none'/, url);
    assert.match(csp, /object-src 'none'/, url);
    assert.ok(csp.includes(`script-src 'self' ${THEME_BOOT_HASH}`), `only our scripts and the theme boot: ${url}`);
    assert.equal(r.headers['referrer-policy'], 'same-origin', url);
  }
});

// The health checks, robots.txt and the 404 for a path spelled another way answer before the guard: they carry the same
// headers all the same, so no answer of the app can be framed or sniffed (A12 WEB-9).
test('answers given before the guard carry the same protective headers', async () => {
  for (const url of ['/healthz', '/readyz', '/robots.txt', '/api//info', '/api/info/']) {
    const r = await request('GET', url);
    assert.equal(r.headers['x-frame-options'], 'DENY', url);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/, url);
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow', url);
  }
});

test('review pages (reachable through the tunnel) get the policy too, and never leak their token in a Referer', async () => {
  const r = await request('GET', '/g/abcdef');
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
});

test('on the person’s own machine a billing module’s payment sources never reach the policy', async () => {
  for (const url of ['/', '/api/info']) {
    const csp = String((await withModule.request('GET', url)).headers['content-security-policy']);
    assert.ok(csp.includes(`script-src 'self' ${THEME_BOOT_HASH};`), url);
    assert.ok(!csp.includes('stripe') && !csp.includes('frame-src'), url);
  }
});

// Stripe's payment frames (js.stripe.com) draw their fields in the app's own Instrument Sans: they fetch the font across
// origins, so a .woff2 may be read by anyone (it's public anyway); nothing else of the app is.
test('the app’s font files may be fetched by other origins (Stripe’s frames); its scripts and pages may not', async () => {
  const font = await request('GET', '/assets/instrument-sans-latin-standard-normal-abc123.woff2', { headers: { Origin: 'https://js.stripe.com' } });
  assert.equal(font.status, 200);
  assert.equal(font.headers['access-control-allow-origin'], '*');
  const script = await request('GET', '/assets/index-abc123.js', { headers: { Origin: 'https://js.stripe.com' } });
  assert.equal(script.headers['access-control-allow-origin'], undefined);
  const page = await request('GET', '/', { headers: { Origin: 'https://js.stripe.com' } });
  assert.equal(page.headers['access-control-allow-origin'], undefined);
});
