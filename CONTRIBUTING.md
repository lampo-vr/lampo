# Contributing

Thanks for helping. This page covers everything you need to send a good pull request. For how the pieces fit
together, read [docs/architecture.md](docs/architecture.md) first.

## Setup

- **Node ≥ 22.18.** The server, CLI, MCP server and tests are TypeScript that Node runs directly, with no build step.
  `.nvmrc` pins 24 (`nvm use`); `.npmrc` sets `engine-strict`, so an older Node fails at `npm install`, and
  `npm start` / `npm test` check the version first and point at a capable Node if one is installed.
- **ffmpeg and ffprobe** on your PATH (macOS: `brew install ffmpeg`; Debian/Ubuntu: `apt install ffmpeg`).
- **Google Chrome or Chromium**, for the browser tests. Set `CHROME_PATH` if it isn't in a standard location.
- **On a minimal Linux** (a container, a fresh server): `python3` and `unzip`, which `npm test` uses to check the
  archives the app writes, and a font package such as `fonts-dejavu-core`, for the text ffmpeg draws in
  `npm run test:qa` and `npm run demo` (`apt install python3 unzip fonts-dejavu-core`). macOS and desktop Linux have
  them already. `scripts/ci-runner.sh need ffmpeg fonts python3 unzip` says what a machine lacks.
- Optional: `tesseract-ocr` (with the `deu` language) and `hunspell` (de_DE, en_US) on Linux, for the pre-review's
  text checks; macOS uses its built-in Vision framework and spell checker. To try the Linux path on a Mac:
  `brew install tesseract tesseract-lang hunspell` and `VR_OCR=tesseract`.
- Speech-to-text needs nothing extra: transcribe.cpp comes with `npm install`. Set
  `VR_STT_TEST_MODEL=/path/to/model.gguf` to run the real transcription test.
- On Linux x64, `npm install` also fetches about 500 MB of CUDA libraries for footage search's onnxruntime-node,
  which nothing here uses: `ONNXRUNTIME_NODE_INSTALL=skip npm install` leaves them out (CI does the same).

```sh
npm install
npm run dev        # the UI with hot reload on http://localhost:4747
npm run demo       # or: a throwaway store with synthetic renders and a full review history
```

Your real reviews are never touched by the tests or the demo: each uses its own temporary store (`VR_DATA`).

## Scripts

