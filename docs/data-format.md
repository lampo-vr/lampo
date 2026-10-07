# The data format

Everything Lampo knows lives in plain files. Agents and scripts read them without the app or the server, so the format
is a public contract: fields are added, never renamed or removed. The TypeScript types in
[`lib/types.ts`](../lib/types.ts) are the source of truth; this page explains them.

Where to look:

- **One video, everything about it:** `data/<slug>/review.json`, or `review.md` next to it (the same, readable).
- **What changed:** `data/events.jsonl`, one line per change, and `data/INBOX.md`, the newest feedback from people.
- **What the reviewer saw:** `data/<slug>/<id>_marked.png`, the note's exact frame with the drawing on it.

Where `data/`, `versions/` and `cache/` are on disk: [configuration.md](configuration.md#where-data-lives). On a
hosted server, agents get the same information through `vr` or MCP instead ([agents.md](agents.md)).

## Layout

```
data/
  <slug>/                     one folder per video
    review.json               the source of truth for the video
    review.md                 the same, readable (rewritten with review.json)
    <id>_clean.png            a note's exact frame, full resolution
    <id>_marked.png           the same frame with the drawing burned in
                              (the same as clean without a drawing)
    <id>_range.jpg            a range note: up to six frames across the range
    <id>.m4a                  a voice note (a recorded note: its stretch of the recording)
    previews/                 fix previews attached to notes
    refs/                     images and clips attached to notes as references
    recordings/               recorded feedback not sent yet: <rec id>.json (events, drafts)
                              and <rec id>.m4a; both go once it is sent or discarded
    drafts/                   notes people saved and haven't sent: <account id>.json and
                              their screenshots and voice notes (never read by agents)
    views.json                who on the team watched the video (never read by agents)
    runs.jsonl                agents' runs on the video: one line each, its steps kept (below)
  events.jsonl                one line per change, appended
  events.imported.jsonl       another store's history, as `vr admin import` brought it in
  INBOX.md                    the newest human feedback across all videos (on your machine)
  folders.json                the project and folder tree
  shares.json                 review links
  asks.json                   a folder's questions with options, before any render (below);
                              their files in asks/<id>/ (with Bunny or S3, in the bucket)
  runs.jsonl                  agents' runs on those questions, before any render (below)
  publish/                    posts of final videos, the publishing connections with their
                              secrets sealed (below; publishing.md)
  footage.json                footage search on or off for this workspace, who said so and
                              when (footage.md)
  playbooks/                  the House's and the folders' playbooks
  taste/<scope>.md, .json     taste files, made on demand (taste.md)
  qa-dictionary.txt           optional: words Auto-check's spelling check accepts, one per line
  for-you.json                what people cleared or put aside in their inbox
  webhooks.json               webhooks added in Settings
  moments.json                where a billing provider runs: one-time notices waiting for
                              the person they are for (api.md)
  users.json, invites.json    accounts and API tokens; pending invites
  avatars/                    profile pictures, <account id>-<hash>.jpg, with local storage
  account-links.json          emailed one-time links (confirm an address, a new password):
                              each token's SHA-256 only
  mail/queue.json             emails waiting to go out, sealed with a key from secret.key
  secret.key                  the key that signs sign-in cookies
  share-secret.key            the key review-link tokens are sealed with
  oauth/                      apps connected through sign-in (clients.json, grants.json)
  push/                       the push notification key and the devices that receive them
  workspaces.json             hosted servers: each workspace and its members (below)
  links.json                  hosted servers: which workspace a review link belongs to
  funnel.json                 where a billing provider runs: the operator's counts of first
                              steps per workspace, never who (server-mode.md)
  backups/                    copies made before a hosted store moved to workspaces
  w/<workspace id>/           every workspace but #1: the same layout as data/ itself
versions/<slug>/vN.<ext>      the bytes of every version; can't be rebuilt
versions/w/<workspace id>/    every workspace but #1: its versions, the same way
cache/                        posters, waveforms, analysis, diffs, Auto-check results,
                              transcripts, playback copies, the speech model (below)
cache/uploads/                uploads in flight
cache/publish-kits/           publish kits, made on demand (publishing.md)
cache/outbox/                 emails written instead of sent, without a mail relay (email.md)
cache/models/                 the speech and footage search models, downloaded once, shared
                              by every workspace
cache/footage/index.db        footage search's index of the workspace's videos, with the
                              contact sheets' pictures in cache/footage/thumbs/ (footage.md)
cache/agent-runs/             on your machine: the output of each agent run Lampo started,
                              <run id>.log
cache/w/<workspace id>/       every workspace but #1: its cache
cache/agent-activity.jsonl    what agents on this machine did through vr and
                              the stdio MCP server, one line per call
```

- **Only the app's user reads them** (mode 0600): accounts, invites, the keys, `oauth/`, `push/`, `workspaces.json`,
  `links.json`, `account-links.json`, `mail/`, `backups/`, `publish/connections.json`, `funnel.json`, `moments.json`,
  `cache/agent-activity.jsonl` and the logs in `cache/agent-runs/`.
- **Locks.** Folders whose names start with a dot (`.lock`, `.inbox`, `.uploads`, …) are held while something writes:
  leave them alone.
- **`cache/` is rebuilt on demand** and safe to delete while the app is stopped, except `cache/uploads/` (uploads in
  flight). Profile pictures used to be kept in `cache/avatars/`; a store that still has them there moves them to
  `data/avatars/` at its next start.
- **In a bucket.** With Bunny or S3 storage, versions, fix previews, references, profile pictures, playbook files and
  playback copies live in the bucket (`versions/<slug>/vN.<ext>`, `previews/<slug>/…`, `refs/<slug>/…`,
  `avatars/…`, `playbooks/<id>/…`, `scrub/…`, `proxies/…`), and the cache keeps working copies of them. A workspace
  other than #1 keeps its keys under `w/<workspace id>/`; profile pictures belong to no workspace.

**Slugs.** A video's slug is its absolute path with every `/` replaced by `__`
(`/home/alex/work/acme/export/ep02.mp4` becomes `__home__alex__work__acme__export__ep02.mp4`). An uploaded video gets
a virtual path, `/@uploads/<folder>/<name>` (`/@uploads/<name>` when it isn't filed), and its slug is made the same
way. Don't build slugs yourself: `review.video` is the source of truth, and `vr` and the MCP server take a path, a name
or a slug.

### Details

- A slug is one folder name, so it can't be longer than 255 bytes. A longer path (deep cloud-drive folders) gets
  `__<the path's last 180 bytes or so>~<16 hex digits of the SHA-256 of the whole slug>` instead (`__@uploads__…` for
  uploads).
- Because `/` becomes `__`, two paths can meet in one slug (`/work/a/b.mp4` and `/work/a__b.mp4`), and a video can be
  moved or archived away from the folder its virtual path names. A new upload whose slug is taken gets a path of its
  own, one level deeper with the same name (`/@uploads/Acme/~2/promo.mp4`). A second file on disk whose path meets
  another's slug is refused ("… share one id: rename one of them"), never mixed into the other video's versions.

## review.json

```json
{
  "video": "/home/alex/work/acme/export/ep02.mp4",
  "project": "work/acme",
  "folder": "Acme/Reels",
  "fps": 30, "width": 1080, "height": 1920, "duration": 50.7, "frames": 1521,
  "versions": [
    {"v": 1, "hash": "3f1c…", "sample": "9b20…", "mtime": "…", "size": 125154025,
     "frames": 1521, "fps": 30, "width": 1080, "height": 1920, "duration": 50.7,
     "registered": "…"},
    {"v": 2, …},
    {"v": 3, …}
  ],
  "session": {"name": "promo-edit", "id": "<CLAUDE_CODE_SESSION_ID>",
              "cwd": "/home/alex/work/acme", "assigned": "…", "by": "alex"},
  "approval": {"status": "approved", "v": 3, "by": "guest:Mia", "at": "…", "note": null},
  "approvals": [
    {"party": "team", "status": "approved", "v": 3, "by": "alex", "at": "…", "note": null},
    {"party": "client", "status": "approved", "v": 3, "by": "guest:Mia", "at": "…",
     "note": null, "share": "s_3f9a1c02de"}
  ],
  "final": null,
  "agent_status": {"text": "exporting the delivery files", "by": "agent:promo-edit",
                   "at": "…", "until": "…"},
  "comments": [{
    "id": "c_7f3a9b", "v": 1, "frame": 363, "timecode": "00:12:03", "t": 12.1,
    "range": {"in": 360, "out": 372},
    "text": "short freeze here", "tags": ["freeze"], "severity": "must",
    "drawing": [{"type": "box", "x": 180, "y": 1040, "w": 720, "h": 400}],
    "shots": {"clean": "c_7f3a9b_clean.png", "marked": "c_7f3a9b_marked.png",
              "range": "c_7f3a9b_range.jpg"},
    "voice": {"file": "c_7f3a9b.m4a", "transcript": "…"},
    "status": "verified", "author": "alex", "created": "…",
    "replies": [
      {"by": "agent:promo-edit", "text": "freeze removed", "status": "fixed",
       "fixed_in_v": 2, "at": "…"},
      {"by": "alex", "text": "", "status": "verified", "at": "…"}
    ],
    "fixed_in_v": 2
  }],
  "added": "…", "added_by": "alex", "updated": "…", "id": "r_4e8a1c2b9d3f"
}
```

The note was made on V1, fixed in V2 and checked; V3 is approved by the team and the client.

Times are ISO 8601, mostly with the writer's UTC offset (`2026-10-01T14:02:11+02:00`), some in UTC (`…Z`, such as a
version's `mtime`). Compare them as times, not as text.

### The video

| Field | |
|---|---|
| `video` | the render's absolute path, or `/@uploads/…` for uploads |
| `source` | absent for a file on disk that is watched for re-renders; `{"kind": "upload", "name": …}` for uploads |
| `project` | where the render's project lives: the folder above `export/` (or the file's own folder), relative to the browse root or your home folder. For uploads, the folder they went to, or `Uploads`. Used for taste files and folder suggestions |
| `folder` | the project or folder it is filed in (`"Acme/Reels"`), or `null` for none |
| `fps`, `width`, `height`, `duration`, `frames` | of the newest version |
| `meta` | stream details that matter for colour-exact frames: codec, pixel format, colour space and range, audio |
| `session` | the agent the video is assigned to (a Claude Code session or a connected agent), or `null`: `{name, id, cwd, assigned, by}`, plus `agent` (its kind: `claude-code`, `codex`, `cursor`, `claude`, `chatgpt`, `gemini`, `vscode`, `antigravity`, `windsurf`, `zed`, `mcp`, `api` or `cli`) when the assigner knew it. Readers treat an assignment without `agent` as a Claude Code session, or, with an id starting `mcp-`, as an MCP client named by its client |
| `approval` | the newest verdict still standing, `{status: "approved" \| "changes", v, by, at, note}`, or `null`. Still written for older readers; the history is `approvals` |
| `approvals`, `final`, `finals` | the sign-off: verdicts per version and party, and the version marked final ([below](#sign-off)) |
| `agent_status` | what an agent is doing right now, `{text, by, at, until?}` (`until`: when it expects to be done); cleared when the next version lands |
| `qa_dismissed` | the keys of Auto-check findings the reviewer dismissed or turned into notes (`qa` in the API) |
| `qa_stretches` | optional: where each finding marked *That's intended* was, `{key: {in, out}}` in frames of the version it was dismissed on. A later version's finding of the same kind on the same stretch (both ends within a quarter second, or a tenth of its length) counts as dismissed too (`lib/findings.ts`) |
| `archived` | when it was removed from the library while it had notes (a video without notes is deleted instead) |
| `missing` | `true` while the file on disk is gone |
| `added`, `added_by`, `added_by_id` | when and by whom it was added. `added_by_id` is the account (optional, like a note's `author_id`); it decides who besides admins may remove or restore the video |
| `id` | `r_` and 12 hex digits, given when the review is made and never reused. A slug comes back (a video removed and added again under the same name gets the same slug); an `id` doesn't. Review links are made for it ([below](#foldersjson-and-sharesjson)). Absent in reviews from before |
| `onboarding_sample` | only on the first run's sample: `{made, by, by_id?}`. None of its events is logged, Insights and the taste file leave it out, it never counts against a workspace's limits, and removing it deletes it for good ([onboarding.md](onboarding.md)) |
| `updated` | when review.json was last written |

### Versions

Every render that lands at the same path, or is uploaded under the same name, is a new version.

| Field | |
|---|---|
| `v` | 1, 2, 3, … |
| `hash` | SHA-1 of the size, the first MiB and the last MiB. It changes on almost every re-render; the same bytes are never registered twice |
| `sample` | SHA-1 of `hash` and 256 slices of 4 KiB spread evenly over the rest of the file (optional; versions from before it have none). It tells re-renders apart that keep their size, start and end ([details](#versions-in-detail)) |
| `mtime`, `size` | the file's modification time and size in bytes when it was registered |
| `frames`, `fps`, `width`, `height`, `duration` | of this version: a re-render may change them |
| `registered` | when it was picked up |
| `stored` | `"bunny"` or `"s3"` when the bytes live in remote storage (a hosted server) instead of `versions/` |
| `by` | who uploaded it (uploads only) |
| `source` | where it was made, as the agent reported it (optional): `{app, project?, comp?, start_frame?, fps?}`. Render frame N is project time `N / fps + start_frame / (source.fps or fps)`. `project` is a file name, never a path |
| `playbook` | the playbook revisions in force when it arrived (optional): `[{scope, rev}]`, the House (`""`) first, down to its folder; only playbooks with a revision |
| `part` | a partial render (optional): `{of, at, frames, handles, seam?, confirmed?, mismatch?}` ([below](#partial-renders)) |
| `run` | the agent run that made it (optional, `run_…`): the open run of an agent at the video when it was registered ([below](#agent-runs)) |

A render on disk that is still being written (changed less than 3 seconds ago, or not readable by ffprobe yet) is
picked up once it settles. The bytes of each version are kept as `versions/<slug>/vN.<ext>`; that is what makes
before-and-after comparisons possible after the file on disk has been overwritten. On macOS (APFS) the copy is a
clone, which takes no space until the original changes.

On a partial render (`part`), `frames`, `fps`, `width`, `height` and `duration` are the whole video's, while `hash`
and `size` are those of its file in `versions/`, which holds only the part.

#### Versions in detail

A re-render in a codec with a constant frame size (uncompressed, v210, DNxHD/HR) that changes only frames in the
middle keeps the size, start and end of the file, so its `hash` is the last version's. It is still a new version when
its `sample` differs. A version without a sample is sampled from its bytes in `versions/`; with remote storage and no
sample, `hash` decides. Files made from a render in `cache/` are named by its `sample`, or by its `hash` when it has
none.

#### Partial renders

A partial render patches a stretch of an earlier version: a person allowed it on a note or with a request (the note's
`part`, below), and the agent rendered only those shots ([workflow.md](workflow.md#partial-renders)).

| Field of `part` | |
|---|---|
| `of` | the version it patches (a full render, or another part) |
| `at`, `frames` | the base frames it replaces: `at` to `at + frames − 1`. Its file holds them plus up to `handles` frames before and after (fewer at the video's ends); a part never changes the video's length |
| `handles` | the frames rendered beyond each end, as asked |
| `seam` | the handles compared with the base's same frames (the version diff's block measure): `"clean"`, or `{jump, diff}` with `jump` the seam frame where they differ. Absent without handles |
| `confirmed`, `mismatch` | `{v, diff, at}`: the next full render compared with the part once it was approved (a mismatch adds the first `frame` that differs) |

The version's `sample` names the whole video it makes (the part's bytes, its base and where it sits), so the files
made from it (posters, Auto-check, transcripts …) describe the whole video. The whole video is spliced from the files
as uploaded into `cache/scrub/<sample>.mp4` (with remote storage, the `scrub/` key), never into `versions/`. A partial
render is never final.

### Notes (`comments`)

| Field | |
|---|---|
| `id` | `c_` and 6 hex digits, unique across the store |
| `v` | the version the note was made on |
| `frame` | 0-based, at that version's frame rate |
| `t` | `frame / fps` in seconds, rounded to the millisecond |
| `timecode` | `mm:ss:ff`, or `h:mm:ss:ff` past an hour |
| `range` | `{in, out}`, both included, or `null`: a note about a stretch of the video (frames of version `v`, never past its last frame). `frame` lies inside it: the first frame, unless a drawing is on another |
| `text`, `tags` | what the note says, and its tags |
| `severity` | `must`, `should`, `nice` or `idea` (an optional suggestion that never counts as open work) |
| `kind` | absent for feedback (every note from before kinds existed, and a person's feedback today); `question` or `info` for notes that aren't feedback; `feedback` when an agent files feedback on purpose. Agents' notes always carry it. Questions and info notes store `severity: "nice"` for older readers: ignore it for them. A note by an `agent…` author without `kind` is from before kinds existed and reads as a question |
| `drawing` | shapes in video pixels ([Drawings](#drawings)) |
| `shots` | screenshot file names in the review's folder, or `null` when none were made. A range note longer than one frame also has `range`: one JPEG of up to six frames across it, first to last, left to right and row by row (`<id>_range.jpg`) |
| `voice` | `{file, transcript}` or `null` |
| `source`, `recording` | a note made from recorded feedback: `source: "recording"` and `recording: {id: "rec_…", t0, t1}`, the recording and the seconds of its audio the note was said in (optional). Its own clip of that stretch is `voice`, with the words as heard as its `transcript` |
| `status` | `open` → `fixed` (the agent) → `verified` (the reviewer), or `wontfix` (with a reason). Reopening sets it back to `open` |
| `author` | the reviewer's name, `agent:<session>`, or `guest:<name>` for a client |
| `author_id` | the account that wrote it, when a signed-in person did, through the app or `/mcp` (optional; absent on older notes, agents', clients' and local `vr` writes). When present it decides who may edit or delete the note: a renamed account keeps its notes, and a new account with a deleted person's name gets none. Otherwise `author` decides |
| `created`, `edited` | when it was written, and when it was last edited: its text, tags, severity, drawing or words, or a reference's caption or removal (optional) |
| `replies` | `{by, text, status?, fixed_in_v?, preview?, refs?, at, by_id?, edited?}`. Every status change adds a reply with the new `status`. `preview` names the fix preview a fix or check refers to; `refs` the references that came with the reply (their ids; the references themselves are in the note's `refs`). `by_id`: the account of a signed-in person who wrote it; `edited`: when its author last changed its words (only plain replies change; `at` stays) |
| `check_again`, `carried_to` | an open note carried into a newer render that nobody has checked again yet |
| `fixed_in_v` | the version a fix landed in |
| `share` | client notes: the public id of the review link they came through (optional) |
| `previews` | fix previews, newest last (optional): `{id: "p_…", kind: "still" \| "clip", frame, frames?, v, by, at, width, height, fps?, file, bytes, source?, confirmed?, mismatch?}`. `frame` is a frame of render `v` (a clip's first). `file` is in `previews/` in the review's folder. `confirmed` or `mismatch` is `{v, diff, at}` (a mismatch adds `reason`): a later render compared with it |
| `verified_on` | `{preview, v}`: checked on that preview while V`v` was the newest render, so the fix isn't in a render yet (optional; removed once a later render matches) |
| `refs` | references, oldest first, at most 8 (optional): `{id: "r_…", kind: "image" \| "clip" \| "link" \| "frame", caption?, by, by_id?, at, share?}` plus, per kind: image and clip `file` and `still` (a JPEG of at most 1280 px), a clip also `strip` (six moments in one picture) and `duration`; both `width`, `height`, `bytes`; a link `url` and `site` (never fetched); a frame `video` (its slug), `name`, `v`, `frame`, `to_frame?`, `timecode`, `fps`, `still` and `end?` (the last frame of a range). Files are in `refs/` in the review's folder. `by_id` is the account, like a note's `author_id` |
| `scope` | `"video"`: about the whole video rather than a moment (optional; `frame` is then 0 and there are no screenshots) |
| `text_edit` | `{from, to}`: a change to what is said (optional; made from the player's transcript). `from` is the words as heard in the note's `range` (or at its `frame`), `to` what they should say (`""`: cut them). `text` may then be empty. Agents read it as one line: `CHANGE WORDS "from" → "to" at 00:00:11–00:00:24 (f11–f24, 0.56 s)` |
| `choices` | questions only (optional): 2 to 4 answers the agent offers, one line of at most 80 characters each, no repeats. The app shows them as buttons; picking one answers the question as typing it would. The reply's `text` is the choice, and nothing else marks it |
| `options`, `answer_prompt` | questions only (optional): groups of options to audition and pick before a render — `[{id, label, pick: "one" \| "many", items: [{id, label, ref?}]}]`, ids `[A-Za-z0-9][A-Za-z0-9_-]{0,23}` — and what the free-text field asks. An item's `ref` is a reference as in `refs`, or a sound: `{kind: "audio", file: "r_….m4a", duration, bytes, loudness: {i, tp?}}` (integrated loudness in LUFS and true peak in dBTP, measured once; no `tp` when the peak couldn't be read, and such a sound is never raised; a clip with sound carries `loudness` too); its files live with the review's `refs/`. The answer is a reply `{text: "PICKED voice=v3 music=- · note: \"…\"", status: "verified", answer: {picks: {<group>: [<item>…]}, note?}}` — `text` is the line agents read, `answer` the picks as made |
| `part` | the person allows a partial render for this note (optional): `{in, out, shot?, to_shot?, handles?}`, frames of version `v`, both ends included, snapped to the render's shots (`shot` and `to_shot` counted from 1); `handles` are the frames to render beyond each end (12). Agents read one line while the note is open: `PART RENDER OK: frames 96–188 (shot 4), handles 12` |
| `draft` | never in review.json: `true` only on a note in `drafts/<account id>.json` (`{"drafts": [note, …]}`, oldest first), a note its author saved and hasn't sent. Sending moves the notes into review.json without it and logs their `comment` events in one append |

`frame`, `t` and `timecode` always refer to the note's own version `v`. To find the same moment in another version,
map by time. A `range` maps from the frame on screen when its first frame starts to the frame on screen when its last
frame ends (at another frame rate that can be more frames than the start of its last one), never past the last frame.

### Sign-off

`approvals` is the history of verdicts: one entry per verdict, oldest first, never rewritten.

| Field | |
|---|---|
| `party` | `team` (someone signed in) or `client` (a review link's visitor) |
| `status` | `approved`, `changes`, or `withdrawn` (takes back that party's verdict on that version) |
| `v` | the version the verdict is about |
| `by`, `at`, `note` | who (`guest:<name>` for clients), when, and an optional note |
| `share` | client verdicts: the public id of the review link they came through |
| `carried_from` | an approval carried over from an identical older render: that version |

A party's verdict on a version is its newest entry for that version; `withdrawn` means it has none. `approval` is the
newest verdict still standing, whichever party gave it.

`final` is `{v, by, at, note}` while a version is marked final, and `null` (or absent) otherwise. `finals` is its
history: the same fields plus `action: "final" | "reopen"`.

Stores from before the history have only `approval`. Readers treat it as the one entry of the history, with the party
taken from `by` (`guest:` means client). The file isn't rewritten until the next verdict, which keeps it as the first
entry. Where these records put a video (its stage) is worked out from them, never stored: [workflow.md](workflow.md).

### Drawings

Shapes are in video pixels:

```
{"type": "box", "x": 180, "y": 1040, "w": 720, "h": 400}
{"type": "arrow", "x1": 900, "y1": 300, "x2": 640, "y2": 520}
{"type": "freehand", "points": [[120, 80], [132, 84], …]}
```

An arrow's head is at `x2,y2`. Each shape may carry a `color`.

## events.jsonl

One JSON object per line, appended for every change, written after the change is saved (a change that fails writes
no event). Two things never log an event: drafts until they are sent, and anything on the first run's sample.
`vr watch` follows this file on your machine, and the server's event stream elsewhere. Here is the event the note
above made, spread over several lines:

```json
{
  "at": "2026-10-01T14:02:11+02:00", "type": "comment", "by": "alex",
  "video": "/home/alex/work/acme/export/ep02.mp4",
  "slug": "__home__alex__work__acme__export__ep02.mp4",
  "session": "promo-edit", "session_id": "<CLAUDE_CODE_SESSION_ID>",
  "id": "c_7f3a9b", "v": 1, "frame": 363, "timecode": "00:12:03",
  "range": {"in": 360, "out": 372}, "range_at": "00:12:00 → 00:12:12 (f360–f372, 0.43 s)",
  "severity": "must", "tags": ["freeze"], "status": "open", "text": "short freeze here",
  "shots": {"clean": "/abs/…/c_7f3a9b_clean.png", "marked": "/abs/…/c_7f3a9b_marked.png",
            "range": "/abs/…/c_7f3a9b_range.jpg"}
}
```

Every event has `at`, `type`, `by`, `video`, `slug` and `session` (the assigned agent's name, or `null`), and
`session_id` when the assignment has one. A `by` that starts with `agent` marks an agent's event.

| `type` | What happened |
|---|---|
| `added` | a video was added or uploaded |
| `assigned` | the video was assigned to an agent, or unassigned |
| `comment` | a new note |
| `reply` | a reply that doesn't change the status (also references added with a reply) |
| `status` | a note's status changed; the event carries the reply |
| `edit` | a note's text, tags, severity, drawing or words changed, or one of its references got a caption or was removed |
| `delete` | a note was deleted |
| `version` | a new version was registered, or its source was set or cleared |
| `removed` | the video was removed (archived when it had notes) |
| `moved` | the video was filed into another folder |
| `approval` | a verdict, final or reopen (see below) |
| `request` | someone asked the assigned agent for something |
| `download` | a review link's visitor downloaded a video, or a whole folder |
| `preview` | by `system`: a newer render matched the fix preview a note was checked on. A mismatch is a `status` event by `system` that sets the note back to `fixed` |
| `ref` | a reference was added to a note; the event carries it as `ref` |
| `agent_run` | your machine started the assigned agent for a request, or that run ended: `run` names it, `phase` is `started` (by whoever asked), `finished`, `failed`, `stopped` (by whoever stopped it) or `timeout`, and `exit` is the process's exit code (`null` when it was killed) |
| `post` | a post of a final video was drafted, published, scheduled, posted, failed or taken back; it carries `post` ([Publishing](#publishing-publishpostsjson-publishconnectionsjson)). Not feedback: INBOX.md and `wait_for_feedback` leave it out |

What else an event carries:

- **Note events** have the note's fields: `id`, `v`, `frame`, `timecode`, `range`, `severity`, `tags`, `status`,
  `text`, `shots`, plus `kind` for questions and info notes. `reply` and `status` events carry the reply as `reply`.
- Every event about a range note, not only its `comment`, also carries `range_at` (the range as agents read it, as in
  the example above) and `shots.range`.
- A note that changes the words carries `text_edit` (`{from, to}`) on its `comment` and `edit` events.
- A note or a request that allows a partial render carries `part` (`{in, out, shot?, to_shot?, handles?}`); a
  request's `text` then ends with its `PART RENDER OK: …` line, and a `comment` event's line in `vr watch` carries it
  too. A full render compared with approved parts logs a `version` event by `system` ("V9 matches the part approved
  in V8 …" or "V9 differs from the part approved in V8 at 00:04:12 (f103, …): check it again."), then a `status`
  event for each note sent back to `fixed`.
- Note events carry `refs` (how many references the note has) when it has some, and `scope: "video"` for a note about
  the whole video.
- `shots` are absolute paths in the file, and only the machine itself is given them as paths (`vr` and MCP there).
  The app's live event stream and webhooks carry addresses instead (`/data/<slug>/<file>`), on a hosted server and on
  your machine alike, and so does everything anyone else reads; `vr` against a server downloads the pictures and
  prints their local paths.
- `approval` events carry the sign-off in `text`: `APPROVED v3 (client: Mia)`, `CHANGES REQUESTED v3 (team): …`,
  `approval withdrawn v3 (team)`, `APPROVED v4 (team): carried over from v3, identical render`, `FINAL v3: …`,
  `REOPENED v3 (was final)`. Verdicts also carry `party`.
- `download` events carry `share` (the link's public id), `files` and `bytes`. A whole folder's download names the
  folder in `video` and `folder`, with an empty `slug`.

- A note with options carries `options` (its group ids) on its `comment` event; the `reply` of an answer carries
  `answer` (the picks) beside its PICKED `text`.
- A question asked on a folder before any render (`asks.json`) logs `comment`, `status`, `reply` and `delete` events like
  a note's, with `slug` empty and `video` = `folder` = the folder, `kind: "question"`, `scope: "video"`, `options`, no
  frame or timecode. `vr watch` prints them as `NEW QUESTION <id> folder <folder> …` and `ANSWERED <id> folder <folder>
  by … — PICKED …`.
- History brought over from another store (`vr admin import`, [moving.md](moving.md)) goes into
  `events.imported.jsonl` next to `events.jsonl`, in the same format, each line carrying `imported` (the bundle's id).
  It is what happened, not news: nothing that follows or reads `events.jsonl` sees it (`vr watch`, the MCP feed and
  `wait_for_feedback`, the app's live stream, webhooks, push, INBOX.md, `vr inbox`), so however long it is, it never
  pushes newer events out of what they read; For you reads it as what happened, and `vr export` carries it on. An
  earlier version appended it to `events.jsonl` itself: such lines stay where they are, and the readers pass them by.

## asks.json

Questions with options asked before any render, per workspace: `{"asks": [{id, folder, text, kind: "question",
options, answer_prompt?, status, author, author_id?, created, replies}]}` — a note's fields without a video or a
moment. `id` is a note's (`c_` + 6 hex, never one a note has). They follow their folder when it is renamed or moved,
and go one level up when it is deleted. At most 200 wait at once and 400 are kept; answered ones are kept a month, then
dropped with their files (`asks/<id>/`) — sooner, oldest first, past 400 or when the file would pass 8 MB (a new question
that still doesn't fit is refused). A question keeps at most 50 answers and 5,000 characters of text. Written compact;
a file that isn't `{"asks": [...]}` of questions is never read as empty or written over.

## Publishing (publish/posts.json, publish/connections.json)

Per workspace (`docs/publishing.md`). `posts.json`: `{"posts": [Post]}` — one per platform per final version: `id`
(`po_` + 12 hex), `slug`, `video_id?`, `v` and `render` (the final version and its render key), `platform`,
`connection`, `account`, `title`, `description`, `tags`, `cover_frame`, `visibility`, `schedule_at`, `ai_generated`
(null until a person answers), `youtube?: {category, made_for_kids}`, `instagram?: {kind, share_to_feed}`, `state`
(`draft` · `queued` · `uploading` · `scheduled` · `posted` · `failed` · `cancelled` · `sent`: sent, not confirmed),
who and when (`created`, `by`,
`by_id?`, `updated`, `published_by?`, `published_at?`), what came back (`remote_id?`, `url?`, `locked?`, `error?`,
`file?`), tries (`attempts?`, `next_try?`, `progress?`) and `history` (the last 50 `{at, state, by, note?}`, edits among them: "changed: title, description"); the server
also keeps `session` (an upload to resume, sealed), `round`, `committed_at` (the send reached the request that makes
the post), `checks`, `checked_at`, never sent to anyone. At most 5000 per workspace; past it the oldest finished ones go
(never one a person still has to look at).
`connections.json` (mode 0600): `{"connections": [{id (pc_ + 12 hex), kind: "youtube" | "zernio", label, state,
error?, accounts, key_hint, audited?, created, by, by_id?, checked?, sealed}]}` — `sealed` is the secret (client id and
secret, refresh and access token; or the API key) under AES-256-GCM with a key derived from the store secret and the
workspace and connection as additional data. The publish kit lives in the disposable `cache/publish-kits/<post id>/`.
`post` events (events.jsonl) carry `post: {id, platform, state, url?, account?, error?}` and a `text` line ("YouTube V3
posted (Studio Channel) https://…").

## INBOX.md

The newest 150 events from people (new videos, notes, replies, status changes, edits, assignments, approvals,
requests, references added to notes), newest first. It is the one file to read for "what did the reviewer say since
last time". On your machine every process that writes a person's event rewrites it; a hosted server doesn't keep it,
and answers `vr inbox` and `GET /api/inbox` instead, one line per event.

Each entry is a heading with the time, the kind of event, the note id and `→ <the assigned agent>` (when one is
assigned), then lines of `- field: value`:

```
## 2026-10-01T14:02:11+02:00 · NEW MUST · freeze · c_7f3a9b → promo-edit
- video: /home/alex/work/acme/export/ep02.mp4 (v1)
- at: 00:12:03 · frame 363 · range 360–372 · 00:12:00 → 00:12:12 (f360–f372, 0.43 s)
- text: short freeze here
- marked: /home/alex/.video-review/data/…/c_7f3a9b_marked.png
- clean: /home/alex/.video-review/data/…/c_7f3a9b_clean.png
- range frames: /home/alex/.video-review/data/…/c_7f3a9b_range.jpg

## 2026-10-01T14:05:40+02:00 · ANSWERED · c_1b2c3d → promo-edit
- video: /home/alex/work/acme/export/ep02.mp4 · 00:04:00 · frame 120
- comment: Keep the old logo?
- note: Yes, keep it
```

| Heading | Lines |
|---|---|
| `NEW MUST` … `NEW IDEA`, `NEW QUESTION`, `NEW INFO` (a new note: its severity, or its kind), then its tags | `- video: <video> (v<n>)`; `- at: <timecode> · frame <n>`, plus ` · range <in>–<out> · <range_at>` for a range note; `- text:`; then, where they apply, `- CHANGE WORDS "…" → "…"`, `- PART RENDER OK: …`, `- options: <group ids> (the reviewer picks in Lampo)`, `- marked:`, `- clean:` and `- range frames:` |
| `ANSWERED` (a question closed with an answer), `FIXED`, `VERIFIED`, `REOPENED`, `WON'T FIX`, `VERIFIED ON A PREVIEW (the next render must contain it)`, `CHECK AGAIN` (a newer render doesn't match the preview a fix was checked on) | `- video: <video> · <timecode> · frame <n>`; `- comment:` (the note's text); `- note:` (what came with the change, if anything did) |
| `REPLY` | `- video:` as above; `- comment:`; `- reply:` |
| `REFERENCE` (a reference added to a note) | `- video:` as above; `- comment:`; `- reference:` |
| `EDITED` | `- video:` as above; `- text now: <text> · <severity or kind> · <tags>`; `- CHANGE WORDS "…" → "…"` for a note that changes the words |
| `EDITED REPLY` (a person changed their reply's words) | `- video:` as above; `- comment:`; `- reply now:` |
| `REQUEST` (no note id) | `- video: <video> (v<n>)`; `- <the request>` |
| A question asked on a folder before any render ([asks.json](#asksjson)): `NEW QUESTION`, `REPLY`, `ANSWERED` or a status as above, with the note id and no agent | `- folder: <folder> (no video yet)`, or `- folder: - (no project, no video yet)` once its project was deleted; `- text:` (a new question) or `- comment:`; `- options: <group ids> (the reviewer picks in Lampo)` on a new question; `- reply:` or `- note:` with a reply or an answer |
| anything else: `ADDED`, `ASSIGNED`, `APPROVAL` (no note id) | `- video: <video>`; `- <the event's text>`, when it has one |

What people wrote stays on its line: a line break of any kind in it (CR, LF, VT, FF, NEL, U+2028, U+2029, and the
file, group and record separators) shows as ` ↵ ` (`review.json` and `events.jsonl` keep the line breaks). Folder and
file names given now are one line: the line and paragraph separators in them become spaces, and so do control
characters in a folder's name (a file's name drops them).

The same events, without new videos, are what wake an agent waiting in `wait_for_feedback` (`FEEDBACK_TYPES` and
`INBOX_TYPES` in `lib/eventLine.ts`).

## review.md

A readable copy of one review, rewritten whenever review.json is: the video, its project, the newest version, the
assigned agent, the stage and the counts, then the notes in sections (open, ideas, questions and notes from agents,
fixed and waiting to be checked, closed), the sign-off history and the versions. Each note shows its id, severity,
tags, timecode and frame, its text, its drawing in words, the screenshots' paths and its replies. Read through the API
or MCP by anyone but the machine itself, it names the screenshots and the data by URL instead, never by a path on the
server's disk.

## folders.json and shares.json

```json
{"folders": ["Acme", "Acme/Reels", "Acme/Reels/Spring", "Globex"],
 "ids": {"Acme/Reels": "f_1a2b3c4d5e6f"},
 "archived": {"Globex": {"at": "2026-10-07T10:12:03+02:00", "by": "Ada", "by_id": "u_…"}}}
```

The folders, listed so that empty ones survive. A video's own folder is `folder` in its review.json.

- **`ids`** (optional) names the folders review links were made on. An id moves with its folder (renamed, moved, or
  its parent deleted) and ends with it, so a folder deleted and made again under the same name is another folder.
- **`archived`** (optional) names the projects (top-level folders only) that were archived: when, by whom (a name,
  and the account for newer records). An archived project leaves the lists and takes nothing new until it is
  restored, which removes its entry ([api.md](api.md#library-and-folders)). Every change of the file keeps the entries
  of the projects still there; a repair keeps those the damaged text still names in whole. Absent while none is.
- **A file that can't be read is never taken for no folders.** No file means no folders yet. A file that can't be read
  or parsed stops every folder change instead, which would write it again without its ids; `shares.json` and
  `links.json` are read the same way. Meanwhile the library, search, playbooks and downloads show the folders videos
  are filed in (`LibraryResponse.degraded: ["folders"]`), the owner's lists of review links and the stages keep every
  link (a folder link's `gone` can't be told meanwhile), and a folder link's visitor is asked to come back later.
- **`vr admin repair-folders`** rebuilds a damaged file from what it still says, the videos' folders and the review
  links' ids. Without `--write` it is a dry run; with it, the damaged file is kept as `folders.json.damaged-<time>`. An
  id the damage took comes back from a folder link only when nothing says its folder had ended (a later link on that
  name, an id older than the newest the file still holds) and either it is the newest of several on that name or the
  store shows the folder is the link's own (a video filed there since before the link, or one its visitors opened).
  Any other is left as a person's call (`--take-back <link id>`), never given to a namesake.

```json
{"shares": {"sha256:<hex of the token>": {
  "sealed": "<iv>.<tag>.<token encrypted with a key derived from share-secret.key>",
  "id": "s_3f9a1c02de", "slug": "…", "label": "Acme marketing", "created": "…", "by": "alex",
  "video_id": "r_4e8a1c2b9d3f", "video_added": "…",
  "comment": true, "approve": true, "notes": "own", "versions": "latest",
  "download": "off", "expires": null,
  "stats": {"opens": 3, "last_opened": "…", "reviewers": ["Mia"],
            "videos": {"<slug>": {"views": 2, "last_viewed": "…", "seen_v": 4, "by": "Mia"}}}
}}}
```

- **No usable link in the file.** Entries are keyed by the SHA-256 of their token. `sealed` keeps the token only so
  the owner can copy the link again in their own browser (AES-256-GCM, with a key derived from `share-secret.key`,
  which never leaves `data/`); a list of links asked for with an API token leaves the tokens out. Files from before
  used the token itself as the key; they load unchanged and are rewritten in the hashed form when the server starts.
- **Written compact, in batches.** The file has no indentation, and what visitors do reaches it in batches, at most
  two seconds later. Each link keeps a bounded number of records ([sharing.md](sharing.md#what-a-link-records)).
- **What a link covers.** `/g/<token>` shows its one video (`slug`), or for a folder link (`folder`, no `slug`)
  every video filed in that folder or below it. Newer links also name what they were made for: `video_id` and
  `video_added` (the review's `id` and `added`), or `folder_id` (the folder's id in `folders.json`). A video added
  again under the same slug is another video, and the link doesn't cover it. Deleting the video (one without notes)
  or the folder revokes its links. Links from before get these fields when the server starts; one whose video or
  folder is gone by then, or that is older than the video now at its slug, is revoked instead.
- **Who and when.** `by` is who made the link and `by_id` their account (optional, newer links); `updated` is when its
  settings last changed.
- **Settings.** `comment`, `approve`, `notes` (`own` or `all`), `versions` (`latest` or `all`), `download` (`off`,
  `preview` or `original`) and `expires`. `password` (a scrypt hash) and `password_v` are present on protected links;
  revoking adds a `revoked` time. `embed: true` marks an Embed link (one video's player for another site): it plays the
  newest version only, whatever the other settings say, never has a password, is set when the link is made, and shows
  no visitor's notes or decisions, whatever came in under it. Every field after `by` is optional:
  entries without them (links from before these settings) mean comment and approve, their own notes, the newest
  version, no downloads and no expiry. What each setting does: [sharing.md](sharing.md).
- **Per workspace.** Each workspace has its own `shares.json`, and `data/links.json` says which workspace a link
  belongs to ([Workspaces](#workspaces)).
- **`stats`** counts visitors only, never the team checking its own link: `opens`, `last_opened`, `reviewers` (the
  names they gave), and optionally `downloads`, `last_download`, `recent_downloads`, `visitors` (by a key their
  browser's random id gives, never an address), `activity` (the latest 200 things done through the link) and
  `videos`. `videos` says which videos a visitor opened and the newest version they had in front of them (`seen_v`);
  the stage uses it to tell "shared" from "seen by the client" ([workflow.md](workflow.md)), and `watch` there holds
  how far each visitor watched ([below](#watching-who-watched-how-often-how-long)).

## Watching (who watched, how often, how long)

Players report what plays in coarse pieces ([`lib/watch.ts`](../lib/watch.ts)): every version is cut into 100 equal
parts, and a report says which parts played (`seen`, 100 bits as 25 hex digits), how often each one did (`plays`, 100
whole numbers) and for how long (`secs`), never the moments themselves. Review-link visitors are kept with their link
(`shares.json` → `stats.videos.<slug>.watch.<visitor key>`). The team is kept in `data/<slug>/views.json`, next to the
review but out of `review.json`, which agents read:

```json
{"viewers": {"u_…": {"name": "Sam Rivera", "v": 3,
  "seen": "fff…", "plays": [2, 2, 1, …], "secs": 48.5, "sessions": 2,
  "first": "…", "last": "…", "total_secs": 71, "total_sessions": 3}}}
```

| Field | |
|---|---|
| `v` | the newest version they watched; a newer one starts the per-version fields over |
| `seen`, `plays`, `secs`, `sessions` | that version: the parts played, how often each played (at most 999), seconds, and sittings (a report more than half an hour after the one before starts a new sitting) |
| `total_secs`, `total_sessions` | every version of the video |
| `first`, `last` | the first and the latest report |
| `name` | the account's name when it last watched. `views.json` is keyed by account id (on your machine: the owner's) |

On a link's records `name`, `plays`, `sessions`, `first`, `total_secs` and `total_sessions` are optional: records from
before have none, and readers count them as one sitting with each played part played once. `views.json` keeps the 100
most recent viewers and is written under a lock of its own (`data/<slug>/.views`). Agents with an API token never
report watching.

## Playbooks

`data/playbooks/house.json` is the House playbook, and `data/playbooks/f_<first 20 hex digits of the SHA-1 of the
folder path>.json` a folder's (a hash, because a folder name may hold anything a file name can't; the path is inside).
One file each:

```json
{
  "id": "pb_4c1d…", "scope": "Acme/Reels", "rev": 5, "updated": "…", "by": "Sam",
  "brief": "…markdown…",
  "rules": "- 9:16, first cut within 1.5 s\n- …",
  "refs": [
    {"id": "r_…", "kind": "frame", "video": "<slug>", "v": 2, "frame": 40, "still": "r_….t.jpg",
     "caption": "This warmth", …}
  ],
  "skills": [
    {"id": "sk_…", "name": "reels-export",
     "description": "…", "body": "…", "extra": "license: …",
     "files": [{"name": "reels-h264.epr", "size": 812, "at": "…", "by": "Sam"}],
     "updated": "…", "by": "Sam"}
  ],
  "history": [
    {"rev": 5, "at": "…", "by": "agent:promo-edit", "accepted_by": "Sam", "proposal": "pp_…",
     "message": "…", "section": "rules", "before": "…", "after": "…"}
  ],
  "proposals": [
    {"id": "pp_…", "scope": "Acme/Reels", "at": "…", "by": "agent:promo-edit",
     "section": "rules", "content": "…", "reason": "…", "evidence": ["c_…"], "base_rev": 4,
     "status": "accepted", "decided_by": "Sam", "decided_at": "…", "rev": 5}
  ]
}
```

- `section` is `brief`, `rules`, `refs` (history only) or `skill:<name>`; a skill's `before` and `after` are its
  SKILL.md. A rejected proposal may carry `reject_reason`, for the agent to read.
- The newest 200 revisions and 50 decided suggestions are kept.
- `refs` use the shapes of a note's references. A playbook's files (skill files, reference pictures) are stored
  through the storage layer under `playbooks/<id>/skills/<skill id>/` and `playbooks/<id>/refs/` (on local disk inside
  `data/playbooks/`).
- A deleted folder's playbook moves to `data/playbooks/archive/`.
- Every version's `playbook` field records the revisions in force when it arrived.

More: [playbooks.md](playbooks.md).

## Transcripts

`cache/transcripts/<sample or hash>.json`, one per render's bytes: two videos holding the same render share it, and a
cleared cache only costs hearing it again. The shape is `Transcript` in `lib/types.ts`:

| Field | |
|---|---|
| `transcript_version` | 2 (older ones are heard again when asked for) |
| `hash` | the version's `hash` |
| `language` | ISO code, or `""` when not detected |
| `engine` | `local:<model>` or `http:<model>` |
| `timing` | `word`: the engine timed every word; `line`: it timed sentences (or only some words), and the other words were spread over their lines by length |
| `fps`, `frames` | of the version |
| `words` | `{text, t0, t1, f0, f1}`: seconds, and the frames the word is heard on (from the frame on screen at `t0` to the last one before `t1`) |
| `lines` | reading lines: `{text, t0, t1, f0, f1, w0, n}`, words `w0` to `w0 + n − 1` |
| `repairs` | stretches the first pass lost and that were heard again: `{t0, t1, engine}` (optional; [speech.md](speech.md)) |
| `created` | when it was made |

## Agent runs

`<slug>/runs.jsonl` keeps the runs of agents on that video: one stretch of an agent's work, opened when a team member
sends it notes (or by the agent's own first write), ended when it hands back ([agents.md](agents.md#your-work-as-the-person-sees-it-runs)).
One JSON object per line, one line per run, oldest first: the run as `GET /api/runs/:id` shows it
([api.md](api.md#agent-runs)), plus `steps` (what it did, oldest first) and `clock` (the server's own counters). The
app rewrites the file under the video's lock (`.lock`), atomically, about a second after a change; nothing else
writes it, and `vr` only reads it to name a version's run. It is compacted as it is written: at most 200 steps per
run (a stretch of render progress keeps its first and last line; the first step, questions and errors stay), and a
run that ended more than 90 days ago keeps no steps. Lines it can't read are kept as they are. A store without the
file has no runs; nothing else changes.

Runs on a question asked on a folder before any render (`asks.json`) live in the workspace's own `runs.jsonl`, with
`slug: null` and `folder`.

## Live agent activity

`cache/agent-activity.jsonl` is how an agent's process on your machine (`vr`, the stdio MCP server) tells the running
app what it did, so the person sees it live ([agents.md](agents.md)). One JSON object per line, appended (readable by
you only: what an agent did is yours); past 512 KB the file becomes `agent-activity.jsonl.1` and a new one begins. The
app reads only what is added while it runs, keeps the last 12 lines per agent and video in memory, and never writes
them to a review. Disposable like the rest of the cache.

One line, spread out here:

```json
{
  "at": "2026-10-01T14:02:11+02:00",
  "agent": "promo-edit",
  "kind": "fix",
  "text": "Fixed c_7f3a9b “freeze removed”",
  "key": "Fixed {id}",
  "vars": {"id": "c_7f3a9b"},
  "quote": "freeze removed",
  "target": "c_7f3a9b",
  "video": null
}
```

`agent` is the Claude Code session's name, or the one in `VR_BY` (a person running `vr` by hand writes nothing).
`video` names the video as the agent did (a path, a name or a slug), and `target` a note id the app finds the video
by. `kind`, `text`, `key`, `vars`, `quote`, `pct`, `progress` (a render through `vr render`: its stage, percent,
frames and time left) and `run` (the run Lampo started the agent for, from `LAMPO_RUN`) are as in
`GET /api/agent-activity` ([api.md](api.md#sessions-agents-and-the-inbox)). A process with `LAMPO_RUN` and no name of
its own writes as `agent`.

## Accounts

`users.json` (0600) holds the accounts, the API tokens (`tokens`, each kept as its SHA-256) and the sessions signed
out on one device, until they would have ended anyway (`revoked`). An account is `PublicUser` in `lib/types.ts`, plus
its password (an scrypt hash) and `epoch` (raised to end every session at once):

| Field | |
|---|---|
| `id`, `email`, `name`, `created` | who it is |
| `role` | its role in workspace #1. With workspaces, each role is in `workspaces.json` ([below](#workspaces)), and this one mirrors the account's role in `w1` |
| `outside_w1` | `true` on a store that moved to workspaces when the account isn't a member of `w1` (it left, or was made for another workspace); its `role` is then the least one, so nothing of #1's could ever be read back from it (optional) |
| `disabled` | when it was disabled (optional) |
| `local` | the owner of the machine the app runs on, signed in there without a password (optional) |
| `avatar` | its profile picture's file (`u_…-<hash>.jpg`), kept through the storage adapter under `avatars/` (optional) |
| `prefs` | choices that follow the person: `theme`, `lang`, `voice_languages`, `wake`, `signin_alerts`; `moments`, the one-time notices they put away, per workspace (a notice's id → until when; only where a billing provider runs); and `onboarding`, the first run (`{since, done?, hidden?, complete?, setup_due?, setup_done?, agent?, plan?}`; absent on accounts from before it, which never see it). `setup_due` is set when the account is made and the setup shows on the next visit; `setup_done` is when it was finished or skipped; `agent` is the agent picked in it (`claude-code`, `codex`, `cursor`, `chatgpt`, `claude`, `other` or `none`), which Get started and the sample name; `plan` is the plan picked on the website before signing up |
| `unverified` | since when its address waits to be confirmed by an emailed link (optional; absent: confirmed, or vouched for by whoever made the account) |
| `signup` | when the person signed up on their own (optional); until the address is confirmed, such an account can do nothing |
| `pending_email` | a new address waiting for its emailed link (optional); the account keeps signing in with `email` until then |

- `account-links.json` (0600) keeps the emailed one-time links, `vt_…` to confirm an address (24 hours) and `rt_…`
  for a new password (60 minutes): each token's SHA-256, the account and the address it went to, never the token. A
  newer link of the same kind voids the older ones; used, voided and expired links are kept a week.
- `mail/queue.json` (0600) holds the emails waiting to go out, each sealed (AES-256-GCM, with a key derived from
  `secret.key`), so the file alone gives no link away. Without a mail relay, emails are written to `cache/outbox/`
  instead ([email.md](email.md)).

## Workspaces

A hosted server can hold several teams, each in its own **workspace**, each seeing only its own videos, notes,
review links, playbooks, events and people. The app on a person's own machine is always one workspace.

- **Workspace #1 (`w1`) is the store as it always was**: `data/`, `versions/`, `cache/` and its storage keys stay
  where they are. Every other workspace has the same layout one level down: `data/w/<id>/`, `versions/w/<id>/`,
  `cache/w/<id>/`, and storage keys under `w/<id>/` (`w/<id>/versions/<slug>/v2.mp4`). An id is `w_` plus 12 random
  lower-case letters and digits.
- **What belongs to no workspace** stays in `data/` itself: accounts (`users.json`, `invites.json`), sessions, OAuth
  clients and connections (`oauth/`), devices for notifications (`push/`), the keys, `workspaces.json`, `links.json`,
  `account-links.json`, `mail/` and `backups/`. Profile pictures belong to no workspace either.
- **`workspaces.json`** (hosted servers: each workspace and its members, written at a hosted server's first start;
  0600) lists each workspace (`id`, `name`, `created`) with its `members`: `{user, role, since, suspended?}`, the
  account id and its role there (`owner`, `admin`, `member`, `reviewer`); `suspended` is when an admin of that
  workspace disabled the person there (no role in it until let in again). An account can be a member of several
  workspaces with a different role in each. `signup: true` marks one made for someone who signed up on their own (its
  name was theirs, a placeholder); `named` is when a person chose its name (made in the app or with `vr admin`, or
  renamed); `by` is the account it was made by or for (what `VR_WORKSPACE_CREATE_LIMIT` counts); `personas` is who
  its videos are for, as its owner picked in the setup (`agency`, `inhouse`, `creator`, `other`; absent: never asked
  or skipped), with `personaOther`, "something else" in a few words. API tokens, invites and app connections name
  the workspace they act in (`workspace`; absent means `w1`, as everything written before workspaces does).
- **A store without `workspaces.json`** is workspace #1 alone, and its members are every account with the account's
  own `role`, exactly how stores always worked (an account that signed up on its own without an invite, `signup` set,
  is never one of them: it gets a workspace of its own). A hosted server moves its store to workspaces once, at start
  (or `vr admin workspaces migrate`): it copies `users.json`, `invites.json`, `oauth/grants.json` and `shares.json` to
  `data/backups/workspaces-<time>/` first, names `w1` on the tokens, invites and connections from before, and writes
  `workspaces.json` with every account as a member of `w1`. Nothing moves on disk. Running it again does nothing.
- **A store that moved never goes back.** The store shows the move by a `data/backups/workspaces-*` folder, a
  `data/w/<id>/` folder (on a hosted store even an empty one, on the machine's only one with files in it), a token or
  invite with `workspace`, or an app connection in another workspace. When `workspaces.json` is missing or can't be
  read on such a store, nothing is implied: instead of making every account a member of `w1`, the server and `vr`
  refuse with one sentence until the file is restored from a backup, and a running server answers `503` meanwhile. A
  read that fails is tried again on the next request; it is never taken for a lost file. A store is hosted by its
  shape, whatever the process was started with (accounts, none of them the machine's own), so an operator's `vr`
  without `VR_MODE=server` reads a server's store as the server does. When a workspace folder is the only sign, the
  sentence names it and both ways out (restore the file, or move a folder a mistyped `VR_WORKSPACE` once left), never a
  backup as certain; on the machine an empty one is no sign at all. The move (`vr admin workspaces migrate`, a hosted
  start) never runs while `data/w/` holds a workspace folder, empty or not: it would write `w1` alone over the other
  workspaces.
- **`vr` and the stdio MCP server** on a store work in one workspace: `VR_WORKSPACE=<id>`, else `w1`. An id the store
  has no workspace for is refused before anything is read or written.
- Review links of every workspace but #1 are listed in `data/links.json` (0600) by their token's SHA-256 with their
  workspace, so a visitor's link is looked up in its own workspace first; a token not listed is workspace #1's.

## Screenshots

`<id>_clean.png` is the note's exact frame at full resolution, grabbed by ffmpeg with the render's colour information
applied. `<id>_marked.png` is the same frame with the drawing burned in at video-pixel coordinates, by the same code
the app draws with: what the reviewer saw is exactly what the agent gets. `<id>_range.jpg` (range notes) puts up to
six frames across the range in rows of up to three (2 × 2 for four), left to right and row by row, each grabbed the
same frame-exact way.

![One note's two screenshots side by side: the clean frame, and the same frame with the reviewer's box and arrow burned in](assets/clean-and-marked.webp)

## Compatibility

- New fields may appear anywhere; readers must ignore what they don't know.
- Existing fields keep their name, type and meaning.
- Stores written by older versions load unchanged. `test/fixtures/store-v0/`, frozen in the oldest format (2026-09-28),
  is what `test/unit/contract.test.ts` starts the app on; a format change adds a new frozen store, never edits it.
