// QA pre-review: findings before anyone watches. Burned-in text (OCR + spelling: macOS Vision/NSSpellChecker, or
// tesseract/hunspell elsewhere — see lib/text), Instagram safe zones, flash frames, black frames, loudness, clipping,
// silence gaps, freezes.
// Results are cached per render in CACHE/qa/<renderKey>.json. Every item has a stable `key` so a dismissal
// survives re-runs (and, for text items, small re-renders).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cutsFromDiffs, writeCuts } from './cuts.ts';
import { FREEZE, holdListing, holdVerdict, LIMITS, SOUND_PEAK, stallMark, type Verdict } from './findings.ts';
import { analysis, projectTracks } from './media.ts';
import { cacheDir, dataDir } from './paths.ts';
import { analysisRows, FFMPEG, lower, runBg, STDERR_KEEP, selectFrames, spawnMedia } from './probe.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import { seekTime } from './shots.ts';
import { type OcrLine, type OcrPage, type OcrWord, type TextTools, textTools } from './text/index.ts';
import { spellLanguages, textLanguage } from './text/language.ts';
import type { NormBox, Spell } from './text/types.ts';
import { distance, matchCase } from './text/words.ts';
import { timecode } from './time.ts';
import type { FrameRange, FreezeRange, Loudness, MediaMeta, QaItem, QaProgress, QaResult, QaWhy, Rect, Version } from './types.ts';
import { REELS_CHECKS, REELS_CROP } from './zones.ts';

// 2: findings say what they rest on (likely, why, holds, word/guess/line, value) and how the spelling went.
// 3: a freeze is judged by the motion at its edges (a stall vs motion coming to rest), and a small thing moving on a
//    still screen isn't one.
export const QA_VERSION = 3;

const cacheFile = (hash: string) => path.join(cacheDir(), 'qa', `${hash}.json`);
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

interface Zone extends Rect {
  zone: string;
  text: string;
}

// Instagram Reels UI zones in the 1080×1920 reel canvas: the numbers the player's phone view and its Reels preset show
// (lib/zones.ts), the words agents read here (the line's format and the zone names stay as they were).
const ZONE_WORDS: Record<string, string> = {
  'ig-icons': 'sits under the Instagram icon column',
  'ig-caption': "sits in Instagram's caption area",
  'ig-topbar': "sits under Instagram's top bar",
};
const ZONES: Zone[] = Object.keys(ZONE_WORDS).flatMap((zone) =>
  REELS_CHECKS.filter((z) => z.check === zone).map(({ x, y, w, h }) => ({ zone, x, y, w, h, text: ZONE_WORDS[zone] as string })),
);
const CROP = REELS_CROP; // px cut on each side in the grid/feed preview

// Words that are fine in social captions even when a dictionary disagrees.
const SOCIAL = new Set([
  'ofc',
  'dm',
  'dms',
  'pov',
  'vlog',
  'vlogs',
  'reel',
  'reels',
  'insta',
  'tiktok',
  'selfcare',
  'skincare',
  'haircare',
  'bodycare',
  'linkinbio',
  'merch',
  'grwm',
  'ootd',
]);

export interface QaOptions {
  onProgress?: (p: QaProgress) => void;
  /** Project folder: its caption/transcript files teach the spell check the project's vocabulary. */
  projectDir?: string;
  /** The languages the work is in, the most likely first — the transcript's, the account's, the server's speech
   * languages: the on-screen text is read in one of them unless a long sample says otherwise (lib/text/language.ts). */
  languages?: (string | null | undefined)[];
}

