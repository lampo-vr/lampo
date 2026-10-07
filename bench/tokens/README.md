# Token bench: what talking to Lampo costs an agent

_Measured 2026-10-01 on macOS, Node 24. Before = the code at 18c0d30, after = the token-efficiency change; the same
bench for both._

Every token an agent spends on Lampo is a cost the person pays: the tool list rides along on every turn of the agent's
conversation, every answer stays in its context. This bench measures it on a realistic review, and
`test/unit/token-budget.test.ts` keeps it from growing back.

```sh
node bench/tokens/measure.ts [--json out.json]   # the table below, on a throwaway store
node bench/tokens/dump-tools.ts [name …]         # the tool definitions as a client receives them
```

## How it is measured

`fixture.ts` builds a throwaway store: a 9:16 reel with **12 notes from a reviewer** (boxes and arrows, two ranges, a
link and a frame of another render as references, replies, one note about the whole video, an idea, a change to the
spoken words), an agent's question with choices, a House playbook with a brief and rules, and two skills on the
project. `measure.ts` talks to the real stdio server (`bin/vr-mcp`) with the MCP SDK client, runs the real `vr`, and
uses a stand-in speech engine for the transcript.

Counting (`count.ts`) needs no network and no model's tokenizer: words ⌈letters / 5⌉, digit runs ⌈digits / 3⌉,
punctuation 0.7, other characters 1 — within about 15 % of real tokenizers on prose and paths; it overcounts dense
JSON (the schemas) somewhat, so compare before with after and never quote it as a price. Images: scaled to fit 1568 px
and 1.15 MP, then w·h / 750 (Anthropic's estimate). The tool list counts what a client hands the model: each tool's
name, description and input schema. Ids are random hex, so text counts move by a token or two between runs.

## Before → after

| Item | Before | After | Change |
|---|---:|---:|---:|
| **Tool list, every turn** (23 tools) | 8262 | 4770 | −42 % |
| Tool list, lean set (`VR_MCP_TOOLS=lean`, 14 tools) | — | 2909 | −65 % |
| Server instructions (once) | 260 | 220 | −15 % |
| `get_open_notes`, 12 notes (default) | 8469 (text 4175 + 6 frames 4294) | 2704 (text 1323 + 6 crops 1381) | −68 % |
| `get_open_notes`, `images: "all"` (the old pictures) | — | 5740 (text 1446 + 4294) | −32 % |
| `get_open_notes`, no images | 3957 | 1127 | −72 % |
| `get_open_notes` again: 4 new notes, 1 fixed (`since`) | 9219 | 1677 | −82 % |
| `get_note` (with a reply) | 1168 | 1171 | = (the full view stays) |
| `get_note` (with a frame reference) | 2530 | 2012 | −20 % |
| `get_playbook` | 436 | 436 | = |
| `get_playbook` again (`known` revisions) | 436 | 17 | −96 % |
| `get_skill` | 144 | 144 | = |
| `get_taste` | 1774 | 1298 | −27 % |
| `get_taste` again (`known` stamp) | 1774 | 19 | −99 % |
| `get_transcript` | 83 | 83 | = |
| `wait_for_feedback`, 1 new note | 955 (264 + a 540×960 frame 691) | 430 (168 + a crop 262) | −55 % |
| `wait_for_feedback`, 3 new notes | 2770 | 1098 | −60 % |
| `add_note` · `mark_fixed` · `reply` · `track_video` · `set_status` | 136 · 9 · 10 · 60 · 8 | 138 · 11 · 7 · 61 · 8 | = |
| `list_videos` · `list_folders` | 166 · 22 | 168 · 22 | = |
| `vr open <video>` (agent-parsed, unchanged) | 4647 | 4703 | = |
| `vr open <video> --brief` | — | 1295 | −72 % |
| `vr watch`, one NEW line (agent-parsed, unchanged) | 218 | 221 | = |
| `vr watch --brief`, one line (= `wait_for_feedback`'s) | — | 58 | −74 % |
| `vr prompt` · `vr show` · INBOX.md per note (unchanged) | 4376 · 519 · 319 | 4429 · 524 · 323 | = |
| `skills/video-review/SKILL.md` (now `skills/lampo/`) | 1829 | 1220 | −33 % |

Since then (partial renders, 2026-10-01): `SKILL.md` 1324 (+104, the bullet on `PART RENDER OK`); the tool list
unchanged (the part parameters of `track_video` and `request_upload` are accepted, not announced); a note that allows
a part adds one line of 17 tokens to every format while it is open, others nothing. The MCP name lampo (2026-10-02):
`skills/lampo/SKILL.md` 1323 (−1). Options before a render (2026-10-02): the tool list 5056 (+286, `ask_options`, a tool
of its own and not in the lean set — the lean list stays 2909; `options` on `add_note` would have cost about 200 in
both lists, the lean one included, and `add_note` would have had to take a folder instead of a video), `SKILL.md` 1385
(+62, one bullet; its budget 1350 → 1450). A note without options costs nothing more anywhere; a question with them
adds one `options …` line per group to `get_note` / `vr show` and the PICKED line to its answer. Publishing
(2026-10-03): the tool list 5401 (+345: `draft_post` 272 — its visibility and YouTube category accepted, not
announced — and `get_posts` 73; neither in the lean set, which stays 2909; budget 5250 → 5550). Nothing else grew:
posts show only in their own answers, one line each. Footage search (2026-10-05): the tool list 5726 (+325,
`find_footage`, one tool with `sheet: true` instead of the two `bench/footage/` sketched at 355; its `motion` is
announced as a described string, not a ten-value enum; not in the lean set, which stays 2909; budget 5550 → 5850).
What it buys: a B-roll request costs about 215 tokens of list and 470 of contact sheet instead of 54–68k of an agent
looking through grids (`bench/footage/RESULTS.md`, `agent-cost.ts`). Nothing else grew. Agents wait right after
handing over (2026-10-05): the tool list unchanged (5718; no description changed), `track_video` 61 → 101 (+40, the
line that says to call `wait_for_feedback` now with a cursor from that moment), `mark_fixed` 11 → 18 while other notes
are open (`2 notes still open on this video.`) and about 52 for the last one (the same line); a wait that ends with
nothing new 20 → 53 (+27 on every such wait: the person's notes arrive together on Send, call again now; budget 58),
the stop line after 30 minutes of that 39 once; `request_upload`'s `PUT` answer +68 (`cursor` and `next`); `vr track`,
`push`, `fix`, `wontfix` +26 (`vr watch`). What it buys: an agent that waits right after it hands over hears every note
(nothing comes while it doesn't wait), and one that nobody reviews stops after half an hour instead of calling every
50 s for hours.

Notes that point at elements (2026-10-06): the fixture now has the reel's elements map (7 elements; the 7 drawn notes
point at them) and a part render allowed on the words note. The tool list unchanged (5718: `track_video`'s `elements`
is accepted, not announced). `get_open_notes` 2696 → 2778 (+82, text 1315 → 1397): ` · on #logo` on each drawn note's
line (about 4 tokens each), one `elements: #logo "Acme logo", …` line in the header (about 30), and on the words note
` · part f20–f44` (5) with its `PART RENDER OK` line (17, the fixture's new part, not this change); `since` 1674 → 1692,
`get_note` +11, `vr open` 4618 → 4698, `vr show` +11, INBOX.md per note 318 → 326. A video without a map costs nothing
more anywhere, a note without a part nothing either; `get_open_notes`' structured content (`notes: [{id, elements,
part_ok?}]`) is data for clients, not counted. Budgets unchanged (`get_open_notes` 3000 holds).

Archived projects (2026-10-07): the tool list unchanged (5718, lean 2932: `list_videos` and `list_folders` accept
`archived`, not announced; announced it cost 25 each, 50 in all). A write into an archived project answers one
sentence of about 17 tokens; `list_videos` and `list_folders` asked for archived ones add ` · archived` (2) per
archived video or project; nothing else changed.

Renders through `vr render` (2026-10-07): the tool list unchanged (no MCP tool: an agent without a shell can't render).
A render the agent runs in its shell prints its own output into the agent's context: 2248 tokens for a 6 s ffmpeg
encode at 1080×1920 (its banner, stream maps and stats lines), more for longer renders and chattier tools. The same
command through `vr render --to … --out … -- <command>` prints two lines, 45 tokens: `V2 rendered in 1s and put up for
review (180 frames).` and the hand-off line (with notes open, `Now mark each note fixed.` and `n notes still open`
instead); a failure one line with the tool's last words (≤ 200 characters). One `vr render wait` while a detached
render goes on: 32. `SKILL.md` 1449 → 1490 (+41: step 3 says to render through `vr render`, and how to wait for a long
one; budget 1450 → 1550). New budgets: `vr render`'s two lines 50, a still-rendering wait 36.

The largest tools before: `add_note` 1605, `attach_preview` 657, `attach_reference` 598, `reply` 529,
`propose_playbook_change` 484. After: `add_note` 796, `attach_preview` 431, `propose_playbook_change` 309,
`attach_reference` 296, `set_render_source` 288.

### One loop, and the next round

**One loop** (8 turns): read the playbook and the open notes, look at one note closely, mark three fixed, wait for the
next note, answer it — tool list × 8 + instructions + results.

| | Before | After | After, lean set |
|---|---:|---:|---:|
| Tool list × 8 | 66096 | 38160 | 23272 |
| Instructions | 260 | 220 | 220 |
| Results | 11065 | 4781 | 4781 |
| **Total context** | **77421** | **43161 (−44 %)** | **28273 (−63 %)** |

**The next round** (6 turns, same conversation): woken by new feedback, what changed, the playbook and the taste again,
one note closely, a fix.

| | Before | After | After, lean set |
|---|---:|---:|---:|
| Tool list × 6 | 49572 | 28620 | 17454 |
| Results | 13561 | 3325 | 3325 |
| **Total** | **63133** | **31945 (−49 %)** | **20779 (−67 %)** |

Clients cache the tool list (a tenth of the price on Anthropic's API), but it fills the context window all the same;
results are paid in full.

## What changed, and why

1. **The tool list (8262 → 4770)**, two thirds of a loop's cost. The schemas the SDK generates carried `$schema` on
   every tool and ±2^53 bounds on every integer; `mcp/lean.ts` (`trimmed()`) announces the same zod schemas without
   them and without `minimum: 0` on frames (the server still validates everything). Descriptions say what an agent
   needs to act — the rules (never verify, final means done, questions vs. info), positions, limits — and leave to
   the loop instructions (sent once) what they already say. The reference shape was described three times (`add_note`,
   `reply`, `attach_reference`); now once. `by` on every write is accepted but not announced: the default author is
   right, and a model that fills it in wrongly makes a person of an agent.
2. **The lean set (→ 2909).** `VR_MCP_TOOLS=lean` (stdio), `/mcp?tools=lean` (HTTP), or a list of names: the review
   loop only. Opt-in, so nobody loses a tool.
3. **Pictures on demand.** Six full frames were half of `get_open_notes`. Only notes with a drawing (a box, an arrow, a
   freehand line, a recording's ring) come with a picture now, cropped to the drawing with as much room again around
   it, at most 512 px; the label names the crop in video px, so coordinates mean the same. Text-only notes come in
   words; `get_note`, `get_frame` and `images: "all"` show anything in full. Range strips and reference pictures went
   from 1280 to 960 px wide.
4. **Paths once.** Locally a slug is the whole path, so a note's three screenshot paths were ~330 tokens. Lists leave
   them to `get_note`; `wait_for_feedback` prints its lines without paths (`shortEventLine`), each video's path once,
   and keeps everything in `structuredContent`. Over a hosted server `get_note` names no server files any more.
5. **Only what changed.** `get_open_notes` ends `as of <time>`; `since` returns the changed notes in full and the rest
   by id. `get_playbook({known})` and `get_taste({known})` say "unchanged" in one line. The taste no longer repeats the
   open notes (`get_open_notes` lists them).
6. **No polling, no status chatter.** The skill and the docs teach `wait_for_feedback` / `vr watch` and never to loop on
   reads; `set_status` is optional (people see notes, fixes and renders as they happen).
7. **The CLI** keeps its agent-parsed formats; `vr open --brief` and `vr watch --brief` are the same with the paths once
   or not at all.

## Budgets

`test/unit/token-budget.test.ts` builds the same fixture and fails when a change makes these more expensive. Each is
the measured value + about 10 %; raise one only on purpose, with the bench run that shows what the tokens buy.

| | Measured | Budget |
|---|---:|---:|
| Tool list | 4770 | 5250 |
| Tool list, lean set | 2909 | 3200 |
| `get_open_notes`, 12 notes | 2704 | 3000 |
| `wait_for_feedback`, 1 note | 430 | 480 |
| `wait_for_feedback`, nothing new | 53 | 58 |
| The hand-off line | 41 | 45 |
| The new-notes line (one note; several: 35) | 43 | 48 |
| The stop line (after a person stopped the work of an agent that listens) | 33 | 36 |
| SKILL.md | 1220 (1385 with the options bullet, 1490 with `vr render`) | 1550 |
| `vr render`, a render put up (its two lines) | 45 | 50 |
| `vr render wait`, still rendering | 32 | 36 |
