# Project files

Renders are what Lampo reviews. Project files are what they are made from: footage, music, voice takes, fonts, logos,
After Effects or Premiere projects. Kept in Lampo, they let a team, its agents and the next person who picks a project
up work from the same material, on any machine, without the laptop it came from.

This page describes the model, the app's Files tab, what agents use (`lampo files` and the MCP tools) and the server's
API.

## Where files live

Files attach where [playbooks](playbooks.md) do:

- **the House**: the workspace's own (the studio's fonts, logos, music library);
- **a project**, and **any folder** inside one (*Acme*, *Acme/Spring*).

A folder sees its own files and every area above it, deepest first: *Acme/Spring* sees its own, then *Acme*'s, then the
House's. The same path in a deeper area hides the one above, so a campaign's `Fonts/Brand.otf` replaces the studio's.
Every answer says which area a file comes from.

Inside an area, files keep their **paths as uploaded** (`Footage/Day 1/A001C003.mov`), so a project's relative links
still work after a pull. Folders inside an area are entries of their own: "New folder" makes an empty one, and a folder
stays when its last file leaves. A project's or folder's area follows it through renames and moves. When a folder is
deleted, its files go to the trash of the folder above it (or the House), as one group under the deleted folder's
name, and can be restored together.

## Paths

A path inside an area is a name, never a path on the server. It is kept exactly as uploaded or refused, never cut or
rewritten (only its Unicode form is made one: NFC, as a Mac's names read the same everywhere):

- `/`-separated names, no empty, `.` or `..` name, nothing before the first name (`/`), no backslash;
- no control characters, line breaks or direction marks; no name that starts or ends with a space;
- at most 1,024 bytes in all, 255 bytes a name, 32 names deep;
- not junk a file system or tool leaves behind: `.DS_Store`, `Thumbs.db`, `._*`, anything under `.git/` or
  `__MACOSX/` (clients skip these and say so);
- two paths that differ only in case are the same place (they would be on a Mac or on Windows): the second is a
  conflict, not a new file;
- a name given now — a new file or folder, a rename, the folders a new path makes — doesn't start with `-` (a command
  line would read it as an option). Names kept from before stay: their files take new versions, their folders new
  files, and a move keeps a name.

The rules are in [`lib/fileText.ts`](../lib/fileText.ts), shared by the server, the CLI and the browser.

## Versions, conflicts and the trash

