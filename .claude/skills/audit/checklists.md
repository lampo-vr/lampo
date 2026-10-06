# Checklists per area

These are starting points, not limits. Each list names the code and what has gone wrong there before or is most
likely to. The paths of each area are in `AUDITS.md`.

## routing

- Canonical paths only (`router()` in `server/http.ts`, `canonicalPaths`). A new route uses them, and
  `test/unit/route-walk.test.ts` walks it in every spelling: upper case, trailing slash, `//`, dot segments.
- The guard denies by default (`isPublicPath`). Is every new public path meant to be public? Every write route must be
  in the role table (`server/permissions.ts`), and every MCP tool in `TOOL_ACCESS` (`mcp/access.ts`).
- CSRF: cookie writes need same-origin or `Sec-Fetch-Site`. Check beacons and `keepalive` requests (text/plain bodies
  skip the preflight).
- Errors: 5xx details hidden; 404 vs 403 used the same way for "not yours".
- Headers on every answer, in both modes: CSP, `frame-ancestors`, `nosniff`, `noindex`. `Vary: Cookie` on session
  answers when hosted.
- Rate limits: keyed by what an attacker can't rotate cheaply, bounded in memory, and no way to lock out the real user.

## auth

- Account takeover paths:
  - reset/verify links: single use, voided by a newer link, bound to their account;
  - an email change, invite acceptance, an existing address joining a workspace;
  - session fixation;
  - sessions surviving a password reset, a disable or a removal.
- Enumeration: answers and timing of sign-up, forgot, resend and invite peek.
- Held (unverified) accounts reach only `HELD_MAY`: walk every route as one.
- API tokens never mint tokens or do person-only things (`person()`: sign-off, playbook writes, drafts).
- OAuth:
  - exact `redirect_uri`, PKCE S256 only, codes single use, refresh rotation with reuse detection;
  - scopes ∩ role, grants bound to their workspace;
  - consent is CSRF-safe, the CIMD fetch goes through `netguard`.
- Mail:
  - header and line-break injection through names, workspace and org names;
  - HTML escaping in `lib/mail/layout.ts` and `templates.ts`;
  - links built from `VR_PUBLIC_URL`, never from Host.
- Secrets compared in constant time; tokens never in logs (`loggedPath`) or Referer.

## workspaces

- Every module-level `Map`, `Set`, cache or memo keyed by a slug, hash or token goes through `wsKey`, or is truly
  global.
- Work that runs later (jobs, timers, promise continuations, listeners) is `boundToWorkspace`.
- Paths go through `dataDir()` / `cacheDir()` / `versionsDir()`, never `DATA` / `CACHE`. Storage keys go through
  `storage()` with its `w/<id>/` prefix; `rootStorage()` only for global things.
- Permissions come from `roleIn` / `req.auth.role`, never `user.role`.
- Two workspaces with the same slug and the same bytes: are derived files (posters, sprites, transcripts, cuts, scrub
  copies) separate? Check SSE after a switch, review-link tokens resolving to their own workspace, tokens and OAuth
  grants after a membership is removed or a role changes, push subscriptions, webhooks, Insights, search, the inbox,
  `/api/people`.
- Extend `test/unit/workspace-isolation.test.ts` for anything new that stores, caches or tells.

## links

- A visitor reaches only what the link covers (`covers`), at the versions it allows (`linkMoment`). They see notes
  per `visibleNotes`, and never team drafts, agent refs (`guestRef`) or disk paths (opaque `guestId`).
- Password, expiry and revocation are checked on every sub-route, on SSE and on media URLs.
- Writes: size limits, rate limits, the verdict names its version (`v`).
- The `progress` beacon can't inflate stats or grow storage without bound.
- `test/unit/guest-privacy.test.ts` covers every new guest route.

## people

- Drafts and recordings are the author's only. They never reach review.json, review links, agents or tokens
  (`via === 'token'` → 403). Their files are served only to the author, and SSE goes to the author's streams only.
- Team views, Insights and the audience: who sees whom; reviewers see colleagues' data.
- Avatars and `/api/people`: enumeration across workspaces.
- Push and webhook payloads: what they carry and to whom.
- The onboarding sample: suppressed everywhere it should be (events, Insights, billing).

## agents

