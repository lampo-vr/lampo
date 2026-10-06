# store-v0: a frozen store in the oldest format

A small synthetic store as the code of 2026-09-28 wrote it (commit 2221f6f; the baseline 7834bb6 wrote the same shapes,
less uploads): an upload with two versions, a linked render whose file (a fake path) is gone, notes in every status
without `kind` or `author_id`, a single `approval` instead of `approvals`, a review link keyed by its token in clear,
events.jsonl and INBOX.md as first written. The footage is a 1 s 160×90 testsrc clip kept as bytes: the hashes in
review.json are these bytes', so it is never encoded again. `.gitignore` keeps `versions/`, ignored elsewhere.

**Never regenerate or edit anything here.** A change to the data format adds a new frozen store beside this one
(`store-v1/`, …). `test/unit/contract.test.ts` starts the app on a copy and compares what agents read with
`test/unit/snapshots/contract/`; when such an output changes on purpose, `VR_UPDATE_SNAPSHOTS=1 node --test
test/unit/contract.test.ts` rewrites the goldens, and the diff is reviewed as a change to the contract.
