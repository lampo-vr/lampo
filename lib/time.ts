// Frame/timecode math. Shared by server, CLI and browser, so no Node imports here.
import type { CommentStatus, NoteKind, Severity } from './types.ts';

// Frame N covers [N/fps, (N+1)/fps). t = start of the frame.
export const frameToTime = (frame: number, fps: number): number => Math.round((frame / fps) * 1000) / 1000;
// t is stored rounded to the millisecond, so allow half a millisecond of slack (frame 1 @30fps → 0.033 s → frame 1).
export const timeToFrame = (t: number, fps: number): number => Math.max(0, Math.floor(t * fps + 0.0005 * fps + 1e-6));
// Seek target in the middle of a frame so the browser never lands on the neighbour.
export const frameSeekTime = (frame: number, fps: number): number => (frame + 0.5) / fps;
// The frame a requestVideoFrameCallback says is on screen. Chrome and WebKit give the presented frame's own start
// (N / fps, give or take the container's timebase); Firefox gives the time the element was seeked to — the middle of
// the frame, (N + 0.5) / fps. Flooring with a twentieth of a frame of slack reads both as N; rounding read Firefox's
// middle as N + 1, and the paused player kept "healing" a mismatch that wasn't there (the picture rocked by a frame).
export const presentedFrame = (mediaTime: number, fps: number): number => Math.max(0, Math.floor(mediaTime * fps + 0.05));

/**
 * Orders ISO 8601 timestamps by the instant they name. Stored times carry different offsets (`isoLocal` writes the
 * writing machine's own, some fields are UTC), so comparing the strings goes wrong as soon as offsets differ, e.g. a
 * store moved from a laptop into a UTC container, or the hour the clocks go back. Missing or unreadable times sort
 * first.
 */
