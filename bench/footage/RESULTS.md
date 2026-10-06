# Footage search for B-roll — results

Measured 2026-10-02/03 on an Apple M1 Max (10 cores, 64 GB, macOS 15.7, Node 24.21), while other sessions kept the
machine busy (load average between 11 and 300). Wall-clock latencies below are therefore pessimistic; **CPU
milliseconds per frame** (user + system time of the process, all its threads) don't depend on how busy the machine is
and are the numbers to plan with. Harness and reproduction: [README.md](README.md).

## Recommendation

Index what people add — shots, the camera move per shot, keyframes, on-screen text, what is said, one image embedding
per keyframe — and answer an agent with a compact list and, when asked, one contact sheet.

| | Mac (Apple Silicon) | CPU server (x86, no GPU) |
|---|---|---|
| **image/text model** | **SigLIP B/16-224, int8** (Google, Apache-2.0; `Xenova/siglip-base-patch16-224`, `*_quantized.onnx`, 99 + 113 MB) | the same model; an index moving between a Mac and a server is re-embedded (int8 kernels differ, below) |
| frame → model | the whole frame letterboxed to 224 × 224 (`pad`), straight out of ffmpeg | same |
| keyframes | one per 2.5 s of a shot (1 for short shots, at most 6), away from the cuts — ~2,000 per hour of B-roll | same |
| text query | the description alone, no "a photo of" | same |
| runtime | `onnxruntime-node` + `@huggingface/tokenizers` in a worker process; ffmpeg does the pixels (no sharp, no transformers.js in the app) | same; install with `ONNXRUNTIME_NODE_INSTALL=skip` and keep only `linux/x64` (45 MB) |
| decoding | VideoToolbox (`-hwaccel videotoolbox`): 5× less CPU | software; the largest cost (below) |
| OCR | macOS Vision (Lampo's `tools/ocr.swift`): 8/8 captions | tesseract today (5/8 captions); a better engine is the first follow-up |
| store | **node:sqlite** (built into Node), vectors as BLOBs, one file per workspace, scanned in JS | same |
| cuts | Auto-check's own rule (`cutsFromDiffs`) on the same 128 px decode | same |
| index cost per hour of 1080p footage | ≈ 13 CPU-min | ≈ 30–40 CPU-min → 8–10 min on 4 cores |
| storage per hour | ≈ 37 MB (27 thumbnails + 10 index), 0.5 % of the footage | same |
| tokens per request | ≈ 760 (list 210 + sheet 480 + the calls) vs 54–68k today | same |

**Why SigLIP B/16 int8.** On 45 requests over 342 shots it put a right shot first 91 % of the time (93 % with Vision's
OCR) and in the first five every time (MRR 0.95–0.96) — as good as MobileCLIP-S2, whose weights may only be used for
research ("no use in any commercial product or service"), and far ahead of CLIP B/32 (71 %, MRR 0.80). It costs
~175 CPU-ms a keyframe, ~0.5 GB for the image side and ~0.4 GB for the text side, and its files are 212 MB.
**SigLIP 2 B/16** (also Apache-2.0, multilingual) was worse here (80 %, MRR 0.87) and its text side alone needs 1.1 GB
and 317 MB of files; worth a second look at a larger size, not as the default. **CLIP B/32 int8** is the fallback for
a tiny box: 4× cheaper (40 CPU-ms a keyframe), 20 points worse.

**Why no vector database.** At what one workspace realistically holds (10k keyframes ≈ 5 h of footage, 100k ≈ 50 h), a
plain scan over vectors kept in memory answers in 8–17 ms and 80–95 ms, as fast or faster than sqlite-vec's brute
force and LanceDB's flat search, with nothing to install and isolation by file path like everything else Lampo keeps
per workspace. sqlite-vec (a 160 KB extension that loads into the same node:sqlite) is the drop-in for a workspace that
outgrows memory: its partition key answers one workspace of ten in 2–24 ms. LanceDB (~200 MB native, plus optional
transformers.js 3 and openai unless omitted) brings an ANN index that was fast but missed most neighbours on this data
(IVF-PQ recall@10 0.16, 0.57 refined) and filtered by workspace only after scanning everything.

**The filters do as much as the model.** The same model given the raw request (no parsing into aspect, length, move,
"no text", words) finds a right shot first 76 % instead of 91 %, and misses all four requests that hinge on a filter or
on what is said. Requests about motion only work because the move is measured per shot (97.9 % right on this set); the
embedding of one frame cannot see a push-in.

## The numbers

### Test set

27 clips, 17.8 minutes, **342 shots** (315 cuts), made by `make.ts` from 315 CC0 photos (StockSnap via Openverse):

- 139 photos the requests are about, in 11 edited reels (16:9 and one 9:16, 2–4 s shots) and 10 single camera takes
  (8–12 s, one of them 9:16);
- 176 same-theme distractors (other coffee cups, sneakers, laptops, beaches …) in six more reels (one 9:16), so most
  shots look like some other shot;
- camera moves as Ken Burns moves over a 4× upscale: 154 static, 77 push-in, 23 pull-out, 49 pans, 18 tilts, 20 handheld;
- 8 burned-in captions (title, lower third, badge — "FREE SHIPPING", "NEW SCENT", "Anna Berg · Designer", "SALE -30%"
  …) and 5 photos with text in the picture (a STREET CLOSED sign, a police car, neon signs, two labels);
- two voice-overs (macOS `say`: German, English) with their word timings as the transcript.

**45 requests** (`queries.json`) in an editor's words — 31 about what the picture shows, 14 near-duplicates to tell
apart, 11 naming a camera move, 4 a length, 3 an aspect, 4 "no text", 4 text on screen, 2 what is said (one German) —
plus 12 of them typed in German. Right answers are predicates over the ground truth; **pooled judgements**: every
distractor that reached any model's top 5 was looked at, and the 22 that do answer a request were added to it
(`pool.ts`). A result counts when the shot found lies mostly inside a right shot. **R@1** / **R@5** = share of requests
with a right shot first / in the first five; **MRR** over the first ten.

### Retrieval quality

Every request parsed into filters + description (as `find_footage` gets them), tesseract OCR (the server's), ranking by
each shot's best keyframe:

| model · precision · frame fit | R@1 | R@5 | MRR | German R@5 | licence |
|---|---:|---:|---:|---:|---|
| **SigLIP B/16 · int8 · pad** | **91** | **100** | **0.95** | 92 | Apache-2.0 |
| SigLIP B/16 · int8 · squash | 87 | 100 | 0.93 | 92 | |
| SigLIP B/16 · int8 · crop | 80 | 100 | 0.89 | 92 | |
| SigLIP 2 B/16 · int8 · pad | 80 | 98 | 0.87 | 92 | Apache-2.0 |
| SigLIP 2 B/16 · int8 · squash | 84 | 96 | 0.89 | 83 | |
| MobileCLIP-S2 · fp32 · pad | 93 | 100 | 0.96 | 83 | research only |
| MobileCLIP-S2 · fp32 · crop | 78 | 98 | 0.87 | 67 | |
| MobileCLIP-S2 · int8 · crop (165 shots, no distractors) | 9 | 18 | 0.13 | — | its int8 export is broken |
| CLIP B/32 · fp32 · pad | 71 | 89 | 0.79 | 42 | MIT |
| CLIP B/32 · int8 · pad | 71 | 91 | 0.80 | 42 | |
| CLIP B/32 · fp32 · crop | 62 | 87 | 0.73 | 50 | |

With macOS Vision's OCR instead of tesseract: SigLIP B/16 pad 93 / 100 / 0.96, MobileCLIP-S2 pad 93 / 100 / 0.96,
SigLIP 2 pad 80 / 98 / 0.88, CLIP B/32 int8 pad 71 / 89 / 0.79. Before the distractors (the first 165 shots) the same
ranking held a few points higher (SigLIP pad 93 %, CLIP int8 pad 76 %).

Findings:
- **Whole frame beats centre crop** for every model (SigLIP 91 vs 80 % R@1): B-roll subjects sit off-centre and a
  9:16 frame loses most of itself in a square crop. Letterboxing (`pad`) beat stretching (`squash`) for SigLIP.
- **int8 costs nothing** where both precisions were measured (CLIP: 71 % either way) and makes the image side 3× cheaper.
  MobileCLIP's int8 export returns noise — check every quantized file against its float32 twin before shipping one.
- **German**: 11 of 12 German requests found by SigLIP and SigLIP 2, 5 of 12 by CLIP. SigLIP's English-trained text
  side gets far on cognates (Pizza, Sneaker, Golden Retriever, Sprinter); a German request without them is where SigLIP 2's multilingual text
  side would matter. Agents write English anyway; it matters for a person's search field.

### What the parts add (SigLIP B/16 int8 pad, R@1 / R@5 / MRR)

| variant | R@1 | R@5 | MRR |
|---|---:|---:|---:|
| as in the table above (filters + words, "a photo of …" around the description) | 91 | 100 | 0.95 |
| the raw request embedded, no filters or words | 76 | 91 | 0.82 |
| the description alone, without "a photo of" (recommended) | 93 | 100 | 0.96 |
| one keyframe per shot (its middle) | 91 | 100 | 0.95 |
| shot = mean of its keyframes instead of the best | 93 | 98 | 0.96 |
| camera move as a hard filter instead of a bonus | 89 | 96 | 0.92 |
| "no text" as a penalty instead of a filter | 91 | 100 | 0.95 |

The raw request misses q01/q02 (the move, the length, "no text") and both "what is said" requests. A hard motion filter
loses a shot whenever the move is misread (2 % of shots); a bonus keeps it in the list. One keyframe per shot is enough
for 2–4 s reel shots; the takes (8–12 s) keep several so a long shot's best moment is found.

### Reading the footage

| | result |
|---|---|
| cuts (Auto-check's rule on the 128 px decode) | 314 of 315 found within ±1 frame, no false cut; the miss is a hard cut between two products on white |
| camera move per shot (block motion → shift + zoom over the shot) | 97.9 % of 341 shots right; errors: 2 push-ins and 2 pull-outs read as static, 2 statics as push-in, 1 tilt as push-in |
| burned-in captions, tesseract | 5 of 8 (misses white text on a coloured badge twice and a small lower third on 9:16) |
| burned-in captions, macOS Vision | 8 of 8 |
| text that is part of the photo | tesseract 0 of 5, Vision 4 of 5 |
| text reported on the other 328 shots | tesseract 4, Vision 25 — read by eye: all real (labels, signs, screens, book spines) |

"No text" therefore means "no legible text" with Vision (a phone's back that says iPhone counts) and "no text tesseract
can read" on the server. The list prints the text it found, so the agent can judge.

### Speed and memory on the CPU (M1 Max cores)

One fresh process per model; batch 1 and 8; the text side loaded separately as at search time.

| model | files (image + text side) | CPU ms per keyframe | ms per keyframe, 4 threads, batch 8 | ms per query | peak RSS image side / text side |
|---|---:|---:|---:|---:|---:|
| CLIP B/32 fp32 | 352 + 67 MB | 116 | 85 | 23 | 850 / 300 MB |
| CLIP B/32 int8 | 89 + 67 MB | **40** | **18–24** | 16 | 370 / 295 MB |
| **SigLIP B/16 int8** | 99 + 113 MB | **175** | **56–89** | 27 | **516 / 388 MB** |
| SigLIP 2 B/16 int8 | 95 + 317 MB | 166 | 55–74 | 19–23 | 580 / 1,115 MB |
| MobileCLIP-S2 fp32 | 143 + 66 MB | 294 | 107 | 11 | 654 / 297 MB |
| MobileCLIP-S2 int8 | 37 + 66 MB | 230 | 268 | 14 | — (output unusable) |

"CPU ms per keyframe" is with one thread (batch 1 and 8 agree within 5 %): divided by the cores you give the worker, it
is the time per keyframe on an idle machine. With 4 threads ONNX Runtime's spin-waiting adds 10–40 % CPU for little
speed; `allow_spinning = 0` gives most of it back on a shared server. **Extrapolation to x86:** ONNX Runtime's int8
kernels on a Zen 3/4 core (AVX2, VNNI on Zen 4) are in the same range as an M1 performance core; plan with the same CPU
ms (±30 %). A 4-core worker embeds ~23 keyframes a second, i.e. an hour of footage in about 1.5 minutes.

Other stages, per keyframe or per second of footage:

| stage | CPU | note |
|---|---:|---|
| decode 1080p H.264 (16 Mbps) to 128 px, software | 0.26 s per footage s | 4 threads: 0.10 s wall per footage s |
| decode 2160p H.264 (50 Mbps) to 128 px, software | 0.84 s per footage s | 4 threads: 0.36 s wall |
| the same with VideoToolbox (Mac) | 0.05 / 0.09 s per footage s | 5× / 9× less CPU |
| cut diffs + block motion in JS | 1.0 ms per frame | on the 128 px picture |
| keyframe grab by seek (1 s GOP) | 307 ms (1080p), 770 ms (4K) | lib/shots.ts style; the design takes them from the same decode instead |
| tesseract (eng+deu, psm 11) | 183 ms per keyframe | 58 MB |
| macOS Vision | 64 ms CPU, 179 ms wall per keyframe | 238 MB |

### Indexing time and storage per hour of footage

About 2,000 keyframes and 1,150 shots per hour of B-roll (this set: 587 keyframes in 17.8 min).

| per hour of 1080p footage | CPU server | Mac |
|---|---:|---:|
| analysis decode (cuts + moves) | 15.4 min | 3.2 min (VideoToolbox) |
| cut diffs + motion in JS | 1.6 min | 1.6 min |
| keyframes (by seek; ~1 min from the analysis decode) | 10.2 min | — (from the decode) |
| OCR | 6.1 min (tesseract) | 2.1 min (Vision; 6 min wall) |
| image embeddings, SigLIP B/16 int8 | 5.8 min | 5.8 min |
| **total CPU** | **≈ 39 min (30 with keyframes from the decode)** | **≈ 13 min** |
| wall | ≈ 8–10 min on 4 cores | ≈ 10–20 min in the background (decode and OCR run off the CPU, not faster) |
| what is said, if not yet transcribed (bench/stt) | + 16 min (Parakeet) | + 1–2 min (Whisper on Metal, estimated) |

4K footage: the decode is 3.3× (≈ 65–90 CPU-min per hour on the server). The model is not the bottleneck: decoding is.

**Storage:** 360 px thumbnails 13 KB each (27 MB per hour), the index with one model 9.7 MB per hour (vectors as
float32 BLOBs, shots, OCR lines, words) — ≈ 37 MB per hour, 0.5 % of 16 Mbps footage. In memory for the scan: 3 KB per
keyframe (6 MB per hour of footage; int8 would be 1.5 MB).

### Vector stores (768 dimensions, the index's vectors + noise, 50 real queries)

Second run at load ≈ 25–60; min / median latency per query.

| store | 10k: query | 100k: query | 100k: one workspace of 10 | insert 100k | on disk 100k | recall@10 | install |
|---|---:|---:|---:|---:|---:|---:|---:|
| **JS scan over node:sqlite BLOBs** | **8 / 17 ms** | **81 / 95 ms** | separate files: as 10k | 1.8 s (load 0.4 s) | 411 MB (307 MB in memory) | 1.00 | built in |
| sqlite-vec vec0 float | 17 / 24 ms | 142 / 291 ms | 14 / 24 ms (partition key) | 60 s | 317 MB | 1.00 | 160 KB |
| sqlite-vec vec0 int8 | 9 / 13 ms | 91 / 128 ms | 9 / 11 ms | 15 s | 81 MB | 0.75 | |
| LanceDB flat (first run, busier) | 17 ms p50 | 482 ms p50 | 379 ms (where-filter) | 1.3 s | 308 MB | 1.00 | ~200 MB native |
| LanceDB IVF-PQ (√N lists, 48 sub-vectors) | 5 ms | 3.6 ms | 5.6 ms | + 95 s to build | 314 MB | **0.16** (0.57 refined ×10) | |

The noise copies of each real vector are near-ties, which is hard for any quantised or approximate index (int8 and
IVF-PQ recall would be higher on real libraries), but on real data too the exact scan is the only one that is always
right, and at these sizes it is fast enough. No store returned another workspace's rows when filtered (0 of 500 hits),
but a filter is one forgotten `WHERE` away from a leak; a file per workspace isn't.

### What an agent spends (bench/tokens conventions: text heuristic, Claude's image estimate)

"Find a usable B-roll shot for X" on this 17.8-minute library:

| | calls | pictures | tokens |
|---|---:|---:|---:|
| (a1) today, careful: `ls`, `ffprobe`, every clip as 4×4 grids of a frame every 2 s, two close looks for the cut points | 81 | 50 | **68,256** |
| (a2) today, smart: scene detection → one frame per shot in 4×4 grids + the cut times, two close looks | 95 | 37 | **53,611** |
| **(b) `find_footage` (k = 6) + one `footage_sheet`** | 2 | 1 | **764** (list 207 + sheet 477 + calls 80) |
| the two tool definitions, on every turn | | | 355 (find_footage 249, footage_sheet 106) |

(a) grows with the footage — 181–230k tokens per hour of it, for every request, since the agent keeps no index — and
still gives cut points only to the nearest grid frame; (b) stays the same and gives exact in–out frames: **70–89× fewer
tokens per request**. Counting the two tool definitions on all eight turns of an editing session, (b) is 3,604 tokens,
still 15–19× less. The tool list grows by 7 % (4,770 → 5,125); the lean set can leave them out.

The answer the agent reads (q01, SigLIP, 9:16 shots):

```
6 of 341 shots · "product close-up on white" · 9:16 · slow push-in · ≥2s · no text
s320 reel_vertical.mp4 0:20.14–0:23.13 3.0s 9:16 push-in fast · 3.3
s323 reel_vertical.mp4 0:29.02–0:32.01 3.0s 9:16 push-in slow · 3.3
s148 reel_more_3.mp4 0:27.14–0:30.13 3.0s 9:16 push-in slow · 2.7
…
```

and one 552 × 648 px contact sheet of the six (≈ 480 tokens), each tile labelled with the same id and its in point.

## Risks and limits

- **Synthetic motion.** Ken Burns moves over stills: no subject motion, motion blur, rolling shutter or lens breathing.
  The move estimator (a global shift + zoom) will be less sure on real footage with people walking through the frame;
  it is reported per shot with its numbers, so a later model can replace it. Subject motion ("a car driving left") is
  not indexed at all.
- **A small, clean set.** 342 shots of well-composed stock photos; a real library is 10–100× bigger and full of
  near-identical takes. R@1 will drop there; the compact list (6 shots) and the contact sheet are what keeps the agent
  right when the first answer isn't. The requests were written by the person who built the set (pooled judgements
  limit, not remove, that bias).
- **What CLIP-style models don't do**: negation ("no people"), counting, left/right, small text, and *your* product as
  opposed to any sneaker. The next step for product identity is "more like this frame" (image → image, the same
  vectors).
- **OCR on the server.** Tesseract misses stylised captions, so "no text" lets some through on a CPU server. A small
  ONNX OCR (e.g. PaddleOCR's detector + recogniser, ~20 MB, the same runtime) would also lift Auto-check's caption checks
  on Linux.
- **Cost is decoding.** 4K camera originals cost 3× the CPU of 1080p; a hosted plan needs footage hours in its limits.
- **Memory on a shared server**: a worker (~0.5 GB) per indexing job and the text side (~0.4 GB) while a library is
  searched; both should unload when idle, like the speech worker. The scan keeps 3 KB per keyframe in memory per
  workspace being searched.
- **Licences**: SigLIP and SigLIP 2 are Apache-2.0, OpenAI's CLIP MIT; Apple's MobileCLIP weights are research-only
  and must not ship; StockSnap photos are CC0 and only their URLs are in git.
- **Vectors are not portable across CPUs.** The same five frames embedded by the Linux x86-64 build (`docker_x64.sh`)
  came out at cosine 0.993 (SigLIP), 0.980 (SigLIP 2) and 0.981 (CLIP) to the Mac's: ONNX Runtime's int8 kernels
  quantise differently on ARM and x86. Keep the model *and* the runtime's platform with every vector, search a library
  only with vectors from one platform, and re-embed (minutes per hour of footage) when a store moves between a Mac and a
  server. float32 would travel better at 3× the CPU.
- **Install weight**: `onnxruntime-node` is 301 MB unpacked (every platform's binaries; 548 MB on Linux if its script
  is allowed to fetch the GPU providers); a CPU image keeps only `bin/napi-v6/linux/x64` (45 MB). transformers.js would
  add onnxruntime-web (145 MB) and sharp: not needed in the app.

## Design sketch (the real feature)

**Where footage lives.** A *Footage* library next to the videos under review, never mixed with them (footage has no
versions, notes or stages). People add it themselves — Lampo never scans folders:
- on the machine: *Add footage* links files where they are (`via === 'local'` only; paths never leave the machine) or
  copies them in;
- hosted: uploads (tus, the workspace's `storage()`, keys `footage/<id>/<name>`), per workspace.

What was added is data — `dataDir()/footage.json` (id, name, folder, size, `sampleHash`, `added_by_id`). The index is
derived: `cacheDir()/footage/index.db` (node:sqlite: clips by `sampleHash`, shots, keyframes, OCR lines, words, vectors
per model) and `cacheDir()/footage/thumbs/`. One file per workspace through `cacheDir()`, so isolation is the path,
deleting a workspace deletes it, and the isolation walk covers it like every other per-workspace file. A re-added file
reuses its analysis; vectors carry their model and CPU platform, and a model upgrade or a move between a Mac and a
server re-embeds in the background.

**Background jobs.** `PRIORITY.footage = 9`, after sprites: footage never delays a review. Per file, separate `heavy()`
jobs so a scrub copy can cut in between them:
1. one decode → the 128 px picture for cuts (`cutsFromDiffs`) and moves, plus a 960 px frame every 0.5 s from which
   each shot's keyframes are taken (a seek only for shots shorter than that);
2. thumbnails (360 px JPEG) and OCR (Vision on the Mac, tesseract — later a small ONNX OCR — on a server);
3. image embeddings in a worker process (`child_process.fork`, like the speech worker: one ONNX session, threads =
   half the cores, no spinning, unloaded after 10 idle minutes);
4. words from `lib/transcripts.ts` when the file has speech and a transcript is wanted (opt-in per file or library: it
   is the most expensive stage on CPU).

Hosted: the workspaces take turns as they do now, `HOSTED_QUEUE_LIMIT` applies, and a quota hook
(`check(ws, 'footage', seconds)`) lets plans count footage hours. Progress goes out as an SSE `footage` event.

**MCP tools** (schemas as a client sees them; 355 tokens together, measured in `agent-cost.ts`):

```json
{ "name": "find_footage",
  "description": "Shots in the footage library, one line each: id, clip, in–out, length, aspect, move, score. query = what the picture shows; the rest in filters.",
  "input_schema": { "type": "object", "required": ["query"], "properties": {
    "query": { "type": "string" },
    "aspect": { "type": "string", "enum": ["16:9", "9:16", "1:1"] },
    "min_s": { "type": "number" }, "max_s": { "type": "number" },
    "motion": { "type": "string", "enum": ["static", "push-in", "pull-out", "pan", "tilt", "handheld"] },
    "text": { "type": "string", "description": "\"none\", or words on screen" },
    "said": { "type": "string" },
    "limit": { "type": "integer" } } } }
{ "name": "footage_sheet",
  "description": "One labelled contact sheet of shots by id; frames 3 shows the move.",
  "input_schema": { "type": "object", "required": ["ids"], "properties": {
    "ids": { "type": "array", "items": { "type": "string" } },
    "frames": { "type": "integer", "enum": [1, 3] } } } }
```

Answers: a header naming the filters, one line per shot (`s412 Footage/Acme/take_031.mp4 0:20.14–0:23.13 3.0s 9:16
push-in slow · 3.3`), ids stable across calls (no session state over stateless HTTP), every text field through
`oneLine`, `folder` accepted but not announced. `footage_sheet` returns one JPEG ≤ 1000 px wide (6 tiles ≈ 480 tokens,
`frames: 3` = in, middle, out per shot). Budget lines in `test/unit/token-budget.test.ts`; not in `LEAN_TOOLS`
(`?tools=lean,footage` adds them). An agent may ask for *more like this*: `find_footage({ like: "s412" })` reuses the
shot's vector (no new schema field until it is built).

**`vr footage`** (both backends): `vr footage add <files…> [--folder X]`, `vr footage find "<request>" [--aspect 9:16]
[--min 2] [--motion push-in] [--no-text] [--said "…"] [--sheet out.jpg] [--json]` — the free text is parsed the way
`find.ts` does (filters out of the words), flags win —, `vr footage sheet <ids…> -o sheet.jpg`, `vr footage status`.

**UI.** *Footage* in the sidebar's Library section (after All videos). The view: a search field that takes the request
in words and shows the filters it read as chips you can remove; results as shot cards (best keyframe, hover-scrub over
in–out from the file's sprite, in–out and length, aspect, a move glyph, the text or words in one line); *Add footage*
(drop, choose, or link on the machine) and a quiet per-file indexing line. A card opens the frame-exact player on the
source file with in and out marked (I / O move them; *Copy for an agent* gives the line).

**Link to "options to audition".** Picking B-roll is choosing between candidates, which is what options are for. An
agent runs `find_footage`, then `ask_options` with a group `broll` whose items are the top shots — for now each a `clip`
reference cut from the footage file's in–out (≤ 10 s, the existing ref kind, no contract change; later a `footage`
reference that plays the library file directly). The person auditions them side by side in the inbox, the note card or
the folder, picks one or several and writes what else matters; the agent reads `PICKED broll=s412` and the in–out it
already has. From the Footage view a person can do the reverse: select shots → *Offer to the agent* makes the same
question.

## Plan

1. **The index, on the machine** (~2 weeks): `lib/footage/` (the one-decode analysis with `cutsFromDiffs`, the move
   estimator, keyframes from the decode, OCR through `lib/text`, words through `lib/transcripts`), the embedding worker
   (`onnxruntime-node` + `@huggingface/tokenizers`, model download on first use into `CACHE/models/` with size + SHA-256
   like the speech models), node:sqlite store and scan, `PRIORITY.footage`, `vr footage add/find/sheet/status`; tests
   on generated clips (cuts and moves against known ground truth, a tiny fake model for the ranking).
2. **Agents** (~3–4 days): `find_footage`, `footage_sheet`, budgets, SKILL.md and `docs/agents.md`, the activity
   templates, both backends.
3. **Hosted** (~1 week): uploads, per-workspace index, the job queue and quota hook, permission table and isolation
   walk lines, a CPU image without GPU providers.
4. **The Footage view** (~2 weeks): search, results, add, progress, the shot player, *Offer to the agent* with options.
5. **Later**: a small ONNX OCR for servers, "more like this", per-shot audio tags (speech, music, silence), subject
   motion, near-duplicate grouping, optional re-ranking of the top 20 by a vision model for people who bring a key.

## What was downloaded

All under `cache/footage/` (gitignored), nothing in git but URLs and licences:

| what | size |
|---|---:|
| `Xenova/clip-vit-base-patch32`: vision fp32 + int8, text int8, tokenizer | 507 MB |
| `Xenova/siglip-base-patch16-224`: vision int8, text int8, tokenizer | 213 MB |
| `onnx-community/siglip2-base-patch16-224-ONNX`: vision int8, text int8, tokenizer | 413 MB |
| `Xenova/mobileclip_s2`: vision fp32 + int8, text int8, tokenizer | 246 MB |
| **models total** | **1,379 MB** |
| CC0 photos (StockSnap via Openverse, 960 px): 315 used, from 320 candidates fetched while curating (8 per theme) | 27 MB (+ 70 MB) |
| npm packages for the bench (`bench/footage/node_modules`) | 1.1 GB on disk |

## The app's own run (step 1, 2026-10-05)

`app-eval.ts` runs the same 45 requests (and the 12 German ones) through the app's `lib/footage/` — ONNX Runtime and
`@huggingface/tokenizers` in a worker process, frames straight from ffmpeg, node:sqlite, the description alone — on
the same clips, with the model downloaded by the app (pinned revision, SHA-256 checked):

| | R@1 | R@5 | MRR | German R@5 | captions read |
|---|---:|---:|---:|---:|---:|
| Vision OCR (a Mac) | 93 | 100 | 0.96 | 100 | 8 of 8 |
| tesseract (eng only on this Mac) | 93 | 100 | 0.96 | 100 | 5 of 8 |

Cuts 314 of 315 (no false one), moves 97.9 % of 341 shots, as above. One difference from the prototype: the app embeds
one picture at a time. The int8 model quantizes its activations with a scale taken over the whole batch, so the
prototype's batches of eight gave each frame a vector ~0.99 cosine from its own (`transformers.js` and the app agree to
1.000000 at batch 1); one at a time a frame's vector no longer depends on its neighbours, at the same CPU. CPU of the
whole process tree (decode, OCR, the model's worker): 274 s for the 17.8 minutes with Vision, 379 s with tesseract —
≈ 15 and 21 CPU-minutes per hour of footage on the Mac (load average 185–400 during the run, so wall clock says nothing).

## Caveats

- Wall-clock numbers come from a machine shared with other heavy jobs; CPU times are the comparable ones.
- One run per configuration; on 45 requests one request is 2.2 points of R@1 — differences under ~5 points are noise.
- German: 12 requests, many with English cognates.
- x86-64: the Linux prebuilts (`node:24-slim`, linux/amd64, emulated) install — 474 MB for transformers.js +
  onnxruntime-node + sqlite-vec with the GPU providers skipped, of which the app would need onnxruntime-node's 45 MB
  binary, its JS and the tokenizers — load all three models and sqlite-vec, and give close but not identical vectors
  (above). They were not timed: emulation says nothing about speed.
