"""Score result files against the manifest: corpus WER/CER per subset group, latency, memory → markdown tables.

Normalisation (applied to reference and hypothesis alike): lowercase, ß→ss, hyphens and slashes become spaces,
punctuation removed, digits spelled out in the clip's language ("12" → "zwölf"), whitespace collapsed. Compound
spelling ("Color Grading" vs "Colorgrading") is NOT normalised away — it is a real difference in the note text,
and CER shows how close such a miss is.

Usage: python score.py manifest.jsonl results/*.jsonl [--json summary.json]
       [--fallback LABEL AUTO.jsonl HINT.jsonl de,en]   (repeatable)

--fallback scores the "restricted auto-detect" strategy offline: take the auto-detect result when the detected
language is one the reviewer speaks, else the result of the language-hinted run of the same clip (a real
implementation re-runs only those clips, so its latency is auto + hint for them).
"""

import json
import re
import statistics
import sys
from pathlib import Path

import jiwer
from num2words import num2words

GROUPS = {
    "de clean": ("synthetic-de-clean",),
    "de noisy/laptop": ("synthetic-de-noisy", "synthetic-de-laptop"),
    "mixed de/en": ("synthetic-mixed-",),
    "en": ("synthetic-en-",),
    "real de": ("real-de-clean",),
    "real de + music": ("real-de-music",),
}


def normalize(text: str, lang: str) -> str:
    t = text.lower().replace("ß", "ss")
    t = re.sub(r"[-‐–—/]", " ", t)
    t = re.sub(r"[^\w\s]", " ", t)
    words = []
    for w in t.split():
        if w.isdigit():
            try:
                w = num2words(int(w), lang="en" if lang == "en" else "de").replace("-", " ")
            except Exception:
                pass
        words.append(w)
    return " ".join(words)


def load(path: Path) -> tuple[dict, dict]:
    rows, meta = {}, {}
    for line in open(path, encoding="utf-8"):
        d = json.loads(line)
        if "meta" in d:
            meta = d["meta"]
        else:
            rows[d["id"]] = d
    return rows, meta


def pct(x: float) -> str:
    return f"{100 * x:.1f}"


def fallback(label: str, auto_file: str, hint_file: str, langs: str) -> tuple[dict, dict]:
    auto, meta = load(Path(auto_file))
    hint, _ = load(Path(hint_file))
    allowed = set(langs.split(","))
    rows = {}
    for i, a in auto.items():
        ok = a.get("lang", "")[:2] in allowed
        h = hint[i]
        rows[i] = a if ok else {**h, "sec": a["sec"] + h["sec"], "cpu": a.get("cpu", 0) + h.get("cpu", 0)}
    return rows, {**meta, "engine": label, "fallbacks": sum(1 for i in auto if auto[i].get("lang", "")[:2] not in allowed)}


