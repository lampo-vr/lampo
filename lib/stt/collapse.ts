// Whisper hears a render in 30-second windows. A window that opens on music sometimes collapses: the decoder writes a
// subtitle credit it learned from the web ("Svensktextning.nu") or a word or two, stretches that over the whole window,
// and the speech in it is gone — the next line starts at 30.00. This file finds such stretches and hears them again.
//
//  1. Invented lines go (lib/stt/hallucinations.ts): credits and sound tags always, a "thanks for watching" when it is
//     stretched over far more time than it takes to say.
//  2. Suspect stretches: at least MIN_STRETCH seconds where Whisper heard fewer than DENSE words a second.
//  3. A second listener (Parakeet, when its model is already on disk) hears each suspect stretch. Clearly more words
//     than Whisper kept → collapsed: Whisper hears it again, cut from just before the second listener's first word (a
//     window that opens on speech doesn't collapse); if that still comes back far too short, the second listener's own
//     words fill the stretch (timed per word). Nothing heard → music, left alone — unless Whisper wrote a credit there
//     (a voice the second listener can't make out), then as without one:
//  4. Whisper alone hears the stretch again with its first line free to start late (`lateStart`); after a collapse's
//     marks (a credit, a stray word or two) also from every SWEEP seconds into the window, the earliest cut that works.
//     Kept only when it is plainly speech — clearly more words than before, at a speaking pace.
// Whisper's first pass on such a window is luck as much as audio: its temperature fallback samples, and the same clip
// collapses on one run and not the next (bench/stt/RESULTS.md). Hence a repair, not a better first pass.
// Pure orchestration: the engine calls come in as functions (lib/stt/index.ts wires the worker; tests a stand-in).
import { garbled, spreadWords } from '../transcript.ts';
import type { TranscriptRepair } from '../types.ts';
import { countWords, type Dropped, dropHallucinations, type Timed } from './hallucinations.ts';
import { isSilent, type SttResult } from './policy.ts';

export type { Timed };

/** A stretch heard again: whose words fill it now. */
export type Repair = TranscriptRepair;

const RATE = 16000;
/** Suspect stretches are at least this long (a pause between sentences is shorter). */
export const MIN_STRETCH = 5;
/** Words a second below which a stretch counts as hardly heard: speech is 2–3, a first line Whisper pulls back over an
 * 8-second music intro still ~0.65, a collapsed window 0.03–0.2. */
export const DENSE = 0.5;
/** The second listener must hear at least this many words for a stretch to hold speech. */
const MIN_HEARD = 3;
/** Collapsed: Whisper kept less than this share of what the second listener heard. */
const COLLAPSED = 0.5;
/** A re-run is plausible with at least this share of the second listener's words. */
const PLAUSIBLE = 0.5;
/** Without a second listener, a re-run must hear at least this many words to count as speech… */
const MIN_ALONE = 4;
/** …at a speaking pace (words a second over the lines it heard). */
const PACE = 1;
/** Seconds of audio kept before the second listener's first word in a cut. */
const LEAD = 0.5;
/** Whisper alone after a collapse: cuts start this far apart, through the first window of the stretch. */
export const SWEEP = 4;
const WINDOW = 30;

const wordsIn = (list: readonly Timed[]) => list.reduce((n, x) => n + countWords(x.text), 0);
const rateOf = (x: Timed) => countWords(x.text) / Math.max(0.05, x.t1 - x.t0);
const mid = (x: Timed) => (x.t0 + x.t1) / 2;
const byStart = (a: Timed, b: Timed) => a.t0 - b.t0;

export interface Stretch {
  t0: number;
  t1: number;
  /** Words Whisper kept in it. */
  words: number;
}

/** A line of at most this many words next to a gap is a collapse's stray ("0.00–2.00 Zimtschnecken", then nothing). */
const STRAY = 2;

/**
 * Stretches of at least MIN_STRETCH seconds where the lines heard carry fewer than DENSE words a second: gaps between
 * lines, lines stretched over far more time than their words take, stray lines (`lineTimed`: lines are segments, not
 * single words) and runs of them.
 */
