# Roadmap

The brief for what comes next. Priorities can change; the reasoning is written down so anyone picking up a piece
knows why it matters. Done work moves to `CHANGELOG.md`.

## Now

**0.2.0 is out** (2026-10-08; CHANGELOG `[0.2.0]`). What it brought, and what each part leaves for next:
- **The agent experience, phase 1: "I can see it."** Every Send, Ask, nudge, answer or Try again opens one piece of
  work for the video's agent (a run), built from the calls it makes anyway: the run strip under the notes panel's head
  (fixing 3 of 6, rendering V4 · 42 % with the time left, needs you, done, failed, not heard from) and the Agent view
  behind it (the notes as its plan, what it is doing now, its steps, Tell it…, Stop); the plan on each note, the
  hourglass on the timeline, who made each version; the library's cards, the board and the sidebar in the same words.
  `lampo render -- <command>` shows a render's progress (Remotion, ffmpeg, aerender, Blender; `--detach` and
  `lampo render wait` for long ones) and puts the file up. The Inbox lists agents that failed, wait for a permission or
  went quiet, phones ping for them if wanted, and Stop reaches agents that listen at their next call. Phase 2 is next
  (below).
- **Close the loop.** "Use Lampo for <project>" is all an agent needs to hear: it finds or names the project, puts up
  V1 itself, works the notes and waits for the next ones until the person approves; one way per kind of agent (chat
  apps through MCP alone, coding agents rendering through `lampo render`); an agent shows in the sidebar and in
  Settings → Connect an agent the moment it connects; Connect an agent is one page per agent; empty pages and the first
  run lead with the agent.
- **Project files, phase 1.** The server (`/api/files…`, per House, project and folder, versioned, attributed,
  counted toward the plan, a trash of 30 days) and the app's Files tab (drops of files and folders with the check
  before upload, resumable uploads, conflicts kept, versions with Restore, previews, Copy for an agent). The agents'
  own tools and phase 2 are next (below).
- **The command is `lampo`**, with `lampo-mcp`, `LAMPO_*`, `lampo://` and the npm package name `@lampo-vr/lampo`; the
  older names keep working.
- **The last audit's backlog**, fixed; what it leaves for later is listed with the deferred findings at the end.

**A real deployment: running** (since 2026-10-03; open sign-up since 2026-10-06). The first hosted instance serves the
app behind a CDN proxy with video from a media host of its own (`LAMPO_MEDIA_ORIGIN`), mail from a verified sending
domain, nightly backups to a second place with a restore drilled, and the smoke test green; CI runs on GitHub's runners
in the public repository (outside contributors' workflows wait for approval). Still to do there: the OAuth connectors
in ChatGPT and Claude.ai for real, an uptime check from outside, the Linux screenshot baselines from CI's artifact
(then drop `LAMPO_BASELINE_MISSING`), perf budgets measured on CI's runners (then drop `LAMPO_PERF_TIMES`), a Parakeet
voice note and an Auto-check run measured on x86, `npm audit` of the pinned versions. Open: whether review links speak
the visitor's browser language (clients have no Settings, so today they always get English).

**Lampo Cloud: sign-up and billing, open** (2026-10-06). Open sign-up gives each person a workspace of their own on a
trial, then the plans, with payments live. In the open app (CHANGELOG): the extension point answers sign-ups and mails
a workspace's people for a module, Settings → Billing, the banner and the 402 sentences, and the in-app conversion:
the trial's line and card, the banner at its end, read-only's locked Add video, the moments of value, limit sheets that
pay in place, and the operator's first-party funnel. Left: a periodic check of seats against members; the module's
side of the conversion (`host.funnel` for `trial_end` and `plan_paid`, `features` on BillingInfo,
`POST /api/billing/storage`, the preview's `prorated`, a storage refusal's `room`).

**Workspaces, next.** Several teams on one server, each seeing only its own projects, are in (CHANGELOG): the model,
paths and migration, auth per workspace, everything scoped, the switcher and Settings → Workspace, the two-workspace
crawl, open sign-up into a workspace of one's own, the first run per workspace, deleting a workspace (its owner) and
taking one down (the operator), and leaving every workspace by deleting one's account. Next: leaving one workspace while
keeping the account (today an admin removes you), moving a person's videos between workspaces. Self-hosting stays free
and complete.

**Publish from Lampo** (phase 1 built, 2026-10-03; [docs/publishing.md](docs/publishing.md)). A gated step after
Final: one post per platform per final version, published by a person from the exact final file (or the platform's
encode of it); agents only draft (`draft_post`, `lampo post draft`, never "publish").
- Landed, tested against local fakes only (no real platform was called): drafts with each platform's limits and the
  required answers (made for kids, realistic AI content); Settings → Publishing per workspace — YouTube with your own
  Google OAuth client (resumable upload, `publishAt`, the cover; the private lock of an unaudited project said where
  it matters), Instagram and Facebook through Zernio with your own key; the publish queue (retries, pausing when the
  final moves, resuming an upload); the publish kit; status on the video, failed posts in the inbox, `post` events,
  `get_posts` / `lampo post`.
- Next in the open app: the one-day test of Zernio (and Upload-Post) with a real master — field names, the cover, the
  AI flag, numbers — then a second posting-API adapter; letting the provider hold a schedule (so a sleeping laptop
  still posts) with cancel-on-reopen against it; YouTube captions from the transcript (`captions.insert`, the
  `youtube.force-ssl` scope) and taking back a YouTube schedule (the `youtube` scope); a client approving the post on a
  review link; the AI answer pre-filled from the version's provenance; the numbers back (YouTube's retention curve on
  the video's frames).
- Later, Lampo Cloud: direct adapters under Lampo's own reviewed apps (Meta Graph for Instagram and Facebook, TikTok,
  LinkedIn, X, and YouTube under one audited project), a token vault, an always-on scheduler with a quota manager
  (YouTube: 100 uploads a day per project) and a relay so a closed laptop still publishes on time. TikTok, LinkedIn
  and X direct come with it; meanwhile they go through the posting API.
