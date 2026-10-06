# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub instead: the
repository's **Security** tab → **Report a vulnerability**. Only the maintainers see the report. If you can't use
GitHub, write to **security@lampo.video**.

<!-- Maintainers, before publishing: enable "Private vulnerability reporting" in the repository settings (the link
above depends on it). -->


Please include:
- what an attacker can do, and in which mode (local, LAN, review link, server mode);
- the version or commit, and your configuration (storage adapter, reverse proxy);
- steps to reproduce, or a proof of concept.

We'll acknowledge the report within a few days, keep you updated while we work on a fix, and credit you in the
release notes unless you'd rather not be named. Please give us a reasonable time to ship a fix before you disclose
the problem publicly.

## Supported versions

Lampo has no stable release yet. Security fixes go into the `main` branch and the next release. Once there are
releases, the latest minor version will receive security fixes.

## Scope

In scope:

- **Server mode:** authentication, sessions and API tokens, access control between users, roles and workspaces,
  sign-up and the emailed links, uploads, the storage adapters and signed URLs, and anything that lets a client read
  or write the server's disk.
- **Local mode:** anything that lets another machine, a website open in your browser (CSRF, DNS rebinding), or a
  review link reach more than it should. That includes reaching through `npm run lan` or the Cloudflare tunnel.
- **Review links:** anything that lets a link reach another video, internal notes, or the rest of the API.
- **The agent interfaces:** anything that makes `vr` or the MCP server write outside the store or run commands.
- **Media handling:** anything that makes ffmpeg or ffprobe read or fetch something other than the file it was given.

Out of scope:

- attacks that need an already-compromised machine or account with owner rights;
- other accounts on a machine that runs the local app. The app signs in whoever connects from the machine itself as
  you. On Linux it tells accounts apart (a request from another account on localhost is nobody); on macOS and Windows
  it can't, so any program any account on the machine runs can use it as you: read and write reviews, and start your
  Claude Code sessions with words of its own. Run the local app only on a machine no one else signs in to, or use a
  hosted server (with accounts) there. A new store is readable by you alone, and the app warns at start when the
  store's folder can be opened by other accounts;
- denial of service through very large but legitimate renders (limit them with `upload_max_bytes` and your reverse
  proxy);
- missing hardening headers without a demonstrated impact;
- vulnerabilities in ffmpeg itself (please report those [upstream](https://ffmpeg.org/security.html)), unless
  Lampo exposes them in a way it shouldn't.

The security model is described in [docs/server-mode.md](docs/server-mode.md#security-model) and
[docs/architecture.md](docs/architecture.md#security-boundaries).

## Hardening a hosted instance

- Set `VR_PUBLIC_URL` (the server refuses to start without it) to the https URL people open, and put TLS in a
  reverse proxy (Caddy in `docker-compose.yml`).
- Name the proxy in `VR_TRUST_PROXY` (`loopback`, `uniquelocal`, or its address/subnet; an https `VR_PUBLIC_URL`
  requires it), and don't publish the app's port past the proxy: forwarding headers from anyone else are ignored.
- Keep `VR_WEBHOOK_ALLOW_PRIVATE` off unless a webhook really has to reach your own network.
- Run the container as shipped: unprivileged `node` user; compose drops all capabilities, sets `no-new-privileges`,
  runs the root file system read-only (temp files on the volume) and caps processes and memory. On a shared machine,
  add a `cpus` limit.
- Keep the media limits (`VR_MAX_SIDE`, `VR_MAX_DURATION`, `VR_MEDIA_TIMEOUT`) no higher than your renders need.
- Give API tokens for CI and servers an expiry (`vr login --expires 90d`, or `days` when creating one) and revoke
  the ones Settings shows as unused; sessions end after 14 idle days (`VR_SESSION_IDLE_DAYS`).
- Encrypt backups of `data/`: `secret.key` and `share-secret.key` in it unseal the invite and review-link tokens
  (without them, `invites.json` and `shares.json` open nothing).
- Back up `data/` (accounts, links, reviews, profile pictures, `secret.key`) off the machine, and with local storage
  `versions/` too; see [docs/docker.md](docs/docker.md#backups).
