#!/usr/bin/env node
// Searching the footage index (prototype of `vr footage find` / MCP find_footage): a request in plain words → the
// filters it names (aspect, length, camera move, "no text", words on screen or said) + what it should show → shots
// ranked by image–text similarity (best keyframe of each shot), words matched in OCR text and transcripts.
//   node bench/footage/find.ts "product close-up on white, slow push-in, ≥ 2 s, 9:16, no text" [--k 6]
//        [--model siglip-b16:q8:pad] [--sheet out.jpg] [--db file]
// Prints the compact list an agent reads; --sheet writes the one labelled contact sheet.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fontFile, tc, WORK_DIR } from './common.ts';
import type { Dtype, Embedder, Fit } from './embed.ts';

export type Aspect = '16:9' | '9:16' | '1:1';
export interface Parsed {
  /** What the shot should show, for the embedding. */
  semantic: string;
  aspect?: Aspect;
  minSec?: number;
  maxSec?: number;
  motion?: string[];
  speed?: 'slow' | 'fast';
  noText?: boolean;
  /** Words to find on screen (OCR) or in what is said. */
  words?: string;
  wordsIn?: 'text' | 'said' | 'any';
}

const MOTIONS: [RegExp, string[]][] = [
  [/\b(?:push(?:ing)?[- ]?in|dolly(?:ing)?[- ]?in|zoom(?:ing)?[- ]in|ranfahrt|reinzoom\w*)\b/i, ['push-in']],
  [/\b(?:pull(?:ing)?[- ]?(?:out|back)|zoom(?:ing)?[- ]out|dolly(?:ing)?[- ]?out|rausfahrt)\b/i, ['pull-out']],
  [/\bpan(?:ning|s|ned)?\s+(?:to\s+the\s+)?left\b|\bschwenk\w*\s+(?:nach\s+)?links\b/i, ['pan-left']],
  [/\bpan(?:ning|s|ned)?\s+(?:to\s+the\s+)?right\b|\bschwenk\w*\s+(?:nach\s+)?rechts\b/i, ['pan-right']],
  // a bare "pan" is a camera move only where it can't be a frying pan
  [/\bpanning\b|\bpan(?:s|ned)?\s+(?:shot|across|over|along)\b|\bcamera pan\b|(?:^|,)\s*pan\s*(?=,|$)|\bschwenk\w*\b/i, ['pan-left', 'pan-right']],
  [/\btilt(?:ing|s|ed)?\s+up\b/i, ['tilt-up']],
  [/\btilt(?:ing|s|ed)?\s+down\b/i, ['tilt-down']],
  [/\btilt(?:ing|s|ed)?\b/i, ['tilt-up', 'tilt-down']],
  [/\bhand[- ]?held\b|\bshaky\b|\baus der hand\b/i, ['handheld']],
  [/\bstatic\b|\blocked[- ]off\b|\btripod\b|\bstatisch\w*\b|\bstill shot\b/i, ['static']],
];

