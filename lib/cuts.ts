// Where a render's shots begin: the cuts a partial render snaps to (lib/part.ts). The detector Auto-check uses
// (lib/qa.ts) — ffmpeg's scdet/scene scores cancel out flashes, ours doesn't — cached per render (renderKey) in
// cache/cuts/. Auto-check writes it too, so a render it checked has its shots for free.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './paths.ts';
import { analysisRows, FFMPEG, lower, spawnMedia } from './probe.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import type { Version } from './types.ts';

export const CUTS_VERSION = 1;
const cacheFile = (ver: Pick<Version, 'hash' | 'sample'>) => path.join(cacheDir(), 'cuts', `${renderKey(ver)}.json`);

interface CutsFile {
  cuts_version: number;
  frames: number;
  cuts: number[];
}

/**
 * Cuts from the mean difference of each frame to the one before (`diffs[i]` compares frame i with i − 1; diffs[0] is
 * 0): a frame whose difference is ≥ 30 and ≥ 3× the local median — fast motion raises the median, cuts don't.
 */
export function cutsFromDiffs(diffs: readonly number[]): { frame: number; score: number }[] {
  const out: { frame: number; score: number }[] = [];
  for (let i = 1; i < diffs.length; i++) {
    const win: number[] = [];
    for (let j = Math.max(1, i - 5); j <= Math.min(diffs.length - 1, i + 5); j++) if (j !== i) win.push(diffs[j] as number);
    win.sort((a, b) => a - b);
    const med = win.length ? (win[Math.floor(win.length / 2)] as number) : 0;
    const d = diffs[i] as number;
    if (d >= 30 && d >= 3 * Math.max(med, 2)) out.push({ frame: i, score: Math.round(d * 10) / 10 });
  }
  return out;
}

export function cachedCuts(ver: Pick<Version, 'hash' | 'sample' | 'frames'>): number[] | null {
  try {
    const c: CutsFile = JSON.parse(fs.readFileSync(cacheFile(ver), 'utf8'));
    return c.cuts_version === CUTS_VERSION && c.frames === ver.frames ? c.cuts : null;
  } catch {
    return null;
  }
}

export function writeCuts(ver: Pick<Version, 'hash' | 'sample' | 'frames'>, cuts: number[]): number[] {
  const file = cacheFile(ver);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cuts_version: CUTS_VERSION, frames: ver.frames, cuts } satisfies CutsFile));
  return cuts;
}

// One small RGB decode (64 px wide): the mean difference of every frame to the one before.
function frameDiffs(file: string, ver: Pick<Version, 'width' | 'height'>): Promise<number[]> {
  const w = 64;
  const h = analysisRows(w, ver.width, ver.height); // at most 1:4, whatever the render (A13 MEDIA-2)
  const size = w * h * 3;
  return new Promise((resolve, reject) => {
    const p = spawnMedia(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    lower(p.pid);
    const diffs: number[] = [];
    let prev: Buffer | null = null;
    let buf: Buffer = Buffer.alloc(0);
    p.stdout.on('data', (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        const cur = buf.subarray(0, size);
        let sum = 0;
        if (prev) for (let i = 0; i < size; i++) sum += Math.abs((cur[i] as number) - (prev[i] as number));
        diffs.push(prev ? sum / size : 0);
        prev = Buffer.from(cur);
        buf = buf.subarray(size);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code !== 0 && !diffs.length ? reject(new Error('could not decode the video')) : resolve(diffs)));
  });
}

const inflight = new Map<string, Promise<number[]>>();

/** The render's cuts (first frames of its shots, the first shot's 0 left out): cached, else found once. */
export function shotCuts(file: string | (() => Promise<string>), ver: Version): Promise<number[]> {
  const hit = cachedCuts(ver);
  if (hit) return Promise.resolve(hit);
  const key = wsKey(renderKey(ver));
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const f = typeof file === 'string' ? file : await file();
    return writeCuts(
      ver,
      cutsFromDiffs(await frameDiffs(f, ver))
        .map((c) => c.frame)
        .filter((c) => c < ver.frames),
    );
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