- Everything people or clients write reaches agents through `oneLine` in every line format: `eventLine`,
  `shortEventLine`, INBOX.md, review.md, `vr prompt`, `vr open`, MCP `noteLines`, the stage detail, `partLine`,
  `textEditLine`, choices, playbook markdown, transcripts, recording drafts, references, and names of videos,
  folders, workspaces and accounts.
- Starting agents (`lib/agentRun.ts`, `server/agentRuns.ts`, `server/wake.ts`):
  - machine only and `via === 'local'`;
  - an argument list (values starting with `-`?) and `FORBIDDEN_FLAGS`;
  - cwd and env scrubbing; logs not served over HTTP.
- The monitor: what command or tool text reaches whom (secrets on command lines, paths for reviewers), spoofed
  activity, bounded files.
- MCP:
  - hidden params still checked;
  - `/mcp` auth on every request and per workspace;
  - `wait_for_feedback` and `subscriptions/listen` resource use;
  - upload tickets;
  - refs pointing at local files or private URLs;
  - postMessage origins in the MCP App.
- `vr`: token file permissions, downloads resolved inside the cache (`inCache`), server-controlled names written to
  disk.
- Playbooks: agents only propose (`person()` on writes). Can a reviewer or client get text into `agentMarkdown`?

## media

- Every ffmpeg, ffprobe and other child process goes through `run` / `spawnMedia`: `-protocol_whitelist file,pipe`,
  `incoming: true` and `restrictFormats` for outside files, a timeout, no shell.
- Filter graphs or concat lists built from user values. Image and playlist formats that pull in other files.
- Paths: slugs, ids and file names from requests (`..`, encoded, absolute, NUL, backslash); symlinks in served
  folders; hard links (`sendDrafts`).
- Uploads: tus and tickets, size versus Content-Length, the disk reserve, `ingestPart` checks, content type and
  `attachment` for user files.
- Storage adapters: keys from user input, the workspace prefix, delete by prefix (`removeSample`), Range.
- One request that costs a lot: zip bombs, huge JSON, unbounded arrays in zod schemas, ReDoS in parsers (`timecodesIn`,
  hashtags, choices, markdown, search).

## network

- Every outbound request goes through `lib/netguard.ts`. Test IPv6, IPv4-mapped, decimal and octal hosts, DNS
  rebinding between check and connect, and redirects.
- Who can set each target: webhooks, link refs, the CIMD fetch, the speech server URL, the SMTP host, push endpoints.

## store

- The data contract: new fields in `lib/types.ts` are optional; existing stores load unchanged; agent-parsed formats
  are unchanged.
- Times compared with `compareTime`; derived files keyed by `renderKey(ver)`; ownership by account id (`isOwner`).
- Locks and atomic writes on every write path; `versions/` is never rewritten.

## web

- Rendering people's text: `dangerouslySetInnerHTML` / `innerHTML`, the playbook Markdown renderer, `TimecodeText`,
  links built from data (`javascript:` URLs), SVG, i18n `<T>` tags with values.
- Client-side storage: the IndexedDB cache per account and workspace, cleared on sign-out; localStorage; what the
  service worker caches.
- Navigation: open redirects, `target=_blank` with `noopener`, postMessage listeners, clickjacking.
- The rules in `AGENTS.md`: strings through `t()`, the vocabulary, tokens only, no Radix in the first paint, the bundle
  budget.

## deploy

- Start-up refuses unsafe settings (`startupProblems`); new env vars are documented in `docs/configuration.md` and
  `.env.example`.
- Docker: non-root, read-only, no secrets baked in. Compose: what is exposed. CI: permissions and secrets.
- `npm audit`; scripts that reach private paths.

## docs

- Claims against code: env vars, routes (`docs/api.md`), MCP tools (`docs/mcp.md`, `skills/lampo/SKILL.md`), `vr`
  commands, data format, the security model, and the README's pictures and claims.
- Oversharing: personal or client names, real paths, hostnames, internal session or process names, private files,
  business internals, and unfixed weaknesses described in detail.
- The vocabulary, the product name and the licence wording are the same everywhere.

## tests

- The guards stay and cover the new code: route walk, workspace isolation, guest privacy, the permission table,
  token budgets, frame exactness against ffmpeg, data contract compatibility.
- Brittle tests (pixel positions, copy, class names, timing) and duplicates across levels.
- Missing tests for security-relevant changes since the last audit.
