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
- The onboarding sample logs no events; Insights, taste, suggestions and `usageOf` skip it.
