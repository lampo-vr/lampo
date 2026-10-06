# Footage search: B-roll for agents

Agents that edit need B-roll, and without help they look through footage frame by frame: tens of thousands of tokens
for every request, and cut points only to the nearest frame they happened to look at. Lampo indexes the videos people
add and answers a request in words with a short list of shots, each with its exact in and out frames, and on request
one labelled contact sheet of them: a few hundred tokens.

```sh
vr footage find "product close-up on white, slow push-in, ≥ 2 s, 9:16, no text"
```

```
6 of 341 shots · "product close-up on white" · 9:16 · slow push-in · ≥2s · no text
s148320 Footage/reel_vertical.mp4 00:20:03–00:23:02 3.0s 9:16 push-in slow · 3.3
s148323 Footage/reel_vertical.mp4 00:29:02–00:32:01 3.0s 9:16 push-in fast · 3.1
…
```

The research behind it, with every number: [bench/footage/RESULTS.md](../bench/footage/RESULTS.md).

## What is indexed

The newest version of every video in the workspace: uploaded or tracked, whatever it is (a camera take, a stock clip,
an edited reel). Not the onboarding sample, and not archived videos (their index is kept for when they come back).
Lampo never scans folders: what is searched is what people added.

For each video, once per render (two videos holding the same file share it):

- **Shots**: the cuts, found by Auto-check's own rule (`cutsFromDiffs`) on a 128 px decode. A shot is at least half a
  second long (a shorter one, a flash cut or a strobe, joins the next), and a video has no more shots than its
  keyframes allow (below): its work follows its length, not how it is cut.
- **The camera's move per shot**: `static`, `push-in`, `pull-out`, `pan-left`, `pan-right`, `tilt-up`, `tilt-down` or
  `handheld`, with `slow` or `fast`, measured from the picture (block motion fitted to a shift and a zoom), never
  guessed by a model.
- **Keyframes**: one per 2.5 s of a shot (one for a short shot, at most six), away from its cuts, each kept as a
  360 px thumbnail for contact sheets; at most 60 a minute of video (past that, one a shot).
- **Text in the picture**: OCR of every keyframe (macOS Vision on a Mac, tesseract elsewhere).
- **What is said**: from the video's transcript when it has one (the player's Transcript tab, `vr transcript`). Footage
  search makes none of its own: a transcript costs far more than the rest.
- **One image embedding per keyframe**: the whole frame letterboxed to a square, by SigLIP B/16 (below).

A request is read the way the research measured: the filters it names (aspect, length, camera move, "no text", words
on screen or said) are taken out of the words, and what is left — what the picture should show — is compared with
every keyframe. A shot scores by its best keyframe; a matching move and matching words add to it; aspect, length and
"no text" filter. The filters do as much as the model: asked the raw request, the same model finds a right shot first
76 % of the time instead of 93 %.

## On, off, and where it runs

| | default | turned on or off by |
|---|---|---|
| A person's own machine | on | `vr footage on` / `off` |
| A hosted server | off, per workspace | its owners and admins: `vr footage on`, `PUT /api/footage/settings` |
| Anywhere | `footage: "off"` in config.json, or `VR_FOOTAGE=off`: nothing is indexed, nothing downloaded | the operator |

The index is built in the background by the app's one job queue, after everything a review needs (`PRIORITY.footage`,
after sprites): a video's work is cut into jobs of a minute of video or 48 keyframes within a minute of each other,
so a long take never holds a player's scrub copy back. Turned on, every video is queued; a new version is indexed when it arrives and the old
one's shots leave the index. `vr footage status` says how far it is.