/** Splits a request in plain words into filters and what the picture should show. English, some German. */
export function parseQuery(q: string): Parsed {
  let s = ` ${q.replace(/\s+/g, ' ')} `;
  const p: Parsed = { semantic: '' };
  const cut = (re: RegExp) => {
    s = s.replace(re, ' , ');
  };
  // quoted words: on screen or said
  const quoted = /["“„«]([^"“”„«»]{2,})["”“»]|'([^']{2,})'/.exec(s);
  if (quoted) {
    p.words = (quoted[1] || quoted[2] || '').trim();
    s = s.replace(quoted[0], ' ');
  }
  const saidCue = /\b(?:voice[- ]?over|voiceover|narrat\w*|spoken|speaks?|said|sprecher\w*|stimme|sagt|gesagt|spricht)\b/i;
  const textCue = /\b(?:sign|text|caption|title|lower third|banner|words?|reads?|schrift|bauchbinde|titel)\b/i;
  p.wordsIn = saidCue.test(s) ? 'said' : textCue.test(s) ? 'text' : 'any';
  // unquoted words after a cue: "where the voice-over says the battery lasts all week", "with the name Anna Berg"
  if (!p.words) {
    const after = /\b(?:says|saying|that reads|reads|with the words|with the name|named|called|sagt|mit dem namen)\s+(?:the\s+(?=\w+\s+\w))?([^,;]+)/i.exec(s);
    if (after?.[1]) {
      p.words = (after[0].match(/\bsays\s+the\s/i) ? `the ${after[1]}` : after[1]).trim();
      s = s.replace(after[0], ' ');
      // capitals after "says" are on the screen, unless a voice is named
      if (p.wordsIn === 'any' && p.words === p.words.toUpperCase()) p.wordsIn = 'text';
    }
  }
  // words in capitals are text in the picture ("the STREET CLOSED sign"); they stay in the description too
  if (!p.words) {
    const caps = /\b([A-ZÄÖÜ]{2,}(?:[ -]+[A-ZÄÖÜ0-9%]{2,})+|[A-ZÄÖÜ]{4,})\b/.exec(s.replace(/\b\d+\s*:\s*\d+\b/g, ''));
    if (caps?.[1]) {
      p.words = caps[1];
      if (p.wordsIn === 'any') p.wordsIn = 'text';
    }
  }
  if (p.words && p.wordsIn === 'said') cut(/\bwhere\b|\bwo\b|\b(?:the\s+)?voice[- ]?over\b|\bdie sprecherin\b|\bder sprecher\b|\bsagt\b/gi);
  // aspect
  if (/\b9\s*:\s*16\b|\bvertical\b|\bportrait\b|\bhochkant\b/i.test(s)) p.aspect = '9:16';
  else if (/\b16\s*:\s*9\b|\bhorizontal\b|\blandscape\b|\bwidescreen\b|\bquerformat\b/i.test(s)) p.aspect = '16:9';
  else if (/\b1\s*:\s*1\b|\bsquare\b|\bquadratisch\b/i.test(s)) p.aspect = '1:1';
  cut(
    /\b9\s*:\s*16\b|\b16\s*:\s*9\b|\b1\s*:\s*1\b|\bvertical\b|\bportrait\b|\bhochkant\b|\bhorizontal\b|\blandscape\b|\bwidescreen\b|\bquerformat\b|\bsquare\b|\bquadratisch\b/gi,
  );
  // length
  const num = '(\\d+(?:[.,]\\d+)?)\\s*(?:s|sec|secs|seconds?|sekunden|sek)\\b';
  const min = new RegExp(`(?:≥|>=|>|at least|min(?:imum)?\\.?|longer than|more than|over|mindestens|länger als)\\s*${num}`, 'i').exec(s);
  if (min) {
    p.minSec = Number((min[1] as string).replace(',', '.'));
    s = s.replace(min[0], ' , ');
  }
  const max = new RegExp(`(?:≤|<=|<|at most|max(?:imum)?\\.?|shorter than|less than|under|höchstens|kürzer als)\\s*${num}`, 'i').exec(s);
  if (max) {
    p.maxSec = Number((max[1] as string).replace(',', '.'));
    s = s.replace(max[0], ' , ');
  }
  // no text
  if (/\b(?:no|without)\s+(?:text|titles?|captions?|graphics|overlays?|lower thirds?)\b|\bclean plate\b|\bohne\s+(?:text|schrift|titel)\b/i.test(s)) {
    p.noText = true;
    cut(/\b(?:no|without)\s+(?:text|titles?|captions?|graphics|overlays?|lower thirds?)\b|\bclean plate\b|\bohne\s+(?:text|schrift|titel)\b/gi);
  }
  // camera move (+ slow/fast next to it)
  for (const [re, kinds] of MOTIONS) {
    const m = re.exec(s);
    if (!m) continue;
    p.motion = kinds;
    const around = s.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:slow|slowly|gentle|langsam\w*)\s*$/i.test(around)) p.speed = 'slow';
    if (/\b(?:fast|quick|rapid|schnell\w*)\s*$/i.test(around)) p.speed = 'fast';
    s = s.replace(new RegExp(`(?:\\b(?:slow|slowly|gentle|fast|quick|rapid|langsame?|schnelle?)\\s+)?(?:${re.source})(?:\\s+shot)?(?:\\s+of)?`, 'i'), ' , ');
    break;
  }
  // what is left describes the picture
  p.semantic = s
    .replace(/\b(?:the|a|an)\s+(?:shot|clip|footage|b-roll)\s+(?:with|of|that)\b/gi, ' ')
    .replace(/\b(?:shot|clip)\s+(?:that|which|where)\b|\b(?:that|which|where)\s*$/gi, ' ')
    .replace(/\b(?:shot|clip|footage|b-roll)\b(?=\s*(?:,|$))/gi, ' ')
    .replace(/\s*,\s*(?:,\s*)*/g, ', ')
    .replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (p.words && p.wordsIn === 'text' && !p.semantic.toLowerCase().includes(p.words.toLowerCase()))
    p.semantic = `${p.semantic} ${p.words.toLowerCase()}`.trim();
  if (!p.words) delete p.words;
  if (!p.words) delete p.wordsIn;
  return p;
}

