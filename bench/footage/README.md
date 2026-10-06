# Footage search benchmark

Can Lampo find B-roll for an agent — "product close-up on white, slow push-in, ≥ 2 s, 9:16, no text" — so the agent
reads one compact list and one contact sheet instead of looking through footage frame by frame? Which image/text
embedding model, which vector store, at what cost on a CPU-only server and on a Mac? Results and the recommendation:
[RESULTS.md](RESULTS.md).

This is a prototype next to the app, not part of it: nothing here is imported by `lib/`, `server/` or `mcp/` (the app's
own implementation, `lib/footage/`, is checked against it by `app-eval.ts`). Its
dependencies live in `bench/footage/package.json` (`npm install --prefix bench/footage`), not in the app's.

## Layout

| file | what it does |
|---|---|
| `sources.json` | 315 CC0 photos (StockSnap via the Openverse API with `license=cc0`, picked by eye from 8 results per theme): 139 that the queries are about, each with what it shows, and 176 same-theme distractors. URL, creator, licence, landing page per photo. No media in git |
| `make.ts` | downloads the photos and turns them into 27 clips (18 min, 342 shots): edited reels (16:9 and 9:16), single camera takes, Ken Burns moves with exact ground truth (static, push-in, pull-out, pan, tilt, handheld), burned-in captions, two voice-overs (macOS `say`, German and English) → `cache/footage/clips/` + `truth.json` |
| `queries.json` | 45 requests with their right answers as predicates over the ground truth (photo, move, aspect, length, text, what is said); tags for the hard cases |
| `models.ts` | the embedding models as exact ONNX files from Hugging Face → `cache/footage/models/` (1.38 GB) |
| `analyse.ts` | one 128 px decode per clip: cuts (Lampo's `cutsFromDiffs`), the camera move per shot (block motion → shift + zoom), keyframe choice |
| `embed.ts` | image/text embeddings with ONNX Runtime via transformers.js; frames come from ffmpeg at the model's size (crop · squash · pad) |
| `index.ts` | the indexer: shots → moves → keyframes → OCR (Lampo's tesseract / Vision code) → transcript → embeddings → one SQLite file |
| `find.ts` | the search: request → filters + description (`parseQuery`), ranking (similarity + words), the compact list, the contact sheet. Also a CLI |
| `eval.ts` | quality: R@1, R@5, MRR per model variant and ablation; how well cuts, moves and text are read |
| `speed.ts` | CPU cost: embeddings per model (fresh process each: load, batch 1/8, CPU ms per frame, RSS), OCR per frame, decoding 1080p/4K |
| `stores.ts` | vector stores at 10k / 100k: JS scan over node:sqlite BLOBs, sqlite-vec (float, int8), LanceDB (flat, IVF-PQ), one workspace of ten |
| `agent-cost.ts` | tokens for "find a usable B-roll shot": an agent looking through grids today vs `find_footage` + one sheet |
| `memory.ts` | peak RSS of the image side and the text side alone, as the app would run them |
| `pool.ts` | pooled judgements: sheets of the distractors that reached a top 5, to judge by hand |
| `linux_check.ts`, `docker_x64.sh` | the Linux x86-64 prebuilts in `node:24-slim` (emulated): install weight, the same vectors as on the Mac, sqlite-vec |
| `smoke.ts` | loads every model and checks three frames against three captions |
| `app-eval.ts` | the app's own footage search (`lib/footage/`, step 1) on this test set: every clip tracked in a throwaway store, indexed by the app's indexer with the real model, the requests asked through `find()`, scored like `eval.ts`; `--ocr tesseract` for the server's engine |

## Reproduce

```sh
node --version                                         # ≥ 22.18 (node:sqlite, type stripping); .nvmrc
npm install --prefix bench/footage                     # transformers.js, onnxruntime-node, sqlite-vec, LanceDB
node bench/footage/models.ts                           # 1.38 GB of ONNX files
node bench/footage/make.ts                             # photos + clips + truth.json (~10 min)
node bench/footage/index.ts --ocr tesseract,vision \
  --models siglip2-b16:q8:pad,siglip-b16:q8:pad,clip-b32:fp32:pad,mobileclip-s2:fp32:pad   # add :crop / :squash variants as wanted
node bench/footage/eval.ts [--ocr vision] [--detail siglip2-b16:q8:pad]
node bench/footage/speed.ts --threads 1,4              # run on a quiet machine; CPU ms per frame is the robust number
node bench/footage/memory.ts
node bench/footage/pool.ts                             # after eval.ts: the distractors to judge by hand
node bench/footage/stores.ts --sizes 10000,100000
node bench/footage/agent-cost.ts
node bench/footage/linux_check.ts --dump && bench/footage/docker_x64.sh   # Docker: the x86-64 prebuilts
node bench/footage/find.ts "product close-up on white, slow push-in, ≥ 2 s, 9:16, no text" --sheet /tmp/sheet.jpg
```

Everything lands in `cache/footage/` (gitignored): photos, clips, models, the index (`work/index.db`), results
(`results/*.json`). `VR_FOOTAGE_CACHE` moves it. The indexer points Lampo's own modules at a throwaway store
(`VR_DATA`/`VR_CACHE` under `cache/footage/work/store`), never a live one. Voice-overs need macOS `say`; elsewhere the
two "said" queries are skipped. OCR with Vision needs macOS with Xcode tools; tesseract needs `eng` + `deu` data.
