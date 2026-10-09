// What is said in a render, on its frames: the words an engine heard (lib/transcripts.ts runs it) mapped to the frames
// they are heard on, grouped into lines to read, exported as SRT/VTT, compared between two versions, and the one line
// a text edit ("change these words") reads as for an agent. Shared with the browser: no Node imports.
import { formatSeconds } from './range.ts';
import { oneLine, timecode, timeToFrame } from './time.ts';
import type { FrameRange, TextEdit, Transcript, TranscriptLine, TranscriptRepair, TranscriptWord } from './types.ts';

// 2: invented lines dropped and collapsed windows heard again (lib/stt/collapse.ts) — older transcripts may miss speech,
// so they are heard again the next time someone asks.
// 3: a render longer than half an hour is heard to its end (lib/stt hears long audio in windows). A version-2 transcript
// of a render that long stopped there and is heard again; a shorter one is complete and kept (lib/transcripts.ts).
export const TRANSCRIPT_VERSION = 3;

/** What an engine gives back: timed words when it can, else only timed segments (sentences). Seconds. */
export interface HeardWord {
  text: string;
  t0: number;
  t1: number;
}
export interface Heard {
  words: HeardWord[];
  segments: HeardWord[];
  language: string;
  engine: string;
  /** Set when `words` mix engine-timed and spread words ('line'); absent: words are engine-timed when there are any. */
  timing?: Transcript['timing'];
  repairs?: TranscriptRepair[];
}

// A line ends at a sentence's end, at a pause, or when it gets long (at a comma first).
const PAUSE = 0.7;
const SOFT_MAX = 12;
const HARD_MAX = 18;

/** The frame a moment is heard on: the one on screen at `t` (timeToFrame), inside the render. */
const frameAt = (t: number, fps: number, frames: number) => Math.min(Math.max(0, frames - 1), timeToFrame(Math.max(0, t), fps));

/** Words spread over a segment by their length: engines that time only sentences (Whisper in transcribe.cpp). */
export function spreadWords(seg: HeardWord): HeardWord[] {
  const parts = seg.text.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const weights = parts.map((p) => p.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, seg.t1 - seg.t0);
  let at = seg.t0;
  return parts.map((text, i) => {
    const t0 = at;
    at += (span * weights[i]) / total;
    return { text, t0, t1: i === parts.length - 1 ? seg.t1 : at };
  });
}

/** A transcript on a render's frames: `fps`/`frames` of the version it was heard in. */
// Words an engine invents on music, noise or a language it didn't expect: a broken character, or letters of two
// scripts in one word ("Doorщ", "das样"). Japanese mixes kanji and kana in a word; that is one script here.
const SCRIPTS: RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
];
export function garbled(word: string): boolean {
  if (word.includes('\uFFFD')) return true;
  let n = 0;
  for (const re of SCRIPTS) if (re.test(word) && ++n > 1) return true;
  return false;
}

export function buildTranscript(heard: Heard, meta: { hash: string; fps: number; frames: number }, created: string): Transcript {
  const timed = heard.words.filter((w) => w.text.trim());
  const timing: Transcript['timing'] = heard.timing ?? (timed.length ? 'word' : 'line');
  const source = timed.length ? timed : heard.segments.flatMap(spreadWords);
  const words: TranscriptWord[] = source
    .map((w) => ({ text: w.text.trim(), t0: round(w.t0), t1: round(Math.max(w.t0, w.t1)) }))
    .filter((w) => w.text && !garbled(w.text))
    .map((w) => {
      const f0 = frameAt(w.t0, meta.fps, meta.frames);
      // the last frame it is still heard on: the one on screen just before it ends
      const f1 = Math.max(f0, frameAt(w.t1 - 0.001, meta.fps, meta.frames));
      return { ...w, f0, f1 };
    });
  return {
    transcript_version: TRANSCRIPT_VERSION,
    hash: meta.hash,
    language: heard.language || '',
    engine: heard.engine,
    timing,
    fps: meta.fps,
    frames: meta.frames,
    words,
    lines: linesOf(words),
    created,
    ...(heard.repairs?.length ? { repairs: heard.repairs } : {}),
  };
}

const round = (t: number) => Math.round(t * 1000) / 1000;

/** Reading lines: a new one after a sentence's end or a pause, or when a line gets long. */
export function linesOf(words: TranscriptWord[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const n = i - start + 1;
    const end = !next || /[.!?…]["»”’)]*$/.test(w.text) || next.t0 - w.t1 >= PAUSE || (n >= SOFT_MAX && /[,;:–—]$/.test(w.text)) || n >= HARD_MAX;
    if (!end) continue;
    const ws = words.slice(start, i + 1);
    out.push({ text: ws.map((x) => x.text).join(' '), t0: ws[0].t0, t1: w.t1, f0: ws[0].f0, f1: w.f1, w0: start, n: ws.length });
    start = i + 1;
  }
  return out;
}

/** The word heard on `frame` (or the last one before it), -1 before the first. */
export function wordAt(t: Pick<Transcript, 'words'>, frame: number): number {
  let lo = 0;
  let hi = t.words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.words[mid].f0 <= frame) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Words a to b (either order): what they say and where they are heard. */
export function wordsSpan(t: Pick<Transcript, 'words'>, a: number, b: number): { text: string; range: FrameRange } | null {
  const i = Math.max(0, Math.min(a, b));
  const j = Math.min(t.words.length - 1, Math.max(a, b));
  if (i > j || !t.words[i]) return null;
  const ws = t.words.slice(i, j + 1);
  return { text: ws.map((w) => w.text).join(' '), range: { in: ws[0].f0, out: ws[ws.length - 1].f1 } };
}

// ---------------------------------------------------------------- captions

const clock = (t: number, sep: ',' | '.') => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
};

