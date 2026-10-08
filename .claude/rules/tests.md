---
paths:
  - "test/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### Tests
- Browser suites use the harness in `test/e2e/lib/` (`e2e-harness.test.ts`); weigh a new one in `SECONDS`, and its
  first line says what it tests (`// covers:`, read by `--changed`; `test/lib/affected.ts`).
- Wait for a state (`until`, `settle`, `waitForFunction`), never a time; API tests start their app with `startApp()`.
- A check that a frame was shown counts `presentedFrames`: rVFC reports one frame per rendering step, and a busy main
  thread misses frames that were on screen (`startOf` in `test/e2e/range.mjs`).
- Until `/api/auth/status` answers, a screen's loading state can show fetched data (cards, the bell's count) but nothing
  role-gated, and the real page then replaces it: act after `signedIn(page)` (`test/e2e/lib/browser.mjs`).
- A loading state in the real layout shows the screen's title too: wait for the loaded screen's testid (`consent`),
  never its words. After a navigation, a click waits for the View Transition to end (`document.activeViewTransition`):
  until then it lands on the snapshot.
- What shows first is not yet the answer: an optimistic switch turns before the server has it (read the API after its
  toast), a line built from two requests shows one before the other (wait for the whole line), a dialog is scaled while
  it comes in (measure a box once it holds still two frames with no animation of its own; `options.mjs`).
- Imports go above a unit file's first test once it has a top-level `after()` (`startApp()` too): Node 22 runs the
  hook while a later top-level await is pending (`test-files.test.ts`).
- Tests never run the real `claude` CLI or send mail: the harness's stand-in and the outbox transport.
- Review a screen with real-shaped data (`test/e2e/lib/insightsStore.ts`) at 390–1920, both themes.
