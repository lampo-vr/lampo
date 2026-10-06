"""Synthetic review notes with exact ground truth (macOS `say`), in three acoustic conditions.

clean   – the TTS voice, 16 kHz mono, 0.4 s of silence around it (a walkie note starts and ends quiet)
noisy   – pink room noise mixed in at 15 dB SNR
laptop  – 300–3400 Hz band (cheap built-in mic) + white noise at 25 dB SNR

Usage: python make_synthetic.py <out_dir>        (writes <out_dir>/synthetic/*.wav and appends manifest.jsonl)
       python make_synthetic.py <out_dir> --silence   (noise-only clips → <out_dir>/silence.jsonl; the right answer
                                                        is no text — a walkie press without speech must not become a note)
"""

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
HERE = Path(__file__).parent


def tts(text: str, voice: str, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "a.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(aiff), "-af", "adelay=400|400,apad=pad_dur=0.4",
             "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", str(out)],
            check=True,
        )


def rms(x: np.ndarray) -> float:
    voiced = x[np.abs(x) > 1e-4]
    return float(np.sqrt(np.mean(voiced**2))) if voiced.size else 1e-9


def pink(n: int, rng: np.random.Generator) -> np.ndarray:
    # Voss-style pink noise via 1/f shaping in the frequency domain.
    spec = rng.standard_normal(n // 2 + 1) + 1j * rng.standard_normal(n // 2 + 1)
    f = np.arange(spec.size)
    spec /= np.sqrt(np.maximum(f, 1))
    return np.fft.irfft(spec, n)


def mix(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    noise = noise / rms(noise) * rms(speech) / (10 ** (snr_db / 20))
    out = speech + noise
    return out / max(1.0, float(np.max(np.abs(out))) / 0.95)


def bandpass(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(x.size, 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, x.size)


def main(out_dir: Path) -> None:
    dest = out_dir / "synthetic"
    dest.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(open(HERE / "notes.tsv", encoding="utf-8"), delimiter="\t"))
    manifest = []
    for i, row in enumerate(rows):
        clean = dest / f"{row['id']}_clean.wav"
        tts(row["text"], row["voice"], clean)
        x, _ = sf.read(clean)
        rng = np.random.default_rng(1000 + i)
        variants = {
            "clean": x,
            "noisy": mix(x, pink(x.size, rng), 15),
            "laptop": mix(bandpass(x, 300, 3400), rng.standard_normal(x.size), 25),
        }
        for cond, audio in variants.items():
            path = dest / f"{row['id']}_{cond}.wav"
            if cond != "clean":
                sf.write(path, audio, SR, subtype="PCM_16")
            manifest.append({
                "id": f"{row['id']}_{cond}",
                "subset": f"synthetic-{row['lang']}-{cond}",
                "lang": row["lang"],
                "cond": cond,
                "path": str(path),
                "ref": row["text"],
                "dur": round(len(audio) / SR, 2),
            })
    with open(out_dir / "manifest.jsonl", "a", encoding="utf-8") as fh:
        for m in manifest:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"{len(manifest)} synthetic clips → {dest}")


def silence(out_dir: Path) -> None:
    dest = out_dir / "silence"
    dest.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    n = 3 * SR
    t = np.arange(n) / SR
    hum = sum(np.sin(2 * np.pi * 50 * k * t) / k for k in (1, 2, 3))
    clicks = np.zeros(n)
    clicks[rng.integers(0, n, 12)] = 1.0  # keyboard / mouse clicks
    clips = {
        "room-quiet": (pink(n, rng), -50),
        "room-loud": (pink(n, rng), -35),
        "laptop-fan": (bandpass(rng.standard_normal(n), 300, 3400), -40),
        "mains-hum": (hum, -38),
        "clicks": (np.convolve(clicks, np.hanning(64), "same") + 0.02 * rng.standard_normal(n), -30),
        "breath": (bandpass(rng.standard_normal(n), 200, 1200) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.4 * t)), -40),
    }
    rows = []
    for name, (x, dbfs) in clips.items():
        x = x / (np.sqrt(np.mean(x**2)) or 1) * 10 ** (dbfs / 20)
        path = dest / f"{name}.wav"
        sf.write(path, np.clip(x, -1, 1), SR, subtype="PCM_16")
        rows.append({"id": f"sil_{name}", "subset": "silence", "lang": "de", "cond": name, "path": str(path),
                     "ref": "", "dur": 3.0})
    with open(out_dir / "silence.jsonl", "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"{len(rows)} noise-only clips → {dest}")


if __name__ == "__main__":
    if "--silence" in sys.argv:
        silence(Path(sys.argv[1]))
    else:
        main(Path(sys.argv[1]))
