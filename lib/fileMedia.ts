// What the Files tab shows of footage, pictures and sound (server/routes/files.ts): a small poster of footage and
// pictures, the length of footage and sound, their size in pixels. Made on demand, the first time a row is seen, from
// the bytes this server keeps on its own disk — a file whose bytes live only in a bucket gets none (fetching gigabytes
// for a thumbnail isn't cheap) — by ffprobe and ffmpeg with the incoming demuxers only (these are files from outside)
// and, for a picture, a place in the on-demand gate. Kept by content in the workspace's cache (cache/file-media/): a
// version's bytes never change, so neither do its picture and its length. What can't be read is remembered as such.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blobKey } from './files.ts';
import { cacheDir } from './paths.ts';
import { FFMPEG, INCOMING_LIMITS, MediaBusyError, probe, probeAudio, run } from './probe.ts';
import { pruneDir } from './prune.ts';
import { filesStorage } from './storage/index.ts';
import type { FileKind, FileMedia } from './types.ts';

/** The kinds a row shows a length or a size in pixels for, and those it shows a picture of. */
export const MEDIA_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['footage', 'audio', 'image']);
export const POSTER_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['footage', 'image']);

/** A poster fits this box (twice the row's picture, for sharp screens), in the file's own shape. */
export const POSTER_BOX = { width: 128, height: 72 } as const;
/** What the posters of a workspace may take on its disk before the oldest go (they are made again when seen). */
const POSTERS_CAP_BYTES = 256e6;
/**
 * The facts and the "nothing to make" marks (a few bytes each, kept by content: no file's deletion says when a blob's
 * last one went) are bounded by count: each weighs a disk block, so about 16,000 of them stay, the oldest go first. One
 * that goes is read again (ffprobe) or tried again (a mark) when its file is seen next.
 */
const FACTS_CAP_BYTES = 64e6;
const BLOCK = 4096;
let factWrites = 0;

const SHA256 = /^[0-9a-f]{64}$/;
const dir = (): string => path.join(cacheDir(), 'file-media');
const factsFile = (hash: string) => path.join(dir(), `${hash}.json`);
const posterFile = (hash: string) => path.join(dir(), `${hash}.jpg`);
const noPosterFile = (hash: string) => path.join(dir(), `${hash}.none`);

/** The bytes of a blob on this disk, or null: only in a bucket, or gone. */
function localBytes(hash: string): string | null {
  const p = filesStorage().localPath(blobKey(hash));
  return fs.existsSync(p) ? p : null;
}

/** A name of its own for what is being written: two requests for the same file at once (a row's length and its
 * picture) each write theirs, and neither moves the other's away. */
const tmpOf = (to: string, ext = '') => `${to}.${crypto.randomUUID()}.tmp${ext}`;

/** Writes `text` into place in one step: a reader never sees half of it. Kept is only a cache: a failure loses nothing. */
function putFile(to: string, text: string): void {
  const tmp = tmpOf(to);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, to);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
  // (every so many writes: reading the folder on each would cost more than the files)
  if (++factWrites % 64 === 0) pruneDir(dir(), FACTS_CAP_BYTES, (f) => f.endsWith('.json') || f.endsWith('.none'), BLOCK);
}

/**
 * ffmpeg making a new picture under `grab`, the caller's budget for new pictures (lib/shots.ts countedGrab): true when it
 * wrote one into `tmp`. A run that started and made nothing (a file ffmpeg can't read, a timeout) is false and stays
 * counted: it cost what a picture costs, and a broken file asked for again and again must not run for free. Only what
 * never started is given back: the on-demand gate full (MediaBusyError, thrown) — and the budget spent throws before.
 */
async function madeUnder(grab: <T>(work: () => Promise<T>) => Promise<T>, args: string[], tmp: string): Promise<boolean> {
  const ran = await grab(async () => {
    try {
      await run(FFMPEG, args, { nice: 5, incoming: true, onDemand: true, timeout: 30_000 });
      return true;
    } catch (e) {
      if (e instanceof MediaBusyError) throw e;
      return false;
    }
  });
  try {
    return ran && fs.statSync(tmp).size > 0;
  } catch {
    return false;
  }
}

/** The gate full or the budget spent: asked again later, nothing remembered. */
const askAgain = (e: unknown): boolean => (e as { status?: number }).status === 503 || (e as { status?: number }).status === 429;

/**
 * A version's length and size in pixels (footage: both; sound: its length; a picture: its size), or null when it is no
 * such file or its bytes aren't on this disk. Read once, then from the cache; a file ffprobe can't read is `{}`.
 */
export async function mediaOf(hash: string, kind: FileKind): Promise<FileMedia | null> {
  if (!SHA256.test(hash) || !MEDIA_KINDS.has(kind)) return null;
  try {
    return JSON.parse(fs.readFileSync(factsFile(hash), 'utf8')) as FileMedia;
  } catch {}
  const file = localBytes(hash);
  if (!file) return null;
  let facts: FileMedia = {};
  try {
    if (kind === 'audio') {
      const a = await probeAudio(file);
      if (a.duration > 0) facts = { seconds: a.duration };
    } else {
      const m = await probe(file, { incoming: true });
      facts = {
        ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
        // a picture is one frame: no length
        ...(kind === 'footage' && m.duration > 0 ? { seconds: m.duration } : {}),
      };
    }
  } catch {
    // not something ffprobe reads (a camera's raw format, a broken file): remembered, never asked again
  }
  putFile(factsFile(hash), JSON.stringify(facts));
  return facts;
}

