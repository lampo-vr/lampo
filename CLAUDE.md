@AGENTS.md
@AGENTS.local.md

## Claude Code specifics

- Keep the area files in `.claude/state/` (indexed by `AGENTS.local.md`, when it exists), `CHANGELOG.md` and `ROADMAP.md` current as part of the work, not afterwards. Read an area's file before working in it.
- Long-running servers: start them as background tasks with a throwaway store, and stop them when you're done.
- Parallel work goes into git worktrees under `.claude/worktrees/` (gitignored); merge back through one branch.
