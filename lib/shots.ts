// Exact-frame screenshots via ffmpeg. _clean.png = the frame at full resolution, _marked.png = the same frame with
// the drawing burned in (drawing rendered by resvg at video resolution, composited by ffmpeg), _range.jpg = for a note
// about a stretch of the video, up to six frames across it in one picture (first … last), so an agent sees the motion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { drawingSvg } from './drawing.ts';
import { heavy, needJobRoom, PRIORITY, QueueFullError } from './jobs.ts';
import { reviewDir } from './paths.ts';
import { FFMPEG, MediaBusyError, ON_DEMAND, run } from './probe.ts';
import { rangeFrames, stripFrames } from './range.ts';
import type { RateLimit } from './rateLimit.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import * as store from './store.ts';
import type { FrameMeta, FrameRange, Shape, Shots } from './types.ts';

// ffmpeg's accurate input seek keeps the first frame whose pts >= T. Half a frame before frame N means frame N.
export const seekTime = (frame: number, fps: number): number => Math.max(0, (frame - 0.5) / fps);

// Convert YUV → RGB with the matrix the browser uses, so colour feedback matches what was on screen.
export function colorFilter(meta: Partial<FrameMeta> = {}): string {
  const pf = meta.pix_fmt || '';
  const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(pf);
  if (!pf.startsWith('yuv')) return alpha ? 'format=rgba' : 'format=rgb24';
  const cs = meta.color_space || '';
  const matrix = /bt470|smpte170m|bt601/.test(cs) ? 'bt601' : cs === 'bt2020nc' ? 'bt2020' : (meta.height || 1080) >= 720 || cs === 'bt709' ? 'bt709' : 'bt601';
  const range = meta.color_range === 'pc' || pf.startsWith('yuvj') ? 'pc' : 'tv';
  return `scale=in_color_matrix=${matrix}:in_range=${range}:out_range=pc,format=${alpha ? 'rgba' : 'rgb24'}`;
}

/** The longest one frame grab may take: an accurate seek decodes from the keyframe before, seconds at most. */
const GRAB_TIMEOUT_MS = 120_000;

/**
 * How a picture is made: someone waits for it (an on-demand place, lib/probe.ts ON_DEMAND), or `queued`: in a job of the
 * job queue, which takes its own turns (the screenshots that follow a note, `followShots`). Two threads either way.
 */
const how = (queued = false) => ({ onDemand: !queued, threads: ON_DEMAND.threads, timeout: GRAB_TIMEOUT_MS });

/** One exact frame as a PNG; `side`: a JPEG no larger than that on its long side instead (`out` ends in .jpg). */
export async function grabFrame(
  file: string,
  frame: number,
  meta: FrameMeta,
  out: string,
  { side, queued }: { side?: number; queued?: boolean } = {},
): Promise<string> {
  if (meta.frames && frame >= meta.frames) throw new Error(`frame ${frame} is past the end (${meta.frames} frames, last is ${meta.frames - 1})`);
  const tmp = `${out}.tmp${side ? '.jpg' : '.png'}`;
  // someone waits for it (a player, an agent, a note): an on-demand place, two threads, two minutes at most
  await run(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      seekTime(frame, meta.fps).toFixed(6),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      side ? `${colorFilter(meta)},scale=${side}:${side}:force_original_aspect_ratio=decrease:force_divisible_by=2` : colorFilter(meta),
      ...(side ? ['-q:v', '4'] : []),
      '-y',
      tmp,
    ],
    how(queued),
  );
  fs.renameSync(tmp, out);
  return out;
}

