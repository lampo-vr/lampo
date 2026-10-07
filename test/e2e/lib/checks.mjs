// What every browser suite shares: named checks that report and carry on, and one summary line at the end
// ("8/8 status e2e checks passed") with the exit code CI reads. Temp stores are removed when every check passed and
// kept for inspection otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../../../lib/env.ts';

const results = [];
let failureShot = null;

class Skipped extends Error {}
/** Ends the running check as skipped, never as passed: it couldn't decide here (say why). Shown in the summary, and
 * as a warning on a GitHub Actions run. */
export const skip = (why) => {
  throw new Skipped(why);
};

/** Runs one named check: ✓ with its time, ✗ with the whole message and where it was thrown, or – when it skipped
 * itself; never throws. With VR_CHECK set, only the checks whose name contains it run (the rest are left out of the
 * count). */
export async function check(name, fn) {
  if (settings.LAMPO_CHECK && !name.includes(settings.LAMPO_CHECK)) return;
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    if (e instanceof Skipped) {
      results.push({ name, ok: true, skipped: e.message });
      console.log(`  – ${name}: skipped, ${e.message}`);
      // A workflow command is one line: GitHub reads %0A as a line break.
      const line = `${name}: ${e.message}`.replace(/%/g, '%25').replace(/\r?\n\s*/g, '%0A');
      if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=skipped check::${line}`);
      return;
    }
    results.push({ name, ok: false });
    await failureShot?.(results.length).catch(() => {});
    // The whole message (a rule may list every offender), then the first frames of where it was thrown.
    const at = String(e?.stack || '')
      .split('\n')
      .filter((l) => l.trim().startsWith('at '))
      .slice(0, 2)
      .map((l) => l.trim());
    console.log(`  ✗ ${name}\n      ${[String(e?.message ?? e), ...at].join('\n      ')}`);
  }
}

export const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** With VR_SHOTS set, a failed check also saves what `page()` shows then, as `<prefix>-FAIL-<n>.png`. */
export function screenshotFailures(page, prefix = 'FAIL') {
  const dir = settings.LAMPO_SHOTS;
  if (!dir) return;
  failureShot = async (n) => page()?.screenshot({ path: path.join(dir, `${prefix}-FAIL-${n}.png`) });
}

/** A failure outside the checks (setup, a page that never loaded): counted, with the servers' last words. */
export function crashed(e, ...servers) {
  results.push({ name: 'setup', ok: false });
  console.log(`  ✗ setup: ${e?.stack || e}`);
  for (const s of servers) if (s) console.log(s.log().slice(-800));
}

/**
 * Closes the browser, stops the servers, prints the summary and exits: 0 when every check passed (the temp stores
 * are removed then), 1 otherwise (they're kept, and the servers' last output is printed). With `skipped` (a reason the
 * suite found out only after starting, e.g. a browser that can't decode the clip) it says so and exits 0.
 */
export async function finish(label, { browser, servers = [], dirs = [], skipped = null } = {}) {
  await browser?.close().catch(() => {});
  for (const s of servers) await s?.stop();
  if (skipped && !results.some((r) => !r.ok)) {
    console.log(`${label} skipped: ${skipped}.`);
    for (const d of [...servers.filter(Boolean).map((s) => s.dir), ...dirs]) fs.rmSync(d, { recursive: true, force: true });
    process.exit(0);
  }
  const failed = results.filter((r) => !r.ok).length;
  const skips = results.filter((r) => r.skipped);
  const passed = results.length - failed - skips.length;
  console.log(
    `\n${passed}/${results.length} ${label} checks passed${skips.length ? `, ${skips.length} skipped (${skips.map((r) => r.name).join('; ')})` : ''}`,
  );
  const kept = [...servers.filter(Boolean).map((s) => s.dir), ...dirs];
  if (!failed) for (const d of kept) fs.rmSync(d, { recursive: true, force: true });
  else {
    if (kept.length) console.log(`kept ${kept.join(', ')} for inspection`);
    for (const s of servers) if (s) console.log(s.log().slice(-600));
  }
  process.exit(failed ? 1 : 0);
}
