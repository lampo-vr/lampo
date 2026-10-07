# Docker

The Docker image runs Lampo as a hosted server: everyone signs in, renders arrive as uploads, and everything needed to
analyse them offline is inside (ffmpeg, the text checks, the speech engine). One volume holds the whole store. How a
hosted server works: [server-mode.md](server-mode.md).

## Quick start (one machine, no domain)

1. Build the image and start it:

   ```sh
   docker build -t lampo .
   docker run -d --name lampo \
     -p 4747:4747 \
     -v vr-data:/data \
     -e LAMPO_PUBLIC_URL=http://localhost:4747 \
     lampo
   ```

2. Read the one-time setup token from the log:

   ```sh
   docker logs lampo
   ```

3. Open http://localhost:4747/?setup, paste the token, and create the owner account.

Plain http is for this machine only: a `LAMPO_PUBLIC_URL` like `http://192.168.1.20:4747` is refused at start, because
passwords would cross the network unencrypted. For other people, put the app behind TLS
([below](#production-compose-and-caddy-https)); on a closed test network, `-e LAMPO_ALLOW_HTTP=1` says that is on
purpose.

## Production: compose and Caddy (HTTPS)

`docker-compose.yml` runs the app with [Caddy](https://caddyserver.com) in front of it. Caddy gets a Let's Encrypt
certificate by itself and speaks HTTP/2 and HTTP/3 to browsers. The whole first deploy, step by step with a check
after each, is [go-live.md](go-live.md).

<!-- picture: compose-setup — the two containers: Caddy in front (ports 80 and 443, automatic HTTPS) passing requests to the app on 4747, and the one vr-data volume behind the app -->

1. Point your domain's DNS at the server.
2. Copy the settings template and fill it in:

   ```sh
   cp .env.example .env
   ```

   Set `LAMPO_DOMAIN` (the domain Caddy gets a certificate for) and `LAMPO_PUBLIC_URL` (the address people open).
   Without a domain (`LAMPO_DOMAIN`, or `VR_DOMAIN` in an `.env` from before) Caddy doesn't start, and
   `docker compose logs caddy` says so.
   `LAMPO_TRUST_PROXY=uniquelocal` is already set: Caddy reaches the app over the compose network, and an https address
   needs it. Every other setting in the file is optional and explained there; the full list is in
   [configuration.md](configuration.md).
3. Start it, and read the setup token:

   ```sh
   docker compose up -d
   docker compose logs app
   ```

4. Open `https://<your domain>/?setup`, paste the token, and create the owner account.

The Caddyfile stays three lines: the app compresses its own answers and sends the right caching headers
([server-mode.md → Speed](server-mode.md#speed-over-a-real-network)).

To connect agents from any machine, create an API token in Settings → API tokens, then run
`lampo login https://<your domain> --token -`, paste the token when asked, and run `lampo watch`
([more](server-mode.md#agents-against-a-hosted-server)).

`lampo` also works inside the container, on the store itself. What it writes is signed `agent:vr` unless you pass
`--by "Your Name"` (or set `LAMPO_BY`):

```sh
# an invite link to send someone
docker compose exec app lampo admin invite --role member
# one email through the mail relay, sent now (docs/email.md)
docker compose exec app lampo admin mail-test you@example.com
docker compose exec app lampo admin list-users
docker compose exec app lampo ls
```

`lampo admin` also has `create-user`, `reset-password`, `invites`, `revoke-invite`, `workspaces`
([server-mode.md → Workspaces](server-mode.md#workspaces)), `import` (reviews from your own machine,
[moving.md](moving.md)), `delete-account`, `delete-workspace`, `export-account` and `erasures`
([server-mode.md → Deleting and exporting](server-mode.md#deleting-and-exporting)), and `repair-folders`, which
rebuilds a damaged `folders.json` ([go-live.md](go-live.md#13-when-something-else-goes-wrong)).

## The /data volume

The image sets `LAMPO_HOME=/data`, so one volume holds everything:

| Path | What | Back up? |
|---|---|---|
| `/data/data/` | reviews, notes, screenshots, accounts, profile pictures, review links | **yes** |
| `/data/versions/` | the bytes of every uploaded render (with local storage) | **yes**, it can't be rebuilt |
| `/data/cache/` | posters, waveforms, analysis, playback copies, the speech and footage models, each workspace's footage index, uploads in progress | no, it is rebuilt on demand |
| `/data/config.json` | an optional settings file (variables override it) | yes |
| `/data/tmp/` | temporary files (Auto-check's frames, pictures and clips being checked) | no |

With Bunny or S3 storage the renders and profile pictures live there instead, and the cache also holds working copies
of the renders, up to `LAMPO_WORK_CACHE` (20 GB).

### Backups

A backup lives somewhere else than what it backs up, and it keeps what was deleted. There are two parts.

**1. The volume's `data/` and, with local storage, `versions/`.** They are plain files written by atomic renames, so a
copy taken while the app runs is consistent file by file. Back them up every night to another machine, for example
with [restic](https://restic.net) to a Hetzner Storage Box or any S3 bucket. Compose names the volume after the
project folder, such as `lampo_vr-data`:

```sh
# as root, whose SSH key the Storage Box has (it speaks SSH on port 23); once:
#   ssh-keyscan -p 23 u123.your-storagebox.de >> /root/.ssh/known_hosts
#   docker run --rm -v /root/.ssh:/root/.ssh:ro -e RESTIC_PASSWORD restic/restic \
#     -r sftp://u123@u123.your-storagebox.de:23/lampo init
docker run --rm \
  -v lampo_vr-data:/data:ro \
  -v /root/.ssh:/root/.ssh:ro \
  -e RESTIC_PASSWORD \
  restic/restic -r sftp://u123@u123.your-storagebox.de:23/lampo \
  backup /data/data /data/versions /data/config.json
# keep a history: the same docker run, ending in
#   forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

A backup keeps what people deleted (their account, a workspace) until its history drops it. After restoring one, put
the newest `data/erasures.jsonl` back and run `lampo admin erasures --apply`: what was deleted since goes again
([server-mode.md → Deleting and exporting](server-mode.md#deleting-and-exporting)).

restic skips a path that doesn't exist yet (no config.json). A one-off archive works too: stop the app
(`docker compose stop app`), archive `data` and `versions` from the volume, and start it again.

**2. Renders in Bunny or S3.** Replication (the copies a provider keeps in other regions) is not a backup: when a video
without notes is deleted, the app deletes its renders from the bucket, and the copies follow. Keep a second copy that
never deletes:

- on S3, turn on bucket versioning, with a lifecycle rule that removes old versions after, say, 90 days;
- on Bunny, copy the zone to a second zone or bucket on a schedule, with a copy that doesn't delete (`rclone copy`,
  not `rclone sync`).

**Try a restore once, before you rely on it.** Restore `data/` (and `versions/`) into a fresh volume, start the app
with the same storage settings, and open a few videos and a review link. Missing posters, playback copies and
checksums rebuild by themselves; the cache never needs restoring.

## Running it

- **One app container per store.** The job queue, live updates, connected agents, sign-in limits and uploads in
  progress live in the app's memory, and reviews are locked per file on one disk. Two containers on one volume would
  run jobs twice and split live updates: give one container more cores and memory instead.
- **Health checks.** `/healthz` answers while the process runs. `/readyz` says whether it can work, and the image's
  health check uses it:
  - data is writable;
  - more than `LAMPO_MIN_FREE` (2 GB) is free for data, the cache and local renders;
  - ffmpeg is found and answers within 5 seconds (a hung ffmpeg fails the check instead of hanging it);
  - the storage accepts its credentials (checked at most every 30 seconds);
  - `LAMPO_PUBLIC_URL` is set.

  It answers one true or false per check, with status 503 when one fails; the reason goes to the log, which also
  lists the checks at start. Uploads that would eat into `LAMPO_MIN_FREE` are refused before they start.
- **Stopping** (`docker compose stop`, a deploy). The app takes no new connections and ends live streams (browsers
  and `lampo watch` reconnect by themselves). It then waits up to 30 seconds for uploads being registered and the job
  that is running, which is why `stop_grace_period` is 45 seconds in `docker-compose.yml`. Queued jobs run again after
  the restart.
- **Logs.** `docker compose logs app` (and `caddy`). Both rotate at 5 × 10 MB in `docker-compose.yml`; Docker keeps
  them forever otherwise. The app logs no tokens, passwords or email addresses, and no requests except one line per
  `/mcp` tool call that never holds what was asked or answered ([mcp.md](mcp.md#what-the-server-logs);
  `LAMPO_MCP_LOG=off` turns it off).

## Upgrades

```sh
git pull
docker compose build app
docker compose up -d app
```

New versions read existing stores unchanged. The cache may be rebuilt after an upgrade; that costs time, not data.
In production, check out a fixed commit or release tag rather than following the main branch, and keep the previous
image to roll back to ([go-live.md → Updates and rollback](go-live.md#11-updates-and-rollback)).

## Resources

- **Memory**: the whole container measured 1.2 GB with the speech model loaded and idle. The model unloads after 30
  idle minutes, and ffmpeg jobs run one at a time on top of that. 4 GB leaves room for both; with `LAMPO_STT=off` a
  smaller box works. `docker-compose.yml` caps the container at 6 GB.
- **CPU**: two cores or more. Measured on four arm64 cores: a voice note takes about 0.5 seconds with Parakeet, and an
  Auto-check of a 6-second 1080×1920 reel took 6.6 seconds (tesseract reads a frame every half second, so it grows
  with the length). On a shared box, give the container a `cpus` limit.
- **Disk**: each version of a render is stored once. Playback copies for fast seeking take at most 8 GB of the cache.

## The image

- Built on node:24-slim (Debian 12), for linux/amd64 and linux/arm64 from the same Dockerfile. It runs as the
  unprivileged node user, with tini as the first process.
- Contains ffmpeg, tesseract (German and English), hunspell (de_DE, en_US) and the speech engine's native build for
  the image's architecture.
- Listens on port 4747 and sets these variables:

  ```sh
  LAMPO_MODE=server
  LAMPO_HOME=/data
  LAMPO_PORT=4747
  LAMPO_STT_PREFETCH=1
  LAMPO_USER=admin
  TMPDIR=/data/tmp
  NODE_ENV=production
  ```

- Its health check asks `/readyz` every 30 seconds: ready, not just alive ([Running it](#running-it)).
- The speech model (Parakeet v3, 740 MB, as there is no GPU in the container) downloads in the background at the
  first start. `LAMPO_STT_PREFETCH=0` waits for the first voice note instead; `LAMPO_STT=off` turns voice notes off.
- Footage search is off until a workspace's owner or admin turns it on ([footage.md](footage.md)); its model (SigLIP,
  213 MB) downloads into `/data/cache/models/` then, once. The image carries ONNX Runtime's binary for its own platform
  only (about 45 MB on x86-64), not the CUDA providers. Indexing costs about 30–40 CPU-minutes per hour of 1080p
  footage, one job at a time after the review work; `LAMPO_FOOTAGE=off` turns it off for the whole server.
- Only what runs ships: the built web app, the server, the CLI and MCP code, the production dependencies, the license
  and the third-party notices. No tests, docs, benchmarks, `.env` files or data, and nothing `.gitignore` keeps
  private (local working files such as `*.local.md` notes, `cloud/`) even reaches the build context (see `.dockerignore`).
- `docker images lampo` shows its size on your platform.
- CI builds it (linux/amd64) on every push to main and every pull request, and checks that a container started from it
  answers `/healthz` (`.github/workflows/ci.yml`).
- Its OCI labels say where its source is (`org.opencontainers.image.source` and `.url`: the `SOURCE_URL` build
  argument, the project's repository by default), its licence (`AGPL-3.0-only`) and the commit it was built from
  (`.revision`: the `REVISION` build argument; CI passes it). Build with the commit:
  `docker build --build-arg REVISION=$(git rev-parse HEAD) -t lampo .`. A changed copy run for others builds
  with `--build-arg SOURCE_URL=<its repository>` and sets `LAMPO_SOURCE_URL` to the same, so the app offers that source
  too.

`docker-compose.yml` hardens the app container further:

- it drops every Linux capability and sets `no-new-privileges`;
- the root file system is read-only: the app writes to `/data` only, and a 64 MB `/tmp` stays for tools that ignore
  `TMPDIR`;
- processes and threads are capped at 512, memory at 6 GB.

Uploaded media is only read through a short list of formats, every ffmpeg run has a time limit, and renders whose
headers claim absurd sizes or lengths are refused before any work starts
([configuration.md → Uploads and disk](configuration.md#uploads-and-disk)).
