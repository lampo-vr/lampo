// The source offer (AGPL-3.0 §13): people who use an instance over the network can find its source. The URL comes
// from source_url / VR_SOURCE_URL, else package.json's repository; /api/info carries it to the UI, and a hosted
// instance without one says so at start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const { loadConfig, repositoryUrl } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');

test('repository fields become web URLs', () => {
  assert.equal(repositoryUrl({}), null);
  assert.equal(repositoryUrl({ repository: 'https://example.org/team/tool' }), 'https://example.org/team/tool');
  assert.equal(repositoryUrl({ repository: { url: 'git+https://example.org/team/tool.git' } }), 'https://example.org/team/tool');
  assert.equal(repositoryUrl({ repository: 'git@example.org:team/tool.git' }), 'https://example.org/team/tool');
  assert.equal(repositoryUrl({ repository: 'github:team/tool' }), null, 'shorthands are not links');
});

test('with nothing set, the source is the project’s own repository (audit A12, OSS-13)', async () => {
  const env = { ...process.env };
  delete env.VR_SOURCE_URL;
  const cfg = loadConfig(env);
  assert.match(cfg.source_url ?? '', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, `${cfg.source_url}`);
  assert.deepEqual(await startupWarnings(cfg.source_url), [], 'nothing to warn about with the default');
});

test('VR_SOURCE_URL beats config.json and the package default', () => {
  assert.equal(loadConfig({ ...process.env, VR_SOURCE_URL: 'https://example.org/fork' }).source_url, 'https://example.org/fork');
});

async function info(cfg: ReturnType<typeof loadConfig>) {
  const { request } = await startApp({ cfg });
  return (await request('GET', '/api/info')).json();
}

test('/api/info offers the source, even before anyone signs in', async () => {
  const body = await info(loadConfig({ ...process.env, VR_SOURCE_URL: 'https://example.org/fork' }));
  assert.equal(body.source_url, 'https://example.org/fork');
});

/** What logStartup() warns about, for a hosted instance with this source URL. */
async function startupWarnings(source_url: string | null): Promise<string[]> {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warned.push(m);
  try {
    await createContext({ cfg: { ...loadConfig(), source_url }, token: 'unused' }).readiness.logStartup();
  } finally {
    console.warn = warn;
  }
  return warned;
}

test('a hosted instance without a source URL warns at start', async () => {
  const warned = await startupWarnings(null);
  assert.ok(
    warned.some((w) => /VR_SOURCE_URL.*AGPL/.test(w)),
    warned.join('\n'),
  );
  assert.deepEqual(await startupWarnings('https://example.org/fork'), []);
});
