// The publish kit: what a person needs to post a final video by hand, no connection needed — the platform's encode
// (H.264 + AAC in MP4, the index at the front, within the platform's size and rate limits: ENCODE_SPECS), an SRT of
// what is said (the transcript, when the render was heard), the cover frame as a JPEG, and the copy as text; one at a
// time or all in one ZIP (streamed, never stored twice). Made in the background (lib/jobs.ts, PRIORITY.publish), kept
// in the cache (cache/publish-kits/<post id>/: disposable, made again on request).
// The same encode is what a post sends when the final file itself isn't what the platform takes (platformFile).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { heavy, PRIORITY } from '../jobs.ts';
import { cacheDir } from '../paths.ts';
import { FFMPEG, run } from '../probe.ts';
import { renderKey } from '../renderKey.ts';
import { wsKey } from '../scope.ts';
import { grabFrame } from '../shots.ts';
import { ensureVersionFile } from '../store.ts';
import { posterFrame } from '../time.ts';
import { toSrt } from '../transcript.ts';
import { cachedTranscript } from '../transcripts.ts';
import type { KitFile, KitInfo, MediaMeta, Post, PostFile, PublishPlatform, Review, Version } from '../types.ts';
import { planZip, type ZipPlan } from '../zip.ts';
import { copyText, ENCODE_SPECS, type EncodeSpec, PLATFORM_NAMES } from './platforms.ts';

export const kitDir = (postId: string): string => path.join(cacheDir(), 'publish-kits', postId);
const kitFile = (postId: string): string => path.join(kitDir(postId), 'kit.json');

/** Kits being made now (per workspace: two teams' posts never share an id, but say so anyway). */
const making = new Map<string, Promise<KitInfo>>();

/** The kit of a post as it stands: being made, made (its files), failed (why), or none yet. */
export function kitInfo(postId: string): KitInfo | null {
  if (making.has(wsKey(postId))) return { state: 'making', files: [] };
  try {
    return JSON.parse(fs.readFileSync(kitFile(postId), 'utf8')) as KitInfo;
  } catch {
    return null;
  }
}

