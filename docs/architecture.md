# Architecture

Lampo (repository `lampo`, npm package `@lampo-vr/lampo`) is one TypeScript codebase. Node (22.18 or newer) runs the
server, the `lampo` CLI and the MCP server straight from the source, with no build step; Vite builds the web app.

![How Lampo fits together: the browser, MCP clients and lampo come in through the server's guard to its routes, which send live updates to every open screen; the routes and watchers write through lib/store, as lampo on your machine does directly; lib/store keeps data/ and registers every render in versions/; background jobs read the renders and fill cache/](assets/architecture.svg)

Three ideas carry the design:

- **Plain files are the source of truth.** Every change goes through `lib/store.ts`, under a lock per video, and is
  written atomically. The server is only one writer: `lampo` and the stdio MCP server on your machine read and write the
  same files directly, with no server running.
- **One app, two places.** The same server runs on a person's machine and hosted; what the machine adds is a list of
  capabilities ([below](#one-app-two-places)).
- **Frame exactness is the product**, kept at every step from the browser to ffmpeg ([below](#frame-accuracy)).

## Modules

The data:

| Code | What it does |
|---|---|
| `lib/types.ts` | the data contract as types: everything in `data/` and every API answer. The server, `lampo`, MCP and the UI import it |
| `lib/store.ts` | reviews, versions, notes, replies, approvals, events, INBOX.md and review.md; a lock per video and atomic writes. Listings reuse parsed reviews until their file changes, and hand them out frozen |
| `lib/paths.ts`, `lib/config.ts` | where things live, and the settings |
| `lib/workspaces.ts`, `lib/scope.ts` | workspaces on a hosted server: the registry and memberships; which workspace the work running now is for, carried by every request, job and stream it starts |
| `lib/folders.ts`, `lib/shares.ts` | projects and folders; review links |
| `lib/archived.ts` | archived projects: out of the lists, read only until a person restores them (shared with the UI) |
| `lib/drafts.ts` | notes saved and not sent yet, kept beside the review (never in it) until their author sends them in one write |
| `lib/stage.ts` | where a video stands (shared with the UI) |
| `lib/foryou.ts` | the inbox: what waits for whom |
| `lib/onboarding.ts`, `lib/sample.ts`, `lib/sample-film/`, `server/firstSample.ts` | the first run: steps that tick from real state; the sample, two versions of Lampo's brand film with a few notes, in a new workspace's library from the start |
| `lib/playbooks.ts`, `lib/playbookFiles.ts`, `lib/playbookText.ts` | playbooks: editing and suggestions, their files, the SKILL.md format |
| `lib/views.ts`, `lib/watch.ts` | who watched what, in hundredths of a version |
| `lib/insights.ts`, `lib/insightsRounds.ts`, `lib/insightsFlow.ts`, `lib/insightsWatch.ts`, `lib/taste.ts` | Insights (why videos take so many rounds), and the taste file |
| `lib/search.ts` | the ⌘K search: videos, folders and notes, every word matched, German spellings folded, best first |
| `lib/bundle.ts`, `lib/bundleExport.ts`, `lib/bundleImport.ts` | moving a store's reviews to another one: `lampo export` and `lampo admin import` ([moving.md](moving.md)) |

Media (ffmpeg):

| Code | What it does |
|---|---|
| `lib/probe.ts` | ffprobe metadata, the hashes that identify a version, and the one safe way to run ffmpeg (allowed formats, time limits) |
| `lib/shots.ts`, `lib/drawing.ts` | frame-exact screenshots and drawings; `drawing.ts` is shared with the UI |
| `lib/time.ts`, `lib/range.ts` | frames ↔ seconds ↔ timecode, and ranges of frames; shared with the UI |
| `lib/media.ts`, `lib/sprite.ts` | posters, hover-scrub sprites, waveforms per frame, loudness (EBU R128), freezes, project tracks (Remotion `timeline.json`) |
| `lib/diff.ts` | what changed between two renders: regions of the picture, audio, retimes |
| `lib/qa.ts`, `lib/text/` | Auto-check: text recognition and spelling, safe zones, flash and black frames, freezes, audio |
| `lib/findings.ts` | what a finding means (shared with the UI): the limits, whether a hold looks intended, dismissals on the same stretch across versions |
| `lib/previews.ts`, `lib/refs.ts` | fix previews (a still or clip of a fix, compared with the next render); references on notes |
| `lib/part.ts`, `lib/parts.ts`, `lib/splice.ts`, `lib/cuts.ts` | partial renders: the rules (shared with the UI), a part arriving and the comparison with the next full render, the whole video spliced together frame-exact, and where a render's shots begin |
| `lib/stt/`, `lib/transcripts.ts`, `lib/transcript.ts` | speech: voice notes, and what is said in a render, on its frames |
| `lib/recording.ts`, `lib/recordings.ts` | recorded feedback: what someone said while watching becomes draft notes |
| `lib/elements.ts`, `lib/elementMaps.ts` | element maps: where each named element of a render is, frame by frame, so a note points at an element |
| `lib/archive.ts`, `lib/zip.ts`, `server/routes/downloads.ts` | downloads: one version as it was rendered, and *Download all* as a store-only zip |
| `lib/publish/` | publishing a final version: posts, the platforms' limits, connections, the queue, the publish kit ([publishing.md](publishing.md)) |
| `lib/footage/` | footage search: shots, camera moves, keyframes and their embeddings, the search ([footage.md](footage.md)) |
| `lib/jobs.ts` | the background queue ([below](#background-jobs)) |
| `lib/storage/` | where renders live: local disk, Bunny Storage + CDN, or an S3-compatible bucket |

Accounts and the outside world:

| Code | What it does |
|---|---|
| `lib/auth.ts`, `lib/permissions.ts` | accounts, sessions and API tokens; the one table of what each role may do |
| `lib/avatars.ts` | profile pictures: checked like any outside file, kept as a square JPEG through the storage adapter |
| `lib/mail/`, `lib/accountLinks.ts` | email: the mailer (a queue on disk, retries, limits; a relay, or the outbox), its own SMTP client, the templates; the one-time links emails carry |
| `lib/oauth/`, `lib/scopes.ts` | sign-in for MCP clients, and what a connected app may do |
| `lib/webhooks.ts`, `lib/push/`, `lib/netguard.ts` | webhooks, push notifications, and the guard on requests to addresses someone chose |
| `lib/rateLimit.ts` | the one rate limiter (sign-in, invites, emailed links, OAuth, MCP, link passwords and notes), with bounded memory |
| `lib/accountExport.ts`, `lib/deletion.ts`, `lib/erasure.ts` | a person's own data: the export (a zip), deleting an account or a workspace — from Settings, the operator's pages or `lampo admin` — and what goes with it |
| `lib/operator.ts`, `lib/legal.ts` | who runs a hosted server (its operator); the operator's legal pages, linked where people sign in, sign up and pay |

Agents:

| Code | What it does |
|---|---|
| `lib/cli.ts`, `lib/cliAccount.ts`, `lib/cliMcp.ts`, `bin/` | `lampo`; `bin/lampo` and `bin/lampo-mcp` (and `bin/vr`, `bin/vr-mcp`, their older names) find a Node that is new enough |
| `mcp/` | the MCP server: `mcp/core.ts`, the tools in `mcp/tools/`, who may call which in `mcp/access.ts`. Served over stdio (`mcp/server.ts`, `bin/lampo-mcp`) and HTTP (`server/routes/mcp.ts` at `/mcp`); `mcp/app.ts` and `web/mcp-app/` are the review card (an MCP App) |
| `lib/backend/` | what `lampo` and the stdio MCP server talk to: the local store, or a hosted server over HTTPS |
| `lib/eventLine.ts`, `lib/prompt.ts`, `lib/handoff.ts` | the lines agents parse (`lampo watch`, `wait_for_feedback`), the *Copy for an agent* text, and the lines that say to wait (a hand-off's last line, a wait with nothing new, the stop after 30 minutes) |
| `lib/sessions.ts`, `lib/agentKind.ts`, `lib/agentStatus.ts` | Claude Code sessions on this machine, what kind an agent is, "rendering v4" |
| `lib/agentRun.ts`, `lib/runStream.ts`, `lib/activity.ts`, `lib/activityText.ts` | starting an assigned Claude Code session for a request, reading its output, and what agents do, live |
| `lib/options.ts`, `lib/asks.ts` | options an agent offers before it renders, and questions on a folder before any render exists |
| `lib/cliRender.ts`, `lib/render/` | `lampo render`: an agent's own render command, run on its machine, its progress shown in the app and the result put up as the next version |

The server:

| Code | What it does |
|---|---|
| `server/index.ts` | the process: settings, listening, watchers, building the UI on first start, warm-up, a graceful stop |
| `server/app.ts` | the Express app: guard, sign-in routes, live updates, `routes/`, one error handler |
| `server/guard.ts`, `server/auth.ts`, `server/permissions.ts` | who is asking (the machine itself, a cookie, a token) and which action each route needs |
| `server/workspace.ts` | runs every request in its workspace (a review link's own, else the caller's), with a request budget per workspace |
| `server/signup.ts`, `server/accountMail.ts` | where a confirmed sign-up works from then on; which email goes out, to which address, in which language |
| `server/extension.ts` | the one extension point: what a hosted service's module may limit (`402`) and hear, how it answers a sign-up, the workspace mail it may send, its billing routes. It is loaded only when `LAMPO_CLOUD_MODULE` names one; a self-hosted server has none and is complete without it |
| `server/routes/` | the API. Review links are in `server/routes/shares/`: `access.ts` (what a request may reach through a link, used by every guest route), `owner.ts`, `guest.ts` (the link, visits, views, a visitor's writes), `media.ts` (playback, posters, screenshots, downloads), `embed.ts` (an Embed link's player and oEmbed) |
| `server/playback.ts` | what the browser plays: originals, playback proxies, scrub copies |
| `server/background.ts` | the work done when a render arrives |
| `server/watch.ts`, `server/feed.ts` | re-renders and outside writes to `data/`; every new line of `events.jsonl` sent out live |
| `server/respond.ts` | compressed JSON with ETags, the pre-compressed UI |
| `server/ready.ts`, `server/shutdown.ts` | `/readyz`, and finishing work before stopping |
| `server/agentRuns.ts`, `server/activity.ts` | runs started on the machine; what agents are doing, live |
| `lib/runs.ts`, `server/runs.ts`, `server/routes/runs.ts` | agents' runs: one stretch of an agent's work on a video (`data/<slug>/runs.jsonl`), its plan, state and result; what opens and moves them; the runs API |
| `server/routes/yourData.ts`, `server/routes/operator.ts` | a person's own data (export, deleting the account or the workspace); the operator's pages (every workspace: its plan, suspend, delete; every account; the funnel) |

The UI lives in `web/src/`: `api/` (TanStack Query and live updates), `library/`, `player/`, `inbox/`, `guest/` and
`share/` (review links), `embed/` (an Embed link's player, a page of its own: `web/embed.html`), `playbook/`,
`publish/`, `auth/` (sign-in, accounts, workspaces), `onboarding/` (the first run), `settings/`, `operator/` (the
operator's pages), `billing/` and `conversion/` (only where a billing module runs), `uploads/`, `ui/` (the design
system), `i18n/`, `styles/`; [web/README.md](../web/README.md) has the whole tree.

## One app, two places

**On a person's own machine** (the default), the owner's account is made on the first start and requests from the
machine itself are that account, with no sign-in. Renders can be linked where they are on disk: adding one registers
it and watches its folder, and a re-render to the same path becomes the next version. Claude Code sessions on the
machine show up by themselves and can be started for a request. A phone joins with the link `npm run lan` prints, or
signs in.

**Hosted** (`LAMPO_MODE=server`), everyone signs in, renders arrive as resumable uploads (tus) and can live in Bunny or
S3, and the server never shows its own disk: no file browser, no tracking by path. Agents run `lampo login` and use the
same commands over HTTPS, or connect to `/mcp`; run inside a Claude Code session, `lampo watch` says it's there every 30
seconds, which makes the session assignable. A hosted server can hold several teams, each in a workspace of its own
([below](#security-boundaries)). Details: [server-mode.md](server-mode.md).

What the machine adds is a list of capabilities (`/api/info` → `capabilities`: linking files, local agents, Finder,
macOS text recognition, project files, INBOX.md, the tunnel, the phone link, starting an assigned agent). Features
decide by capability, or by how a request was identified, rather than by the mode. Everything else is the same in both
places: accounts, invites, uploads, the store format, notes and screenshots, versions and diffs, Auto-check and review
links.

## How a render flows

1. **Registration.** A file is added (on your machine) or uploaded. ffprobe reads it, and a content hash (the size,
   the first and the last MiB) identifies the version; when it equals the last version's, a sample of the middle
   decides (`Version.sample`). Files made from a render are named by `renderKey()`. The bytes are kept as
   `versions/<slug>/vN.<ext>` (a clone on macOS), or uploaded to remote storage, which is why older versions stay
   comparable after the file on disk is overwritten. An upload holds `data/.uploads/<slug>` from choosing N until vN
   is registered, so a second process uploading the same video at the same moment is refused (409) instead of
   overwriting it.
2. **Warm-up, in the background.** A poster, the loudness and freeze analysis, the diff against the previous version,
   Auto-check, a check of fix previews, a transcript when the version before had one, a scrub copy when the
   render's keyframes are far apart, and footage search's index where it is on.
3. **Playback.** The browser plays the original when it can decode it, or a playback proxy (ProRes and similar). Once
   the scrub copy is ready, the player switches to it while paused. A partial render plays as the whole video: the
   version it patches with the part's frames in their place, spliced once into the scrub copy's place, every frame
   keeping its number.
4. **Review.** A note records the frame, drawing, tags and severity. The server grabs the exact frame with ffmpeg from
   the original bytes and burns the drawing in: `<id>_clean.png` and `<id>_marked.png`. A note can be kept as a draft
   first: it waits beside the review, seen by its author only, and goes in with the others in one write when sent.
5. **Events.** Every change appends to `events.jsonl` (except drafts until they are sent, and anything on the first
   run's sample), and a change to a review rewrites its `review.md`. On the machine, a person's change also rewrites
   `INBOX.md`, under its own lock (`data/.inbox`), so two processes writing at once can't leave an older version
   behind. A change that fails writes no event. Live updates tell open browsers what to fetch again, and `lampo watch`
   follows the same events: from the file on the machine, over the event stream elsewhere.
6. **Runs.** Notes a team member sends to the video's agent open its run (`data/<slug>/runs.jsonl`); every activity
   the agent's calls make joins it, and the events above (a version, a fix, its question, the answer) move its plan
   and state. Only the app writes the file, under the video's lock, about a second after a change; the version a run
   produced names it (`Version.run`, set when it is registered, by whichever process registers it). A clock looks at
   open runs every 30 s for the ones that went quiet.

<!-- picture: render-flow — a render's path in five steps: registered (hash, versions/), warm-up jobs, playback (original or scrub copy), a note (clean and marked screenshots), the event (events.jsonl, live update, lampo watch) -->

### Background jobs

ffmpeg-heavy work goes through one queue (`lib/jobs.ts`) that runs **one job at a time**, highest priority first. On a
hosted server with several workspaces the people who run them take turns — the owner served longest ago next, then,
among that owner's workspaces, the one served longest ago —, each turn running that workspace's most urgent job. So a
backlog of any kind, spread over any number of one account's workspaces, holds another team's next job back by at most
one job per owner with work waiting. And a hosted server bounds what one workspace may have waiting (200 jobs): past
that, what someone asked for is refused with a 503 and a sentence (said once in the log), a warm-up nobody waits on is
skipped (it is made when asked for), and work the server owes — a note's fix check, a recording its maker waits for —
is queued anyway. Asking again for an analysis or a comparison already waiting joins it. The last 20 places are kept
for what a player waits on (a scrub copy, a part's splice); when even those are taken, the copy waits: the video's
media answer says `busy` once (the player says the server is busy and plays the version's own file), and the server
asks for the copy again by itself (5 s, doubling to a minute) instead of announcing the video on every request.

| Priority | Job | Why this order |
|---|---|---|
| 0 | scrub copy | makes the player feel instant; the reviewer is waiting for it |
| 0.5 | recorded feedback; a render's shots (for partial renders) | its maker waits for the draft notes; the where-menu waits for the shots |
| 0.75 | an agent's options: the files and frames of a question with choices | the agent's call waits for them: the question is asked once they are stored |
| 1 | a missing poster (after a restart or a cleared cache) | with remote storage it may download the render first, so one at a time |
| 2 | diff | "what changed" is the first thing to look at in a new render |
| 3 | fix-preview check; a full render compared with approved partial renders | compares a new render with the previews notes were checked on and the parts people approved, which settles those notes |
| 4 | analysis | loudness and freezes, for the badges |
| 4.5 | a platform's encode of a final video (the publish kit, or the file a post sends) | someone waits for it, but never a player |
| 5 | transcript | what is said, when someone asks or the version before had one |
| 6 | Auto-check | the slowest: text recognition on a frame every half second |
| 7 | checksums | only make the next folder download resumable |
| 8 | hover-scrub sprite | nice to have: made on the first request for it, for the newest render only (`GET /api/sprite/<slug>.jpg` answers 202 with `Retry-After` until then) |
| 9 | footage search's index | after everything a review needs, so it never delays one; a video's work is cut into chunks of a minute (or 48 keyframes), each a job of its own, so a long take never holds the queue |

Background work also runs at a lower OS priority, so the reviewer's playback never competes with it. Posters and
waveforms a browser asks for run outside the queue, three at a time, because someone is looking at the page; a cached
one never touches the render (nor remote storage). Other ffmpeg runs someone waits for (a frame, a note's screenshots,
a contact sheet, a reference) go through one gate outside the queue too: at most four at once, on two threads each,
and on a hosted server with several workspaces at most two per workspace; past what may wait, the answer is a `503`
with `Retry-After`.

A job that takes the whole process down with it (the system's out-of-memory killer, a crash in native code) is not
started again and again: each job of the warm-up leaves a marker in `cache/.jobs/` while it runs, the next start counts
a marker whose process died, and after two such ends the job is refused (`CrashedJobError`; the comparison it would
have made says so). A graceful stop (SIGTERM, Ctrl-C) removes the marker: an interrupted job runs again. Clearing the
cache gives every job its chances back. The diff itself streams both renders, keeping only the old version's frames
within a few seconds of the one it compares, so its memory doesn't grow with the length of the video.

## Frame accuracy

Frame accuracy is the product, and it is kept at every step:

- **Frame numbers** are 0-based at the render's real frame rate (23.976 is `24000/1001`, not 24). A note stores the
  frame; `t` and the timecode are worked out from it.
- **The browser.** Seeks go to the middle of a frame, `(N + 0.5) / fps`, so rounding can't land on a neighbour. The
  frame shown is read from `requestVideoFrameCallback`'s `mediaTime` (the frame actually presented), not from
  `currentTime`. Quick seeks are merged so the newest target always wins; where playback starts or jumps to (a
  section, a loop's start) goes at once and drops a seek still waiting, so a section always plays from its first frame.
- **ffmpeg.** Screenshots seek to `(N − 0.5) / fps` and take the next frame, which matches `select=eq(n,N)`. The
  render's colour information is applied, so the PNG matches what the player showed.
- **Playback copies** keep every frame's timestamp (`-fps_mode passthrough`). Screenshots and analysis always use the
  original bytes, never a copy.
- **WebKit** (Safari) sometimes ends the first seek after loading with the previous frame still on screen, although
  `currentTime` is right. The player notices through `requestVideoFrameCallback` and recovers once per frame: it rests
  on the frame next door for a moment and seeks back (seeking to the same frame, or chaining the two seeks, doesn't
  make WebKit show anything new). The "shown fN" badge appears only if that fails too.
- **Tests** compare what headless Chrome and WebKit show with what ffmpeg decodes (H.264 at 25 and 30 fps;
  `test/e2e/`), and screenshots at 23.976, 25 and 30 fps (`test/unit/shots.test.ts`). `test/e2e/webkit.mjs` runs
  Playwright's WebKit on an emulated iPhone: a finger on the timeline, a scrub, the step buttons and a `?f=` link.
  `requestVideoFrameCallback` runs once per rendering step of the page and reports the newest frame: on a busy main
  thread a frame can be on screen and gone between two steps, so a check that a frame was shown counts
  `presentedFrames` too (`startOf` in `test/e2e/range.mjs`).
  `npm run webkit:install` downloads WebKit into `cache/playwright` once; without it the suite fails, unless
  `LAMPO_E2E_SKIP_OK=1`.

## The UI

React 19, with TanStack Query for everything that comes from the server. Query keys follow the API's resources, and
live updates refresh exactly what changed. Across browser tabs only one holds the event stream (a Web Lock) and
passes events to the others over a BroadcastChannel, so tabs don't use up the browser's six connections per host.
Radix provides menus, dialogs, popovers and tooltips, unstyled and dressed in the project's own CSS; it loads after
the first paint ([Speed](#speed)). The timeline draws a still canvas and moves the playhead as a separate layer, so
playback doesn't redraw the strip.

### Speed

- **Local-first start.** What the screens showed (the library, recent reviews, the inbox, Insights) is kept in
  IndexedDB per account (`web/src/api/persist.ts`) and restored before the first render: the next visit shows what it
  showed last and checks for changes in the background (ETags make that mostly "not modified" answers). Signing out
  deletes it; review links never keep anything. Without kept data, the screen's data is asked for together with the
  sign-in status, not after it.
- **Optimistic writes.** A change updates the screen first and rolls back on an error (`api/mutations.ts`, and
  `status/api.ts`, which works out the new stage with `lib/stage.ts`).
- **Precise live updates.** Events name the video they are about. `api/live.ts` fetches after the first announcement
  at once, merges the repeats of the same write (the route, the data folder's watcher, the event feed), and updates
  single library entries (`GET /api/library?slug=…`) instead of fetching the whole list again.
- **A light start.** The first paint loads no Radix: buttons that open things are plain elements with their roles,
  names and states, and tooltips are notes on their element (`web/src/ui/primitives.tsx`, `ui/tip.tsx`,
  `ui/toggle.tsx`). The Radix half (`ui/layers.tsx`: dialogs, menus, popovers, hover cards, one tooltip layer, the
  toasts) loads right after the first paint, and a control mounts its part the first time it is used. `boot.tsx` waits
  for the screen's code before the first render, and screens read it through `lib/lazy.ts`: a lazy screen whose code
  is already there would still wait, because React holds content that replaces a fallback back for up to 300 ms.
  Library cards share one set of permissions and actions.
- **Windowed lists.** `lib/windowing.ts` renders only the rows near the view in libraries of more than 120 videos, and
  in notes lists and inbox groups of more than 120 (rows of different heights are measured and remembered), with
  spacers for the rest. A list that just appeared guesses its rows in its first render from the window's height and
  the last measured grid, and keeps the guess when it holds them. Cards fetch their video ahead on hover and focus
  (`api/prefetch.ts`).
- **A frame store for playback.** `player/frameStore.ts` holds the playing frame. Only the timecode, the playhead and
  the notes' "here" mark follow it; the rest of the player renders on seeks, pauses and edits.
- **The server's part** (`server/respond.ts`): compressed JSON with ETags and `Server-Timing`, and the built UI
  pre-compressed and cached for good. [server-mode.md](server-mode.md#speed-over-a-real-network) covers the proxy.
- **Measured, with budgets.** `bench/perf/` (a synthetic store of 1,000 videos: bundles, API, live updates, the
  browser with the CPU slowed down 4×) and `test/e2e/perf.mjs` (the budgets every run must hold).

### Phones and tablets

One stylesheet, `web/src/styles/mobile.css`, loaded last, holds everything that differs on small and touch screens.
Every rule in it sits inside a media query or styles something only small screens show (the drawer and its menu
button), so desktop layouts never change. The same queries are shared with the components through `usePhone` and
`useTouch` (`web/src/lib/media.ts`):

| Layout | Query | What changes |
|---|---|---|
| phone | narrower than 640 px, or a touch screen at most 480 px tall | the phone player, dialogs and menus as bottom sheets, 16 px text fields, 44 px tap areas |
| stacked | at most 820 px wide | the library's sidebar becomes a drawer (the menu button in the top bar); the player stacks |
| touch | `(hover: none) and (pointer: coarse)` | nothing hides behind hover (folder and card actions show), no keyboard hints |
| phone landscape | touch, at most 480 px tall, landscape | the picture gets the screen's height; the controls and notes follow when scrolled |

The phone player uses the desktop's playback code, so seeking stays frame-exact; only the controls differ. The
timecode and thumb-sized steps (−10, −1, play, +1, +10) sit above the timeline, a row under it holds in, out, loop,
speed and sound with the rest behind *More*, and the notes are a bottom sheet that peeks, covers half the screen or
most of it. While comparing, before and after lie on top of each other and a sideways swipe switches them. The
timeline takes a finger like a mouse, pinches to zoom and widens its markers under a finger. Links go to the phone's
share sheet where there is one.

On a desktop, the player's top bar has one main control, the stage and its next step (`StageControl`); the version
picker, compare, the agent button and Share sit quietly beside it. Compare (`CompareBar`, <kbd>B</kbd>) floats over the
top of the picture: side by side, a wipe, or B over A as a difference (what changed lights up) or an onion skin, and B
always follows A's frame. Notes are rows (`CommentCard` at rest: the timecode, the severity as a keyframe glyph, the
first line), with who wrote them and when said once above each person's sitting (`player/noteRows.ts`); the selected
note opens in place into its card, a thread: replies are messages, status changes one line each, and edits happen in
place. The notes' tags are filter chips with counts, and while playing the list follows the playhead. Auto-check is one
chip in the notes panel's head; its findings open in a popover (a sheet on a phone) and show as hollow diamonds on the
timeline. Each says what, where (a picture
of its frame; a click plays the stretch), why, and whether it looks intended, by the rules in `lib/findings.ts` that
`lib/qa.ts` judges by (a freeze is a problem only with a stall's marks — copies of one frame where the motion stops
dead or jumps ahead after it — and while the sound goes on; motion easing into a hold, or a pause with the sound, looks
intended); the freeze marks follow the same verdicts. Hovering the timeline shows the frame from the render's sprite. Review mode (<kbd>N</kbd>) steps
through the open notes on their frames. Check mode shows a fix preview (a still or clip made in the project) against
the render at its frame, and *Looks right* then checks the fix on the preview.

Two rules the layout checks enforce (`test/e2e/layout.mjs`, run by most browser suites at phone, tablet and desktop
sizes, next to "nothing scrolls sideways"): the grain overlay never sits on an element that scrolls (it would end
after the first screenful), and no heading loses the tops or tails of its letters to a clip.

## Security boundaries

- **Everywhere.** Routes match exactly as written (`router()` in `server/http.ts`: capital letters count, no trailing
  slash). A doubled slash, a dot segment or a trailing slash is a 404 before anything else (`canonicalPaths` in
  `server/guard.ts`), so the guard and the role table always judge the path the route will serve. The guard denies by
  default (`isPublicPath`), the role table runs for every signed-in request, and the same security headers go out
  (a Content-Security-Policy with the theme script's hash, `frame-ancestors 'none'`, `nosniff`; the one page another
  site may frame is an Embed link's player, `/e/<token>`: `frame-ancestors *` and no `X-Frame-Options`). Media, frames,
  posters, screenshots and API answers (`/api/`, `/media/`, `/data/`, review links' own included) carry
  `Cross-Origin-Resource-Policy: same-origin`, so no other site's page can load them as an image or a video — but for
  an Embed link's poster, its oEmbed thumbnail, which says `cross-origin` (as does a media host of its own,
  `LAMPO_MEDIA_ORIGIN`, which answers signed URLs and nothing else).
- **On your machine.** Only requests from the machine itself, with no proxy headers, are the owner without signing in.
  On Linux that is the app's own OS account (or root): the connecting socket's row in `/proc/net/tcp` names it
  (`peerUidFrom` in `server/auth.ts`). macOS and Windows can't tell accounts apart, so there every account on the
  machine is trusted, a limit [SECURITY.md](../SECURITY.md) states; a new store is made `0700`, and the start warns
  when the store's folder can be opened by other accounts (`openToOthers` in `lib/paths.ts`). A phone needs the link
  `npm run lan` prints (its token becomes an `HttpOnly` cookie), or an account. The Host and Origin headers are checked
  on every request, which stops DNS rebinding and other sites' forms. And since the machine itself is the owner by its
  address alone, a request another site makes the browser send (`Sec-Fetch-Site: cross-site`, or `same-site`: this host
  on another port) is refused with `403` unless anyone may ask it: the app's pages and files (so links into the app and
  the LAN link still open), sign-in, OAuth and review links. Agents, `lampo` and curl send no Fetch Metadata and aren't
  affected. Anything that names a path on the machine must come from the machine itself.
- **Review links** (`/g/<token>`) reach only their video or folder and the notes meant for their visitors,
  everywhere, and name videos by ids of their own; an Embed link's player (`/e/<token>`) reaches its one video and
  nothing else, no notes or names. They, the one-time upload addresses links give visitors for files, and oEmbed
  are the only things that answer through the optional Cloudflare tunnel.
- **Hosted** adds a required public URL, sign-in for everyone, ffmpeg held to the formats uploads may use, no access to
  the machine's files or sessions, and webhooks and push to public addresses only. See the
  [security model](server-mode.md#security-model) and [SECURITY.md](../SECURITY.md).
- **Workspaces** (hosted). Each team's files are a tree of their own (`data/w/<id>/`, `versions/w/<id>/`,
  `cache/w/<id>/`, `w/<id>/` in a bucket). Every request, job, timer and live update runs in its workspace
  (`lib/scope.ts`), and work that has lost it is refused once a server has a second workspace: it is never given the
  first workspace's store. In-memory caches are keyed per workspace, and an upload, a one-time upload URL or a
  connected app is reachable only in its own; another workspace's things answer `404`, never `403`.
  `test/unit/workspace-isolation.test.ts` walks every route to hold it. See
  [server-mode.md](server-mode.md#workspaces).
