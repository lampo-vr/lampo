# Speech-to-text for voice notes — results

Measured 2026-09-28 on an Apple M1 Max (64 GB, macOS 15.7) and in `node:24-slim` Linux containers capped at 4 CPUs.
Harness and reproduction: [README.md](README.md).

## Recommendation

**One runtime everywhere: [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) through its Node
binding, npm [`transcribe-cpp`](https://www.npmjs.com/package/transcribe-cpp) 0.2.x.** Prebuilt natives for macOS
arm64 (Metal), Linux x64/arm64 (CPU, Vulkan when a driver exists) and Windows — no compiler, no Python, no CUDA.
It runs in-process in Node (compute on a libuv worker thread), so the server loses its Python/MLX dependency.

| where | default model | why |
|---|---|---|
| **Mac / any machine with a GPU** | **Whisper large-v3-turbo, Q8_0** (886 MB) | most robust overall (11.0 % WER, 3 of 126 clips badly wrong, best in noise, best with German/English mix, perfect language detection), 0.49 s per note on Metal, 1.3 GB RAM — faster and leaner than today's mlx-whisper for the same model |
| **Server / Docker, CPU only** | **Parakeet TDT 0.6B v3, Q8_0** (740 MB) | 0.35 s per note on 4 vCPUs (Whisper needs 7–10 s there: it always encodes a 30 s window), on par with Whisper on real German speech, 1.3 GB RAM, never invents text on silence |
| **GPU box or hosted API** | OpenAI-compatible `/v1/audio/transcriptions` backend | the same contract is served by whisper.cpp's server, CrispASR, vLLM (Qwen3-ASR), speaches and hosted APIs — the right abstraction for "bring your own STT", not the default |

Rule for `model: auto`: a device with `deviceType === 'gpu'` in `getAvailableBackends()` (Apple Silicon reports
`MTL0`/metal as `gpu`; CUDA and discrete Vulkan cards too) → Whisper-turbo; otherwise → Parakeet v3. Integrated GPUs
(`igpu`) and plain CPU count as CPU.

Three behaviours matter more than the model choice:

1. **Never force the language on the first pass.** A fixed language hint makes every engine invent text on silence
   ("Vielen Dank.", "Untertitelung des ZDF, 2020", whole Qwen sentences) and turns English notes into gibberish
   (Whisper with `de`: 62–67 % WER on English). Today's config `whisper_language: 'de'` has exactly that problem.
   Instead: **auto-detect; if the detected language is not one the reviewer speaks (config, e.g. `["de","en"]`),
   re-run that clip once with the first of them.** Whisper never needed the re-run (0 of 126); it fixed 4–6
   misdetections for Qwen3-ASR (German read as Dutch).
2. **Vocabulary prompts are opt-in and guarded.** Whisper's initial prompt with domain terms fixes English words in
   German notes (mixed WER 21 % → 7.8 %) but occasionally collapses a clip ("Beiôt说加入Roll kilometers", "und" — 2 of
   36 real clips). If offered: run with the prompt, and re-run without it when the output has non-Latin script for a
   de/en reviewer or fewer than ~1 word per 2 s of audio.
3. **Keep the model warm in a worker, not per request.** Load is 0.3–1.1 s once cached, but the very first load on a
   machine compiles Metal kernels / reads the file cold (26–28 s measured) — pre-warm at server start.

Rejected: **ARK-ASR-3B** (drifts into English translations of German speech even with a German instruction —
36 % WER, 33 of 126 clips badly wrong; runtime marked experimental; 4.8 GB RSS). **Qwen3-ASR 0.6B** (20–22 % WER).
**onnx-asr int8 Parakeet** on CPU (fastest, 0.16 s, but 62.5 % WER in noise vs 12.5 % for transcribe.cpp's Q8).
**mlx-whisper / parakeet-mlx / mlx-audio** as app runtimes: fine engines, but Apple-only Python, slower than
transcribe.cpp on Metal, and mlx-whisper invented "Thank you." on all 6 noise-only clips.

## Test set

| subset | clips | words | what |
|---|---:|---:|---|
| synthetic German | 48 | 528 | 16 editor notes (Bauchbinde, Untertitel, Farbkorrektur, Übergang, Schnitt, Logo, numbers …) × clean / noisy / laptop |
| synthetic German/English mix | 18 | 177 | 6 notes (Caption, B-Roll, Color Grading, Call to Action, Jump Cut, After Effects, Safe Zone) × 3 conditions |
| synthetic English | 24 | 225 | 8 notes × 3 conditions |
| real German | 19 | 448 | 4–10 s clips cut at word boundaries from 4 German talking-head social videos (music-free exports) |
| real German + music | 17 | 397 | the same moments from the published versions with background music |
| noise only | 6 | — | 3 s of room noise, laptop fan, mains hum, clicks, breathing — the right answer is no text |

Synthetic notes are macOS `say` voices (9 German, 7 English), noisy = pink noise at 15 dB SNR, laptop = 300–3400 Hz
band + white noise at 25 dB SNR. WER is corpus-level after normalisation (lowercase, ß→ss, hyphens/punctuation
removed, digits spelled out); cells show **WER % / CER %**.

## Accuracy (all 126 speech clips)

| engine · runtime | de clean | de noisy/laptop | mixed de/en | en | real de | real de + music | **all** | clips > 50 % wrong |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Whisper-turbo · transcribe.cpp Q8** (auto) | 4.5 / 1.6 | 18.2 / 9.7 | 21.1 / 8.4 | 2.7 / 1.6 | 10.7 / 5.2 | 7.8 / 2.2 | **11.0** | 3 |
| Whisper-turbo · mlx-whisper (auto) | 3.4 / 1.0 | 16.5 / 8.4 | 20.0 / 8.0 | 2.2 / 1.3 | 9.8 / 4.5 | 9.4 / 3.8 | **10.5** | 3 |
| Whisper-turbo · mlx-whisper · `de` (today's config) | 3.4 / 1.0 | 10.8 / 5.1 | 20.0 / 8.0 | **67.1** / 61.3 | 9.8 / 4.5 | 9.4 / 3.8 | **17.6** | 15 |
| **Parakeet v3 · transcribe.cpp Q8** | 6.8 / 2.5 | 25.9 / 13.5 | 30.0 / 14.5 | 6.7 / 2.4 | 11.6 / 5.7 | 7.1 / 1.9 | **14.2** | 8 |
| Parakeet v3 · parakeet-mlx (bf16) | 6.8 / 2.3 | 36.9 / 19.5 | 41.1 / 21.0 | 6.7 / 2.7 | 11.4 / 5.2 | 8.4 / 2.4 | **17.7** | 14 |
| Qwen3-ASR 1.7B · transcribe.cpp Q8 (auto) | 9.1 / 3.4 | 33.8 / 18.3 | 30.0 / 16.0 | 2.2 / 1.1 | 9.4 / 4.6 | 8.4 / 3.5 | **15.2** | 10 |
| Qwen3-ASR 1.7B · transcribe.cpp · auto → `de` re-run | 9.1 / 3.4 | 30.4 / 15.9 | 30.0 / 16.0 | 2.2 / 1.1 | 9.4 / 4.6 | 8.4 / 3.5 | **14.5** | 10 |
| Qwen3-ASR 1.7B · mlx-audio 8bit · `de` + hotwords | 10.2 / 4.1 | 21.6 / 10.7 | 15.6 / 9.3 | 13.3 / 8.8 | 9.4 / 4.0 | 9.6 / 4.0 | **13.1** | 7 |
| Qwen3-ASR 0.6B · transcribe.cpp Q8 (auto) | 23.9 / 11.5 | 45.2 / 23.7 | 43.9 / 24.0 | 4.4 / 2.3 | 12.5 / 5.3 | 12.4 / 4.4 | **22.3** | 20 |
| ARK-ASR-3B · CrispASR Q8 · German instruction (HTTP) | 47.7 / 19.8 | 57.4 / 33.8 | 49.4 / 27.3 | 4.4 / 2.3 | 32.0 / 16.8 | 28.1 / 13.6 | **36.0** | 33 |

Whisper-turbo variants (transcribe.cpp Q8):

| variant | de noisy/laptop | mixed | en | real de | all | clips > 50 % wrong |
|---|---:|---:|---:|---:|---:|---:|
| auto (default) | 18.2 | 21.1 | 2.7 | 10.7 | **11.0** | 3 |
| `de` hint | 11.1 | 21.1 | 62.2 | 10.7 | 17.1 | 15 |
| auto + vocabulary prompt | 15.3 | 7.8 | 1.8 | 17.7 | 11.4 | 5 |
| `de` hint + vocabulary prompt | 10.5 | 7.8 | 1.8 | 15.2 | 9.8 | 3 |

What the numbers say: on **real** German speech the three families are within ~2 points (9.4–11.6 clean, 7.1–8.4
with music) — differences of that size are ~10–20 words out of 448 and not significant. They separate on robustness:
noisy/laptop audio, German/English mixing and English-only notes, where Whisper-turbo is clearly ahead and has the
fewest catastrophic clips.

## Invented text on noise-only clips

| engine | clips with text (of 6) | what it wrote |
|---|---:|---|
| Whisper-turbo · mlx-whisper, auto (today) | **6** | "Thank you." ×6 |
| Whisper-turbo · mlx-whisper, `de` (today's config) | **6** | "Vielen Dank." ×6 |
| Whisper-turbo · transcribe.cpp, auto | 0 | — |
| Whisper-turbo · transcribe.cpp, `de` hint | 4 | "Vielen Dank.", "Untertitelung des ZDF, 2020" |
| Parakeet v3 · transcribe.cpp | 0 | — |
| Qwen3-ASR 1.7B · transcribe.cpp, auto | 0 | — |
| Qwen3-ASR 1.7B · transcribe.cpp, `de` hint | **6** | "Ich bin nicht sicher, ob ich das richtig …", "Ich bin der Meinung," |
| Qwen3-ASR 0.6B · transcribe.cpp, `de` hint | 3 | "Die." (and one run-away output) |

Keep the app's RMS silence gate as the first line of defence; auto-detect is the second.

## Speed and memory — Mac (Metal)

Calm machine (load average 5–10), 32-clip sample (3–10 s), each engine twice in mirrored order; warm latency per
note with the model resident:

| engine · runtime | median | p90 | max | load | first call | peak RSS | MLX peak | model on disk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Parakeet v3 · transcribe.cpp Q8 | 0.07 s | 0.11 s | 0.16 s | 0.3 s | 0.17 s | 1.0 GB | – | 740 MB |
| Parakeet v3 · parakeet-mlx | 0.15 s | 0.21 s | 0.25 s | 0.6 s | 0.44 s | 1.6 GB | 3.1 GB | 2.5 GB |
| Qwen3-ASR 0.6B · transcribe.cpp Q8 | 0.18 s | 0.33 s | 0.45 s | 0.5 s | 0.23 s | 1.6 GB | – | 850 MB |
| Qwen3-ASR 1.7B · transcribe.cpp Q8 | 0.26 s | 0.50 s | 0.64 s | 1.1 s | 0.32 s | 3.6 GB | – | 2.2 GB |
| Qwen3-ASR 1.7B · mlx-audio 8bit | 0.31 s | 0.54 s | 0.82 s | 2.1 s | 0.66 s | 2.7 GB | 3.6 GB | 2.5 GB |
| **Whisper-turbo · transcribe.cpp Q8** | **0.49 s** | 0.53 s | 0.60 s | 0.4 s | 0.53 s | 1.3 GB | – | 886 MB |
| Whisper-turbo · mlx-whisper (today) | 0.74 s | 0.80 s | 0.85 s | 1.3 s | 0.92 s | 1.8 GB | 2.5 GB | 1.6 GB |

ARK-ASR-3B via CrispASR's server measured 1.29 s median under heavy load (4.8 GB RSS); not re-measured once rejected.
Load times above are with the file in the page cache; the first load on a machine took 26–28 s (Metal kernel
compilation + cold read).

## Speed and memory — server, CPU only

`node:24-slim` (Linux arm64) with `--cpus 4 --memory 6g`, transcribe.cpp's Linux prebuilt, 32-clip sample.
"CPU s per audio s" is load-independent: divide by the cores you give it for an idle-machine estimate.

| engine | median | p90 | CPU s per clip | CPU s per audio s | peak RSS | WER on the sample |
|---|---:|---:|---:|---:|---:|---:|
| **Parakeet v3 · Q8** | **0.35 s** | 0.54 s | 1.4 | 0.27 | 1.3 GB | 10.7 |
| Qwen3-ASR 0.6B · Q8 | 0.81 s | 1.18 s | 3.2 | 0.63 | 1.6 GB | 21.1 |
| Qwen3-ASR 1.7B · Q8 | 1.59 s | 2.37 s | 6.3 | 1.29 | 3.4 GB | 13.6 |
| Whisper-turbo · Q8 | 10.35 s | 10.79 s | 41.0 | 7.61 | 1.1 GB | 11.0 |

Same 4 threads on the Mac's CPU, to compare runtimes: Whisper-turbo 6.88 s (transcribe.cpp) vs 6.65 s
(faster-whisper int8) — Whisper is slow on CPU in any runtime; Parakeet 0.24 s (transcribe.cpp Q8, 10.7 % WER) vs
0.16 s (onnx-asr int8, 26.8 % WER — the int8 ONNX export falls apart in noise).

The Linux **x86-64** prebuilt (`@transcribe-cpp/linux-x64-cpu-vulkan`) installs and produces the same transcripts
(checked under emulation); its speed on real x86 hardware is still to be measured on the target server.

## Integration notes (for the app)

**Install**: `transcribe-cpp@^0.2.4` as an optional dependency. npm picks `@transcribe-cpp/<platform>` (macOS arm64
5 MB, Linux x64 63 MB); no install scripts are needed (npm ≥ 11 warns about blocked scripts — harmless here).
Node ≥ 22. License MIT (ggml MIT, miniz MIT).

**Models** — download on first use into `CACHE/models/` with a size + SHA-256 check, show progress, allow a local
path override for offline installs:

| preset | file | size | license |
|---|---|---:|---|
| `whisper-turbo` | `https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf/resolve/main/whisper-large-v3-turbo-Q8_0.gguf` | 886 MB | Apache-2.0 (weights MIT upstream) |
| `parakeet-v3` | `https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/main/parakeet-tdt-0.6b-v3-Q8_0.gguf` | 740 MB | CC-BY-4.0 (credit NVIDIA in the about/licenses page) |
| `qwen3-asr-1.7b` | `https://huggingface.co/handy-computer/Qwen3-ASR-1.7B-gguf/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf` | 2.2 GB | Apache-2.0 |

**Warm worker** — a small child process (`child_process.fork`) owns one `TranscribeModel` + one session; the server
talks to it over IPC. A native crash then restarts the worker instead of the server, and memory (1–3.6 GB) is
returned when the worker exits after `idle_unload_minutes` (default 30). The library allows one compute per model at
a time — queue requests in the worker. Pre-load at server start (in the background) so nobody waits for the
first-load compile.

```js
// worker: load once, then answer {id, pcm} messages
import os from 'node:os';
import { TranscribeModel, getAvailableBackends } from 'transcribe-cpp';

const gpu = getAvailableBackends().some((d) => d.deviceType === 'gpu');   // model: 'auto'
const modelPath = gpu ? models['whisper-turbo'] : models['parakeet-v3'];
const model = await TranscribeModel.load(modelPath);                      // backend "auto": Metal / Vulkan / CPU
const session = model.createSession({ nThreads: Math.min(4, os.availableParallelism()) });
const r = await session.run(pcm);                                          // Float32Array, 16 kHz mono
// r.text, r.language ('' for Parakeet)
```

Audio in: decode the browser recording with ffmpeg straight to PCM —
`ffmpeg -v error -i note.webm -ac 1 -ar 16000 -f f32le pipe:1` → `new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)`.

**Language**: config `languages: ["de", "en"]` (reviewer speaks these; first = fallback). Run without a language; if
`r.language` is non-empty and not in the list, re-run once with `{ language: languages[0] }`.

**Vocabulary** (optional, Whisper only in this binding: `family: { kind: 'whisper', initialPrompt }`): comma-joined
terms from the tag list and `qa-dictionary.txt`, with the collapse guard described above. Qwen3-ASR hotwords exist in
mlx-audio but not in transcribe.cpp's binding.

**OpenAI-compatible backend**: `stt: { backend: 'http', url, api_key, model, language? }` → multipart POST of the
recording to `{url}/v1/audio/transcriptions` with `response_format=json`, read `text` (and `language` when present).
Servers differ in which fields they honour (CrispASR ignored a per-request `language` for ARK), so keep the request
minimal and apply the language/garbage guards client-side too.

**Remove** the Python/MLX path (`.venv`, `mlx-whisper`, the `whisper_python` config) once the transcribe.cpp worker
is in; migrate `whisper_language` to `languages: [<old value>, 'en']`.

## Renders that open on music: invented credits and collapsed windows

Measured 2026-10-01, same Mac (Metal), transcribe.cpp 0.2.4, Whisper large-v3-turbo Q8 and Parakeet v3 Q8.

**The failure.** A real Swedish ad (84 s, about 8 s of music before the voice) came back with one first line,
"Svensktextning.nu" over 0.00–29.98 s, and the next line at 30.00: every word said from 8 to 30 s was lost (forcing
Swedish did the same). Whisper hears a file in 30-second windows and wants each window's first line within its first
second (whisper.cpp's `max_initial_timestamp`); a window that opens on music sometimes answers with a subtitle credit
it learned from web captions, or a word or two, stretched to the window's end.

**Synthetic reproduction** — `make_music_intro.py`: the same short ad in sv/de/en (macOS voices) after 8 s of a numpy
bed, in five mixes. One Whisper pass collapses the first window of 3 of the 15 clips every time (`sv_sung-phone` into
"Svensktextning.nu", `de_reverb` and `de_sung-phone` into one or two words over 0.00–29.98) and of `de_sung-reverb`
on some runs only: **the first pass is partly luck** — in one warm session the same clip heard four times collapsed
once; with a fixed `seed` it collapsed every time (Whisper's temperature fallback samples, and the session's random
state carries over between calls).

What does and doesn't bring a collapsed window back (that window alone, words heard):

| clip | default | `max_initial_timestamp` 10 / 30 | temperature 0.2 + fallback | no previous-text conditioning | `no_speech_thold` 1 | `logprob_thold` −0.5 | cut from 7.5 s (voice at 8 s) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `de_reverb` | 2 | 63 / 60 | 58 | 2 | 2 | 3 | 58 |
| `de_sung-phone` | 4 | 1 / 1 | 5 | 6 | 9 | 4 | 63 |
| `sv_sung-phone` | 1 (the credit) | 1 / 1 | 1 | 1 | 1 | 1 | 55 |

Decoding options rescue some windows and not others; **a cut that opens on the speech is heard every time.** Raising
`max_initial_timestamp` for every first pass (43 exploratory clips) fixed one collapse and moved first lines from 0.00
to where the voice starts, but made one clip with a loud bed worse (13 → 36 % WER) — so it is used only to hear a stretch again.
Parakeet (no 30-second windows) finds the voice's onset within 0.1–0.2 s even where its own words are poor, but it can
also hear nothing at all (`sv_sung-phone`: 0 words in the whole clip).

**The repair** (`lib/stt/collapse.ts`, `docs/speech.md`): drop known invented lines; find stretches ≥ 5 s under 0.5
words/s; with Parakeet on disk, let it locate the speech and hear Whisper again from 0.5 s before its first word (or use
its words); without it — or when it hears nothing under a credit — Whisper again with a late first line, then from
4, 8, … s into the window, the earliest start that is plainly speech. `run_collapse.ts --repeat 3`, means per round:

| mode | mean WER | clips > 50 % wrong | credits left | words in the first 30 s | time for 15 clips |
|---|---:|---:|---:|---:|---:|
| before (one pass, as until now) | 25.2 % | 3.7 | 1 | 736 | 20.2 s |
| repair, Whisper alone | 15.3 % | 2.0 | 0 | 926 | 24.2 s |
| repair, Parakeet as second listener | **13.6 %** | **1.0** | 0 | 927 | 23.2 s |

| subset | words in the first 30 s (before → alone / second) | mean WER | median time per clip |
|---|---:|---:|---:|
| 3 clips that always collapse | 6 → 162 / 169 | 82.8 → 44.7 / 37.5 % | 1.08 → 2.48 / 2.30 s |
| 12 controls (incl. `de_sung-reverb`, collapsed on 2 of 3 runs before) | 730 → 764 / 758 | 10.8 → 7.9 / 7.6 % | 1.27 → 1.29 / 1.32 s |

The repaired clips stay worse than the controls because their audio is hard throughout (a roomy, band-limited voice
under a sung line): what is heard after 30 s is no better. Controls cost nothing measurable — a normal music intro
(Whisper's first line pulled back to 0.00 at ~0.65 words/s) is not a suspect stretch.

**The real ad** (counts only): before, 2 tokens (the credit) in 0–30 s and 72 words in all, 2.3 s; repaired with
Whisper alone, 24 words in 0–30 s (the first at 7.9 s) and 94 in all, 4.1 s — the first try with a late first line
was enough; with Parakeet as the second listener the same 24 / 94 words, 3.3 s. Parakeet alone hears 23 words in that
stretch, its first at 8.24 s; the repaired words share 21 of them.

## Caveats

- Real speech is 36 clips from 4 episodes of one German channel (few speakers, studio microphones); caption
  references were probably corrected ASR output and may favour the engine that produced the first draft. Clips whose
  word timings did not match the export were dropped (one episode).
- Synthetic notes are TTS: clean, but German voices pronounce English terms the German way, which makes the mixed
  subset harder than real bilingual speakers. Engines that saw little synthetic speech in training (Qwen3-ASR,
  Parakeet) may be penalised more than on real voices; the noisy/laptop conditions are the part of that subset that
  transfers best.
- Accuracy runs overlapped with heavy unrelated load on the same machine (load average up to ~270); that affects
  their latencies (not reported from them) but not the transcripts. The latency tables come from the separate calm
  pass and the containers.
- CPU numbers come from Apple M1 Max cores and a Linux arm64 VM on them; an x86 server (AVX2/AVX-512) will differ,
  most likely by less than the 30× gap between Parakeet and Whisper on CPU. Hetzner's arm64 CAX servers are closest
  to the container setup.
- 126 speech clips / 1,775 words: differences below ~2 WER points between engines are noise.
