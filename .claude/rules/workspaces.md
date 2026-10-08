---
paths:
  - "lib/**"
  - "server/**"
  - "mcp/**"
  - "scripts/**"
  - "test/unit/workspace-isolation.test.ts"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### Workspaces
- Every in-memory map keyed by a slug, a render's hash or a token goes through `wsKey`.
- Use `dataDir()`, `cacheDir()`, `versionsDir()`, `eventsFile()`, `storage()`, never `DATA` / `CACHE` / `EVENTS_FILE`.
- `rootStorage()` only for what no workspace owns (avatars); nothing at start or on `/readyz` reads `dataDir()`.
- Work queued now and run later is wrapped in `boundToWorkspace(fn)`; never fall back to workspace #1.
- Never read `user.role` for a permission (workspace #1's mirror): `req.auth.role`, `roleIn(ws, user)`.
- A new per-workspace thing joins `ids.ownedSets` and `ids.ownedSetsA` in `workspace-isolation.test.ts`; run it.
