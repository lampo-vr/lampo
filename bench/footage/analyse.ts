// One small decode per clip (128 px wide, RGB) gives everything the index needs about time: the cuts (Lampo's own rule,
// cutsFromDiffs in lib/cuts.ts, on the same 64 px picture it uses) and the camera's move in every shot (a global
// similarity — shift + zoom — fitted to block motion between frames 5 apart). No model, no GPU: ~1 ms of CPU a frame.
import { spawn } from 'node:child_process';

export interface ClipInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  audio: boolean;
}

export type MotionKind = 'static' | 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'handheld';
export interface ShotMotion {
  kind: MotionKind;
  /** 'slow' under 8 % of the frame (or 8 % zoom) a second. */
  speed: 'slow' | 'fast' | null;
  /** Zoom over the shot (1.15 = 15 % closer), the picture's shift over the shot in frame widths/heights (content
   * moving right/down is positive), and the shift's path length (handheld shows as a long path, little net). */
  zoom: number;
  dx: number;
  dy: number;
  path: number;
}

export interface Analysis {
  info: ClipInfo;
  /** First frames of shots after the first (the first shot starts at 0). */
  cuts: number[];
  /** Per pair of frames (a, a + STEP): shift in px of the 128-wide picture and zoom − 1. */
  pairs: { a: number; tx: number; ty: number; s: number; ok: boolean }[];
  decodeMs: number;
  cpuMs: number;
}

export const AW = 128;
const STEP = 5;

export function probeClip(file: string): Promise<ClipInfo> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,width,height,r_frame_rate,nb_read_packets:format=duration',
      '-of',
      'json',
      file,
    ]);
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('error', reject);
    p.on('close', () => {
      const j = JSON.parse(out) as {
        streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; nb_read_packets?: string }[];
        format: { duration: string };
      };
      const v = j.streams.find((s) => s.codec_type === 'video');
      if (!v?.width || !v.height) return reject(new Error(`${file}: no video stream`));
      const [a, b] = (v.r_frame_rate || '25/1').split('/').map(Number) as [number, number];
      resolve({
        width: v.width,
        height: v.height,
        fps: a / (b || 1),
        frames: Number(v.nb_read_packets) || 0,
        duration: Number(j.format.duration),
        audio: j.streams.some((s) => s.codec_type === 'audio'),
      });
    });
  });
}

/** The picture's height at 128 px wide, even (64 px for the cut diffs is half of it). */
export const analysisHeight = (w: number, h: number): number => Math.max(4, Math.round((AW * h) / w / 4) * 4);

// Block matching between two grey pictures: for blocks with texture, the shift (±R px, sub-pixel from a parabola
// through the SAD minimum), then a least-squares fit of u = tx + s·x, v = ty + s·y (x, y from the centre).
export function estimatePair(a: Uint8Array, b: Uint8Array, w: number, h: number): { tx: number; ty: number; s: number; ok: boolean } {
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
    // [n 0 sx; 0 n sy; sx sy sxx] [tx ty s] = [su sv sxu]
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

/** Decodes the clip once at 128 px wide: frame diffs for the cuts (on the 64 px picture lib/cuts.ts uses) and block
 * motion between frames STEP apart. */
export function decodeClip(file: string, info: ClipInfo): Promise<{ diffs: number[]; pairs: Analysis['pairs']; decodeMs: number; cpuMs: number }> {
  const w = AW;
  const h = analysisHeight(info.width, info.height);
  const size = w * h * 3;
  const cw = w / 2;
  const ch = h / 2;
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `scale=${w}:${h}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const diffs: number[] = [];
    const pairs: Analysis['pairs'] = [];
    let prev: Float32Array | null = null;
    const greys: Uint8Array[] = [];
    let n = 0;
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
        let sum = 0;
        if (prev) for (let i = 0; i < small.length; i++) sum += Math.abs((small[i] as number) - (prev[i] as number));
        diffs.push(prev ? sum / small.length : 0);
        prev = small;
        const g = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) g[i] = ((f[i * 3] as number) * 77 + (f[i * 3 + 1] as number) * 150 + (f[i * 3 + 2] as number) * 29) >> 8;
        greys.push(g);
        if (greys.length > STEP + 1) greys.shift();
        if (n >= STEP && n % STEP === 0) {
          const e = estimatePair(greys[0] as Uint8Array, g, w, h);
          pairs.push({ a: n - STEP, tx: e.tx, ty: e.ty, s: e.s, ok: e.ok });
        }
        n++;
        buf = buf.subarray(size);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && !diffs.length) return reject(new Error(`could not decode ${file}`));
      const cpu = process.cpuUsage(cpu0);
      resolve({ diffs, pairs, decodeMs: performance.now() - t0, cpuMs: (cpu.user + cpu.system) / 1000 });
    });
  });
}

/** The move over one shot from the pairs inside it (pairs that span a cut, or touch its first/last 2 frames, are left out). */
export function shotMotion(pairs: Analysis['pairs'], inF: number, outF: number, fps: number, w: number, h: number): ShotMotion {
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
  let kind: MotionKind = 'static';
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

/** Frames to look at in a shot: 1 under 2.5 s, then one per 2.5 s, at most 6, spread over the shot away from its cuts. */
export function keyframesFor(inF: number, outF: number, fps: number): number[] {
  const margin = Math.min(3, Math.floor((outF - inF) / 4));
  const a = inF + margin;
  const len = outF - margin - a;
  const n = Math.max(1, Math.min(6, Math.ceil(len / fps / 2.5)));
  return Array.from({ length: n }, (_, j) => a + Math.floor(((j + 0.5) * len) / n));
}
