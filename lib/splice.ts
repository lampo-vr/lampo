// What a partial render looks like as a whole video (lib/part.ts): the version it patches with the part's frames
// in their place, re-encoded once into the playback copy's place (`scrub/<renderKey>.mp4`, a keyframe every 10 frames
// like every scrub copy) — never into versions/. Every frame keeps its number: frame N is at N / fps exactly, taken by
// counting decoded frames (ffmpeg's `trim=start_frame`, the `select=eq(n,N)` frame grabs agree with). The picture comes
// from the files as uploaded (a part of a part never re-encodes a re-encode); the sound is the patched version's,
// straight through, unless the part's own sound differs over its stretch: then the part's, with a 2-frame blend at
// each seam. Also here: the seam check (the part's handle frames against the base's same frames).
import fs from 'node:fs';
import path from 'node:path';
import { analysisSize, BLOCK_CHANGED, blockDiff, greyFilter } from './diff.ts';
import { partBounds, sourceFrame, spliceSegments } from './part.ts';
import { FFMPEG, MEDIA_TIMEOUT_MS, run } from './probe.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import { seekTime } from './shots.ts';
import { holdForWork, holdingWorkFiles } from './storage/held.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import type { MediaMeta, PartSeam, Review, Version, VersionPart } from './types.ts';

const SCRUB_GOP = 10;
const AUDIO_COPY = new Set(['aac', 'mp3', 'opus', 'alac', 'ac3', 'eac3']);
/** The blend at a seam where the part's sound differs, in frames. */
export const BLEND_FRAMES = 2;

/** Where a part version's whole video is kept: the playback copy's place (server/playback.ts serves it). */
export const spliceKey = (ver: Pick<Version, 'hash' | 'sample'>): string => `scrub/${renderKey(ver)}.mp4`;

/** A frame rate as num/den (25 → 25/1, 29.97 → 30000/1001), for timestamps that are exactly frame N / fps. */
export function fpsRational(fps: number): [number, number] {
  if (Math.abs(fps - Math.round(fps)) < 1e-4) return [Math.round(fps), 1];
  const ntsc = Math.round(fps * 1001);
  if (ntsc % 1000 === 0 && Math.abs(ntsc / 1001 - fps) < 1e-4) return [ntsc, 1001];
  return [Math.round(fps * 1000), 1000];
}

const matrixOf = (meta: MediaMeta | undefined, height: number) => {
  const cs = meta?.color_space || '';
  return /bt470|smpte170m|bt601/.test(cs) ? 'bt601' : cs === 'bt2020nc' ? 'bt2020' : height >= 720 || cs === 'bt709' ? 'bt709' : 'bt601';
};

async function ownFile(review: Review, v: number): Promise<string> {
  const file = await store.ensureOwnFile(review, v);
  if (!file) throw new Error(`the bytes of v${v} are gone`);
  return file;
}

// ---------------------------------------------------------------- sound

/** Loudness per frame (RMS, 0–1) of `frames` frames of a file's sound from `start` seconds; null without sound. */
async function levels(file: string, start: number, frames: number, fps: number): Promise<number[] | null> {
  const sr = 12000;
  let pcm: Buffer;
  try {
    const seek = start > 0 ? ['-ss', start.toFixed(6)] : [];
    pcm = (
      await run(
        FFMPEG,
        ['-v', 'error', ...seek, '-i', file, '-map', '0:a:0', '-t', (frames / fps).toFixed(6), '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
        {
          maxBuffer: 1 << 28,
          nice: 10,
        },
      )
    ).stdout;
  } catch {
    return null;
  }
  if (!pcm.length) return null;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = sr / fps;
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * per);
    const b = Math.min(samples.length, Math.floor((f + 1) * per));
    let sq = 0;
    for (let i = a; i < b; i++) sq += ((samples[i] as number) / 32768) ** 2;
    out.push(b > a ? Math.sqrt(sq / (b - a)) : 0);
  }
  return out;
}