/** SubRip captions, one cue per line. */
export function toSrt(t: Pick<Transcript, 'lines'>): string {
  return t.lines.map((l, i) => `${i + 1}\n${clock(l.t0, ',')} --> ${clock(l.t1, ',')}\n${oneLine(l.text)}\n`).join('\n');
}

/** WebVTT captions, one cue per line. */
export function toVtt(t: Pick<Transcript, 'lines'>): string {
  return `WEBVTT\n\n${t.lines.map((l) => `${clock(l.t0, '.')} --> ${clock(l.t1, '.')}\n${oneLine(l.text)}\n`).join('\n')}`;
}

// ---------------------------------------------------------------- what changed between two versions

export interface WordChange {
  op: 'same' | 'del' | 'add';
  text: string;
  /** Frames in the version the words are in (the older one for 'del', the newer one otherwise). */
  f0: number;
  f1: number;
}

/** One word of a comparison: kept, removed (a word of the older version) or added; `i` is its index in its version. */
export interface WordOp {
  op: WordChange['op'];
  w: TranscriptWord;
  i: number;
}

/** A word as compared and searched: without case and punctuation. */
export const normWord = (w: string): string =>
  w
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Word by word, what the newer version says differently (a longest common subsequence on the words without case and
 * punctuation). */
export function diffWords(a: Pick<Transcript, 'words'>, b: Pick<Transcript, 'words'>): WordOp[] {
  const x = a.words.map((w) => normWord(w.text));
  const y = b.words.map((w) => normWord(w.text));
  const n = x.length;
  const m = y.length;
  // lengths of the common tail from (i, j), one row at a time would lose the path: a full table (a few thousand words)
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: WordOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', w: b.words[j], i: j });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: 'del', w: a.words[i], i: i++ });
    else out.push({ op: 'add', w: b.words[j], i: j++ });
  }
  while (i < n) out.push({ op: 'del', w: a.words[i], i: i++ });
  while (j < m) out.push({ op: 'add', w: b.words[j], i: j++ });
  return out;
}

/** What the newer version says differently, as runs of kept, removed and added words. */
export function diffTranscripts(a: Pick<Transcript, 'words'>, b: Pick<Transcript, 'words'>): WordChange[] {
  const out: WordChange[] = [];
  for (const { op, w } of diffWords(a, b)) {
    const last = out.at(-1);
    if (last && last.op === op) {
      last.text += ` ${w.text}`;
      last.f1 = w.f1;
    } else out.push({ op, text: w.text, f0: w.f0, f1: w.f1 });
  }
  return out;
}

/** The line a word of the transcript is in (-1 for none). */
export function lineOfWord(t: Pick<Transcript, 'lines'>, i: number): number {
  if (i < 0) return -1;
  let lo = 0;
  let hi = t.lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = t.lines[mid];
    if (i < l.w0) hi = mid - 1;
    else if (i >= l.w0 + l.n) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The newer version's lines, each with its words of the comparison: a removed word sits in the line of the word that
 * follows it ("Coffee" → "Tea" starts the line Tea is in; at the very end, in the last line). `line` is null only when
 * nothing is said any more. */
export function linesOfDiff(b: Pick<Transcript, 'lines'>, ops: WordOp[]): { line: TranscriptLine | null; ops: WordOp[] }[] {
  if (!b.lines.length) return ops.length ? [{ line: null, ops }] : [];
  const groups = b.lines.map((line) => ({ line, ops: [] as WordOp[] }));
  const removed: WordOp[] = [];
  for (const o of ops) {
    if (o.op === 'del') removed.push(o);
    else groups[Math.max(0, lineOfWord(b, o.i))].ops.push(...removed.splice(0), o);
  }
  groups[groups.length - 1].ops.push(...removed);
  return groups;
}

// ---------------------------------------------------------------- for people

/**
 * The engine that heard it, as people say it: `local:whisper-turbo` → "Whisper turbo", `local:parakeet-v3` →
 * "Parakeet", `http:whisper-1` → "Whisper". A model given as a file is named by the file, never its folder.
 */
export function engineName(engine: string): string {
  const model = (engine.includes(':') ? engine.slice(engine.indexOf(':') + 1) : engine)
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(gguf|bin)$/i, '')
    .replace(/^ggml-/i, '')
    .replace(/[-_.]q\d\w*$/i, '');
  if (!model) return engine;
  if (/parakeet/i.test(model)) return 'Parakeet';
  if (/qwen3-asr/i.test(model)) return 'Qwen3-ASR';
  if (/^whisper-1$/i.test(model)) return 'Whisper';
  if (/^whisper.*turbo/i.test(model)) return 'Whisper turbo';
  const words = model.split(/[-_]/).filter(Boolean);
  if (!words.length) return engine;
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

// ---------------------------------------------------------------- for agents

/** The one line a text edit reads as in every format agents read (lampo watch, INBOX.md, lampo prompt, the MCP notes):
 * `CHANGE WORDS "from" → "to" at 00:03:12–00:03:15 (f96–f105)`. People's words never break the line. */
export function textEditLine(edit: TextEdit, where: { frame: number; range: FrameRange | null }, fps: number): string {
  const at = where.range
    ? `${timecode(where.range.in, fps)}–${timecode(where.range.out, fps)} (f${where.range.in}–f${where.range.out}, ${formatSeconds((where.range.out - where.range.in + 1) / fps)})`
    : `${timecode(where.frame, fps)} (f${where.frame})`;
  return `CHANGE WORDS "${oneLine(edit.from)}" → "${oneLine(edit.to)}" at ${at}`;
}

/** Text edits are short: a few words either side, bounded like a note. */
export const TEXT_EDIT_MAX = 2000;