/** A file name for people: the video's name and the platform, nothing a shell or an unzipper could trip on. */
export function kitBase(review: Review, platform: PublishPlatform): string {
  const name = path
    .basename(review.video)
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${name || 'video'}-${platform}`;
}

/** The ffmpeg arguments of a platform's encode (pure: tested without a file). */
export function encodeArgs(input: string, output: string, spec: EncodeSpec, ver: Pick<Version, 'width' | 'height' | 'fps'>): string[] {
  const long = Math.max(ver.width, ver.height);
  const short = Math.min(ver.width, ver.height);
  const k = Math.min(1, spec.maxLong / long, spec.maxShort / short);
  // even sides, never larger than the source
  const w = Math.max(2, Math.floor((ver.width * k) / 2) * 2);
  const h = Math.max(2, Math.floor((ver.height * k) / 2) * 2);
  const fps = Math.min(spec.fpsMax, Math.max(spec.fpsMin, ver.fps || 30));
  const gop = Math.max(1, Math.round(fps * 2));
  const vf = [`scale=${w}:${h}:flags=lanczos`, 'format=yuv420p', ...(Math.abs(fps - ver.fps) > 0.01 ? [`fps=${fps}`] : [])].join(',');
  return [
    '-v',
    'error',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'medium',
    '-crf',
    String(spec.crf),
    '-maxrate',
    String(spec.maxRate),
    '-bufsize',
    String(spec.maxRate * 2),
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-flags',
    '+cgop',
    '-c:a',
    'aac',
    '-ar',
    String(spec.audioRate),
    '-b:a',
    String(spec.audioBitrate),
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    // nothing of the render's own goes out: no editing paths, internal titles, places or chapters (A12 PUB-10)
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-y',
    output,
  ];
}

/**
 * Whether a final file is what the platform takes as it is (so the exact bytes go out): MP4 or MOV, H.264 or HEVC in
 * 4:2:0, AAC or no sound, within its size, frame rate and resolution. Otherwise a post sends the platform's encode.
 */
export function fitsAsIs(platform: PublishPlatform, review: Pick<Review, 'video' | 'meta'>, ver: Pick<Version, 'width' | 'height' | 'fps' | 'size'>): boolean {
  if (platform === 'youtube') return true;
  const spec = ENCODE_SPECS[platform];
  const m: MediaMeta = review.meta ?? {};
  const ext = path.extname(review.video).toLowerCase();
  if (!['.mp4', '.mov', '.m4v'].includes(ext)) return false;
  if (!['h264', 'hevc'].includes(String(m.codec || ''))) return false;
  if (m.pix_fmt && m.pix_fmt !== 'yuv420p' && m.pix_fmt !== 'yuvj420p') return false;
  if (m.audio && m.audio.codec !== 'aac') return false;
  if (m.audio && m.audio.sample_rate > 48000) return false;
  if (ver.fps < spec.fpsMin || ver.fps > spec.fpsMax) return false;
  if (Math.max(ver.width, ver.height) > spec.maxLong || Math.min(ver.width, ver.height) > spec.maxShort) return false;
  return ver.size <= spec.maxBytes;
}

const sha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

/** The platform's encode of the final, made once per post and render (the kit's own). */
async function encodeFor(post: Post, review: Review, ver: Version): Promise<string> {
  const dir = kitDir(post.id);
  const out = path.join(dir, `${kitBase(review, post.platform)}.mp4`);
  const stamp = path.join(dir, 'encode.key');
  const key = `${renderKey(ver)}:${post.platform}`;
  try {
    if (fs.readFileSync(stamp, 'utf8') === key && fs.statSync(out).size > 0) return out;
  } catch {}
  const src = await ensureVersionFile(review, ver.v);
  if (!src) throw new Error(`V${ver.v}'s file is gone: the kit can't be made`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${out}.part.mp4`;
  // no owed work: under the workspace's cap like anyone's job (A12 PUB-4); a send waits and asks again when it is full
  await heavy(() => run(FFMPEG, encodeArgs(src, tmp, ENCODE_SPECS[post.platform], ver)), PRIORITY.publish);
  const size = fs.statSync(tmp).size;
  const spec = ENCODE_SPECS[post.platform];
  if (size > spec.maxBytes) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `the ${PLATFORM_NAMES[post.platform]} encode is ${Math.round(size / 1e6)} MB: ${PLATFORM_NAMES[post.platform]} takes ${Math.round(spec.maxBytes / 1e6)} MB`,
    );
  }
  fs.renameSync(tmp, out);
  fs.writeFileSync(stamp, key);
  return out;
}

/** The file a post sends: the final's own bytes when the platform takes them, else its encode (with that file's hash). */
export async function platformFile(post: Post, review: Review): Promise<{ file: string; info: PostFile }> {
  const ver = review.versions.find((x) => x.v === post.v);
  if (!ver) throw new Error(`V${post.v} is gone`);
  if (fitsAsIs(post.platform, review, ver)) {
    const file = await ensureVersionFile(review, ver.v);
    if (!file) throw new Error(`V${ver.v}'s file is gone`);
    return { file, info: { kind: 'final', hash: renderKey(ver), bytes: fs.statSync(file).size } };
  }
  const file = await encodeFor(post, review, ver);
  return { file, info: { kind: 'encode', hash: await sha256(file), bytes: fs.statSync(file).size } };
}

/** The cover frame as a JPEG (the chosen frame; the kit falls back to the poster's frame). */
export async function coverJpeg(post: Post, review: Review, out: string, fallback = false): Promise<string | null> {
  const ver = review.versions.find((x) => x.v === post.v);
  if (!ver) return null;
  const frame = post.cover_frame ?? (fallback ? posterFrame(ver) : null);
  if (frame === null) return null;
  const src = await ensureVersionFile(review, ver.v);
  if (!src) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = `${out}.png`;
  await grabFrame(src, Math.min(frame, ver.frames - 1), { fps: ver.fps, width: ver.width, height: ver.height, frames: ver.frames, ...review.meta }, png);
  await run(FFMPEG, ['-v', 'error', '-i', png, '-q:v', '2', '-y', out]);
  fs.rmSync(png, { force: true });
  return out;
}

