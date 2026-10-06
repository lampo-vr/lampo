// Words and times the Insights page and its chart share (InsightsChart.tsx loads on its own: it must not pull the page).
import type { InsightsWatchedVideo, InsightsWatchViewer } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { pct } from '../lib/format.ts';

/** A viewer as sentences name them: the asker is "You", a visitor without a name "Someone with the link". */
export const whoName = (x: Pick<InsightsWatchViewer, 'you' | 'name' | 'kind'>) =>
  x.you ? t('You') : x.name || (x.kind === 'client' ? t('Someone with the link') : t('Someone'));
/** "once", "twice", "3 times". */
export const timesWords = (n: number) => (n === 1 ? t('once') : n === 2 ? t('twice') : t('{n} times', { n }));
/** Facts in a row's second line, in one run (it shortens from its end, where the least important one stands). */
export const facts = (...xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
/** A figure with at most one decimal, as the language writes it ("7.8", "7,8"). */
export const num = (x: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(x);

/** Decimals a moment of a version needs for its hundredths to read apart: none from 50 s up (half a second each), then
 * tenths, then hundredths. */
const decimalsFor = (duration: number) => (duration >= 50 ? 0 : duration >= 5 ? 1 : 2);
/** A moment of a version as its clock reads it, m:ss (with `d` decimals) — cut, never rounded up, like a timecode. */
export const clockAt = (s: number, d = 0) => {
  const k = 10 ** d;
  const x = Math.floor(s * k + 1e-6) / k;
  const m = Math.floor(x / 60);
  return `${m}:${(x - m * 60).toFixed(d).padStart(d ? 3 + d : 2, '0')}`;
};
/** A stretch of hundredths (`to` included) as times of the version ("0:42–0:48"), or in percent without its length. */
export const stretchOf = (w: { from: number; to: number }, duration: number | null | undefined) => {
  if (!duration) return `${pct(w.from / 100)}–${pct((w.to + 1) / 100)}`;
  const d = decimalsFor(duration);
  return `${clockAt((w.from / 100) * duration, d)}–${clockAt(((w.to + 1) / 100) * duration, d)}`;
};
/** The same stretch for a summary line: whole seconds, from the second it starts in to the one it ends in ("0:03–0:05").
 * A part is a hundredth of the version — tenths of a second on a short one — finer than a glance at a row needs. */
export const secondsOf = (w: { from: number; to: number }, duration: number | null | undefined) => {
  if (!duration) return stretchOf(w, duration);
  const a = Math.floor((w.from / 100) * duration + 1e-6);
  const b = Math.max(a + 1, Math.ceil(((w.to + 1) / 100) * duration - 1e-6));
  return `${clockAt(a)}–${clockAt(b)}`;
};

/** How a video's chart counts: from three viewers up, how many of them saw each part; one or two can only have seen a
 * part or not, so their chart counts how often each part played. */
export const chartModeOf = (v: Pick<InsightsWatchedVideo, 'seenBy' | 'viewers'>): 'viewers' | 'plays' =>
  (v.seenBy ?? v.viewers.filter((x) => x.watched != null).length) >= 3 ? 'viewers' : 'plays';
/** The steps of the chart's height: five for viewers; for plays as many as the most played part, so a version watched
 * once is a slim strip and the parts played again rise above it. */
export const chartLevelsOf = (v: InsightsWatchedVideo) => (chartModeOf(v) === 'viewers' ? 5 : Math.min(5, Math.max(1, ...(v.plays ?? []))));