/** Whether two loudness curves sound different: the version diff's rule (smoothed, ±2 frames of slack, 2.5 dB). */
export function soundsDifferent(a: number[], b: number[]): boolean {
  const env = (rms: number[]) =>
    rms.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(rms.length - 1, i + 2); k++) {
        s += (rms[k] as number) ** 2;
        c++;
      }
      return Math.sqrt(s / c);
    });
  const ea = env(a);
  const eb = env(b);
  const db = (x: number) => 20 * Math.log10(x + 1e-3);
  for (let i = 0; i < eb.length && i < ea.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let k = Math.max(0, i - 2); k <= Math.min(ea.length - 1, i + 2); k++) best = Math.min(best, Math.abs(db(eb[i] as number) - db(ea[k] as number)));
    if (Math.max(eb[i] as number, ea[i] as number) >= 0.02 && best > 2.5) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the splice

export interface SplicePlan {
  /** ffmpeg arguments after the inputs' own: the filter graph and the maps. */
  args: string[];
  inputs: string[];
}

/**
 * The ffmpeg run that makes version `ver`'s whole video: one input per segment (lib/part.ts spliceSegments), each
 * trimmed by frame count and laid end to end with timestamps N / fps; the sound of `sound.base` (the patched version's
 * whole video), or with `own` the part's sound over its stretch blended in.
 */