**Every write is a version**, attributed and recoverable: the account that made it, the agent that did it with that
account (and its kind), how it came (the app, the CLI, an agent's tool), when.

- **A push names the version it was based on** (`base`). Pushing to a path that is taken without a base, or with a base
  older than the version there now, is refused with 409 and who changed it since — before any byte moves, and again
  when the bytes arrive, in case it changed meanwhile. With `conflict: "copy"` the push is kept beside the file instead,
  under the writer's name: `spot (Alex).aep`. Bytes refused at the last moment stay stored, so the same push can be
  committed as a copy without sending them again.
- **Older versions** are kept 30 days after they were replaced, the ten newest of each file (versions kept on purpose
  besides) — and every version replaced within the last day, whoever replaced it. Any of them can be brought back as
  the newest version (V5 with V2's bytes; V4 stays one of its versions); bringing back the bytes the file has already
  makes no new version. Each account (a person with their agents) makes at most 24 new versions of a file a day: its
  next is refused (429, with when it may come) until the first of them is a day old, and nobody else's versions are
  held up by it. A save as a copy (`conflict: "copy"`) is never refused for it: it lands beside the file. An upload URL
  handed out while there was room is checked again when its bytes start to come.
- **The trash** keeps a file 30 days. Restoring puts it back at its path, or beside it as `name (restored).ext` when
  something else is there now. Members trash what they added; owners and admins anything.
- **Bytes are kept once per workspace** by their SHA-256: the same logo in fifty projects is stored and counted once.
  Never across workspaces: one workspace is never told what another holds.

## What counts toward the plan

Files and renders share the plan's storage.

- **Counted:** the current version of every live file, once per workspace, versions kept on purpose (pinned), and
  uploads waiting for their commit (a push that stores first and commits later): until they are committed, or for the
  day the server keeps them.
- **Not counted:** the trash and replaced versions (the safety net). Trashing a file gives its space back at once, up
  to what the safety net may hold; what it holds past that counts for the day below.
- The safety net is kept 30 days, and holds at most a quarter of the plan's storage — and, plan or none, never more
  than what the workspace's files count (or a floor of 5 GB). Past that, the oldest of it goes early, with its bytes,
  but **nothing that went in within the last day**: a file just trashed, a folder just deleted, a version just
  replaced stays restorable. While such recent things hold the net over its cap, what it holds over counts toward the
  plan (pushes, commits and restores get the plan's refusal) until it may go. Every trashed file says when it really
  goes (`purge_at`), every older version too (`kept_until`).
- **Uploads under way** count by their declared size from the start, as renders do.
- **What comes back counts again:** restoring from the trash, a trashed folder or an older version is checked against
  the plan like a push, by what it changes: what the trash held past its cap counts already, so it isn't counted
  twice.

A push is checked against the plan and the server's disk for all of its files at once, before any byte moves: a 402
with the plan's sentence and the numbers the limit sheet shows (`reason`, `needed`, `room`, `fits`), or a 507 when the
server's disk has no room. `GET /api/files/usage` says what the files hold.

## Who sees files

| | reviewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| see, list and download files | | ✓ | ✓ | ✓ |
| add, replace, rename, move and restore files; trash what they added | | ✓ | ✓ | ✓ |
| trash anyone's files | | | ✓ | ✓ |

- **Reviewers don't see files.** The material is the team's, often confidential: their file routes answer 404.
- **Review links never reach files.**
- **API tokens** act with their account's role. **OAuth apps** need the scopes `files:read` (list and download) or
  `files:write` (also add, replace, move and trash): an app connected with `review:act` never gains a project's
  footage without being asked.
- Another workspace's file ids answer 404, like ids nobody has.

## The bytes, in and out

**In.** `POST /api/files/uploads` names the files of a push (path, size, sha256 when known, base). For each file whose
bytes the workspace holds already it answers `stored: true` (nothing to send: commit it); for the others a one-time
ticket that takes the bytes once, for 15 minutes:

- one plain `PUT` to its `url` (`curl -T file <url>`), from anywhere — the URL is its own credential;
- or **tus** (resumable) at the answer's `tus` endpoint, with `Upload-Metadata: ticket <b64>, filename <b64>`, signed
  in as the account that asked. The ticket is spent when the upload is made; the upload then resumes for a day
  (`HEAD`, `PATCH`), for that account only.

When the last byte arrives the server hashes it (a mismatch with the sha256 named is refused, nothing kept), reads its
type from its first bytes (never from its name or what a client says), keeps it once, and — unless the push asked
`commit: false` — commits it at its path. A push of many files can store them all first and commit them in one change
(`POST /api/files/commit`).

**Out.** `GET /api/files/:id/download` redirects to a short-lived signed URL on the media host, or streams the file
when the server has none. Every download is an attachment: `application/octet-stream`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`, ranges for resuming, from a host with no cookies. The signed URL asks
again, on every request, whether whoever it was handed to may still read files: a member removed, a token revoked or
a session signed out stops it. `POST /api/files/urls` gives signed URLs for up to 100 files at once (an hour for an
API token, six for a person), for a pull or a render that streams a clip.

A **preview** (`?inline=1`) is shown as what it is only for pictures (JPEG, PNG, GIF, WebP, AVIF), video, sound, PDF
and plain text, still sandboxed. Nothing else a person uploaded is ever shown inline: an SVG or an HTML file only
downloads.

## Where the bytes are kept

Through the storage adapter renders use: with local storage (the default) on the server's disk in `data/files/`
(never the disposable cache), each workspace's under its own prefix, in the normal backup; with Bunny or S3 storage, in
the bucket.

```
data/files/areas/<area>.json        an area's catalog: its files, older versions, folders, trash
data/files/areas/<area>.log.jsonl   its journal: every change, append-only
data/files/blobs/<ab>.json          which bytes the workspace holds: size, type, when
data/files/sha256/<ab>/<sha256>     the bytes (through the storage adapter)
```

Every catalog change holds the workspace's files lock and replaces the file atomically. A catalog that can't be read is
never treated as empty: reads and writes refuse until it is put right. All bytes go through one function in the
storage adapter (`filesStorage()` in [`lib/storage/index.ts`](../lib/storage/index.ts)), so giving them a bucket of
their own, apart from the renders, is a setting there; the catalogs stay in `data/` either way. From a bucket,
downloads are the bucket's own signed URLs.

**The purge** runs hourly per workspace: the trash and replaced versions past 30 days (or past the cap), then bytes no
catalog names any more and that are older than a day — an upload committing now is never swept. A catalog that can't
be read stops it before anything is removed. Deleting a workspace deletes its files with it.

## In the app

Every project and folder has a **Files** tab beside its Videos and Playbook (`#/files/<folder>`); the House's files
are in Settings → Files. Reviewers have neither.

![A project's Files tab: its folders (Footage, Grade, Music) and files with their icon, version, size, who changed them and when; the House’s typeface folded below; and the end card opened beside them with its preview and its two versions, the newer one by the film’s agent](assets/files.webp)

- **The list**: the area's folders, then its files, in three columns: *Name* (with the kind's glyph, or a small poster
  of footage and pictures, and beside the name a folder's number of files, a clip's or a sound's length, a version past
  V1), *Size*, and *Changed* (who changed it last, an agent with its mark, and when; for a folder its newest file's).
  A column's name orders the list by it, again the other way (on a phone: the order control beside the count); the
  order is kept in the browser. Under the pointer, and on the row the keys are on, a file shows *Download*, *Copy for an
  agent* and ⋯. What it inherits from its project and the House is folded under it ("Also here, from the Acme
  project"): where both have a file of the same name in the same folder, the area's own is used. Search looks in every
  folder inside; the kinds narrow the list in place. Keys: ↑↓ (⇧ to pick), ↵ opens, Space is Quick Look, F2 renames a
  file or a folder, ⌫ trashes (with Undo), ⌘A picks all, ⌘↑ goes up a folder, `/` searches, ⌘1 / ⌘2 a grid or a list,
  Tab reaches the keys' row's actions.
- **Posters and lengths**: the server reads a version's length and size in pixels with ffprobe and makes a poster of
  footage (its frame at one second) and pictures within 128×72 with ffmpeg, the first time a row is seen, from the bytes
  on its own disk (a file kept only in a bucket gets none); both are kept in the workspace's cache by content
  (`cache/file-media/`), and a file ffmpeg can't read is remembered as such. A poster counts as one of the account's
  new frames.
- **A grid or a list**, as in Finder: the toolbar's switch (⌘1 grid, ⌘2 list), kept per folder in the browser. A
  folder opens as a grid where more than half of its files are footage or pictures (a folder of folders: where more
  than half of them hold some), else as a list. The grid shows each file large (its poster on a dark frame, its length
  and size on it, the name under it; a long name is cut in its middle, its end kept), a folder as a mosaic of the first
  four pictures inside it (`dirs[].pics` in the listing) or its glyph, and a file on its way with how far it got; two
  columns on a phone. The arrows move by tiles and by rows of them.
- **Scrubbing**: under a mouse (never a finger) a clip's tile shows the frame for where the pointer is across it, from
  a strip of 8 frames the server makes on the first hover (`GET /api/files/:id/scrub`: one ffmpeg seeking once per
  frame, never decoding the clip, counted as the 8 new frames it decodes, kept like the poster; a clip it can't make
  a strip of is remembered, never tried again). In the list, a
  clip's or a picture's row shows a card with it larger after a short rest, above the row (under it near the window's
  top), a clip flipping through its strip; it goes when the pointer moves on, and never shows while files are picked or
  in Quick Look.
- **Quick Look**: Space, or a click on a picture, shows the file large: a clip plays, a picture fills the room, a sound
  shows its waveform (read in the browser, files up to 40 MB) over its player, anything else its kind and name. ← → go
  through the folder's files, Space or Esc closes; *Details* opens the file beside the list, with its versions.
- **An empty project**: *Add files*, and *Copy prompt for your agent*: the agent connects itself to Lampo unless its
  tools are there, asks which folder of yours goes up (it changes nothing in it), puts it here with `lampo files push`
  and says what went up and what was left out ([Agents](#agents)).
- **Adding**: drop files and folders anywhere on the tab, or *Add files* (a folder, or a new empty folder, from its
  menu). Before a byte moves, one sheet says what will happen: what is already in Lampo (the browser hashes files up
  to 256 MB and asks), which files become a new version, what is left out (junk), and whether it fits the plan. The
  uploads run in the upload tray over tus, three at a time, each file's one-time upload URL asked for a few files ahead
  (a URL lives 15 minutes; one that ran out before its file started is asked for again by itself): they resume after a
  dropped connection, and dropping the same folder again after a reload continues where each file stopped. Signing out
  stops them and forgets them, and what the browser kept to resume them. A file someone changed while yours was on its way is never
  overwritten: the tray names who changed it, with *Keep both* (yours lands beside it) or *Replace*. A file you made
  the day's versions of already (each person's own, with their agents) waits there with the time it takes your next,
  and *Save as a copy* lands yours beside it now; *Restore* in a file says the same.
- **A file, opened**: beside the list on a wide screen, over it on a narrower one, a sheet from the bottom on a phone.
  Pictures, video, sound and plain text show in the sheet; a PDF opens in a tab of its own (*Open*); anything else
  downloads. Every version kept, who made it and whether an agent did, *Restore* and *Download* per version; rename,
  move (also into another project's files), trash, and *Copy for an agent*: the `lampo files pull` line that fetches
  exactly the files picked. An address naming a file that isn't there any more says so, with the way back.
- **The trash**: at the foot of the area's top ("Trash: 1 file, 3.1 GB, doesn't count toward your storage"), *Restore*. Each file says when it goes (`purge_at`: up to 30 days), an
  older version until when it is kept (`kept_until`). A member trashes what they added; owners and admins anyone's.
- **The plan**: where a billing provider runs, the list's foot has a bar of the plan's storage ("310 GB of 2.5 TB",
  amber and in words from 80 %, a way to Settings → Billing; its tooltip splits it into files and videos), and Settings
  → Billing and the plan's sheet split the storage into videos and files.

## Agents

An agent works from the same material as the team, on any machine, and saves what it makes back as a version of its
own. A shell has `lampo files`; any MCP client has `list_files`, `get_file` and `add_file`. Both work on the store on
this machine, or on a hosted server after `lampo login` (or with `LAMPO_SERVER` and `LAMPO_TOKEN`), with the account's
rights: reviewers' tokens find no files, and an app connected over OAuth needs `files:read` / `files:write`.

An area is named the way the app names it: a project's or folder's path (`'Acme/Spring sale'`), or `House` for the
workspace's own (a project that is called "House" is `House/`). A folder sees its own files and those of every area
above it, deepest first, as in the app.

```sh
lampo files ls 'Acme/Spring sale'                     # what applies there, in short
lampo files ls 'Acme/Spring sale' Music               # one folder's files, with their ids
lampo files pull --to=public/ --only='Music/**' --only=Brand/logo.svg -- 'Acme/Spring sale'
lampo files status --to public/                       # what changed here and there since
lampo files push --to='Acme/Spring sale' -- public/   # what changed here, as new versions
lampo files push --to='Acme/Spring sale' --path=Footage/ -- ./Shoot   # as Footage/Shoot/…
```

```
files for Acme/Spring sale · Acme/Spring sale r14 · Acme r3 · House r2 (deepest wins)
Acme/Spring sale  Footage/  214 files  182.4 GB  footage
Acme/Spring sale  Music/  11 files  412 MB  audio
House  Fonts/  6 files  2.1 MB  font
```

*Copy for an agent* in the Files tab copies exactly such a pull line, for the files and folders picked, with the
`list_files` call under it. The lines Lampo hands out (that one, and what `lampo files` and the tools say to run next)
give every value attached to its option (`--only=<glob>`) and put the area, or what goes up, after `--`: `lampo` reads
nothing after `--` as an option, so a file or folder whose name starts with dashes stays a name, and the line does
what it says. Typed by hand, `--to <dir>` and `<area> --to <dir>` work as well.

**`lampo files pull <area> [<path|glob>…] [--only <glob>]… --to <dir>`** fetches what applies there into `<dir>`, at
the paths the area keeps (`Music/bed.wav` lands at `<dir>/Music/bed.wav`). Without a path or glob, everything that
applies; `*` and `?` match inside a name, `**` any number of names, a plain path the file or the folder with all in
it; a path that differs only in case is the same place. It:
- fetches only what changed: a file already there with the same bytes stays, and a pull run again goes on with a file
  it broke off (its bytes wait beside it as `.lampo-<hash>.part`);
- never writes over a file that changed here since it was pulled, or that Lampo didn't write (`--force` does);
- checks the room on the disk first, and fetches nothing that doesn't fit (`--dry-run` says what it would fetch);
- writes what it pulled into `<dir>/.lampo/files.json`: each file's area, id, version and sha256, so `status` knows
  what changed on either side and `push` which version each file was based on.

**What a pull never does**, whatever a server sends (one that was taken over, or not the one you think): it writes
nothing outside `<dir>` — no `..`, no absolute path, no drive letter or share, no NUL or control character, nothing in
`.lampo/`, and on Windows none of its device names (`CON`, `NUL`, `COM1` …), its characters (`<>:"|?*`) or a name that
ends with a dot or a space —, never into or through a symbolic link that is in `<dir>` (wherever it points), never
onto a folder, and of two names that would meet on a disk that ignores case only the first (the deepest area's). A
name starting with a dot (`.env`, `.claude/settings.json`) comes only when a pattern names it exactly. Every file is
written to a new file beside its place and moved in only once its size and sha256 are right; bytes that are more than
its size, or another sha256, are never kept. The token goes only to the server's own download route: a signed URL
elsewhere (the media host, a bucket) and a redirect get nothing of it.

**`lampo files push <file|folder>… --to <area> [--path <folder>]`** saves files and folders of this disk there: a
folder by its name with all in it, as dropping it in the app does (`./Shoot` → `Shoot/…`); with a slash at its end,
what is in it (`public/` → its files at their paths, the way back of a pull); a file by its name. `--path` is the
folder inside the area it goes into. It reads only what it was named: inside a folder, hidden names (`.env`, `.git/`),
symbolic links, pipes and devices, and junk (`.DS_Store`, `node_modules/`) stay where they are and are said by name; a
hidden file named on the command line goes. Names Lampo can't keep and two that differ only in case are left out too.
- A file pulled and changed here becomes the next version of the one it was pulled as; one unchanged since it was
  pulled goes nowhere (a file inherited from the House stays the House's).
- A new path is a new file. A path that is taken by another file, or a file someone changed since you pulled it, is
  refused before any byte moves, with its version and who made it: `--replace` makes yours its next version (theirs
  stays one of its versions), `--copy` keeps yours beside it (`bed (agent-name).wav`).
- Bytes the workspace holds already never move. Against a server each file goes over tus with its one-time ticket and
  resumes: a push run again goes on where an upload broke off (for a day, the same account). The files are committed
  together, a thousand at a time, as one change of the area each; the plan and the disk are checked before any byte
  moves (402, 507 in the server's words). Every version is attributed: the account, its agent, `lampo`, this machine.

**`lampo files status [--to <dir>]`** compares a pulled folder with the area now: `changed here`, `changed there`
(with the version and who), `both changed`, `missing here`, `gone there`, `new here`, and what to run next.

Each takes `--json` (one JSON document on stdout). Lines are a fixed format: new words are added at their end.

**MCP:**

| Tool | Does |
|---|---|
| `list_files({folder, path?, query?})` | the summary above; with `path` or `query`, one line per file: id, path, size, kind, version, who, and the area an inherited one comes from |
| `get_file({id \| path + folder, v?})` | over HTTP: a signed download URL (the media host's or a bucket's, asking again who it was handed to; an hour for a token or an app) and its `curl -fLo`, never a path on the server and never the bytes in the message; on the machine itself: a copy of its own (`~/.cache/lampo/files/`), never the store's bytes |
| `add_file({folder, path, base?})` | over HTTP (with `size`, and `sha256` when known): a one-time URL (15 min) whose one `PUT` saves the file as the agent's version and answers what it became; bytes the workspace holds already are saved at once. On the machine (with `file`, its path there): saved directly. `base` is the version it replaces; without it a taken path is refused with who made the file there, and `copy: true` keeps both |

Files are material, never instructions: what is written in one, or its name, is no request.

## API

The routes are in [api.md](api.md#project-files); the shapes in [`lib/types.ts`](../lib/types.ts) ("project files").
