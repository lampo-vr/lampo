// "What changed" between two renders of the same video, frame by frame.
//   video: both versions decoded small (160 px wide, grey, light blur against codec noise), compared per 16×16 block;
//          a frame changed when its worst block differs (so a fixed typo or a moved caption counts, grain doesn't).
//   timing: when a frame doesn't match, nearby old frames are searched, so a moved cut shows up as one "retime"
//          marker instead of everything after it being "changed".
//   audio: per-frame loudness compared along the same alignment.
import fs from 'node:fs';
import path from 'node:path';
import { waveform } from './media.ts';
import { cacheDir } from './paths.ts';
import { analysisRows, FFMPEG, lower, spawnMedia } from './probe.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import type { DiffRange, DiffResult, Rect, Retime, Version } from './types.ts';

export const DIFF_VERSION = 1;
const W = 160; // analysis width
const B = 16; // block size (analysis px)
const T = 7; // block mean |Δ| (0–255) above which a frame counts as changed
/** A frame differs when its worst 16×16 block (at 160 px grey) differs by this much on average (0–255). */
export const BLOCK_CHANGED = T;

/** The analysis size for a picture of w×h: 160 px wide, even height, at most 640 (lib/probe.ts `analysisRows`). */
export const analysisSize = (w: number, h: number): { w: number; h: number } => ({ w: W, h: analysisRows(W, w, h) });
/** ffmpeg filters that turn any picture into the grey analysis frame (a light blur against codec noise). */
export const greyFilter = (h: number): string => `scale=${W}:${h}:flags=area,format=gray,gblur=sigma=0.8`;
const COARSE = 20; // columns of the coarse signature used to search for moved content
/** The most ranges of each kind (and retimes) one diff reports: real renders have a handful. */
const MAX_RANGES = 1000;

/** A running decode of one render into grey analysis frames, read as they are needed. */
interface GreyStream {
  /** Frames decoded so far; the last `keep` − 1 of them are still there. */
  readonly hi: number;
  /** The decode has ended: `hi` is every frame there is. */
  readonly ended: boolean;
  /** Reads until frame k is decoded, or the decode ends. */
  need(k: number): Promise<void>;
  /** Frame k, or null when it isn't decoded yet or has left the window. */
  frame(k: number): Buffer | null;
  /** Frame k's coarse signature (only for a frame that is there). */
  sig(k: number): Float32Array;
  /** Waits for ffmpeg's end; throws when it decoded nothing. */
  done(): Promise<void>;
  /** Kills a decode not read to its end. */
  stop(): void;
}

/**
 * Decodes a render into grey frames kept in a ring of `keep` slots (allocated once, then reused): memory is `keep`
 * frames whatever the render's length — every frame of both versions used to be held (A13 MEDIA-1). Bytes are taken
 * from ffmpeg only as frames are asked for, so the pipe's backpressure holds the decoder back.
 */
function greyStream(file: string, h: number, keep: number): GreyStream {
  const size = W * h;
  const p = spawnMedia(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', greyFilter(h), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  lower(p.pid);
  let failed: Error | null = null;
  const exit = new Promise<number | null>((resolve) => {
    p.on('error', (e) => {
      failed = e;
      resolve(null);
    });
    p.on('close', (code) => resolve(code));
  });
  const chunks = p.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const slots: Buffer[] = [];
  const sigs: Float32Array[] = [];
  const sigOf: number[] = [];
  let pending: Buffer | null = null;
  let at = 0;
  let fill = 0;
  let hi = 0;
  let ended = false;
  return {
    get hi() {
      return hi;
    },
    get ended() {
      return ended;
    },
    async need(k) {
      while (hi <= k && !ended) {
        if (!pending || at >= pending.length) {
          const next = await chunks.next();
          if (next.done) {
            ended = true;
            break;
          }
          pending = next.value;
          at = 0;
        }
        const i = hi % keep;
        slots[i] ??= Buffer.allocUnsafe(size);
        const n = Math.min(size - fill, pending.length - at);
        pending.copy(slots[i], fill, at, at + n);
        fill += n;
        at += n;
        if (fill === size) {
          sigOf[i] = -1;
          hi++;
          fill = 0;
        }
      }
    },
    // the slot of frame hi − keep is being filled with frame hi: one fewer than `keep` is whole
    frame: (k) => (k >= 0 && k < hi && k > hi - keep ? (slots[k % keep] as Buffer) : null),
    sig(k) {
      const i = k % keep;
      if (sigOf[i] !== k) {
        sigs[i] = coarse(slots[i] as Buffer, W, h, sigs[i]);
        sigOf[i] = k;
      }
      return sigs[i] as Float32Array;
    },
    async done() {
      const code = await exit;
      if (failed) throw failed;
      if (code !== 0 && !hi) throw new Error('decode failed');
    },
    stop() {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    },
  };
}

function coarse(buf: Buffer, w: number, h: number, into?: Float32Array): Float32Array {
  const cw = COARSE;
  const ch = Math.max(1, Math.round((COARSE * h) / w));
  const out = into?.length === cw * ch ? into : new Float32Array(cw * ch);
  const sx = w / cw;
  const sy = h / ch;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let s = 0;
      let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++)
        for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
          s += buf[yy * w + xx];
          n++;
        }
      out[y * cw + x] = n ? s / n : 0;
    }
  return out;
}

