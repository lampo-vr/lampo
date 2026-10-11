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
- A double tap goes through CDP's `Input.dispatchTouchEvent` with each touch's `timestamp`: sent one by one, a loaded
  machine delivers them apart, and the page's `timeStamp`s follow the stamps (`mobile.mjs`).
- A row that must fit a phone is also checked with letters a little wider (`letter-spacing: 0.04em`): Linux sets them
  wider than a Mac, and CI's 390 px overflowed by 6 px where the Mac's fit (`record.mjs`, `zoom.mjs`).
- A `setViewport` that turns `isMobile` or `hasTouch` on or off reloads the page (puppeteer does): wait for the screen
  again before the next click. On a Mac puppeteer's first query after the load came later than the drafts did; on CI's
  Linux runner (or `LAMPO_E2E_CPU=2`) it came first (`record.mjs`, back from the phone widths).
- After a seek, wait for the picture (`closestFrame` in an `until`), not for a new rVFC: a paused video presents
  nothing new once the seek's frame is up, so a callback asked for after it never comes (`player.mjs`).
- A key gone from a mock bucket is not its removal ended: the remover drops the working copy once the bucket has
  answered. Read working copies after `store.removalsSettled()`, never right after the bucket looks empty
  (`playback-copies-deleted.test.ts`; mockBunny's `deleteAnswerDelayMs` widens that gap).
- Something left "waiting" a timer should have woken, about 1 run in 100: look for a `Date.now()` check of the timer's
  deadline (Node fires timers up to 1 ms before Date.now() gets there). Force it by setting `Date.now` back once the
  timer is set (after a `setImmediate`, the microtasks that set it have run) and restore it in `finally`
  (`files-upload-store.test.ts`).
- A negative substring check ("B's answer never says X") uses a probe that can't occur in a token: a space or a letter
  outside ASCII (`'Mia Kovač'`), never a short ASCII name. Links, ids and hashes are base64url or hex, and "Mia" turned
  up inside a random video id about once in 7,000 runs (`shares.test.ts`). Check the parsed fields too, and that the
  probe arrived whole where it belongs.
- Times in the store are to the second (`isoLocal`): two writes in a row land in one second or two, and a list sorted
  newest first swaps them. Never assume which of two such items comes next; open the one the check is about
  (`inbox.mjs` "Still wrong").
- A price that keeps both intervals in the page (the plans' roll) is read with `innerText`: the one rolled away is `visibility: hidden`, still in `textContent` (billing.mjs `seen`).
- A click on something near the window's foot can land on the toasts stacked there (puppeteer clicks the point, not the element): bring it to the middle and wait until `elementFromPoint` is inside it (`playbook.mjs`, the skill's row after three saves).
- What a stand-in proxy holds is one test's: a request held paused never reads its sender's close (`gone` stays false),
  so once its sender has exited it is dropped, never let go to the server; and a wait for "an answer came" counts only
  requests that came in while this test listens. Let go late, a stopped upload's 404 was taken for the next render's
  answer, whose SIGINT then hit `lampo` while Node was still starting (`render-stop.test.ts`, half the runs under load).
- A file two processes share (the stand-in billing module's state, a store file a suite edits under its running server)
  is written with a rename (`writeJsonAtomic`, `test/e2e/lib/sharedJson.ts`), and its reader never turns a parse error
  into a default (`readJson`: only a missing file is). A plain write empties the file first: CI's conversion suite read
  half of it, a tight loop tore 1 read in 6, and the module had read a torn file as "Free for everyone".
