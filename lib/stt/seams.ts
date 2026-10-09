// Long audio is heard in windows that overlap (lib/stt/index.ts pcmWindows), so what is said across the end of one
// window is heard whole by the next. What both heard is kept once: at each seam a moment inside the overlap where
// neither window hears a word is picked — the middle of the widest such gap in the overlap's middle half — and the
// earlier window keeps what starts before it, the later one what starts from it on. A word a window's edge cuts lies
// in the overlap's outer quarters, beyond that moment, so the copy kept is the one heard whole. Times are on the
// file's clock, in seconds. No Node imports.

export interface Span {
  t0: number;
  t1: number;
}

/** A window's speech as heard: timed words when the engine gives them, timed segments always. */
export interface Heard {
  words: Span[];
  segments: Span[];
}

/**
 * The moment the seam between two windows that overlap from `lo` to `hi` is cut at: where neither hears a word (a
 * segment, when neither has words), the widest such gap in the overlap's middle half; with none, the overlap's middle.
 */
export function seamCut(earlier: Heard, later: Heard, lo: number, hi: number): number {
  const a = lo + (hi - lo) / 4;
  const b = hi - (hi - lo) / 4;
  const level = earlier.words.length || later.words.length ? 'words' : 'segments';
  const spans = [...earlier[level], ...later[level]].filter((s) => s.t1 > a && s.t0 < b).sort((x, y) => x.t0 - y.t0);
  let best: [number, number] | null = null;
  let at = a;
  // the gap before each span, and the one after the last (up to b)
  for (const s of [...spans, { t0: b, t1: b }]) {
    const to = Math.min(s.t0, b);
    if (to > at && (!best || to - at > best[1] - best[0])) best = [at, to];
    at = Math.max(at, s.t1);
  }
  return best ? (best[0] + best[1]) / 2 : (lo + hi) / 2;
}

/**
 * Where each window's speech is kept, `[from, until)` by when a word starts: each seam with an overlap is cut at
 * `seamCut`; windows that don't overlap (a silent one between them was left out) keep all they heard.
 */
export function keptStretches(windows: readonly { from: number; end: number; heard: Heard }[]): { from: number; until: number }[] {
  const kept = windows.map(() => ({ from: Number.NEGATIVE_INFINITY, until: Number.POSITIVE_INFINITY }));
  windows.forEach((after, i) => {
    const before = windows[i - 1];
    const mine = kept[i];
    const theirs = kept[i - 1];
    if (!before || !mine || !theirs || after.from >= before.end) return;
    const cut = seamCut(before.heard, after.heard, after.from, before.end);
    theirs.until = cut;
    mine.from = cut;
  });
  return kept;
}