/**
 * The post's cover as a JPEG, one per post (A12 PUB-9): made again only when the frame or the render changes, so a page
 * asking for frame after frame keeps one file, never one per frame. Null without a chosen frame.
 */
export async function cachedCover(post: Post, review: Review): Promise<string | null> {
  const ver = review.versions.find((x) => x.v === post.v);
  if (!ver || post.cover_frame === null) return null;
  const dir = kitDir(post.id);
  const out = path.join(dir, 'cover.jpg');
  const stamp = path.join(dir, 'cover.key');
  const key = `${renderKey(ver)}:${Math.min(post.cover_frame, ver.frames - 1)}`;
  try {
    if (fs.readFileSync(stamp, 'utf8') === key && fs.statSync(out).size > 0) return out;
  } catch {}
  const tmp = path.join(dir, `cover.${process.pid}.${Date.now()}.part.jpg`);
  if (!(await coverJpeg(post, review, tmp))) return null;
  fs.renameSync(tmp, out);
  fs.writeFileSync(stamp, key);
  return out;
}

/** Makes (or makes again) the kit of a post; resolves with it when done. One at a time per post. */
export function makeKit(post: Post, review: Review): Promise<KitInfo> {
  const key = wsKey(post.id);
  const running = making.get(key);
  if (running) return running;
  const job = (async (): Promise<KitInfo> => {
    const dir = kitDir(post.id);
    const ver = review.versions.find((x) => x.v === post.v);
    try {
      if (!ver) throw new Error(`V${post.v} is gone`);
      fs.mkdirSync(dir, { recursive: true });
      const base = kitBase(review, post.platform);
      const files: KitFile[] = [];
      const video = await encodeFor(post, review, ver);
      files.push({ name: path.basename(video), bytes: fs.statSync(video).size, kind: 'video' });
      const heard = cachedTranscript(ver);
      const srt = path.join(dir, `${base}.srt`);
      if (heard?.lines?.length) {
        fs.writeFileSync(srt, toSrt(heard));
        files.push({ name: path.basename(srt), bytes: fs.statSync(srt).size, kind: 'captions' });
      } else fs.rmSync(srt, { force: true });
      const cover = await coverJpeg(post, review, path.join(dir, `${base}-cover.jpg`), true);
      if (cover) files.push({ name: path.basename(cover), bytes: fs.statSync(cover).size, kind: 'cover' });
      const copy = path.join(dir, `${base}-copy.txt`);
      fs.writeFileSync(copy, copyText(post));
      files.push({ name: path.basename(copy), bytes: fs.statSync(copy).size, kind: 'copy' });
      files.push({ name: 'kit.zip', bytes: kitZip(post.id, files).length, kind: 'zip' });
      const info: KitInfo = { state: 'ready', files, made: new Date().toISOString() };
      fs.writeFileSync(kitFile(post.id), JSON.stringify(info));
      return info;
    } catch (e) {
      const info: KitInfo = { state: 'failed', error: (e as Error).message.split('\n')[0]?.slice(0, 300), files: [] };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(kitFile(post.id), JSON.stringify(info));
      return info;
    } finally {
      making.delete(key);
    }
  })();
  making.set(key, job);
  return job;
}

/** A file of a made kit by its name, or null (only names the kit lists: never a path from a request). */
export function kitPath(postId: string, name: string): string | null {
  const info = kitInfo(postId);
  if (info?.state !== 'ready' || name === 'kit.zip') return null;
  if (!info.files.some((f) => f.name === name)) return null;
  const file = path.join(kitDir(postId), name);
  return fs.existsSync(file) ? file : null;
}

/** All of a kit in one store-only ZIP, laid out without reading a byte (streamed when sent). */
export function kitZip(postId: string, files: KitFile[] = kitInfo(postId)?.files ?? []): ZipPlan {
  const dir = kitDir(postId);
  const entries = files
    .filter((f) => f.kind !== 'zip')
    .map((f) => {
      const file = path.join(dir, f.name);
      const st = fs.statSync(file);
      return {
        name: f.name,
        size: st.size,
        crc: null,
        mtime: st.mtime,
        async *read(start: number, end: number) {
          for await (const chunk of fs.createReadStream(file, { start, end })) yield chunk as Buffer;
        },
      };
    });
  return planZip(entries);
}