- Start now (the checklist in docs/publishing.md): Google OAuth verification and the YouTube API audit; Meta Business
  Verification, Tech Provider, App Review for Advanced Access (`instagram_business_content_publish` /
  `instagram_content_publish`, `pages_manage_posts`); TikTok app review and the Direct Post audit — each needs a live
  domain, privacy policy and terms URLs, demo videos and a test account.

## Next

- **The agent experience, phase 2: "It comes by itself."** Today an agent hears notes only while it listens (an open
  session in `wait_for_feedback` or `lampo watch`), and only Claude Code on the person's own machine can be started by
  Lampo. Next:
  - **the local runner**: `lampo connect` sets a computer up once — signs it in, finds the agents installed, binds the
    folders that hold projects to Lampo projects (the paths stay on that computer), offers the plugin, prints the
    permission lines to add (it never writes a client's settings) and proves it with a practice note — and
    `lampo runner` keeps a small process there that claims the work people send and starts the agent for it (Claude
    Code, then Codex), with a token per computer that the app revokes; the local app's own start of an agent becomes
    this runner;
  - **publishing `@lampo-vr/lampo` to npm**: a thin CLI for other machines (`lampo`, `lampo render`, `lampo connect`,
    `lampo runner`), without the speech engine or ffmpeg, with provenance;
  - **the plugin**: the loop, `watch`, the setup and `lampo render` as skills, for Claude Code and other clients that
    load plugins;
  - **Settings → Agents** in place of Connect an agent: the computers with their runners, the agents connected, and
    connecting a new one.

- **The agents' file tools.** MCP `list_files`, `get_file` and `add_file`, and `lampo files push` / `lampo files pull`
  (with `ls` and `status`), so an agent works from the same footage, fonts and project files as the team on any machine
  and saves its project back as a version of its own. The app's *Copy for an agent* already hands out the
  `lampo files pull` line for the files picked; the instructions agents read gain one line on where the files are.

- **Project files, phase 2**: the **Handover link**, a fourth kind of link (a project's videos and files with a
  generated `HANDOVER.md`, for whoever takes the project over), and **editing leases** (who has a project file open,
  shown and ending by themselves; a push against one is kept beside it as a copy, never refused, never overwriting);
  then proxies of the footage and what a final version was made from. In the app meanwhile: a folder downloaded as one
  zip, *Delete for good* in the trash for owners and admins, posters for pictures and video in the rows.

- **A click inside a menu never reaches what is behind it.** A menu opens in a layer of its own (a portal), and a click
  on one of its items can still bubble to the clickable row or card it was opened from: on a narrow screen a menu that
  opens over its own button could open the row too. The Files tab guards its rows (`onRowItself`); the general fix
  belongs in the menu layer itself, so the library's cards and rows and the inbox's rows are covered too.

- **An explicit `LAMPO_DATA` wins over a saved login.** After `lampo login`, every `lampo` command talks to that server
  even when `LAMPO_DATA` names a store on this machine (only `LAMPO_REMOTE=0` keeps it local). A store named on purpose
  should win, or at least `lampo` should say which one it uses.

- **Audit ids out of code comments.** Comments explain why, in words; the ids of findings stay in AUDITS.md and the
  reports.

- First run, next: a short guided pass through the sample in the player (point at the fix to check, then the agent's
  question) for people who open it and don't know where to look; the agent step showing the client the person picked
  in Connect an agent while it waits; measuring where people stop (the steps' times are on the account:
  `prefs.onboarding.done`).

- **Footage search for B-roll**, next steps (step 1 is built: `docs/footage.md` — the index of every video's newest
  version in the background, `lampo footage find|sheet|status|on|off|index`, `find_footage`, the API, per workspace, the
  model downloaded on first use; research: `bench/footage/RESULTS.md`, reproduced by `bench/footage/app-eval.ts`).
  2. **A Footage view** (search with the filters it read as chips, shot cards with hover-scrub, the shot player with
     in and out marked) and *Offer to the agent* through options to audition; a `footage` SSE event already fires.
  3. **"More like this"** (`find_footage({like: "s412"})`: the shot's own vectors, no new model) and a separate
     `footage_sheet` if agents want sheets of chosen shots more than of a list.
  4. **On a server**: keyframes from the analysis decode (one decode instead of two), a small ONNX OCR instead of
     tesseract (also lifts Auto-check's caption checks), a quota hook for footage hours, sqlite-vec for a workspace
     that outgrows a scan in memory; a per-file opt-in for transcripts of footage.
  5. Later: audio tags per shot, subject motion, near-duplicate grouping. Open: a multilingual model for German
     search; a separate *Footage* library (files that aren't videos under review).

- **Render progress, next** (done: `lampo render -- <cmd>` with Remotion, ffmpeg, aerender and Blender, `--detach` and
  `lampo render wait`, the progress in the player's agent line and on the library's cards; CHANGELOG): DaVinci Resolve
  (`GetRenderJobStatus`) and Remotion Lambda (`getRenderProgress`); an image sequence counted by its frames rather
  than its size; `lampo render stop <id>` for a detached render (today its supervisor stops on SIGTERM).

- Options before a render, next (done: an agent asks, the person auditions and picks, the answer is one PICKED line;
  CHANGELOG): **options through a review link** — a client picks the narrator or the look on the link (a question
  shown to the link's visitors, its files under the link's rules like `guestRef`, the answer as the client's); **votes
  by several people** — each picks, the agent hears the tally (`voice=v3 (3) v1 (1)`) and who still has to, one answer
  when the asker says it's decided; comparing clips with their sound levelled through Web Audio as sounds are (today
  their volume only lowers); an agent replacing one item's file after asking (today: ask again).

- Drafts, next: **Save and Send on review links.** Clients still send each note at once (the guest composer and
  `POST /api/g/:token/comments` are unchanged). Their drafts would be kept per link and visitor key (`visitorKey`),
  beside the review like a person's (`lib/drafts.ts`), and sent the same way, one batch.
- Partial renders, next (done: opt-in quick checks of whole shots, CHANGELOG): a part that changes its length
  (rippling what follows instead of refusing it); a part's own download on review links (today "original" is the
  stretch as sent, the preview the whole video); comparing a part's sound with the full render too (only the picture
  is compared now); suggesting the next shot when a seam jumps, in one click.

- Recorded feedback, next: recording on review links (clients talking over a video; the guest API and the client
  composer first); **retiming by feel** (tap where a hit should land while recording, or drag a moment on the timeline:
  a `RETIME F212 → F200` note agents can't misread); a stroke's own time on drafts (today a drawing goes to the
  nearest thing said); the agent reading a recording's plan back before it renders.

- Inbox clean-up, next: a swipe on a phone row (left: Later, right: Done or Got it) beside today's ⋯; more than one
  "Later" (this evening, next week, when the next version lands).

- Playbooks, next: **specs that drive Auto-check** — the rules' measurable parts (loudness, duration, aspect, safe
  zones, logo size) as typed checks in the playbook that the pre-review runs on every render and names by rule;
  moments of **clips** as references (today: pictures, links and single frames); evidence on a suggestion as links to
  its notes (today: a count, their ids in its tooltip); a playbook for a single video, if folders turn out too coarse;
  in the document, a rule edited in its own line (today: added and taken out one at a time, changed through Edit) and
  a skill's instructions written in place rather than in a dialog.
- Editor round trip, part 2: a panel for After Effects / Premiere Pro (notes as markers, jump to a note's frame, send a
  fix preview with one click) on top of the fix previews agents already use.
- Export notes as editor markers: Premiere Pro XML, DaVinci Resolve EDL/CSV, Final Cut FCPXML.
- Transcripts, next: the Transcript tab on review links (the guest API is there: `GET /api/g/:token/review/:id/
  transcript`, links that take notes only; guests can already send `text_edit`); Auto-check comparing burned-in
  captions (OCR) with what is said; the transcript's words on the timeline's words lane when a project has no
  words.json; a language picked per video when the engine's detection gets it wrong. Over a music intro Whisper still
  pulls the first line back to 0.00 (words spread from the start of the music, seconds early): `lateStart` on every
  first pass fixed that on the synthetic set but cost one clip (bench/stt/RESULTS.md), so a targeted re-run of a
  window's first line is the next step; the transcript foot could say which stretch was heard again (`repairs`);
  recorded feedback could use the collapse repair too (it has the filter only).
- Starting agents that aren't running, next: other agent kinds (Codex, Gemini CLI, …) through a command template the
  person writes once per kind in Settings (`codex exec --cd {cwd} "{prompt}"`), still an argument list and still only
  from the machine.
- Agents that listen, next: an agent connected over MCP still has to be started by hand (`/lampo:watch`). Claude Code's
  *Channels* (research preview: a server declares `claude/channel` and pushes a message the open session acts on)
  could deliver a note to an idle session; today it needs a stdio server started with a development flag (or an
  allow-listed plugin) and isn't carried over a 2026-07-28 HTTP connection, so a `lampo` plugin with a channel for the
  stdio server is the candidate. Parked for now: the runner (phase 2, above) brings an agent by itself without it. Also:
  long waits behind a proxy for clients that send no progress token (a JSON answer
  only after the wait; Cloudflare gives up after 100 s): keep-alive bytes or a shorter cap for them.
- Live agent monitor, next: **opt-in reading of Claude Code sessions Lampo didn't start** (their transcripts under
  `~/.claude/projects/`) for the same live view of an agent working in a terminal — its steps and the tokens it
  reports — which needs a privacy decision first (it reads a person's whole conversation with the agent; off by
  default, per session, never on a hosted server). Until then the view is built only from calls to Lampo, uploads,
  renders on disk and runs Lampo started.
- Email notifications of review activity and a daily digest, on the mailer accounts use now (`lib/mail/`, done:
  invites, resets, confirmations, notices); clients rarely install a web app. With them: an unsubscribe link and
  per-person choices.
- Accounts and email, next: a revert link in the "your address was changed" notice (today it says whom to tell);
  bounces and complaints from the relay (Brevo webhooks) marking an address as undeliverable; a one-time code beside
  the confirm link for people who read mail on another device.
- Fix previews on review links, if clients should verify on them too.
- Review link tracking, next: the watched strip over the player's own timeline (which parts the client skipped), and
  "watched" in webhooks and the MCP inbox, so an agent knows the client saw the fix. Kept out for now: anything finer
  than hundredths, or anything about the visitor beyond the name they typed.
- Settings that change things from the UI (speech model and languages, Auto-check dictionary), not only show them.
- Hard CPU/memory limits per ffmpeg process on hosted instances; the full Unicode confusables table for names.
- Real-credential tests for Bunny and S3; Parakeet timings on x86 servers.
- Speed, what is left (bench/perf/): the warm library paint's 300 ms goal at CPU 4× — it is ~0.4 s on the suites'
  chrome-headless-shell (budget 450 ms), of which ~80 ms compile the start again on every load and ~200 ms are the
  first render and layout of the page (sidebar, toolbar, the cards in view); less DOM on the first paint (the sidebar's
  tree, the library chunk: the add dialog could load with its view, as Insights, the inbox view and the board now do) is next;
  posters and sprites through the CDN with signed URLs in the library's answer (hosted); the player's first paint (it
  brings the Radix it uses along). Done: a light start (Radix after the first paint, 167 → 124 KB), cards without
  menus or tooltips of their own, windows that render their rows in the first pass, windowed notes and inbox lists.

- Tokens, what is left (bench/tokens/): `add_note` is still a sixth of the tool list (positions, ranges, drawings,
  choices); the MCP App tools only for hosts that announce the UI extension; `lampo mcp config --lean`; a check of the
  heuristic against a real tokenizer (it overcounts JSON); `since` for `lampo open`.
- MCP over HTTP: 2025-era clients are told resource subscriptions work, but the stateless `/mcp` route can't deliver
  them (`resources/subscribe` answers "Method not found"); 2026-07-28 clients get them through `subscriptions/listen`.
  Either stop advertising `subscribe` to 2025 clients there or keep a session for them.
- Push skips your own actions by display name (`eligible` in `server/context.ts`): events record `by`, not the
  account, so on a team where two people share a name one isn't told about the other's notes. Record `by_id` on events
  (optional, like `Comment.author_id`) and compare that.

## Later

- **Embeds, next** (an Embed link plays one video on any site: docs/sharing.md, "Embedding a video"): a list of the
  sites a link may be framed by (its own `frame-ancestors` instead of `*`); chapters set in the app for a render that
  has no markers of its own; a folder's embed as a playlist; a poster sharper than the 640 px one for a page's large
  hero before it plays (it rests on the decoded poster frame meanwhile).
- **Generation that lands in the review.** Not one more model hub, but generation whose result goes where the review
  is (a reference on a note, a fix preview, the next version) with its cost, approval, model, prompt and provenance
  recorded.
  - First: record provenance for files agents make elsewhere.
  - Then: keys brought by the user in the open app. A provider interface, MCP `generate`, `wait_for_generation` and
    `list_models`, an approval threshold and a cost ledger; models as data (the catalogue changes monthly).
  - Generated media is marked (a C2PA manifest, providers' own marks kept).
- **Render on the server** (hosted). The agent sends the bundled project (`npx remotion bundle`) and its props; the
  server renders it and it lands as the next version without an upload. Before it is built: one sandbox per render
  (the bundle is the customer's code; network only for its assets), and how assets (fonts, clips) travel with it.
- Live presence: who else is watching, and their playheads.
- **Cold storage for archived projects.** An archived project's versions still count toward the plan's storage (and
  its videos under review toward the plan's count) as they did: move its renders to a cheaper bucket class (or a
  bundle the workspace keeps) while it is archived, back when it is restored, and say so in Settings → Billing.
- **Voice notes on replies.** "Still wrong" can be said now, but only its words are kept (replies have no `voice`):
  keep the clip as the reply's voice note (`Reply.voice`, the agent formats naming it like a note's), and give review
  links' guest notes and their "still not right" the same voice button.
- Translations beyond German.
- Plugin points for storage adapters, speech engines and pre-review checks.

## Deferred from A12

Findings of audit A12 (2026-10-02, `AUDITS.md`) that are known and left for later; each keeps its id until it is done.

- **A12 first-sweep lows** (the audit's ids; picked up as a stream when someone has room):
  - Review links: info: **GUEST-13's rest** — on a hosted server with Bunny or S3, a link's media answers with a
    redirect to a signed storage URL whose object key holds the workspace's id and the upload slug (folder and file
    names). The redirect stays (GUEST-11: bytes from the CDN, not through the server); hiding the key needs opaque
    storage keys, a migration of every stored render.
  - Web: info: **WEB-9's rest** — Trusted Types. React DOM 19.3's production build has no Trusted Types integration
    and writes SVG markup (the drawing overlay) by string concatenation, so `require-trusted-types-for 'script'` would
    break drawn notes; waits for React's integration.
  - Publishing: info: **PUB-16's rest** — pin the posting API's presigned upload to its storage hosts once the one-day
    test names them (any public https host today; the key never goes there).
  - Invariants: info: **INV-12** duplicated helpers,
    **INV-13** 16 dead exports, **INV-14** long functions and `as unknown as`, **INV-15** mixed API naming, **INV-16**
    strictness flags still off.

## Deferred from A13

Findings of audit A13 (2026-10-05, `AUDITS.md`) and its verification rounds that are known and left for later.

- **A13 FILES-6** (low): a project file's older versions are capped per file, not per area, so an area of thousands of
  files that each keep their versions holds a large catalog that every change reads and writes whole. Give each area a
  budget of versions (the oldest unpinned go first), or split a big catalog by top-level path.
- **A13 FILES-10** (low): past the safety net's cap, trashing a project file frees only the cap's worth for a day (the
  rest counts until it may go). Add "delete for good" from the trash for owners and admins (`remove`, a person only,
  with the erasure log).
- **A13 FILES-11** (low): the restore and commit plan checks don't count uploads under way, and run in a queue apart
  from the upload routes' one; count `declaredIn` there too and share one queue per workspace.
- **A13 FILES-12** (low): until the workspace's plan size was asked once since the start (`rememberPlan`), usage leaves
  the safety net's excess out (a render upload in that window gets its room), and a plan change is seen up to an hour
  late; ask every workspace's plan at start and when the module says it changed.

- **A13 VERIFY-4b** (low): while one address's reset or confirmation waits in the mail queue, another person asking
  from the same address (one office network) gets theirs only on a later try. Key the one-at-a-time rule by recipient
  too (`askerWaits` in `lib/mail/index.ts`).
- **A13 RENDER-1, the rest** (low): a failed render's last lines still keep a password said in prose ("password
  hunter2"), and the rule for a bare AWS secret key also takes a relative path of exactly 40 characters that has digits,
  both cases and a "/" (it says less, never more). Prose needs a different approach than shapes; the path is a cosmetic
  loss.
- **A13 RENDER-1f** (info): the redaction rules for a secret's name (`token=`, `…_KEY=`, `…_PASS=`) take time that
  grows with the square of a long run of short words joined by "-", "." or "_" (`a-ua-u…`: about 1 s at 16,000
  characters). What reaches them is cut first (2,000 characters a line on the agent's machine, 300 on the server: about
  15 ms and under 1 ms), so it costs nothing today. Make their leading group read each word once (an atomic group
  through a lookahead and a backreference). The MySQL rule is linear, measured by doubling adversarial and random lines.
- **A13 RENDER-1g** (low): a failed render's last lines still keep a MySQL client's password in three shapes the rule
  doesn't read yet: a JSON argument list written without spaces, the client run in a backquoted subcommand, and a
  command continued on the next line with a backslash.
- **A13 RUNS-FIT-2c** (info): a run the queued bound stops tells whoever sent it nothing (it ends `stopped`, credited to
  the person whose new run made room), and a store from before the bound stops its surplus all at once on the next
  send, with as many stop events in that person's name. Tell the sender (a step on the run, or the Inbox) and credit
  the bound itself.
- **A13 RUNS-FIT-2d** (low): the account's bound on open runs (`roomToBegin`) counts queued runs too, so an account
  with many runs waiting to be picked up (sends, Try again) can leave none of them able to begin. Count only the runs
  that began.
- **A13 RUNS-FIT-4** (info): the first write of a runs file that holds thousands of open runs with steps takes a while
  (seconds at 20,000), as each pass of `fitRuns` sorts every run again; only a file written before the bounds gets
  there, never the API. Sort each kind once and walk it (or a heap for the longest open run).
- **A13 RUN-2, look-alikes** (info): an account's name may hold a character that looks like "·" but isn't one of the
  six refused (`checkName`); it can't pass for another's agent (runs go by account id), it only reads alike.
- **A13 VERIFY-5** (low): pending OAuth sign-ins are kept in a bounded store that makes room by dropping the oldest;
  when it is full it should refuse new ones (or bound them per network) instead.
- **A13 VERIFY-6** (info): a version diff cut short by its time limit is cached as if it were complete; mark it partial
  so a later run finishes it.
- **A13 VERIFY-7** (info): a few request-time ffmpeg runs (voice-note transcription, recording clips, the publishing
  cover) don't go through the on-demand gate yet, and footage jobs have no crash-guard key.
- **A13 DL** (low): files streamed by `streamFile` (server/playback.ts) ignore `If-Range`.
- **A13 EMBED** (info): an embed's media and poster `Last-Modified` equals the version's registration time.
- **A13 NAME** (low): a store from before well-formed names reads `shares.json`, `asks.json` and `playbooks/*.json` as
  they are, so a link or playbook of a folder or video whose name holds half a character breaks after the upgrade.
  Read those files well-formed too.
- **A13 KIT** (low): `kitBase` (lib/publish/kit.ts) cuts a kit file name at 80 UTF-16 units, which can split a
  character; cut with `cutChars`.
- **A13 HEAD** (low): a HEAD on a review link's version download counts as a download (event, stats); return before
  counting.
- **A13 SSE** (info): SSE writes don't wait for the connection to drain (team members only, bounded per person).
- **A13 TEST** (info): the export HEAD test checks the bytes sent, not the files read, so it can't catch a HEAD that
  reads the file.
- **A13 WEB-1's rest** (low): a browser whose session ended stops its notifications the next time it opens the app;
  until then the server still sends to it. Binding a device to its session needs a way back for people who stay signed
  in (a new session after 30 days would silence them): keep the session's end with the device and refresh it when the
  app asks for its push state or signs in with notifications allowed.
- **A13 AGENT-3's rest** (low): over a remote backend, a wait without a cursor starts from the agent machine's clock;
  one running ahead skips notes. Take "now" from the server (its events answer's time).
- **A13 AUTH-3's rest** (low): confirmation mails sent for invite accepts are charged to no workspace's mail share.
  Charge them to the invite's workspace and count accepts per invite too.
- **A13 LINK-6** (info): a link's views are named by the visitor's address, so two visitors behind one address share a
  name. Key names by the visitor's own key, or record views without one.
- **A13 LINK-7** (info): a review link's media URLs carry part of the render's key. Neutral names with a keyed hash for
  the cache instead.
- **A13 INV-6** (info, tests): some unit files build their own server instead of `startApp()`, and some browser suites
  wait a time instead of a state. Move them over and let the test-files check flag a new one.
- **A13 LINK-8** (info, tests): the review-link privacy crawl doesn't reach the media host's routes, compare and a few
  older routes. Extend it, hosted with a media origin.
- **A13 WS-4** (info, tests): the workspace isolation walk doesn't cover the moments, the funnel and sprites. Run it with
  a stand-in billing module and seed those in both workspaces.
- **A13 AGENT-3, across videos** (low): a cursor reused for another video, or for all of them, skips notes on other
  videos that landed during the wait. An append-only cursor that carries the other videos' positions.
- **A13 AGENT-2's rest** (low): an MCP agent's id is 48 bits of an unkeyed SHA-1. Key it with a server secret (HMAC) or
  lengthen it, and keep an `mcp-` key's account past its TTL.
- **A13 INV-1** (info): on the machine, `lampo post list --json` gives its owner the sentence, not the detail.
- **A13 FILES, infos** (info): a ticket for a non-copy upload on a stale base gets 429 ("24 h") instead of 409 before
  any byte moves; a revert's 429 suggests `conflict: 'copy'`, which a restore ignores.

## Open decisions

- 1.0 criteria: the data format frozen, server mode audited, CI green on GitHub.
- Distribution: a registry container image beside the CLI / MCP package, so agents and servers on other machines don't
  need a clone (the package, `@lampo-vr/lampo` on npm, is phase 2 of the agent experience above).
- Accounts scoped to folders (clients with their own logins) or share links only. (Importing an existing local store
  into a hosted instance: `lampo export` / `lampo admin import`, docs/moving.md. Not in a bundle yet: questions asked on a
  folder before any video (`asks.json`), and notes made on a video after it moved, which a later export can't merge.)

## Decided

- **The name is Lampo** (2026-09-29), with the logo "out of the o, a frame" (`docs/brand/`). Agents connect to the
  MCP server as `lampo` since 2026-10-02 (setups under `video-review` keep working: the key never reaches the server).
  The repository is `lampo` (github.com/lampo-vr/lampo) since its first public release. **The command is `lampo`**
  (2026-10-07), with `lampo-mcp`, `LAMPO_*` settings, `lampo://` resources and the npm package `@lampo-vr/lampo`
  (plain `lampo` is someone else's on npm; nothing is published yet). `vr`, `vr-mcp`, `VR_*` and `vr://` keep working
  for setups made with them. The MCP tool names, data paths and file formats keep their names.
- **The demo footage's terms** (2026-10-05). Lampo's own demo footage (AI-generated, Higgsfield, Seedance 2.0) is ours
  to publish, in the repository and an AGPL release: the brand film, the setup's stills, the sample and the website's
  clips.
