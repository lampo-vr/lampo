// A browser suite whose browser is missing must fail, not print "skipped" and exit 0: otherwise a fresh clone or a CI
// image without Chrome/WebKit reports green without testing. Skipping is opt-in (VR_E2E_SKIP_OK=1). The WebKit suite
// with an empty browser folder stands in for any missing prerequisite (it stops before starting anything).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, tmpdir } from '../lib/helpers.ts';

const suite = (env: Record<string, string>) =>
  spawnSync(process.execPath, [path.join(ROOT, 'test/e2e/webkit.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: tmpdir('vr-no-webkit-'), VR_E2E_SKIP_OK: '', ...env },
    timeout: 60_000,
  });

test('a missing browser fails the suite and says how to skip on purpose', () => {
  const r = suite({});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /webkit e2e can't run: WebKit is not downloaded yet/);
  assert.match(r.stderr, /VR_E2E_SKIP_OK=1/);
});

test('VR_E2E_SKIP_OK=1 turns it into a visible skip', () => {
  const r = suite({ VR_E2E_SKIP_OK: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /webkit e2e skipped: WebKit is not downloaded yet.*\(VR_E2E_SKIP_OK=1\)/);
});
