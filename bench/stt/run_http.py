"""Any OpenAI-compatible speech-to-text server: POST /v1/audio/transcriptions (multipart), one request per clip.

The same contract is served by CrispASR --server, whisper.cpp's server, vLLM (Qwen3-ASR), speaches, and hosted APIs,
so this runner doubles as a test of the "OpenAI-compatible backend" the app can offer for GPU boxes and clouds.
Latency here includes the HTTP round trip on localhost (~1 ms) — the model stays resident in the server.

Usage: python run_http.py --url http://127.0.0.1:8080 --manifest m.jsonl --out results/x.jsonl --name LABEL
                          [--model NAME] [--language de] [--vocab vocab.txt] [--server-pid PID]
"""

import argparse
import json
import mimetypes
import time
import urllib.request
import uuid
from pathlib import Path


def post(url: str, fields: dict, file_path: str, key: str | None) -> dict:
    boundary = uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        if v is None:
            continue
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    ctype = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{Path(file_path).name}"\r\n'
             f"Content-Type: {ctype}\r\n\r\n").encode()
    body += Path(file_path).read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=bytes(body), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                          **({"Authorization": f"Bearer {key}"} if key else {})})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def rss_mb(pid: int | None) -> int | None:
    if not pid:
        return None
    import psutil

    return round(psutil.Process(pid).memory_info().rss / 1e6)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--model", default="default")
    ap.add_argument("--language")
    ap.add_argument("--vocab")
    ap.add_argument("--key")
    ap.add_argument("--server-pid", type=int)
    opts = ap.parse_args()
    vocab = [l.strip() for l in open(opts.vocab, encoding="utf-8") if l.strip()] if opts.vocab else []
    endpoint = opts.url.rstrip("/") + "/v1/audio/transcriptions"
    fields = {"model": opts.model, "response_format": "json", "language": opts.language,
              "hotwords": ",".join(vocab) or None}
    clips = [json.loads(l) for l in open(opts.manifest, encoding="utf-8")]
    t = time.perf_counter()
    post(endpoint, fields, clips[0]["path"], opts.key)  # warm-up, not scored
    first = time.perf_counter() - t
    Path(opts.out).parent.mkdir(parents=True, exist_ok=True)
    peak = 0
    with open(opts.out, "w", encoding="utf-8") as fh:
        for c in clips:
            t = time.perf_counter()
            try:
                r = post(endpoint, fields, c["path"], opts.key)
                hyp, lang = r.get("text", ""), r.get("language", "")
            except Exception as e:
                hyp, lang = f"<error {type(e).__name__}: {e}>", ""
            fh.write(json.dumps({"id": c["id"], "hyp": hyp.strip(), "sec": round(time.perf_counter() - t, 4),
                                 "lang": lang}, ensure_ascii=False) + "\n")
            peak = max(peak, rss_mb(opts.server_pid) or 0)
        meta = {"engine": opts.name, "model": opts.model, "language": opts.language, "vocab": bool(vocab),
                "first_call_s": round(first, 2), "peak_rss_mb": peak or None, "mlx_peak_mb": None}
        fh.write(json.dumps({"meta": meta}) + "\n")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
