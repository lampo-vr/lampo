---
name: audit
description: Run a security, privacy and consistency audit of this repository. It reads only what changed since each area was last audited (AUDITS.md) and writes a private report. Use it when asked to audit, do a security review or sweep, check what needs auditing, or verify fixes from an earlier audit.
---

# Audit

The ledger is `AUDITS.md`. It holds the areas with their paths, the audit and commit each area was last read at, the
**Needs audit** queue and the log. Never re-read unchanged code and never report again what an earlier audit
already decided.

## 1. Scope

1. Run `node scripts/audits.ts`. It prints, for each area, the commits and files changed since that area's last audit,
   and then the queue. `node scripts/audits.ts <area>` lists the changed files of one area. It needs Node ≥ 22.18;
   see `.nvmrc`.
2. The audit covers:
   - every queued line;
   - every area that changed;
   - for each change, the code it touches (the caller that now passes new input, the route that now reaches the new
     function).
   A full sweep means all areas, but an unchanged area only gets a quick look for regressions against the last report.
3. Collect what is already known, so you don't report it again: `ROADMAP.md` (the "Deferred …" sections and the open
   decisions), the private reports of earlier audits if this checkout has them (`audits/<date>-<id>/` and older
   `*.local.md` at the root), and "Known gaps" in `docs/go-live.md`. An item that was fixed and is broken again IS a finding
   (a regression).
4. Pin the commit before you start: run `git worktree add --detach .claude/worktrees/audit <commit>` and audit
   there. Line numbers then stay true while others merge.

## 2. Rules

- Do your repros on **throwaway stores** only: `VR_DATA=<tmp>/data VR_CACHE=<tmp>/cache VR_STT=off`, on a free
  port. A `data/` folder next to the app is a live store; never send requests to a running app you didn't start.
- **Hosted mode:** `VR_MODE=server VR_PUBLIC_URL=http://127.0.0.1:<port> VR_ALLOW_HTTP=1`. It is often faster to load
  the app in-process the way `test/unit/*` do (`isolatedEnv` in `test/lib/helpers.ts`).
- Never run the real `claude` CLI; use a stand-in, the way `test/e2e/lib/server.mjs` does. Make no requests to
  outside services: mail stays on the log transport, and webhook/SSRF tests target listeners you start yourself.
- An audit changes no product code. Fixes are separate work, with a test that fails before them.
- Put no client names, real paths or personal data in a report beyond what is needed to point at a leak.

## 3. Method

Split the scope by area. Where subagents are available, give one agent per area (or per two small areas) in
parallel. Give each one the rules above, the known items, its checklist from [checklists.md](checklists.md) and the
report format below. One more agent checks the written invariants across all code (`AGENTS.md` "Invariants" and
"Rules learned the hard way"), because a rule broken in one new file is the most common finding.

Verify every critical and high finding with a repro, and re-check any surprising claim yourself before it goes into
the report. Calibrate: 10 real findings beat 40 maybes.

## 4. Report

Write it to `audits/<YYYY-MM-DD>-A<n>/` (gitignored): `README.local.md` first, with the summary table, the fix order
and the decisions needed; then one file per area and the repro scripts. Then give each finding
this shape:

```
### <AREA>-<n> · <critical|high|medium|low|info> · <short title>
- Category: security | privacy | correctness | inconsistency | docs | oss-hygiene | tests
- Where: path:line (at <commit>)
- Who/when: attacker or precondition, and the mode (machine, hosted, both)
- Evidence: verified (repro + observed output) or by reading (the lines and the reasoning)
- Impact / Fix (name the function) / Test (the one that would have caught it)
```

Severity:
- **critical:** unauthenticated or cross-workspace access or writes, or remote code execution;
- **high:** privilege escalation, an account takeover path, or a serious leak that needs some access;
- **medium:** a real weakness with preconditions, a DoS by one request, or a privacy leak;
- **low:** hardening;
- **info:** an inconsistency worth fixing before publishing.

End the report with "What's solid" and "Not covered".

## 5. Close the loop

- In `AUDITS.md`:
  - add a log row (id `A<n+1>`, date, commit, scope, areas, counts per severity, outcome);
  - set **Last audited** for every area you covered to that id, commit and date;
  - remove the queue lines you covered, and add one for each area you had to leave out.
- Give the findings to whoever fixes them. Each fix commit adds a queue line ("fix for AUTH-3"), so the next audit
  checks the fix.
- Docs and website findings go to whoever owns the public text, as one list they can apply.
- Deferred findings go into `ROADMAP.md` with their id.
- **Verifying fixes.** For each merged fix stream:
  - pin the merge commit and re-run the original repros against it;
  - try to bypass each fix (other call sites, spellings, modes, callers);
  - prove that each fix's test would have caught it:
    - run the fix commit's own test files on the code just before it (`git worktree add --detach <scratch> <fix>^`,
      then `git checkout <fix> -- <its test files>`);
    - they must fail there case by case, not only on loading, and pass at `<fix>`.

    Don't revert the fix on top of the merge: later commits make `git revert` conflict, and a test that fails on
    conflict markers proves nothing.

  Fixes breed findings, so stop on purpose:
  - after one follow-up round, new **low and info** findings go straight to `ROADMAP.md` ("Deferred from A<n>", each
    with an id), and no new stream starts for them;
  - only **medium and above** gets another round before the next audit.

  The queue lines stay until every fix is verified. Then remove them in one commit and record the outcome in the log
  row.
- Once nothing is open, a public summary may follow as `audits/<id>.md`: what was read, the counts, what changed. It
  never includes exploit steps for anything unfixed.
