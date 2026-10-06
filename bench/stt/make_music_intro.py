"""Synthetic ads that open on music: a beat-and-chords bed (optionally with a sung-like line) for 8 s, then a TTS voice
over it. Whisper hears a file in 30-second windows; a window that opens on music sometimes collapses into an invented
line ("Svensktextning.nu", "Die Sendung wurde vom NDR live untertitelt.") stretched to 29.98 s, and the speech in it
is lost. Some of these clips do that; the rest are controls that must not get worse. Scored by run_collapse.ts.

Everything here is generated: macOS `say` voices and numpy tones, no recordings.

Usage: python make_music_intro.py <out_dir>      (writes <out_dir>/music-intro/*.wav and music-intro.jsonl)
"""

import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 16000
INTRO = 8.0

# The same little ad in three languages (a bakery; nobody's words).
TEXTS = {
    "sv": ("Alva", "Välkommen till vårt lilla bageri vid torget. Varje morgon bakar vi bröd, bullar och kakor med mjöl från "
           "gårdar i närheten. Kanelbullarna är färdiga klockan sju, och kaffet är alltid varmt. På lördagar har vi öppet "
           "längre, och barnen får smaka gratis. Vi har också glutenfritt bröd och goda smörgåsar till lunch. Beställ "
           "gärna en tårta till födelsedagen, så hjälper vi dig med dekorationen. Kom förbi och säg hej, vi ses snart."),
    "de": ("Anna", "Willkommen in unserer kleinen Bäckerei am Marktplatz. Jeden Morgen backen wir Brot, Brötchen und Kuchen "
           "mit Mehl von Höfen aus der Nähe. Die Zimtschnecken sind um sieben Uhr fertig, und der Kaffee ist immer heiß. "
           "Am Samstag haben wir länger geöffnet, und die Kinder dürfen kostenlos probieren. Wir haben auch glutenfreies "
           "Brot und belegte Brote zum Mittag. Bestellen Sie gern eine Torte zum Geburtstag, wir helfen Ihnen bei der "
           "Dekoration. Kommen Sie vorbei und sagen Sie hallo, bis bald."),
    "en": ("Samantha", "Welcome to our little bakery on the square. Every morning we bake bread, buns and cakes with flour "
           "from farms nearby. The cinnamon buns are ready at seven, and the coffee is always hot. On Saturdays we stay "
           "open longer, and the children taste for free. We also have gluten free bread and good sandwiches for lunch. "
           "Order a cake for the birthday, and we will help you with the decoration. Come by and say hello, see you soon."),
}

# (name, sung line in the bed, bed level under the voice in dB vs the intro, voice effect)
CONDITIONS = [
    ("clean", False, -14, "none"),      # a voice-over on a quiet bed: the everyday case, must not change
    ("loud", False, 0, "none"),         # bed as loud under the voice as before it
    ("reverb", False, 6, "reverb"),     # a roomy voice in a loud mix
    ("sung-reverb", True, 6, "reverb"),
    ("sung-phone", True, 3, "reverb+band"),  # a roomy, band-limited voice under a sung line
]


def tts(text: str, voice: str) -> np.ndarray:
    with tempfile.TemporaryDirectory() as tmp:
        aiff, raw = Path(tmp) / "a.aiff", Path(tmp) / "a.raw"
        subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(aiff), "-ar", str(SR), "-ac", "1", "-f", "f32le", str(raw)], check=True)
        return np.fromfile(raw, dtype=np.float32).astype(np.float64)


def rms(x: np.ndarray) -> float:
    voiced = x[np.abs(x) > 1e-4]
    return float(np.sqrt(np.mean(voiced**2))) if voiced.size else 1e-9