export function sparseStretches(lines: readonly Timed[], seconds: number, lineTimed = true): Stretch[] {
  const out: Stretch[] = [];
  let run = null as Stretch | null;
  let cursor = 0;
  const extend = (t0: number, t1: number, words: number) => {
    run ??= { t0, t1, words: 0 };
    run.t1 = Math.max(run.t1, t1);
    run.words += words;
  };
  const close = () => {
    if (run && run.t1 - run.t0 >= MIN_STRETCH) out.push(run);
    run = null;
  };
  for (const l of [...lines].sort(byStart)) {
    if (l.t0 > cursor) extend(cursor, l.t0, 0);
    const n = countWords(l.text);
    if (rateOf(l) < DENSE || (lineTimed && n <= STRAY)) extend(l.t0, l.t1, n);
    else close();
    cursor = Math.max(cursor, l.t1);
  }
  if (seconds > cursor) extend(cursor, seconds, 0);
  close();
  return out;
}

export interface RepairDeps {
  /** Whisper again on a cut of the audio (times relative to the cut), its first line free to start late. */
  again: (pcm: Float32Array) => Promise<SttResult>;
  /** The second listener's timed words for a cut (relative to it); absent when there is none. */
  second?: (pcm: Float32Array) => Promise<Timed[]>;
  /** The engines, as transcripts name them ("local:whisper-turbo", "local:parakeet-v3"). */
  engine: string;
  secondEngine?: string;
  log?: (m: string) => void;
}

export interface Repaired {
  /** Line-timed (Whisper's segments) when Whisper heard every stretch; else empty. */
  segments: Timed[];
  /** Every word when the second listener filled a stretch (Whisper's lines spread over by length); else as given. */
  words: Timed[];
  /** 'line' when `words` mixes the two: some of them are estimated. */
  timing?: 'line';
  repairs: Repair[];
}

type Piece = Timed & { exact: boolean };

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const cut = (pcm: Float32Array, t0: number, t1: number) => pcm.subarray(Math.max(0, Math.round(t0 * RATE)), Math.min(pcm.length, Math.round(t1 * RATE)));
/** A cut's lines on the file's clock, inside the cut. */
const placed = (list: readonly Timed[], at: number, end: number): Timed[] =>
  list.filter((x) => x.t0 + at < end - 0.05).map((x) => ({ text: x.text, t0: x.t0 + at, t1: Math.min(end, Math.max(x.t0, x.t1) + at) }));
const garbledShare = (list: readonly Timed[]) => {
  const ws = list.flatMap((x) => x.text.split(/\s+/).filter(Boolean));
  return ws.length ? ws.filter((w) => garbled(w)).length / ws.length : 0;
};

/**
 * Whisper's timed result (without invented lines; `dropped` is what went) with its collapsed stretches heard again.
 * `language` is what the first pass detected: a re-run that hears another language is not the same speech. An engine
 * call that fails leaves its stretch as it was.
 */