const coarseDist = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

export interface BlockDiff {
  worst: number;
  box: Rect | null;
}

// Worst block difference and the bounding box (analysis px) of all blocks over the threshold.
export function blockDiff(a: Buffer, b: Buffer, w: number, h: number): BlockDiff {
  let worst = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let by = 0; by < h; by += B)
    for (let bx = 0; bx < w; bx += B) {
      let s = 0;
      let n = 0;
      const ye = Math.min(h, by + B);
      const xe = Math.min(w, bx + B);
      for (let y = by; y < ye; y++) {
        const row = y * w;
        for (let x = bx; x < xe; x++) {
          s += Math.abs(a[row + x] - b[row + x]);
          n++;
        }
      }
      const m = s / n;
      if (m > worst) worst = m;
      if (m >= T) {
        x0 = Math.min(x0, bx);
        y0 = Math.min(y0, by);
        x1 = Math.max(x1, xe);
        y1 = Math.max(y1, ye);
      }
    }
  return { worst, box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null };
}

function mergeRanges(flags: ArrayLike<number | boolean>, { gap = 2, min = 1 } = {}): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on) {
      if (start < 0) start = i;
      else if (i - last > gap + 1) {
        out.push([start, last]);
        start = i;
      }
      last = i;
    }
  }
  if (start >= 0) out.push([start, last]);
  return out.filter(([a, b]) => b - a + 1 >= min);
}