def bed(seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Am–F–C–G, two seconds a chord, with a bass, a kick on every beat and a hat between (120 bpm)."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    chords = [[220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [261.63, 329.63, 392.0], [196.0, 246.94, 293.66]]
    for i in range(int(np.ceil(seconds / 2))):
        a, b = int(i * 2 * SR), min(n, int((i + 1) * 2 * SR))
        tt = t[a:b] - i * 2
        env = np.minimum(1, tt / 0.05) * np.exp(-tt * 0.6)
        for f in chords[i % 4]:
            for h, g in ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.15)):
                out[a:b] += g * env * np.sin(2 * np.pi * f * h * tt + rng.uniform(0, 6.28))
        out[a:b] += 1.2 * env * np.sin(2 * np.pi * chords[i % 4][0] / 2 * tt)
    for k in range(int(seconds / 0.5)):
        a = int(k * 0.5 * SR)
        m = min(n, a + int(0.25 * SR))
        tt = t[a:m] - k * 0.5
        out[a:m] += 2.5 * np.exp(-tt * 18) * np.sin(2 * np.pi * (50 + 80 * np.exp(-tt * 30)) * tt)
        h0 = a + int(0.25 * SR)
        h1 = min(n, h0 + int(0.06 * SR))
        if h0 < n:
            out[h0:h1] += 0.6 * np.exp(-(t[h0:h1] - t[h0]) * 60) * rng.standard_normal(h1 - h0)
    return out / np.sqrt(np.mean(out**2))


def sung(seconds: float, rng: np.random.Generator) -> np.ndarray:
    """A vowel-like line (harmonics shaped by two formants, vibrato) on a pentatonic-ish tune: music with a voice in it."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    notes = [220, 247, 262, 294, 330, 294, 262, 247]
    out = np.zeros(n)
    for k in range(int(seconds / 0.5)):
        a, b = int(k * 0.5 * SR), min(n, int((k + 1) * 0.5 * SR))
        tt = t[a:b] - k * 0.5
        f = notes[rng.integers(len(notes))]
        ph = 2 * np.pi * f * np.cumsum(1 + 0.01 * np.sin(2 * np.pi * 5.5 * tt)) / SR
        form = sum((np.exp(-(((h * f) - 700) / 150) ** 2) + 0.6 * np.exp(-(((h * f) - 1200) / 200) ** 2)) * np.sin(h * ph) for h in range(1, 20))
        out[a:b] = np.minimum(1, tt / 0.04) * np.minimum(1, np.maximum(0, 0.5 - tt) / 0.04) * form
    return out / np.sqrt(np.mean(out**2))


def reverb(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    n = int(0.6 * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 7)
    ir[0] = 3
    y = np.convolve(x, ir)[: len(x)]
    return y / rms(y) * rms(x)


def band(x: np.ndarray) -> np.ndarray:
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(x.size, 1 / SR)
    spec[(f < 300) | (f > 3400)] = 0
    return np.fft.irfft(spec, x.size)


def write(path: Path, x: np.ndarray) -> None:
    x = np.clip(x / max(1.0, float(np.max(np.abs(x))) / 0.95), -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def main(out_dir: Path) -> None:
    dest = out_dir / "music-intro"
    dest.mkdir(parents=True, exist_ok=True)
    manifest = []
    for lang, (voice, text) in TEXTS.items():
        speech = tts(text, voice)
        for name, with_song, under_db, effect in CONDITIONS:
            rng = np.random.default_rng(7)
            total = INTRO + len(speech) / SR + 3
            music = bed(total, rng)
            if with_song:
                music = music + 0.8 * sung(total, rng)
                music /= rms(music)
            s0 = int(INTRO * SR)
            x = 0.15 * music
            x[s0:] *= 10 ** (under_db / 20) * 0.5
            voice_track = speech
            if "reverb" in effect:
                voice_track = reverb(voice_track, rng)
            if "band" in effect:
                voice_track = band(voice_track)
            x[s0 : s0 + len(voice_track)] += voice_track / rms(voice_track) * 0.12
            path = dest / f"{lang}_{name}.wav"
            write(path, x)
            manifest.append({"id": f"{lang}_{name}", "lang": lang, "cond": name, "path": str(path.resolve()), "ref": text,
                             "speech": [INTRO, round(INTRO + len(speech) / SR, 2)], "dur": round(total, 2)})
    with open(out_dir / "music-intro.jsonl", "w", encoding="utf-8") as fh:
        for m in manifest:
            fh.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"{len(manifest)} music-intro clips → {dest}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
