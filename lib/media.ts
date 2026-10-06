// Derived media per version (cached by content hash under cache/): poster, waveform, loudness, freezes,
// plus optional project tracks (Remotion timeline.json / words.json) for source mapping and captions.
import fs from 'node:fs';
import path from 'node:path';
import { FREEZE } from './findings.ts';
import { cacheDir, projectDirOf } from './paths.ts';
import { analysisRows, FFMPEG, lower, runBg, spawnMedia } from './probe.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import { colorFilter, seekTime } from './shots.ts';
import { SPRITE_VERSION, spriteFrame, spriteLayout } from './sprite.ts';
import { posterFrame } from './time.ts';
import type { Analysis, FreezeRange, FreezeScan, Loudness, MediaMeta, ProjectTracks, Version, Waveform } from './types.ts';

const cacheFile = (kind: string, hash: string, ext: string) => path.join(cacheDir(), kind, `${hash}${ext}`);

/**
 * The render to derive from: a local file, or a function that produces one. With remote storage the function
 * downloads a working copy, so it is only called on a cache miss: a cached poster or waveform never fetches the render.
 */
export type MediaSource = string | (() => Promise<string>);
const fileOf = (src: MediaSource): Promise<string> => (typeof src === 'string' ? Promise.resolve(src) : src());

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson<T>(file: string, data: T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// One job per key at a time; everyone asking for the same thing awaits the same promise.
const inflight = new Map<string, Promise<unknown>>();
function once<T>(name: string, fn: () => Promise<T>): Promise<T> {
  // per workspace: each has its own cache, so another team's job must neither be joined nor reveal the same bytes
  const key = wsKey(name);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Small queue so a library full of new posters doesn't start 40 ffmpegs (or 40 downloads from remote storage) at once.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>, limit = 3): Promise<T> {
  if (active >= limit) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function cachedPoster(ver: Pick<Version, 'hash' | 'sample'>): string | null {
  const out = cacheFile('posters', renderKey(ver), '.jpg');
  return fs.existsSync(out) ? out : null;
}

export async function poster(src: MediaSource, ver: Version, meta: MediaMeta | undefined): Promise<string> {
  const out = cacheFile('posters', renderKey(ver), '.jpg');
  if (fs.existsSync(out)) return out;
  return once(out, () =>
    slot(async () => {
      const file = await fileOf(src);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const frame = posterFrame(ver);
      const scale = ver.height >= ver.width ? 'scale=-2:640' : 'scale=640:-2';
      await runBg(FFMPEG, [
        '-v',
        'error',
        '-ss',
        seekTime(frame, ver.fps).toFixed(6),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `${colorFilter({ ...meta, ...ver })},${scale}`,
        '-q:v',
        '4',
        '-y',
        `${out}.tmp.jpg`,
      ]);
      fs.renameSync(`${out}.tmp.jpg`, out);
      return out;
    }),
  );
}

/** The hover-scrub sprite of a render, if it was made already (cheap: callers decide whether to queue making it). */
const spriteFile = (hash: string) => cacheFile('sprites', hash, `.v${SPRITE_VERSION}.jpg`);

export function cachedSprite(hash: string): string | null {
  const out = spriteFile(hash);
  return fs.existsSync(out) ? out : null;
}

/**
 * The hover-scrub sprite: SPRITE_COUNT evenly spaced frames in a SPRITE_COLS × SPRITE_ROWS grid (lib/sprite.ts has the
 * layout). Each frame is grabbed like every other still here (a seek to (N − 0.5) / fps, one frame), which stays cheap
 * however long the render is; then one pass tiles them. Heavy: callers run it through lib/jobs.ts at PRIORITY.sprite.
 */
export async function sprite(file: string, ver: Version, meta: MediaMeta | undefined): Promise<string> {
  const out = spriteFile(renderKey(ver));
  if (fs.existsSync(out)) return out;
  return once(out, async () => {
    const layout = spriteLayout(ver.width, ver.height);
    const tmp = `${out}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const filter = `${colorFilter({ ...meta, ...ver })},scale=${layout.tileW}:${layout.tileH}:flags=lanczos,setsar=1`;
      const tile = (i: number) => path.join(tmp, `${String(i).padStart(2, '0')}.png`);
      for (let i = 0; i < layout.count; i++) {
        const frame = spriteFrame(i, ver.frames, layout.count);
        const args = ['-v', 'error', '-ss', seekTime(frame, ver.fps).toFixed(6), '-i', file, '-frames:v', '1', '-vf', filter, '-y', tile(i)];
        await runBg(FFMPEG, args).catch(() => {});
        // A frame the decoder can't reach (a short or damaged tail) repeats the one before, so the grid stays whole.
        if (!fs.existsSync(tile(i))) {
          if (i === 0) throw new Error('no frame to start the sprite with');
          fs.copyFileSync(tile(i - 1), tile(i));
        }
      }
      await runBg(FFMPEG, [
        '-v',
        'error',
        '-framerate',
        '1',
        '-i',
        path.join(tmp, '%02d.png'),
        '-vf',
        `tile=${layout.cols}x${layout.rows}`,
        '-frames:v',
        '1',
        // 10 on ffmpeg's 2–31 scale: ~105 KB for a calm 16:9 render, ~240 KB for a busy one (a card fetches it once).
        '-q:v',
        '10',
        '-y',
        `${out}.tmp.jpg`,
      ]);
      fs.renameSync(`${out}.tmp.jpg`, out);
      return out;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// Peak (0–1) per video frame, so the strip lines up with frame numbers exactly.
export async function waveform(src: MediaSource, ver: Pick<Version, 'hash' | 'sample' | 'fps' | 'frames'>): Promise<Waveform> {
  const out = cacheFile('waveforms', renderKey(ver), '.json');
  const hit = readJson<Waveform>(out);
  if (hit) return hit;
  return once(out, () =>
    slot(async () => {
      const file = await fileOf(src);
      const sr = 12000;
      let pcm: Buffer;
      try {
        pcm = (await runBg(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { maxBuffer: 1 << 30 }))
          .stdout;
      } catch {
        return writeJson(out, { fps: ver.fps, peaks: [], rms: [], audio: false });
      }
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const perFrame = sr / ver.fps;
      const peaks = new Array<number>(ver.frames).fill(0);
      const rms = new Array<number>(ver.frames).fill(0);
      for (let f = 0; f < ver.frames; f++) {
        const a = Math.floor(f * perFrame);
        const b = Math.min(samples.length, Math.floor((f + 1) * perFrame));
        let pk = 0;
        let sq = 0;
        for (let i = a; i < b; i++) {
          const v = Math.abs(samples[i]) / 32768;
          if (v > pk) pk = v;
          sq += v * v;
        }
        peaks[f] = Math.round(pk * 1000) / 1000;
        rms[f] = b > a ? Math.round(Math.sqrt(sq / (b - a)) * 1000) / 1000 : 0;
      }
      return writeJson(out, { fps: ver.fps, peaks, rms, audio: true });
    }),
  );
}

// EBU R128 integrated loudness + true peak.
async function loudness(file: string): Promise<Loudness | null> {
  try {
    const { stderr } = await runBg(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const num = (re: RegExp) => {
      const m = summary.match(re);
      return m ? Number(m[1]) : null;
    };
    return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), true_peak: num(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/) };
  } catch {
    return null;
  }
}

/** The freeze detector's rules (`FreezeScan.v`): 2 watches every patch of the picture and measures each hold's edges. */
export const FREEZE_SCAN = 2;
/** The detector's picture: this many pixels on its short side, the other side by the render's shape (`analysisRows`). */
const FREEZE_SIDE = 270;

/** The median of xs[from…to) (0 when that is empty). */
const median = (xs: number[], from: number, to: number): number => {
  const a = xs.slice(Math.max(0, from), Math.max(0, to)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
/** The lowest and highest of xs[from…to) (0 and 0 when that is empty); a loop: a still hour is more than a spread takes. */
const span = (xs: number[], from: number, to: number): [number, number] => {
  const a = Math.max(0, from);
  const b = Math.min(xs.length, to);
  if (a >= b) return [0, 0];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = a; i < b; i++) {
    if (xs[i] < lo) lo = xs[i];
    if (xs[i] > hi) hi = xs[i];
  }
  return [lo, hi];
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Freeze detector that ignores film grain: grey at 270 px on the short side, Gaussian σ=3; two neighbouring frames look
 * the same when their mean |Δ| is under FREEZE.threshold (0–255) and no patch of the picture (two by two cells of
 * FREEZE.cell px) changes by FREEZE.patchThreshold on average — a small thing moving on a still screen is motion. A
 * hold is ≥ FREEZE.minFrames such frames in a row, with how the picture moves at its edges (`HoldMotion`), which tells
 * a stall from motion coming to rest (lib/findings.ts `holdVerdict`, which the player explains). One frame before and
 * the one being read are kept, whatever the render's length; the steps (a few bytes a frame) are kept for the edges.
 */
export function freezes(
  file: string,
  ver: Pick<Version, 'width' | 'height' | 'fps'>,
  {
    threshold = FREEZE.threshold,
    patch = FREEZE.patchThreshold,
    minFrames = FREEZE.minFrames,
  }: { threshold?: number; patch?: number; minFrames?: number } = {},
): Promise<FreezeScan> {
  const portrait = ver.height >= ver.width;
  const w = portrait ? FREEZE_SIDE : analysisRows(FREEZE_SIDE, ver.height, ver.width);
  const h = portrait ? analysisRows(FREEZE_SIDE, ver.width, ver.height) : FREEZE_SIDE;
  const size = w * h;
  const C = FREEZE.cell;
  const cols = Math.ceil(w / C);
  const rows = Math.ceil(h / C);
  // a patch is two by two cells, one cell apart (so a small thing on a cell's border is whole in some patch)
  const pw = Math.min(2, cols);
  const ph = Math.min(2, rows);
  const cellSum = new Float64Array(cols * rows);
  const cellPx = new Float64Array(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) cellPx[cy * cols + cx] = (Math.min(w, (cx + 1) * C) - cx * C) * (Math.min(h, (cy + 1) * C) - cy * C);
  return new Promise((resolve, reject) => {
    const p = spawnMedia(FFMPEG, [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `scale=${w}:${h},format=gray,gblur=sigma=3`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ]);
    lower(p.pid);
    const prev = Buffer.allocUnsafe(size);
    let havePrev = false;
    let buf: Buffer = Buffer.alloc(0);
    let n = 0;
    // per pair of neighbouring frames: the whole picture's mean |Δ|, and the step (multiples of the still limit)
    const diffs: number[] = [];
    const steps: number[] = [];
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const cur = buf.subarray(0, size);
        if (havePrev) {
          cellSum.fill(0);
          let s = 0;
          for (let y = 0; y < h; y++) {
            const row = y * w;
            const at = ((y / C) | 0) * cols;
            for (let cx = 0; cx < cols; cx++) {
              const end = row + Math.min(w, (cx + 1) * C);
              let c = 0;
              for (let i = row + cx * C; i < end; i++) {
                const v = cur[i] - prev[i];
                c += v < 0 ? -v : v;
              }
              cellSum[at + cx] += c;
              s += c;
            }
          }
          let worst = 0;
          for (let cy = 0; cy + ph <= rows; cy++)
            for (let cx = 0; cx + pw <= cols; cx++) {
              let sum = 0;
              let px = 0;
              for (let yy = cy; yy < cy + ph; yy++)
                for (let xx = cx; xx < cx + pw; xx++) {
                  sum += cellSum[yy * cols + xx];
                  px += cellPx[yy * cols + xx];
                }
              if (sum / px > worst) worst = sum / px;
            }
          diffs.push(s / size);
          steps.push(Math.max(s / size / threshold, worst / patch));
        }
        cur.copy(prev);
        havePrev = true;
        buf = buf.subarray(size);
        n++;
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && !n) return reject(new Error('freeze scan failed'));
      // steps[i] compares frame i+1 with frame i. A run of k steps under 1 = k+1 frames that look the same.
      const k = Math.max(3, Math.round((ver.fps || 25) * FREEZE.paceSeconds));
      const ranges: FreezeRange[] = [];
      let start = -1;
      for (let i = 0; i <= steps.length; i++) {
        const still = i < steps.length && steps[i] < 1;
        if (still && start < 0) start = i;
        if (!still && start >= 0) {
          const frames = i - start + 1;
          if (frames >= minFrames) {
            // the quarter second before the last step in, and after the first step out
            const [steady, before] = span(steps, start - 1 - k, start - 1);
            ranges.push({
              in: start,
              out: i,
              frames,
              min_diff: Math.round(span(diffs, start, i)[0] * 1000) / 1000,
              motion: {
                before: r2(before),
                steady: r2(steady),
                lead: r2(steps[start - 1] ?? 0),
                inside: r2(median(steps, start, i)),
                jump: r2(steps[i] ?? 0),
                after: r2(span(steps, i + 1, i + 1 + k)[1]),
              },
            });
          }
          start = -1;
        }
      }
      resolve({ ranges, frames: n, threshold, min_frames: minFrames, v: FREEZE_SCAN, patch_threshold: patch });
    });
  });
}

/** An analysis whose freeze scan follows today's rules (one that failed isn't tried again on every read). */
const current = (a: Analysis): boolean => !a.freezes || a.freezes.v === FREEZE_SCAN;

export async function analysis(file: string, ver: Version): Promise<Analysis> {
  const out = cacheFile('analysis', renderKey(ver), '.json');
  const hit = readJson<Analysis>(out);
  if (hit && current(hit)) return hit;
  return once(out, () =>
    slot(async () => {
      // a scan by older rules is made again; the loudness it came with still holds
      const [loud, frz] = await Promise.all([hit ? hit.loudness : loudness(file), freezes(file, ver).catch(() => null)]);
      return writeJson(out, { loudness: loud, freezes: frz, at: new Date().toISOString() });
    }, 2),
  );
}

/** A render's analysis, or null until it is made (or made again: a freeze scan by older rules). */
export const cachedAnalysis = (ver: Pick<Version, 'hash' | 'sample'>): Analysis | null => {
  const a = readJson<Analysis>(cacheFile('analysis', renderKey(ver), '.json'));
  return a && current(a) ? a : null;
};

/** A render's loudness, whatever rules its freeze scan followed. */
export const cachedLoudness = (ver: Pick<Version, 'hash' | 'sample'>): Loudness | null =>
  readJson<Analysis>(cacheFile('analysis', renderKey(ver), '.json'))?.loudness ?? null;

// ---------------------------------------------------------------- project tracks

const SKIP_DIRS = /^(node_modules|\.git|public|source|export|_versions|_old|out|dist|build)$/;

function findUp(dir: string, names: string[], depth = 4): Record<string, string> {
  // Breadth-first under the project dir, skipping heavy folders. Returns the first hit per name.
  const found: Record<string, string> = {};
  let level = [dir];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const cur of level) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && names.includes(e.name) && !found[e.name]) found[e.name] = path.join(cur, e.name);
        else if (e.isDirectory() && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) next.push(path.join(cur, e.name));
      }
    }
    level = next;
  }
  return found;
}

interface TimelineFile {
  fps?: number;
  segments?: { id: string; src: number; speed?: number; out: number; n: number; audio?: unknown }[];
  words?: { t?: string; w?: string; s: number; e: number; cut?: boolean }[];
}

type WordsFileEntry = { w?: string; t?: string; word?: string; s?: number; start?: number; e?: number; end?: number; seg?: unknown };

// timeline.json (Remotion-style project timelines): {fps, total, segments:[{id, src, speed, out, n}], words:[{t, s, e, cut}]}
// with s/e/out/n in output frames. words.json: [{w, s, e}] in seconds — only used when it has no "seg" (source) field.
export function projectTracks(videoPath: string): ProjectTracks {
  const dir = projectDirOf(videoPath);
  const found = findUp(dir, ['timeline.json', 'words.json']);
  const res: ProjectTracks = { dir, timeline: null, words: null, segments: null };
  if (found['timeline.json']) {
    const t = readJson<TimelineFile>(found['timeline.json']);
    if (t && Array.isArray(t.segments)) {
      const fps = t.fps || 30;
      res.timeline = found['timeline.json'];
      res.fps = fps;
      res.segments = t.segments
        .filter((s) => Number.isFinite(s.out) && Number.isFinite(s.n))
        .map((s) => ({ id: s.id, in: s.out, out: s.out + s.n, src: s.src, speed: s.speed || 1, audio: s.audio }));
      if (Array.isArray(t.words)) res.words = t.words.filter((w) => !w.cut && Number.isFinite(w.s)).map((w) => ({ w: w.t ?? w.w ?? '', in: w.s, out: w.e }));
    }
  }
  if (!res.words && found['words.json']) {
    const w = readJson<WordsFileEntry[] | { words?: WordsFileEntry[] }>(found['words.json']);
    const list = Array.isArray(w) ? w : w?.words;
    if (Array.isArray(list) && list.length && !('seg' in list[0])) {
      res.words = list.map((x) => ({ w: x.w ?? x.t ?? x.word ?? '', in: (x.s ?? x.start) as number, out: (x.e ?? x.end) as number, seconds: true }));
      res.wordsFile = found['words.json'];
    }
  }
  return res;
}