export function cachedQa(ver: Pick<Version, 'hash' | 'sample'>): QaResult | null {
  try {
    const r: QaResult = JSON.parse(fs.readFileSync(cacheFile(renderKey(ver)), 'utf8'));
    return r.qa_version === QA_VERSION ? r : null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<QaResult>>();
export function runQa(file: string, ver: Version, meta: MediaMeta = {}, opts: QaOptions = {}): Promise<QaResult> {
  const hit = cachedQa(ver);
  if (hit) return Promise.resolve(hit);
  const key = wsKey(renderKey(ver));
  let p = inflight.get(key);
  if (!p) {
    p = doQa(file, ver, meta, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------- helpers

// Short side ≤ 720 px is plenty for Vision and keeps OCR fast.
const ocrScale = (ver: Version) => (Math.min(ver.width, ver.height) > 720 ? (ver.width >= ver.height ? 'scale=-2:720' : 'scale=720:-2') : 'null');

interface ExtractedFrame {
  frame: number;
  file: string;
}

/** Extract the given frame numbers (exact, by decode index) as JPEGs; returns [{frame, file}] in order. Exported for its
 * test (select-frames.test.ts). */
export async function extractFrames(file: string, ver: Version, frames: number[], dir: string, prefix: string): Promise<ExtractedFrame[]> {
  if (!frames.length) return [];
  const wanted = [...new Set(frames)].sort((a, b) => a - b);
  const script = path.join(dir, `${prefix}.filter`);
  fs.writeFileSync(script, `select='${selectFrames(wanted)}',showinfo,${ocrScale(ver)}`);
  const { stderr } = await runBg(
    FFMPEG,
    [
      '-hide_banner',
      '-v',
      'info',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-filter_script:v',
      script,
      '-fps_mode',
      'passthrough',
      '-q:v',
      '3',
      path.join(dir, `${prefix}-%05d.jpg`),
    ],
    // showinfo's line for each picked frame is the answer: room for all of them (a few hundred bytes each) besides the rest
    { stderrLimit: STDERR_KEEP + wanted.length * 2048 },
  );
  const shown = [...stderr.matchAll(/\[Parsed_showinfo[^\]]*\] n:\s*(\d+) .*?pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[2]) * ver.fps));
  return shown.map((frame, i) => ({ frame, file: path.join(dir, `${prefix}-${String(i + 1).padStart(5, '0')}.jpg`) })).filter((x) => fs.existsSync(x.file));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// Words the project already "knows": transcript/caption files, the user's QA dictionary, path tokens.
function knownWords(file: string, projectDir: string | undefined): Set<string> {
  const known = new Set(SOCIAL);
  const add = (s: string) => {
    for (const w of String(s)
      .toLowerCase()
      .split(/[^\p{L}]+/u))
      if (w.length >= 3) known.add(w);
  };
  try {
    for (const l of fs.readFileSync(path.join(dataDir(), 'qa-dictionary.txt'), 'utf8').split('\n')) add(l);
  } catch {}
  add(file);
  if (!projectDir) return known;
  add(projectDir);
  try {
    const t = projectTracks(path.join(projectDir, 'export', '_.mp4'));
    for (const w of t.words || []) add(w.w);
  } catch {}
  // words*.json / timeline.json / captions / subtitles anywhere shallow in the project
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && !/^(node_modules|\.git|public|source|dist|build|out)$/.test(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
      } else if (/^(words.*\.json|timeline\.json|caption.*\.txt)$|\.(srt|vtt)$/i.test(e.name) && fs.statSync(p).size < 5e6) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          if (e.name.endsWith('.json')) {
            JSON.stringify(JSON.parse(raw), (k, v) => {
              if ((k === 'w' || k === 't' || k === 'word' || k === 'text') && typeof v === 'string') add(v);
              return v;
            });
          } else add(raw);
        } catch {}
      }
    }
  };
  walk(projectDir, 0);
  return known;
}

