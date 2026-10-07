# Publishing a final video

When a video is final, Lampo can post it to **YouTube**, **Instagram** and **Facebook**, or hand you a **publish kit** to
post it yourself. Agents write the posts; a person publishes them. TikTok, LinkedIn and X come through the same path
later (see [Not built yet](#not-built-yet)).

What is built (this document): post drafts after Final, connections per workspace with your own keys, the publish
queue, the kit, status and history. **None of it has been run against a real platform yet**: the adapters are tested
against local fakes (`test/lib/fakePlatforms.ts`), and the field names of the posting API are to be confirmed in a
one-day test with a real account before anyone relies on them ([What is not confirmed](#what-is-not-confirmed)).

## The steps

1. **Final.** A post belongs to a final version: `lib/stage.ts` says `final` and no newer render arrived. Before that,
   drafting answers `409` with the reason and the video's next step.
2. **Draft.** One post per platform per final version (`data/publish/posts.json`, per workspace). People write it in
   the composer (*Publish…* is the next step of a final video, and in the video menu); agents write it with MCP
   `draft_post` or `lampo post draft`. A new final's post starts from the same platform's post of the version before.
3. **Publish.** Only a person with the `publish` action (owners and admins), signed in in the app — never with an API
   token, never an agent. The composer asks once more, naming the platform and the account ("Publish to YouTube as
   Studio Channel?"), and sends that confirmation with the request, with the `digest` of every field that goes out as
   the person saw it: a post that names something else since, or that anyone (an agent too) edited after they looked,
   is refused (`409`), and they look again. Every edit is in the post's history with who made it.
4. **Out.** The queue sends it (see below); the post says where it stands, and so do the video's stage line, the inbox
   (a failed post is your turn), `lampo post` / MCP `get_posts`, webhooks and push.

| | Draft and download the kit | Publish, schedule, cancel, retry | Connections (keys, sign-ins) |
|---|---|---|---|
| Owner, admin | yes | yes | yes |
| Member | yes | no | sees them (to pick one), changes none |
| Reviewer | reads posts | no | no |
| Agents (MCP, `lampo`, any API token) | drafts only (`draft_post`, scope `post:draft`): a failed or cancelled post is a person's to change or delete | never (`PERSON_ONLY`) | never |
| A review link | nothing | nothing | nothing |

Retry asks the plan's gate as Publish does. A post that went out before (`remote_id`) is never deleted, by anyone: it
is the record of what the platform holds. While the video's project is archived its posts take no draft, change,
publish or retry (`423`) until it is restored; cancelling and deleting still work. Reviewers read posts on purpose, as
the team does: the connection's label, the account's name, a post's link (an unlisted or scheduled video's too) and
who drafted and published it; the connections themselves are not theirs to read.

The actions are `post` and `publish` in [`lib/permissions.ts`](../lib/permissions.ts); the routes are in
[api.md](api.md#publishing). A plan may limit publishing on Lampo Cloud (`check(ws, 'publish')`, server/extension.ts).

## What a post says

Title, description or caption, tags, the cover frame (picked on an exact frame of the final), visibility, the time it
goes live, and per platform: YouTube's category and **made for kids**; Instagram Reel or feed, and a Reel in the feed
too; for Facebook, the Page (the connection's Facebook account). And one answer every post needs: **"Contains realistic
AI-generated or altered people, places or events?"** Neither that nor *made for kids* is ever defaulted: missing, they
are warnings on a draft and block publishing. YouTube gets the AI answer as `containsSyntheticMedia`; through the
posting API Lampo can't set Instagram's or Facebook's label yet, so the composer says to put it in the caption.

The platforms' limits are checked as you write (`lib/publish/platforms.ts` `postProblems`: `block` stops publishing,
`warn` only says so), the same in the composer, in `draft_post`'s answer and on the server:

| | YouTube | Instagram | Facebook |
|---|---|---|---|
| Title | 100 characters, no `<` `>`; needed | none (only in the kit's copy) | 255 |
| Description / caption | 5000 bytes, no `<` `>` | 2200 characters, 30 hashtags | 63206 |
| Tags | 500 characters together, 100 each | become hashtags | become hashtags |
| Length | 1 s – 12 h; over 15 min needs a verified account | 3 s – 15 min | from 3 s; over 90 s a video, not a Reel |
| Shape | any | a Reel wants 9:16 (warning) | 9:16 (warning) |
| Visibility | public, unlisted, private | public | public |
| Who holds a schedule | YouTube (`publishAt`; it makes the video public then) | Lampo sends it at its time | Lampo sends it at its time |

## Before you publish

What a server that publishes with its own keys needs (each step is [below](#connections)):

- **For YouTube**: a Google Cloud project with the YouTube Data API v3 enabled, an OAuth consent screen and an OAuth
  client of type *Web application* with the redirect URI that Settings → Publishing shows. Until Google verifies the
  consent screen it shows a warning, and only the test users you add (100 at most) can sign in. Until the project
  passes the YouTube API Services audit (support.google.com/youtube/contact/yt_api_form), its uploads stay private and
  it may upload 100 videos a day.
- **For Instagram and Facebook**: an account at Zernio with your Instagram professional account and Facebook Page
  connected to it, and its API key.

## Connections

Settings → Publishing, per workspace. Keys and tokens are sealed at rest (AES-256-GCM under a key derived from the
store's secret, bound to the workspace and the connection: `lib/publish/seal.ts`) in `data/publish/connections.json`;
they never appear in an answer, an event, a webhook or a log line — what anyone reads is the label, the accounts, the
state and the last four characters of the key.

On your own machine the app's owner is whoever asks it from the machine itself, so any program running there — not
only your browser — may add a connection or publish, as it may do everything else (`SECURITY.md`); on a hosted server
only a person signed in in the app does.

Hardening, besides the above: a platform's link is kept only when it is https; an upload's progress is saved and told
every ten seconds at most (to the post's page, not the whole library); every field of a draft is capped the same over
the HTTP API and MCP (`lib/inputs.ts`), past 256 kB a draft's body is a `413`; names in `lampo post` and `get_posts` are
one line each.

### YouTube, with your own Google Cloud OAuth client

1. In Google Cloud: a project, the **YouTube Data API v3** enabled, an OAuth consent screen (External; add yourself as
   a test user while it is unverified), and an OAuth client of type **Web application** with the redirect URI that
   Settings → Publishing shows (`<this app>/api/publish/oauth/callback`; on your machine `http://localhost:4747/…`).
2. In Lampo: *Add YouTube*, paste the client id and secret, *Connect with Google*. Google asks for two scopes:
   `youtube.upload` (the upload and its cover) and `youtube.readonly` (your channel's name, where an upload stands).
   Google sends you back to the redirect URI: on your machine that page load from Google's site is the one request from
   another site the app takes outside its public pages (only as a page load, and only with the sign-in's own state).
3. The upload is resumable: 8 MB chunks that go on where a dropped connection left them, also after a restart (the
   session URL is kept sealed with the post). A cover frame goes up through `thumbnails.set` (it needs a verified
   YouTube account; without one the post says so and goes out without it).

**Uploads stay private until your Google project passes YouTube's API audit.** Every API project made after 28 July
2020 — your own included — has its uploads locked private until it passes the YouTube API Services audit. So with your
own unaudited client the upload works, but it lands **private**, a schedule (`publishAt`) **never goes public**, and you
make it public in YouTube Studio (whether Studio allows that is [not confirmed](#what-is-not-confirmed); the kit is the
way round). Lampo says so where it matters: the connection's state ("Uploads stay private until
your Google project passes YouTube's audit"), the composer's warning on a public or scheduled post (`youtube_locked`),
and the post's result ("YouTube kept it private… make it public in YouTube Studio", with the Studio link). When your
project has passed the audit, switch *My Google project passed YouTube's API audit* on. A minute after an upload (and
again at ten minutes) Lampo looks at the video to tell a lock it didn't expect.

Quota: since 1 June 2026 `videos.insert` has its own bucket of **100 uploads a day per Google project**. A quota or
upload limit is a reason Lampo tries again later (in a few hours), not a failure.

### Instagram and Facebook, through a posting API with your own key

Lampo talks to **Zernio** (formerly Late) with your API key: no Meta app review is needed, because the provider's apps
passed it. Connect your Instagram professional account and Facebook Page at Zernio, then *Add Zernio* in Settings →
Publishing with the key: Lampo lists the accounts it may post as. The file goes from this machine to the provider's
storage (a presigned upload; the key is never sent there), then one call posts it. That call carries an idempotency key
per publish, but nothing depends on it: Lampo never sends a post again by itself once that call went out (below).

**Lampo sends these posts at their time** (the posting API is called with *publish now*), so a scheduled post follows
the final: reopening it, or a newer render, pauses the post before anything leaves. The price: **on a machine that
sleeps, the post goes when the machine is awake and Lampo running again** — the composer says so on a scheduled
Instagram or Facebook post (`schedule_awake`). A hosted server is always awake. (Letting the provider hold the schedule
is on the [roadmap](../ROADMAP.md).)

Posting to Instagram and Facebook through Lampo's own Meta app comes later, in Lampo Cloud.

## What goes out

**YouTube gets the final file as it is.** Instagram and Facebook get it as it is when they take it (MP4 or MOV, H.264
or HEVC 4:2:0, AAC ≤ 48 kHz or no sound, within the platform's size, rate and resolution: `fitsAsIs`), else the
platform's encode from the publish kit. The post records which (`file: {kind: final | encode, hash, bytes}`: the
final's render key, or the encode's sha256).

## The queue

`lib/publish/queue.ts`, started with the server (every 15 s, and at once when someone publishes), in every workspace,
one upload at a time. On a server with several teams they take turns like the job queue's: the owner served longest
ago goes, then their workspace served longest ago, so one team's backlog holds another's post back by one send at most.
What is due is looked at again before every turn: a post published while another team's upload runs goes next.
The file a post sends (the final fetched, or the platform's encode) and its cover are made before its turn, under the
workspace's job cap; a send never waits for ffmpeg while it holds the line. Every request to a platform has a
wall-clock deadline (its timeout plus the time its body needs at 64 KiB/s), an answer that drips included.

- **Due**: at once, or at its time when Lampo sends it.
- **Asked again first**: still final, still that render, the connection still ready. A reopened final or a newer
  render pauses a post Lampo still has to send (`cancelled`, "Paused: the video was reopened…"); nothing leaves Lampo
  for a version that isn't final. **A schedule YouTube holds is not paused**: the upload is on YouTube already and
  YouTube makes it public at its time, whatever happens in Lampo. Reopening asks first and says so (in the player and
  on the board); take it back in YouTube Studio.
- **Passing failures** (the network, a timeout, a 5xx, a rate limit, a quota) are tried again after 1 min, 5 min,
  15 min, 1 h, 3 h — six tries — or when the platform says (Retry-After, a quota's reset); then the post fails.
- **A refusal** fails it at once, with the platform's reason as a sentence ("The video is too short for a Reel.").
  A sign-in or key that no longer works also marks the connection.
- **After a send** the queue looks at what the platform holds: a YouTube schedule after its time, a post the posting
  API is still publishing (every minute, for up to six hours), and a fresh YouTube upload once more for the lock.
- **Never twice.** Once a send reached the request that makes the post exist (YouTube: the last bytes of the upload;
  the posting API: the post itself), a failure without the platform's answer is never sent again by itself. YouTube's
  upload session (kept, sealed, until the video's id is) finds the upload again, also after a restart; without one the
  post is `sent`: *sent, not confirmed*, for a person to look on the platform. So is such a post whose tries run out,
  that a person cancels or that a reopened final pauses: never `failed` or `cancelled`, which would send it as a new
  upload. Only the platform's clear "no" to the post itself starts the next try clean. A look at a post the platform
  holds that fails — a revoked sign-in or key, the platform away — keeps where the post stands (posted, scheduled,
  still being published) and marks the connection; looks through a connection that doesn't work wait until it is
  fixed. A post the posting API is still publishing after six hours is `sent` too. Only the platform's own "it failed"
  fails a post it holds, and that post keeps its id.
- **Taking back**: a post waiting in Lampo is cancelled at once. One YouTube already holds (scheduled there) can't be
  taken back with the upload scope: Lampo says so and links to YouTube Studio.
- The server stops without waiting for an upload: it resumes on the next start.

States: `draft` → `queued` → `uploading` → `scheduled` / `posted`, or `failed`, or `cancelled`, or `sent` (not
confirmed). A failed or cancelled post is a draft again once changed. *Retry* sends a failed post again only when it
never reached the platform; one the platform holds (`remote_id`) is asked about again instead, and a `sent` one without
an id waits for a person. Sending a post that went out before again — publishing it, or *Retry* — needs the person to
say so (`again`), after the app says it went out before.

## The publish kit (no connection needed)

Per post (`POST /api/posts/:id/kit`, made in the background, kept in `cache/publish-kits/<post id>/`):

- the platform's **encode**: H.264 High 4:2:0 in MP4 with the index at the front (fast start), a closed GOP of two
  seconds, AAC 48 kHz, scaled down (never up) within the platform's frame, the frame rate within its range, the video
  bit rate capped (Instagram and Facebook ≤ 1920 px on the long side, 25 Mbit/s; Instagram ≤ 300 MB; YouTube up to 4K);
  none of the render's own metadata goes with it (no editing paths, internal titles, places or chapters);
- an **SRT** from the version's transcript, when it was heard;
- the **cover** frame as a JPEG (the post's frame, else the poster's);
- the **copy** as text (title, description, tags — hashtags for Instagram and Facebook);
- **kit.zip**: all of it in one store-only ZIP, streamed.

A post belongs to its video by the video's id, not only its name: once the video is deleted its kit and cover are
gone (404), and a later video of the same name and folder starts posts of its own. The cover frame is held inside the
version (a frame past its end is its last), and one cover JPEG is kept per post.

## Status and history

A post keeps its history (who drafted, who published, each try, the platform's answers). It shows:

- **on the video**: the stage carries `published` (`StageInfo.published`: one line per platform of the final version —
  posted, scheduled, failed, with the link); the stage itself stays `final`;
- **in the inbox**: a failed post is the `post` item of whoever may publish, with the reason and Retry; it leaves when
  it goes out, is changed or cancelled;
- **for agents**, read-only: MCP `get_posts`, `lampo post [<video>] [--json]`, and `draft_post`'s answer;
- **events**: `post` events (drafted, published, scheduled, posted, failed, cancelled) in events.jsonl with
  `post: {id, platform, state, url?, account?, error?}` — webhooks hear them (event `post` or `all`), push tells who may
  draft when a post went out, is scheduled or failed (category `posts`, on by default). They are not feedback: `lampo
  watch` and `wait_for_feedback` don't wake for them.

## Outbound requests

Every request publishing makes goes through `lib/publish/net.ts` on top of [`lib/netguard.ts`](../lib/netguard.ts):
public addresses only (every address a name resolves to), the connection pinned to the checked address, https only, no
redirect followed, answers read up to 4 MB. That covers the URLs the platforms hand back too (an upload session, a
presigned upload URL); YouTube's upload bytes only ever go to YouTube's upload host. The posting API's presigned
upload may go to any public https host it names: its storage hosts aren't confirmed yet (below), so they aren't pinned.
Adding a posting-API key, or changing one, asks the platform at once and counts against the same limit as *Check*
(30 in ten minutes per workspace). What a platform says about its accounts is kept one line per field, 120 characters
each, 100 accounts per connection. `LAMPO_PUBLISH_ENDPOINTS` (JSON)
points the adapters elsewhere — the tests' fake platforms, a staging proxy — and the hosts it names may be private and
plain http. Leave it unset in production.

## Not built yet

- **In Lampo Cloud, later**: posting through Lampo's own approved platform apps, so you don't need keys of your own,
  and scheduled posts that go out even while your machine sleeps.
- **TikTok, LinkedIn and X**, directly or through the posting API (TikTok prescribes its own posting UI: privacy with no
  default, interaction toggles off, the commercial-content disclosure, the music confirmation).
- Captions to YouTube (`captions.insert`, 400 units, the `youtube.force-ssl` scope), the provider holding a schedule,
  editing or deleting a post after it went out, a client approving the post on a review link, the numbers coming back
  (YouTube's retention curve on the video's frames).

## What is not confirmed

Read from the providers' documents on 2 October 2026, not run against them:

- Zernio's base URL (`https://zernio.com/api` per its OpenAPI servers; its media guide says `https://api.zernio.com/v1`),
  the shape of `GET /v1/accounts`, and the names of `platformSpecificData` fields (`contentType: "reels"`,
  `shareToFeed`, `thumbOffset`, a Facebook `contentType: "reel"` and `title`), the `Idempotency-Key` header, and how its
  AI-disclosure flag is spelled (not sent yet).
- Whether the cover frame arrives (Instagram's `thumbOffset`), whether a YouTube SRT and the AI and branded flags pass
  through, and how deep the numbers go — the one-day test checks each.
- Whether YouTube Studio lets the owner make a locked upload public: Google says only that such uploads are "restricted
  to private viewing mode". The post links to Studio; if Studio won't, the kit's encode uploaded by hand in Studio is
  the way until the audit is passed.