| | |
|---|---|
| `npm run check` | typecheck (strict TypeScript, backend and web) and lint (Biome) |
| `npm run format` | apply the formatting and safe lint fixes |
| `npm test` | the fast tier, for every commit: unit and integration tests (`node:test`), including server mode, storage adapters against mocks, `vr` + MCP against a server, and the frozen older store (`test/fixtures/store-v0/`) whose agent-facing text must not change. `VR_TEST_JOBS=<n>` runs n test files at a time (default: one fewer than the CPUs) |
| `npm run test:changed` | only the unit tests your change can affect (see [Testing what you changed](#testing-what-you-changed)); `npm run test:changed <base>` compares with another branch, `-- --list` names them |
| `npm run test:mcp` | the MCP server end to end through the real SDK client |
| `npm run test:qa` | the pre-review on a generated clip |
| `npm run test:e2e` | the full tier: every browser suite, one after another — headless Chrome against a real server, locally and in server mode, the phone layout on an emulated iPhone, and WebKit. Every suite runs whatever failed before it; the failures are listed at the end. `-- --only a,b`, `--except a,b`, `--shard 1/2` pick suites, `--changed [base]` only those your change can affect, `--list` names them; the speed budgets (`perf`) run on CI, with `--perf`, in `test:all` or when `--only`/`--changed` picks them; a suite still running after `VR_E2E_SUITE_MINUTES` (15) is stopped and counts as failed. Needs `npm run build` and `npm run webkit:install` first |
| `npm run test:e2e:parallel` | the same suites side by side (`VR_E2E_JOBS=<n>`, default half the cores, at most 4), for a faster local round; `test:e2e` stays the reference run |
| `VR_E2E_CPU=4 npm run test:e2e -- --only <suite>` | every page the suites open runs its scripts that many times slower (Chrome's CPU throttling): a busy CI runner on a quiet machine, for a race only CI shows |
| `npm run chrome:install` | download chrome-headless-shell and Chrome for Testing into `cache/chrome`, once: the suites prefer the shell (worktrees find the main checkout's), since the Chrome app on a Mac quits headless instances it thinks are idle; a suite that checks shown notifications (`launch({ notifications: true })`, the shell has none) gets Chrome for Testing. Without them the suites use Chrome/Chromium; `CHROME_PATH` overrides all |
| `npm run webkit:install` | download Playwright's WebKit (Safari's engine) into `cache/playwright`, once |
| `npm run test:webkit` | frame exactness in WebKit on an emulated iPhone (Playwright's Linux WebKit has no H.264: there it reports a skip) |
| `npm run test:all` | the build, then all of the above |
| `VR_TEST_MEDIA_CACHE=off npm test` | encode every generated clip afresh; by default each is made once per machine and copied from `<tmp>/vr-test-media/` (ffmpeg gives the same bytes for the same arguments) |
| `VR_PERF_STRICT=1 npm run test:perf` | the speed budgets as hard failures even on a busy machine; by default a time budget missed while the 1-minute load is above 10 is reported, not failed (the numbers then measure the machine) — run this on a quiet machine before merging speed work |
| `npm run build` | build the web UI into `web/dist` |
| `npm run screenshots` | make every picture of the app in `docs/assets/` again (README and docs, dark and light) from the synthetic demo; `npm run screenshots -- --only a,b` for some |

Tests generate their clips with ffmpeg, so there are no fixtures to download.

A browser suite that can't run (no Chrome, no `web/dist`, no WebKit) **fails** instead of passing silently, so a
green run always means the suites ran. On a machine without a browser, `VR_E2E_SKIP_OK=1 npm run test:all` turns
those into visible skips on purpose.

### Testing what you changed

The full run takes long on a busy machine, so a change is tested by what it can affect, and the whole of
`npm run test:all` runs once per batch of merged work, on CI. Before you report a piece of work as done:

```sh
npm run check
npm run test:changed               # the unit tests that import what you changed
npm run test:e2e -- --changed      # the browser suites that cover it (npm run build first)
```

Both compare your branch with where it left `main` (`origin/main` when there is no `main`; name another
base after `--changed` or `test:changed`) and count what isn't committed yet. `test/lib/affected.ts`
decides, from facts rather than a list kept by hand:

- **Unit tests** run when they import a changed file, directly or through local imports (static or
  dynamic), when a helper they call runs it (`vr()` runs `bin/vr`), when they name it as a path
  (`path.join(ROOT, 'docs')`), or when the test itself changed. A test that reads files in a way no
  string shows says so on its first line: `// covers: **` (every file, as `audits.test.ts` does).
- **Browser suites** each say on their first line what they test:
  `// covers: web/src/player/NotesPanel.tsx web/src/styles/notes.css lib/qa.ts` (a file, a folder ending
  in `/`, or a name with `*`). A suite runs when a changed file is one of those, or anything they import
  statically, or the suite itself. A dynamic import is a screen of its own (what the router loads), so a
  suite that tests a screen names it. `lib/types.ts`, `server/app.ts`, `server/index.ts`, the shell
  (`web/src/main.tsx`, `boot.tsx`, `App.tsx`, `index.html`, `vite.config.ts`), `web/src/ui/`, `base.css`,
  `index.css`, the dependencies and the harness every suite imports run every suite. So does code the app
  runs that no covers line reaches: the run names the file, and adding it to the covers line of the suite
  that tests it narrows the next run. Docs, unit tests and the CLI run no suite.

`test/unit/affected.test.ts` holds every suite to a covers line whose paths still name files.

### Writing a browser suite

A suite is one file in `test/e2e/` that runs with plain `node` and reports through `./lib/checks.mjs`: that is what
makes it a suite — `npm run test:e2e`, `test:e2e:parallel` and CI find it (`test/e2e/lib/suites.mjs`), there is no list
to add it to. Its first line says what it covers (above). It never finds Chrome, picks a port or starts the server
itself — `test/unit/e2e-harness.test.ts` fails if one does — but uses the harness in `test/e2e/lib/`:

```js
// covers: web/src/my-screen/ server/routes/my-route.ts
import { launch, requireChrome } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'my e2e';
// no Chrome or no web/dist: fails (or skips with VR_E2E_SKIP_OK=1)
requireChrome(LABEL);
// also mode: 'server', publicUrl, config, env, sessions
const srv = await startServer({ prefix: 'vr-my-e2e-', user: 'Sam' });
let browser;
try {
  // English, muted, reduced motion, a mouse; launch({ locale: 'de-DE' }) for another language
  browser = await launch();
  const page = await browser.newPage();
  await check('the library opens', async () => {
    await page.goto(`${srv.base}/#/`);
    assert(await page.$('.lib'), 'no library');
  });
} catch (e) {
  crashed(e, srv);
} finally {
  // "n/m my e2e checks passed", cleanup, exit code
  await finish(LABEL, { browser, servers: [srv] });
}
```

`startServer` gives the server its own temp store, a free port on 127.0.0.1, `VR_STT=off` and a stand-in for the
`claude` CLI (`sessions` sets what `claude agents` reports; a run the app starts is written down in
`<dir>/bin/runs.log`, prints `<dir>/bin/stream.jsonl` when a suite puts one there (stream-json, a line every
`bin/stream.delay` s) and waits while `<dir>/bin/hold` exists; see `test/e2e/wake.mjs` and `monitor.mjs`), drops the
`VR_*` settings of your shell that would change the instance (mode, storage, URLs, tokens, proxies), and stops the
server when the suite exits; `await srv.setupToken()` is a hosted server's one-time setup token. Its fresh store stands
for one in use: new accounts there get no first run unless the suite asks (`onboarding: true`, see
`test/e2e/onboarding.mjs`). Screenshots go to `VR_SHOTS` when it is set (`shotsDir()`; `screenshotFailures(() => page)`
adds one per failed check). `VR_CHECK=<part of a name>` runs only the checks whose name contains it
(`VR_CHECK=skeleton node test/e2e/quality-load.mjs`).

Wait for a state, never for a time: `until(fn, what)` (test/lib/helpers.ts) polls until `fn` gives something,
`jsonApi(base)` (`test/e2e/lib/api.mjs`) sets up what the page then shows, and `settle(page)` (`layout.mjs`) waits
until the page holds still after a resize, a theme switch or a load. A fixed sleep passes on a quiet machine and fails
on a busy one. For "it fits" use `fitsAt(page, where)` (seven widths, phone to 1920) or `layoutMatrix(page, states, …)`
(each theme × each state, or plain widths for an open dialog) rather than a loop of your own; for frame exactness,
`shownPicture` and `closestFrame` (`test/e2e/lib/frames.mjs`: the shown picture against ffmpeg's decode). A check that
can't decide here calls `skip(why)`: it shows as skipped, never as passed. In unit/API tests, `startApp()`
(`test/lib/app.ts`) starts the app the way the server does; call it at the top level, before the tests.

## What a good pull request looks like

- **One concern per pull request**, with a description of what changed and why.
- **Tests.** New behaviour comes with a test. A bug fix comes with a test that failed before it.
- **Frame accuracy is the product.** A change that touches seeking, timecodes, screenshots or version handling needs
  a test that compares against the frame ffmpeg decodes (see `test/unit/shots.test.ts`, `test/e2e/run.mjs` and, for
  Safari's engine, `test/e2e/webkit.mjs`).
- **`npm run check` and `npm run test:all` pass.** CI (`.github/workflows/ci.yml`) runs the unit, MCP and Auto-check
  tests on Linux (Node 22.18 and 24) and the Chrome suites on Linux in two parts (on chrome-headless-shell from
  `npm run chrome:install`, the browser their time budgets were set on), and builds the Docker image and checks that it
  answers `/healthz`; every job has a time limit and every failure is reported. In this repository every job runs on
  GitHub's `ubuntu-latest`. Only a private copy of the repository sends check, unit and the browser suites to a
  self-hosted runner (labels `self-hosted`, `linux`, `x64`, `lampo-ci`; never for a pull request from a fork or from
  Dependabot, never the Docker build); a job there has no sudo, installs nothing, fails naming what the machine lacks
  (`scripts/ci-runner.sh`), and stops whatever it left running. On CI's runners perf's time budgets are
  warnings (`VR_PERF_TIMES=report`), and the styleguide's screenshot comparison is *skipped* until Linux baselines are
  committed: take them from the run's `new-screenshot-baselines-<part>` artifact into `test/e2e/baseline/` and remove
  `VR_BASELINE_MISSING: skip` from the workflow. macOS (the unit and MCP tests and WebKit,
  `.github/workflows/macos.yml`) runs on demand, since GitHub's macOS runners are scarcer than its Linux ones: label the
  pull request `macos`, or start it from the Actions tab.
- **Screenshots** for visible UI changes.

## Style

- Formatting and lint are Biome's (`npm run format`). Line width is 160.
- Keep modules small and names descriptive. Comments explain *why*, not what the next line does.
- Only TypeScript syntax that Node can strip: no `enum`, no `namespace`, no parameter properties. Imports name the
  `.ts` file.
- No new runtime dependency without a good reason; say why in the pull request.
- The UI chrome stays achromatic. Colour is for meaning (severity, status, the agent) and the one primary action, and
  every colour is a token in `web/src/styles/base.css`.

## The data contract is a public format

`review.json`, `review.md`, `events.jsonl`, `INBOX.md`, the screenshot names and the `vr` output are read by agents
that never open the UI. Treat them like an API:
- add fields, but don't rename or remove them;
- keep old stores loading;
- update [docs/data-format.md](docs/data-format.md) and [docs/agents.md](docs/agents.md) in the same pull request.

The types in `lib/types.ts` are the contract.

## Extending

**A storage adapter** (another object store) implements `RemoteStore` in `lib/storage/index.ts`:
- `put`, `get`, `remove`;
- `url`, for signed direct URLs, or `null` to stream through the server;
- `origins`, for the Content-Security-Policy.

Register it in `createStorage` and add its configuration to `StorageConfig` in `lib/paths.ts` and to
`lib/config.ts`. The generic `Storage` wrapper already handles local working copies and eviction. Test it against a
mock server, as `test/unit/storage.test.ts` does for Bunny and S3, and document its setup in
[docs/server-mode.md](docs/server-mode.md#storage).

**A speech-to-text engine** is a backend in `lib/stt/`; see [docs/speech.md](docs/speech.md) for the interface and
how an engine is selected. Include how you measured it: [bench/stt/](bench/stt/) has the harness that chose the
current defaults.

**A pre-review check** goes in `lib/qa.ts`. It returns items with a stable `key`, so that dismissals survive
re-runs.

## Principles

- **Local-first.** On your own machine: no telemetry, no sign-up, nothing calls home; the network is used only for
  what you turn on (the speech model download, push, the tunnel, webhooks) and for footage search's model, about
  213 MB from Hugging Face, downloaded once when the first video is indexed (`VR_FOOTAGE=off` or `vr footage off`
  prevents it).
- **The renders under review are read-only.** Write only inside the store.
- **The server never exposes its disk** in server mode. Every path a client can influence is validated before it
  reaches the file system or ffmpeg.

## Contributor License Agreement

Contributions are accepted under the [Contributor License Agreement](CLA.md). It lets the maintainers also offer
Lampo under a commercial license; your contribution always stays available under the AGPL too. You sign it once: the
**CLA signed** check on your first pull request asks you to comment

```
I have read the CLA Document and I hereby sign the CLA
```

and turns green; it stays green on every later pull request. A comment saying `recheck` runs it again
(`.github/workflows/cla.yml`).

### Code you didn't write

Only submit work you wrote yourself, or that your employer allows you to contribute. If a pull request includes code
or media from someone else (a vendored library, an adapted snippet, an icon):
- keep its original copyright and license notice;
- say in the pull request where it comes from and under which license;
- keep it in separate files, where possible.

Only licenses compatible with the AGPL-3.0 can be accepted. When in doubt, ask in the pull request before you put
work into it.

## Security

Please report security problems privately, as described in [SECURITY.md](SECURITY.md), and not in a public issue.

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
