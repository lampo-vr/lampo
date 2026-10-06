# AGENTS.md

Hydration for any agent or session working **on this repository** (Claude Code loads it through `CLAUDE.md`). Read it
first, then:
1. `CHANGELOG.md` → `[Unreleased]`: what changed recently;
2. `ROADMAP.md`: what comes next and the open decisions;
3. `AGENTS.local.md`, if it exists: the index of the current state, an area per file in `.claude/state/` (private);
4. `HANDOFF.local.md`, if it exists: the maintainer's private context (gitignored, never commit its contents).

Agents that only *use* the tool to receive feedback on their renders want the README's "For agents" section and
`docs/agents.md` instead.

## What this is

A frame-exact video review tool. A reviewer pins notes (with drawings) to exact frames; the notes land as plain files
(`data/<slug>/review.json`, `INBOX.md`, screenshots) or behind a hosted server, where AI agents read and act on them
through the `vr` CLI or the MCP server. One app, on a person's own machine (signed in there automatically, renders
linked where they live, Claude Code sessions and other machine extras) or hosted (`VR_MODE=server`: storage
adapters, everyone signs in, teams in workspaces). Clients review through review links without an account.

## Map

| Path | Responsibility |
|---|---|
| `lib/types.ts` | the data contract as types: review.json, events, shares, API shapes. Change it first, deliberately |
| `lib/store.ts` | reviews, versions, comments, events, INBOX.md, review.md; per-video locks, atomic writes |
| `lib/time.ts`, `lib/range.ts`, `lib/stage.ts`, `lib/findings.ts` and every `lib/` module `web/` imports | shared with the browser: no Node imports |
| `lib/probe.ts`, `lib/shots.ts`, `lib/media.ts`, `lib/diff.ts`, `lib/qa.ts`, `lib/previews.ts` | ffmpeg: probing, frame grabs, posters/analysis, version diff, Auto-check, fix previews |
| `lib/jobs.ts` | one heavy background job at a time, by priority; hosted: workspaces take turns, queues bounded |
| `lib/stt/`, `lib/text/`, `lib/transcripts.ts` | speech-to-text engines; OCR + spelling; a render's transcript |
| `lib/storage/` | where renders live in server mode: local, Bunny, S3 |
| `lib/scope.ts`, `lib/workspaces.ts` | which workspace work is for; the registry and memberships |
| `lib/auth.ts`, `lib/shares.ts`, `lib/mail/`, `server/permissions.ts` | accounts + API tokens; review links; the mailer; the one permission table |
| `lib/backend/` | what `vr` and MCP talk to: `local` (the store) or `remote` (a hosted server over HTTP) |
| `lib/cli.ts`, `mcp/`, `bin/` | the agent interfaces; tools in `mcp/tools/`, their rights in `mcp/access.ts` |
| `lib/playbook*.ts` | playbooks: editing, suggestions, files, what agents read |
| `lib/publish/` | publishing a final video: posts and the gate, the platforms' limits (browser-safe `platforms.ts`), connections with sealed secrets, the YouTube and Zernio adapters, the queue, the kit; every request through `net.ts` ([docs/publishing.md](docs/publishing.md)) |
| `server/app.ts`, `server/routes/*` | Express 5 app: guard, SSE, routes, one error handler; `server/index.ts` is the process |
| `web/src/` | React 19 UI: `api/` (TanStack Query), `player/`, `library/`, `inbox/`, `guest/`, `settings/`, `ui/`, … |
| `test/unit`, `test/e2e`, `test/mcp-e2e.ts` | tests; every one builds its own throwaway store |
| `bench/` | `stt/` the speech engines, `perf/` speed on 1,000 videos, `tokens/` what Lampo costs an agent |
| `docs/` | reference docs; `docs/architecture.md` is the deep dive |

## Run and verify

Node ≥ 22.18 runs the TypeScript directly (`.nvmrc` pins 24; `bin/vr` finds a capable Node by itself).