// A whitespace chunk that is a handle, hashtag, URL or domain is never spell-checked.
const isHandleChunk = (c: string) => /[@#/]|\.\p{L}/u.test(c) || /^www/i.test(c);

function candidateWords(line: OcrLine): OcrWord[] {
  const chunks = line.text.split(/\s+/).filter(Boolean);
  const skip = new Set<string>();
  for (const c of chunks) if (isHandleChunk(c)) for (const w of c.split(/[^\p{L}\p{N}]+/u)) if (w) skip.add(w);
  const words = line.words?.length ? line.words : chunks.map((t) => ({ text: t, box: line.box }));
  const out: OcrWord[] = [];
  for (const w of words) {
    const t = w.text.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (t.length < 3 || /\d/.test(t) || skip.has(t)) continue;
    if (t === t.toUpperCase() && t.length <= 4) continue;
    if (!/^[\p{L}'’-]+$/u.test(t)) continue;
    out.push({ text: t, box: w.box });
  }
  return out;
}

// Classic OCR slips: if the spell checker's guess is one of these away from the word, the text is probably fine.
const CONFUSIONS: [string, string][] = [
  ['m', 'rn'],
  ['rn', 'm'],
  ['d', 'cl'],
  ['cl', 'd'],
  ['w', 'vv'],
  ['vv', 'w'],
  ['h', 'li'],
  ['I', 'l'],
  ['l', 'I'],
];
// Single letters OCR mixes up: diacritics of the same base letter (å/ä/à/á …) and look-alike glyphs.
const LOOKALIKE: Record<string, string> = {
  a: 'äåàáâo',
  o: 'öøóòôa0',
  u: 'üúùûv',
  e: 'éèêëc',
  i: 'íìîïl',
  c: 'eo',
  n: 'hr',
  h: 'nb',
  v: 'u',
  g: 'q',
  O: 'GQDC0',
  G: 'OC',
  C: 'GO',
  I: 'l',
  l: 'Ii',
};
const BASE: Record<string, string> = {
  ä: 'a',
  å: 'a',
  à: 'a',
  á: 'a',
  â: 'a',
  ö: 'o',
  ø: 'o',
  ó: 'o',
  ò: 'o',
  ô: 'o',
  ü: 'u',
  ú: 'u',
  ù: 'u',
  û: 'u',
  é: 'e',
  è: 'e',
  ê: 'e',
  ë: 'e',
  í: 'i',
  ì: 'i',
  î: 'i',
  ï: 'i',
};

function confusionVariants(word: string): string[] {
  const out = new Set<string>();
  for (const [a, b] of CONFUSIONS) for (let i = word.indexOf(a); i >= 0; i = word.indexOf(a, i + 1)) out.add(word.slice(0, i) + b + word.slice(i + a.length));
  const chars = [...word];
  chars.forEach((c, i) => {
    const base = BASE[c];
    const alts = new Set([...(LOOKALIKE[c] || ''), ...(base ? [base, ...(LOOKALIKE[base] || '')] : [])]);
    for (const alt of alts) if (alt !== c) out.add([...chars.slice(0, i), alt, ...chars.slice(i + 1)].join(''));
  });
  return [...out];
}

// A word from the project's own vocabulary (captions, QA dictionary, social terms) that is closer than the spelling
// engine's guess wins: dictionaries don't know "Skincare" or a brand name, the project does.
function preferKnown(word: string, guess: string | null | undefined, known: readonly string[]): string | null {
  const lw = word.toLowerCase();
  let best = guess || null;
  let bestD = guess ? distance(word, guess) : Number.POSITIVE_INFINITY;
  for (const k of known) {
    if (k === lw || Math.abs(k.length - lw.length) > 2) continue;
    const d = distance(lw, k);
    if (d <= 2 && d < bestD) {
      best = matchCase(word, k);
      bestD = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const toPx = (b: NormBox, W: number, H: number): Rect => ({ x: Math.round(b.x * W), y: Math.round(b.y * H), w: Math.round(b.w * W), h: Math.round(b.h * H) });
const pad = (b: Rect, W: number, H: number, p: number): Rect => {
  const x = Math.max(0, b.x - p);
  const y = Math.max(0, b.y - p);
  return { x, y, w: Math.min(W - x, b.w + 2 * p), h: Math.min(H - y, b.h + 2 * p) };
};
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// ---------------------------------------------------------------- passes

interface PictureScan {
  cuts: { frame: number; score: number }[];
  /** Frames decoded. */
  n: number;
  black: FrameRange[];
  flashes: (FrameRange & { score: number; back: number })[];
}

// One small RGB decode for shot cuts and black frames. ffmpeg's scdet/scene scores deliberately cancel out
// flashes (two equal jumps), which is exactly what we want to find, so the cut test is ours (cutsFromDiffs in
// lib/cuts.ts, which partial renders snap to as well).
function scanPicture(file: string, ver: Version): Promise<PictureScan> {
  const w = 64;
  const h = analysisRows(w, ver.width, ver.height); // at most 1:4, whatever the render (A13 MEDIA-2)
  const size = w * h * 3;
  return new Promise((resolve) => {
    const p = spawnMedia(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    lower(p.pid);
    const diffs = [0];
    const dark: boolean[] = [];
    const flashes: PictureScan['flashes'] = [];
    const maxFlash = Math.max(2, Math.round(ver.fps * 0.07));
    const ring: Buffer[] = []; // last maxFlash + 2 frames
    const mad = (a: Buffer, b: Buffer) => {
      let t = 0;
      for (let i = 0; i < size; i++) t += Math.abs(a[i] - b[i]);
      return t / size;
    };
    let prev: Buffer | null = null;
    let buf: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const cur = buf.subarray(0, size);
        let sum = 0;
        let black = 0;
        for (let i = 0; i < size; i += 3) {
          if (prev) sum += Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
          if (0.2126 * cur[i] + 0.7152 * cur[i + 1] + 0.0722 * cur[i + 2] < 25.5) black++;
        }
        if (prev) diffs.push(sum / size);
        dark.push(black / (w * h) >= 0.98);
        const frame = Buffer.from(cur);
        prev = frame;
        ring.push(frame);
        if (ring.length > maxFlash + 2) ring.shift();
        // A flash: the picture jumps away for 1–2 frames and comes back to the same shot (A x A). Transitions
        // between two different shots (A x B: wipes, whip pans) look the same frame to frame and are not flagged.
        const j = diffs.length - 1;
        for (let len = 1; len <= maxFlash && j - len - 1 >= 0 && len + 1 < ring.length; len++) {
          const k = j - len;
          if (diffs[k] < 25 || diffs[j] < 25) continue;
          const before = ring[ring.length - 2 - len];
          const back = mad(before, frame);
          if (back <= 15 && back <= 0.35 * Math.min(diffs[k], diffs[j])) {
            if (!flashes.some((f) => f.out >= k)) flashes.push({ in: k, out: j - 1, score: round(Math.min(diffs[k], diffs[j])), back: round(back) });
            break;
          }
        }
        buf = buf.subarray(size);
      }
    });
    p.on('error', () => resolve({ cuts: [], black: [], flashes: [], n: 0 }));
    p.on('close', () => {
      const cuts: PictureScan['cuts'] = cutsFromDiffs(diffs);
      const black: FrameRange[] = [];
      for (let i = 0; i < dark.length; i++) {
        if (!dark[i]) continue;
        let j = i;
        while (j + 1 < dark.length && dark[j + 1]) j++;
        if (j - i + 1 >= 2) black.push({ in: i, out: j });
        i = j;
      }
      resolve({ cuts, black, flashes, n: dark.length });
    });
  });
}

interface AudioScan {
  clip: Uint16Array;
  peak: Float32Array;
  silence: { start: number; end: number; dur: number }[];
}

// One decode for silence gaps + per-frame sample peaks (clipping) at the native rate and channel count.
function scanAudio(file: string, ver: Version, meta: MediaMeta): Promise<AudioScan | null> {
  if (meta && meta.audio === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const sr = meta?.audio?.sample_rate || 48000;
    const p = spawnMedia(FFMPEG, [
      '-hide_banner',
      '-nostats',
      '-v',
      'info',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'silencedetect=n=-50dB:d=0.4',
      '-ar',
      String(sr),
      '-f',
      'f32le',
      '-',
    ]);
    lower(p.pid);
    const chans = meta?.audio?.channels || 2;
    const perFrame = (sr * chans) / ver.fps;
    const clip = new Uint16Array(ver.frames + 1);
    const peak = new Float32Array(ver.frames + 1);
    let idx = 0;
    let rest: Buffer = Buffer.alloc(0);
    // silencedetect's lines, read as they come: nothing else of stderr is kept (a broken stream prints a line a packet).
    const starts: number[] = [];
    const ends: { end: number; dur: number }[] = [];
    let line = '';
    const read = (l: string) => {
      const s = /silence_start: ([\d.]+)/.exec(l);
      if (s) starts.push(Number(s[1]));
      const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(l);
      if (e) ends.push({ end: Number(e[1]), dur: Number(e[2]) });
    };
    p.stdout.on('data', (d: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, d]) : d;
      const n = Math.floor(buf.length / 4);
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readFloatLE(i * 4));
        const f = Math.min(ver.frames, Math.floor(idx / perFrame));
        if (v > peak[f]) peak[f] = v;
        if (v >= 0.98855) clip[f]++;
        idx++;
      }
      rest = buf.subarray(n * 4);
    });
    p.stderr.on('data', (d: Buffer) => {
      const lines = (line + d.toString()).split('\n');
      line = (lines.pop() ?? '').slice(-4096);
      for (const l of lines) read(l);
    });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      read(line);
      if (!idx) return resolve(null);
      const silence = ends.map((e, i) => ({ start: starts[i] ?? e.end - e.dur, end: e.end, dur: e.dur }));
      resolve({ clip, peak, silence });
    });
  });
}

