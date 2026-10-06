// How far people watched a video, in coarse pieces: every version is cut into 100 equal parts (the hundredths of its
// length), and a player reports which parts played and how often, never the moments themselves. Review links' visitors
// (the guest player) and the team (the owner's player, lib/views.ts) report the same way. The same code runs in the
// players (collecting) and on the server (merging, summing up for Insights), so it has no Node imports.
import type { ShareWatch } from './types.ts';

/** Parts per version. */
export const PARTS = 100;
/** 100 bits as hex: 25 digits. */
const DIGITS = PARTS / 4;
export const SEEN_PATTERN = /^[0-9a-f]{25}$/;
/** Seconds one report may add (the player reports every 15 s; a tab that slept can't claim an hour). */
export const MAX_SECS_PER_REPORT = 120;
/** Times one report may say a part played (a 15 s report of a looping 1 s stretch can't claim more). */
export const MAX_PLAYS_PER_REPORT = 60;
/** A part's play count stops here: enough to tell a stretch watched over and over from one seen once. */
export const MAX_PLAYS = 999;
/** A report this long after the last one starts a new sitting (how often someone watched). */
export const SESSION_GAP_MS = 30 * 60_000;

/** The part a moment falls in: 0 … PARTS − 1. */
export function partOf(time: number, duration: number): number {
  if (!(duration > 0) || !(time >= 0)) return 0;
  return Math.min(PARTS - 1, Math.floor((time / duration) * PARTS));
}

/** Parts as 25 hex digits: part i is bit (i % 4) of digit ⌊i / 4⌋, digits left to right. */
export function encodeParts(parts: Iterable<number>): string {
  const digits = new Array<number>(DIGITS).fill(0);
  for (const p of parts) if (Number.isInteger(p) && p >= 0 && p < PARTS) digits[p >> 2] |= 1 << (p & 3);
  return digits.map((d) => d.toString(16)).join('');
}

export function decodeParts(seen: string | undefined | null): number[] {
  if (!seen || !SEEN_PATTERN.test(seen)) return [];
  const out: number[] = [];
  for (let i = 0; i < DIGITS; i++) {
    const d = Number.parseInt(seen[i] as string, 16);
    for (let b = 0; b < 4; b++) if (d & (1 << b)) out.push(i * 4 + b);
  }
  return out;
}

/** Parts either of two reports saw. */
export function orParts(a: string | undefined | null, b: string | undefined | null): string {
  const x = a && SEEN_PATTERN.test(a) ? a : '0'.repeat(DIGITS);
  const y = b && SEEN_PATTERN.test(b) ? b : '0'.repeat(DIGITS);
  let out = '';
  for (let i = 0; i < DIGITS; i++) out += (Number.parseInt(x[i] as string, 16) | Number.parseInt(y[i] as string, 16)).toString(16);
  return out;
}

/** Share of the version that played: 0 … 1. */
export const watchedOf = (seen: string | undefined | null): number => decodeParts(seen).length / PARTS;

/**
 * How often each part played in one report, as PARTS whole numbers. Players that count send `plays`; older ones only
 * say which parts played, which counts each of them once.
 */
export function playsOfReport(seen: string, plays?: readonly number[] | null): number[] {
  const out = new Array<number>(PARTS).fill(0);
  if (plays && plays.length === PARTS) {
    for (let i = 0; i < PARTS; i++) out[i] = Math.max(0, Math.min(MAX_PLAYS_PER_REPORT, Math.floor(Number(plays[i]) || 0)));
    return out;
  }
  for (const p of decodeParts(seen)) out[p] = 1;
  return out;
}

/** Two play counts added up, each part capped at MAX_PLAYS. */
export function addPlays(a: readonly number[] | undefined | null, b: readonly number[]): number[] {
  return Array.from({ length: PARTS }, (_, i) => Math.min(MAX_PLAYS, (a?.[i] || 0) + (b[i] || 0)));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * One viewer's report folded into what they watched of a video. A newer version starts over (what they saw of the
 * old one says nothing about the new); a report about an older version than the one on record is dropped. Across
 * versions the record keeps how long and how often they watched the video at all (`total_secs`, `total_sessions`).
 */
