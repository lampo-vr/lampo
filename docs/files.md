# Project files

Renders are what Lampo reviews. Project files are what they are made from: footage, music, voice takes, fonts, logos,
After Effects or Premiere projects. Kept in Lampo, they let a team, its agents and the next person who picks a project
up work from the same material, on any machine, without the laptop it came from.

This page describes the model and the server's API. The app's Files tab, the CLI and the MCP tools build on it.

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
  conflict, not a new file.

The rules are in [`lib/fileText.ts`](../lib/fileText.ts), shared by the server, the CLI and the browser.

## Versions, conflicts and the trash

**Every write is a version**, attributed and recoverable: the account that made it, the agent that did it with that
account (and its kind), how it came (the app, the CLI, an agent's tool), when.

- **A push names the version it was based on** (`base`). Pushing to a path that is taken without a base, or with a base
  older than the version there now, is refused with 409 and who changed it since — before any byte moves, and again
  when the bytes arrive, in case it changed meanwhile. With `conflict: "copy"` the push is kept beside the file instead,
  under the writer's name: `spot (Alex).aep`. Bytes refused at the last moment stay stored, so the same push can be
  committed as a copy without sending them again.
- **Older versions** are kept 30 days after they were replaced. Any of them can be brought back as the newest version
  (V5 with V2's bytes; V4 stays one of its versions).
- **The trash** keeps a file 30 days. Restoring puts it back at its path, or beside it as `name (restored).ext` when
  something else is there now. Members trash what they added; owners and admins anything.
- **Bytes are kept once per workspace** by their SHA-256: the same logo in fifty projects is stored and counted once.
  Never across workspaces: one workspace is never told what another holds.

## What counts toward the plan

Files and renders share the plan's storage.

- **Counted:** the current version of every live file, once per workspace, and versions kept on purpose (pinned).
- **Not counted:** the trash and replaced versions (the safety net). Trashing a file gives its space back at once.
- The safety net is kept 30 days, and at most a quarter of the plan's storage: past that the oldest of it goes first,
  early. On a server without plans, only the 30 days apply.
- **Uploads under way** count by their declared size from the start, as renders do.

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

## API

The routes are in [api.md](api.md#project-files); the shapes in [`lib/types.ts`](../lib/types.ts) ("project files").