```sh
npm install
npm run check        # strict typecheck (backend + web) and Biome
npm test             # the fast tier: unit + API + server mode + storage mocks + remote vr/MCP + the frozen store-v0
npm run test:mcp     # MCP end to end
npm run test:qa      # pre-review on a generated clip
npm run build && npm run test:e2e   # the full tier: every browser suite, all failures listed at the end (`npm run chrome:install` once)
npm run test:e2e -- --only quality,perf   # some suites (--except, --shard 1/2 too); test:e2e:parallel side by side
npm run test:changed && npm run test:e2e -- --changed   # only what your change can affect (vs main)
npm run test:perf    # speed budgets at CPU 4× (in test:e2e on CI, with --perf and in test:all; bench/perf/ for the full picture)
npm run test:all     # all of the above
```

Tests wait for states, never for times (a loaded machine is slow, not wrong): `until` (test/lib/helpers.ts), `settle`
(test/e2e/layout.mjs). API tests start their app with `startApp()` (test/lib/app.ts: production keep-alive, its own
`after`; top level, before the tests). A browser suite is any `test/e2e/*.mjs` on `./lib/checks.mjs` — no list to keep.
Generated clips are cached per machine in `<tmp>/vr-test-media/` (`VR_TEST_MEDIA_CACHE=off` to encode afresh).
CI (`.github/workflows/ci.yml`: Linux on GitHub's `ubuntu-latest`; only a private copy sends its own jobs to a
self-hosted runner; `macos.yml` only on the `macos` label or by hand) is described in CONTRIBUTING.md; its styleguide
comparison is skipped until Linux baselines are committed.

Anything you start by hand (server, `vr`, scripts) must use a throwaway store: `VR_DATA=<tmp>/data VR_CACHE=<tmp>/cache`
(and `VR_STT=off` unless you test speech). A checkout with a `data/` folder next to the app **is a live store**.

## Invariants

