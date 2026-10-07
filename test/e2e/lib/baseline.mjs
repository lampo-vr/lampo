// Screenshot baselines: test/e2e/baseline/<name>-<platform>.png, one per platform (fonts render differently
// elsewhere). A platform without one records its own on the first run, on a developer's machine. On CI a baseline
// recorded in the run compares nothing, so every run would pass: there a missing one fails, and the screenshot goes to
// test-output/baseline/, which the workflow uploads (ci.yml, e2e job) so it can be looked at and committed. Until a
// platform's first baselines are committed, a workflow can say so with VR_BASELINE_MISSING=skip: the comparison is
// then reported as skipped (a warning on the run, never a pass) and the screenshot is still kept for upload.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../../../lib/env.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASELINE_DIR = path.join(ROOT, 'test/e2e/baseline');
export const NEW_BASELINE_DIR = path.join(ROOT, 'test-output/baseline');

/** CI sets CI (GitHub Actions: "true"); "false" or "0" say it isn't. */
export const onCI = (env = process.env) => !!env.CI && env.CI !== 'false' && env.CI !== '0';

/**
 * What to do with a screenshot: `compare` it with the baseline, `record` it as the baseline (VR_UPDATE_BASELINE=1, or
 * the first run on this machine), or, on CI without a baseline for this platform, `missing`: fail and keep the
 * screenshot for upload — or `skip` it (kept for upload too) when the workflow set VR_BASELINE_MISSING=skip.
 */
export function baselinePlan({ exists, update = false, ci = onCI(), missing = settings.LAMPO_BASELINE_MISSING }) {
  if (update) return 'record';
  if (exists) return 'compare';
  if (!ci) return 'record';
  return missing === 'skip' ? 'skip' : 'missing';
}

/** The baseline of a screenshot on this platform, and where CI keeps a new one. */
export function baselineFiles(name, platform = process.platform) {
  const file = `${name}-${platform}.png`;
  return { baseline: path.join(BASELINE_DIR, file), fresh: path.join(NEW_BASELINE_DIR, file) };
}
