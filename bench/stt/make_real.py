"""Real-speech clips cut from rendered videos that come with word timings (caption tracks).

Each source is {"video": path, "words": path, "format": "timeline"|"words", "tag": "music"|"clean"}:
  timeline – Remotion-style timeline.json: {"fps": 30, "words": [{"t": "Wort", "s": frames, "e": frames, "cut": bool}]}
  words    – words.json: [{"w": "wort", "s": seconds, "e": seconds}]
Clips are 4–10 s, start and end in the silence between words (never inside a neighbouring word), and the reference
is the caption text of exactly those words. Caption tracks are often ASR output that someone corrected, so treat
these references as good but not perfect — and possibly biased towards the engine that produced the first draft.

Usage: python make_real.py sources.json <out_dir> [clips_per_video=6]
"""

import json
import subprocess
import sys
from pathlib import Path

TARGETS = [6, 9, 5, 8, 10, 4, 7]  # seconds, cycled, so clip lengths vary like real notes
MAX_GAP = 0.9  # a longer pause ends a clip: a note is one breath, not two sentences with a gap


def load_words(src: dict) -> list[dict]:
    data = json.load(open(src["words"], encoding="utf-8"))
    if src["format"] == "timeline":
        fps = data.get("fps", 30)
        return [{"w": w["t"], "s": w["s"] / fps, "e": w["e"] / fps} for w in data["words"] if not w.get("cut")]
    items = data if isinstance(data, list) else data["words"]
    return [{"w": w.get("w") or w.get("t"), "s": w["s"], "e": w["e"]} for w in items]


def groups(words: list[dict]) -> list[tuple[int, int]]:
    out, i, k = [], 0, 0
    while i < len(words):
        target = TARGETS[k % len(TARGETS)]
        j = i
        while j + 1 < len(words) and words[j + 1]["s"] - words[j]["e"] < MAX_GAP and words[j]["e"] - words[i]["s"] < target:
            j += 1
        if words[j]["e"] - words[i]["s"] >= 3:
            out.append((i, j))
            k += 1
        i = j + 1
    return out


def main(sources: Path, out_dir: Path, per_video: int) -> None:
    dest = out_dir / "real"
    dest.mkdir(parents=True, exist_ok=True)
    manifest = []
    for n, src in enumerate(json.load(open(sources, encoding="utf-8"))):
        words = sorted(load_words(src), key=lambda w: w["s"])
        cand = groups(words)
        step = max(1, len(cand) // per_video)
        for c, (i, j) in enumerate(cand[::step][:per_video]):
            start = max(words[i]["s"] - 0.12, words[i - 1]["e"] + 0.02 if i else 0)
            end = min(words[j]["e"] + 0.2, words[j + 1]["s"] - 0.02 if j + 1 < len(words) else words[j]["e"] + 0.2)
            cid = f"r{n:02d}_{c:02d}"
            path = dest / f"{cid}.wav"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", src["video"],
                 "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(path)],
                check=True,
            )
            manifest.append({
                "id": cid,
                "subset": f"real-de-{src.get('tag', 'clean')}",
                "lang": "de",
                "cond": src.get("tag", "clean"),
                "path": str(path),
                "ref": " ".join(w["w"] for w in words[i : j + 1]),
                "dur": round(end - start, 2),
            })
    with open(out_dir / "manifest.jsonl", "a", encoding="utf-8") as fh:
        for m in manifest:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"{len(manifest)} real clips → {dest}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 6)
