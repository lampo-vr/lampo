# Going live on one server

A runbook for the first production deploy of a hosted Lampo: one Linux server with Docker, the app and
[Caddy](https://caddyserver.com) in front of it from `docker-compose.yml`, renders on the server's disk. It assumes a
fresh Ubuntu 24.04 box (a Hetzner Cloud or dedicated server works as is) and a domain you control. Each step ends with
a check; `scripts/smoke.ts` runs the read-only ones for you from your laptop. Background for every setting:
[server-mode.md](server-mode.md), [docker.md](docker.md), [configuration.md](configuration.md).

What you end up with:

```
browser, vr, MCP clients
   │  https
   ▼
Caddy :443 (Let's Encrypt, HTTP/2 and HTTP/3)
   │  http, on the compose network only
   ▼
app :4747 ── volume vr-data
             /data/data      reviews, accounts, profile pictures, keys
             /data/versions  every render (can't be rebuilt)
             /data/cache     posters and playback copies (rebuilt on demand)
```

## 0. Decide first

| | |
|---|---|
| Domain | e.g. `review.example.com`. Review links and invites carry it, so pick the one you keep |
| A CDN in front | optional. A CDN proxy (Cloudflare's, for example) may not carry video: give video a host of its own, `VR_MEDIA_ORIGIN` ([below](#behind-a-cdn-proxy)) |
| Server | 2+ cores, 4 GB RAM with voice notes (`VR_STT=local`), 2 GB without; disk for every render you keep, plus 20 % |
| Renders | on the server's disk (`VR_STORAGE=local`, the default) for the first deploy; Bunny or S3 later ([server-mode.md → Storage](server-mode.md#storage)) |
| Backups | where they go (another machine: a Hetzner Storage Box, any S3 bucket) and who gets the restore key |
| Email | an SMTP relay (Brevo or any other) and a sender on a domain you control, for invites and password resets ([email.md](email.md)) |
| Voice notes | `VR_STT=local` downloads a 740 MB speech model from Hugging Face at the first start; `VR_STT=off` for none |
| Source offer | `VR_SOURCE_URL`: where people who use the instance get its source (AGPL-3.0 §13). The default, the project's repository, is right for an unmodified copy; a changed one points it at its own source |
| Who runs it | the accounts that see the operator's pages (every workspace and account; suspending or deleting a workspace): `LAMPO_OPERATOR`, else the owner the setup makes ([server-mode.md](server-mode.md#the-operators-pages)) |
| Legal pages | for an instance open to the public: your imprint, privacy policy and terms (`VR_IMPRINT_URL`, `VR_PRIVACY_URL`, `VR_TERMS_URL`), linked on the sign-in screens and review links. Open sign-up (`VR_SIGNUP=open`) doesn't start without the last two ([configuration.md](configuration.md#legal-pages)) |
| Monitoring | an uptime check from outside (step 9) and who it alerts |
| Your laptop | a checkout of the same commit and Node ≥ 22.18, which runs `scripts/smoke.ts` as it is |

## 1. The server

- A non-root user with your SSH key, password login off, updates on (`unattended-upgrades`).
- Docker Engine and the compose plugin from Docker's own apt repository (docs.docker.com → Install → Ubuntu).
- A firewall that lets in only `22/tcp` (better: your address only), `80/tcp`, `443/tcp` and `443/udp` (HTTP/3).
  On Hetzner Cloud a Cloud Firewall in front of the server does it without touching the box. The app's port 4747 is
  never published: compose only `expose`s it to Caddy.

Check: `docker run --rm hello-world` prints its greeting; from your laptop, `nc -vz <server> 4747` is refused.

## 2. DNS

Point an `A` record (and `AAAA` if the server has IPv6) for the domain at the server, with a short TTL (300) for the
first days so a mistake can be undone quickly. Caddy asks Let's Encrypt for the certificate as soon as the name
resolves to it; until then it retries.

Check: `dig +short review.example.com` (and `AAAA`) answers the server's addresses.

### Behind a CDN proxy

With the app host behind a CDN proxy, the steps change in a few places; the background is
[server-mode.md → A host of its own for video](server-mode.md#a-host-of-its-own-for-video).

- **Two names.** The app host (`review.example.com`) is proxied by the CDN; the media host (`media.example.com`) is
  DNS only, straight to the server, so the proxy never carries video. Set `VR_MEDIA_ORIGIN=https://media.example.com`.
- **TLS twice.** Browsers see the CDN's certificate for the app host; between the CDN and the server, use the CDN's
  strictest mode (Cloudflare: *Full (strict)*) with a certificate the CDN trusts for that name (Cloudflare's Origin
  CA). The media host gets its own certificate from Let's Encrypt, as a host without a CDN would.
- **The visitor's address.** Requests to the app host come from the CDN's addresses. The proxy on the server takes the
  visitor's address from the CDN's header (Cloudflare: `CF-Connecting-IP`) only for requests from the CDN's published
  ranges, and refuses the app host to anyone else; `VR_TRUST_PROXY` names the proxy on the server, as before. Without
  this every visitor would look like a handful of CDN addresses, and sign-in limits would lock everyone out.
- **Caching.** Let the CDN cache `/assets/` (hashed names, a year) and bypass its cache for everything else: the app
  marks what may be kept, and pictures and screenshots are private (a CDN caches `.png` and `.jpg` by extension).
- **Rewriting.** Turn off whatever rewrites pages or injects scripts (Rocket Loader, email obfuscation, automatic HTTPS
  rewrites, analytics beacons, bot-detection scripts): the page's one inline script is pinned by the CSP's hash. The
  page, the live stream and every answer that carries a secret say `Cache-Control: no-transform`.
- **Limits.** A CDN takes a request of about 100 MB: uploads from the browser and `vr push` go in pieces of 48 and
  64 MiB, and one-time upload URLs point at the media host, so renders of any size arrive. An upload's body (a piece,
  or a whole render in one PUT on a slow line) may take up to 6 hours; any other request's body must arrive within
  5 minutes, and every request's headers within a minute. The live
  stream sends a ping every 25 seconds, inside a CDN's idle timeout (Cloudflare: 125 s between reads).

## 3. The code and the image

```sh
sudo mkdir -p /opt/lampo && sudo chown "$USER" /opt/lampo
git clone https://github.com/lampo-vr/lampo.git /opt/lampo && cd /opt/lampo
git checkout <the commit or tag you deploy>   # never a moving branch in production
docker compose build app   # node:24-slim with ffmpeg, tesseract, hunspell, the speech engine
# a tag of this build, to roll back to (step 11):
docker tag video-review:local video-review:$(git rev-parse --short HEAD)
```

The image builds for the server's own architecture (x86 on most Hetzner boxes; arm64 on CAX). Note its size
(`docker images video-review`), to compare later builds with.

## 4. The env file

```sh
cp .env.example .env && chmod 600 .env
```

Set at least:

```sh
VR_DOMAIN=review.example.com
VR_PUBLIC_URL=https://review.example.com   # scheme and host only, no path
VR_TRUST_PROXY=uniquelocal                 # Caddy reaches the app over the compose network
#VR_SOURCE_URL=https://…                   # a changed copy: where its source is
#VR_ORG_NAME=Northwind Studio              # shown to clients next to who shared a link
#VR_STT=off                                # no voice notes (and no 740 MB model download)
#VR_PUSH_SUBJECT=mailto:you@example.com    # the contact push services see
#LAMPO_OPERATOR=you@example.com            # who runs it; unset: the owner the setup makes
#VR_IMPRINT_URL=https://example.com/imprint   # your legal pages, linked where people sign in
#VR_PRIVACY_URL=https://example.com/privacy
# email; without these, messages wait in the outbox:
VR_SMTP_URL=smtp://…%40smtp-brevo.com:…@smtp-relay.brevo.com:587   # STARTTLS
VR_MAIL_FROM=Lampo <hello@review.example.com>
```

Email ([email.md](email.md)): with `VR_SMTP_URL` and `VR_MAIL_FROM` the server sends invites, password resets,
confirmations of a new address and account notices; without them it writes every message to `/data/cache/outbox/` and
says so at start. Use port 587 (`smtp://`, upgraded with STARTTLS): Hetzner Cloud blocks outgoing ports 25 and 465 by
default. `VR_MAIL_FROM` needs a sender on a domain you authenticated: before opening the doors, add the
domain's SPF, DKIM and DMARC records in Brevo, then run `docker compose exec app vr admin mail-test you@example.com`.
It sends one message now and prints the relay's answer.

The server refuses to start, with one plain line saying why, on what would be unsafe or can't work: a URL with a path,
plain http on another host (`http://` is only for this machine, or a closed test network with `VR_ALLOW_HTTP=1`), an
https URL without `VR_TRUST_PROXY`, incomplete storage settings, a CDN without signed links, a mail relay without a
sender, an open sign-up without your terms and privacy policy, a store it can't write, a damaged key ([the full
list](server-mode.md#configuration)). There are no secrets to
generate: the cookie and link keys are made in the volume at the first start (`data/secret.key`,
`data/share-secret.key`, readable only by the app's user).

Never put the `.env` in git or a ticket; it is all the configuration there is besides the volume.

## 5. The volume

`docker compose up` creates the named volume `<folder>_vr-data` (`lampo_vr-data` for `/opt/lampo`), owned by the
container's user (uid 1000). Find it with `docker volume inspect lampo_vr-data` (`Mountpoint`, usually
`/var/lib/docker/volumes/lampo_vr-data/_data`).

If you mount a host folder instead (`./data:/data`, or a Hetzner Volume), give it to that user first:
`sudo chown -R 1000:1000 /mnt/lampo`. Otherwise the app stops at start with
`video-review: can't write to /data/data (EACCES)…`.

## 6. First start and the owner

```sh
docker compose up -d
docker compose ps                    # app: healthy after ~30 s; caddy: running
docker compose logs app              # the one-time setup token
```

The log prints the token and says `ready: data writable, disk above 2.0 GB free, ffmpeg found, storage (local)
reachable`. Open `https://review.example.com/?setup=<token>` (the field comes filled in), and give your name, email
and a password of at least 10 characters: that is the owner account. The token works once; while no account exists,
every restart prints a new one. Or, on the server:
`docker compose exec app vr admin create-user --role owner --email you@… --name "…"`.

Then bring people in: **Settings → Users** for the team (one-time invite links, emailed when the server has a relay,
or copied and sent yourself), review links from the player for clients, and **Settings → API tokens** or
`vr login https://review.example.com` for agents. Reviews you made on your own machine come over with `vr export` and
`vr admin import` ([moving.md](moving.md)).

## 7. Smoke test

From your laptop, in a checkout of the same commit:

```sh
node scripts/smoke.ts https://review.example.com
# before DNS points at the new server:
node scripts/smoke.ts https://review.example.com --connect <server ip>
# with a media host (VR_MEDIA_ORIGIN): it is checked too
node scripts/smoke.ts https://review.example.com --media https://media.example.com
```

It never signs in or writes. Every line should be `✓`: alive, ready, the security headers (CSP, `X-Frame-Options`,
`nosniff`, `Referrer-Policy`, HSTS), `noindex` and `/robots.txt`, nothing loaded from other hosts, the build's cache
headers and compression, the API closed to strangers (and no cookie for them), an owner, its public URL and hosted
mode, OAuth discovery for `/mcp`, http → https, the certificate's days left. `!` lines are warnings (no source
offered, no owner yet, a certificate with less than three weeks left). Exit code 1 when a check fails.
`--insecure` accepts a test certificate (a staging server), and `--json` prints the checks for a monitor.

Then five minutes by hand, in a private window:

1. Sign in; upload a short render (drop it on the library); it plays, and ← / → step one frame.
2. Pin a note on a frame; make a review link (Share → Create link) and open it in another private window: the client
   sees the video and can leave a note; it arrives in your inbox.
3. On your laptop: `vr login https://review.example.com`, `vr ls`, `vr logout`.
4. Settings → Notifications → turn on notifications for this device, send the test (phones: install the app first,
   [mobile.md](mobile.md)).
5. In ChatGPT or Claude, add the connector `https://review.example.com/mcp`: the consent screen opens, and after
   Allow the app lists your videos.

## 8. Backups

What, and how often:

| | in the volume | back up |
|---|---|---|
| reviews, notes, screenshots, accounts, profile pictures, review links, keys | `/data/data/` | **nightly**, and before every update |
| every uploaded render (with `VR_STORAGE=local`) | `/data/versions/` | **nightly**: it can't be rebuilt |
| the settings | `/opt/lampo/.env`, `docker-compose.yml`, `deploy/Caddyfile` | when they change |
| posters, playback copies, the speech model | `/data/cache/` | never: rebuilt on demand |

Files in `data/` and `versions/` are written by atomic renames, so a copy taken while the app runs is consistent per
file; nothing needs to stop. A backup holds the keys (`secret.key` signs sessions, `share-secret.key` seals review
links): **encrypt it**, and keep it somewhere else than the server. Losing `secret.key` also loses every publishing
connection (their keys and sign-ins are sealed under it: each is added again) and any upload to a platform that hadn't
finished (it starts over).

With [restic](https://restic.net) on the host (`apt install restic`) to a Hetzner Storage Box (SSH on port 23), once,
in a root shell (`sudo -i`) with root's SSH key on the Storage Box:

```sh
export RESTIC_REPOSITORY=sftp://u123456@u123456.your-storagebox.de:23/lampo
export RESTIC_PASSWORD_FILE=/root/.restic-pass
restic init
```

Then a script, `/usr/local/bin/lampo-backup` (`chmod 700`), that backs up and keeps a history:

```sh
#!/bin/sh
export RESTIC_REPOSITORY=sftp://u123456@u123456.your-storagebox.de:23/lampo
export RESTIC_PASSWORD_FILE=/root/.restic-pass
V=/var/lib/docker/volumes/lampo_vr-data/_data
restic backup --quiet "$V/data" "$V/versions" /opt/lampo/.env &&
  restic forget --quiet --prune --keep-daily 14 --keep-weekly 8 --keep-monthly 12
```

and run it at 03:15 every night from `/etc/cron.d/lampo-backup` (cron reads each entry from one line):

```
15 3 * * * root /usr/local/bin/lampo-backup
```

Keep the restic password in two places that aren't the server (a password manager and the person on call). A plain
alternative: `tar czf - -C <mountpoint> data versions | gpg -c > lampo-$(date +%F).tgz.gpg`, copied elsewhere.

With Bunny or S3, the renders and profile pictures are not in the volume: keep a second copy that never deletes
(bucket versioning on S3, `rclone copy` — not `sync` — of a Bunny zone), [docker.md → Backups](docker.md#backups).

### Restore (drilled)

Do this once before you rely on the backups, on another machine or a fresh volume — never over the live one (in a root
shell with the two restic variables from above):

```sh
restic restore latest --target /tmp/restore
R=/tmp/restore/var/lib/docker/volumes/lampo_vr-data/_data
docker volume create lampo-restore
N=/var/lib/docker/volumes/lampo-restore/_data
sudo cp -a "$R/." "$N/"
sudo chown -R 1000:1000 "$N"
docker run --rm -d --name lampo-restore -p 127.0.0.1:4848:4747 -v lampo-restore:/data \
  -e VR_PUBLIC_URL=http://localhost:4848 -e VR_STT=off video-review:local
# from your laptop, through: ssh -L 4848:127.0.0.1:4848 <server>
node scripts/smoke.ts http://localhost:4848
```

From a tar archive instead: `mkdir -p /tmp/restore && gpg -d lampo-….tgz.gpg | tar xzf - -C /tmp/restore`, and copy
from `/tmp/restore` itself (`R=/tmp/restore`).

What a good restore looks like, as it went in the drill for this runbook (a copy of a running instance's `data/` and
`versions/` taken with `tar` while it served, unpacked into a new folder, a second app started on it with an empty
cache and another public URL): `/readyz` ready; no setup token (the owner exists); the owner signs in with the old
password; all four accounts and their roles; an agent's API token from before the backup works; a review link from
before opens; a render answers range requests (it plays); its notes and versions are there; its poster is rebuilt on
the first request. Remove the drill with `docker rm -f lampo-restore && docker volume rm lampo-restore`.

A real restore is the same into the live volume with the app stopped (`docker compose stop app`, copy, `chown`,
`docker compose start app`). Keep the same `VR_PUBLIC_URL`: review links, invites and connected apps carry it.

A backup keeps what people deleted after it was taken (their account, a workspace). Keep the newest
`data/erasures.jsonl` aside before a real restore, put it back before the start, then run
`docker compose exec app vr admin erasures --apply`: what was deleted since goes again
([server-mode.md → Deleting and exporting](server-mode.md#deleting-and-exporting)).

## 9. Monitoring

- **Up and ready, from outside**: an HTTP check of `https://review.example.com/readyz` every minute, alerting on
  anything but `200` for 3 minutes. `/readyz` fails when `data/` isn't writable or its `workspaces.json` can't be
  read, the disk is below `VR_MIN_FREE` (2 GB), ffmpeg is missing or the storage can't be reached; it answers booleans
  only, the log says why. Prefer a monitor in the EU (or a self-hosted Uptime Kuma on another box): it sees nothing
  but that URL.
- **Everything else, daily**: `node scripts/smoke.ts https://review.example.com` from another machine's cron; exit 1
  mails the cron owner. It also warns three weeks before the certificate runs out (Caddy renews about a month before;
  a warning means renewal failed: `docker compose logs caddy`).
- **On the box**: `docker compose ps` shows `healthy`. Docker restarts a container that exits
  (`restart: unless-stopped`) but not one that is merely unhealthy: that is what the outside check is for.

## 10. Logs

`docker compose logs -f app` (and `caddy`). Both rotate at 5 × 10 MB (`logging` in `docker-compose.yml`). The app
logs its start, warnings, failed background jobs and, for any 5xx answer, a reference with the details (the person
sees only "something went wrong (ref …)"); it logs no tokens, no passwords and no email addresses, and no requests
except one line per `/mcp` tool call that never holds what was asked or answered ([mcp.md](mcp.md#what-the-server-logs);
`VR_MCP_LOG=off` turns it off). Caddy
keeps no access log unless you add one — leave it that way unless you need it (it would hold visitors' addresses).

What to look for after a deploy: `ready:` at start; `not ready (…)` lines; `warning: a request came with forwarding
headers from …` (the proxy isn't the one `VR_TRUST_PROXY` names, or port 4747 is reachable from outside).

## 11. Updates and rollback

```sh
cd /opt/lampo
sudo /usr/local/bin/lampo-backup                  # the nightly backup, now (step 8)
git fetch && git checkout <new commit or tag>
docker compose build app
docker tag video-review:local video-review:$(git rev-parse --short HEAD)
docker compose up -d app                          # Caddy keeps running
docker compose logs --tail 20 app                 # ready: …
node scripts/smoke.ts https://review.example.com  # from your laptop
```

On `up -d` the old container gets SIGTERM: it stops taking connections, ends live streams (browsers and `vr watch`
reconnect by themselves), and waits up to 30 s for uploads being registered and the running job
(`stop_grace_period: 45s`). Uploads in flight pause and resume on their own (they retry for about four minutes).
Queued background jobs run again in the new container.

Rollback: `git checkout <previous>`, `docker tag video-review:<previous> video-review:local`,
`docker compose up -d app`. The store format only grows (new fields are optional), so the previous version reads it;
if the release notes of the version you leave mention a migration of the store, restore the backup from before the
update instead. Moving a hosted store to workspaces is such a migration: a version from before workspaces can't open
it without losing them ([server-mode.md → Workspaces](server-mode.md#workspaces)).

## 12. When the disk fills

At `VR_MIN_FREE` (2 GB left by default) `/readyz` turns red and new uploads are refused up front with "not enough disk
space on the server for this upload"; everything else keeps working. Then:

1. Where it went: `df -h`, `docker system df`, `sudo du -sh /var/lib/docker/volumes/lampo_vr-data/_data/*`.
2. Safe to delete at any time: old images (`docker image prune` — keep the tags you may roll back to), build cache
   (`docker builder prune`), and the app's playback and working copies:
   `docker compose exec app sh -c 'rm -rf /data/cache/scrub /data/cache/proxies /data/cache/work'` (rebuilt on
   demand). Leave the rest of `/data/cache`: `models` is the speech model (downloaded again otherwise), and `uploads`
   the uploads in flight (unfinished ones are cleaned after a day).
3. Never delete anything in `versions/` or `data/` by hand: remove videos in the app (Delete in the video's menu),
   which removes their renders.
4. For good: a bigger disk or a Hetzner Volume (stop the app, copy the volume's contents with `cp -a`, mount it at
   `/data`, `chown -R 1000:1000`), or renders in Bunny/S3 ([server-mode.md → Storage](server-mode.md#storage)).

## 13. When something else goes wrong

| | |
|---|---|
| Someone forgot their password | *Forgot password?* on the sign-in screen (a link for 60 minutes, once a relay is set), or `docker compose exec app vr admin reset-password --email them@…` (asks for the new one; signs their sessions out) |
| An email doesn't arrive | `docker compose logs --no-log-prefix app \| grep '^mail:'` (recipients appear only as a hash; `vr admin mail-test <address>` tries one now), then the spam folder and the domain's SPF/DKIM/DMARC ([email.md](email.md)) |
| Locked out of sign-in ("too many attempts") | waits 15 minutes; a browser that signed in before isn't blocked by guesses from elsewhere. If everyone is locked out at once, `VR_TRUST_PROXY` doesn't name the proxy (see the log) |
| The app doesn't start | `docker compose logs app`: every refusal is one line starting with `video-review:` that says what to change |
| `/readyz` red | `docker compose logs app \| grep 'not ready'` names the check and why |
| No certificate | DNS doesn't point here yet, or ports 80/443 are closed: `docker compose logs caddy` |
| `folders: … folders.json is damaged` / `can't be read` | the library shows only the folders videos are in (review link lists and stages as before), folders can't be changed and folder review links ask visitors to come back: `docker compose exec app vr admin repair-folders` (add `--workspace <id>` for another workspace) says what it would rebuild, `--write` writes it (the review links' ids it can recover kept, the damaged file beside it; a link it names as not given back is yours to decide: `--take-back <link id>` if its folder is the one of that name now); a permission problem: give the file back to uid 1000 |
| A key file damaged | the start says which and what deleting it costs; restore it from the backup first |
| `workspaces.json is missing` / `can't be read` | the store moved to workspaces and lost its list of members; restore `data/workspaces.json` from the backup (the app never rebuilds it from the accounts, and `vr admin workspaces migrate` refuses while `data/w/` holds a workspace folder — from inside the container or not). A running server says so once in the log and answers every signed-in request with 503 meanwhile; it serves again as soon as the file can be read, without a restart |

## Known gaps

- How fast the speech model transcribes on an x86 server without a GPU hasn't been measured yet: note it on the first
  deploy.
- Bunny and S3 are tested against mocks only; the first real credentials deserve a careful look: a render uploaded,
  played through the CDN with a signed link, and an unsigned link refused.