On a machine without the app running, `vr footage index` indexes in its own process (the model's worker included) and
`vr footage find` reads what is there.

**The model** is [SigLIP B/16-224](https://huggingface.co/Xenova/siglip-base-patch16-224), int8 (Google, Apache-2.0):
213 MB, downloaded once on first use into `<cache>/models/siglip-base-patch16-224/` (`VR_FOOTAGE_MODELS` moves it),
from one pinned revision, every file checked by size and SHA-256 before it is used. Nothing downloads at install
time. It runs in a process of its own through ONNX Runtime (`onnxruntime-node`, an optional dependency: without it,
footage search answers by filters and words only), one picture at a time with half the cores (at most four), and stops
after ten idle minutes (`VR_FOOTAGE_IDLE_MINUTES`). A copy of the files put in that folder by hand is checked and used.

**Vectors belong to a CPU family**: ONNX Runtime's int8 kernels differ between ARM and x86 (cosine 0.98–0.99), so every
vector is tagged with its model and platform, and a store moved between a Mac and a Linux server is embedded again in
the background (minutes per hour of footage) before its pictures are searched.

**What it costs**, measured with the app's own indexer on the research's test set (18 minutes, 341 shots, 587
keyframes) on an M1 Max (`bench/footage/app-eval.ts`; CPU of the whole process tree):

| | |
|---|---|
| indexing on a Mac (VideoToolbox decode, Vision OCR, embeddings) | ≈ 15 CPU-minutes per hour of 1080p footage |
| the same with tesseract for the text | ≈ 21 CPU-minutes per hour |
| on a CPU-only server (software decode; estimate from the research) | ≈ 30–40 CPU-minutes per hour; decoding is the largest part |
| storage, in the workspace's cache | ≈ 22 MB of index and 24 MB of thumbnails per hour of footage |
| a search | tens of milliseconds on a quiet machine (the text embedding, a scan over every keyframe in JS, the ranking) |
| memory | the model's worker ≈ 0.5 GB while it runs; it stops after ten idle minutes |

## The answer: `vr footage find --json`

The same JSON from `vr footage find --json` (on the machine or logged in to a server) and `GET /api/footage/find`.
New fields may be added; none is renamed (`footage_version`).

```json
{
  "footage_version": 1,
  "query": "product close-up on white, slow push-in, ≥ 2 s, 9:16, no text",
  "read": { "show": "product close-up on white", "aspect": "9:16", "min_s": 2,
            "no_text": true, "motion": ["push-in"], "speed": "slow" },
  "shots": [
    { "id": "s148320", "video": "<slug>", "name": "reel_vertical.mp4", "folder": "Footage",
      "v": 1, "fps": 25, "in": 503, "out": 577, "t0": 20.12, "t1": 23.12, "length_s": 3,
      "width": 1080, "height": 1920, "aspect": "9:16", "move": "push-in", "speed": "slow",
      "frame": 540, "text": "", "said": "", "score": 3.31,
      "file": "/Users/you/footage/reel_vertical.mp4" }
  ],
  "searched": 341,
  "index": { "on": true, "videos": 27, "indexed": 27, "waiting": 0, "failed": 0 },
  "sheet": "/Users/you/.../sheet.jpg"
}
```

| field | |
|---|---|
| `read` | what the request was read as: `show` (the description compared with the pictures), `aspect`, `min_s`, `max_s`, `motion` (the moves that count), `speed`, `no_text`, `words` and `words_in` (`text`, `said` or `any`) |
| `shots[].id` | `s` + a number: stable while the video's version stays the same; each index numbers from a random start, so an old id (or another workspace's) names no shot rather than a wrong one |
| `video`, `v` | the video's slug (what `vr open`, `get_frame` and the API take) and its version (always the newest) |
| `in`, `out` | the shot's first and last frame, **both included** (Lampo's frame ranges); frame N is ffmpeg's `select=eq(n,N)` |
| `t0`, `t1` | the same in seconds: `in / fps` and `(out + 1) / fps`, where the last frame ends: cut `[t0, t1)` |
| `length_s` | `t1 − t0`, rounded to tenths |
| `move`, `speed` | the camera's move over the shot; `speed` is `null` for `static` and `handheld` |
| `frame` | the keyframe that matched the description best (the contact sheet shows it) |
| `text`, `said` | text read in the picture, words said during the shot (`""` when none) |
| `score` | higher is better; comparable within one answer only |
| `matched` | where the request's words were found (`text`, `said`), when they were |
| `file` | the render's file on this machine: **only for the machine itself** (`vr` on it, its own agent over stdio or loopback). Over the network (a token, the LAN link, `vr` logged in to a server, `/mcp`) it is left out; fetch by `video` and `v` instead |
| `index` | how far the workspace's index is; `note` says why it is off, or that an answer used filters and words only (the model still downloading, or no picture indexed yet) |
| `sheet` | with `--sheet`: the contact sheet, a JPEG on this machine |

