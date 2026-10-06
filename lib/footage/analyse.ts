// What a video's footage is made of, from one small decode (128 px wide, RGB): its shots (Auto-check's own cut rule,
// cutsFromDiffs, on the same 64 px picture lib/cuts.ts uses), the camera's move in each (a global shift + zoom fitted
// to block motion between frames 5 apart) and the keyframes to look at. No model, no GPU: ~1 ms of CPU a frame
// (bench/footage/RESULTS.md: 314 of 315 cuts within ±1 frame, 97.9 % of moves right). The decode goes in chunks, each
// its own job in the queue, so a long take never holds a player's scrub copy back for minutes.
import { cutsFromDiffs } from '../cuts.ts';
import { analysisRows, FFMPEG, lower, spawnMedia } from '../probe.ts';
import { seekTime } from '../shots.ts';
import type { FootageMotion } from './types.ts';

/** Width of the analysis picture. */
export const AW = 128;
/** Frames between the two pictures whose motion is measured. */
export const STEP = 5;
/** Frames per analysis job (a minute at 25 fps). */
export const CHUNK_FRAMES = 1500;

/** The picture's height at 128 px wide, a multiple of 4 (64 px for the cut diffs is half of it), at most 512 (1:4). */
export const analysisHeight = (w: number, h: number): number => analysisRows(AW, w, h, 4);

export interface MotionPair {
  /** The first frame of the pair (the second is a + STEP). */
  a: number;
  /** Shift in px of the 128-wide picture, and zoom − 1. */
  tx: number;
  ty: number;
  s: number;
  ok: boolean;
}

export interface ShotMotion {
  kind: FootageMotion;
  /** 'slow' under 8 % of the frame (or 8 % zoom) a second. */
  speed: 'slow' | 'fast' | null;
  /** Zoom over the shot (1.15 = 15 % closer), the picture's shift over it in frame widths/heights (content moving
   * right/down is positive), and the shift's path length (handheld shows as a long path, little net). */
  zoom: number;
  dx: number;
  dy: number;
  path: number;
}

/** What the chunks have read so far: per frame the mean difference to the one before, and the motion pairs. */
export interface Reading {
  diffs: number[];
  pairs: MotionPair[];
  /** Frames decoded so far (the next chunk starts here). */
  frames: number;
  /** The decode ended before the frame count it was given (the file has fewer frames than probed). */
  ended: boolean;
}

export const newReading = (): Reading => ({ diffs: [], pairs: [], frames: 0, ended: false });

// Block matching between two grey pictures: for blocks with texture, the shift (±R px, sub-pixel from a parabola
// through the SAD minimum), then a least-squares fit of u = tx + s·x, v = ty + s·y (x, y from the centre).
export function estimatePair(a: Uint8Array, b: Uint8Array, w: number, h: number): Omit<MotionPair, 'a'> {
  const B = 12;
  const R = 8;
  const pts: { x: number; y: number; u: number; v: number }[] = [];
  for (let by = R; by + B + R <= h; by += 10) {
    for (let bx = R; bx + B + R <= w; bx += 10) {
      // texture: skip flat blocks (sky, white backgrounds) — their shift is noise
      let sum = 0;
      let sum2 = 0;
      for (let y = 0; y < B; y++)
        for (let x = 0; x < B; x++) {
          const p = a[(by + y) * w + bx + x] as number;
          sum += p;
          sum2 += p * p;
        }
      const n = B * B;
      if (sum2 / n - (sum / n) ** 2 < 30) continue;
      const sad = (dx: number, dy: number) => {
        let s = 0;
        for (let y = 0; y < B; y++) {
          const ra = (by + y) * w + bx;
          const rb = (by + y + dy) * w + bx + dx;
          for (let x = 0; x < B; x++) s += Math.abs((a[ra + x] as number) - (b[rb + x] as number));
        }
        return s;
      };
      let best = Number.POSITIVE_INFINITY;
      let bdx = 0;
      let bdy = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const s = sad(dx, dy);
          if (s < best || (s === best && dx * dx + dy * dy < bdx * bdx + bdy * bdy)) {
            best = s;
            bdx = dx;
            bdy = dy;
          }
        }
      if (Math.abs(bdx) === R || Math.abs(bdy) === R) continue;
      const sub = (m: number, c: number, p: number) => {
        const d = m - 2 * c + p;
        return d > 0 ? (0.5 * (m - p)) / d : 0;
      };
      const u = bdx + sub(sad(bdx - 1, bdy), best, sad(bdx + 1, bdy));
      const v = bdy + sub(sad(bdx, bdy - 1), best, sad(bdx, bdy + 1));
      pts.push({ x: bx + B / 2 - w / 2, y: by + B / 2 - h / 2, u, v });
    }
  }
  if (pts.length < 6) return { tx: 0, ty: 0, s: 0, ok: false };
  const fit = (ps: typeof pts) => {
    // normal equations for [tx, ty, s]: u = tx + s x, v = ty + s y
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let su = 0;
    let sv = 0;
    let sxu = 0;
    for (const p of ps) {
      n++;
      sx += p.x;
      sy += p.y;
      sxx += p.x * p.x + p.y * p.y;
      su += p.u;
      sv += p.v;
      sxu += p.x * p.u + p.y * p.v;
    }
    const det = n * (n * sxx - sy * sy) - sx * (n * sx);
    if (Math.abs(det) < 1e-9) return { tx: su / n, ty: sv / n, s: 0 };
    const s = (n * n * sxu - n * sx * su - n * sy * sv) / (n * n * sxx - n * sx * sx - n * sy * sy);
    return { tx: (su - s * sx) / n, ty: (sv - s * sy) / n, s };
  };
  let m = fit(pts);
  // one robust pass: drop blocks that disagree with the fit by more than 1.5 px (a moving subject over a still camera)
  const inl = pts.filter((p) => Math.hypot(p.u - (m.tx + m.s * p.x), p.v - (m.ty + m.s * p.y)) < 1.5);
  if (inl.length >= 6) m = fit(inl);
  return { ...m, ok: true };
}