export function mergeWatch(
  prev: ShareWatch | undefined,
  r: { v: number; seen: string; secs: number; at: string; name?: string | null; plays?: readonly number[] | null },
): ShareWatch | undefined {
  if (prev && r.v < prev.v) return prev;
  const same = prev && prev.v === r.v;
  const secs = Math.max(0, Math.min(MAX_SECS_PER_REPORT, Number.isFinite(r.secs) ? r.secs : 0));
  // A sitting: reports closer together than SESSION_GAP_MS are one (the player reports every 15 s while it plays).
  const sitting = !prev || Date.parse(r.at) - Date.parse(prev.last) > SESSION_GAP_MS;
  // Records from before sittings were counted were one sitting at least.
  const sessionsBefore = same ? (prev.sessions ?? 1) : 0;
  const totalBefore = prev ? (prev.total_sessions ?? prev.sessions ?? 1) : 0;
  return {
    v: r.v,
    seen: orParts(same ? prev.seen : null, r.seen),
    secs: round1((same ? prev.secs : 0) + secs),
    last: r.at,
    name: r.name || prev?.name || null,
    plays: addPlays(same ? prev.plays : null, playsOfReport(r.seen, r.plays)),
    sessions: sessionsBefore + (sitting || !same ? 1 : 0),
    first: prev ? (prev.first ?? prev.last) : r.at,
    total_secs: round1((prev ? (prev.total_secs ?? prev.secs) : 0) + secs),
    total_sessions: totalBefore + (sitting ? 1 : 0),
  };
}

/** How often each part of one version played, summed over its viewers: PARTS numbers, or none when nobody watched it. */
export function playsOf(watches: ShareWatch[], v: number): number[] {
  const on = watches.filter((w) => w.v === v);
  if (!on.length) return [];
  let sum = new Array<number>(PARTS).fill(0);
  for (const w of on) sum = addPlays(sum, w.plays?.length === PARTS ? w.plays : playsOfReport(w.seen));
  return sum;
}

/** Share of the viewers (0 … 1) who played each part: the retention curve. Empty without viewers. */
export function retentionOf(watches: ShareWatch[], v: number): number[] {
  const heat = heatOf(watches, v);
  const n = watches.filter((w) => w.v === v).length;
  return heat.map((h) => Math.round((h / n) * 1000) / 1000);
}

/**
 * Stretches watched again and again: runs of parts that played at least `min` times as often, per viewer who saw them,
 * as the video usually did (the median part) — and at least `min` times per viewer. Someone watching the whole video
 * twice rewatched nothing in particular; going over one stretch three times is what this finds. Hundredths, `to`
 * inclusive.
 */
export function rewatchedOf(plays: readonly number[], heat: readonly number[], min = 2): { from: number; to: number; plays: number }[] {
  const out: { from: number; to: number; plays: number }[] = [];
  const per = (i: number) => ((heat[i] || 0) > 0 ? (plays[i] || 0) / (heat[i] as number) : 0);
  const seen = Array.from({ length: PARTS }, (_, i) => per(i))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  if (!seen.length) return out;
  const usual = seen[Math.floor((seen.length - 1) / 2)] as number;
  const bar = Math.max(min, min * usual);
  let run: { from: number; to: number; plays: number } | null = null;
  for (let i = 0; i < PARTS; i++) {
    const again = (heat[i] || 0) > 0 && per(i) >= bar;
    if (again) {
      if (run && run.to === i - 1) {
        run.to = i;
        run.plays = Math.max(run.plays, plays[i] || 0);
      } else {
        run = { from: i, to: i, plays: plays[i] || 0 };
        out.push(run);
      }
    }
  }
  return out;
}

/** How many visitors played each part of one version: PARTS numbers, or none when nobody watched it. */
export function heatOf(watches: ShareWatch[], v: number): number[] {
  const on = watches.filter((w) => w.v === v);
  if (!on.length) return [];
  const heat = new Array<number>(PARTS).fill(0);
  for (const w of on) for (const p of decodeParts(w.seen)) heat[p] += 1;
  return heat;
}

/** The furthest one visitor got through one version (0 … 1), or null when nobody watched it. */
export function bestWatched(watches: ShareWatch[], v: number): number | null {
  const on = watches.filter((w) => w.v === v);
  return on.length ? Math.max(...on.map((w) => watchedOf(w.seen))) : null;
}