`vr footage find` without `--json` prints the compact list above: a head naming what was read, one line per shot
(`id folder/name [Vn] in–out length aspect move [speed] [text "…"] [said "…"] · score`), and a last line in brackets
when the index isn't complete.

## Commands, tool, routes

```sh
vr footage find "<request>" [--aspect 9:16] [--min 2] [--max 8] [--motion push-in]
                            [--no-text | --text "SALE"] [--said "…"] [--limit 6]
                            [--sheet [out.jpg]] [--json]
vr footage sheet <id…> [--out sheet.jpg]   # one labelled contact sheet (at most 9 shots)
vr footage status [--json]                 # videos indexed, waiting, failed; the model
vr footage on | off                        # the workspace's switch
vr footage index [<video>…]                # on the machine: index now, in this process
```

Flags win over the words. `--motion` takes `static`, `push-in`, `pull-out`, `pan`, `pan-left`, `pan-right`, `tilt`,
`tilt-up`, `tilt-down` or `handheld`.

**MCP:** `find_footage({query, aspect?, min_s?, max_s?, motion?, text?, said?, limit?, sheet?})` answers the compact
list, and with `sheet: true` one contact sheet as a picture (≈ 210 tokens for six shots, ≈ 480 for the sheet). It is
in the full tool list (325 tokens on every turn), not in the lean set. An agent with only `view` may use it.

**HTTP** (every route checked against the workspace's roles, `server/permissions.ts`):

| route | needs | |
|---|---|---|
| `GET /api/footage/find?q=&aspect=&min_s=&max_s=&motion=&text=&said=&limit=` | view | the answer above |
| `GET /api/footage/sheet?ids=s1,s2` | view | the contact sheet (JPEG), one to nine shots |
| `GET /api/footage/status` | view | how far the index is, and the model |
| `PUT /api/footage/settings` `{on}` | admin | the workspace's switch; turned on, every video is queued |

## Isolation

Each workspace's index is a file in its own cache (`footage/index.db`, node:sqlite, vectors as BLOBs scanned in JS;
thumbnails beside it): a workspace can only ever open its own, deleting the workspace deletes it, and clearing the
cache only costs indexing again. A shot id names a shot of the caller's workspace or nothing. The routes, `vr` and the
MCP tool all search the workspace the caller is in (`test/unit/footage-api.test.ts`,
`test/unit/workspace-isolation.test.ts`).

## Limits

- **The test set is clean and small**: 342 shots of well-composed stock photos with Ken Burns moves. A real library is
  bigger and full of near-identical takes; the list and the sheet keep the agent right when the first shot isn't.
- **Subject motion isn't indexed** ("a car driving left"), nor negation ("no people"), counting, left and right, or
  *your* product as opposed to any sneaker (step 2: "more like this frame").
- **Text on a server**: tesseract reads stylised captions less well than Vision (5 of 8 captions in the research,
  Vision 8 of 8), so "no text" lets more through there.
- **German**: SigLIP's text side is English; German requests work on cognates (11 of 12 found in the research).
- **Decoding is the cost**: 4K footage costs about three times the CPU of 1080p.
