# Moving to a server

You have reviewed on your own machine for a while and now run Lampo on a server (your own, see
[go-live.md](go-live.md), or one someone runs for your team). `lampo export` packs your store's reviews into one file, a
**bundle**; `lampo admin import` on the server unpacks it into a workspace there. Notes keep their frames, drawings,
replies and statuses, approvals and finals keep their history, every version keeps its bytes, and Insights picks up where your
machine left off.

The move is a snapshot. Export, import, and from then on review on the server: notes made on your machine afterwards
don't follow (an export later brings videos that are new since, never more notes on a video the server has).

## What moves, what stays

| Moves | Stays on your machine |
|---|---|
| every video (removed ones kept for their notes too), each version's bytes as they arrived | the onboarding sample |
| notes: frames, ranges, drawings, tags, severities, kinds, choices and options, screenshots, voice clips | drafts and recordings not sent yet |
| replies, statuses, fixes, checks, answers | review links and what they counted (opens, watching, downloads); the notes and decisions made through them come along, by name |
| decisions: every approval, request for changes, final and reopen | the Claude Code sessions' ids and folders (the assigned agent's name comes along) |
| references and fix previews, with their files | devices, push, your account, passwords, API tokens and keys |
| folders, empty ones too; playbooks with their skills' files | publishing: connections and posts; which projects are archived (they arrive in use: archive them again on the server) |
| the history (`events.jsonl`) and the team's watching, for the inbox and Insights | questions asked on a folder before any video (`asks.json`) |
| taste (written again on the server from the notes) | everything in `cache/`: the server makes its own posters, waveforms, proxies, analysis and transcripts |

**No path of your machine travels.** A video you tracked from a file, `/Users/you/work/acme/export/spot.mp4` (id
`__Users__you__work__acme__export__spot.mp4`), arrives as an upload in its folder: `/@uploads/Acme/Reels/spot.mp4`, id
`__@uploads__Acme__Reels__spot.mp4`, and that id replaces the old one everywhere it was named (the history, moments of
it other notes point at, playbooks). Two files of the same name in one folder become `spot.mp4` and `~2/spot.mp4`. A
path inside text (an agent's reply naming the file it rendered) becomes the file's name.

**People travel by name; you give them accounts.** Your machine's account, and every name you wrote under (the app's,
`lampo`'s), becomes the account you name with `--owner`, by its id: the server treats those notes as yours. Other people's
names go to accounts with `--people "Mia Lang=mia@example.com,…"`: each address must already be a member of the
workspace (invite them first; the import makes no accounts and refuses an address that isn't one). Agents keep their
names (`agent:…`), visitors of review links theirs (`guest:…`), and anyone else keeps a name and no account.

**History is history.** The imported events go into a file of their own (`events.imported.jsonl`, beside the
workspace's `events.jsonl`), each marked as imported: no agent hears them as new feedback (`lampo watch`,
`wait_for_feedback`, INBOX.md, `lampo inbox`), no webhook fires, no push goes out, no mail is sent, and however long the
history is, it never crowds out what happens on the server. Insights, the Inbox and each video's history read them as
what happened.

## 1. Export, on your machine

```sh
lampo export ~/lampo-move.tar
lampo export ~/acme.tar --folder "Acme" --folder "Globex/Spring"   # only these folders
```

It reads your store and writes nothing into it; it says what it packed, what stays, and what was gone already (a
version whose bytes you deleted comes along without them: its notes stay readable, it can't play). The bundle is about
as large as your `versions/` folder; check the disk first. A bundle holds your notes and renders: copy it only to
places you would keep them.

## 2. Copy it to the server

Somewhere the app can read it. With the [Docker setup](docker.md) the store is the `vr-data` volume at `/data`:

```sh
scp ~/lampo-move.tar you@server:/tmp/
ssh you@server
docker compose exec app mkdir -p /data/import
docker compose cp /tmp/lampo-move.tar app:/data/import/lampo-move.tar
```

(A store on a bind-mounted folder takes it directly: `rsync` it into that folder.)

## 3. Your account and the workspace

Make your account first (the setup link, or `lampo admin create-user`), then find the workspace it goes into:

```sh
docker compose exec app lampo admin workspaces
```

## 4. A dry run

```sh
docker compose exec app lampo admin import /data/import/lampo-move.tar \
  --workspace w1 --owner you@example.com --dry-run
```

It reads and checks the whole bundle and says what would happen to every video, folder, playbook and name, how much
it writes and whether the disk has room (`LAMPO_MIN_FREE` stays free). Nothing is written.

## 5. A backup, then the import

Back up first (what [go-live.md](go-live.md) sets up), then the same command without `--dry-run`. The server keeps
running and people can keep working; the videos appear once all their files are in place. It makes each video's poster, waveform
and loudness as normal background jobs before it ends (`--no-derive` leaves them to the server, which makes them when
someone opens the video); proxies are made when a player first opens a version.

## 6. Check

Open the library. Running the import again is safe and shows where things stand: every video "this workspace has it
already". Then delete the bundle from the server.

## What the import checks

A bundle is a file from outside, and is read as one. It is read twice: the first read checks all of it before anything
is written, the second places what was checked.

- **The archive**: plain files only, plain relative names (no `..`, nothing absolute, no link, folder or device), each
  name once, every header's checksum, nothing after its end.
- **The manifest**: every file listed with its size and sha256, and the archive holds exactly those; each kind of file
  within its limit (a version within `LAMPO_UPLOAD_MAX`).
- **Every record**, against a strict schema: a field the format doesn't have refuses the bundle. A video must be an
  upload (`/@uploads/…`), each file must be one its review names, each event about a video the bundle holds. No time
  in it may lie after the bundle was made, nor after the server's clock (10 minutes of drift aside): if one does,
  check the clock of the machine it came from.
- **Every version's bytes** match its hash (the one the store keeps for every render), and ffprobe reads them as a
  video within the server's limits, like an upload; its size, frames, frame rate and picture size are what ffprobe
  reads on the server, not what the bundle says. Pictures and sounds start like what their names say.
- **What the app checks when it makes something** holds for what comes in: a link reference is http or https (its
  user name and password dropped), a playbook is for the House or a folder name the server takes, within the limits a
  playbook has here.

Nothing is ever written over. A video id the workspace holds already is skipped and said; a note id it has already
gets a new one (its screenshots and history follow). A playbook comes in with ids of the server (its own, its skills'
and its suggestions'), so its files land in a place of their own, after the videos are in; a playbook for a folder that
has one already is skipped and said. An import that stops halfway takes back what it placed, and a video's history goes in
only with the video; one that was killed is carried on by the next run of the same bundle — a video it had put in
without its history yet gets that history then — and nothing is imported twice (what a killed run of another bundle left is taken back by the next import). One import runs in a workspace at a
time, and it never writes into a video id an upload is filling at that moment: it stops before writing anything, and
the next run goes on.

On a server whose renders live in Bunny or S3, versions, references, fix previews and skill files go into the bucket
through the same storage adapter as uploads.