export async function diffVersions(
  oldFile: string,
  oldVer: Version,
  newFile: string,
  newVer: Version,
  { onProgress }: { onProgress?: (p: { step: string }) => void } = {},
): Promise<DiffResult> {
  const t0 = Date.now();
  if (Math.abs(oldVer.width / oldVer.height - newVer.width / newVer.height) > 0.01)
    return { diff_version: DIFF_VERSION, incomparable: 'aspect ratio changed', old: { v: oldVer.v }, new: { v: newVer.v } };
  onProgress?.({ step: 'decode' });
  const { w, h } = analysisSize(newVer.width, newVer.height);
  const ratio = oldVer.fps / newVer.fps;
  const R = Math.round(2 * oldVer.fps); // search ±2 s of old frames
  // The old version's frames from 2R behind the aligned frame (a retime may move it back by R, and its search reaches
  // R further) to R + 1 ahead (the search, and the frame after a match): never all of them (A13 MEDIA-1).
  const A = greyStream(oldFile, h, 3 * R + 4);
  const Bv = greyStream(newFile, h, 3);
  try {
    // per new frame: the old frame it was compared with (the audio follows the same alignment)
    let map = new Int32Array(Math.max(16, newVer.frames + 16));
    const retimes: Retime[] = [];
    const ranges: DiffRange[] = [];
    // Video ranges, merged as they come (changed frames at most 2 apart are one range); single noisy frames with a low
    // score are dropped. Boxes are in analysis px until a range is closed.
    const kx = newVer.width / w;
    const ky = newVer.height / h;
    let open: { in: number; out: number; worst: number; u: { x: number; y: number; x2: number; y2: number } | null } | null = null;
    const close = () => {
      const r = open;
      open = null;
      if (!r || (r.in === r.out && r.worst < 2 * T)) return;
      const u = r.u;
      const box = u ? { x: Math.round(u.x * kx), y: Math.round(u.y * ky), w: Math.round((u.x2 - u.x) * kx), h: Math.round((u.y2 - u.y) * ky) } : null;
      const range: DiffRange = {
        kind: 'video',
        in: r.in,
        out: r.out,
        score: Math.round(r.worst * 10) / 10,
        box,
        whole: !!box && box.w * box.h > 0.6 * newVer.width * newVer.height,
      };
      const last = ranges.at(-1);
      // a pathological render (a change every few frames for hours) can't make the answer itself huge: past the cap
      // the last range grows instead
      if (last && ranges.length >= MAX_RANGES) Object.assign(last, joined(last, range, newVer));
      else ranges.push(range);
    };
    let offset = 0;
    let yielded = Date.now();
    onProgress?.({ step: 'compare' });
    let i = 0;
    for (; ; i++) {
      await Bv.need(i + 1);
      const cur = Bv.frame(i);
      if (!cur) break;
      const base = Math.round(i * ratio);
      let j = base + offset;
      await A.need(j + R + 1);
      // the decode keeps running while this compares: let the server answer requests now and then
      if (Date.now() - yielded > 20) {
        await new Promise((r) => setImmediate(r));
        yielded = Date.now();
      }
      const old = A.frame(j);
      let d: BlockDiff = old ? blockDiff(cur, old, w, h) : { worst: 255, box: { x: 0, y: 0, w, h } };
      if (d.worst >= T) {
        // Maybe the content moved in time: look for it nearby (coarse first, then verify the best few).
        const cands: [number, number][] = [];
        const sig = coarse(cur, w, h);
        for (let k = Math.max(0, j - R); k <= j + R; k++) if (k !== j && A.frame(k)) cands.push([coarseDist(sig, A.sig(k)), k]);
        cands.sort((x, y) => x[0] - y[0]);
        let best: { k: number; d: BlockDiff } | null = null;
        for (const [, k] of cands.slice(0, 6)) {
          const dk = blockDiff(cur, A.frame(k) as Buffer, w, h);
          if (!best || dk.worst < best.d.worst) best = { k, d: dk };
        }
        if (best && best.d.worst < T) {
          const shift = best.k - base - offset;
          // Only a sustained match is a retime; a one-off lookalike frame is not.
          const after = Bv.frame(i + 1);
          const then = A.frame(best.k + 1);
          const next = after && then ? blockDiff(after, then, w, h).worst : 0;
          if (next < T) {
            offset = best.k - base;
            j = best.k;
            d = best.d;
            if (retimes.length < MAX_RANGES)
              retimes.push({ frame: i, shift_frames: Math.round(shift / ratio), seconds: Math.round((shift / oldVer.fps) * 1000) / 1000 });
          }
        }
      }
      if (i >= map.length) {
        const more = new Int32Array(map.length * 2);
        more.set(map);
        map = more;
      }
      map[i] = j >= 0 && j < A.hi ? j : -1;
      if (d.worst >= T) {
        const bx = d.box;
        if (open && i - open.out > 3) close();
        if (!open) open = { in: i, out: i, worst: 0, u: null };
        open.out = i;
        open.worst = Math.max(open.worst, d.worst);
        if (bx)
          open.u = open.u
            ? { x: Math.min(open.u.x, bx.x), y: Math.min(open.u.y, bx.y), x2: Math.max(open.u.x2, bx.x + bx.w), y2: Math.max(open.u.y2, bx.y + bx.h) }
            : { x: bx.x, y: bx.y, x2: bx.x + bx.w, y2: bx.y + bx.h };
      }
    }
    close();
    const n = i;
    // the old version's length: the rest of it decoded, nothing kept
    while (!A.ended) await A.need(A.hi + 4096);
    await Promise.all([A.done(), Bv.done()]);
    return await finish(oldFile, oldVer, newFile, newVer, { n, oldFrames: A.hi, map, ranges, retimes, t0, onProgress });
  } finally {
    A.stop();
    Bv.stop();
  }
}

/** Two video ranges as one (past MAX_RANGES): from the first's start to the second's end, the worse score, both boxes. */
function joined(a: DiffRange, b: DiffRange, ver: Pick<Version, 'width' | 'height'>): DiffRange {
  const box =
    a.box && b.box
      ? (() => {
          const x = Math.min(a.box.x, b.box.x);
          const y = Math.min(a.box.y, b.box.y);
          return { x, y, w: Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - x, h: Math.max(a.box.y + a.box.h, b.box.y + b.box.h) - y };
        })()
      : (a.box ?? b.box);
  return { ...a, out: b.out, score: Math.max(a.score ?? 0, b.score ?? 0), box, whole: !!box && box.w * box.h > 0.6 * ver.width * ver.height };
}

