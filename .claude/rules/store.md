---
paths:
  - "lib/**"
  - "server/**"
  - "mcp/**"
  - "bin/**"
  - "scripts/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### Data and the store
- Never mutate what a parsed-once cache returns (`listReviews()`, shares `load()`, OAuth `current()`).
- Derived files are keyed by `renderKey(ver)`, never `ver.hash` alone: two renders can share a hash.
- Compare times with `compareTime`, never as ISO strings or with `localeCompare`.
- Ownership goes by account id (`author_id`, `by_id`, `isOwner`); names only for older records.
- A registry file that can't be read (folders, shares, links, workspaces) is never "empty": refuse writes.
- A review link points at a video or folder id (`Share.video_id` / `folder_id`), never a name.
- Drafts and unsent recordings stay out of review.json and events; only their author reads them, never a token.
- What a person made (avatars, refs, previews) goes through the storage adapter, never `cache/`.
- A deleted video takes its stored copies (`dropStored`): a new kind of copy per render joins `playbackKeys`; one goes
  only when no other video has its render (`renderKept`): the same bytes uploaded twice share a renderKey.
- What a deletion owes the storage goes through `removeOwed` (written down first, crossed out as each key goes,
  finished by `finishRemovals`), never a bare `storage().remove` whose failure is only logged and then forgotten.
- What is written down to remove later is exact keys, never a prefix: a same-name upload's bytes land under the prefix
  before its review exists. A video id's keys go under its upload hold (`reserveUpload`), and anything that puts bytes
  under an id crosses its owed keys out first (`forgetOwed`); `versions/` is never swept by prefix.
- The onboarding sample logs no events; Insights, taste, suggestions and `usageOf` skip it.
- A new field on `Version`, `Comment`, `Reply` or `NoteRef` travels in the bundle's schema or is named in
  `LEFT_OUT` (lib/bundleExport.ts): one an export doesn't know stops `lampo export` (`bundle-portable.test.ts`).