export function splicePlan(
  review: Pick<Review, 'versions' | 'meta'>,
  ver: Version,
  files: Map<number, string>,
  sound: { base: string | null; own: string | null; baseCodec?: string | null },
  out: string,
): SplicePlan {
  const part = ver.part as VersionPart;
  const segs = spliceSegments(review.versions, ver.v);
  if (!segs.length) throw new Error(`v${ver.v} can't be put together: the versions it patches are missing`);
  const [num, den] = fpsRational(ver.fps);
  const matrix = matrixOf(review.meta, ver.height);
  const inputs: string[] = [];
  const graph: string[] = [];
  segs.forEach((s, i) => {
    inputs.push(files.get(s.v) as string);
    graph.push(
      `[${i}:v:0]trim=start_frame=${s.from}:end_frame=${s.to},setpts=PTS-STARTPTS,scale=${ver.width}:${ver.height}:out_color_matrix=${matrix}:out_range=tv,format=yuv420p,setsar=1[v${i}]`,
    );
  });
  graph.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,settb=${den}/${num},setpts=N[vout]`);
  const maps = ['-map', '[vout]'];
  let audio: string[] = [];
  if (sound.base && !sound.own) {
    // The patched version's sound, straight through.
    const b = inputs.push(sound.base) - 1;
    maps.push('-map', `${b}:a:0?`);
    audio = sound.baseCodec && AUDIO_COPY.has(sound.baseCodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k'];
  } else if (sound.base && sound.own) {
    const b = inputs.push(sound.base) - 1;
    const p = inputs.push(sound.own) - 1;
    const fps = num / den;
    const d = BLEND_FRAMES / fps;
    const { pre, post } = partBounds(part, ver.frames);
    const t = (f: number) => (f / fps).toFixed(6);
    const end = part.at + part.frames;
    // Each blend is centred on its seam where the handles allow it; the lengths add up to the video's exactly.
    const pa = Math.min(d / 2, pre / fps);
    const qb = Math.min(d / 2, post / fps);
    // One format for the blend: the patched version's rate and channels (a part's other layout is converted to it).
    const a = review.meta?.audio;
    const layout = a?.channels === 1 ? ':channel_layouts=mono' : a?.channels === 2 ? ':channel_layouts=stereo' : '';
    const norm = `aresample=${a?.sample_rate || 48000},aformat=sample_fmts=fltp${layout}`;
    const ownFrom = Math.max(0, pre / fps - (part.at > 0 ? pa : 0));
    const ownTo = (pre + part.frames) / fps + (end < ver.frames ? qb : 0);
    graph.push(`[${p}:a:0]atrim=start=${ownFrom.toFixed(6)}:end=${ownTo.toFixed(6)},asetpts=PTS-STARTPTS,${norm}[pa]`);
    const before = part.at > 0;
    const after = end < ver.frames;
    graph.push(`[${b}:a:0]${norm},asplit=2[b0][b1]`);
    if (before) graph.push(`[b0]atrim=end=${(part.at / fps + d - pa).toFixed(6)},asetpts=PTS-STARTPTS[ba]`);
    else graph.push('[b0]anullsink');
    if (after) graph.push(`[b1]atrim=start=${(end / fps - (d - qb)).toFixed(6)},asetpts=PTS-STARTPTS[bb]`);
    else graph.push('[b1]anullsink');
    let cur = 'pa';
    if (before) {
      graph.push(`[ba][pa]acrossfade=d=${d.toFixed(6)}:c1=tri:c2=tri[x0]`);
      cur = 'x0';
    }
    if (after) {
      graph.push(`[${cur}][bb]acrossfade=d=${d.toFixed(6)}:c1=tri:c2=tri[x1]`);
      cur = 'x1';
    }
    graph.push(`[${cur}]atrim=end=${t(ver.frames)}[aout]`);
    maps.push('-map', '[aout]');
    audio = ['-c:a', 'aac', '-b:a', '256k'];
  }
  const color = review.meta?.color_space
    ? ['-colorspace', review.meta.color_space, ...(review.meta.color_range ? ['-color_range', review.meta.color_range] : [])]
    : [];
  const args = [
    ...['-filter_complex', graph.join(';'), ...maps],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', String(SCRUB_GOP), '-keyint_min', String(SCRUB_GOP), '-sc_threshold', '0', '-bf', '0'],
    ...['-pix_fmt', 'yuv420p', ...color, '-fps_mode', 'passthrough', ...audio, '-movflags', '+faststart', '-y', out],
  ];
  return { args, inputs };
}

// Whether the part's sound over its stretch differs from what the patched version plays there.
async function ownSoundDiffers(baseFile: string, partFile: string, part: VersionPart, fps: number, baseFrames: number): Promise<boolean> {
  const { pre } = partBounds(part, baseFrames);
  const [a, b] = await Promise.all([levels(baseFile, part.at / fps, part.frames, fps), levels(partFile, pre / fps, part.frames, fps)]);
  if (!a || !b) return false;
  return soundsDifferent(a, b);
}

const inflight = new Map<string, Promise<string>>();

/**
 * Version `ver`'s whole video as a local file (made once, kept by its renderKey; remote stores get it too). Runs
 * ffmpeg itself rather than through the job queue: it is what queued jobs (posters, analysis, the playback copy) wait
 * for, and the queue runs one job at a time.
 */
export function ensureSplice(review: Review, ver: Version): Promise<string> {
  const key = spliceKey(ver);
  const job = wsKey(key);
  const s = storage();
  const running = inflight.get(job);
  if (running)
    return running.then((f) => {
      holdForWork(f);
      return f;
    });
  // its inputs stay among the working copies until it is made (lib/storage/held.ts): it runs outside the job queue
  const p = holdingWorkFiles(async () => {
    if (s.has(key)) {
      const hit = await s.ensureLocal(key);
      if (hit) return hit;
    }
    const part = ver.part as VersionPart;
    const segs = spliceSegments(review.versions, ver.v);
    const files = new Map<number, string>();
    for (const seg of segs) if (!files.has(seg.v)) files.set(seg.v, await ownFile(review, seg.v));
    const base = review.versions.find((x) => x.v === part.of) as Version;
    // The patched version's whole video carries its sound (a part of a part: that part's own splice).
    const baseFile = (await store.ensureVersionFile(review, base.v)) as string;
    if (!baseFile) throw new Error(`the bytes of v${base.v} are gone`);
    const partFile = files.get(ver.v) as string;
    const hasSound = review.meta?.audio !== null;
    const own = hasSound && (await ownSoundDiffers(baseFile, partFile, part, ver.fps, ver.frames)) ? partFile : null;
    const out = s.localPath(key);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.mp4`;
    // The patched version's sound codec: its own file's, or AAC for a splice (made here).
    const baseCodec = base.part ? 'aac' : review.meta?.audio?.codec;
    const plan = splicePlan(review, ver, files, { base: hasSound ? baseFile : null, own, baseCodec }, tmp);
    try {
      await run(FFMPEG, ['-v', 'error', ...plan.inputs.flatMap((f) => ['-i', f]), ...plan.args], {
        nice: 5,
        timeout: Math.max(MEDIA_TIMEOUT_MS, ver.duration * 3000),
      });
      fs.renameSync(tmp, out);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    await s.commit(key, 'video/mp4');
    return out;
  }).finally(() => inflight.delete(job));
  inflight.set(job, p);
  return p;
}

