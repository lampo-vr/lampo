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
- An endpoint with an error format of its own (OAuth) passes on only its own refusals; anything else is a server
  fault said by audience (`publicMessage`, `server_error`), never `e.message`, and a catch rethrows what it didn't expect.
- Object-store and speech failures are `internal()`; their status is someone else's (`statusOf`).
- Event screenshot paths are for `via === 'local'` only: everyone else gets URLs (`ctx.eventFor(via)`).
- A path that goes to the log goes through `loggedPath`: review-link tokens and tickets live in paths.
- Maps keyed by what visitors send are `Recent` / `RateLimit`, listed with `keptInMemory`; never a bare `Map`.
- Per-address limits key by `addressKey` (IPv6 by its /64); guest write limits count only writes that landed.
- A link's videos that a guest request asks about more than once (a set link's) are looked up once in `link()` and held
  by that request's link object (`holdSet`), never kept across requests: a video removed or archived drops out on the next.
- A one-time URL's guard (`t.check`) runs before the bytes and again once they are in, before any work: a PUT's body
  may take as long as an upload (6 h), and a check made only at its start let a file land on a video archived meanwhile.
- A limit on costly work (a new frame) is taken before the work starts and given back if it fails (`RateLimit.reserve`,
  `countedGrab`): checked first and counted once it landed, every request of a burst in flight together passes.
- What is given back is only work that never started (the on-demand gate full): a run that started and made nothing
  (a broken file) stays counted and is remembered (`madeUnder`, `.none` marks in lib/fileMedia.ts), and work that
  costs several frames takes them all up front (`countedGrab(…, cost)`). Given back on any failure, a broken clip ran
  ffmpeg 8 times past a budget of 5.
- ffmpeg runs through `run` / `spawnMedia` (timeout, stderr tail), `incoming: true` for outside files; never `spawn`.
- ffmpeg someone waits for outside the job queue (a frame, a screenshot, a reference) passes `onDemand: true`; a
  whole-video decode streams into a fixed window of frames, never holds them all; analysis heights go through `analysisRows`.
- `run()` fails past its `maxBuffer` (`OutputTooLargeError`), never answers with the output cut: a run whose stdout is
  its answer bounds it (`-t`, `-frames:v`), and a long input is read in windows (`decodePcm`'s `from`/`seconds`).
- A remote store's working copy is used inside work that holds it (`heavy()`, `holdingWorkFiles`, every request through
  `holdingForResponse`): fetched outside any work, the next download's prune may take it before it is opened (and
  `AsyncResource.bind` hides a scope set outside).
- A background job gets a crash-guard key (`heavy(…, { key })`, lib/crashGuard.ts): one that kills the process isn't run on every start.
- A `select` over a list of frame numbers goes through `selectFrames` (lib/probe.ts): FFmpeg 5.1.9 / 7.1.4 / 8.0.2 and
  later refuse an expression over 100 deep, and `eq(n,a)+eq(n,b)+…` is one level per frame.
- An Auto-check finding that names an edit ("between shots") checks for one against the frames around it
  (`blackBetweenShots`, `cutLike`), and "black" is near zero and flat (`BLACK`, lib/findings.ts): 98 % of the picture
  below a tenth of full luma read a dark night sky as black gaps. A change to what it finds bumps `QA_VERSION`; kinds
  and keys (`black:<first frame>`) stay, so dismissals keep holding.
- Outbound requests (webhooks, OAuth metadata) go through `lib/netguard.ts`; publishing's through `lib/publish/net.ts` on top of it.
- An unsafe hosted setting is a refusal in `startupProblems`: one line, never a stack trace.
- Hosted jobs: `needJobRoom` before a start, `unlessBusy` for warm-ups, `mustRun` for owed work.
- Never broadcast `review` per request: every open player refetches on it.
- Owed work a person waits for (a recording being heard) is taken up again at start from what is on disk
  (`resumeRecordings`): queued jobs die with the process, and a SIGTERM's drain waits only for the running one.
