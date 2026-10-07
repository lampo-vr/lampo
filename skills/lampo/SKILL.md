---
name: lampo
description: Work through frame-exact video feedback from Lampo — read the reviewer's notes (with marked frames), fix the render, re-render, mark notes fixed, ask questions on a frame, and wait for new feedback. Use when a video you render is under review in Lampo, when the user mentions Lampo, review notes, "vr", or feedback on a render.
---

# Working with Lampo

People pin notes (with drawings) to exact frames of your renders. You fix, re-render and report back — through the
MCP tools (the `lampo` server; `video-review` in older setups) or the `vr` CLI (`vr help`; `--json` on every read but
`vr prompt`), whichever this session has.

## The loop

1. **Before rendering**, read the playbook (the team's brief, rules, skills):
   `get_playbook({video})` / `vr playbook <video>` (`get_skill` / `vr playbook skill <name> <video>` loads a skill)
   — and the taste file (what the notes taught): `get_taste({video})` / `vr taste <video>`. Follow both. Never edit
   a playbook: suggest a change with `propose_playbook_change` / `vr playbook propose`; a person decides.
2. **Read the open notes**: `get_open_notes({video})` / `vr open <video>` — work first (must → should → nice), then
   ideas (optional), then your questions still waiting (no work). A note with a drawing comes with its marked frame,
   cropped to it; `get_note({id})` / `vr show <id>` shows one note in full (replies, the whole frame, a range's
   frames, references). Frames are 0-based, timecodes `mm:ss:ff`, drawings in video pixels. Fix a `range` note's
   whole stretch.
3. **Fix and re-render** through `vr render --to <video> --out <file> -- <your command>`, so the person sees the
   progress; it puts the file up as the next version (past ~8 min: `--detach`, then `vr render wait <id>`). Without a
   shell: `request_upload({filename, video})` and its `curl`. `vr diff` / `vr qa` check it.
4. **Mark each note fixed with what you changed and where**: `mark_fixed({id, note: "caption moved to y 1392"})` /
   `vr fix <id> --note "…"`. On a `CLIENT` note the client reads it as written: no paths or team remarks.
5. **Wait, don't poll**: `wait_for_feedback({video, since})` blocks until something new arrives and returns only
   that plus a cursor for the next call; `No new feedback` after `timeout_s` (default 50 s): call again (`vr watch
   --brief` prints the same lines). You hear notes only while you wait: offer it on connecting, then keep waiting
   until told to stop. Never loop on `get_open_notes` or `list_videos`.

## Spend few tokens

- Hand back what an answer gave you, and read only what changed: `since` = the `as of` of your last
  `get_open_notes`, `known` = the revisions `get_playbook` printed or the stamp of `get_taste`.
- Pictures come for drawn notes only; `images: "all"`, `get_note` and `get_frame` show more.
- `set_status` only for a long step: people see your work as it happens.

## Notes that say more

- **`CHANGE WORDS "every morning" → "every evening" at …`**: change them where they are made (script, TTS input,
  subtitles), re-render, check with `get_transcript` / `vr transcript` (a word the engine misheard is not a request;
  `→ ""` cuts them).
- **`PART RENDER OK: frames 96–188 (shot 4), handles 12`** (only then): render that stretch plus 12 frames either side
  and `vr push <file> --to <video> --part-at 96` (MCP: `part_of` and `part_at` on `track_video`; `video` and
  `part_at` on `request_upload`). If its seam jumps, add the next shot or render in full. A part is never final.
- **References** (`ref …` lines, pictures in `get_note`): match their look or timing; ask when one disagrees with the
  note. Yours: `attach_reference` / `vr ref`. `OVERALL` = about the whole video, not frame 0.
- **Working in a project** (After Effects, Premiere, Resolve): `set_render_source` / `vr source` once, then per note
  export a still (After Effects: `comp.saveFrameToPng`) or a clip ≤ 10 s and
  `attach_preview({id, path, fixed: true, note})` (`path` only where the server runs; otherwise `data`, base64
  ≤ 8 MB) / `vr preview <id> <file> --fixed --note "…"`. Render once per batch: a note whose preview the render
  doesn't match comes back as `CHECK AGAIN`.

## Rules

- **Never mark a note verified** — people do. You mark it fixed.
- **Final means done**: at `stage final` don't fix or re-render; ask first if it must change.
- **Ask in Lampo, never in your own chat** (the person reviews there): `add_note({video, frame, text})` / `vr add <video> --frame N --text "…"`; a box
  or arrow when position matters, `to_timecode` for a stretch, `choices` (2–4) when a few answers are likely.
- **Voices, music, looks to choose before rendering?** `ask_options` / `vr ask` (a video, or its folder before V1);
  the person picks, you get `PICKED voice=v3 music=m1 · note: "…"`.
- **Won't fix on purpose?** `wont_fix({id, reason})`: it stands as a decision in the taste file.
- `show_review({video})` only when the person wants to look with you (hosts with MCP Apps).