// ---------------------------------------------------------------- the seam check

/** Frames [from, from + n) of a file as grey analysis frames (seeked like frame grabs). */
async function greyRun(file: string, from: number, n: number, fps: number, size: { w: number; h: number }): Promise<Buffer[]> {
  if (n <= 0) return [];
  const { stdout } = await run(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      seekTime(from, fps).toFixed(6),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-frames:v',
      String(n),
      '-vf',
      greyFilter(size.h),
      // every decoded frame, one after another (a seek's first timestamp would make a constant-rate output repeat it)
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ],
    { nice: 10, maxBuffer: 1 << 28 },
  );
  const px = size.w * size.h;
  const out: Buffer[] = [];
  for (let i = 0; i + px <= stdout.length && out.length < n; i += px) out.push(stdout.subarray(i, i + px));
  if (out.length < n) throw new Error('could not decode the frames around the seam');
  return out;
}

/** Base frames [a, b) of version `v` as grey frames, read from the files they come from. */
async function baseGrey(review: Review, v: number, a: number, b: number, size: { w: number; h: number }, fps: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let f = a;
  while (f < b) {
    const src = sourceFrame(review.versions, v, f);
    if (!src) throw new Error(`frame ${f} is outside v${v}`);
    // the run of frames that come from the same file, one after another
    let n = 1;
    while (f + n < b) {
      const next = sourceFrame(review.versions, v, f + n);
      if (!next || next.v !== src.v || next.frame !== src.frame + n) break;
      n++;
    }
    out.push(...(await greyRun(await ownFile(review, src.v), src.frame, n, fps, size)));
    f += n;
  }
  return out;
}

/**
 * The part's handle frames against the base's same frames, with the version diff's block measure: 'clean' when every
 * pair matches, else the first seam where they don't (the base frame the motion jumps at). Undefined without handles.
 */
export async function checkSeam(review: Review, part: VersionPart, partFile: string): Promise<PartSeam | undefined> {
  const base = review.versions.find((x) => x.v === part.of);
  if (!base) throw new Error(`no v${part.of}`);
  const { pre, post } = partBounds(part, base.frames);
  if (!pre && !post) return undefined;
  const size = analysisSize(base.width, base.height);
  const worst = async (own: Buffer[], theirs: Buffer[]) => Math.max(0, ...own.map((x, i) => blockDiff(x, theirs[i] as Buffer, size.w, size.h).worst));
  const seams: { frame: number; diff: number }[] = [];
  if (pre) {
    const own = await greyRun(partFile, 0, pre, base.fps, size);
    seams.push({ frame: part.at, diff: await worst(own, await baseGrey(review, base.v, part.at - pre, part.at, size, base.fps)) });
  }
  if (post) {
    const end = part.at + part.frames;
    const own = await greyRun(partFile, pre + part.frames, post, base.fps, size);
    seams.push({ frame: end, diff: await worst(own, await baseGrey(review, base.v, end, end + post, size, base.fps)) });
  }
  const jump = seams.find((s) => s.diff >= BLOCK_CHANGED);
  return jump ? { jump: jump.frame, diff: Math.round(jump.diff * 10) / 10 } : 'clean';
}
