// Frame exactness against ffmpeg, checked one way in every browser suite: what a <video> shows, drawn small and grey on
// a canvas, against the frames ffmpeg decodes from the same file (`select=eq(n,N)`, the frame the store's grabs use).
// The closest of the frames around the one asked for must be that one.
import { rawRgb } from '../../lib/helpers.ts';

export const SW = 96;
export const SH = 54;

const gray = (buf) => {
  const out = new Uint8Array(buf.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * buf[i * 3] + 0.587 * buf[i * 3 + 1] + 0.114 * buf[i * 3 + 2]);
  return out;
};
const decoded = new Map();

/** ffmpeg's frame `n` of `file`, small and grey (each decoded once). */
export function ffFrame(file, n) {
  const key = `${file}#${n}`;
  if (!decoded.has(key)) decoded.set(key, gray(rawRgb(['-i', file, '-vf', `select=eq(n\\,${n}),scale=${SW}:${SH}:flags=area`, '-fps_mode', 'passthrough'])));
  return decoded.get(key);
}

/** What the video at `selector` shows now, small and grey (a Puppeteer or a Playwright page). */
export const shownPicture = (page, selector = '.vbox video') =>
  page.evaluate(
    ({ SW, SH, selector }) => {
      const v = document.querySelector(selector);
      const c = document.createElement('canvas');
      c.width = SW;
      c.height = SH;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(v, 0, 0, SW, SH);
      const d = g.getImageData(0, 0, SW, SH).data;
      const out = [];
      for (let i = 0; i < d.length; i += 4) out.push(Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]));
      return out;
    },
    { SW, SH, selector },
  );

/** The mean difference of two small grey pictures. */
export const mae = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;

/**
 * Among ffmpeg's frames n − near … n + near of `file` (those inside 0 … frames − 1), the one closest to `pixels`: `k`,
 * its distance `e`, and `line`, every candidate with its distance, for the failure message.
 */
export function closestFrame(file, pixels, n, frames, near = 1) {
  const cands = [];
  for (let k = n - near; k <= n + near; k++) if (k >= 0 && k < frames) cands.push({ k, e: mae(ffFrame(file, k), pixels) });
  const best = cands.reduce((a, b) => (b.e < a.e ? b : a));
  return { k: best.k, e: best.e, line: cands.map((c) => `${c.k}:${c.e.toFixed(2)}`).join(' ') };
}

// ---------------------------------------------------------------- what playing presented

/**
 * Starts recording every frame `selector`'s video presents, from its own callback (a newer recording ends an older one):
 * the frame, presentedFrames and Chrome's count of dropped frames. The callback runs once per rendering step of the page
 * and reports the newest frame; presentedFrames also counts the frames that came and went between two steps, which a
 * busy main thread misses (a check that looks for a frame among the reported ones then fails although it was shown).
 */
export const recordFrames = (page, fps, selector = '.vbox video') =>
  page.evaluate(
    (fps, selector) => {
      const v = document.querySelector(selector);
      const rec = [];
      window.__frames = rec;
      const cb = (_n, m) => {
        if (window.__frames !== rec) return;
        rec.push({ f: Math.round(m.mediaTime * fps), pf: m.presentedFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames });
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    },
    fps,
    selector,
  );
/** What recordFrames has recorded so far. */
export const recordedFrames = (page) => page.evaluate(() => window.__frames);

/**
 * Whether playing presented every frame from `from` to `to`, each once: between two reports in that stretch as many
 * frames were presented as the media advanced, and none was dropped. A frame no callback reported counts as shown when
 * it lies between two such reports. Returns the problems (a skip, a repeat, a drop, or the stretch not covered).
 */
export function playedThrough(frames, from, to) {
  // the reports while playing forward, each with the one before it
  const pairs = [];
  for (let i = 1; i < frames.length; i++) if (frames[i].f > frames[i - 1].f) pairs.push([frames[i - 1], frames[i]]);
  const covering = pairs.filter(([a, b]) => b.f >= from && a.f <= to);
  if (!covering.length || covering[0][0].f > from || covering.at(-1)[1].f < to)
    return [`the reports don't span f${from}–f${to}: ${frames.map((x) => x.f).join(',')}`];
  const out = [];
  for (const [a, b] of covering) {
    if (b.dropped > a.dropped) out.push(`${b.dropped - a.dropped} frame(s) dropped between f${a.f} and f${b.f}`);
    else if (b.f - a.f !== b.pf - a.pf) out.push(`f${a.f} → f${b.f}: ${b.pf - a.pf} presented for ${b.f - a.f} frames on (a skip or a repeat)`);
  }
  return out;
}
