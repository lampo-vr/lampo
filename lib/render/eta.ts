// How long a render stage has left, honestly: from the rate over the last ~10 seconds, never before 5 % of the stage
// and never while the rate swings (the window's two halves more than 50 % apart): a render that speeds up and slows
// down gets no number rather than a wrong one. Pure; lib/render/run.ts keeps one per stage.

export interface EtaOptions {
  /** How far back the rate is measured. */
  windowMs?: number;
  /** No estimate below this share of the stage (%). */
  minPct?: number;
  /** The most the window's two halves' rates may differ, as a share of the faster one. */
  swing?: number;
}

export interface Eta {
  /** A reading at `at` (ms) of `pct` (0–100): the seconds left, or undefined when there is no honest estimate. */
  push(at: number, pct: number): number | undefined;
}

interface Sample {
  at: number;
  pct: number;
}

export function etaOf({ windowMs = 10_000, minPct = 5, swing = 0.5 }: EtaOptions = {}): Eta {
  let kept: Sample[] = [];
  const rate = (a: Sample, b: Sample) => (b.at > a.at ? (b.pct - a.pct) / (b.at - a.at) : 0);
  return {
    push(at, pct) {
      const last = kept.at(-1);
      // a stage that went back starts over; readings closer than 200 ms are used, not kept (a tool may print a line a frame)
      if (last && pct < last.pct) kept = [];
      const now = { at, pct };
      if (!kept.length || at - (kept.at(-1) as Sample).at >= 200) kept.push(now);
      // the window, plus the newest reading from before it, so the whole window is spanned
      const firstIn = kept.findIndex((s) => s.at >= at - windowMs);
      if (firstIn > 1) kept = kept.slice(firstIn - 1);
      const samples = kept.at(-1) === now ? kept : [...kept, now];
      if (pct < minPct || pct >= 100 || samples.length < 3) return undefined;
      const first = samples[0];
      if (at - first.at < 1000) return undefined;
      const mid = first.at + (at - first.at) / 2;
      const middle = samples.reduce((best, s) => (Math.abs(s.at - mid) < Math.abs(best.at - mid) ? s : best), samples[1]);
      const older = rate(first, middle);
      const newer = rate(middle, now);
      if (older <= 0 || newer <= 0) return undefined;
      if (Math.abs(newer - older) / Math.max(older, newer) > swing) return undefined;
      const r = rate(first, now);
      return r > 0 ? Math.max(1, Math.round((100 - pct) / r / 1000)) : undefined;
    },
  };
}