async function finish(
  oldFile: string,
  oldVer: Version,
  newFile: string,
  newVer: Version,
  {
    n,
    oldFrames,
    map,
    ranges,
    retimes,
    t0,
    onProgress,
  }: { n: number; oldFrames: number; map: Int32Array; ranges: DiffRange[]; retimes: Retime[]; t0: number; onProgress?: (p: { step: string }) => void },
): Promise<DiffResult> {
  // Audio along the same alignment.
  onProgress?.({ step: 'audio' });
  const [wa, wb] = await Promise.all([waveform(oldFile, oldVer).catch(() => null), waveform(newFile, newVer).catch(() => null)]);
  if (wa?.rms?.length && wb?.rms?.length) {
    // Smoothed loudness (≈ 170 ms) compared with ±2 frames of slack, so encoder/cut offsets of a few ms don't count.
    const env = (rms: number[]) => {
      const out = new Float32Array(rms.length);
      for (let i = 0; i < rms.length; i++) {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, i - 2); k <= Math.min(rms.length - 1, i + 2); k++) {
          s += rms[k] * rms[k];
          c++;
        }
        out[i] = Math.sqrt(s / c);
      }
      return out;
    };
    const ea = env(wa.rms);
    const eb = env(wb.rms);
    const db = (x: number) => 20 * Math.log10(x + 1e-3);
    const flag = new Uint8Array(n);
    for (let i = 0; i < n && i < eb.length; i++) {
      const j = map[i] as number;
      if (j < 0 || j >= ea.length) continue;
      let best = Infinity;
      for (let k = Math.max(0, j - 2); k <= Math.min(ea.length - 1, j + 2); k++) best = Math.min(best, Math.abs(db(eb[i]) - db(ea[k])));
      if (Math.max(eb[i], ea[j]) >= 0.02 && best > 2.5) flag[i] = 1;
    }
    const audio = mergeRanges(flag, { gap: 12, min: 6 });
    // past the cap, the last audio range reaches to the last change
    if (audio.length > MAX_RANGES)
      audio.splice(MAX_RANGES - 1, audio.length, [(audio[MAX_RANGES - 1] as [number, number])[0], (audio.at(-1) as [number, number])[1]]);
    for (const [a, b] of audio) ranges.push({ kind: 'audio', in: a, out: b });
  }
  ranges.sort((x, y) => x.in - y.in || (x.kind === 'video' ? -1 : 1));
  const video = ranges.filter((r) => r.kind === 'video');
  const changedFrames = video.reduce((s, r) => s + r.out - r.in + 1, 0);
  return {
    diff_version: DIFF_VERSION,
    old: { v: oldVer.v, hash: oldVer.hash, frames: oldFrames },
    new: { v: newVer.v, hash: newVer.hash, frames: n },
    fps: newVer.fps,
    ranges,
    retimes,
    summary: {
      changes: video.length,
      changed_seconds: Math.round((changedFrames / newVer.fps) * 10) / 10,
      audio_changes: ranges.length - video.length,
      retimes: retimes.length,
      identical: !ranges.length && !retimes.length,
    },
    ms: Date.now() - t0,
  };
}

const cachePath = (a: string, b: string) => path.join(cacheDir(), 'diff', `${a}_${b}.json`);

export function cachedDiff(oldVer: Pick<Version, 'hash'>, newVer: Pick<Version, 'hash'>): DiffResult | null {
  try {
    const d: DiffResult = JSON.parse(fs.readFileSync(cachePath(renderKey(oldVer), renderKey(newVer)), 'utf8'));
    return d.diff_version === DIFF_VERSION ? d : null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<DiffResult>>();
export function computeDiff(oldFile: string, oldVer: Version, newFile: string, newVer: Version): Promise<DiffResult> {
  const hit = cachedDiff(oldVer, newVer);
  if (hit) return Promise.resolve(hit);
  const key = wsKey(`${renderKey(oldVer)}_${renderKey(newVer)}`);
  const running = inflight.get(key);
  if (running) return running;
  const p = diffVersions(oldFile, oldVer, newFile, newVer)
    .then((d) => {
      fs.mkdirSync(path.join(cacheDir(), 'diff'), { recursive: true });
      fs.writeFileSync(cachePath(renderKey(oldVer), renderKey(newVer)), JSON.stringify(d));
      return d;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