def main() -> None:
    argv = sys.argv[1:]
    json_out = None
    runs = []
    while "--fallback" in argv:
        k = argv.index("--fallback")
        runs.append(fallback(*argv[k + 1 : k + 5]))
        del argv[k : k + 5]
    if "--json" in argv:
        k = argv.index("--json")
        json_out = argv[k + 1]
        del argv[k : k + 2]
    manifest = {c["id"]: c for c in (json.loads(l) for l in open(argv[0], encoding="utf-8"))}
    runs = [load(Path(f)) for f in argv[1:]] + runs
    summary = []
    for rows, meta in runs:
        name = meta.get("engine")
        res = {"engine": name, "meta": meta, "groups": {}}
        for g, prefixes in GROUPS.items():
            ids = [i for i, c in manifest.items() if c["subset"].startswith(prefixes) and i in rows]
            if not ids:
                continue
            refs = [normalize(manifest[i]["ref"], manifest[i]["lang"]) for i in ids]
            hyps = [normalize(rows[i]["hyp"], manifest[i]["lang"]) for i in ids]
            hyps = [h if h else "∅" for h in hyps]
            res["groups"][g] = {"wer": jiwer.wer(refs, hyps), "cer": jiwer.cer(refs, hyps), "n": len(ids)}
        secs = [rows[i]["sec"] for i in rows]
        durs = [manifest[i]["dur"] for i in rows]
        res["lat_median"] = statistics.median(secs)
        res["lat_p90"] = sorted(secs)[int(0.9 * (len(secs) - 1))]
        res["rtf"] = sum(secs) / sum(durs)
        cpus = [rows[i]["cpu"] for i in rows if "cpu" in rows[i]]
        res["cpu_median"] = statistics.median(cpus) if cpus else None
        res["cpu_rtf"] = sum(cpus) / sum(durs) if cpus else None
        speech = [i for i in rows if i in manifest and manifest[i]["ref"]]
        silent = [i for i in rows if i in manifest and not manifest[i]["ref"]]
        res["errors"] = sum(1 for i in rows if rows[i]["hyp"].startswith("<error"))
        res["false_text"] = [rows[i]["hyp"] for i in silent if normalize(rows[i]["hyp"], "de")]
        res["n_silent"] = len(silent)
        if speech:
            allrefs = [normalize(manifest[i]["ref"], manifest[i]["lang"]) for i in speech]
            allhyps = [normalize(rows[i]["hyp"], manifest[i]["lang"]) or "∅" for i in speech]
            res["wer_all"] = jiwer.wer(allrefs, allhyps)
            # A clip that is more than half wrong is a note the reviewer has to re-record or retype.
            res["catastrophic"] = sum(1 for r, h in zip(allrefs, allhyps) if jiwer.wer(r, h) > 0.5)
            res["n_speech"] = len(speech)
        summary.append(res)
    if not any(s.get("n_speech") for s in summary):
        print("| engine | noise-only clips with invented text | what it wrote |")
        print("|---|---:|---|")
        for s in summary:
            said = "; ".join(f"“{t[:40]}”" for t in s["false_text"][:3]) or "—"
            print(f"| {s['engine']} | {len(s['false_text'])} / {s['n_silent']} | {said} |")
        if json_out:
            json.dump(summary, open(json_out, "w"), indent=1)
        return

    groups = [g for g in GROUPS if any(g in s["groups"] for s in summary)]
    print("| engine | " + " | ".join(groups) + " | all | clips > 50 % wrong |")
    print("|---|" + "---:|" * (len(groups) + 2))
    for s in summary:
        cells = [f"{pct(s['groups'][g]['wer'])} / {pct(s['groups'][g]['cer'])}" if g in s["groups"] else "–" for g in groups]
        print(f"| {s['engine']} | " + " | ".join(cells) + f" | **{pct(s['wer_all'])}** | {s['catastrophic']} / {s['n_speech']} |")
    print()
    print("| engine | warm latency median / p90 (s) | RTF | CPU s per clip (median) | CPU s per audio s | load (s) | "
          "peak RSS (MB) | MLX peak (MB) | errors |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for s in summary:
        m = s["meta"]
        cpu = f"{s['cpu_median']:.2f}" if s["cpu_median"] is not None else "–"
        cpu_rtf = f"{s['cpu_rtf']:.3f}" if s["cpu_rtf"] is not None else "–"
        fb = f" ({m['fallbacks']} re-runs)" if "fallbacks" in m else ""
        print(f"| {s['engine']}{fb} | {s['lat_median']:.2f} / {s['lat_p90']:.2f} | {s['rtf']:.3f} | {cpu} | {cpu_rtf} | "
              f"{m.get('load_s', '–')} | {m.get('peak_rss_mb', '–')} | {m.get('mlx_peak_mb') or '–'} | {s['errors']} |")
    if json_out:
        json.dump(summary, open(json_out, "w"), indent=1)


if __name__ == "__main__":
    main()
