// Long audio is heard in windows that overlap (lib/stt/index.ts pcmWindows), so what is said across the end of one
// window is heard whole by the next. What both heard is kept once: each seam is cut at one moment inside the overlap,
// and a word goes to the window its middle lies on the side of. The moment is a gap neither window hears a word in when
// there is one; else a boundary between one window's words that the other's words cross least; else the overlap's
// middle. A copy its own window's edge cut (the earlier window's last word, running to where it ends; the later one's
// first, starting where it starts) has its middle on the far side of that moment, so the copy kept is the one heard
// whole. A sound longer than the overlap is cut by both edges: both pieces are kept, as one word when they read the
// same. Engines that time only sentences have their words spread over them first (lib/stt/index.ts), so a seam is cut
// between words, never inside a sentence one window heard only half of. Times are on the file's clock, in seconds.
// No Node imports.

export interface Span {
  t0: number;
  t1: number;
}

/** A window: where its audio starts and ends on the file's clock, and the words it heard. */
export interface HeardWindow<T extends Span> {
  from: number;
  end: number;
  words: T[];
}

/** How close to its window's edge a piece must end (or start) to count as cut by it. */
const AT_EDGE = 0.25;

const middle = (s: Span) => (s.t0 + s.t1) / 2;

/**
 * The moment the seam between two windows that overlap from `lo` to `hi` is cut at, looked for in the overlap's middle
 * half: a gap neither window hears a word in (the widest; touching words leave one of no width); else a boundary
 * between one window's words where the other window's words cross it least; else the overlap's middle.
 */
export function seamCut(earlier: { words: Span[] }, later: { words: Span[] }, lo: number, hi: number): number {
  const a = lo + (hi - lo) / 4;
  const b = hi - (hi - lo) / 4;
  const mid = (lo + hi) / 2;
  const better = (best: { at: number; score: number } | null, at: number, score: number) =>
    !best || score > best.score || (score === best.score && Math.abs(at - mid) < Math.abs(best.at - mid)) ? { at, score } : best;

  // a gap in both: the widest, nearest the middle
  let gap: { at: number; score: number } | null = null;
  let at = a;
  for (const s of [...earlier.words, ...later.words, { t0: b, t1: b }].sort((x, y) => x.t0 - y.t0)) {
    const to = Math.min(s.t0, b);
    if (to >= at && at <= b) gap = better(gap, (at + to) / 2, to - at);
    at = Math.max(at, s.t1);
  }
  if (gap) return gap.at;

  // a boundary of one window's words, where the other's cross it least (by the shorter side of the word it cuts)
  const inside = (words: Span[], p: number) => words.some((s) => s.t0 < p && p < s.t1);
  const crossing = (words: Span[], p: number) => Math.max(0, ...words.filter((s) => s.t0 < p && p < s.t1).map((s) => Math.min(p - s.t0, s.t1 - p)));
  let edge: { at: number; score: number } | null = null;
  for (const [own, other] of [
    [earlier.words, later.words],
    [later.words, earlier.words],
  ] as const)
    for (const p of own.flatMap((s) => [s.t0, s.t1])) if (p >= a && p <= b && !inside(own, p)) edge = better(edge, p, -crossing(other, p));
  return edge ? edge.at : mid;
}

/**
 * Where each seam is cut: one moment per pair of neighbouring windows, null where they don't overlap (a silent window
 * between them was left out).
 */
export function seamCuts<T extends Span>(windows: readonly HeardWindow<T>[]): (number | null)[] {
  return windows.slice(1).map((after, i) => {
    const before = windows[i] as HeardWindow<T>;
    return after.from < before.end ? seamCut(before, after, after.from, before.end) : null;
  });
}

/** What window `i` keeps of `list`: what has its middle between the seams on either side of it. */
export function keptBetween<T extends Span>(list: readonly T[], cuts: readonly (number | null)[], i: number): T[] {
  const from = i > 0 ? cuts[i - 1] : null;
  const until = cuts[i] ?? null;
  return list.filter((s) => (from == null || middle(s) >= from) && (until == null || middle(s) < until));
}

/**
 * Every window's words, each kept once: by `keptBetween`, and where a seam's earlier window kept a word its end cut and
 * the later one kept a word its start cut that overlap (a sound longer than the overlap), as one word from the first's
 * start to the second's end when they read the same; else both stay.
 */
export function joinWords<T extends Span & { text: string }>(windows: readonly HeardWindow<T>[], cuts: readonly (number | null)[]): T[] {
  const kept = windows.map((w, i) => keptBetween(w.words, cuts, i));
  for (let i = 1; i < windows.length; i++) {
    const before = windows[i - 1] as HeardWindow<T>;
    const after = windows[i] as HeardWindow<T>;
    const mine = kept[i] as T[];
    const theirs = kept[i - 1] as T[];
    if (cuts[i - 1] == null) continue;
    const last = theirs.at(-1);
    const first = mine[0];
    if (!last || !first || last.t1 < before.end - AT_EDGE || first.t0 > after.from + AT_EDGE || first.t0 >= last.t1) continue;
    if (last.text.trim() !== first.text.trim()) continue;
    theirs[theirs.length - 1] = { ...last, t1: Math.max(last.t1, first.t1) };
    mine.shift();
  }
  return kept.flat();
}