/** VideoToolbox on a Mac: the decode is the analysis's largest cost, and the hardware does it at a fifth of the CPU. */
const hwaccel = (): string[] => (process.platform === 'darwin' && process.env.VR_FOOTAGE_HWACCEL !== 'off' ? ['-hwaccel', 'videotoolbox'] : []);

/**
 * Decodes frames [from, to) at 128 px wide (plus the STEP frames before `from` that the first diff and pair need) and
 * adds their diffs and motion pairs to `r`. A chunk that gets fewer frames than asked for is the end of the video.
 */
export function readChunk(file: string, meta: { fps: number; width: number; height: number }, r: Reading, to: number): Promise<void> {
  const from = r.frames;
  const start = Math.max(0, from - STEP);
  const w = AW;
  const h = analysisHeight(meta.width, meta.height);
  const size = w * h * 3;
  const cw = w / 2;
  const ch = h / 2;
  return new Promise((resolve, reject) => {
    const p = spawnMedia(FFMPEG, [
      '-v',
      'error',
      ...hwaccel(),
      '-threads',
      '2',
      ...(start > 0 ? ['-ss', seekTime(start, meta.fps).toFixed(6)] : []),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-frames:v',
      String(to - start),
      '-vf',
      `scale=${w}:${h}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    lower(p.pid);
    let prev: Float32Array | null = null;
    const greys: Uint8Array[] = [];
    let n = start;
    let buf: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const f = buf.subarray(0, size);
        // 64 px RGB (2×2 box) for the cut rule, grey 128 px for motion
        const small = new Float32Array(cw * ch * 3);
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++)
            for (let c = 0; c < 3; c++) {
              const i = (2 * y * w + 2 * x) * 3 + c;
              small[(y * cw + x) * 3 + c] = ((f[i] as number) + (f[i + 3] as number) + (f[i + w * 3] as number) + (f[i + w * 3 + 3] as number)) / 4;
            }
        if (n >= from) {
          let sum = 0;
          if (prev) for (let i = 0; i < small.length; i++) sum += Math.abs((small[i] as number) - (prev[i] as number));
          r.diffs[n] = prev && n > 0 ? sum / small.length : 0;
        }
        prev = small;
        const g = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) g[i] = ((f[i * 3] as number) * 77 + (f[i * 3 + 1] as number) * 150 + (f[i * 3 + 2] as number) * 29) >> 8;
        greys.push(g);
        if (greys.length > STEP + 1) greys.shift();
        if (n >= from && n >= STEP && n % STEP === 0 && greys.length === STEP + 1) {
          const e = estimatePair(greys[0] as Uint8Array, g, w, h);
          r.pairs.push({ a: n - STEP, ...e });
        }
        n++;
        buf = buf.subarray(size);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && n <= from) return reject(new Error(`could not decode the video (${p.stderrTail().trim().split('\n').pop() || `exit ${code}`})`));
      if (n < to) r.ended = true;
      r.frames = Math.max(from, n);
      resolve();
    });
  });
}

/** The move over one shot [inF, outF) from the pairs inside it (pairs that span a cut, or touch its first/last 2 frames, are left out). */
export function shotMotion(pairs: readonly MotionPair[], inF: number, outF: number, fps: number, w: number, h: number): ShotMotion {
  const inside = pairs.filter((p) => p.a >= inF + 2 && p.a + STEP <= outF - 2);
  const span = Math.max(1, outF - inF - 4);
  if (!inside.length) return { kind: 'static', speed: null, zoom: 1, dx: 0, dy: 0, path: 0 };
  const ok = inside.filter((p) => p.ok);
  // the pairs cover part of the shot (every STEP frames): scale the sums to the whole shot
  const cover = (ok.length * STEP) / span || 1;
  let lz = 0;
  let tx = 0;
  let ty = 0;
  let path = 0;
  for (const p of ok) {
    lz += Math.log(1 + p.s);
    tx += p.tx;
    ty += p.ty;
    path += Math.hypot(p.tx / w, p.ty / h);
  }
  lz /= cover;
  const dx = tx / w / cover;
  const dy = ty / h / cover;
  path /= cover;
  const secs = (outF - inF) / fps;
  const net = Math.hypot(dx, dy);
  let kind: FootageMotion = 'static';
  let rate = 0;
  if (path / secs > 0.06 && net < 0.45 * path) kind = 'handheld';
  else if (Math.abs(lz) > 0.05) {
    kind = lz > 0 ? 'push-in' : 'pull-out';
    rate = Math.abs(lz) / secs;
  } else if (Math.max(Math.abs(dx), Math.abs(dy)) > 0.05) {
    if (Math.abs(dx) >= Math.abs(dy)) kind = dx < 0 ? 'pan-right' : 'pan-left';
    else kind = dy > 0 ? 'tilt-up' : 'tilt-down';
    rate = Math.max(Math.abs(dx), Math.abs(dy)) / secs;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    kind,
    speed: kind === 'static' || kind === 'handheld' ? null : rate < 0.08 ? 'slow' : 'fast',
    zoom: r3(Math.exp(lz)),
    dx: r3(dx),
    dy: r3(dy),
    path: r3(path),
  };
}

/**
 * Frames to look at in a shot [inF, outF): 1 under 2.5 s, then one per 2.5 s, at most 6 (or `most`), spread over it
 * away from its cuts.
 */
export function keyframesFor(inF: number, outF: number, fps: number, most = 6): number[] {
  const margin = Math.min(3, Math.floor((outF - inF) / 4));
  const a = inF + margin;
  const len = outF - margin - a;
  const n = Math.max(1, Math.min(most, Math.ceil(len / fps / 2.5)));
  return [...new Set(Array.from({ length: n }, (_, j) => a + Math.floor(((j + 0.5) * len) / n)))];
}

/**
 * The shortest shot footage search keeps: a shorter one joins the next (a cut every few frames is a strobe or a flash
 * cut, not footage to find), and the most keyframes a video gets per minute (the docs' set has about 30). Footage
 * search's work then follows a video's length, not how it is cut (A13 MEDIA-3: a cut every 6 frames made 80 × the work).
 */
export const MIN_SHOT_S = 0.5;
export const KEYFRAMES_PER_MINUTE = 60;

/** Cuts [0, …, frames] without the ones that end a stretch shorter than `min` frames (that stretch joins the next). */
function longEnough(bounds: number[], min: number): number[] {
  const out = [bounds[0] as number];
  const end = bounds.at(-1) as number;
  for (const cut of bounds.slice(1, -1)) if (cut - (out.at(-1) as number) >= min) out.push(cut);
  // the last stretch too short: it joins the one before
  if (out.length > 1 && end - (out.at(-1) as number) < min) out.pop();
  out.push(end);
  return out;
}

export interface FoundShot {
  /** First frame and the frame after the last (exclusive here; the index keeps the last, Lampo's ranges). */
  in: number;
  end: number;
  motion: ShotMotion;
  keyframes: number[];
}

/** The shots of a video once every chunk is read: cuts by Auto-check's rule, a move and keyframes per shot. */
export function shotsOf(r: Reading, meta: { fps: number; width: number; height: number }): FoundShot[] {
  const frames = r.frames;
  if (!frames) return [];
  const diffs = Array.from({ length: frames }, (_, i) => r.diffs[i] ?? 0);
  const cuts = cutsFromDiffs(diffs)
    .map((c) => c.frame)
    .filter((c) => c > 0 && c < frames);
  // shots of half a second at least; and when that still makes more than the minute's keyframes, longer ones still
  const budget = Math.max(6, Math.floor((KEYFRAMES_PER_MINUTE * frames) / meta.fps / 60));
  let bounds = longEnough([0, ...cuts, frames], Math.ceil(MIN_SHOT_S * meta.fps));
  if (bounds.length - 1 > budget) bounds = longEnough(bounds, Math.ceil(frames / budget));
  const h = analysisHeight(meta.width, meta.height);
  const out: FoundShot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i] as number;
    const b = bounds[i + 1] as number;
    if (b <= a) continue;
    out.push({ in: a, end: b, motion: shotMotion(r.pairs, a, b, meta.fps, AW, h), keyframes: keyframesFor(a, b, meta.fps) });
  }
  // more keyframes than the video's minutes allow: one a shot (there are no more shots than that)
  if (out.reduce((n, s) => n + s.keyframes.length, 0) > budget) for (const s of out) s.keyframes = keyframesFor(s.in, s.end, meta.fps, 1);
  return out;
}