export async function renderMarked(
  cleanPng: string,
  drawing: Shape[] | null | undefined,
  width: number,
  height: number,
  out: string,
  { queued }: { queued?: boolean } = {},
): Promise<string> {
  if (!drawing?.length) {
    fs.copyFileSync(cleanPng, out, fs.constants.COPYFILE_FICLONE);
    return out;
  }
  const overlay = path.join(os.tmpdir(), `vr-overlay-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(overlay, new Resvg(drawingSvg(drawing, width, height)).render().asPng());
  const tmp = `${out}.tmp.png`;
  try {
    await run(
      FFMPEG,
      ['-v', 'error', '-i', cleanPng, '-i', overlay, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto', '-frames:v', '1', '-y', tmp],
      how(queued),
    );
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(overlay, { force: true });
  }
  return out;
}

/**
 * Frames of a render side by side in one JPEG — up to three in a row, 2 × 2 for four, 3 × 2 for five or six — each
 * grabbed frame-exactly like a screenshot (a strip made with the fps filter would land between frames). Tiles are
 * 426 px wide for wide pictures, 240 px for tall ones, with a thin black gap.
 */
export async function grabStrip(file: string, frames: number[], meta: FrameMeta, out: string, { queued }: { queued?: boolean } = {}): Promise<string> {
  if (!frames.length) throw new Error('no frames for a strip');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-strip-'));
  try {
    const pngs = frames.map((_, i) => path.join(work, `${i}.png`));
    await Promise.all(frames.map((f, i) => grabFrame(file, f, meta, pngs[i] as string, { queued })));
    const n = pngs.length;
    const cols = n <= 3 ? n : n === 4 ? 2 : 3;
    const tile = (meta.width || 16) >= (meta.height || 9) ? 426 : 240;
    const scaled = pngs.map((_, i) => `[${i}:v]scale=${tile}:-2,pad=iw+4:ih+4:2:2:black,setsar=1[t${i}]`);
    const at = (i: number) => {
      const x =
        i % cols
          ? Array(i % cols)
              .fill('w0')
              .join('+')
          : '0';
      const row = Math.floor(i / cols);
      const y = row ? Array(row).fill('h0').join('+') : '0';
      return `${x}_${y}`;
    };
    const joined =
      n === 1 ? '[t0]copy[s]' : `${pngs.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${n}:layout=${pngs.map((_, i) => at(i)).join('|')}:fill=black[s]`;
    const tmp = `${out}.tmp.jpg`;
    await run(
      FFMPEG,
      [
        '-v',
        'error',
        ...pngs.flatMap((p) => ['-i', p]),
        '-filter_complex',
        `${scaled.join(';')};${joined}`,
        '-map',
        '[s]',
        '-frames:v',
        '1',
        '-q:v',
        '4',
        '-y',
        tmp,
      ],
      how(queued),
    );
    fs.renameSync(tmp, out);
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export interface ShotRequest {
  file: string;
  frame: number;
  meta: FrameMeta;
  drawing: Shape[];
  dir: string;
  id: string;
  /** A note about a stretch of the video: its frames go into <id>_range.jpg as well. */
  range?: FrameRange | null;
  /** Made in a job of the job queue (`followShots`), not while someone waits: no on-demand place. */
  queued?: boolean;
}

// Writes <dir>/<id>_clean.png and <dir>/<id>_marked.png (and <dir>/<id>_range.jpg for a range of two or more frames).
// `meta` needs fps, width, height (+ pix_fmt/color_*).
export async function makeShots({ file, frame, meta, drawing, dir, id, range, queued }: ShotRequest): Promise<Shots> {
  fs.mkdirSync(dir, { recursive: true });
  const clean = path.join(dir, `${id}_clean.png`);
  const marked = path.join(dir, `${id}_marked.png`);
  await grabFrame(file, frame, meta, clean, { queued });
  await renderMarked(clean, drawing, meta.width, meta.height, marked, { queued });
  const shots: Shots = { clean: path.basename(clean), marked: path.basename(marked) };
  if (range && rangeFrames(range) > 1) {
    const strip = path.join(dir, `${id}_range.jpg`);
    await grabStrip(file, stripFrames(range), meta, strip, { queued });
    shots.range = path.basename(strip);
  }
  return shots;
}

/**
 * Removes what makeShots writes for note `id` in `dir`, whether it got that far or not: the screenshots of a note that
 * wasn't saved after all (refused as it was written) stay behind otherwise, in a folder nothing cleans up.
 */
export function dropShots(dir: string, id: string): void {
  for (const end of ['_clean.png', '_marked.png', '_range.jpg']) fs.rmSync(path.join(dir, `${id}${end}`), { force: true });
}

/**
 * A note's screenshots, or none when the on-demand gate has no place for them now (MediaBusyError): a note is never
 * refused for its screenshots (A13 VERIFY-2). Saved without them, `followShots` makes them afterwards.
 */
export async function shotsOrLater(req: ShotRequest): Promise<Shots | undefined> {
  try {
    return await makeShots(req);
  } catch (e) {
    if (!(e instanceof MediaBusyError)) throw e;
    dropShots(req.dir, req.id);
    return undefined;
  }
}

/**
 * The screenshots of a note saved without them (`shotsOrLater`), made in the job queue — where workspaces take turns
 * and no on-demand place is held — and added to the note; `done` runs once they are in. Nothing happens when the
 * workspace's queue is full, or the note is gone, about the whole video or has screenshots by then: it stays as it was
 * saved. For the workspace running now.
 */
export function followShots(slug: string, id: string, done?: () => void): void {
  const review = store.loadReview(slug);
  const note = review?.comments.find((c) => c.id === id);
  const ver = note && review?.versions.find((v) => v.v === note.v);
  if (!review || !note || !ver || note.shots || note.scope === 'video') return;
  try {
    needJobRoom();
  } catch (e) {
    if (e instanceof QueueFullError) return;
    throw e;
  }
  const dir = reviewDir(slug);
  heavy(
    async () => {
      const now = store.loadReview(slug);
      const c = now?.comments.find((x) => x.id === id);
      const v = c && now?.versions.find((x) => x.v === c.v);
      if (!now || !c || !v || c.shots) return false;
      const meta = { ...(now.meta || {}), fps: v.fps, width: v.width, height: v.height, frames: v.frames };
      const file = await store.ensureVersionFile(now, v.v);
      if (!file) return false;
      const shots = await makeShots({ file, frame: c.frame, meta, drawing: c.drawing, dir, id, range: c.range, queued: true });
      return store.attachShots(slug, id, shots);
    },
    PRIORITY.poster,
    { key: wsKey(`shots:${renderKey(ver)}`) },
  ).then(
    (placed) => {
      if (placed) done?.();
      else dropShots(dir, id);
    },
    () => dropShots(dir, id),
  );
}

/**
 * New frames one account may have made for it (a frame made once is served from the cache to whoever asks again), per
 * window (A13 VERIFY-2): past it, 429 until the window moves on. The machine's owner at the machine isn't counted.
 */
export const GRAB_LIMITS = { perAccount: 200, windowMs: 10 * 60_000 };

/** An account asked for more new frames than its limit: it may ask again in `retryAfter` seconds. */
export class TooManyGrabsError extends Error {
  status = 429;
  retryAfter: number;
  /** The same sentence for everyone (lib/publicError.ts). */
  publicText: string;
  constructor(retryAfter: number) {
    super(`too many new frames asked for by one account: try again in ${Math.ceil(retryAfter / 60)} min`);
    this.retryAfter = retryAfter;
    this.publicText = this.message;
  }
}

/** One account's new frames, counted: `check` before a grab (TooManyGrabsError past the limit), `landed` once it is made. */
export interface GrabCount {
  check(): void;
  landed(): void;
}
export const grabCount = (limit: RateLimit, key: string): GrabCount => ({
  check() {
    const wait = limit.retryAfter(key);
    if (wait) throw new TooManyGrabsError(wait);
  },
  landed: () => limit.hit(key),
});