export function compareTime(a: string | null | undefined, b: string | null | undefined): number {
  const x = instant(a);
  const y = instant(b);
  return x === y ? 0 : x < y ? -1 : 1;
}
/** The instant an ISO 8601 time names, in ms; missing or unreadable: -Infinity (so it sorts first). */
export const instant = (t: string | null | undefined): number => {
  const ms = t ? Date.parse(t) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

// mm:ss:ff at the real fps ("00:12:03" = 12 s + 3 frames). Hours are prefixed only when needed.
/**
 * Where render frame N sits on the timeline of the project it was rendered from (Version.source): seconds and the
 * project's frame. Null when the render's source is unknown.
 */
export function compTime(ver: { fps: number; source?: { start_frame?: number; fps?: number } }, frame: number): { seconds: number; frame: number } | null {
  if (!ver.source) return null;
  const fps = ver.source.fps || ver.fps;
  const seconds = frame / ver.fps + (ver.source.start_frame || 0) / fps;
  return { seconds: Math.round(seconds * 1e6) / 1e6, frame: timeToFrame(seconds, fps) };
}

export function timecode(frame: number, fps: number): string {
  const sec = Math.floor((frame + 1e-6) / fps);
  const ff = frame - Math.ceil(sec * fps - 1e-6);
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${p(m)}:${p(s)}:${p(ff)}`;
}

// Parses "12.1", "12.1s", "00:12:03" (mm:ss:ff), "1:00:12:03" (h:mm:ss:ff) or "f363" into a frame number.
export function parseFramePosition(str: string | number, fps: number): number | null {
  const s = String(str).trim();
  if (/^f?\d+$/.test(s) && s.startsWith('f')) return parseInt(s.slice(1), 10);
  if (/^\d+(\.\d+)?s?$/.test(s)) return timeToFrame(parseFloat(s), fps);
  const parts = s.split(':').map((x) => parseInt(x, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3 || parts.length === 4) {
    const [h, m, sec, ff] = parts.length === 4 ? parts : [0, ...parts];
    return Math.ceil((h * 3600 + m * 60 + sec) * fps - 1e-6) + ff;
  }
  return null;
}

/** A timecode written in someone's text: where it is in the text and the frame it names. */
export interface TimecodeMention {
  /** Index of its first character in the text, and one past its last. */
  start: number;
  end: number;
  /** The words as written ("0:28:20"). */
  text: string;
  frame: number;
}

// Timecodes as the app writes them — mm:ss:ff, with hours h:mm:ss:ff — and the short forms people and agents type
// ("0:28:20"). Not part of a longer run of digits and colons or decimals ("12:30:00:00:00", "1.12:03:04").
const TIMECODE_IN_TEXT = /(?<![\d:.])(?:\d{1,2}:)?\d{1,2}:\d{2}:\d{2}(?![\d:]|\.\d)/g;

/**
 * The timecodes written in a text that name a frame of a render with these fps and frames: seconds and minutes under
 * 60, frames under the frame rate, inside the render. What doesn't fit ("10:30:00" in a 20-second video — a time of
 * day more likely) stays plain text.
 */
export function timecodesIn(text: string, fps: number, frames = Number.POSITIVE_INFINITY): TimecodeMention[] {
  const out: TimecodeMention[] = [];
  if (!text || !(fps > 0)) return out;
  const perSecond = Math.ceil(fps - 1e-6);
  for (const m of text.matchAll(TIMECODE_IN_TEXT)) {
    const parts = m[0].split(':').map(Number);
    const [h, min, sec, ff] = parts.length === 4 ? parts : [0, ...parts];
    if ((parts.length === 4 && min >= 60) || sec >= 60 || ff >= perSecond) continue;
    const frame = Math.ceil((h * 3600 + min * 60 + sec) * fps - 1e-6) + ff;
    if (frame >= frames) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], frame });
  }
  return out;
}

/** The frame a render's poster shows (lib/media.ts), and the moment a preview opens on when nothing names one. */
export const posterFrame = (ver: { frames: number; duration: number; fps: number }): number =>
  Math.max(0, Math.min(ver.frames - 1, Math.round(Math.min(ver.duration * 0.15, 3) * ver.fps)));

export const fmtDuration = (sec: number): string => {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
};

/** "just now", "5 min ago", "2 h ago", "3 d ago", then the date ("28 Sep"): how long ago an ISO time was. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  if (min < 7 * 24 * 60) return `${Math.floor(min / (24 * 60))} d ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const TAGS = ['cut', 'timing', 'freeze', 'text/typo', 'layout/overlap', 'color/grade', 'audio/music', 'sfx', 'graphic', 'idea', 'love-it'];
export const SEVERITIES: readonly Severity[] = ['must', 'should', 'nice', 'idea'];
export const NOTE_KINDS: readonly NoteKind[] = ['feedback', 'question', 'info'];
export const STATUSES: readonly CommentStatus[] = ['open', 'fixed', 'verified', 'wontfix'];
export const isAgent = (by: unknown): boolean => typeof by === 'string' && by.startsWith('agent');
/** A client on a review link wrote it (`guest:<name>`). */
export const isClient = (by: unknown): boolean => typeof by === 'string' && by.startsWith('guest:');
/** The flag on a client's note in what agents read (MCP note lines, `lampo open` / `lampo show`): what an agent writes on it —
 * a reply, the fix note — reaches the client as written, through every review link that shows the note (A12 GUEST-7). */
export const CLIENT_NOTE_FLAG = 'CLIENT: they read your replies and fix note as written';
export const isSeverity = (x: unknown): x is Severity => (SEVERITIES as readonly unknown[]).includes(x);
export const isStatus = (x: unknown): x is CommentStatus => (STATUSES as readonly unknown[]).includes(x);
export const isNoteKind = (x: unknown): x is NoteKind => (NOTE_KINDS as readonly unknown[]).includes(x);

// Every line terminator some reader splits on: CR LF, LF, CR, VT, FF, the file/group/record separators (Python's
// splitlines), NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR (Unicode, JavaScript).
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the line terminators readers split on
const LINE_BREAK = /\r\n|[\n\v\f\r\u001c-\u001e\u0085\u2028\u2029]/g;

/**
 * Text from people (notes, replies, verdicts, captions, names) in the formats agents read line by line: `lampo watch`,
 * INBOX.md, review.md, `lampo prompt`, the MCP notes. A line break of any kind stays visible (↵) but never starts a line
 * of its own, so what a client types can't read as a note of its own; other control characters become spaces.
 */
export const oneLine = (s: string): string => s.replace(LINE_BREAK, ' ↵ ').replace(/\p{Cc}/gu, ' ');

// The line terminators that are never ours: our formats end a line with \n, and only \n.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the line terminators readers split on
const NOT_OUR_BREAK = /[\v\f\r\u001c-\u001e\u0085\u2028\u2029]/g;

/**
 * Text whose lines are ours (a tool's answer, a `lampo` command's output, INBOX.md) as it leaves: `\n` ends a line and
 * nothing else does. A terminator that came in with a name or a text nobody passed through `oneLine` becomes its
 * `\uXXXX` escape: no line of its own in any reader, and in JSON the same string as before (JSON escapes the others).
 */
export const keepLines = (s: string): string => s.replace(NOT_OUR_BREAK, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * An error as a terminal shows it (`lampo`'s stderr): `keepLines`, a tab as a space, and no other control character — an
 * escape sequence in an error built from outside text (a bundle's record key) could retitle the window, hide what
 * follows or forge it (sweep 2 SW-5).
 */
export const terminalText = (s: string): string =>
  keepLines(s)
    .replace(/\t/g, ' ')
    .replace(/(?!\n)\p{Cc}/gu, '');

// ---------------------------------------------------------------- what a note is

interface NoteLike {
  kind?: NoteKind;
  severity: Severity;
  author: string;
}

/** A note's kind as it reads: `agent` for notes agents wrote before kinds existed (almost always questions). */
export type NoteLook = NoteKind | 'agent';
export const noteKind = (c: Pick<NoteLike, 'kind' | 'author'>): NoteLook => c.kind ?? (isAgent(c.author) ? 'agent' : 'feedback');
/** Feedback someone has to act on; ideas, questions and info notes are not work. */
export const isRequired = (c: NoteLike): boolean => noteKind(c) === 'feedback' && c.severity !== 'idea';
export const isIdea = (c: NoteLike): boolean => noteKind(c) === 'feedback' && c.severity === 'idea';
/** Waiting for the reviewer: questions, and the kind-less notes agents wrote before. */
export const isQuestion = (c: Pick<NoteLike, 'kind' | 'author'>): boolean => {
  const k = noteKind(c);
  return k === 'question' || k === 'agent';
};
/** List order: must, should, nice, idea, then questions, then info notes. */
export function noteRank(c: NoteLike): number {
  const k = noteKind(c);
  if (k === 'info') return SEVERITIES.length + 1;
  if (k !== 'feedback') return SEVERITIES.length;
  const i = SEVERITIES.indexOf(c.severity);
  return i < 0 ? 1 : i;
}
/** A reviewer closing a question with an answer: printed as ANSWERED instead of VERIFIED. */
export const isAnswer = (e: { status?: CommentStatus; kind?: NoteKind; reply?: { text?: string } | null }): boolean =>
  e.status === 'verified' && e.kind === 'question' && !!e.reply?.text;
/** Where files and CLI lines print the severity: MUST/SHOULD/NICE/IDEA, or QUESTION/INFO for those kinds. */
export const noteLabel = (c: { kind?: NoteKind; severity?: Severity }): string =>
  c.kind === 'question' ? 'QUESTION' : c.kind === 'info' ? 'INFO' : (c.severity || '').toUpperCase();
