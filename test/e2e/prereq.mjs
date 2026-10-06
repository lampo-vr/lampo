// A browser suite that can't run must not pass. A missing Chrome, web/dist or WebKit fails the run (exit 1), so a
// fresh clone's `npm run test:all` or a CI image without a browser can't report green without testing anything.
// Locally, VR_E2E_SKIP_OK=1 turns these into skips on purpose (e.g. on a machine without Chrome).

/** Ends the suite: a skip when VR_E2E_SKIP_OK=1, otherwise a failure that says what's missing. */
export function unavailable(label, reason) {
  if (process.env.VR_E2E_SKIP_OK === '1') {
    console.log(`${label} skipped: ${reason} (VR_E2E_SKIP_OK=1).`);
    process.exit(0);
  }
  console.error(`${label} can't run: ${reason}. Set VR_E2E_SKIP_OK=1 to skip browser suites on purpose.`);
  process.exit(1);
}
