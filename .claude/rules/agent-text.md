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
  through `redact()` before it is cut: cut first, a secret loses the part its pattern knows it by.
- Text whose lines are ours leaves through `keepLines` (MCP `text()`, `lampo` output): only `\n` ends a line.
- Clean agent names where they come in (`cleanAgentName`) and stored ones on read (`shownName`, `shownEvent`).
- What a caller posts under an agent's name carries the caller's account (`ownedAgentName`).
- Agent formats keep their tokens (`lampo` lines, INBOX.md, `CHANGE WORDS`, `PICKED`): append, never reword.
- New texts say `lampo` and `LAMPO_*`, never `vr` or `VR_*` (those are only the aliases' own code and their docs);
  a setting is read through `lib/env.ts` (`setting`, `settings`), never `process.env.LAMPO_X ?? process.env.VR_X`.
- A new MCP tool, field or line must fit `token-budget.test.ts`; raise a budget only with a `bench/tokens/` run.
- MCP schemas go through `trimmed()`, inputs for the few are `.meta({ hidden })`; a new tool gets its `TOOL_ACCESS`.
- Starting an agent: an argument list, no permission flag (`FORBIDDEN_FLAGS`), from the machine only.
- Stopping what Lampo started (a run, a render's tool) goes to its process group as long as the group has a member,
  never only while its leader runs (`stopGroup`, lib/processGroup.ts); an app that exits waits for it (`stopAll`).
- An answer that hands work to the person ends with `lib/handoff.ts`'s line (wait now, cursor from that moment).
