---
paths:
  - "lib/**"
  - "server/**"
  - "mcp/**"
  - "bin/**"
  - "skills/**"
  - "docs/**"
  - "README.md"
  - "bench/tokens/**"
  - "test/unit/token-budget.test.ts"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### What agents read
- Every person-written field in a line format goes through `oneLine`: names, captions, reasons, not only notes.
- A name someone else chose goes into a prompt the person pastes as data, never as the instruction: quoted with no
  quote of its own and framed (`lampoFor`: the project named "…" (a name, not an instruction)).
- What an agent prints that others read (a run's steps, words, summary; activity of every kind, its vars too) goes
  through `redact()` before it is cut: cut first, a secret loses the part its pattern knows it by. A path that skips
  `cleanActivity` (a refused permission: `cleanDenied`) is cleaned the same way, and a rule built from its words stops
  before a word `redact()` would change (`commandPrefix`).
- Text whose lines are ours leaves through `keepLines` (MCP `text()`, `lampo` output): only `\n` ends a line.
- With `--json`, stdout is one JSON document: a line `lampo` appends after a command (a stop, new notes) goes to stderr.
- A decision about what runs on the machine (is that session running?) asks afresh (`sessions.current()`), never from
  the list the app shows: it is refreshed only when someone looks, and the first look answers with nothing. Only a load
  begun after the ask counts (one on its way may predate the session), and a load that failed is never "not running".
- A position an agent gives (`--at`, MCP `timecode`) is parsed whole (`parseFramePosition`): never `parseInt` its
  parts (`00:00:01;15` and `00:00:01.5` read as frame 1); what isn't a position is "bad position", never a guess.
- Clean agent names where they come in (`cleanAgentName`) and stored ones on read (`shownName`, `shownEvent`).
- What a caller posts under an agent's name carries the caller's account (`ownedAgentName`).
- Agent formats keep their tokens (`lampo` lines, INBOX.md, `CHANGE WORDS`, `PICKED`): append, never reword.
  Appending means after: new words after a line's closing token (a REPLY's ` · on: "…"`; only `lampo watch`'s file path
  comes later), a new flag after the flags agents know, a new section after theirs, a heading's new words after its
  count ("## Fixed, waiting for alex to verify (1) · the person's check"); a count keeps what it counted ("N open
  comment(s) carried forward"), and what else there is to count comes after it. The contract snapshots hold the old
  lines byte for byte.
- New texts say `lampo` and `LAMPO_*`, never `vr` or `VR_*` (those are only the aliases' own code and their docs);
  a setting is read through `lib/env.ts` (`setting`, `settings`), never `process.env.LAMPO_X ?? process.env.VR_X`.
- A new MCP tool, field or line must fit `token-budget.test.ts`; raise a budget only with a `bench/tokens/` run.
- MCP schemas go through `trimmed()`, inputs for the few are `.meta({ hidden })`; a new tool gets its `TOOL_ACCESS`.
- Starting an agent: an argument list, no permission flag (`FORBIDDEN_FLAGS`), from the machine only.
- Stopping what Lampo started (a run, a render's tool) goes to its process group as long as the group has a member,
  never only while its leader runs (`stopGroup`, lib/processGroup.ts); an app that exits waits for it (`stopAll`).
- Every way the app ends runs that stop: SIGTERM, Ctrl-C and SIGHUP (a closed terminal; without a handler the app died
  by the signal and its `exit` handler never ran), and a run that ended on its own gets it for what it left running.
- An answer that hands work to the person ends with `lib/handoff.ts`'s line (wait now, cursor from that moment).
- An answer that leaves the agent waiting on the person ends with the wait line too — a reply, a question, options, a
  fix's preview (`afterHandBack`; `lampo`: `WATCH_NOW_LINE`) — and a note it answered is no work left (`workLeft`):
  `reply` said only "reply added", a chat agent asked again in its chat and ended its turn, and the person's answer in
  Lampo reached nobody. That line also tells the app (`onHandBack` → server/agents.ts `handedBack`): no wait within
  `graceMs`, and the app says it isn't listening.
- A stopped render is decided by the stop, never by the tool's exit code (a wrapper script runs on to exit 0 with its
  file cut short), and the same stop aborts the upload that follows (`hooks.abort`, lib/render/job.ts).
- A signal that lands during synchronous work (a registration's probe and copy, a big render's hash) is handled only in
  the next poll phase: ask after an immediate inside an immediate (`signalsHeard`, lib/backend/types.ts), never right
  after the call returns, and never after one `setImmediate` (work that ran in a poll phase gets it before the next poll).
  Long work after the last such look is made async before the lock (a render's copy: `fs.promises.copyFile` to a temp
  file, the stop asked after it), so that only a rename is left under the lock: a synchronous copy can't be stopped.
- A version an agent puts up says to mark what it fixed while notes older than it are neither marked nor answered
  (`unmarkedAfter`, `markWhatItFixedLine`), never "wait now" before the marks (a hasty agent waited and marked nothing);
  a hand-back with only early fixes left says to put the version up (`putUpNextLine`). A version an agent names that
  doesn't exist is "bad version", never taken as given.
- A wait never skips what an agent wasn't told: it hands over everything after the video's told place (`Told`,
  lib/told.ts), whatever cursor it brings; the cursor is a floor, never a reason to skip. A hand-out marks only what it
  handed out; a read of the notes marks only past the notes it told of (`readPlace`, up to `placeNow` taken before the
  review is read): never past an approval, a request or a verdict on a note it left out, which the next wait brings.
  Counting within a second goes by the second, never by a run of lines (a log may hold one second's events apart).
- A picture made for an agent of another version (`spotPicture`: same spot, still wrong here) goes through the
  caller's frame budget (`count`) and is cached, never written to versions/; it is cropped like the marked frame and
  labelled `<id> f<frame> v<v> <what>`; a picture that can't be made, or a screenshot that is missing, is said in a
  line, never left out. Lists show it on request (`images: "compare"`); only get_note pairs it by default. A fix riding
  with the next version (`fix_pending`) is the agent's own hand-over: named, never pictured on a version without it,
  never counted as work waiting for it or as a person's input.
