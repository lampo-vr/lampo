# AGENTS.md

Hydration for any agent or session working **on this repository** (Claude Code loads it through `CLAUDE.md`). Read it
first, then:
1. `CHANGELOG.md` → `[Unreleased]`: what changed recently;
2. `ROADMAP.md`: what comes next and the open decisions;
3. `AGENTS.local.md`, if it exists: the index of the current state, an area per file in `.claude/state/` (private);
4. `HANDOFF.local.md`, if it exists: the maintainer's private context (gitignored, never commit its contents);
5. before you change code: the rules for its area in `.claude/rules/` (the table under *Rules learned the hard way*;
   Claude Code loads them by itself when it opens a matching file).

Agents that only *use* the tool to receive feedback on their renders want the README's "For agents" section and
`docs/agents.md` instead.

## What this is

A frame-exact video review tool. A reviewer pins notes (with drawings) to exact frames; the notes land as plain files
(`data/<slug>/review.json`, `INBOX.md`, screenshots) or behind a hosted server, where AI agents read and act on them
through the `lampo` CLI or the MCP server. One app, on a person's own machine (signed in there automatically, renders
linked where they live, Claude Code sessions and other machine extras) or hosted (`LAMPO_MODE=server`: storage
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
| `lib/backend/` | what `lampo` and MCP talk to: `local` (the store) or `remote` (a hosted server over HTTP) |
| `lib/cli.ts`, `mcp/`, `bin/` | the agent interfaces; tools in `mcp/tools/`, their rights in `mcp/access.ts` |
| `lib/playbook*.ts` | playbooks: editing, suggestions, files, what agents read |
| `lib/publish/` | publishing a final video: posts and the gate, the platforms' limits (browser-safe `platforms.ts`), connections with sealed secrets, the YouTube and Zernio adapters, the queue, the kit; every request through `net.ts` ([docs/publishing.md](docs/publishing.md)) |
| `server/app.ts`, `server/routes/*` | Express 5 app: guard, SSE, routes, one error handler; `server/index.ts` is the process |
| `web/src/` | React 19 UI: `api/` (TanStack Query), `player/`, `library/`, `inbox/`, `guest/`, `settings/`, `ui/`, … |
| `test/unit`, `test/e2e`, `test/mcp-e2e.ts` | tests; every one builds its own throwaway store |
| `bench/` | `stt/` the speech engines, `perf/` speed on 1,000 videos, `tokens/` what Lampo costs an agent |
| `docs/` | reference docs; `docs/architecture.md` is the deep dive |

## Run and verify

Node ≥ 22.18 runs the TypeScript directly (`.nvmrc` pins 24; `bin/lampo` finds a capable Node by itself).

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
Generated clips are cached per machine in `<tmp>/vr-test-media/` (`LAMPO_TEST_MEDIA_CACHE=off` to encode afresh).
CI (`.github/workflows/ci.yml`: Linux on GitHub's `ubuntu-latest`; only a private copy sends its own jobs to a
self-hosted runner; `macos.yml` only on the `macos` label or by hand) is described in CONTRIBUTING.md; its styleguide
comparison is skipped until Linux baselines are committed.

Anything you start by hand (server, `lampo`, scripts) must use a throwaway store: `LAMPO_DATA=<tmp>/data LAMPO_CACHE=<tmp>/cache`
(and `LAMPO_STT=off` unless you test speech). A checkout with a `data/` folder next to the app **is a live store**.

## Invariants

- **Frame exactness is the product.** Browser seeks go to `(N + 0.5) / fps`, frame grabs to `(N − 0.5) / fps` (which
  matches ffmpeg's `select=eq(n,N)`), the shown frame comes from `requestVideoFrameCallback` `mediaTime`. Any change to
  seeking, timecodes, proxies or screenshots needs a test that compares against ffmpeg's decoded frame.
- **The data contract stays backwards compatible.** Existing stores must load unchanged; agents parse `lampo watch` lines,
  `lampo prompt` and `INBOX.md`. New fields are optional; nothing is renamed.
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
   work. A rule learned the hard way gets one line in the `.claude/rules/` file of the area whose code it's about (the
   table below; one that holds everywhere goes in this file). `ROADMAP.md` when scope or priorities change. If
   `HANDOFF.local.md` exists, append a dated line there too (private context, gitignored).
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
Agent-facing text (`lib/stage.ts`, `lampo`, MCP, INBOX.md) keeps its words; the UI maps them. The product is Lampo,
and so is everything people and agents type: the `lampo` command and `lampo-mcp`, `LAMPO_*` settings (read through
`lib/env.ts`), the MCP key `lampo`, `lampo://` resources, the repository and the npm package `@lampo-vr/lampo`. The
older names keep working and stay out of new text: `vr` / `vr-mcp` run the same code (`bin/`), `VR_*` is read where
`LAMPO_*` is unset, `vr://` and the key `video-review` still answer. Data paths (`~/.video-review`, `data/`), file
formats, MCP tool names, the OAuth client id `vr` and crypto labels keep their names: changing them would break stores,
sessions or installs.

## Rules learned the hard way

Each area's rules live in its own file in `.claude/rules/`, so a session reads the ones for the code it changes and not
the rest. Claude Code loads a file by itself when it reads or edits a file its paths match; any other agent reads the
file for the paths it is about to change, from this table, before the first edit. A rule that holds everywhere stays
here.

| File | Rules about | Paths |
|---|---|---|
| [store.md](.claude/rules/store.md) | Data and the store | `lib/**` `server/**` `mcp/**` `bin/**` `scripts/**` |
| [workspaces.md](.claude/rules/workspaces.md) | Workspaces | `lib/**` `server/**` `mcp/**` `scripts/**` `test/unit/workspace-isolation.test.ts` |
| [permissions.md](.claude/rules/permissions.md) | Permissions and accounts | `lib/**` `server/**` `mcp/**` `test/unit/access-ends.test.ts` |
| [hosted-server.md](.claude/rules/hosted-server.md) | Hosted server | `lib/**` `server/**` `mcp/**` `deploy/**` |
| [agent-text.md](.claude/rules/agent-text.md) | What agents read | `lib/**` `server/**` `mcp/**` `bin/**` `skills/**` `docs/**` `README.md` `bench/tokens/**` `test/unit/token-budget.test.ts` |
| [ui-speed.md](.claude/rules/ui-speed.md) | UI: speed | `web/**` |
| [ui-look.md](.claude/rules/ui-look.md) | UI: look and layout | `web/**` |
| [ui-words.md](.claude/rules/ui-words.md) | UI: words and state | `web/**` |
| [tests.md](.claude/rules/tests.md) | Tests | `test/**` |

### Docs
- A line in a code block of the README or `docs/*.md` fits 96 characters (`docs-shape.test.ts`); prose may run on.
- Pictures of the app come from `npm run screenshots` (`scripts/shots/`, synthetic footage): `x.webp` + `x-light.webp`.
- `CHANGELOG.md` is public on lampo.video: no audit or sweep ids (A13 …, CLOUD-1, sweep 2), and a security fix says
  what is protected, never how it was attacked or its exact thresholds (those stay in AUDITS.md and the reports).