// ---------------------------------------------------------------- on-screen text

export interface OcrLineLite {
  text: string;
  conf: number;
}
/** Confidence a line needs per engine (tesseract's are word means, Vision's 0.3 / 0.5 / 1). */
export const OCR_MIN_CONF: Record<string, number> = { tesseract: 0.75, vision: 0.5 };

/** What the OCR read that is worth keeping: confident lines with a real word in them (≥ 4 letters, or two of ≥ 3) —
 * photos make tesseract see "ee", "BLE", "nee". */
export function cleanOcr(lines: OcrLineLite[], minConf: number): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.conf < minConf) continue;
    const words = l.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
    const long = words.filter((w) => /\p{L}{4,}/u.test(w)).length;
    const mid = words.filter((w) => /\p{L}{3,}|\p{N}{2,}/u.test(w)).length;
    if (!long && mid < 2) continue;
    out.push(words.join(' '));
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- the index in memory

export interface IndexShot {
  id: number;
  clip: string;
  width: number;
  height: number;
  fps: number;
  in: number;
  out: number;
  motion: string;
  speed: string | null;
  text: string;
  said: string;
  kfs: { id: number; frame: number; thumb: string }[];
}
export interface LoadedIndex {
  dir: string;
  model: string;
  shots: IndexShot[];
  dim: number;
  /** keyframe vectors, row i belongs to kfShot[i] (index into shots) */
  vecs: Float32Array;
  kfShot: Int32Array;
  kfRow: Map<number, number>;
}

/** `ocr`: rebuild each shot's text from the raw lines of that engine (to compare engines on one index). */
export function loadIndex(dbFile: string, model: string, ocr?: string): LoadedIndex {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const shots = db
    .prepare(
      'SELECT s.id, c.file AS clip, c.width, c.height, c.fps, s.f_in AS "in", s.f_out AS out, s.motion, s.speed, s.text, s.said FROM shots s JOIN clips c ON c.id = s.clip_id ORDER BY c.file, s.f_in',
    )
    .all() as unknown as IndexShot[];
  const at = new Map(shots.map((s, i) => [s.id, i]));
  for (const s of shots) s.kfs = [];
  const rows = db
    .prepare('SELECT k.id, k.shot_id, k.frame, k.thumb, v.vec FROM keyframes k JOIN vectors v ON v.kf_id = k.id AND v.model = ? ORDER BY k.id')
    .all(model) as { id: number; shot_id: number; frame: number; thumb: string; vec: Uint8Array }[];
  if (!rows.length) throw new Error(`no vectors for ${model} in ${dbFile}`);
  const dim = rows[0]?.vec.byteLength ? rows[0].vec.byteLength / 4 : 0;
  const vecs = new Float32Array(rows.length * dim);
  const kfShot = new Int32Array(rows.length);
  const kfRow = new Map<number, number>();
  rows.forEach((r, i) => {
    vecs.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
    const si = at.get(r.shot_id) as number;
    kfShot[i] = si;
    kfRow.set(r.id, i);
    (shots[si] as IndexShot).kfs.push({ id: r.id, frame: r.frame, thumb: r.thumb });
  });
  if (ocr) {
    const lines = db.prepare('SELECT k.shot_id, o.text, o.conf FROM ocr o JOIN keyframes k ON k.id = o.kf_id WHERE o.engine = ?').all(ocr) as {
      shot_id: number;
      text: string;
      conf: number;
    }[];
    const byShot = new Map<number, OcrLineLite[]>();
    for (const l of lines) byShot.set(l.shot_id, [...(byShot.get(l.shot_id) ?? []), l]);
    for (const s of shots) s.text = cleanOcr(byShot.get(s.id) ?? [], OCR_MIN_CONF[ocr] ?? 0.75).join(' · ');
  }
  db.close();
  return { dir: path.dirname(dbFile), model, shots, dim, vecs, kfShot, kfRow };
}

export const aspectOf = (w: number, h: number): Aspect => (w / h > 1.2 ? '16:9' : w / h < 0.83 ? '9:16' : '1:1');

