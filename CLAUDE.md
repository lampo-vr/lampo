@AGENTS.md
@AGENTS.local.md

## Claude Code specifics

- Keep the area files in `.claude/state/` (indexed by `AGENTS.local.md`, when it exists), `CHANGELOG.md` and `ROADMAP.md` current as part of the work, not afterwards. Read an area's file before working in it.
- Long-running servers: start them as background tasks with a throwaway store, and stop them when you're done.
- The rules in `.claude/rules/` load when you open a file their paths match with Read, Edit or Write (not with a
  shell `cat`): open a file with Read before you change it, and the rules for its area come with it.
- Parallel work goes into git worktrees under `.claude/worktrees/` (gitignored); merge back through one branch.
