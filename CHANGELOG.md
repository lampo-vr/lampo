# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, minor versions may change behaviour; the data
format stays backwards compatible throughout.

## [Unreleased]

### Added
- **An agent's work on a video is kept, from start to end.** When you send notes to the video's agent (Send, Ask,
  a nudge, your answer to its question, Try again), Lampo keeps what it does with them as one piece of work: the notes
  you sent as its plan (which it is on, which it fixed, asked about or left), what it is doing now, how long it worked
  (not counting the time it waited for you), whether it needs you, and the version it handed back. It costs the agent
  nothing: it comes from the calls it makes anyway. A version an agent made says so, notes you send while it works
  join the same work (the agent hears of them with its next answer), and an agent that goes quiet shows as not heard
  from instead of quietly reading as idle. Only team members who may work with agents start one; reviewers' notes and
  review links never do. For tools: `GET /api/runs?slug=`, `GET /api/runs/:id`, each video's `run` in the library,
  the live event `run`, and `AGENT RUN …` lines in `vr watch --all` (docs/api.md, docs/agents.md).
- **See what your agent is doing, while it does it.** Wherever a video has an agent, one line under the notes panel's
  head (above the controls on a phone) says what is happening: "Claude Code · fixing 3 of 6 · editing Logo.tsx",
  "rendering V4 · 42 % · about 1 min left" with a thin edge that fills, "needs you · a question" with **Answer**,
  "V4 is ready · 5 fixed · 1 asked · 12 min" with **Check fixes**, a failure in its own words with Log and Try again,
  "No word from Claude Code for 22 min" with Nudge. It keeps its place in every state, so nothing on the page moves.
  Pressing it opens the new **Agent** view beside Notes and Transcript: your notes as the plan (next, on it, fixed,
  asked you), what it is doing now with what it said to you, quoted, the steps it took, how it ended and what came
  before, and *Tell it…* to send it a few words. Stop is at once. Reviewers see all of it, without the controls.
- **When an agent needs you, the Inbox says so, and so does your phone.** Right after agents' questions, the Inbox
  now lists work that failed — in its own words, with the last lines the tool printed and **Try again** — and work that
  waits for a permission it doesn't have, with the exact rule to add to the agent's settings, **Copy** and **Send
  again** (Lampo never allows anything itself). An agent you haven't heard from in a while, or notes sent and never
  picked up, appear under Stalled with **Nudge** and **Stop**. None of it needs a "Got it": a failure leaves once you
  opened it or tried again, a permission once the agent goes on or is stopped. In the player, "How to allow it" opens
  the same rule. Only team members who may work with agents see these. Notifications gain **Agents that stop or wait**
  (on): "Claude Code stopped — the render of promo.mp4 failed", "Claude Code is waiting for your OK to render
  promo.mp4"; and **Agents gone quiet** (off until you turn it on), after 30 minutes without a word. Starting,
  rendering and progress never ping you, and the app's badge counts what needs you.
- **Stop reaches agents that listen.** When you stop an agent that works through Lampo's tools, its next call to Lampo
  tells it to stop, once — "The person stopped this work on promo.mp4: stop now, render nothing, mark nothing, and
  say you stopped." — and until then the line says "Stopped · it will notice at its next step". An agent Lampo started
  on your machine is asked to finish its turn first (as Ctrl-C would), then stopped for good if it doesn't.
- **Your notes say where the agent is with them**: a quiet line under each note it was sent — "on it", "fixed · in
  V4", "asked you" — and the timeline shows the note in hand as an hourglass.
- **Who made each version**: the version picker says "Claude Code · 12 min · 5 fixed · 1 asked", from which of your
  notes, and *Steps* opens what it did; a version still rendering shows there as "V4 · rendering 42 %" until it lands.
- **Archive a project.** A project that is done can be put away from its ⋯ menu (owners and admins), with Undo: it
  leaves the sidebar, All videos, the board, Recent, the Inbox and Insights' lists of what waits now, and the
  sidebar's *Archived* row (with how many) opens the archived projects; ⌘K finds them under *Archived*. Opened, an
  archived project and its videos say *Archived · Restore* where Share or the next step stands, and are read only:
  you watch, read and download, but nothing new goes in — no version, note, reply, sign-off, playbook change, post,
  move into it or review link — until it is restored, in one click and as it was. Owners and admins can still take a
  video out, in the app. Its review links play watch only meanwhile and take notes and decisions again once it is
  back; embeds keep playing. Agents get one sentence for any write into it, and `list_videos`, `list_folders`, `vr ls`
  and `vr folders` leave it out unless asked (`archived`). Storage counts as before.
- **Suggestions waiting in a playbook further down are no longer out of sight.** A project's playbook (and the House's)
  says when agents' suggestions wait in its folders — "Reels · 5 suggestions waiting" — and one click opens that
  playbook on them; the folder's Playbook tab counts them too.
- **Download a video from its ⋯ menu**, in the player and on its card in the library: *Download V3* saves the version
  on screen (on a card, the newest) as it was rendered, named `spot V3.mp4`, and *Download another version* lists the
  others. A version in a codec browsers can't play downloads as itself, not as the copy the player shows. Members,
  admins and owners may download, as for whole folders; reviewers watch and leave notes.
- **Embed a video on your own site.** A new kind of link, *Embed*: Share → Embed copies the code for one `<iframe>`
  that keeps the video's shape, and the video plays on any site in Lampo's own frame-exact player — the timecode with
  frames, frame steps and the player's keys, the render's chapters on its timeline, captions from its transcript, full
  screen, and options to start muted, loop or show the picture alone. It shows the video and nothing else, counts its
  plays without anyone's name, sets no cookie, and stops wherever it is the moment the link is revoked or expires.
  Sites that embed from an address find it through oEmbed (on your own machine through its public tunnel too), with
  the poster as a thumbnail they may show. A link is an embed from when it is made: an existing link doesn't become
  one, nor an embed another kind of link.
- **See a render's progress while an agent renders.** An agent that renders through
  `vr render --to <video> --out <file> -- <its render command>` shows the person how far it is, as it goes: the stage
  (bundling, rendering, encoding, uploading, checking), the percent and frames, and the time left once it can be
  estimated honestly. Remotion, ffmpeg, After Effects (aerender) and Blender are read; any other command by its output
  growing. When it is done, the file becomes the next version, and the agent reads two lines instead of the render's
  output. A failed render reaches Lampo with the tool's last words, anything that looks like a secret taken out. Long
  renders run detached (`--detach`, then `vr render wait`), so an agent's shell time limit doesn't end them. The
  command runs on the agent's own machine, never on a server ([docs/agents.md](docs/agents.md)).

### Fixed
- Checking a video or a download without fetching it (what browsers and download managers ask before they start) no
  longer makes the server read the whole file first: the player, downloads, review links, embeds, the publishing kit
  and your data export answer with the details alone.
- A publishing kit's ZIP or your data export cut short (a closed tab, a lost connection) now ends on the server too:
  before, it went on waiting for the viewer for good, with the kit's files kept open.
- Video playback, downloads and review-link files that were cut short (a seek, a closed tab) no longer leave the file
  open on the server; and a version's file says when it was made, so a browser can resume a download.
- A video whose file name held a broken character no longer breaks the library for the whole workspace: names are made
  well-formed when they come in.
- The same holds for folders: a folder name with a broken character, or a long one cut in the middle of an emoji, no
  longer breaks the inbox, search, *For you* and the library. Everything people and agents send in — folder and link
  names, display names, notes — comes in well-formed, names are shortened between characters, never through one, and
  a store that already holds such a name reads it whole.
