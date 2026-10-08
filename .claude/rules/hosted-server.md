---
paths:
  - "lib/**"
  - "server/**"
  - "mcp/**"
  - "deploy/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### Hosted server
- A failure becomes a 4xx through `failFrom(status, e)`, never `fail(status, e.message)`.
- Object-store and speech failures are `internal()`; their status is someone else's (`statusOf`).
- Event screenshot paths are for `via === 'local'` only: everyone else gets URLs (`ctx.eventFor(via)`).
- A path that goes to the log goes through `loggedPath`: review-link tokens and tickets live in paths.
- Maps keyed by what visitors send are `Recent` / `RateLimit`, listed with `keptInMemory`; never a bare `Map`.
- Per-address limits key by `addressKey` (IPv6 by its /64); guest write limits count only writes that landed.
- ffmpeg runs through `run` / `spawnMedia` (timeout, stderr tail), `incoming: true` for outside files; never `spawn`.
- ffmpeg someone waits for outside the job queue (a frame, a screenshot, a reference) passes `onDemand: true`; a
  whole-video decode streams into a fixed window of frames, never holds them all; analysis heights go through `analysisRows`.
- A background job gets a crash-guard key (`heavy(…, { key })`, lib/crashGuard.ts): one that kills the process isn't run on every start.
- A `select` over a list of frame numbers goes through `selectFrames` (lib/probe.ts): FFmpeg 5.1.9 / 7.1.4 / 8.0.2 and
  later refuse an expression over 100 deep, and `eq(n,a)+eq(n,b)+…` is one level per frame.
- Outbound requests (webhooks, OAuth metadata) go through `lib/netguard.ts`; publishing's through `lib/publish/net.ts` on top of it.
- An unsafe hosted setting is a refusal in `startupProblems`: one line, never a stack trace.
- Hosted jobs: `needJobRoom` before a start, `unlessBusy` for warm-ups, `mustRun` for owed work.
- Never broadcast `review` per request: every open player refetches on it.