export async function repairCollapses(
  pcm: Float32Array,
  first: { segments: Timed[]; words: Timed[]; language: string; dropped?: readonly Dropped[] },
  deps: RepairDeps,
): Promise<Repaired> {
  const seconds = pcm.length / RATE;
  const wordTimed = first.words.length > 0;
  const lines = wordTimed ? first.words : first.segments;
  let pieces: Piece[] = lines.map((x) => ({ ...x, exact: wordTimed }));
  const repairs: Repair[] = [];
  const log = deps.log ?? (() => {});
  let second = deps.second;
  const fill = (s: Stretch, list: readonly Timed[], exact: boolean, repair: Repair) => {
    pieces = [...pieces.filter((p) => mid(p) < s.t0 || mid(p) > s.t1), ...list.map((x) => ({ ...x, exact }))].sort(byStart);
    repairs.push({ t0: round(repair.t0), t1: round(repair.t1), engine: repair.engine });
  };
  /** Whisper again on [t0, t1] of the file: its lines on the file's clock, without invented ones; null when it failed
   * or heard another language or garble. */
  const again = async (t0: number, t1: number): Promise<Timed[] | null> => {
    try {
      const r = await deps.again(cut(pcm, t0, t1));
      const list = placed(dropHallucinations(r).segments, t0, t1);
      const sameLanguage = !first.language || !r.language || r.language === first.language;
      return sameLanguage && garbledShare(list) < 0.25 ? list : null;
    } catch (e) {
      log(`speech: hearing ${clock(t0)}–${clock(t1)} again failed: ${(e as Error).message}`);
      return null;
    }
  };

  for (const s of sparseStretches(lines, seconds, !wordTimed)) {
    const audio = cut(pcm, s.t0, s.t1);
    if (isSilent(audio)) continue;
    const span = `${clock(s.t0)}–${clock(s.t1)}`;
    // A collapse leaves marks: an invented credit, or a stray word or two stretched over the window.
    const credit = (first.dropped ?? []).some((d) => d.kind === 'credit' && mid(d) >= s.t0 && mid(d) <= s.t1);
    const marked = credit || s.words > 0;

    let heard: Timed[] | null = null;
    if (second) {
      try {
        heard = placed(await second(audio), s.t0, s.t1).filter((w) => countWords(w.text));
      } catch (e) {
        log(`speech: the second listener failed (${(e as Error).message}); Whisper alone from here`);
        second = undefined;
      }
    }
    const n = heard ? wordsIn(heard) : 0;
    if (heard && n >= MIN_HEARD) {
      if (s.words >= COLLAPSED * n) continue; // Whisper heard it fine
      const c0 = Math.max(s.t0, heard[0].t0 - LEAD);
      const list = await again(c0, s.t1);
      if (list && wordsIn(list) >= PLAUSIBLE * n) {
        fill(s, list, false, { t0: c0, t1: s.t1, engine: deps.engine });
        log(`speech: ${span} had collapsed (${s.words} words kept, a second listener heard ${n}); heard again: ${wordsIn(list)} words`);
      } else {
        fill(s, heard, true, { t0: heard[0].t0, t1: heard[heard.length - 1].t1, engine: deps.secondEngine ?? 'second listener' });
        log(`speech: ${span} had collapsed (${s.words} words kept); filled with the second listener's ${n} words`);
      }
      continue;
    }
    // The second listener hears music: so it is, unless Whisper wrote a credit there (it can't hear every voice).
    if (heard && !credit) continue;

    // Whisper alone: the whole stretch with the first line free to start late; after a collapse's marks also from
    // later starts through its first window, the earliest that works.
    // A later start hears at most a window and a step: a collapse loses one window, and a long stretch is music.
    const starts = [s.t0];
    if (marked) for (let t = s.t0 + SWEEP; t < Math.min(s.t1 - 3, s.t0 + WINDOW - SWEEP / 2); t += SWEEP) starts.push(t);
    for (const start of starts) {
      const end = start === s.t0 ? s.t1 : Math.min(s.t1, start + WINDOW + SWEEP);
      const list = await again(start, end);
      if (!list) continue;
      const got = wordsIn(list);
      const talking = list.reduce((t, x) => t + Math.max(0.05, x.t1 - x.t0), 0);
      if (got >= Math.max(MIN_ALONE, 2 * s.words + 1) && got / talking >= PACE) {
        fill({ ...s, t1: end }, list, false, { t0: start, t1: end, engine: deps.engine });
        log(`speech: ${span} had collapsed (${s.words} words kept); heard again from ${clock(start)}: ${got} words`);
        break;
      }
    }
  }

  if (!repairs.length) return { segments: first.segments, words: first.words, repairs };
  if (pieces.every((p) => !p.exact)) return { segments: strip(pieces), words: [], repairs };
  if (pieces.every((p) => p.exact)) return { segments: [], words: strip(pieces), repairs };
  const words = pieces.flatMap((p) => (p.exact ? [{ text: p.text, t0: p.t0, t1: p.t1 }] : spreadWords(p)));
  return { segments: [], words, timing: 'line', repairs };
}

const round = (t: number) => Math.round(t * 1000) / 1000;
const strip = (list: readonly Piece[]): Timed[] => list.map(({ text, t0, t1 }) => ({ text, t0, t1 }));