- The skill dialog's instructions field was one line high until you typed.
- A playbook opened on its suggestions (the inbox's *Open the playbook*) put the focus on Reject, so Enter opened the
  reject form instead of accepting: Accept has it now, on the suggestion the inbox showed.
- A suggestion for a skill no longer ends its diff with an empty line taken out.
- A download that breaks off and picks up again — a video from the library, or a file from a Delivery link — now gets
  the whole rest of the file, not just the next piece of it.
- An account deleted, disabled or given a new password while someone signs in to it gets no session and sends no
  sign-in email: the answer is the same as for any wrong sign-in. The same holds while someone takes an invite with
  it: it joins no workspace, and nobody is signed in.
- Save and Send in the note composer stay where they are when the video's agent is assigned, starts waiting or is
  unassigned while you write: only which of the two is the main action changes, so a click meant for Save never lands
  on Send.
- On a phone, a long note keeps the line you are typing above the pinned Save and Send, and that bar sits flush with
  the bottom of the notes sheet instead of letting the note show beneath it.
- Auto-check works again on videos longer than about 50 seconds with current FFmpeg releases (5.1.9, 7.1.4, 8.0.2
  and later), which refused how it picked the frames to read; it still reads exactly the same frames.
- When Auto-check can't read a version, the player and the inbox say so, with Run again, instead of "Checking…" for
  good, and it is no longer started again every time someone opens the video.

### Changed
- **Telling an agent something while it works joins what it is doing**: your words become part of that work, beside
  the notes it is working through, instead of starting something new. It hears them as before.
- A Claude Code run Lampo starts on your machine now stops after 30 minutes without a sign of the agent (its output,
  or a call to Lampo), and after 3 hours at most, instead of after 30 minutes whatever it was doing: a long render
  no longer cuts it off.
- **The library says what agents are doing in one line.** A card on the board, in the grid or in the list says the
  agent's work in the same words as the player — rendering with its percentage and a thin edge along the poster's foot,
  failed, needs you with **Answer** where the next step stands — instead of the status chip with its spinner; the
  sidebar's agents say where they stand in a word or two, and *Being fixed* counts the agents at work.
- **Several suggestions for the same part of a playbook** (the brief, the rules, one skill) stand together, the newest
  first and marked, with a line that says how they relate. Once one is accepted, or someone changed that part by hand,
  the others say so straight away and their diff shows what accepting them now would replace; *Accept anyway* does it
  on purpose, where before they could only be rejected. The inbox's preview says the same.
- **The skill dialog is a place to write.** The instructions start twelve lines high and grow with the text until the
  dialog is full, then scroll inside while the name, the files and the actions stay put; Write and Preview are one box,
  so switching moves nothing; on a phone the dialog takes the whole screen. Import and Copy sit together under
  *SKILL.md*. An open brief or rules editor starts with room for a paragraph.

## [0.1.0] - 2026-10-06

The first public release: what it has first, then everything that changed while it was made, newest first.

### Added
- **Frame-exact review.** The frame the player shows is the frame ffmpeg decodes (tested in Chrome and in Safari's
  engine, H.264 and ProRes, 23.976–60 fps); any codec plays through a proxy with the same frame numbers, long renders
  scrub at once, and safe-zone overlays and a real-size phone view come with it.
- **Notes on a frame, a section or the whole video**: box, arrow and freehand drawings in video pixels, tags,
  severities (must, should, nice, idea) and kinds (feedback, question, info), threads with replies, references
  (pictures, clips, links, moments of any version), and a clean and a marked screenshot of the exact frame. A section
  is one drag on the timeline, or I and O while playing; the timeline zooms down to single frames. Save keeps a note
  as a draft only you see; Send sends the video's drafts as one batch.
- **Talk instead of typing.** Voice notes (hold T), recorded feedback (talk, point and draw while the video plays;
  everything said becomes a draft note on the frame it was said at) and spoken reasons for "Still wrong". Speech is
  heard by transcribe.cpp where the app runs, or by an OpenAI-compatible server you name.
- **Transcripts** of every version, word by word on its frames: a click goes to the word, "Change the words" writes a
  note about exactly those frames, SRT and WebVTT captions download, and versions compare by their words.
- **Versions.** Every re-render or upload is the next version and open notes carry forward. What changed between
  versions (picture regions, sound, retimes), compare side by side, as a wipe, a difference or an onion skin, and
  check mode for every fix before and after.
- **Auto-check** on every version: typos in on-screen text, safe zones, flash and black frames, freezes, clipping,
  silence and loudness. Each finding says what, where (with its frame), why, and whether it looks intended.
- **Where every video stands.** One stage per video from to review to final, approvals per version by the team and
  the client with their history, one next-step button, and a board where moving a card is the sign-off (with Undo).
  A final version is locked for agents.
- **Fix previews and partial renders.** An agent shows a fix as a still or short clip before it renders, or renders
  only the shots a note allows; the next full render is compared with what was approved.
- **Options before a render.** An agent offers takes, lines or looks to audition side by side, sounds at the same
  loudness; the picks go back as one line.
- **Playbooks**: a House playbook and one per folder (brief, rules, references, Agent Skills), inherited down the
  folders and stamped on every version. Agents read them and suggest changes; people decide.
- **Agents**: the `vr` CLI and an MCP server (stdio, and Streamable HTTP at `/mcp` on the 2026-07-28 spec, 2025
  clients still served) that hand over notes with their marked frames; `wait_for_feedback` and live subscriptions;
  the review as an MCP App (`show_review`); an Agent Skill; ready configs for Claude Code, Codex, Cursor, VS Code,
  Windsurf, Gemini CLI, Zed and the Claude desktop app (`vr mcp config`). Agents ask questions with answers to pick,
  answer per note (fixed, won't fix) and read the reviewer's taste.
- **Few tokens**: a lean tool set, pictures only for drawn notes, answers that name only what changed (`bench/tokens/`).
- **See your agents.** Each agent with its kind and mark, what it is doing now (from what it already sends Lampo, at
  no token cost), and on your own machine a Claude Code session that isn't running can be started with the notes.
- **Review links** for one video or a whole folder, without an account: notes and approval, notes only or watch only;
  which versions; original or preview downloads and Download all as one zip; an expiry and a password. Owners see
  who opened what and how far they watched. Webhooks to Slack, Discord or signed JSON.
- **The library** in four layouts (grid, compact, list, board) with filters, hover-scrub posters, recent videos and
  ⌘K search across videos, folders and notes.
- **The inbox**: everything that is your turn, by video or by kind, with a frame-exact preview beside the list and
  the actions on every row (done, looks right, still wrong, later), with Undo.
- **Insights**: who watched how much of what, where the time goes (on you, on agents, on clients), how agents do,
  and the notes that keep coming up, a click from a playbook rule.
- **On the phone**: an installable app, Web Push without a third-party service, a touch player and timeline, and
  bottom sheets for notes and menus.
- **One app, on your machine or hosted.** On your machine you are signed in at the machine itself, renders stay where
  they are, and Claude Code sessions, a LAN link and a tunnel are a click away. Hosted (`VR_MODE=server`): accounts
  with owner, admin, member and reviewer roles, invites, API tokens, OAuth for MCP clients, resumable uploads, storage
  on disk, Bunny or S3, Docker and compose, `/readyz` and a graceful shutdown.
- **Workspaces**: many teams on one hosted server, each seeing only its own work; an account can belong to several.
  Open sign-up gives everyone a workspace of their own.
- **Email**: invites, password resets, address confirmation and account notices through any SMTP relay, or into an
  outbox folder without one.
- **A first run** that teaches by doing, ticked off by what you really did, with a sample video to try.
- **Going live**: `docs/go-live.md` (one server with Docker and Caddy) and `scripts/smoke.ts` to check an instance.
- English and German, light and dark, one design system, loading states that keep the page's layout, and the Lampo
  identity (`docs/brand/`).

### Security
- A hosted server treats every request as hostile: zod on every input, no paths from clients, ffmpeg only on accepted
  formats and with time limits, routes matched exactly, a deny-by-default guard and a permission table that every
  route is in (a test walks them all, in every spelling).
- Error text by audience: only the machine's owner at the machine reads internal errors; everyone else gets a sentence
  and a reference to the log.
- Agents never sign off, and API tokens never touch credentials, roles, members, invites, tokens, apps, webhooks,
  workspaces or review links: that is a person's, signed in in the app.
- Review links name videos by opaque ids, keep their tokens only as hashes, and are rate-limited per visitor and per
  link, with every record they keep bounded.
- Sign-in limits that can't lock a person out, sessions that end on sign-out and when idle, the same answer for every
  address, one-time links stored as hashes; a new password ends sessions, devices and connected apps.
- What people write reaches agents on its own line, so a note can't forge another; names are cleaned.
- Workspaces are isolated: a test walks every route, MCP tool and file URL as a member of one workspace asking for
  another's things.
- Webhooks and OAuth fetches reach public addresses only; a hosted server refuses to start with unsafe settings; the
  container runs read-only and without capabilities.

### Project
- AGPL-3.0-only with a Contributor License Agreement; the source link the AGPL asks of network services; third-party
  notices travel with the build.
- TypeScript that Node ≥ 22.18 runs directly; React 19.
- Tests: unit, API, server mode, storage adapters against mocks, `vr` and MCP end to end, browser suites in both modes
  (Chrome and WebKit), layout and quality checks from phone to wide screens, speed budgets (`bench/perf/`); CI on
  Linux and macOS.
- `npm run demo` and `npm run screenshots` on synthetic footage.

### Changed (the cookie box's two answers)
- **"Allow all" and "Necessary only" both wear the primary orange** in the cookie settings, as on the website; *Settings*
  and *Save* stay plain, all one size. An accept that stands out beside a plain refusal would steer the choice.

### Changed (reverse charge only with the seller's VAT ID; a consumer's yearly plan after its first year)
- **Reverse charge is a switch of the billing provider** (`BillingInfo.reverseCharge`), on only where the seller has a
  VAT ID, which a reverse-charge invoice must name. While it is off, a business from another EU country pays VAT like
  everyone else, the checkout asks a business's name and VAT ID in fields of its own (the VAT ID goes on the invoices
  only, and is said wrong at its field), and nothing in the app says reverse charge — the plans' VAT line, the business
  box and the order's tax row included. With it on, the checkout is as before.
- **A consumer's yearly plan after its first year may end with one month's notice** (the terms' § 6 (1)): *Cancel
  contracts here* offers it where the provider says so, with the day it would end and what goes back for the time paid
  for after it; the contract keeps one height whichever way is chosen. What was received says the refund, the
  confirmation email states it, and the plan says it until the end; keeping the plan owes nothing. Businesses and plans
  in their first year cancel as before.

### Added (your data in your hands, and a workspace taken down)
- **Export my data** (Settings → Profile): one zip of plain files — your account, your workspaces and roles, your API
  tokens, apps and devices (never a token itself), and per workspace the notes and replies you wrote, your drafts,
  unsent recordings with their audio, verdicts, the review links you made, what you watched and what you uploaded. Never
  anyone else's words: a reply on someone else's note names that note by its id only.
- **Delete my account** (Settings → Profile, a hosted server), confirmed with your password: the workspaces only you
  work in go with it, the others you leave. The last owner of a workspace others work in is told to hand it over or
  delete it first. **Delete workspace** (Settings → Workspace, its owner): its name typed; everyone in it is emailed.
  On the server: `vr admin delete-account`, `delete-workspace` (a dry run without `--yes`), `export-account`, `erasures`.
- **The operator takes a workspace down** (the operator's Workspaces page): **Suspend** makes it read-only for its
  people — they read and download, nothing changes, its agents write nothing, its review links stop — and tells them;
  **Lift** gives it all back; **Delete** removes it with everything it holds once its name is typed.
### Changed (what goes when an account goes)
- **A removed account leaves nothing of its person behind**: its picture, push devices, drafts and unsent recordings in
  every workspace, app connections, account links and its copy in the backups of the move to workspaces go with it;
  what it watched stays in the team's numbers under no name. Its notes stay with the team, signed with its name.
  Someone removed from one workspace loses their drafts and recordings there. Deleted accounts and workspaces are
  written down by id (`data/erasures.jsonl`), so a restored backup can delete them again.
- **A workspace's admins see who its members are, not what their accounts keep**: no settings, first runs or other
  workspaces' dates, no address waiting to be confirmed.

### Fixed (voice notes on a hosted server)
- **Settings → Voice notes speaks to whoever reads it.** On a hosted server it says the notes are written down on the
  server the workspace is on, by Lampo's own speech model, and that the recording goes to no other service. It no
  longer mentions a Mac's graphics chip. The engine, the model and the server's settings (config.json, `VR_STT_*`) are
  shown only to whoever runs the app: the person at their own computer, or a hosted server's operator.

### Added (cookie settings before the payment form)
- **The payment form waits for the person's say in the cookie settings**, as on the website (CookieConsent 3.1.0,
  vendored; the same `cc_cookie`, 182 days, the same words, buttons of equal weight, in the app's look). Stripe.js with
  its fraud cookies and the address search with Google's suggestions are a category of their own, *The payment form*,
  off until allowed; nothing is requested from Stripe or Google before. Refused, the checkout says so where the form
  would be, with *Allow the payment form* and *Cookie settings*; the choice is kept, and *Settings → About* opens the
  settings again. None of it loads before a payment form opens.
### Changed (consumers may buy: the checkout as German law asks)
- **The checkout takes consumers, not only businesses**. *I'm purchasing as a business* is
  optional and off; ticked, it asks for the business's name and VAT ID (needed only for reverse charge). A consumer
  ticks a box above the order button asking for the plan to start at once, before the 14-day withdrawal period ends
  (§ 356(4) / § 357a BGB), with the terms line right under it linking the operator's terms, privacy policy and
  withdrawal information; the button says **Buy now** (*Zahlungspflichtig bestellen*), in a trial and in a limit's
  sheet too. What was agreed is recorded with the billing provider before the order goes to Stripe.
- **Prices in Settings → Billing are shown with VAT** where the billing provider names the rate a consumer pays
  (PAngV): "€14.28 a month · €171.36 billed yearly, incl. VAT", and the checkout works out the tax for the billing
  address.
- **Cancel contracts here** (*Verträge hier kündigen*, § 312k BGB) replaces *Cancel plan…*: it leads to a confirmation
  step of its own (at the period's end, or for an important reason with that reason; who, which plan, until when) whose
  *Cancel now* (*Jetzt kündigen*) is confirmed by email at once with when it was received and when the plan ends. The
  sign-in's foot and *Settings → About* link it too: to `VR_CANCEL_URL` when set (a page without signing in), else to
  that step.
### Added (hide the Lampo badge on a paid plan)
- **"Powered by Lampo" stays on every review link by default, on every plan; a paid workspace may hide it.** Its owners
  and admins find *Hide the Lampo badge* in *Settings → Review links* (where a billing provider runs); a review link's
  answer says `badge: false` only while the plan may hide it and the admins did, so a lapsed plan shows it again by
  itself. The source offer and the legal pages stay on the page either way. The plans and the in-app moments no longer
  promise "no badge"; a trial shows the badge like Free.
### Added (the operator's legal pages)
- **A hosted server links its operator's imprint, privacy policy and terms** where people meet it: under the sign-in
  screens' server line, at the foot of every review link's page (imprint and privacy policy, under *Powered by Lampo*)
  and in *Settings → About* (with the withdrawal information too). New settings `VR_IMPRINT_URL`, `VR_WITHDRAWAL_URL`
  and `VR_CANCEL_URL` beside `VR_TERMS_URL` and `VR_PRIVACY_URL`; each must be an http(s) URL. **`VR_SIGNUP=open` now
  refuses to start without `VR_TERMS_URL` and `VR_PRIVACY_URL`**: strangers who sign up accept the
  terms and are told how their data is used before they have an account.

### Fixed (a hosted server under load)
- **Comparing two versions streams them** instead of holding every frame of both in memory, so a long or high frame
  rate upload no longer weighs on the server; the results are the same. A comparison reports at most 1,000 changed
  sections of each kind.
- **A render that brings the server down can't do it on every start.** A background job whose process died under it
  isn't started again after the second time, and the comparison says why there is none; a graceful stop is no crash.
- **Uploads of extreme shapes are refused** (thinner than 8:1, or under 32 pixels on a side; `VR_MAX_ASPECT` allows
  more for LED boards and the like), and the analyses never look at a picture taller than four times its width.
- **Uploads hold room only while they move**: the disk's reserve and a workspace's plan count what unfinished uploads
  still have to send, an upload that stops sending gives its room back, and no one account or workspace can hold all of
  it.
- **Pictures made while someone waits take turns** across the server, and each workspace gets its share, so one team's
  requests never hold back another's notes; a note is saved even when its screenshots have to wait. Frames stay exactly
  the frames they were.
- **Invites, sign-ins started by apps and decisions through a review link are bounded**, per account, per address and
  per day, so no one can fill a file, the server's memory or a video's record, or crowd out a real client.
- **A password reset goes before every other mail**, so a flood of sign-ups can't hold it back; forgot password for a
  sign-up nobody confirmed sends its confirmation, which lets you in with a new password too, and whoever asks hears
  the same as for any address.
- **Footage search's work follows a video's length, not how it is cut.**

### Added (notes that point at elements; a part's room per note)
- **Elements maps**: a renderer that knows what it put where sends it with the render — each named element's box,
  frame by frame (`{v: 1, fps, size, elements: [{id, name, kind, keys: [[frame, x, y, w, h]], runs?}]}`, docs/agents.md).
  `vr push --elements map.json`, `vr elements <video> <map.json> [--v N]`, MCP `track_video`'s `elements` (a file on
  the machine) and `PUT /api/review/:slug/versions/:v/elements`. Checked whole (500 elements, keys sorted and at most
  max(2000, the version's frames) per element, runs sorted and apart, 1 MB, names on one line), scaled to the version,
  thinned to the keys a straight line needs, kept per version beside the review.
- **Every note says what its drawing points at** in its version's map: ` · on #title, #card +2` on its line in
  `vr open`, `vr show`, INBOX.md, `get_open_notes` and `get_note` (` · near #card` for a drawing over empty space), the
  names once in the header (`elements: #title "Launch day", …`), `elements` per note in `vr open --json` and in
  `get_open_notes`' new structured content. The rules come from a renderer's own review loop: the closest match under
  a box, an arrow by its tip, a range across its frames, the full-frame background only under a large box.
  `GET /api/review/:slug/elements` for agents on another machine.
- **A part's room per note**: where a person allowed a part render, the note's line ends ` · part f96–f188` and
  `vr open --json` / `get_open_notes` carry `part_ok: {from, to}` — the frames `vr push --part-at` checks.
- `vr <command> --help` prints that command's usage on stdout (`vr push --help` names `--elements`).
- docs/agents.md: the elements map, and "Three directions before one render" (three agents, three directions, a 4-second
  motion test each, one `vr ask --options` to pick from).

### Changed (asks you can't miss, clips you can see large)
- **A question an agent asked on a project or folder before its first version now leads that page**, above the videos
  or the empty project, instead of a small chip beside the Videos · Playbook tabs: who asks and when, the question in
  its own words (two lines, then cut), what there is to compare ("3 clips", "Narrator: 3 sounds · Look: 3 pictures"),
  "n more questions in the inbox" when several wait, and one action, *Compare and pick*. It is the page's one orange:
  while it waits, the empty project's *Upload a video to …* and the top bar's *Add video* step back to neutral, and the
  empty state takes its quieter size. The question comes with the inbox's list the bell already keeps, so the block is
  there with the page (on a first visit the content waits for that list, so nothing moves when it arrives). The inbox
  and the bell's count already listed such questions; unchanged.
- **Compare and pick uses the room it has, and every picture or clip opens large in it.** With pictures or clips to
  look at the dialog is up to 1600 px wide and as tall as a dialog may be; tiles share the row (three clips across it,
  up to four a row) instead of staying 220 px. A click on a tile, or its Expand, shows that one large inside the dialog
  — as much of it as fits at 16:9 with the clip's own controls, its group and "2 of 3" above it, its pick under it —;
  ←/→ (or the arrows) go to the next of its group at the same moment, playing if it played; A goes back to the one
  before; 1–9 pick there too; Esc or *All options* returns to the grid, which kept its place. The grid and the large
  view share one box, so switching never resizes the dialog. A clip in the grid is a way into it (no controls of its
  own); *Play together* plays them all side by side and becomes *Pause* while they do; A/B for sounds is unchanged.

### Fixed (a watch-only link and other links' notes)
- **A watch-only link that had "notes from all links" on showed its visitors every other link's notes and names**
  while the dialog said it doesn't. A link that only plays now shows no one else's notes or
  decisions, links made before included, and the dialog saves it that way.

### Added (the operator's admin)
- **Whoever runs a hosted server sees every workspace and account on it**, at `#/operator/workspaces` and
  `#/operator/accounts` beside the funnel (one frame, its tab line Funnel · Workspaces · Accounts), reached from
  **Operator** in their account menu. Workspaces lists each one's owner, members, plan and state (Free, Solo, Team, a
  trial and its end, grace, read-only, complimentary), storage used of the plan, videos, when it was made and last
  active — searched by name or owner, filtered by where the plan stands, ordered by activity or age. A workspace opened
  shows its facts and members, and its **plan set by hand** through the billing module: complimentary on any plan (no
  limits, never billed), the trial run to a day, or back to normal billing, each with a reason, all of it in the
  workspace's log (who, when, what, why). Accounts lists each one's workspaces and roles, last sign-in and whether it
  is disabled; **Disable** signs it out everywhere and stops its tokens at once, **Enable** lets it in again.
- **`LAMPO_OPERATOR`** names who runs the server (account addresses or ids); unset, the owners of the first workspace,
  as before. Anyone else, and every API token, is answered as if there were no such page. Accounts now remember their
  last sign-in (kept from now on, shown only on the operator's page).
### Changed (who runs the server)
- **Everything that is the server's rather than a workspace's goes by that one rule now**, never by a role in the first
  workspace: the server's setup, its health check and test mail, the speech engine's model path and last error, and
  making workspaces (`VR_WORKSPACE_CREATE=owners`, and no limit with `anyone`). Someone invited into the first workspace
  as an owner or admin works there and runs nothing; with `LAMPO_OPERATOR` set, the first account too unless listed.
  An admin of the first workspace no longer sees the server's health check (the owners still do while the list is
  unset).

### Changed (sharing)
- **Every setting of a link is a row with its name and its switch**, in the share dialog and when a link is changed:
  Leave notes · Approve or request changes · See notes from other links · All versions, to switch and compare, each a
  switch; Downloads a menu (Off · Preview · Original); Expiry date a switch whose button says the day; Password a
  switch with its field in the row. No *Customise* to open first, and nothing opens under a row: the settings keep
  their height while they change. Review · Watch only · Delivery set the switches; what depends on notes is shown off
  and can't be changed for a link that only watches.
- **The expiry date is one picker**: its button opens 1 day · 7 days · 30 days and a calendar for any day (a sheet on a
  phone); the chosen day has the focus.
- **A password is made up for you**: turning it on fills its field with one that reads well (three words and a
  number), *Generate* makes another, and it can be typed over. Made with a password, the link and its password are
  copied together.
- **A link is one line**, in the dialog and in Settings → Review links: its name (a lock with a password, *Expired*
  when it ended), what visitors may do, until when and what came of it; *Copy*, and a ⋯ menu with *Change link*,
  *Activity* and *Revoke*. It was a card with the address, chips, a summary bar and five buttons. On a phone *Copy* is
  its icon.
- **Change link opens the link as its own page in the dialog** (its name, the kind, the same rows, Revoke link, Save),
  in the same height as the list; from Settings → Review links it opens there too.
- **The dialog's links have a heading with their count and *All links***, which leads to Settings → Review links.
- **No QR code** in the share dialog.
- German says the expiry's days in German ("in 7 Tagen", it said "in 7 days").
### Fixed (sharing)
- After a link was made, an expiry or password opened for it stayed open on the empty form, the expiry saying
  "Never expires".
- Settings → Review links opened directly (before any share dialog) showed its lines without their styles.

### Changed (agents wait right after handing over)
- **An agent hears notes only while it waits in `wait_for_feedback`, so every hand-off now says "wait now".**
  `track_video`, `mark_fixed` and `wont_fix` (once none of the video's notes is open; until then "2 notes still open on
  this video.") end with `Now call wait_for_feedback with since "<cursor>": the person's notes arrive together when they
  press Send.` — the cursor from that moment, so a note written before the agent's next call is still heard.
  `request_upload`'s `PUT` (and the `GET` after it) answers with `cursor` and `next`. `vr track`, `vr push`, `vr fix`
  and `vr wontfix` end with how to listen there: `vr watch`. Appended lines only; nothing an agent parses changed.
- **A wait that ends with nothing new says what is going on**: after `No new feedback in 50 s.` and its cursor, one line
  says the person's notes arrive together when they press Send, and to call again now.
- **After 30 minutes of nothing but that, the agent is told to stop** and to tell the person it stopped listening and
  how to start it again (the `watch` prompt, `/lampo:watch`), with `stop: true` in `structuredContent`. Counted per
  agent (over HTTP the connected agent, else its token or app), in bounded memory; a pause of more than two minutes
  between waits, or any real answer, starts the count again.
- **On a video with an agent, notes go to it together.** The agent starts on the first note it gets, so the composer's
  main action there keeps the note (Save, ⌘↵) and "Not sent yet" sends them all with one "Send 3 to <agent>"; the
  composer's own Send (now quiet, ⇧⌘↵) still sends this note and the others at once. Replies and answers to an agent's
  question go at once, as before; videos without an agent and review links are unchanged.
- **The player says when the agent waits**: "<agent> is waiting · gets your notes when you send", one quiet line in the
  composer or under "Not sent yet" (in place of "Only you see these…" while it waits), and the toast after a send says
  "<agent> got your 3 notes". While notes wait to be sent, + Note steps down so their Send is the one raised action.

### Added (a video made by your agent)
- **An empty library offers making a video, not only uploading one**: beside Upload video, *Make one with an agent*
  copies a prompt for the person's own agent — make a short video (what it's for, who it's for, how long), put it up
  for review with `vr push` (at the machine `vr track`), read the notes with `vr open` and fix them, and if `vr` isn't
  set up, ask to be connected. Under it: "No video yet? Your agent can make one and put it here for review." with
  Connect an agent. It replaces the line that only showed a `vr push` command.

### Changed (vr login opens the browser)
- **`vr login <url>` signs in through your browser instead of asking for an email and a password**, the way `gh` and
  `gcloud` do. It opens the server's consent screen (after you sign in there, if you aren't): the same page apps see,
  naming `vr` and this machine, the API token it gets (`vr on <machine>`, `--expires` days or until revoked), the
  workspace on a server with several, and what the token may do. Press Allow and the browser hands a one-time code back
  to a port on this machine (`127.0.0.1`, PKCE); vr trades it for the same API token `--email` makes, and the page
  says "Back to the terminal". The terminal prints the address too, says it is waiting (Ctrl-C cancels, 5 minutes at
  most) and then who you are signed in as, in which workspace. Over SSH it prints the address to open on any device;
  after Allow, paste the address that browser ends on. `BROWSER` names another browser.
- `--email` (the password prompt) and `--token -` stay for CI, containers and scripts. A script that piped the email
  and the password into a bare `vr login <url>` now says `--email`. `vr logout` revokes a token from either way.
- Settings → Agents says how `vr login` signs in now.

### Fixed (an invited admin's setup)
- **Someone invited as admin or owner into a server's first workspace was shown the server's setup** (name the
  workspace, check the server, invite the team, connect agents) — on a hosted server, the operator's workspace. An
  account that joined through an invite now gets an invited teammate's setup, whatever role the invite gave it; the
  server's setup stays its own owner's.

### Fixed (live updates after a restart)
- **A tab left open across a server restart (a deploy) went deaf**: its live stream was refused once while the server
  started, browsers never try a refused stream again, and the app reopened it only after a sign-in. Everything that
  changed afterwards stayed out of that tab until a reload — a fix checked in another tab stayed in its inbox with
  "Check 1 fix". The stream now opens again by itself (1 s, then longer, at most 30 s; at once when the network or the
  tab comes back), and once it is back every tab asks again for what it shows, since what was said meanwhile is lost.

### Fixed (uploads from chat apps)
- **An agent in a chat app's sandbox no longer has to guess when its upload is refused.** Claude and ChatGPT run code
  in a sandbox that reaches only the domains it allows; `request_upload`'s URL is on the media host, so the sandbox's
  own proxy answered 403 and the render never reached Lampo. The tool now says what to do then — ask the person to
  allow that host in their client's network settings, or hand them the app link — and its answer ends with that link:
  the folder in the library for a new video, the video's page for its next version, where the person uploads it.
- **Settings → Connect an agent → Claude names the domain to allow** on a hosted server with a media host, with its
  Copy: Claude's allowed domains are in Settings → Capabilities (on Team and Enterprise plans the organization's owner
  adds it). The machine and a server without a media host show nothing new. `GET /api/info` names the media host
  (`media_origin`) to someone signed in.

### Fixed (the agent tiles)
- Settings → Connect an agent: every agent tile is one size, its name and line the same distance apart (a line that
  wrapped in "Other client" made its row taller and spread ChatGPT's and Claude's apart). "Other client" reads "VS Code,
  Zed and more" on one line, the clients themselves behind it as before, and a narrow panel shows two columns instead of
  cutting "Claude Co…".

### Fixed (a section played right after a jump)
- Playing a section right after a jump or a scrub (before that seek had landed, on a loaded machine or with hosted
  media) skipped the section and left the picture on its last frame: the frame the earlier seek put up was taken for
  where playback was. A frame shown while the player is still seeking no longer ends, loops or records a section.

### Added (conversion)
- **A limit reached is a sheet, not a toast**: where a billing provider runs, an owner or admin who hits the plan's
  storage, member or video limit (a 402) sees a sheet instead of a red toast: what was asked for and why there is no
  room, with the workspace's own numbers (for storage a meter with the file hanging over the plan's notch); what fits by
  the smallest step (Solo for room on Free, one more terabyte on a paid Team, Team for a second person, billed for at
  least two, said in the first sentence); Yearly · Monthly with the saving said exactly; a now → then table; paying in
  place (the billing page's checkout in one column, or the card on file with €0 today and the rest prorated onto the
  next invoice); "Or make room" with the workspace's final videos; and "Not now". Members and review-link pages keep a
  toast, without a way to plans they can't choose. Agents and `vr` keep the 402 sentence.
- **An upload waits for room instead of failing**: refused for room, it stays in the tray as "Waiting for room · 1.8 GB"
  (with See what fits and Try again) and starts again by itself once the plan holds it.
- **An invite beyond the plan says what brings them in**: on a subscription with a card on file, typing an address the
  plan has no room for shows the plan that fits, its price for the people there will be, and "Today: Nothing", with the
  prorated difference on the next invoice; the button becomes "Switch to Team and invite Ben". On Free the invite opens
  Team's sheet, and the invite goes out once it's paid.
- **Insights on a plan without them explain themselves**: what Insights would show from the workspace's own work, an
  illustration marked as one, and See Team (the feature's sheet); the sidebar's row says which plan brings them.
- **The trial, visible all along**: where a billing provider runs, the library's sidebar ends with "Team trial · 10 days
  left" over a ruler of the trial's days (today the playhead, the end a keyframe that turns half and amber in the last
  three days, never red). A click opens its card: the end date, what Team includes with the workspace's own numbers
  (members, storage, videos under review, roles, Insights and webhooks in use, review links in your name), that nothing
  is deleted afterwards, and one way on — Choose a plan, for owners and admins (everyone else reads who chooses it). A
  sheet on a phone. The account menu carries the same line and Billing with a quiet "Trial"; after the trial the line
  counts the week of grace. Paid plans show nothing there.
- **The trial's end at the library's head**, one line until clicked: three days before the date, and opened what Free
  would mean for the workspace (its members, storage and videos against Free's) and what happens if nobody chooses (a
  week of grace, then read-only, nothing deleted); on the last day the hour; after it the week of grace and read-only
  with three honest ways on — keep the plan, fit into Free (exactly what that takes, who would have to leave), or do
  nothing (what still works, what waits). A failed payment's banner leads to Settings → Billing.
- **Read-only locks Add video instead of failing later**: a neutral button with a lock (A and U too, and the
  empty library's button) whose popover says new videos wait, what still works, and the two ways on; a drop says it
  waits until there's room.
- **Moments of value**: the first fix checked on a video of the workspace's own (never the sample) adds a line under
  the player's stage while the trial runs ("That's the loop, on your own video", with the price for the workspace's
  people and Keep Team…); the workspace's first review link opened shows its maker a card in the library's corner with
  a picture of what the link shows and the video's chip turned "opened". Each shows once per workspace; Not now puts it
  away for 14 days on every device, with Undo.
- **The operator's funnel** (`#/operator/funnel`, the owners of a hosted server's first workspace only): how sign-ups
  become paying workspaces — four figures, the eight steps with the biggest drop before paying flagged (each step's
  detail on hover or Tab), each sign-up week's share per step with the weeks still in their trial marked, 4 / 8 / 12
  weeks, and what is counted and what never is. Before anything was counted it says so; it never shows example
  numbers. Anyone else gets "There's no page here".
- **First-party counts only** where a billing module runs: eight steps once per workspace (signed up, setup done, first
  video, first review link, a link's first opening, first fix checked, active at the trial's end, paid) with the day and
  the plan, and what the conversion moments did per week — never names, addresses, IPs, devices, videos or anything a
  visitor types; no third-party trackers. Kept 13 months, then weekly counts. A self-hosted server counts nothing.
- **"Not now" holds on every device**: a conversion moment put away is kept with the account for that workspace (and
  comes back with Undo); the first loop on a video of the workspace's own and the first review link opened wait a day
  for the one person they are for, told live.

### Changed (Settings → Billing)
- **Billing is one page in three parts** (the approved prototype): the plan as one panel (its name and state, the
  price, one sentence with the dates, the trial's or a grace period's days as a ruler, what Free would mean in a
  trial's last days, extra storage, three meters with a dashed track where there is no limit, and the one thing to
  do); the plans as tiles chosen like radio buttons whose prices and lists line up in any language, with one bar for
  the cost and the one orange action; and the account as one panel: cards with their brands (Remove with Undo, a new
  card added in place), the billing details edited in their row with the VAT ID said wrong at its field and checked
  by VIES, and the invoices as a table with the next one estimated. One 1040 px column, centred on wide screens. A
  failed renewal is fixed in a sheet (what still works, a new card, paid); a complimentary workspace reads its own
  words; a member sees the plan without prices and can let the owner and the admins know.
- **Stripe's card and address fields look like the app's own**: Instrument Sans, the app's field heights, borders, focus
  ring and error colour, in both themes.
- **Checkout is a step of its own** (`#/settings/billing/checkout?plan=…&interval=…&currency=…`): the plan for the
  workspace as its title, the billing address, "I'm purchasing as a business" with the business name and VAT ID, and the
  card on the left; the order on the right with its lines, VAT from the address, a promotion code above the total, and
  what is due today while the trial runs on. Stripe's fields keep their room while they load, so nothing moves; on
  phones what is due and the button stay in a bar at the bottom. Paid, a calm panel says the plan, the first payment,
  the card and where invoices go. A new address for receipts can be given there and is saved once paid.
- **The billing address can be searched**: type a street and pick a suggestion, and the street, postal code and city
  fill in (Stripe's address search, its suggestions powered by Google); "Enter address manually" stays.
- **Adding a card and paying an open invoice use the same fields**: the card alone (no wallets, no Link box), its room
  kept while it loads, Cancel and the one orange action at the field height.
- **A declined card is said in our words**: what happened, that nothing was charged and the way out (an expired card,
  a wrong security code, a bank that declined), never the payment provider's own text; English and German.
- **Paid during a trial, the trial's ruler fills in one sweep** and its end turns solid green on the done panel.

### Added (billing: what the redesigned page and the limit sheet read)
- **A plan's 402 says more for the limit sheet**: what was asked for (`needed`: the upload's size, or the address of
  the member being added), the room the workspace could make (`room`: its final or archived videos and their bytes)
  and the smallest step that fits (`fits`: a plan or `addon:storage_tb`); `PlanRefusal` in lib/types.ts. The sentence
  agents and `vr` read is unchanged.

### Fixed (agents hear their notes)
- **Notes written while an agent wasn't listening reach it when it starts.** An agent connected over MCP (Claude
  Code, Codex …) acts only when prompted, and `wait_for_feedback` without a cursor started from now: an agent told to
  "wait for my notes" after they were written heard nothing. Its first call now answers at once with what is assigned
  to it and waiting — the videos with open notes or a request it hasn't been told of — each thing once, then waits as
  before.
- **`list_videos({session: "me"})` works over HTTP**: the videos assigned to the agent the app lists for this
  connection. It refused ("only works when the server runs inside a Claude Code session").
### Added (agents that listen)
- **The app shows whether an agent hears new notes**: *listening* (it waits in `wait_for_feedback`, or follows with
  `vr watch`), *working* (on what a wait handed it), *not listening* or *not connected* — from the waits it holds
  open, not from being connected. In the video's agent menu and card, where you assign one, in Settings → Connected
  agents and Connect an agent. Only an agent that listens or works reads as "An agent is on it".
- **One command starts it: `/lampo:watch` in Claude Code.** The MCP server's new `watch` prompt has the agent work the
  notes on the videos assigned to it, then keep calling `wait_for_feedback` until you say stop; any other agent gets
  the same as a sentence to paste. Settings → Connect an agent (a fourth step), the setup, the agent menu and
  Connected agents show it to copy, and the server's instructions and the Agent Skill tell an agent to offer it.
- **When a note goes to an agent that isn't listening**, the player says once how to start it.
- **One log line per MCP tool call** (`mcp: <workspace> <agent session id> <tool> <outcome> <time>`, a wait when it
  starts and when it ends): never note text, names, file names or tokens. `VR_MCP_LOG=off` turns it off.
### Changed (the agent menu)
- **The agent menu reads calmer.** Its head is the agent and, in plain words, whether it listens (with the command that
  starts it when it doesn't); the live log shows three lines — what it does now and the two actions before —, then
  *Show all*; what people ask most are quiet choices above the field, with the quick check as a smaller option under
  them, and *Copy for an agent* · *Assign agent…* sit quietly at the foot. No orange sparkles.
- **What an agent did never shows its note ids**: "Fixed “End card rebuilt…”" in the words of its fix, cut at a word,
  or "Reading the note at 00:15:08" — in the menu and on the agent button; the sidebar and board cards say "a note".

### Fixed (the look)
- **The way in loads as itself.** Invite, reset, consent and confirm draw their own column at once (a separate
  skeleton then the form 238 px higher before); the sign-in no longer shows the sign-up-off sentence and then swaps
  it, "Forgot password?" holds its place until the server says it sends mail; the column is centred once and what
  grows in it (the fine print, "Sign in an agent", a two-line error) grows downward; the foot line no longer slides.
  The brand film has its own tones from the first paint (no black box before the still), a tablet keeps a 440 px
  column, a wide screen draws the film at most 1.2×. An invite's "Check your inbox" offers *Send it again*; the
  consent's scopes are sentences; the sign-in in front of an app's request says so; phone tap areas reach 44 px; a
  review link's name longer than 80 characters ends at a word.
- **Words people read are never `--faint`** (under AA contrast): password rules, terms, counts, dates, timecodes,
  hints and labels are `--muted`; a browser check keeps it so. A chip's count is a quiet second word (the UI face, a
  step under its label) in the tags, the lanes and the tabs.
- **Settings stands in the middle of its room** on a wide screen; an agent tile wraps its line instead of cutting it.
- **A phone card's foot has only the lines it holds** (no empty row between the stage and the agent); a narrow
  desktop window grows its fields and selects with its buttons; a mouse click on a native select draws no keyboard
  ring; the toast's × loses the browser's padding.
- **Library and inbox:** an empty workspace's first visit no longer jumps from a sidebar skeleton to the empty state
  (a browser that never saw the library draws the top bar alone); an inbox row cuts its words, never the timecode; on
  a wide screen the list's columns share the width; the phone's bell count sits on the bell; the item in the preview
  doesn't look picked beside the picked rows; the search field keeps its words at 1024; "Changed Changed…" says it
  once; the list's Open column one glyph; a group of cards says no age of its own; a folder's own videos are "In this
  folder"; Insights' facts wrap between facts.
- **Player:** check mode asks *Looks right · Still wrong* once (its card over the picture; the panel's card shows the
  state); the zoom tip goes with its control (it stood half off the screen over the title with the notes sheet up);
  German "1 kleinerer Fund"; the speed's word stands against its chevron; the dock's foot has a soft edge and its Δ
  chips come first so late words move nothing; a reply edit says its keys once.
- **"New workspace…" in the account menu** for whoever may make one, with one workspace too (it was only at the foot
  of Settings → Workspace).

### Added (footage search)
- **Footage search: B-roll for agents** ([docs/footage.md](docs/footage.md)). Lampo indexes the newest version of
  every video in the background — its shots (Auto-check's cut rule), the camera's move per shot, keyframes, text in
  the picture, what its transcript says, one image embedding per keyframe — and answers a request in words with
  shots, each with its exact in and out frames: `vr footage find "product close-up on white, slow push-in, ≥ 2 s,
  9:16, no text" [--json] [--sheet]`, the MCP tool `find_footage` (one line per shot, and on request one labelled
  contact sheet: ≈ 210 + 480 tokens instead of tens of thousands), and `GET /api/footage/find`. The filters in the
  words (aspect, length, move, "no text", words on screen or said) are read as the research measured them; on its
  test set a right shot comes first 93 % of the time and in the first five always.
- **On by default on your machine; on a hosted server, per workspace** by its owners and admins (`vr footage on`,
  `PUT /api/footage/settings`); `footage: "off"` (or `VR_FOOTAGE=off`) turns it off everywhere. `vr footage status`
  says how far the index is; `vr footage index` indexes now without the app; `vr footage sheet <ids>` makes a sheet.
- **The model downloads on first use**: SigLIP B/16 int8 (Apache-2.0, 213 MB) into the cache, from one pinned revision
  with every file's SHA-256 checked, and runs in a process of its own (`onnxruntime-node`, an optional dependency).
  Indexing is the job queue's least urgent work, a minute of video at a time; each workspace's index is a file in its
  own cache. The render's path on this disk comes with a shot for the machine itself only.

### Added (compare on review links)
- **Visitors compare two versions side by side, or as a wipe.** On a review link that shows every version (*All, to
  switch and compare* in the share dialog), a video with two or more has *Compare* beside the version switcher (in ⋯
  on a phone; B on a keyboard). A is the version on screen — what notes, drawings and the decision are about —, B the
  reference: by default the newest older version the visitor wrote notes on, else the one before. Either side is picked
  in the compare bar, ⇄ swaps them on the same frame, Esc or × closes it, and a reload keeps it open. Each picture
  says which it is ("A V3", "B V1 · reference"), playing, stepping and scrubbing keep both on the same frame, and B's
  picture holds its place before its video comes. On a phone two landscape pictures stand one above the other (two
  upright ones side by side). Watch-only and delivery links that show every version compare too; a newest-only link
  never does and receives no other version's media. B comes from a new guest route that only such links answer.

### Changed (review links)
- **A review link's notes look as they do in the app:** a row each under the name of whoever wrote them, the selected
  note (and every fix waiting for the visitor's check) opened into the app's card — the timecode chip, *Change* or
  *Idea*, the version, *Fixed · V3* in green, the marked frame at the app's size, the thread as messages and one-line
  status changes, *Looks right* and *Still wrong* together under their question, *Reply…*. An agent is *Editor*
  (*Schnitt* in German), and German pages no longer say "on V1".
- The share dialog says what *All* does: *All, to switch and compare*.

### Fixed (review links)
- **Compare: after a pause, B stops on A's frame.** It stayed where playing left it, a frame or two off (the owner's
  compare and check mode too); a B that comes while A plays now plays along instead of standing still.
- The thank-you after a verdict lies at the picture's foot, centred on it, instead of over the drawing tools; a
  delivery link shows its *Download* on a phone; a link without notes ends with its foot at the bottom of a phone's
  screen; no "No notes yet" under an open composer; the folder room fills wide screens and its cards on a phone lose
  the empty band under them.

### Fixed (Settings → Billing)
- **Paying isn't set up / the payment provider refused** read as "something went wrong (ref …)" since the sweep-3
  change; a billing module may now mark exactly those two answers as meant for people, and a declined card says why.
- **The payment form keeps its room while Stripe loads**, and Pay appears only once the card field is there.
- **Stripe's form shows a card and nothing else**: no test-mode assistant over the page, no Link box, not every payment
  method the account has switched on.
- **An applied promotion code can be removed**, and a declined card is said in the error colour right under the card
  field.
- **An open payment form follows a light/dark switch.**
- **The library no longer drops when the billing banner arrives**: its room is held from the first paint (after a
  first visit).
- **The owner of the operator's own workspace** reads that there is nothing to pay, not that owners choose the plan.

### Fixed (billing)
- **A billing module's routes are held to the role they declare**: each says the lowest workspace role that
  may call it and whether only a person may; the role table enforces it whatever the module checks itself, and a
  route that declares nothing stops the server at start.
- **A billing module's server errors answer like the app's own**: one sentence and a ref, the module's text
  only in the server log.
- **A billing module's payment sources can't widen the page's policy past its provider**: no IP addresses, and
  a wildcard only over the provider's own domains.
- **Paying during the trial says when it ends the trial**: a plan the trial doesn't carry into (Business, or
  with too few days left) is billed from today, and the checkout says so.

### Fixed
- **The setup's health check names the data folder only on the machine itself**: a phone through the LAN link
  and a hosted server's admins read "Local disk · writable · 27 GB free" (a bucket's or zone's name stays).
- **A person's first run is theirs alone**: an API token can no longer end the setup, put Get started away or
  pick the agent the sample names (`PUT /api/onboarding` is people only, 403 for a token).
- **The sample can't be made and removed in a loop**: a few times per workspace in a short while (then 429 with
  when to come back), and never started while a hosted server's job queue for the workspace is full (503).
- **Several clicks on "Try it with a sample" make one sample, said once**: one answer says it was made, the
  others get the same sample; it is warmed up once, and removing it while it warms up leaves nothing in the log.
- **Agents never take the sample for work**: `vr ls`, `vr folders`, MCP `list_videos`, `list_folders` and
  the review resources leave it out; asked for by name, `vr open`, `get_open_notes`, `vr show` and `get_note` say
  "SAMPLE: … not work" first, and there are no notes to work through.

### Fixed (playing a section)
- **A section plays from its first frame, also right after the playhead was moved.** Seeks that come while one is on
  its way wait in line, and playing a section (a note's ▶, its bar on the timeline, *Play changes*, a finding) didn't
  end that line: a seek still waiting landed after the section's own and playback went on from there. Pressing End and
  then Home just before ▶ played a section that starts at 0:01 from the first frame of the video. Where playback starts
  or jumps to (a section, the start of a loop) now goes first, and what was waiting is dropped.

### Added (a new account's setup)
- **A new account starts with a short setup** (`#/welcome`, every step skippable), each step's picture on a light
  table beside it that follows what is typed and picked. Lampo Cloud: the workspace's name, who the videos are for
  (several picks, "Something else" in a few words), the agent with its connect block in place and its status live
  ("Waiting for Claude Code…" → "Connected · Claude Code from …" the moment it calls), and the team row by row (a
  pasted list splits, each row checks itself, the role follows who the videos are for). Someone invited gets Welcome
  (the workspace, who invited them) and the agent. A self-hosted server's owner gets a health check — the public
  address, the storage, the mail relay with *Send a test mail*, the speech engine — before the team and its agents;
  without a relay the invites become links. The machine finds where its exports land and links them, finds the agent
  installed, and ends at the sample. Phones get the picture as a band on top and the actions as a bar at the bottom.
- **Get started** replaces the first run's start and strip: a card above All videos, the steps on a keyframe track
  beside the selected one at work (connect the agent, link or upload a video, make a review link, invite someone,
  right there; an accordion on a phone). It folds to one line, × puts it away with Undo, a plan picked on the
  website's pricing is offered ("You picked Team · add a card any time"), and the machine offers `vr export` for later.
- **The sample opens in check mode on its fix**, its agent named after the one picked in the setup; checking the fix
  and answering its question says **That's the loop**, with the way back to the library.
- **No UI text calls the people who review through a link "clients"** any more (the new-workspace dialog and Settings
  → Workspace say "another team or brand"; German "Kunde" is gone too); `stage-words.test.ts` now fails on any UI
  string that does, apart from the software kind (MCP, OAuth, API client).
### Changed (the first run's sample: a real cut of the brand film)
- **The sample is two versions of Lampo's own brand film**, frame for frame the same, with the title "EVERY MILE, ON THE
  RECORD." over the car in V1 and on the hill in V2: Alex's must ("The title covers the car…") fixed by the agent in V2
  and waiting for a check, an idea on the opening with the agent's answer, and the agent's question with "Fade it out" /
  "Hold it" (in German too). The two files are committed in `lib/sample-film/` (about 320 KB each; their origin in its
  README, made again with `node scripts/sample-film.ts`), replacing the generated gradients.
- **It is in the library from the start**: made in the background when an account starts in a workspace of its own (an
  open sign-up's confirmation, a server's setup page, the machine's first start), in the person's language. Invited
  people find the workspace's. `VR_ONBOARDING_SAMPLE=off` makes it only on request; `POST /api/auth/verify` takes the
  page's `lang` for it.
### Added (the setup's server side)
- **A self-hosted server checks itself for its owner.** `GET /api/server/health` says whether the public address is set
  and safe, writes to and reads back the storage (with the free space), names the mail relay by host and port (never its
  password) and reports the speech engine; `POST /api/server/mail-test` sends one test mail now to the asker's own
  address (the same as `vr admin mail-test`). For the owners and admins of the server's first workspace only, and only
  signed in as themselves.
- **Who a workspace's videos are for** (`PUT /api/workspaces/current/persona`: for other brands, for our own brand, for my
  channel, something else in a few words) is kept on the workspace; Get started's order follows it.
- **The plan picked on the website rides with a sign-up** (`plan` on `POST /api/auth/signup`: `cloud-solo`,
  `cloud-team`, `cloud-business`; anything else is ignored) through the confirm link, for Get started to offer.
- **The machine's setup finds what is there**: folders with renders in a few likely places
  (`GET /api/onboarding/folders`) and the agents installed, by looking and never by running them
  (`GET /api/onboarding/agents`); both only for the machine itself.
- `GET /api/onboarding` adds the website's plan, who invited you, and the sample's note to check and its question;
  `PUT /api/onboarding` keeps the setup's end and the agent picked in it. New accounts carry `setup_due` until the setup
  is over.
### Changed (Get started)
- **Get started's steps are the sample first, then the agent, a video, a review link and the invite**, ordered by where
  the app runs and who the videos are for (an in-house team invites before it uploads, a channel alone invites nobody,
  a self-hosted server adds its first video before agents and invites, the machine links before it connects). "Leave a
  note" and "Name your workspace" left the list (the sample and the setup teach them); "Try the sample" ticks once its
  fix is checked or its agent's question answered.

### Fixed
- **A long imported history no longer hides the note made just before it**. What a waiting agent,
  INBOX.md and `vr inbox` read is the newest 2,000 to 5,000 events within 4 MB of the log; the history a
  `vr admin import` brought in was skipped there but still took its room, so a note made just before an import of
  more than 2,000 events never reached them. Imported history now goes into a file of its own,
  `events.imported.jsonl` beside `events.jsonl`, which only what reads history reads (For you, a person's part
  opt-ins, the folders' repair, `vr export`). A store imported into before keeps its log as it is: the readers pass
  those lines by before they count.
- **Only an upload may take hours to send**. The 6 hours a whole render in one PUT needs applied to every request.
  Now a render's body (a tus piece, a one-time upload URL's PUT) has the 6 hours, every other body Node's own 5
  minutes; an upload refused before its body is in has the rest thrown away within those 5 minutes.
- **The check that keeps a module off the app's own routes can't be passed by a router under a path**.
  The app's routes are read from its routers, which keep their paths without the one they are mounted under: a
  router mounted at `/x` would have listed `/y` for what answers `/x/y`, out of sight of that check and the route
  walk. None is mounted that way; one that is now stops the app from starting, so it can't come in unnoticed.

### Changed (Settings → Billing: paid on the page)
- **Paying for a plan happens on Settings → Billing itself**, no longer on the provider's own page: the billing address,
  a VAT ID, the card, a promotion code and the total with its tax in one form, with the card fields in the provider's
  frames (card details never reach the app). Only a bank that wants its own approval page is left for, and it comes
  back. The provider's script loads only when a payment form opens.
- **The billing account is on the page too**, instead of *Manage billing*: payment methods (add one, choose the one
  renewals use, remove one), the name, address and VAT ID on the invoices, and the invoices with their PDFs; an open
  invoice after a failed payment is paid there (*Pay now*). Switching plans says first what the next invoice will be;
  *Cancel plan* and *Keep plan* are on the plan's card.
- **A plan picked on the website is marked** when Settings → Billing opens with `?plan=cloud-solo|cloud-team|
  cloud-business` (anything else is ignored).
- A billing module may name the origins its payment form loads from; the hosted app's own pages allow exactly those in
  their Content-Security-Policy, review links and a person's own machine never ([server-mode.md](docs/server-mode.md#a-billing-provider)).

### Changed (the way in: a split page with the brand film)
- **Every screen in front of the app is one split page.** A review link's password, a link that expired or isn't
  available, and the owner's setup, sign-in, sign-up, "Check your inbox", the confirm and reset links, an invite and an
  app asking to connect (and its error) show the form on the right and, on the left, a panel with the logo and Lampo's
  brand film: 60 real frames of its own demo footage (F 0266–0325 at 24 fps, around 00:12:07) in slow motion, each
  dissolving into the next while their strip glides through a lit gate under a playhead and a readout says the frame
  and the timecode. It is calm, never reacts to typing, and is still on phones and with reduced motion; narrow windows
  and phones stack a slim band of it above the logo and the form. The film slate, the graph editor behind it and the
  viewfinder look (`?look=b`) are gone.
- **The form reads quieter.** Who shared the review or who invites (picture or initials, name · team, one line), the
  title and one sentence, then the fields (40 px, the eye in every password), the line kept for what went wrong (the
  field it is about shakes and turns red), the orange button without a chevron, and one short line of fine print. What
  that line leaves out sits behind a "?" (whose address to use, how an existing account joins an invite); the agents'
  `vr login` command sits behind *Sign in an agent* as a light line with Copy; the setup token's hint carries
  `vr admin create-user` the same way. Screens without a form say what they are with a small sign (an envelope for
  "Check your inbox", a broken link for a link that can't be used).
- **Nothing of a protected review shows before its password**, as before: the film is the same footage on every server
  and loads as images after the form has painted (the still first, the frames in an idle moment, each decoded before
  it moves; about 0.7 MB, and none of it on phones or with reduced motion beyond the still's 90 KB). The first-paint
  JavaScript stays within its budget (181.0 of 183 KB, +0.3 for three icons).

### Fixed (drawing on the frame)
- **A menu no longer wiggles the first time it opens.** Buttons shrink a little while pressed, and the first time a
  menu's code arrived mid-press it was placed from the shrunken button, then jumped 3 px when the button let go. Buttons
  that open a menu, popover or select keep their size while pressed: what opens is the feedback.
- **Typing in the library's search while the page still loads keeps going.** On a first visit with a slow answer from
  the server, the loading page took the first letters and the real page then replaced it without the focus: the next
  letters went nowhere. The real field now takes over the focus and the caret.
- **A box, arrow or stroke ends where you let go.** On a busy machine several pointer moves (and the release) could
  arrive before the page redrew, and each was built on the last drawn copy: a quickly drawn box came out short, a
  freehand stroke lost points. Every move now builds on the one before, and the release point is part of the shape.

### Fixed (a note's card)
- **A note's card no longer jumps when its marked frame arrives.** The thumbnail took no room until the picture had
  loaded, then pushed the thread and *Reply…* down: a click aimed at *Reply…* at that moment landed on the line above
  it. It keeps its frame's shape from the start now.
- **On a review link, a fixed note's *Looks good* and *Not yet* no longer jump when its marked frame arrives.** The
  same thumbnail on the review link's page took no room until its picture had loaded (an upright video's pushed the
  buttons 34 px down), so a visitor's tap could miss them. It keeps its frame's shape from the start now: the link's
  versions carry their frame size (optional `width` and `height` in `GuestReviewResponse.versions`).

### Fixed
- **A team's *Download all* link on the media host stops working for someone who lost access**. The zip
  is put together when its URL is fetched, and that URL lived up to 7 hours with nothing but the folder in it: a member
  removed meanwhile, a revoked API token or a signed-out session still got the folder, renders added since included.
  The URL now carries who asked for it, and the media host asks again when the zip starts, as it does for one-time
  upload URLs; it also carries what the folder held, so a zip never grows past it (a folder that changed: start the
  download again). URLs made before this change are refused once; asking again gives a new one.
- **A one-time upload URL takes one upload**. Two PUTs sent to it at the same moment both landed when
  the plan's check took a moment (a billing lookup), each passing the size and plan checks on its own; the URL is now
  taken before that check, and a refusal before any bytes arrive gives it back.
- **A whole render in one request no longer breaks off after 5 minutes**. Node's own request timeout cut
  a one-time upload URL's PUT (and a tus piece on a slow line) whose body took longer than 5 minutes to send; a
  request's body may now take up to 6 hours, its headers still within a minute.
- **An imported store's history is no news to agents**. `wait_for_feedback` handed the history a
  `vr admin import` brought in out as new feedback, and one event dated in the future parked every agent's cursor
  there, so real notes were never handed out. Imported events are now skipped by `wait_for_feedback`, INBOX.md,
  `vr://inbox` and `vr inbox`, as they already were by `vr watch`, the live stream, webhooks and push; and a bundle
  holding a time after it was made, or after the server's clock (10 minutes of drift aside), is refused.
- **An imported playbook can't write over another playbook's files**. A bundle's playbook kept its own
  ids, which decide where its skill files and reference pictures are stored: a bundle reusing an existing playbook's
  ids replaced that playbook's files, even when the import was then refused. An imported playbook now gets new ids
  (its own, its skills' and its suggestions'), nothing is put where a file is kept already, and its files go in only
  after the videos are in, taken back if the playbook can't be written.
- **What an import brings in passes the checks the app runs when it makes the same thing**. A link
  reference must be http or https and keeps no user name or password (a `javascript:` or a protocol-handler link
  refuses the bundle); a version's size, frames, frame rate and picture size are what ffprobe reads on the server, and
  a version without bytes is in no bucket; a playbook comes in only for the House or a folder name the server takes,
  within a playbook's normal limits.
- **An imported partial render can't share another video's posters and analysis**. A part version's
  sample, which names its derived files (posters, sprites, waveforms, analysis, scrub copies), was taken from the
  bundle, so it could name another video's; it is now made from the part's bytes, the version it patches and where, as
  an uploaded part's is.
- **`vr admin import` prints nothing a bundle could use to hide or forge its report**. A bundle's app
  version, warnings and the record keys named in a refusal reached the terminal as they were, escape sequences
  included. The version must be a version, every string the report prints is one line without control characters, and
  `vr`'s errors drop control characters.
- **An extension module can't open one of the app's own routes**. A module route with the method and
  path of an app route left the app's handler answering it while the guard and the role table went by the module's
  word: a module declaring a public `GET /api/library` by mistake served the library signed out. Such a module is now
  refused when the server starts, in one line; the route walk covers a module's routes too.
- **An import that fails, is killed or meets an upload leaves nothing behind**. A video's history now
  goes into the log only once the video is in (it went first, and stayed for a video that didn't come in, to be
  inherited by a later upload of the same name); a video id is marked for the import under the same hold an upload
  takes, after checking it is free, so an upload of the same name under way is never written over or taken back
  (the import stops before writing anything); one import runs in a workspace at a time; and what a killed run of
  another bundle left is taken back by the next import.
- **An import's limits and room check hold at their edges**. A bundle's history may be 500 MB (512 MB
  was past the longest text Node can read, a crash rather than a refusal); the room an import needs counts its notes
  and history, on the disk of the store's data as well; and `vr admin import` on a hosted server no longer writes an
  INBOX.md the server never reads.

### Fixed (Auto-check: the side crop)
- **Text at a normal margin is no longer "cut by the 52 px side crop".** The text reader's box runs wider than the letters
  (about 20 px before an opening quote mark at 1080 px), which is the whole margin to Instagram's crop, so a Reel with its
  text 65–70 px from the edge got a should-fix it didn't have. Auto-check now measures where the letters start and end on
  the frame it read for every line near the crop, and judges the crop by that; text over a picture, where the ground
  can't be told, keeps the reader's box. On five agent-made Reels the five false crop findings are gone and the three
  real ones (a Send button under the icon column) stay.

### Changed (review links: for anyone, not only clients)
- **A watch-only review link with no notes to show has no notes panel.** The video gets the width (on a phone the page
  ends after the controls) and "Powered by Lampo · Source" moves under the controls. A link that shows notes but takes
  none lists them read only, without a composer ("Read only: this link doesn’t take new notes."). Every kind of link
  (review, watch only, delivery) is checked at 390, 768, 1440 and 1920 in both themes.
- **The review link speaks to anyone it is sent to, a colleague, a producer or a client.** The line under the video's
  name is the link's own name when it was given one, else the team's name, else "Shared by {name}", then the version
  ("Client · V9" is gone). A link nobody named is now called "Review link" (it was "Client", or "Review" for a folder);
  visitors never see a default as a name: not under the title, not as the password page's title, not in the room. The
  share dialog's first kind is *Review* (it was *Client review*), its notes setting *Notes from all links* (was *All
  client notes*), and it says "Visitors see it’s from {name}."; German alike ("Notizen von allen Links", "Besucher sehen
  …", "Geteilt von {name}").
- **The app no longer calls whoever reviews through a review link "the client"**: a link is for a colleague, a
  producer or a client alike. The stage reads *Out for review* (was *Client reviewing*; German *In Abstimmung*) and
  *Approved V3 via link* (was *Client approved V3*; *V3 per Link freigegeben*), what it waits for *Waiting for their
  decision* / *Waiting for the link to be opened*, the next step *Send out for review*, the stepper's fourth step
  *Shared*; the one-line detail says "Mia approved V3 via review link" and "(Mia via review link)" in English too. The
  history marks those decisions *Link*, the filter and the list's column are *Review link* (*Opened*, *Changes
  requested*, *Approved*), the inbox's group *From review links* ("Mia · via review link"), Insights' card *Review
  links* with *Out for review* and *Send a reminder*, the viewers list "via For Mia", notifications and webhooks
  *Review link activity*, and the settings' and first run's sentences "people on review links", "everyone else".
  Agents keep their words (`with_client`, `client_approved`, "Waiting for the client's verdict", `client: Mia`).
- **The share dialog's limits read as two options.** *Expiry date* and *Password* are buttons until added; an added one
  is a row with its name, what it does ("The link stops working after that day.", "Anyone with the link needs it."),
  its field and a × that takes it away again (the expiry's "Never" is that ×). The password is a labelled field typed
  behind dots, with an eye to show it; one that is too short (or empty) says so under the field and no link is made
  until it is right, also when editing a link (*Set* · *Change*, × removes it on save).

### Fixed (review links)
- **The play button's glyph stands in its middle.** The pause bars were half a pixel off the circle (a 15 px glyph in a
  38 px button lands between pixels, and the browser snaps it one way): the glyph now has the button's parity (16 in 38,
  20 in 58) and no browser padding moves it; the play triangle stands a pixel right of the middle (`--ic-play-nudge`),
  where it looks centred. On the review link, the player's transport and the phone's; `share.mjs` and `mobile.mjs`
  measure it.

### Changed (the timeline's zoom is easy to find)
- **The timeline's zoom is a control you see, in the player and on review links.** Zoom out · the level ("Fit", "2×",
  "30 frames") · zoom in, whose tooltips name the keys (− = and Z / ⇧Z on the level); a click on the level fits again,
  or zooms to the marked section (else around the playhead). It was a faint "− Fit +" in the ruler's type and absent on
  touch screens: tablets now have it with finger-sized tap areas, and a phone shows zoom in alone until the timeline is
  zoomed. The first time a video longer than two seconds opens, a tip says how to zoom without it (⌘/Ctrl + scroll or a
  pinch; on a touch screen, a pinch), until it is dismissed with × or the timeline is zoomed — once per browser.
  ⌘/Ctrl + wheel zooms more evenly (a mouse notch about 1.8×, a trackpad pinch smoothly) and never the page; Safari's
  trackpad pinch, which arrives as gesture events and used to zoom the page, now zooms the timeline.
- **The zoom has a place of its own and never covers the timeline.** It sits in the transport row beside the speed and
  the sound, in the row's own buttons (the level keeps the width of its longest words, so the buttons never move while
  zooming; where the row is short, the level gives way), and on a phone in a quiet row above the ruler. It used to sit
  on the film strip and the ruler at the timeline's top right, against its end. The first-time tip is a small popover
  in the tooltips' material pointing at the control, ⌘/Ctrl as a key cap (it was a purple line inside the control); it
  takes no room, and waits while check mode's card is over the picture's foot. `zoom.mjs` and `share.mjs` check by
  bounding boxes that nothing of it touches the film strip, the ruler or the timeline at 390–1920 in both themes.

### Added (agents: Antigravity)
- **Antigravity connects like the other agents.** `vr mcp config antigravity` and Settings → Connect an agent (under
  *Other client*) give its setup: its own file (`~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json` in a
  project) with the address as `serverUrl`, which is the only key Antigravity reads for a server it reaches over the
  network. It signs in by itself, as Lampo lets clients register on their own. The app recognises it by its name and
  shows it with letters in a tile (Simple Icons has no mark for it); [docs/mcp.md](docs/mcp.md#antigravity) has the
  setup.

### Added (moving to a server)
- **`vr export <out.tar> [--folder <name>]…` packs your machine's reviews for a server; `vr admin import <bundle.tar>
  --workspace <id> --owner <email>` unpacks them into a workspace there** ([docs/moving.md](docs/moving.md)). Notes keep
  their frames, ranges, drawings, replies and statuses, sign-off keeps its history, every version keeps its bytes, and
  screenshots, voice clips, references, fix previews, folders, playbooks, the team's watching and the history (inbox,
  Insights) come along. No path of the machine travels: a video tracked from a file becomes an upload in its folder,
  under that new id everywhere it was named. Your machine's account and the names you wrote under become your account
  on the server; `--people "Name=email"` gives others theirs; agents and clients keep their names. The history is
  marked as imported: no agent, webhook, push or mail hears of it. `--dry-run` says what would happen; a second run
  brings nothing new; nothing on the server is ever written over (a video id it has is skipped, a note id it has is
  renamed). The bundle is checked whole before anything is written (sizes and checksums, a strict format, every
  version's bytes against its hash) and works with renders on disk, Bunny or S3 alike.

### Changed (polish: the inbox, uploads, the review link)
- **The inbox's selection is one calm system.** The item in the preview and the rows picked for the bar share one flat
  fill a step deeper than the row under the pointer — no lifted card, no orange. "n selected · Done · Later · ×" floats
  over the list's foot in the float material, centred (also in the bell's popover and sheet), and keeps a room of its own
  at the list's end: the last row and the prompt under the list always scroll clear of it, and a list whose end was in
  view moves on by that room as the bar comes, so it covers nothing; the keys' list (?) sits in
  the inbox view's header beside By video · By kind; the "Get a ping" prompt is a quiet footnote under the list, still
  dismissible.
- **The upload dialog can make a new project.** Its picker is one control — the search in a hairline box over the list,
  one highlight, a check on the current choice — and ends in **New project**, a row that becomes a name field in place
  (↵ creates it, / for a folder in it); a name typed in the search that isn't there is offered as "Create “name”".
  Closed, it is one select-like field (also in Add video). ↑↓ ↵ pick, Esc folds the list without closing the dialog,
  ⌘↵ uploads.
- **The upload progress is a quieter float.** The tray wears the app's float material without the ruler strip; the
  whole upload is a ring in its head, each video a thin line with "14 MB of 21 MB · 2 MB/s · 3 s left" in the UI's face;
  a click on its head leaves no focus ring behind.
- **Review link on phones:** keyboard shortcuts ("Add note ⌘↵") are gone wherever nothing hovers or the pointer is a
  finger, and a note's Reply rides in its head with the state instead of a row of its own.
### Fixed (polish)
- Settings → Notifications: a webhook's failed delivery ("failed 2 min ago: HTTP 404") was English in German.
- The upload tray's **Open** button ran off the row next to a long file name.

### Changed (the way in: one design with the client's password gate)
- **Setup, sign-in, sign-up, "Check your inbox", every confirm link, forgot and reset, invites and the new-workspace
  dialog look like the password page clients get** — the same parts, shared in code (`ui/EntryForm.tsx`), so the two
  can't drift apart again: boxed fields that take the brand's light on focus, an eye on every password, one line kept
  for what went wrong (a wrong password shakes its field and stamps the take NG), helper text under its field, and the
  orange way in with a chevron. The button is never grey while the form is empty: a press says what is missing
  ("Type your email first.") and puts the cursor there. The sentence under the title runs the slate's width; the setup's
  01/02/03 numbering is gone.
- **The top is the gate's too:** the logo and one theme button. Which server this is, its version and its source
  move to a quiet line under the slate, with room below it and a calm patch behind its words, so it never sits on
  the backdrop's ruler; "Invited? Create your account…" and the command agents sign in with (`vr login <url>`,
  copyable, never broken) sit in a quiet row under the way in.
- **The slate's cells say the same things on every screen**, like the gate's: where (the server, or the workspace an
  invite is for), the scene (SIGN IN, SETUP, SIGN UP, CONFIRM, PASSWORD, INVITE, APP), the take — or where it stands
  (SENT, CONFIRMED, EXPIRED …) — and the day (an invite: until when it works). The NG stamp sits beside the take's
  number.

### Changed (the first run: the opened Get started strip)
- **Opened, the strip above All videos is the first-run start in small**: its panel, the steps on their track from the left
  and the sample card at its own width pinned to the right edge (never stretched over half the page; under the steps on
  a phone), the next step's action a quiet button. Its buttons show focus with the soft ring instead of a hard black outline. Closed,
  it is the same one line as before.

### Fixed (player: check mode and the notes panel)
- **Check mode and the notes panel no longer disagree.** A fix reopened, checked or closed on its card in the panel (or
  by someone else, or an agent) leaves check mode's queue at once: the check card keeps the fix it is on, or moves on to
  the next one when that one was settled, and the reopened fix never comes up. A fix answered in check mode shows on its
  card in the panel at once. The queue is read from the notes themselves, not copied when check mode starts.

### Changed (player: a fix to check)
- **One decision row on a fix waiting to be checked:** *Looks right* · *Still wrong*, the reason and its microphone
  opening in place — the same component as check mode's card, so both ask and send the same. The reply field moves
  below it, full width: "Reply without changing the status". Typed there, the words go with **Send as reply** (⌘↵, the
  fix still waits to be checked) or **Send and reopen**, both named, so a reply is never taken for a reopen. What agents
  read for a reply or a reopen is unchanged.

### Added (replies)
- **Edit and delete your own replies.** A ⋯ on your own reply edits it in place (⌘↵ saves, Esc cancels, then
  "edited") or deletes it with Undo. Only its author may — by account, not a role; with an API token as with the
  person's own notes — and only plain words change: status changes, picks and fix previews stay as they happened. New
  routes `PATCH` / `DELETE /api/comments/:id/replies/:n` ([api.md](docs/api.md)); agents read the reply as it is now
  (`↳ Sam: … (edited)` in `vr` and MCP `get_note`), the change as `EDITED REPLY`, a deletion as `DELETED REPLY`.
  Replies now record the writer's account (`by_id`). Review links' visitors can't edit notes, so not replies either.

### Added (hosting: a host of its own for video)
- **`VR_MEDIA_ORIGIN`: video on a second host name of the same server**, for an app host behind a CDN proxy that must
  not carry video (Cloudflare's terms, a 100 MB request limit). The player, review links, downloads, fix-preview and
  reference clips and *Download all* zips are redirected there with signed URLs, as with Bunny or S3: they name no video
  or folder (AES-GCM sealed), live 6 hours for the team and 5 minutes on a review link, and the same file gets the same
  URL within a minute or an hour, so the browser keeps its cached ranges. The media host answers nothing else (no page,
  no API, no cookie). One-time upload URLs point there too, so a whole render never meets the proxy's request limit. A
  link's zip is asked again when it starts (revoked or expired: refused). The setting is refused at start when it
  isn't an origin of its own, plain http off this machine, or the public URL's host. `scripts/smoke.ts --media` checks
  it ([server-mode.md](docs/server-mode.md#a-host-of-its-own-for-video), [go-live.md](docs/go-live.md#behind-a-cdn-proxy)).
- The page, the live stream and every answer that carries a secret say `Cache-Control: no-transform`: a CDN in front
  neither compresses what the app leaves uncompressed on purpose (BREACH) nor rewrites the page its CSP pins.

### Changed (player: the phone view)
- **The phone view looks like the phone and the app.** Each phone is drawn from its public dimensions: iPhone 15/16,
  16 Pro and 16 Pro Max with the Dynamic Island, Apple's 9:41 status bar, the home indicator, their corner radii and
  side buttons; the iPhone SE with its home button, chins and classic status bar; the Pixel 8 with its punch hole,
  Android's status bar and the gesture bar. One menu chooses what the phone shows — **Off · Full height** (the video
  over the whole screen, top to bottom, under the status bar only) **· Instagram Reels · TikTok · YouTube Shorts ·
  Stories** — and the phone, with *Show safe zones* to draw the preset's zones over the app. Each app is its current
  interface in generic glyphs (no logos): the top bar, the rail with its counts, the name, Follow or Subscribe, two
  lines of caption with "more", the audio line, the tab bar; Stories' progress, header and reply field. The app *is* the
  safe-zone preset (one choice, so the two never disagree); V brings the last choice back, G cycles the presets as
  before, and a phone's More has the same choice. The drawings load with the phone view, not before it.
- **Safe zones corrected against the apps as they are now** (`web/src/player/zones.ts`, each with its source): Reels'
  top bar 14 % (Meta's guidance) and its rail down to the audio's cover, TikTok's and Shorts' top bars under the status
  bar, their rails as wide as the buttons, Shorts' rail to the bottom. Off the phone view the stage keeps the plain
  zones; Reels' old drawn mock moved into the phone view, where every app has one.

### Changed (review links)
- A browser's Do Not Track or Global Privacy Control signal no longer changes what a review link records: every
  client's visit, the name they type, how far they watched and their downloads are recorded alike, so the team sees who
  watched (decided 2026-10-03). The team's own viewing is unchanged.
- **A review link on a phone is laid out like an app's screen.** One compact bar that stays at the top while the page
  scrolls — the title, *Approve*, and ⋯ for *Request changes*, versions, downloads and the theme — the picture across
  the whole width with the drawing tools in a strip under it instead of over it, one row of playback controls (step,
  play, step, timecode, speed, sound), then the notes. Tablets name their buttons again (*Download*, *Request
  changes*) instead of showing an undo arrow.
- **The name is asked when it is first needed**, not in a card above the notes: in the composer as the first note goes
  (↵ sends both), in a small dialog (a sheet on phones) when Approve, a reply or a check comes first, and the notes'
  head shows who is writing (tap to change). Where it is asked, the page still says who sees the notes.
- The notes say what to do once, in the empty list (without "press C" on a touch screen), not again above it; the
  notes' head shows how many there are. A note's *Reply* keeps its quiet size on a phone. Clients no longer see the
  picture's size in pixels under it.
- **"Powered by Lampo"** sits quietly in the middle at the foot of the room and the video page (the notes column's
  foot on a computer), linking to lampo.video, with *Source* beside it for the AGPL-3.0 §13 offer (`source_url`);
  German "Bereitgestellt von Lampo" · "Quellcode". Neither link sends the review link as referrer.

### Fixed (review links)
- On an iPhone, the page scrolled under the status bar and its clock ("Notes" behind the time): the bar now stays at
  the top and makes room for the status bar and the notch (`env(safe-area-inset-top)` with `viewport-fit=cover`), the
  page's foot clears the home indicator, and the thank-you after a verdict hangs under the bar instead of over the
  menus that rise from the bottom.

### Added (developing Lampo)
- **Test only what a change can affect**: `npm run test:changed [base]` runs the unit tests that import a changed
  file (directly or through local imports, through a helper they call, or by naming it as a path), and
  `npm run test:e2e -- --changed [base]` the browser suites that cover it. Each suite's first line says what it tests
  (`// covers: …`), and the import graph does the rest; the data contract, the shell, the UI building blocks, the
  tokens and the dependencies run everything, and the run names the file that chose each suite. The base is `main`
  (else `origin/main`), plus what isn't committed. CONTRIBUTING.md "Testing what you changed".
- `VR_TEST_JOBS=<n> npm test` runs n test files at a time.

### Changed (CI)
- The public repository runs every CI job on GitHub's `ubuntu-latest`. A private copy can send check, unit and the
  browser suites to a self-hosted runner for pushes to main and pull requests from its own branches; a pull request
  from a fork or from Dependabot, and the Docker build, always run on GitHub's `ubuntu-latest`. A job on a self-hosted
  runner installs nothing: it checks for ffmpeg, tesseract, hunspell, fonts and Chrome's libraries and names what is
  missing (`scripts/ci-runner.sh`), keeps temp files and the npm cache in the runner's work dir, holds no token on disk
  and stops whatever it left running.
- The tests hold on a Linux server as on a Mac. The browser suites' Chrome is a desktop with a mouse everywhere
  (`hover: hover`, `pointer: fine`, also after a resize; headless Chrome on a server without input devices reported
  neither, and the app showed its no-hover layout). A unit file with a top-level `after()` keeps its imports above its
  first test (Node 22 ran the hook early; `test-files.test.ts`). Tests no longer assume the temp dir lies outside
  `$HOME` or that two mails sent at random moments arrive in one order.

### Added (hosting: a billing provider)
- **Settings → Billing**, where a billing provider runs (a module behind the extension point; a self-hosted server has
  none and shows nothing of it): the workspace's plan and where it stands — a trial and its days, the free plan, paid,
  a grace period, read-only — what it uses of what the plan holds (members, storage, videos under review), and for
  owners and admins the plans monthly or yearly in the currencies offered. Choosing one opens the provider's own page
  and comes back to the new plan; *Manage billing* opens the provider's page for invoices, the payment method and
  cancelling. In English and German.
- A banner above the library when a trial is in its last three days, a payment is overdue or the workspace is
  read-only; a plan's refusal (a 402) says why in one sentence, in the page's language, with *See plans*.
- The extension point: a module may answer sign-ups (it places the person as the server would, then starts what its
  plans give a newcomer), email a workspace's owners and admins in its own words through the server's mailer and
  layout (links only into the app), say it provides billing (`/api/info`), give its 402 sentence in more languages, and
  stop its timers with the server ([server-mode.md](docs/server-mode.md#a-billing-provider)).

### Added
- **Publish a final video** to YouTube, Instagram and Facebook ([docs/publishing.md](docs/publishing.md)): one post
  per platform per final version — title, description or caption, tags, a cover on an exact frame, visibility, a
  time, YouTube's category and *made for kids*, Instagram Reel or feed, the Facebook Page, and a required answer on
  realistic AI-made content; each platform's limits said as you write. Agents draft (MCP `draft_post`, `vr post
  draft`); only a person (owner or admin, in the app) publishes, after a confirm that names the platform and account.
- **Connections** in Settings → Publishing, per workspace, with your own keys: YouTube through your own Google Cloud
  OAuth client (resumable upload, `publishAt`, the cover; uploads from a project that hasn't passed YouTube's API audit
  stay private, and Lampo says so), Instagram and Facebook through Zernio. Keys and tokens sealed at rest, never shown
  or logged; every request through the address guard.
- **The publish queue**: posts go out at once or at their time, passing failures are tried again, a reopened final
  pauses what waits, an upload resumes after a dropped connection or a restart; status and history on the video
  (`StageInfo.published`), failed posts in the inbox, `post` events for webhooks and push, `vr post` and MCP
  `get_posts` to read them.
- **The publish kit**, no connection needed: each platform's encode, an SRT from the transcript, the cover frame, the
  copy as text, and all of it as one ZIP.
- **Publishing in the app**: *Publish…* is a final video's next step (and in the video menu); the composer has one tab
  per platform with its mark, saves as you type, picks the cover on the player, and shows the post's state, link,
  history and kit. Settings → Publishing adds and checks connections; the stage line says where it was published,
  failed posts wait in the inbox with Try again, and a *Posts* push switch joins Notifications. Loaded on demand, in
  English and German, from phone to desktop.

### Fixed (publishing, delta review)
- **A post that went out is never posted twice by Lampo**. A posted or scheduled post whose later look
  failed for good (a revoked Google sign-in or posting key) turned "failed", and Retry uploaded it a second time; a
  post the posting API kept working on past six hours did the same, and a stop while YouTube's cover was set uploaded
  the final again on the next start. Now a look that fails keeps where the post stands and marks the connection; once
  a send reached the request that makes the post, a failure without an answer is *sent, not confirmed* (`sent`) for a
  person to look, instead of a new try; YouTube's upload session is kept until the video's id is; Retry asks the
  platform again about a post it holds, and sending one that went out before needs the person to say so (`again`).
  None of it depends on the posting API honouring its idempotency key.
- **What goes out is what the person saw**. The publish confirmation named only the platform and account, so an
  agent's edit to the caption, the time or the cover just before the click went out under the person's name. It now
  carries the post's `digest` (every outgoing field, as shown); anything edited since is a `409` to look at again, and
  every edit is in the post's history with who made it.
- **One team's posts don't hold another's back on a hosted server**. The publish queue sent one workspace's due
  posts all before the next workspace's, with a post's encode made inside the send slot every team shares, and a
  platform answering a byte at a time could hold it past its timeout. Teams now take turns like the job queue's; the
  file and cover a send needs are made before its turn; every platform request has a wall-clock deadline; a kit's
  encode is a job under the workspace's cap (`503` when it is full) instead of owed work.
- Retry asks the plan's gate as Publish does. An agent's token changes and deletes drafts only: a failed or
  cancelled post — the inbox's work for who may publish — is a person's to change or delete, and a post that went out
  before is never deleted, by anyone.
- A deleted video's publish kit and cover are no longer served, and its posts don't attach to a later video of the
  same name (posts are bound by the video's id). The cover frame is held inside the version and one cover is
  kept per post. The Instagram and Facebook encode carries none of the render's own metadata.
- Reopening a final with a YouTube post that YouTube holds as scheduled asks first and says that schedule stays live
  (take it back in YouTube Studio), in the player and on the board; the docs said reopening paused it.
- Publishing's UI follows: *Sent, not confirmed* posts wait in the inbox; Retry says *Try again*, *Check again* (the
  platform holds it) or *Post again* (behind its own confirm); the publish confirmation carries the post's digest and
  shows an edit made meanwhile; Delete is hidden for a post that went out; edits show in the history.
- Publishing's smaller points: an upload's progress is saved every ten seconds and tells the post's page, not
  the library; only https links from a platform are kept; `draft_post` takes the API's caps; video names in `get_posts`
  and `vr post` are one line; the seal's workspace binding has a test; docs/publishing.md says that on your machine any
  local program is the owner.
- **Never twice, the rest of the ways out of a send**: a post whose tries
  ran out, or that a person cancelled or a reopened final paused, after its upload's last bytes or the posting API's
  post call went out was `failed` or `cancelled`, so Retry or a new publish uploaded it a second time; it is now *sent,
  not confirmed*. A kept YouTube session YouTube no longer knows after the last bytes went out is no reason to upload
  again. The platform's clear "no" to the post call (a slow-down, say) no longer turns the next try into *sent, not
  confirmed*. Publishing without the digest of what the person saw is refused in the store too, not only by the route,
  and the confirmation shows the post's visibility and time as confirmed.
- **Teams take turns with posts published mid-pass too**: the queue looks at what is due before every turn, so
  a post published while another team's uploads run waits behind one more of them at most, not the rest of that
  team's backlog; a send whose file is still being made takes its turn when the file is ready.
- Publishing's hardening notes: adding a posting-API key or changing one counts against the checks' limit;
  what a platform says about its accounts is kept one line per field, 120 characters, 100 accounts; the damaged
  `secret.key` message and go-live's backup section say that a new key costs every publishing connection and any
  unfinished upload; docs/publishing.md says what reviewers read of posts, on purpose.

### Changed
- **Insights asks why a video takes so many versions to approval, and what would cut that.** It answers in a sentence
  ("7.8 versions to approval, up from 5.1. SFX notes cause most of the rounds."), then four tiles (versions to
  approval with its median and the target ≤ 3, the rounds the top topic came up before, right the first time,
  turnaround per round and whom it waited on) and cards that each answer first: *What causes the rounds* (each new
  version that followed notes, by the notes' topics, with *Make it a rule* — the playbook opens with the rule drafted —
  or "Rule exists — still 6 rounds"), versions to approval by project against the target, *What came back* as still
  wrong by topic and agent, agents right the first time, *Where it's stuck now* with the one thing to do (nudge the
  agent, remind the client, open it), and the clients who watched through review links. Every figure against the
  period before; with too little history the page says what shows after how many approvals. The team's own watching
  left the page (the API keeps it). `GET /api/insights` adds `toApproval`, `causes`, `stillWrong`, `turnaround` and
  `firstTime` (`lib/insightsRounds.ts`), `stuck[].agent` and a client viewer's version, link, plays and stretch watched
  again; nothing is renamed. The page loads as its own chunk (the first paint: 183.1 → 178.3 KB).
- **The notes panel reads calm at 25 notes and more**: one row per note — timecode, its severity as a keyframe glyph,
  the first line, where it stands when that is news (fixed, a question, carried over), replies, a section's length —
  with who wrote it and when said once above each person's sitting, like a chat; the picture comes under the pointer.
  The selected note (a click, ↑ / ↓, or the playhead stopping on it) opens in place into its card — picture, thread,
  references, actions — one at a time; no red outline on every must. The notes' tags are chips with counts under the
  filters (picked: the list narrows, with Open / Mine / Closed / All). While playing, the note at the playhead is
  marked and the list follows it unless you scroll or type. Phones: the same rows at a finger's height.
- **Auto-check is one chip in the notes panel's head** instead of a card above the notes: quiet "✓ Auto-check · 5
  minor", "◆ 2 to check" in the problem colour, "Checking…" while it runs; it opens the findings in a popover (a sheet
  on a phone) — what looks like a problem first, the minor ones folded under them, Run again in its head, what the
  spelling check read in its foot. The timeline's diamonds open it on their finding.
- **Auto-check's safe zones are the phone view's**: text is flagged under today's Instagram Reels zones — the top 14 %
  (269 px of 1920, was 220) and the rail as it is since its repost button (890–1028 across, 1100–1900 down, was
  905–1000 × 1165–1750) — from the same numbers the Reels preset and the phone view draw (`lib/zones.ts`). The finding's
  words and zone names (`ig-topbar`, `ig-icons`, `ig-caption`, `ig-crop`) are unchanged.
- **CI is green on its first GitHub run and says what it didn't check.** Every job has a time limit; every suite runs
  and every failure is listed, the run failing at the end; the browser suites run in two parts of equal time on the
  cached chrome-headless-shell; macOS (unit + WebKit) runs only on demand (`macos` label or Run workflow); the
  styleguide's pixel comparison reports *skipped* (a warning, never a pass) until Linux baselines are committed from
  the run's artifact, and perf's time budgets are warnings on CI's runners (counts and the bundle stay strict).
- **One runner for the browser suites** (`test/e2e/lib/suites.mjs`): every `test/e2e/*.mjs` on the harness is a suite
  (no list to keep); `npm run test:e2e` runs all of them one after another, `test:e2e:parallel` side by side, both
  listing every failure, a hung suite stopped after 15 minutes.
- **The unit suite holds under load.** API tests start their app through one `startApp` (`test/lib/app.ts`) with
  production's keep-alive — Node's 5 s default reset sockets when a synchronous ffmpeg or `vr` blocked the test's
  event loop on a busy machine (ECONNRESET); waits are for states, not times. Generated clips are encoded once per
  machine (`<tmp>/vr-test-media/`). New guards: the refusals and limits no test reached, `vr admin`, and a frozen store
  in the oldest data format (`test/fixtures/store-v0/`) whose agent-facing text must not change.
- **Every way access ends is held to cutting open MCP waits and listens** (`test/unit/access-ends.test.ts`): signing
  out, signing out everywhere, a new password, a removed account, an app disconnected by an admin, and an app revoking
  its own refresh token. Each fails if that way stops calling `accessEnded()` (then the next note reached the wait).
### Fixed
- Switching between English and German in Settings → Appearance changes every word in place: no reload, no empty page
  or loading states, nothing on screen moves; the section stays open, dates and numbers follow, other tabs switch too.
  Before, the page reloaded, and a status kept from the last visit could switch it back and forth several times (the
  theme too): the account's choice is now followed only as the server says it.
- Compare and pick: the row the keys act on lights up like a hovered row; its square outline sat on the list's rounded border.
- The safe-zone menu names TikTok and YouTube Shorts without "(approx.)": their zones are measured from the apps, as the Reels icons are.
- A section dragged on the timeline ends on the frame where it was let go. On a busy machine the release could reach
  the timeline before its last moves were drawn, and the section ended a frame or two short (on a review link too).
- Publishing's warning on a YouTube video over 15 minutes says what YouTube asks for — "YouTube allows it only on an
  account confirmed by phone" — instead of "the YouTube account must be verified" (the UI never says "verify": a fix is
  *checked*).
- Auto-check said "Spelling checked in Norwegian Bokmål" (or Danish, Italian) for German or English on-screen text,
  and checked the words in that language: macOS's language guess on a few words of captions and names was taken as it
  came. The language now comes from the video's transcript, your voice-note languages and the server's speech
  languages, decided by the words themselves; a language nobody expects only for a long text the guess is sure of.
  Older results name only German or English.
- The agent menu shows the latest run of a session when two started within the same second (a run stopped and the
  next started at once): it showed the older one, so a finished run could read as stopped (found by wake.mjs).
- A command or token to copy in Settings (a fresh API token's setup, Connect an agent, `vr login`) breaks lines at
  spaces only. A token is base64url and the browser broke a full line after one of its `-`, so on a phone or a tablet
  the token in the Claude Code command could split across two lines, depending on the token drawn; a URL could break
  after a `/` the same way. Each run of non-spaces now stays whole and a line too long scrolls sideways. The browser
  check measures a token with a `-` every few characters at 390 to 1920 px, so it no longer passes by luck.
- The confirm page's *Choose your password* screen no longer lists the workspaces the account "joins": a new password
  leaves the invites taken with the old one behind, so it now names them as left behind (who invited, which role),
  and the list of joins stays on the screen that asks for the original password, where it is true.

- **A folder path has a depth limit, so no request can hold the server up making folders.** A folder path named for a
  write is now at most 12 levels and 400 characters, refused with a 400 (never cut to fit) everywhere a folder comes
  in — `POST`, `PATCH` and `PUT` on folders, `POST /api/asks`, upload metadata and upload URLs, the MCP tools
  `move_video`, `track_video`, `request_upload` and `ask_options`, and `vr move`, `track`, `push` and `ask` before they
  send anything; a rename can't carry a tree past them either. Making a folder and saving folders.json take one pass.
  A folder a store holds from before still lists, opens, downloads, is renamed and deleted.

### Fixed (accounts and workspaces)
- **A confirm link never hands someone else's password to the address's owner.** A held account's link confirms at
  once only in the browser that chose its password (or signed in as it). Anywhere else the page asks for that password
  — the same person on another device is in, signed in there — or for a new one, which leaves the invites taken with
  the old password behind and ends whatever it could have made; it says which workspace and inviter confirming would
  join. Signing up with a held address and another password sends a reset link instead of the link; with
  `VR_SIGNUP=invite` asking sends the invites made out to the address too.
- An invite sign-up held from before the invite fix (made from an invited address alone, with the invite's role) whose
  confirmation had been moved to another inbox can no longer be confirmed from there: the server drops such a pending
  change of address and its link at start, so only the invited address's own inbox confirms the account.
- Signing up a second time in the same browser (another address, or the same one again) no longer stops the first
  confirm link from signing that browser in: the browser keeps one mark for all its sign-ups and taken invites.
- Two workspaces asking for the first run's sample within the seconds it takes to make one each get their own: the
  second was told its sample was made and had none (and the first's was warmed up in it).
- `VR_WEBHOOK_ALLOW_PRIVATE` no longer opens the server's own network to every workspace: it lets the first workspace's
  webhooks (the operator's own team) reach private addresses, and every other workspace's stay on public addresses —
  when they are saved, tested and sent. A hook another workspace saved to a private address before stops being sent.
- **Only the owners of workspace #1 make workspaces now, unless the instance says anyone may**
  (`VR_WORKSPACE_CREATE` defaults to `owners`; it was `anyone`). Whoever runs a workspace invites and emails people and
  takes turns in the job queue, so accounts made for the purpose could each run one and push other teams' posters and
  previews back. With `VR_WORKSPACE_CREATE=anyone`, each account makes at most `VR_WORKSPACE_CREATE_LIMIT` (3; the
  workspace its sign-up gave it counts; #1's owners have none), counted on the server, and *New workspace…* is offered
  only while it may. Sign-up (`VR_SIGNUP=open`) still gives each person a workspace of their own.
- An API token is told of its own workspace only: `/api/auth/status`, `/api/auth/me` and `/api/workspaces` no longer
  list the names, ids and sizes of the person's other workspaces to an agent given a token for one of them. The
  switcher in the browser still lists them all, and `vr login` still names the workspace a token works in.
- Someone who signs up with your address and never confirms it no longer keeps you from moving your account to it: the
  link goes to that inbox, and confirming it there removes their sign-up.
- A sign-up confirmed with a link asked for late in its week is no longer removed before the link can be used: the week
  counts from the newest link sent to its address.
- **One address is one account.** Another spelling of an address (full-width letters, another Unicode form, a domain
  written in Unicode or with a trailing dot) is that address, and letters from another script that look like ours,
  invisible characters and addresses no email can reach are refused for sign-ups, invites and new addresses. Accounts
  made before sign in as they did.
- Whether an address has an account no longer shows in how busy the server is right after *Forgot password?*, a
  sign-up, *Send it again* or taking an invite: the link and email for an existing address are made a moment later.
- A plan's member limit (Lampo Cloud) holds when someone confirms an invite they took earlier: with no room left, the
  confirm link is refused and stays good for when there is.
- Someone holding an invite link made out to an address can no longer find the address by trying one after another:
  after a few wrong addresses the invite answers "try again later" for a while, whatever address is typed.
- A sign-up waiting for its address to be confirmed can no longer find out the names of other teams' people by
  renaming itself: its name is told apart in the workspaces it joins, when it joins them.
- Two people invited into one workspace under the same name no longer both join as it: the one confirming second is
  asked for another name on the confirm page (names tell people apart on notes).
- A held account whose invite someone else took first is refused every time its confirm link is opened (*This invite
  can't be used*): a second try used to confirm it into no workspace at all.
- **Disabling someone on a server with workspaces shuts them out of that workspace only.** A workspace's admin could
  disable the account of anyone who worked only there, and the address was then dead on the whole server: no reset,
  sign-up or other team's invite could bring it back. Now *Disable* suspends the membership — no role in that
  workspace, its tokens and apps of theirs end — and the person keeps their account: they sign in, reset their
  password and join other workspaces as before. The admin can let them in again; a person in several workspaces can be
  disabled in one without the others hearing of it.
- Links from outside the app name their workspace on a server with several: a notification, a chat webhook's link
  and an agent's "open in the player" link open the video in the workspace it belongs to (the app switches there
  first) instead of whichever the browser was in, where a video of the same name can be another team's. Someone who
  isn't in that workspace is told so and lands in their library.
- An app is connected (OAuth) to the workspace its consent screen named, never another: when the session switched
  workspace in another tab between seeing the screen and pressing Allow, the answer is refused, the screen shows where
  the app would work now, and the person answers again. `POST /api/oauth/requests/:id` takes the shown `workspace`.

### Fixed
- A review link's page no longer tells a client that only people with this link see their name: a link to the same
  video that shows all client notes shows theirs too. It now says who does see the notes: the team, and anyone with
  this link or another that shows all client notes.
- The UI keeps to its words in a few more places, English and German: *version* where it said "render" (Auto-check's
  summary, the playbook's brief and rules, Final on a partial version, linking a file on this machine), *write notes*
  and *check fixes* in what reviewers do, *Writing as* on review links where it said "Commenting as"; the list layout's
  open-notes count says "3 open notes, 1 must-fix" in the UI's language instead of "3 open, 1 must".
- `npm run link` works on a machine without `~/.local/bin` (a stock Mac): it makes the folder, links `vr` there, and
  says which line to add to the shell's profile when the folder isn't on the PATH.
- Review links offer the app's source (AGPL-3.0 §13): the room and the video page end with one quiet line linking to
  `source_url` (the link's answer carries it as `source`, before the password too). The Docker image carries OCI
  labels: its source (`SOURCE_URL` build argument, the repository by default), licence and the commit it was built from
  (`REVISION`; CI passes it).
- A review link names no folder above what it shares (folder names are often client and project names): a video link
  sent its video's whole folder path, a folder link the full path of its folder, and a password link that path before
  the password. Now a video link names no folder, a folder link its own name and where each video sits below it, and
  a locked link none.
- A newest-only review link no longer serves a still of an older version through a frame reference another link's
  note brought in: the moment shows, its picture doesn't, and the file answers 404 there.
- Writing on a client's note says the client reads it: what the team writes there (a reply, a reason) and what an
  agent writes (its fix note too) reaches the client word for word. The reply field and check mode's reason on a
  client's note say "Mia can see this on the review link", and agents read `CLIENT: they read your replies and fix note
  as written` in the note's head line (`vr open`, `vr show`, the MCP notes; SKILL.md says to keep paths and team remarks
  out).
- Signing out leaves nothing of the account in the browser's storage: the sidebar's open folders, collapsed projects,
  the player's last video and zoom per video, the machine's last folder, Insights' remembered layout and the tab's last
  library view went with the session's other data only on "Sign out everywhere"; now every sign-out clears them. The
  theme and language chosen on the device stay.
- The installed app's service worker no longer keeps every build's code forever: each version has its own cache and
  deletes the older ones when it takes over, and icons (whose names don't change) are refreshed in the background, so
  a new icon shows on the next load.
- Over https the session cookie is `__Host-vr_session`: the browser takes it only from this exact host, Secure, for the
  whole site, so a sibling subdomain can't set or overwrite it. Nobody is signed out by the change: a browser holding
  the old `vr_session` keeps its session, and its next request moves it to the new name. Over plain http (the app on
  your own machine) the name stays `vr_session`. The health checks, `robots.txt` and the 404 of a path spelled another
  way now carry the same protective headers as every other answer.
- An app that runs the sign-in in a popup and listens on `window.opener` (as browser and desktop MCP clients do) now
  hears the answer after Allow: the consent page and the redirect to it no longer cut the popup from its opener
  (`Cross-Origin-Opener-Policy: unsafe-none` there, `same-origin` everywhere else). `/oauth/authorize` sends the person
  to `/?consent#/oauth/<request>`.
- Query strings are checked like request bodies: a version that isn't a positive whole number (`?v=0`, `?v=abc`,
  `?v=1&v=2`), an array where one value belongs and similar junk answer `400` naming the field, on review links and for
  the team alike, instead of being read as the newest version or as "unknown".
- `npm install` reports no vulnerabilities: the browser suites' puppeteer-core is 25 (it was 23, whose
  `@puppeteer/browsers` pulled in `extract-zip` and `basic-ftp` with 7 high advisories); the app's runtime dependencies never were affected.
- TRADEMARKS.md covers the name Lampo and its logo only; the technical name `video-review` is not claimed. NOTICE.md
  no longer lists OpenAI's mark among the current Simple Icons release (it is from 15.22.0, the last that carried it).

### Changed (the docs)
- **The docs say what the app does today, and say it shorter.** Every page was checked against the code: the agents,
  MCP and API pages, review links, where a video stands, playbooks, the inbox and the phone, speech, taste,
  configuration (every setting the code reads, none it doesn't), Docker, hosting, the data format and the
  architecture. Each starts with what it does and the shortest way to do it; steps are numbered, settings are tables,
  deep detail moved to a closing Details section, and code stays for what you type or copy. Client setups are one
  short block per client, checked against each client's own documentation. No line in a code block is wider than a
  page of docs (a test holds them to it), so code keeps its columns and never scrolls sideways.
- **The docs show the app.** Twenty pictures of the real app where a page explains a screen — the board, the inbox, an
  agent's question, check mode on a fix preview, the live agent menu, recorded feedback, the transcript, the share
  dialog and a link's activity, a client's review room, settings, a playbook, the MCP review card, a hosted server's
  setup and an app's consent screen — and the README's pictures taken again from today's UI, each in the dark and the
  light theme. `npm run screenshots` makes them all again from the synthetic demo (`--only` for some). How Lampo fits
  together is a diagram now instead of a text drawing.
- Settings → Connect an agent and `docs/mcp.md` name the chat apps' menus as they are now: Claude's *Customize →
  Connectors → + Add → Add custom connector*, and ChatGPT's developer mode under *Settings → Security and login* with
  the app made at chatgpt.com/plugins.

### Fixed
- `/oauth/authorize` no longer sends anyone to an app's address before they decided on the consent screen. Every
  problem before the decision (an unknown client or address, PKCE, the response type, the resource, the scope) now
  shows Lampo's page "The app can't connect", and that page shows its own words for a fixed set of codes: a link to it
  can no longer put someone else's sentence in Lampo's frame.
- On a person's own machine, a page the owner opens on another site can no longer make the owner's requests. A request
  another site makes the browser send (and this machine on another port) is refused unless anyone may ask it: the
  app's pages, sign-in, OAuth and review links. Renders, frames, posters, screenshots and API answers also tell
  browsers that only this origin may load them (both modes). Agents, `vr` and the LAN link work as before.
- `vr playbook skill --files` and `vr playbook export` no longer write a file wherever the server's name for it points.
  Every skill and file name is now checked before the first file is written: a name that isn't plain, or that would
  land outside the folder (also through a symbolic link already there), stops the command and nothing is written.
- On a hosted server with Bunny or S3, a review link's video no longer keeps playing for up to 6 hours after the link
  is revoked, expires or gets a password. The signed storage URLs a link's visitors get (renders, previews, reference
  clips, downloads) now live 5 minutes; the bytes still come straight from the CDN or bucket, the server checks the
  link every time it hands one out, and the player fetches a fresh one when an old one stops working and plays on from
  the same frame. The team's player keeps its 6 hours.
- The MCP tools take the HTTP API's limits on what they write: a note, reply, fix note or reason over 20,000
  characters, a tag over 60, a status over 200, a render source, caption, link or playbook suggestion over the API's
  caps is refused instead of going into review.json. Both ways in share one set of schemas. A reference or fix
  preview sent inline over MCP, or an upload URL for one, now asks the workspace's plan like the HTTP API does, so a
  read-only workspace refuses it with its sentence. The tool list doesn't grow: the limits are checked, not announced.

### Fixed (options)
- An option's file the server fails to store — the bucket refuses it, ffmpeg dies on it — no longer hands an API
  token, an agent over MCP or anyone else but the machine's owner at the machine the bucket's error XML, the storage
  key, an internal address or ffmpeg's output as a 422: they read a sentence with a reference (the details are in the
  log under it), and a store's failure answers 5xx, the server's fault rather than the file's. The machine's owner
  still reads which item failed and why.
- A sound offered as an option can no longer keep the server's processor busy for long: its header must say at most
  192 kHz and 8 channels (a clip's sound too, references on notes included) before anything decodes it, every ffmpeg
  run on a reference's or an option's file stops at a time limit of its own, and a question's files go through the
  server's job queue one at a time instead of all at once. A hosted workspace whose queue is full answers 503 with when
  to try again, and keeps nothing of the question
 .
- A question may show at most 8 moments of renders, and they are grabbed in the job queue like its files, not inside
  the request. More than 8 is refused before anything is grabbed.
- Questions asked on folders can no longer grow their workspace's file without end: their number and the file's size
  are bounded, answered ones go first, a question keeps at most 50 answers (on a video too) and 5,000 characters of
  text, and the file is read once per change. A file of the wrong shape is no longer read as empty and written over;
  asking waits until it is put right, and other people read a sentence instead of its path
 .
- A question whose project was deleted (it waits on no folder) reads as a folder's question in `vr watch`,
  `wait_for_feedback` and INBOX.md (`ANSWERED c_… folder - by …`), no longer as a video's line with `undefined` in it
 .
- An option's file that arrives through its upload URL after the person answered or closed the question is refused
  (409) instead of changing an item they already picked from without anyone hearing of it.
- A question whose upload URLs are refused (too many open) is no longer stored and announced without them: the URLs are
  handed out first. Over MCP an item of words alone no longer takes an upload URL; ask for one with `upload: true`
  (`ask_options` items that had neither a file nor a link used to get one each).
- `ask_options` checks what it is sent the way `POST /api/asks` does — the question ≤ 5,000 characters, the prompt,
  labels, ids, links and items within the API's bounds — before anything is read. The bounds are checked, not
  announced: the tool list doesn't grow.
- An option's file sent inline with `ask_options` asks the workspace's plan first, like `POST /api/asks` and the
  references and fix previews sent over MCP: a read-only workspace refuses it with its sentence and no question is
  made (an upload URL's file is asked when it arrives).
- An option's sound is read only in the codecs sounds come in (PCM, MP3, AAC, ALAC, FLAC, Vorbis, Opus, AC-3); another
  (MS ADPCM, WavPack …) is refused from its header before anything decodes it, and a file that is no picture, clip or
  sound says so with the formats to send (a raw FLAC was told it was "not an image or a video").
- A stored sound or clip keeps none of the sender's tags or chapters. Loudness is read only from the meter's own summary,
  and a true peak that can't be read is unknown — such a sound is no longer raised as if it had room.
- `vr ask` against a hosted server sends a question's files inline only while the request stays under the server's
  limit, the rest through upload URLs (four 6 MB takes were refused as "request entity too large"); `ask_options` over
  HTTP says what fits inline there (≤ 700 KB, `/mcp` takes 1 MB a request) instead of 8 MB.

### Fixed
- A storage key can no longer name a place outside the store: a render's key names its video by an id a review could
  have (as fix previews and references did already), and no part of any key may be `..` or `.`.
- Deleting a video, a sample or a folder's files on S3 storage no longer leaves an object behind whose key holds an
  escaped character such as `&lt;` spelled out, or a control character: the listing's keys are read as XML text in one
  pass.
- The HTTP API no longer takes a version the video doesn't have for the newest one: `vr note --v 5` against a server
  with only V1 recorded the note on V1 without a word, while the same call on the machine said "no v5". Notes, render
  sources, transcripts, frames, waveforms and the playable file now answer `404 {error: "no v5"}` for it; naming no
  version still means the newest.
- A hung ffmpeg no longer keeps `/readyz` from answering: the check gives up after 5 s and says not ready. On the
  machine a hung `claude` CLI no longer holds the library's first load (up to an hour): the agents list waits a second,
  then comes when it comes, and `claude agents` gets 10 s before the session files are read instead. A tool stopped at
  its deadline whose children still held its output open is let go too.
- A device's push service is reached only at a public address: besides naming one of the browsers' push services,
  every address the endpoint's name resolves to must now be public, and the push connects to the one it checked (the
  same guard as webhooks and OAuth metadata); a refusal is logged once and not retried.
- On a machine other people sign in to, they can no longer read what your agents did: the logs of runs Lampo started
  (an agent's whole transcript) are 0600 in a 0700 folder, the live activity file is 0600, and `vr`'s download cache of
  a hosted server's screenshots is a 0700 folder. Ones made by an older version are closed on next use.
- `vr login http://<another machine>` no longer sends your password or token, and then every note, unencrypted without
  a word: it refuses and says why, unless you add `--insecure` (then it warns); this machine's own `http://localhost`
  and `127.0.0.1` work as before. `vr mcp config claude --with-token` warns that the command it prints holds your token
  and will stay in your shell's history.
- On a hosted server, what one member's agent reports it did can no longer show under another's agent, or at a made-up
  time: lines posted to the live monitor are listed as `<agent> · <account>`, like an MCP client's connection, and
  their time is held to the last five minutes.
- An unauthenticated `POST /oauth/revoke` with a made-up token, or a refresh with one, no longer makes every open MCP
  wait and listen on the server ask again whether its caller still gets in, nor rewrites the server's list of app
  connections: only a token one of the client's connections holds revokes, writes and tells the open streams. Signing
  out everywhere an account that isn't there, and the sweep of unconfirmed sign-ups when there is none, tell nobody
  either.
- Access ended outside the server's own process (`vr admin reset-password`, a token revoked by `vr admin`, a restored
  file) or by expiry (an API token's, an app's hour-long access token, a session's) no longer reaches an open MCP wait
  for up to 5 s: an open wait or listen asks again whenever the files access is decided by have changed, and never
  remembers a yes past its credential's own end, so the next note is held back from it.
- Reviewers can no longer take every MCP wait of a workspace, nor its listens, and leave its owner's own agent
  refused: the places are shared out by role, and a part is kept for owners and admins (docs/mcp.md).
- On the machine, each phone or tablet with the LAN link now has its own 4 MCP listens and waits; they shared one
  connection's 4 between them.
- One account can no longer hold hundreds of `/api/events` live streams on a hosted server: the streams a person holds
  at once are bounded, and one more answers `429`. A stdio MCP server signed in to a hosted server no longer reads the
  server's recent event log (2,000 events, ~888 KB) once a second for each `wait_for_feedback`: it sleeps until the
  live stream it already follows says something happened, then asks only for what is new since its cursor.
- On a Linux machine other people sign in to, their programs can no longer use the local app as you: a request from
  localhost counts as the machine's owner only from your own OS account (or root); another account's is signed out.
  On macOS and Windows the system can't tell accounts apart, which SECURITY.md now says. A new store is made readable
  by you alone, and the app warns at start when the store's folder can be opened by other accounts.
- An API token's "last used" no longer moves while an agent merely holds a wait, a listen or `/api/events` open with
  it: asking again whether it still gets in isn't a use (it rewrote the account file about once a minute per token)
 .
