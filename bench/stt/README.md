# Speech-to-text benchmark

Which engine should turn a walkie-talkie voice note ("Die Bauchbinde steht zu lange…") into text — on a Mac, and on
a server without a GPU? Results and the recommendation: [RESULTS.md](RESULTS.md).

## Layout

| file | what it does |
|---|---|
| `notes.tsv` | 30 review notes with exact text: 16 German, 6 German/English mix, 8 English, each with a macOS voice |
| `vocab.txt` | domain terms for the hotword / initial-prompt runs |
| `make_synthetic.py` | renders the notes with `say` in three conditions (clean, pink noise at 15 dB SNR, 300–3400 Hz laptop mic + noise); `--silence` renders six noise-only clips |
| `make_real.py` | cuts 4–10 s clips from rendered videos that ship caption word timings (`timeline.json` / `words.json`) — bring your own sources, see `real_sources.example.json` |
| `run.py` | Python engines in one process (model loaded once, warm-up discarded): mlx-whisper, parakeet-mlx, mlx-audio (Qwen3-ASR), faster-whisper, onnx-asr |
| `run_node.mjs` | transcribe.cpp through its Node binding (npm `transcribe-cpp`) — the in-process path the app uses |
| `run_http.py` | any OpenAI-compatible `/v1/audio/transcriptions` server (CrispASR, whisper.cpp server, vLLM, hosted APIs) |
| `docker_cpu.sh` | `run_node.mjs` inside `node:24-slim`, capped at 4 CPUs / 6 GB — the self-hosted server case |
| `score.py` | corpus WER/CER per subset, catastrophic clips, latency, CPU cost, memory; `--fallback` scores the "auto-detect, re-run with the reviewer's language only if needed" strategy |
| `make_music_intro.py` | 15 synthetic ads that open on 8 s of music (numpy chords, beat and a sung-like line; `say` voices in sv/de/en, clean to roomy and band-limited) — some make Whisper's first window collapse into an invented credit |
| `run_collapse.ts` | a render's transcript through the app's own code, before and after the collapse repair (Whisper alone, and with Parakeet as the second listener): WER, words in the first 30 s, credits left, time; `--repeat` because Whisper's fallback samples |

Every runner writes one JSON line per clip (`id`, `hyp`, `sec`, `cpu`, optionally `lang`) and a final `{"meta": …}`
line, so results from different runtimes score the same way.

## Reproduce

```bash
python3 -m venv .venv-stt && .venv-stt/bin/pip install numpy soundfile jiwer num2words psutil \
    parakeet-mlx mlx-audio faster-whisper "onnx-asr[cpu,hub]"      # MLX packages: Apple Silicon only
npm install --prefix /tmp/tc transcribe-cpp@0.2.4                  # prebuilt natives, no compiler needed

D=/tmp/stt; mkdir -p $D
.venv-stt/bin/python make_synthetic.py $D && .venv-stt/bin/python make_synthetic.py $D --silence
.venv-stt/bin/python make_real.py my_sources.json $D 6            # optional, needs videos with word timings

node run_node.mjs --module /tmp/tc/node_modules/transcribe-cpp --model whisper-large-v3-turbo-Q8_0.gguf \
     --manifest $D/manifest.jsonl --out $D/results/whisper.jsonl --name "whisper-turbo · metal"
.venv-stt/bin/python score.py $D/manifest.jsonl $D/results/*.jsonl
```

Renders that open on music (the collapse repair, `lib/stt/collapse.ts`) — numpy only, plus macOS `say` and ffmpeg:

```bash
python3 make_music_intro.py $D                       # → $D/music-intro/*.wav, $D/music-intro.jsonl
node run_collapse.ts --manifest $D/music-intro.jsonl --models <dir with both .gguf files> --repeat 3
```

GGUF models: `huggingface.co/handy-computer/{whisper-large-v3-turbo,parakeet-tdt-0.6b-v3,Qwen3-ASR-1.7B,Qwen3-ASR-0.6B}-gguf`
(`*-Q8_0.gguf`). Keep audio from your own projects out of the repository — the harness only needs paths.