// ---------------------------------------------------------------- main

/** A recognised text line on one sampled frame, in video pixels. */
export interface TextLine {
  frame: number;
  text: string;
  key: string;
  conf: number;
  box: Rect;
  words: OcrWord[];
}

interface Occurrence {
  frame: number;
  box: Rect;
  line: TextLine;
}

type Tick = (step: string) => void;

async function doQa(file: string, ver: Version, meta: MediaMeta, { onProgress, projectDir, languages }: QaOptions = {}): Promise<QaResult> {
  const t0 = Date.now();
  const fps = ver.fps;
  const steps = ['picture', 'audio', 'analysis', 'frames', 'ocr', 'spelling', 'verify'];
  let done = 0;
  const tick: Tick = (step) => onProgress?.({ step, done: ++done, total: steps.length });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-qa-'));
  try {
    const step = Math.max(1, Math.round(fps / 2));
    const regular: number[] = [];
    for (let f = 0; f < ver.frames; f += step) regular.push(f);

    const [pic, aud, ana, regFrames] = await Promise.all([
      scanPicture(file, ver).then((r) => {
        tick('picture');
        return r;
      }),
      scanAudio(file, ver, meta).then((r) => {
        tick('audio');
        return r;
      }),
      analysis(file, ver)
        .catch(() => null)
        .then((r) => {
          tick('analysis');
          return r;
        }),
      extractFrames(file, ver, regular, tmp, 'r'),
    ]);
    // The shots partial renders snap to (lib/cuts.ts), from the same decode.
    if (pic.n && Math.abs(pic.n - ver.frames) <= 1)
      writeCuts(
        ver,
        pic.cuts.map((c) => c.frame).filter((f) => f < ver.frames),
      );
    // Without an OCR engine the picture/audio checks still run; without a speller, safe zones still do.
    const text = await textTools();

    // Frames right after cuts (a few frames in, when pop-in text has landed), unless a regular sample is close.
    const cutFrames = pic.cuts.map((c) => c.frame);
    const extra = cutFrames.map((f) => Math.min(ver.frames - 1, f + 3)).filter((f) => !regular.some((r) => Math.abs(r - f) <= 3));
    const frames = [...regFrames, ...(await extractFrames(file, ver, extra, tmp, 'c'))].sort((a, b) => a.frame - b.frame);
    tick('frames');

    const pages = text.ocr ? await text.ocr(frames.map((x) => x.file)) : [];
    tick('ocr');

    const lines = textLines(frames, pages, ver);
    const zoneLines = await inkBoxes(lines, frames, ver);
    const spelling = await spellingItems({ file, ver, lines, text, known: knownWords(file, projectDir), tmp, tick, languages });
    // Pushed in this order and sorted stably below: findings on the same frame keep a fixed order between runs.
    const items: QaItem[] = [
      ...spelling.items,
      ...safeZoneItems(zoneLines, ver),
      ...flashItems(pic, fps),
      ...blackItems(pic, ver),
      ...loudnessItems(ana?.loudness, aud, ver),
      ...(aud ? audioItems(aud, ver) : []),
      ...freezeItems(ana?.freezes?.ranges || [], pic, aud, ver),
    ];

    for (const it of items) {
      if (it.range === undefined) delete it.range;
      if (it.detail === undefined) delete it.detail;
    }
    items.sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind));
    const result: QaResult = {
      qa_version: QA_VERSION,
      hash: ver.hash,
      at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      samples: frames.length,
      text_language: spelling.lang || null,
      items,
      spelling: spelling.spelling,
    };
    const notes = [...text.notes, spelling.note].filter((n): n is string => !!n);
    if (notes.length) result.notes = notes;
    fs.mkdirSync(path.dirname(cacheFile(renderKey(ver))), { recursive: true });
    fs.writeFileSync(cacheFile(renderKey(ver)), JSON.stringify(result));
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The text lines OCR found on the sampled frames, in video pixels, with the words worth spell-checking. */
function textLines(frames: ExtractedFrame[], pages: OcrPage[], ver: Version): TextLine[] {
  const W = ver.width;
  const H = ver.height;
  const byFile = new Map(pages.map((p) => [p.path, p]));
  const lines: TextLine[] = [];
  for (const fr of frames) {
    const page = byFile.get(fr.file);
    for (const l of page?.lines || []) {
      if (l.conf < 0.5 || norm(l.text).replace(/\s/g, '').length < 2) continue;
      lines.push({
        frame: fr.frame,
        text: l.text.trim(),
        key: norm(l.text),
        conf: l.conf,
        box: toPx(l.box, W, H),
        // Spell-check burned-in captions only: small UI text and words cut by the frame edge are OCR guesswork.
        words:
          l.box.h * H >= 0.045 * Math.min(W, H)
            ? candidateWords(l)
                .filter((w) => w.box.x > 0.005 && w.box.y > 0.005 && w.box.x + w.box.w < 0.995 && w.box.y + w.box.h < 0.995)
                .map((w) => ({ text: w.text, box: toPx(w.box, W, H) }))
            : [],
      });
    }
  }
  return lines;
}