- **Frame exactness is the product.** Browser seeks go to `(N + 0.5) / fps`, frame grabs to `(N − 0.5) / fps` (which
  matches ffmpeg's `select=eq(n,N)`), the shown frame comes from `requestVideoFrameCallback` `mediaTime`. Any change to
  seeking, timecodes, proxies or screenshots needs a test that compares against ffmpeg's decoded frame.
- **The data contract stays backwards compatible.** Existing stores must load unchanged; agents parse `vr watch` lines,
  `vr prompt` and `INBOX.md`. New fields are optional; nothing is renamed.
- **`versions/` can't be regenerated.** Never delete or rewrite it; `cache/` is disposable. Never run experiments or
  tests against a live store, and never bulk-delete in one.
- **Server mode is hostile territory.** No filesystem paths from clients, no shell strings, ffmpeg only with
  `-protocol_whitelist file,pipe`, zod on every input, 5xx details hidden, guest tokens scoped to their video(s).
- **Error text goes by audience, never by mode.** Only the machine's owner at the machine (`via === 'local'`, off a
  review-link path) reads errors as they are; everyone else gets a sentence + ref for a 5xx and for anything internal
  (a tool's output, an errno, an `internal()` error): `publicMessage` / `shownTo` in `lib/publicError.ts`, `audienceOf`
  in `server/http.ts` and `mcp/access.ts`.
- **Nothing tracks or resolves a path on this disk unless `via === 'local'`.** MCP tools get `backendFor(principal,
  backend)`; a path from anyone else is answered like an unknown name — never whether a file is there.
- **No client names, real paths or client media** in the repository, tests, screenshots or commit messages.
- TypeScript with erasable syntax only (no enums, namespaces or parameter properties), imports with `.ts`
  extensions, Biome formatting (2 spaces, width 160, single quotes). Comments explain *why*, sparingly.

## How work is done here

1. Small, reviewable commits with a message that says what and why. End with
   `Co-Authored-By: <agent> <…>` when an agent wrote it. **Never push, publish or tag** unless the maintainer asks.
2. Tests with every behaviour change; a bug fix comes with a test that failed before it.
3. Before you report: `npm run check` + `npm run test:changed` + `npm run test:e2e -- --changed` green. The full
   `test:all` runs once per batch, on CI.
4. **`CHANGELOG.md`**: add a line under `[Unreleased]` for every user-visible change (Added / Changed / Fixed).
5. **`.claude/state/<area>.md`** (when `AGENTS.local.md` exists): update your area's file when you finish a piece of
   work. A rule learned the hard way gets one line below. `ROADMAP.md` when scope or priorities change. If `HANDOFF.local.md` exists,
   append a dated line there too (private context, gitignored).
6. Docs live next to what they describe; update `docs/` in the same commit as the behaviour.
7. **`AUDITS.md`**: when a merge changes an area's security surface, the same commit adds one line to the *Needs
   audit* queue. That covers new routes or inputs, auth or permission logic, workspace scoping, what review links
   show, people's data, text that reaches agents, files from outside, outbound requests and deploy settings. The fix
   of an audit finding adds a line too. A new tracked file needs an area there (`test/unit/audits.test.ts`). To see
   what changed since each area's last audit, run `node scripts/audits.ts`; to run an audit, use the `audit` skill
   (`.claude/skills/audit/`).

## Vocabulary

One word per thing in UI text, English and German (`de.ts`'s header lists the German): *Project* / *Folder* (a
top-level entry is a project, anything inside it a folder) · *Version* for each upload, always "V2" (never "render" as
a noun, never "v2"; "render" may stay in agent/CLI text) · *Note* (never "comment") · *Approve* / *Request changes* /
*Final* (not "verdict", "sign-off") · a fix is *checked*: "Fixes to check", *Looks right* / *Still wrong*, "check
mode" (never "verify" in the UI; the data status stays `verified`) · *Agent*, *Assign agent…* (not "session", "hand
to") · *Copy for an agent* · *Review link*, its kinds *Review* · *Watch only* · *Delivery* (watch and download) ·
*Embed* (one video's player on another site, German *Einbettung*; its code is the "embed code") · the stages read … → *Approved* → *Out for review* → *Approved via link* → *Final* (data: `with_client`, `client_approved`);
whoever reviews through a link is never "client" in UI text: the link's name, "via review link", "visitors"
("reviewer" is a workspace role) · *Inbox* only for the person's to-do list · counted musts are "must-fix" · a range is
a "section".
Agent-facing text (`lib/stage.ts`, `vr`, MCP, INBOX.md) keeps its words; the UI maps them. The product is Lampo and
agents add it as `lampo`; the repository is `lampo` too. The npm package, `vr`, `VR_*`, data paths, MCP tool names and
`vr://` URIs stay `video-review`.

## Rules learned the hard way

### Data and the store
- Never mutate what a parsed-once cache returns (`listReviews()`, shares `load()`, OAuth `current()`).
- Derived files are keyed by `renderKey(ver)`, never `ver.hash` alone: two renders can share a hash.
- Compare times with `compareTime`, never as ISO strings or with `localeCompare`.
- Ownership goes by account id (`author_id`, `by_id`, `isOwner`); names only for older records.
- A registry file that can't be read (folders, shares, links, workspaces) is never "empty": refuse writes.
- A review link points at a video or folder id (`Share.video_id` / `folder_id`), never a name.
- Drafts and unsent recordings stay out of review.json and events; only their author reads them, never a token.
- What a person made (avatars, refs, previews) goes through the storage adapter, never `cache/`.
- The onboarding sample logs no events; Insights, taste, suggestions and `usageOf` skip it.

### Workspaces
- Every in-memory map keyed by a slug, a render's hash or a token goes through `wsKey`.
- Use `dataDir()`, `cacheDir()`, `versionsDir()`, `eventsFile()`, `storage()`, never `DATA` / `CACHE` / `EVENTS_FILE`.
- `rootStorage()` only for what no workspace owns (avatars); nothing at start or on `/readyz` reads `dataDir()`.
- Work queued now and run later is wrapped in `boundToWorkspace(fn)`; never fall back to workspace #1.
- Never read `user.role` for a permission (workspace #1's mirror): `req.auth.role`, `roleIn(ws, user)`.
- A new per-workspace thing joins `ids.ownedSets` and `ids.ownedSetsA` in `workspace-isolation.test.ts`; run it.

### Permissions and accounts
- A new route goes in the permission table (`server/permissions.ts`): an unlisted write is refused to everyone.
- A route touching credentials, roles, members, invites, tokens, apps, webhooks, workspaces or links is `PERSON_ONLY`.
- Who runs the server is the operator list (`isOperator`, lib/operator.ts: LAMPO_OPERATOR, else #1's owners), never a role in workspace #1.
- Decide by capability (`ctx.capabilities`) or `req.auth.via`, never by mode.
- Sign-off (approve, carry, final, reopen) is a person's: API tokens get 403 (`signOffByPerson`).
- Publishing is a person's too (`publish`, `PERSON_ONLY`); agents only draft, and no tool or scope publishes.
- API tokens never read review-link tokens (`listedFor`).
- Anything that ends access calls `accessEnded()` (and gets a row in `access-ends.test.ts`); nothing else may.
- What a new password ends lives in `afterNewPassword`; new credential-bound things join it.
- Account answers are the same for every address (sign-up, reset, invite, add user): no enumeration.
- Read the session cookie with `sessionOf(req)` (`__Host-` over https), a query string with zod (`query`/`queryOr`).

### Hosted server
- A failure becomes a 4xx through `failFrom(status, e)`, never `fail(status, e.message)`.
- Object-store and speech failures are `internal()`; their status is someone else's (`statusOf`).
- Event screenshot paths are for `via === 'local'` only: everyone else gets URLs (`ctx.eventFor(via)`).
- A path that goes to the log goes through `loggedPath`: review-link tokens and tickets live in paths.
- Maps keyed by what visitors send are `Recent` / `RateLimit`, listed with `keptInMemory`; never a bare `Map`.
- Per-address limits key by `addressKey` (IPv6 by its /64); guest write limits count only writes that landed.
- ffmpeg runs through `run` / `spawnMedia` (timeout, stderr tail), `incoming: true` for outside files; never `spawn`.
- ffmpeg someone waits for outside the job queue (a frame, a screenshot, a reference) passes `onDemand: true`; a
  whole-video decode streams into a fixed window of frames, never holds them all; analysis heights go through `analysisRows`.
- A background job gets a crash-guard key (`heavy(…, { key })`, lib/crashGuard.ts): one that kills the process isn't run on every start.
- Outbound requests (webhooks, OAuth metadata) go through `lib/netguard.ts`; publishing's through `lib/publish/net.ts` on top of it.
- An unsafe hosted setting is a refusal in `startupProblems`: one line, never a stack trace.
- Hosted jobs: `needJobRoom` before a start, `unlessBusy` for warm-ups, `mustRun` for owed work.
- Never broadcast `review` per request: every open player refetches on it.

### What agents read
- Every person-written field in a line format goes through `oneLine`: names, captions, reasons, not only notes.
- Text whose lines are ours leaves through `keepLines` (MCP `text()`, `vr` output): only `\n` ends a line.
- Clean agent names where they come in (`cleanAgentName`) and stored ones on read (`shownName`, `shownEvent`).
- What a caller posts under an agent's name carries the caller's account (`ownedAgentName`).
- Agent formats keep their tokens (`vr` lines, INBOX.md, `CHANGE WORDS`, `PICKED`): append, never reword.
- A new MCP tool, field or line must fit `token-budget.test.ts`; raise a budget only with a `bench/tokens/` run.
- MCP schemas go through `trimmed()`, inputs for the few are `.meta({ hidden })`; a new tool gets its `TOOL_ACCESS`.
- Starting an agent: an argument list, no permission flag (`FORBIDDEN_FLAGS`), from the machine only.
- An answer that hands work to the person ends with `lib/handoff.ts`'s line (wait now, cursor from that moment).

### UI: speed
- Never import `radix-ui` in a module the first paint needs; budget 183 KB (`BUNDLE_BUDGET_KB`).
- On-demand code goes through `lib/lazy.ts` (`loader`, `useLoaded`, `screen`), not `lazy()` + Suspense.
- A new dynamic import in the first paint costs its preload entry: ride an existing chunk, measure a build.
- Loading states use the real layout (`pending` props, `SkLine`, `…Pending` rows); never a separate skeleton tree.
- What follows playback subscribes to `player/frameStore.ts` (`pb.live`, `useFrame`), never `pb.frame`.
- Writes are optimistic (`guess()` + rollback); SSE events patch their video, never refetch the library.
- An action with Undo waits behind `later()` and is sent on `beforeunload` too, not only `pagehide`.

### UI: look and layout
- Every size and colour is a token in `base.css`; stylesheets define only their own classes.
- No `var()` inside a `@keyframes` timing function: Safari ignores it and runs linear.
- Implicit grid and auto columns: `minmax(0, 1fr)`; they grow to their content otherwise.
- One layer order: overlay 50 < sheet 51 < dialog 52 < menu 55; never patch a single case.
- No `grain` on a scrolling box; phone bars fit, they don't scroll; a strip that scrolls uses `useScrollEdges`.
- `pre-wrap` still breaks after `-` and `/`: a token, URL or path to copy goes through `Code` (nowrap `.set-code-w`).
- Status is a keyframe glyph (`KeyGlyph`), never a coloured dot; selection never wears the orange.
- List selection is a flat fill (`--sel`, `--sel-on`), never raised; a bar floating over a list keeps its room at the end.
- A popover opened by a pointerdown elsewhere (a timeline pick) opens once the press is over: the focus it moves closes it.
- Empty lists use EmptyState (in a card or lane: `RowEmpty`, `LaneEmpty`); no headline ends with a full stop.
- A box whose content switches (steps, tabs) keeps one height: every panel in one grid cell, the current one shown.
- A lazy screen's styles come with its own code; never lean on a class only another chunk's stylesheet defines.
- A bare `stop`, `close`, `open`, `print`, `find`, `status` or `name` is the window's (`stop()` aborts every request in flight): Biome refuses them, so a lost local helper of that name can't fall through to it.

### UI: words and state
- Every UI string goes through `t('…')` or `<T k>`; then `npm run i18n` and translate the new keys.
- A language switch re-renders in place: words outside a component go through `perLang(() => …)`; a `memo` or a `useMemo` with words in it reads `useLang()` (`i18n.test.ts` finds the first two).
- `|` in a UI string separates plural forms; a literal bar is `∣`.
- `npm run i18n` reads only literal keys: a key picked by a condition (`t(a ? 'x' : 'y')`, `<T k={…}>`) is one call per branch.
- Kept data and per-account localStorage are cleared in `afterSignOut`; none for review links.
- Inbox work never has "Got it": it leaves when done; dismissals only hide what informs.

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
- Imports go above a unit file's first test once it has a top-level `after()` (`startApp()` too): Node 22 runs the
  hook while a later top-level await is pending (`test-files.test.ts`).
- Tests never run the real `claude` CLI or send mail: the harness's stand-in and the outbox transport.
- Review a screen with real-shaped data (`test/e2e/lib/insightsStore.ts`) at 390–1920, both themes.

### Docs
- A line in a code block of the README or `docs/*.md` fits 96 characters (`docs-shape.test.ts`); prose may run on.
- Pictures of the app come from `npm run screenshots` (`scripts/shots/`, synthetic footage): `x.webp` + `x-light.webp`.
- `CHANGELOG.md` is public on lampo.video: no audit or sweep ids (A13 …, CLOUD-1, sweep 2), and a security fix says
  what is protected, never how it was attacked or its exact thresholds (those stay in AUDITS.md and the reports).
