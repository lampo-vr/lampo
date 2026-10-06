"""Run one engine over the manifest in a single process: load the model once, warm it up, then transcribe every clip.

That is how the app should run speech-to-text too (a persistent worker), so warm latency is the number that matters
for a walkie-talkie note; the load time is paid once per server start.

Usage:
  python run.py --engine NAME --manifest manifest.jsonl --out results/NAME.jsonl [--vocab vocab.txt] [--threads 4]

Writes one JSON line per clip ({"id", "hyp", "sec", "cpu"}) and a final {"meta": …} line with load time and memory.
transcribe.cpp runs through run_node.mjs (its Node binding), servers through run_http.py.
"""

import argparse
import json
import os
import resource
import sys
import time
from pathlib import Path

T_START = time.perf_counter()
HERE = Path(__file__).parent
WHISPER_MLX = os.environ.get("WHISPER_MLX_MODEL", "mlx-community/whisper-large-v3-turbo")


def peak_rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1e6 if sys.platform == "darwin" else r / 1e3  # bytes on macOS, KiB on Linux


def mlx_peak_mb() -> float | None:
    try:
        import mlx.core as mx

        fn = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
        return fn() / 1e6
    except Exception:
        return None


# ---------------------------------------------------------------- engines: each returns transcribe(path) -> str


def whisper_mlx(opts):
    import mlx.core as mx
    import mlx_whisper
    from mlx_whisper.transcribe import ModelHolder

    ModelHolder.get_model(opts.model or WHISPER_MLX, mx.float16)
    prompt = ", ".join(opts.vocab) if opts.vocab else None

    def run(path):
        r = mlx_whisper.transcribe(
            path, path_or_hf_repo=opts.model or WHISPER_MLX, language=opts.language, initial_prompt=prompt,
            condition_on_previous_text=False, verbose=None,
        )
        return r["text"]

    return run


def parakeet_mlx(opts):
    from parakeet_mlx import from_pretrained

    model = from_pretrained(opts.model or "mlx-community/parakeet-tdt-0.6b-v3")
    return lambda path: model.transcribe(path).text


def mlx_audio(opts):
    from mlx_audio.stt.utils import load

    model = load(opts.model)

    def run(path):
        out = model.generate(path, language=opts.language, hotwords=opts.vocab or None, verbose=False)
        return out.text

    return run


def faster_whisper(opts):
    from faster_whisper import WhisperModel

    model = WhisperModel(opts.model or "large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=opts.threads)
    prompt = ", ".join(opts.vocab) if opts.vocab else None

    def run(path):
        segs, _ = model.transcribe(path, language=opts.language, initial_prompt=prompt, beam_size=5,
                                   condition_on_previous_text=False, vad_filter=False)
        return " ".join(s.text for s in segs)

    return run


def onnx_asr(opts):
    import onnx_asr as oa
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = opts.threads
    so.inter_op_num_threads = 1
    model = oa.load_model(opts.model or "nemo-parakeet-tdt-0.6b-v3", quantization=opts.quant or "int8",
                          sess_options=so, providers=["CPUExecutionProvider"])
    return lambda path: model.recognize(path)


ENGINES = {
    "whisper-mlx": whisper_mlx,
    "parakeet-mlx": parakeet_mlx,
    "mlx-audio": mlx_audio,
    "faster-whisper": faster_whisper,
    "onnx-asr": onnx_asr,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=ENGINES)
    ap.add_argument("--name", help="label for the results (default: engine)")
    ap.add_argument("--model")
    ap.add_argument("--quant")
    ap.add_argument("--language", default=None, help="force a language; default: auto-detect")
    ap.add_argument("--vocab", help="file with one hotword per line (biases rare terms, if the engine supports it)")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="comma-separated subset prefixes to run")
    opts = ap.parse_args()
    opts.vocab = [l.strip() for l in open(opts.vocab, encoding="utf-8") if l.strip()] if opts.vocab else []

    clips = [json.loads(l) for l in open(opts.manifest, encoding="utf-8")]
    if opts.only:
        prefixes = tuple(opts.only.split(","))
        clips = [c for c in clips if c["subset"].startswith(prefixes)]

    t_load = time.perf_counter()
    run = ENGINES[opts.engine](opts)
    load_s = time.perf_counter() - t_load
    t = time.perf_counter()
    run(clips[0]["path"])  # warm-up (kernels compiled, caches filled) — not scored
    warm_s = time.perf_counter() - t

    Path(opts.out).parent.mkdir(parents=True, exist_ok=True)
    with open(opts.out, "w", encoding="utf-8") as fh:
        for c in clips:
            t = time.perf_counter()
            cpu0 = time.process_time()  # all threads of this process: contention-proof cost
            try:
                hyp = run(c["path"])
            except Exception as e:  # an engine crash on one clip is a result, not a reason to stop
                hyp = f"<error {type(e).__name__}: {e}>"
            row = {"id": c["id"], "hyp": (hyp or "").strip(), "sec": round(time.perf_counter() - t, 4),
                   "cpu": round(time.process_time() - cpu0, 4)}
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
        meta = {
            "engine": opts.name or opts.engine, "model": opts.model, "language": opts.language,
            "vocab": bool(opts.vocab), "threads": opts.threads,
            "startup_s": round(t_load - T_START, 2), "load_s": round(load_s, 2), "first_call_s": round(warm_s, 2),
            "peak_rss_mb": round(peak_rss_mb()), "mlx_peak_mb": round(mlx_peak_mb() or 0) or None,
        }
        fh.write(json.dumps({"meta": meta}) + "\n")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