/**
 * Whether a version's poster can be asked for (the rows ask only then): footage or a picture whose size in pixels
 * ffprobe read, within the incoming limits, and not one ffmpeg failed on before.
 */
export function posterable(hash: string, kind: FileKind, facts: FileMedia): boolean {
  if (!POSTER_KINDS.has(kind) || !facts.width || !facts.height) return false;
  return Math.max(facts.width, facts.height) <= INCOMING_LIMITS.maxSide && !fs.existsSync(noPosterFile(hash));
}

/**
 * The path of a version's poster (a JPEG within POSTER_BOX, in its own shape), or null: no picture to make (another
 * kind, bytes not on this disk, nothing ffmpeg reads, a picture past the incoming limits). Footage shows its frame at
 * one second (its first for a shorter clip). `grab` takes the caller's budget for new pictures before ffmpeg starts
 * (lib/shots.ts countedGrab) and gives it back when nothing was made.
 */
export async function posterOf(hash: string, kind: FileKind, grab: <T>(work: () => Promise<T>) => Promise<T>): Promise<string | null> {
  if (!SHA256.test(hash) || !POSTER_KINDS.has(kind)) return null;
  const out = posterFile(hash);
  if (fs.existsSync(out)) return out;
  if (fs.existsSync(noPosterFile(hash))) return null;
  const facts = await mediaOf(hash, kind);
  const file = facts && localBytes(hash);
  if (!facts || !file) return null;
  if (!posterable(hash, kind, facts)) {
    putFile(noPosterFile(hash), '');
    return null;
  }
  const at = kind === 'footage' && (facts.seconds ?? 0) > 2 ? 1 : 0;
  const tmp = tmpOf(out, '.jpg');
  fs.mkdirSync(dir(), { recursive: true });
  const { width: w, height: h } = POSTER_BOX;
  // someone is looking at the row: a place in the on-demand gate (lib/probe.ts ON_DEMAND), one frame's time
  const args = [
    ...['-v', 'error', ...(at ? ['-ss', String(at)] : []), '-i', file, '-map', '0:v:0', '-frames:v', '1'],
    ...['-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`, '-q:v', '5', '-y', tmp],
  ];
  let made = false;
  try {
    made = await madeUnder(grab, args, tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (askAgain(e)) throw e;
  }
  if (!made) {
    // what ffmpeg couldn't make a picture of: never tried again
    fs.rmSync(tmp, { force: true });
    putFile(noPosterFile(hash), '');
    return null;
  }
  fs.renameSync(tmp, out);
  pruneDir(dir(), POSTERS_CAP_BYTES, (f) => f.endsWith('.jpg') && f !== path.basename(out));
  return out;
}

/** A clip's scrub strip (a grid's poster under the pointer): this many frames along it, side by side, each within the box. */
export const SCRUB_FRAMES = 8;
export const SCRUB_BOX = { width: 160, height: 90 } as const;

/**
 * The path of a clip's scrub strip, or null (no footage, no length, bytes not here, nothing ffmpeg reads). One ffmpeg
 * seeks to each frame on its own input (a seek and one frame each, never the whole clip), in the on-demand gate. It
 * decodes SCRUB_FRAMES frames, so `grab` counts it as that many of the account's new pictures (the route passes the
 * cost); kept like the poster, and a clip ffmpeg made no strip of is remembered as such, never tried again.
 */
export async function scrubOf(hash: string, kind: FileKind, grab: <T>(work: () => Promise<T>) => Promise<T>): Promise<string | null> {
  if (!SHA256.test(hash) || kind !== 'footage') return null;
  const out = path.join(dir(), `${hash}.scrub.jpg`);
  const none = path.join(dir(), `${hash}.scrub.none`);
  if (fs.existsSync(out)) return out;
  if (fs.existsSync(none)) return null;
  const facts = await mediaOf(hash, kind);
  const file = facts && localBytes(hash);
  if (!facts?.seconds || !file || !posterable(hash, kind, facts)) return null;
  const seconds = facts.seconds;
  const { width: w, height: h } = SCRUB_BOX;
  const at = Array.from({ length: SCRUB_FRAMES }, (_, i) => ((i + 0.5) * seconds) / SCRUB_FRAMES);
  const chains = at.map((_, i) => `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[f${i}]`);
  const filter = `${chains.join(';')};${at.map((_, i) => `[f${i}]`).join('')}hstack=inputs=${at.length}[out]`;
  const tmp = tmpOf(out, '.jpg');
  fs.mkdirSync(dir(), { recursive: true });
  const args = [
    '-v',
    'error',
    ...at.flatMap((t) => ['-ss', t.toFixed(3), '-i', file]),
    ...['-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '6', '-y', tmp],
  ];
  let made = false;
  try {
    made = await madeUnder(grab, args, tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (askAgain(e)) throw e;
  }
  if (!made) {
    fs.rmSync(tmp, { force: true });
    putFile(none, '');
    return null;
  }
  fs.renameSync(tmp, out);
  pruneDir(dir(), POSTERS_CAP_BYTES, (f) => f.endsWith('.jpg') && f !== path.basename(out));
  return out;
}