/**
 * Typos in burned-in text: words no dictionary (nor the project's own vocabulary) knows, minus classic OCR slips and
 * misread logos, confirmed by reading the word again at 2× from the full-resolution frame.
 */
async function spellingItems(o: {
  file: string;
  ver: Version;
  lines: TextLine[];
  text: TextTools;
  known: Set<string>;
  tmp: string;
  tick: Tick;
  languages?: (string | null | undefined)[];
}): Promise<{ items: QaItem[]; lang: string | null; note: string | null; spelling: NonNullable<QaResult['spelling']> }> {
  const { file, ver, lines, text, known, tmp, tick } = o;
  const W = ver.width;
  const H = ver.height;
  const tc = (f: number) => timecode(f, ver.fps);
  const seen = new Map<string, Occurrence[]>();
  for (const l of lines)
    for (const w of l.words) {
      if (known.has(w.text.toLowerCase())) continue;
      const occ = seen.get(w.text) || [];
      occ.push({ frame: l.frame, box: w.box, line: l });
      seen.set(w.text, occ);
    }
  const allText = [...new Set(lines.map((l) => l.text))].join('\n');
  const spell: Spell = text.spell || (async () => ({ lang: null, verdicts: {} }));
  // The language is decided here, before the words are checked in it: an engine's own guess at a few words of
  // captions and names named rare languages (and checked in them).
  const detected = text.detect && allText.trim() ? await text.detect(allText).catch(() => null) : null;
  const lang = textLanguage(allText, { preferred: o.languages, detected });
  const checkIn = spellLanguages(lang);
  const { verdicts } = await spell([...seen.keys()], allText, checkIn);
  tick('spelling');

  const knownList = [...known];
  // A misspelling that turns into a real word with one classic OCR slip ("verbessem" → "verbessern") is the font,
  // not the text.
  const misspelled = [...seen.keys()].filter((w) => verdicts[w] && !verdicts[w].ok);
  const variants = new Map(misspelled.map((w) => [w, confusionVariants(w)]));
  const variantVerdicts = (await spell([...new Set([...variants.values()].flat())], allText, checkIn)).verdicts;
  let suspects = [...seen.entries()].filter(([w]) => {
    const v = verdicts[w];
    if (!v || v.ok) return false;
    if ((variants.get(w) || []).some((x) => variantVerdicts[x]?.ok)) return false;
    const lw = w.toLowerCase();
    if (lw.length >= 4 && knownList.some((k) => Math.abs(k.length - lw.length) <= 1 && editDistance(k, lw) <= 1)) return false; // logo misread
    return true;
  });
  // Safety valve: when a large share of words fails, the text is in a language the dictionaries don't cover.
  let note: string | null = null;
  let state: NonNullable<QaResult['spelling']>['state'] = text.ocr && text.spell ? 'checked' : 'unavailable';
  if (seen.size >= 10 && suspects.length / seen.size > 0.15) {
    note = `spell check skipped: ${suspects.length} of ${seen.size} words unknown (text language ${lang || 'unknown'})`;
    suspects = [];
    state = 'skipped';
  }
  // Re-read each suspect at 2× from the full-resolution frame (one OCR batch): slips disappear, real typos stay.
  const crops: { word: string; occ: Occurrence[]; img: string }[] = [];
  for (const [word, occ] of suspects) {
    const first = occ[0];
    const crop = pad(first.line.box, W, H, Math.round(Math.max(12, first.line.box.h * 0.4)));
    const img = path.join(tmp, `v-${sha(word)}.png`);
    try {
      await runBg(FFMPEG, [
        '-v',
        'error',
        '-ss',
        seekTime(first.frame, ver.fps).toFixed(6),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=iw*2:ih*2:flags=lanczos`,
        '-y',
        img,
      ]);
      crops.push({ word, occ, img });
    } catch {}
  }
  const rereads = text.ocr ? await text.ocr(crops.map((c) => c.img)) : [];
  const confirmed = crops
    .filter((c, i) => (rereads[i]?.lines || []).some((l) => candidateWords(l).some((w) => w.text === c.word)))
    .map((c) => [c.word, c.occ] as const);
  tick('verify');

  const items: QaItem[] = [];
  for (const [word, occ] of confirmed) {
    const guess = preferKnown(word, verdicts[word].guess, knownList);
    const first = occ[0];
    const frames = [...new Set(occ.map((x) => x.frame))];
    items.push({
      key: `typo:${sha(word.toLowerCase())}`,
      kind: 'typo',
      severity: 'should',
      tags: ['text/typo'],
      frame: first.frame,
      range: frames.length > 1 ? { in: frames[0], out: frames[frames.length - 1] } : undefined,
      text: guess ? `Possible typo "${word}" → "${guess}"?` : `Possible typo "${word}"?`,
      detail: `In "${first.line.text}" · seen at ${frames.slice(0, 4).map(tc).join(', ')}${frames.length > 4 ? ' …' : ''}`,
      box: pad(first.box, W, H, 8),
      // read again at 2× from the full frame and still unknown: more likely the text than the reading
      likely: 'problem',
      word,
      ...(guess ? { guess } : {}),
      line: first.line.text,
    });
  }
  return { items, lang, note, spelling: { state, words: seen.size, ...(text.spell ? { languages: checkIn } : {}) } };
}

/**
 * OCR's line box runs wider than the letters (Vision's box for “around 0:12.” at 1080 px starts 20 px left of the quote
 * mark), and 20 px is the whole margin to the side crop. Lines near the crop on a vertical video get their sides
 * measured on the frame they were read from: the box's own rows against the box's median colour. Only ever narrowed;
 * where the edge columns aren't plain ground (text over a picture) OCR's box stands.
 */
export async function inkBoxes(lines: TextLine[], frames: ExtractedFrame[], ver: Version): Promise<TextLine[]> {
  const W = ver.width;
  const H = ver.height;
  if (H <= W) return lines;
  const k = 1080 / W;
  const near = (b: Rect) => b.x * k < CROP + 4 || (b.x + b.w) * k > 1080 - CROP - 4;
  const out = [...lines];
  for (const fr of frames) {
    const at = out.flatMap((l, i) => (l.frame === fr.frame && near(l.box) ? [i] : []));
    if (!at.length) continue;
    // the OCR frame back at the render's size, so boxes and pixels share one scale
    const px = await runBg(FFMPEG, ['-v', 'error', '-i', fr.file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).then(
      (r) => r.stdout,
      () => null,
    );
    if (!px || px.length !== W * H * 3) continue;
    for (const i of at) {
      const span = inkSpan(px, W, H, out[i].box);
      if (span) out[i] = { ...out[i], box: { ...out[i].box, x: span[0], w: span[1] - span[0] } };
    }
  }
  return out;
}

/** The columns of a box that hold anything but its ground (its median colour), or null when there are none. */
function inkSpan(px: Buffer, W: number, H: number, b: Rect): [number, number] | null {
  const x0 = Math.max(0, Math.round(b.x));
  const x1 = Math.min(W, Math.round(b.x + b.w));
  const y0 = Math.max(0, Math.round(b.y));
  const y1 = Math.min(H, Math.round(b.y + b.h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) hist[c][px[(y * W + x) * 3 + c]]++;
  const half = ((x1 - x0) * (y1 - y0)) / 2;
  const ground = hist.map((h) => {
    let n = 0;
    for (let v = 0; v < 256; v++) {
      n += h[v];
      if (n >= half) return v;
    }
    return 255;
  });
  const ink = (x: number) => {
    for (let y = y0; y < y1; y++) {
      const o = (y * W + x) * 3;
      if (Math.abs(px[o] - ground[0]) + Math.abs(px[o + 1] - ground[1]) + Math.abs(px[o + 2] - ground[2]) > 90) return true;
    }
    return false;
  };
  let a = x0;
  while (a < x1 && !ink(a)) a++;
  if (a === x1) return null;
  let z = x1 - 1;
  while (z > a && !ink(z)) z--;
  return [a, z + 1];
}

/** Text under the Instagram Reels UI or cut by the feed's side crop (vertical video only), one item per line and zone.
 * Exported for its test (safe-zones.test.ts). */
export function safeZoneItems(lines: TextLine[], ver: Version): QaItem[] {
  const W = ver.width;
  const H = ver.height;
  if (H <= W) return [];
  const tc = (f: number) => timecode(f, ver.fps);
  const k = 1080 / W;
  const offY = (1920 - H * k) / 2;
  const zoneHits = new Map<string, { zone: string; line: TextLine; first: number; last: number; count: number }>();
  for (const l of lines) {
    const b = { x: l.box.x * k, y: l.box.y * k + offY, w: l.box.w * k, h: l.box.h * k };
    const area = Math.max(1, b.w * b.h);
    const hits = ZONES.filter((z) => overlap(b, z) / area >= 0.15).map((z) => z.zone);
    if (b.x < CROP - 4 || b.x + b.w > 1080 - CROP + 4) hits.push('ig-crop');
    for (const zone of hits) {
      const same = [...zoneHits.values()].find(
        (z) => z.zone === zone && (z.line.key === l.key || (l.key.length >= 4 && editDistance(z.line.key, l.key) <= 1 && overlap(z.line.box, l.box) > 0)),
      );
      if (same) {
        same.last = Math.max(same.last, l.frame);
        same.count++;
      } else zoneHits.set(`${zone}|${l.key}`, { zone, line: l, first: l.frame, last: l.frame, count: 1 });
    }
  }
  // Text that touches a zone in a single sample is usually mid-animation (words flying in or out).
  return [...zoneHits.values()]
    .filter((z) => z.count >= 2)
    .map(({ zone, line, first, last }): QaItem => {
      const z = ZONES.find((x) => x.zone === zone);
      const label = line.text.length > 40 ? `${line.text.slice(0, 38)}…` : line.text;
      return {
        key: `zone:${zone}:${sha(line.key)}`,
        kind: 'safe-zone',
        severity: 'should',
        tags: ['layout/overlap'],
        frame: first,
        range: last > first ? { in: first, out: last } : undefined,
        text: z ? `Text "${label}" ${z.text}` : `Text "${label}" is cut by the ${CROP} px side crop`,
        detail: `Instagram Reels zone ${zone} · on screen ${tc(first)}${last > first ? `–${tc(last)}` : ''}`,
        zone,
        box: pad(line.box, W, H, 8),
        likely: 'problem',
        line: line.text,
      };
    });
}

/** Flash frames: 1–2 foreign frames inside a shot. */
function flashItems(pic: PictureScan, fps: number): QaItem[] {
  return pic.flashes.map((f): QaItem => {
    const len = f.out - f.in + 1;
    return {
      key: `flash:${f.in}`,
      kind: 'flash-frame',
      severity: 'must',
      tags: ['cut'],
      frame: f.in,
      range: len > 1 ? { in: f.in, out: f.out } : undefined,
      text: `Flash frame: ${len} foreign frame${len > 1 ? 's' : ''} at ${timecode(f.in, fps)}, then the shot continues`,
      detail: `jump ${f.score} vs. ${f.back} between the frames around it (64 px RGB mean difference)`,
      likely: 'problem',
    };
  });
}

/** Black frames inside the video (fades at the very start and end are fine). */
function blackItems(pic: PictureScan, ver: Version): QaItem[] {
  const fps = ver.fps;
  const edge = Math.round(LIMITS.edgeSeconds * fps);
  return pic.black
    .filter((b) => b.in >= edge && b.out < ver.frames - edge)
    .map((b): QaItem => {
      const n = b.out - b.in + 1;
      const gap = n <= Math.round(fps * LIMITS.blackGapSeconds); // a few frames: a gap between clips; longer: a dip to black
      return {
        key: `black:${b.in}`,
        kind: 'black-frames',
        severity: gap ? 'should' : 'nice',
        tags: ['cut'],
        frame: b.in,
        range: { in: b.in, out: b.out },
        text: gap ? `Black gap of ${n} frame${n > 1 ? 's' : ''} between shots` : `Dip to black for ${round(n / fps, 2)} s: intended?`,
        likely: gap ? 'problem' : 'intended',
        why: gap ? 'black-gap' : 'black-dip',
      };
    });
}

/** Loudness far from what social platforms normalise to (about −14 LUFS), and a true peak above −1 dBTP. */
function loudnessItems(loud: Loudness | null | undefined, aud: AudioScan | null, ver: Version): QaItem[] {
  const items: QaItem[] = [];
  if (!loud || loud.lufs === null || !Number.isFinite(loud.lufs)) return items;
  if (loud.lufs < LIMITS.lufsLow || loud.lufs > LIMITS.lufsHigh)
    items.push({
      key: 'loudness:lufs',
      kind: 'loudness',
      severity: 'nice',
      tags: ['audio/music'],
      frame: 0,
      text: `Integrated loudness ${round(loud.lufs)} LUFS; social platforms normalise to about −14 LUFS`,
      detail: `LRA ${loud.lra ?? '–'} LU · true peak ${loud.true_peak ?? '–'} dBTP`,
      value: round(loud.lufs),
    });
  if (loud.true_peak !== null && Number.isFinite(loud.true_peak) && loud.true_peak > LIMITS.peakDb) {
    let pf = 0;
    if (aud) for (let f = 1; f < aud.peak.length; f++) if (aud.peak[f] > aud.peak[pf]) pf = f;
    items.push({
      key: 'loudness:peak',
      kind: 'loudness',
      severity: 'should',
      tags: ['audio/music'],
      frame: Math.min(pf, ver.frames - 1),
      text: `True peak ${round(loud.true_peak)} dBTP; keep it below −1 dBTP`,
      detail: `Loudest frame ${timecode(Math.min(pf, ver.frames - 1), ver.fps)}`,
      likely: 'problem',
      value: round(loud.true_peak),
    });
  }
  return items;
}

/** Clipping (frames with ≥ 2 samples at ≥ −0.1 dBFS, merged when ≤ half a second apart) and silence gaps inside. */
function audioItems(aud: AudioScan, ver: Version): QaItem[] {
  const fps = ver.fps;
  const items: QaItem[] = [];
  const ranges: FrameRange[] = [];
  for (let f = 0; f < ver.frames; f++) {
    if (aud.clip[f] < 2) continue;
    const last = ranges[ranges.length - 1];
    if (last && f - last.out <= Math.round(fps / 2)) last.out = f;
    else ranges.push({ in: f, out: f });
  }
  for (const r of ranges.slice(0, 8))
    items.push({
      key: `clip:${r.in}`,
      kind: 'clipping',
      severity: 'should',
      tags: ['audio/music'],
      frame: r.in,
      range: r.out > r.in ? r : undefined,
      text: `Audio peaks at 0 dBFS for ${r.out - r.in + 1} frame${r.out > r.in ? 's' : ''}: likely clipping`,
      detail: ranges.length > 8 ? `${ranges.length - 8} more clipped spots not listed` : undefined,
      likely: 'problem',
    });

  for (const s of aud.silence) {
    if (s.start < 0.3 || s.end > ver.duration - 0.3) continue;
    const f = Math.round(s.start * fps);
    items.push({
      key: `silence:${f}`,
      kind: 'silence',
      severity: 'nice',
      tags: ['audio/music'],
      frame: f,
      range: { in: f, out: Math.max(f, Math.round(s.end * fps) - 1) },
      text: `Silence for ${round(s.dur)} s`,
    });
  }
  return items;
}

// What a hold looks like, said for agents (and for a note made of it): how long, and what the guess rests on. A stall
// says its mark after the sentence agents know.
function holdText(why: QaWhy, n: number, sec: number, mark: ReturnType<typeof stallMark>): string {
  if (why === 'pause') return `Picture holds for ${n} frames (${sec} s) while the sound pauses`;
  if (why === 'held-shot') return `Shot holds still for ${n} frames (${sec} s) from its first frame`;
  if (why === 'eased') return `Picture rests for ${n} frames (${sec} s) as the motion eases into it`;
  if (why === 'still-before') return `Picture holds for ${n} frames (${sec} s) with nothing moving before it`;
  const tail = mark === 'jump' ? ', then jumps ahead: frames look missing' : mark === 'stop' ? ': the motion stops dead' : '';
  if (why === 'mid-shot') return `Picture freezes for ${n} frames (${sec} s) in a moving shot${tail}`;
  return `Picture freezes for ${n} frames (${sec} s) while the sound goes on${tail}`;
}

/**
 * Freezes (the grain-robust detector from media.ts), each judged by lib/findings.ts `holdVerdict` from the motion at
 * its edges and the sound under it: holds on the first or last frames open or close the video and aren't listed; holds
 * over black are the black frames' finding; a few repeated frames of a stall become one summary (they stay visible on
 * the timeline); the rest are listed one by one — what looks like a problem as `should`, what looks intended as minor —
 * unless there are many (one summary: motion graphics and screen recordings pause on purpose), or a hold that looks
 * intended is too short for a pause or a still shot longer than FREEZE.stillSeconds.
 */
function freezeItems(ranges: FreezeRange[], pic: PictureScan, aud: AudioScan | null, ver: Version): QaItem[] {
  const fps = ver.fps;
  const tc = (f: number) => timecode(f, fps);
  const cuts = pic.cuts.map((c) => c.frame);
  const soundOf = (r: FrameRange): number | null => {
    if (!aud) return null;
    let on = 0;
    for (let f = r.in; f <= r.out; f++) if ((aud.peak[f] ?? 0) >= SOUND_PEAK) on++;
    return on / (r.out - r.in + 1);
  };
  const holds: { r: FreezeRange; v: Verdict; listing: ReturnType<typeof holdListing> }[] = ranges
    .filter((r) => !pic.black.some((b) => b.in <= r.out && r.in <= b.out))
    .map((r) => {
      const v = holdVerdict(r, { frames: ver.frames, fps, sound: soundOf(r), fromCut: cuts.some((c) => Math.abs(c - r.in) <= 1), motion: r.motion });
      return { r, v, listing: holdListing(r, v, fps) };
    });
  const at = (list: FreezeRange[], max: number) =>
    `at ${list
      .slice(0, max)
      .map((x) => tc(x.in))
      .join(', ')}${list.length > max ? ' …' : ''}`;
  const items: QaItem[] = [];
  const ones = holds.filter((h) => h.listing === 'one');
  if (ones.length > FREEZE.many) {
    const list = ones.map((h) => h.r);
    items.push({
      key: 'freeze:holds',
      kind: 'freeze',
      severity: 'nice',
      tags: ['freeze'],
      frame: list[0].in,
      text: `${list.length} holds of ${round(Math.min(...list.map((x) => x.frames)) / fps, 2)}–${round(Math.max(...list.map((x) => x.frames)) / fps, 2)} s: intended pauses?`,
      detail: at(list, 8),
      likely: 'intended',
      why: 'many-holds',
      holds: list.map((x) => ({ in: x.in, out: x.out })),
    });
  } else
    for (const { r, v } of ones)
      items.push({
        key: `freeze:${r.in}`,
        kind: 'freeze',
        severity: v.likely === 'problem' ? 'should' : 'nice',
        tags: ['freeze'],
        frame: r.in,
        range: { in: r.in, out: r.out },
        text: holdText(v.why, r.frames, round(r.frames / fps, 2), r.motion ? stallMark(r.motion) : null),
        likely: v.likely,
        why: v.why,
      });
  const short = holds.filter((h) => h.listing === 'short').map((h) => h.r);
  if (short.length) {
    const lo = Math.min(...short.map((x) => x.frames));
    const hi = Math.max(...short.map((x) => x.frames));
    items.push({
      key: 'freeze:short',
      kind: 'freeze',
      // a few hitches are worth a look; many at once is footage that was retimed (speed ramps) on purpose
      severity: short.length <= FREEZE.fewRepeats ? 'should' : 'nice',
      tags: ['freeze'],
      frame: short[0].in,
      text: `Repeated frames: ${short.length} run${short.length > 1 ? 's' : ''} of ${lo === hi ? lo : `${lo}–${hi}`} identical frames`,
      detail: at(short, 6),
      likely: 'problem',
      why: 'repeated',
      holds: short.map((x) => ({ in: x.in, out: x.out })),
    });
  }
  return items;
}