const STOP = new Set('the a an and or of in on at to with is are was this that der die das und ein eine mit im am zu'.split(' '));
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // one edit (OCR misreads a letter)
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
}
/** Share of the query's words found in a text (one edit allowed for words of 5+ letters). */
export function wordMatch(query: string, text: string): number {
  const q = fold(query)
    .split(' ')
    .filter((w) => w && !STOP.has(w));
  if (!q.length || !text) return 0;
  const t = fold(text).split(' ');
  return q.filter((w) => t.some((x) => near(w, x))).length / q.length;
}

export interface SearchOptions {
  k?: number;
  motionMode?: 'hard' | 'soft' | 'off';
  textMode?: 'hard' | 'soft';
  /** Score a shot by its best keyframe (max) or the mean of them. */
  agg?: 'max' | 'mean';
  /** Only the middle keyframe of each shot (what one keyframe per shot would give). */
  oneKeyframe?: boolean;
  /** Ignore filters and words: the request's embedding alone. */
  raw?: boolean;
}
export interface Hit {
  shot: IndexShot;
  score: number;
  /** the keyframe that matched best */
  frame: number;
  thumb: string;
  why: string[];
}

/** Ranks shots: z-scored similarity of each shot's best keyframe, + matched words, filtered by what the request names. */
export function search(ix: LoadedIndex, qvec: Float32Array | null, p: Parsed, o: SearchOptions = {}): Hit[] {
  const k = o.k ?? 10;
  const motionMode = o.motionMode ?? 'soft';
  const n = ix.shots.length;
  const best = new Float32Array(n).fill(Number.NEGATIVE_INFINITY);
  const sum = new Float32Array(n);
  const cnt = new Int32Array(n);
  const bestKf = new Int32Array(n).fill(-1);
  if (qvec) {
    const rowsN = ix.kfShot.length;
    for (let r = 0; r < rowsN; r++) {
      const si = ix.kfShot[r] as number;
      if (o.oneKeyframe) {
        const s = ix.shots[si] as IndexShot;
        const mid = s.kfs[Math.floor((s.kfs.length - 1) / 2)];
        if (mid && ix.kfRow.get(mid.id) !== r) continue;
      }
      let dot = 0;
      const base = r * ix.dim;
      for (let d = 0; d < ix.dim; d++) dot += (ix.vecs[base + d] as number) * (qvec[d] as number);
      sum[si] = (sum[si] as number) + dot;
      cnt[si] = (cnt[si] as number) + 1;
      if (dot > (best[si] as number)) {
        best[si] = dot;
        bestKf[si] = r;
      }
    }
  }
  const sim = Array.from({ length: n }, (_, i) => (qvec ? (o.agg === 'mean' ? (sum[i] as number) / Math.max(1, cnt[i] as number) : (best[i] as number)) : 0));
  const mean = sim.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sim.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  const hits: Hit[] = [];
  for (let i = 0; i < n; i++) {
    const s = ix.shots[i] as IndexShot;
    const why: string[] = [];
    let score = qvec ? ((sim[i] as number) - mean) / sd : 0;
    const secs = (s.out - s.in) / s.fps;
    if (!o.raw) {
      if (p.aspect && aspectOf(s.width, s.height) !== p.aspect) continue;
      if (p.minSec !== undefined && secs < p.minSec) continue;
      if (p.maxSec !== undefined && secs > p.maxSec) continue;
      if (p.noText && s.text) {
        if (o.textMode === 'soft') score -= 1.5;
        else continue;
      }
      if (p.motion && motionMode !== 'off') {
        const ok = p.motion.includes(s.motion);
        if (!ok && motionMode === 'hard') continue;
        if (motionMode === 'soft') score += ok ? 1 : -0.5;
        if (ok && p.speed && s.speed === p.speed) score += 0.2;
      }
      if (p.words) {
        const field = p.wordsIn === 'said' ? s.said : p.wordsIn === 'text' ? s.text : `${s.text} ${s.said}`;
        const m = wordMatch(p.words, field);
        if (m > 0) {
          score += m >= 0.5 ? 4 * m : 2 * m;
          why.push(p.wordsIn === 'said' ? 'said' : 'text');
        }
      }
    }
    // a request that is only words ("where the voice-over says …") lists only shots with those words
    if (!qvec && p.words && !o.raw && !why.length) continue;
    const r = bestKf[i] as number;
    const kf = r >= 0 ? s.kfs.find((x) => ix.kfRow.get(x.id) === r) : s.kfs[Math.floor((s.kfs.length - 1) / 2)];
    hits.push({ shot: s, score, frame: kf?.frame ?? s.in, thumb: kf?.thumb ?? '', why });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

/** "a photo of …": how CLIP-style models were asked in training. */
export const prompt = (semantic: string): string => (semantic ? `a photo of ${semantic}` : '');

// ---------------------------------------------------------------- what the agent reads

const clipText = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The compact answer: a header naming the filters, then one line per shot, best first: id, file, in–out, length, aspect,
 * move, words, score. */
export function compactList(hits: Hit[], p: Parsed, total: number): string {
  const f = [
    p.aspect,
    p.motion ? `${p.speed ? `${p.speed} ` : ''}${p.motion.length > 1 ? p.motion[0]?.split('-')[0] : p.motion[0]}` : '',
    p.minSec !== undefined ? `≥${p.minSec}s` : '',
    p.maxSec !== undefined ? `≤${p.maxSec}s` : '',
    p.noText ? 'no text' : '',
    p.words ? `${p.wordsIn === 'said' ? 'said' : 'text'} "${p.words}"` : '',
  ].filter(Boolean);
  const head = `${hits.length} of ${total} shots${p.semantic ? ` · "${p.semantic}"` : ''}${f.length ? ` · ${f.join(' · ')}` : ''}`;
  const lines = hits.map((h) => {
    const s = h.shot;
    const extra = [
      s.text && (h.why.includes('text') || !p.noText) ? `text "${clipText(s.text)}"` : '',
      s.said && h.why.includes('said') ? `said "${clipText(s.said)}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const move = s.speed && s.motion !== 'static' ? `${s.motion} ${s.speed}` : s.motion;
    return `s${s.id} ${s.clip} ${tc(s.in, s.fps)}–${tc(s.out - 1, s.fps)} ${((s.out - s.in) / s.fps).toFixed(1)}s ${aspectOf(s.width, s.height)} ${move}${extra ? ` ${extra}` : ''} · ${h.score.toFixed(1)}`;
  });
  return [head, ...lines].join('\n');
}

/** One labelled contact sheet: each candidate's best keyframe with its id (as in the list) and in point, 3 to a row. */
export function contactSheet(hits: Hit[], dir: string, out: string, cols = 3): { width: number; height: number } {
  const tall = hits.every((h) => h.shot.height > h.shot.width);
  const [cw, ch] = tall ? [180, 320] : [320, 180];
  const font = fontFile().replace(/:/g, '\\:');
  const n = hits.length;
  const c = Math.min(cols, n);
  const rows = Math.ceil(n / c);
  const parts = hits.map((h, i) => {
    const label = `s${h.shot.id}  ${tc(h.shot.in, h.shot.fps).replace(/:/g, '\\:')}`;
    return `[${i}:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:0x202020,drawtext=fontfile='${font}':text='${label}':x=6:y=6:fontsize=${tall ? 18 : 20}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5,pad=iw+4:ih+4:2:2:black[t${i}]`;
  });
  const layout = hits.map((_, i) => `${(i % c) * (cw + 4)}_${Math.floor(i / c) * (ch + 4)}`).join('|');
  const graph =
    n === 1 ? `${parts[0]};[t0]copy[s]` : `${parts.join(';')};${hits.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black[s]`;
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', ...hits.flatMap((h) => ['-i', path.join(dir, h.thumb)]), '-filter_complex', graph, '-map', '[s]', '-frames:v', '1', '-q:v', '5', out],
    {
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) throw new Error(`contact sheet: ${r.stderr.slice(-300)}`);
  return { width: c * (cw + 4), height: rows * (ch + 4) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string, d: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args.splice(i, 2)[1] as string) : d;
  };
  const dbFile = opt('db', path.join(WORK_DIR, 'index.db'));
  const model = opt('model', 'siglip-b16:q8:pad');
  const k = Number(opt('k', '6'));
  const sheet = opt('sheet', '');
  const q = args.join(' ');
  const p = parseQuery(q);
  const { loadEmbedder } = await import('./embed.ts');
  const [key, dtype, fit] = model.split(':') as [string, Dtype, Fit];
  void fit;
  const e: Embedder = await loadEmbedder(key, dtype, 4, { vision: false });
  const ix = loadIndex(dbFile, model);
  // the description alone: "a photo of …" around it didn't help SigLIP (RESULTS.md)
  const qv = p.semantic ? ((await e.texts([p.semantic]))[0] as Float32Array) : null;
  const hits = search(ix, qv, p, { k });
  console.log(compactList(hits, p, ix.shots.length));
  if (sheet) {
    const { width, height } = contactSheet(hits, ix.dir, sheet);
    console.log(`sheet ${sheet} ${width}×${height}`);
  }
}
