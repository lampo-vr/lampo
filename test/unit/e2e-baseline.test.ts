// Screenshot baselines (test/e2e/lib/baseline.mjs): a platform without a committed baseline records one on a
// developer's machine, but on CI that would compare nothing and pass every run — there a missing baseline fails (or,
// while a workflow says VR_BASELINE_MISSING=skip, is a skipped check, never a pass), and the screenshot is kept where
// the workflow uploads it. Every suite that compares screenshots decides through it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { baselineFiles, baselinePlan, NEW_BASELINE_DIR, onCI } from '../e2e/lib/baseline.mjs';
import { ROOT } from '../lib/helpers.ts';

test('compare when there is a baseline, record the first one locally, fail for a missing one on CI', () => {
  assert.equal(baselinePlan({ exists: true, ci: false }), 'compare');
  assert.equal(baselinePlan({ exists: true, ci: true }), 'compare');
  assert.equal(baselinePlan({ exists: false, ci: false }), 'record');
  assert.equal(baselinePlan({ exists: false, ci: true, missing: '' }), 'missing');
  assert.equal(baselinePlan({ exists: true, update: true, ci: true }), 'record', 'VR_UPDATE_BASELINE=1 records on purpose');
  // A workflow without the platform's first baselines yet: skipped, not passed — and only where there is none.
  assert.equal(baselinePlan({ exists: false, ci: true, missing: 'skip' }), 'skip');
  assert.equal(baselinePlan({ exists: true, ci: true, missing: 'skip' }), 'compare', 'a committed baseline is always compared');
  assert.equal(baselinePlan({ exists: false, ci: false, missing: 'skip' }), 'record', 'off CI the first run records');
  assert.equal(baselinePlan({ exists: false, ci: true, missing: 'yes' }), 'missing', 'only "skip" skips');
});

test('CI is what CI says', () => {
  assert.equal(onCI({ CI: 'true' }), true);
  assert.equal(onCI({ CI: '1' }), true);
  assert.equal(onCI({}), false);
  assert.equal(onCI({ CI: 'false' }), false);
  assert.equal(onCI({ CI: '0' }), false);
});

test('a missing baseline is kept where the workflow uploads it', () => {
  const f = baselineFiles('styleguide-dark', 'linux');
  assert.equal(f.baseline, path.join(ROOT, 'test/e2e/baseline/styleguide-dark-linux.png'));
  assert.equal(f.fresh, path.join(NEW_BASELINE_DIR, 'styleguide-dark-linux.png'));
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /uses: actions\/upload-artifact@v\d+[\s\S]*?path: test-output\/baseline\//, 'ci.yml uploads test-output/baseline/');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^test-output\/$/m, 'and git ignores it');
});

test('every browser suite that compares screenshots decides through baselinePlan', () => {
  const E2E = path.join(ROOT, 'test/e2e');
  const off = fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(E2E, f), 'utf8');
      return /\bdiffPng\(/.test(src) && !/\bbaselinePlan\(/.test(src);
    });
  assert.deepEqual(off, []);
});
