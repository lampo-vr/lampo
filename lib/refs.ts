// References on notes: what "like this" means. A reviewer (or an agent) attaches an image, a clip, a link or a moment
// of another render to a note, and the agent that fixes it gets the pictures with the note. Images and clips are
// checked with ffprobe as untrusted files (the incoming demuxers only), kept like fix previews (the storage adapter:
// data/<slug>/refs/ on this disk, the bucket with Bunny/S3), and get a JPEG still (≤ 1280 px) for thumbnails and
// agents; a clip is re-encoded to H.264 and gets a strip of six moments. A frame reference stores the frame (and the
// last frame of a range) as stills, so it still reads when that render is archived. Links are never fetched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDraftRefs, listDrafts } from './drafts.ts';
import { heavy, PRIORITY } from './jobs.ts';
import { cutChars } from './names.ts';
import { isoLocal } from './paths.ts';
import { type AudioProbe, FFMPEG, isVideoContainer, probe, probeAudio, run } from './probe.ts';
import { grabFrame } from './shots.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import { timecode } from './time.ts';
import type { Comment, NoteRef, ProbeResult, RefLoudness, Review, Version } from './types.ts';

export { describeRef } from './refLine.ts';

export const REF_LIMITS = {
  /** Sent inline (base64 through MCP or the JSON API). */
  inlineBytes: 8 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  clipBytes: 200 * 1024 * 1024,
  clipSeconds: 60,
  maxSide: 8192,
  /** Long side of the stills (thumbnails, and what agents look at). */
  still: 1280,
  caption: 300,
  url: 2000,
  /** A sound offered as an option (lib/options.ts): a voice line, a music bed, a whoosh. */
  audioBytes: 60 * 1024 * 1024,
  audioSeconds: 180,
  /**
   * What a sound's header may say before anything decodes it (a sound's, or a clip's first audio stream): the cost of
   * decoding and resampling grows with both — 75 KB of FLAC at 655 kHz in 8 channels took 16 s of CPU (A12 OPTM-2).
   * 192 kHz is the highest rate studios record at, 8 channels a 7.1 mix.
   */
  audioRate: 192_000,
  audioChannels: 8,
} as const;

/**
 * Wall-clock limits of the ffmpeg runs on a reference's or an option's file, in ms (lib/probe.ts run's `timeout`): far
 * above what the largest file within REF_LIMITS takes, far below the hour a render's work may (MEDIA_TIMEOUT_MS), so a
 * file that makes ffmpeg crawl is stopped instead of holding the job queue (A12 OPTM-2). Tests lower them.
 */
export const REF_TIMEOUTS = {
  /** A still, a single picture converted. */
  picture: 60_000,
  /** A clip made playable (≤ clipSeconds, ≤ 1920 px), and its strip, which decodes all of it. */
  clip: 300_000,
  /** A sound re-encoded to AAC (≤ audioSeconds). */
  sound: 120_000,
  /** Its EBU R128 measurement. */
  loudness: 60_000,
};

/**
 * The codecs sounds come in (a voice from a speech engine, a music bed, a take from an editor): only these decoders
 * read an option's sound, not every one the allowed containers can carry (MS ADPCM, WavPack, G.726 … — A12 OPTM-3).
 */
const SOUND_CODECS = /^(pcm_[suf](8|16|24|32|64)(le|be)?|mp3|aac|alac|flac|vorbis|opus|ac3|eac3)$/;

/** Refuses an option's sound (or its clip's sound) in a codec sounds don't come in, before anything decodes it. */
export function checkSoundCodec(codec: string, what = 'a sound'): void {
  if (!SOUND_CODECS.test(codec)) throw new Error(`${what} must be PCM (WAV), MP3, AAC, ALAC, FLAC, Vorbis, Opus or AC-3, not ${codec || 'an unknown codec'}`);
}

/** Refuses a sound whose header promises more than any real one, before ffmpeg decodes a sample of it. */
export function checkSound(a: { sample_rate: number; channels: number }, what = 'the sound'): void {
  if (!(a.sample_rate > 0 && a.sample_rate <= REF_LIMITS.audioRate))
    throw new Error(`${what} says its sample rate is ${a.sample_rate || 'unknown'} Hz; at most ${REF_LIMITS.audioRate / 1000} kHz`);
  if (!(a.channels > 0 && a.channels <= REF_LIMITS.audioChannels))
    throw new Error(`${what} says it has ${a.channels || 'no'} channels; at most ${REF_LIMITS.audioChannels}`);
}

/** Every file a reference may have: r_<hex>.<ext>, and .t (still), .s (strip), .e (end frame) JPEGs. */
export const REF_FILE = /^r_[a-f0-9]{10}(\.[tse])?\.(png|jpg|webp|mp4)$/;
/** The same for the items of a question's options, which may also be sounds (m4a). */
export const OPTION_FILE = /^r_[a-f0-9]{10}(\.[tse])?\.(png|jpg|webp|mp4|m4a)$/;

const IMAGE_CODECS: Record<string, string> = { png: '.png', mjpeg: '.jpg', webp: '.webp' };
const IMAGE_FORMATS = new Set(['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2']);
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
};

export const newRefId = (): string => `r_${crypto.randomBytes(5).toString('hex')}`;

/** Where a reference's file is served (the owner's side; review links have their own route). */
export const refUrl = (slug: string, file: string): string => `/api/refs/${encodeURIComponent(slug)}/${file}`;

export interface RefRequest {
  caption?: string;
  by: string;
  /** The account of `by` (a signed-in person on the server; see NoteRef.by_id). */
  by_id?: string;
  /** Said with them: the references come as a reply. Without: they belong to the note itself. */
  note?: string;
  /** Client refs: the review link they came through. */
  share?: string;
}

/** An image or clip reference to be uploaded later (one-time upload URLs): who adds it goes with the ticket. */
export interface RefTarget {
  comment: string;
  request: { caption?: string; note?: string; kind?: 'image' | 'clip'; share?: string; by_id?: string };
  /** `comment` is one of this person's drafts on this video (lib/drafts.ts), not a note. */
  draft?: { slug: string; owner: string };
}

export interface RefAttached {
  ref: NoteRef;
  comment: Comment;
  slug: string;
}

const cleanCaption = (c: string | undefined): string | undefined => (c ? cutChars(c.trim(), REF_LIMITS.caption) : '') || undefined;

function base(kind: NoteRef['kind'], req: RefRequest): NoteRef {
  const caption = cleanCaption(req.caption);
  return {
    id: newRefId(),
    kind,
    ...(caption ? { caption } : {}),
    by: req.by,
    ...(req.by_id ? { by_id: req.by_id } : {}),
    at: isoLocal(),
    ...(req.share ? { share: req.share } : {}),
  };
}

// ---------------------------------------------------------------- links

/**
 * What a link reference keeps of a link: http(s) only, credentials dropped, written as URL writes it, and its site.
 * Throws for anything else. Every link reference goes through it, made here or brought in by an import.
 */
export function linkTarget(raw: string): { url: string; site: string } {
  const text = raw.trim();
  if (!text || text.length > REF_LIMITS.url) throw new Error(`a link must be 1–${REF_LIMITS.url} characters`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('not a link (it must start with https:// or http://)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http and https links can be references');
  if (!u.hostname) throw new Error('the link has no host');
  u.username = '';
  u.password = '';
  return { url: u.toString(), site: u.hostname.replace(/^www\./, '') };
}

/** A link reference: http(s) only, credentials and fragments of userinfo dropped; never fetched by the server. */
export function linkRef(raw: string, req: RefRequest): NoteRef {
  return { ...base('link', req), ...linkTarget(raw) };
}

// ---------------------------------------------------------------- stills

// A JPEG of at most REF_LIMITS.still px on the long side (the first image of the input; `seek` = seconds into a clip).
async function still(src: string, out: string, seek = 0): Promise<void> {
  const size = REF_LIMITS.still;
  await run(
    FFMPEG,
    [
      ...['-v', 'error', ...(seek ? ['-ss', seek.toFixed(3)] : []), '-i', src, '-map', '0:v:0', '-frames:v', '1'],
      ...['-vf', `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', '-y', out],
    ],
    { nice: 5, incoming: true, timeout: REF_TIMEOUTS.picture, onDemand: true },
  );
}

// ---------------------------------------------------------------- images and clips

const NOT_READABLE = 'not an image or a video this app can read (send PNG, JPEG, WebP, GIF, MP4, MOV, WebM or MKV)';
/** An option's file may also be a sound. */
const NOT_READABLE_OPTION =
  'not a picture, clip or sound this app can read (send PNG, JPEG, WebP, GIF, MP4, MOV, WebM or MKV, or a sound as WAV, MP3, M4A or OGG)';

async function inspect(file: string, notReadable = NOT_READABLE): Promise<{ meta: ProbeResult; kind: 'image' | 'clip' }> {
  let meta: ProbeResult;
  try {
    meta = await probe(file, { incoming: true });
  } catch {
    throw new Error(notReadable);
  }
  if (!meta.width || !meta.height) throw new Error(notReadable);
  if (meta.width > REF_LIMITS.maxSide || meta.height > REF_LIMITS.maxSide)
    throw new Error(`the picture must be between 1 and ${REF_LIMITS.maxSide} px on each side`);
  const format = (meta.format || '').split(',');
  const gif = format.includes('gif');
  if ((IMAGE_CODECS[meta.codec] && format.some((f) => IMAGE_FORMATS.has(f))) || (gif && meta.frames <= 1)) {
    if (meta.frames > 1 && !gif) throw new Error('an image is one picture (send motion as a clip)');
    return { meta, kind: 'image' };
  }
  if (!gif && !isVideoContainer(meta.format)) throw new Error(`a clip must be a video file (mp4, mov, webm, mkv) or a GIF, not ${meta.format || 'this'}`);
  if (!meta.frames && !meta.duration) throw new Error('the clip has no frames');
  if (meta.duration > REF_LIMITS.clipSeconds + 0.5) throw new Error(`a clip may be at most ${REF_LIMITS.clipSeconds} s long; cut the part that matters`);
  return { meta, kind: 'clip' };
}

// Plays in every browser: H.264 in mp4, at most 1920 px on the long side, even dimensions, audio kept when there is some.
async function playableClip(src: string, out: string): Promise<ProbeResult> {
  await run(
    FFMPEG,
    [
      ...['-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-t', String(REF_LIMITS.clipSeconds + 0.5)],
      ...['-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2", '-pix_fmt', 'yuv420p'],
      // The sender's tags and chapters stay out of what is stored and served.
      ...['-map_metadata', '-1', '-map_chapters', '-1'],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out],
    ],
    { nice: 5, incoming: true, timeout: REF_TIMEOUTS.clip, onDemand: true },
  );
  return probe(out);
}

// Six moments of a clip in one picture (3 × 2), so an agent sees the motion without playing it.
async function strip(src: string, duration: number, out: string): Promise<void> {
  const rate = 6 / Math.max(duration, 0.2);
  await run(
    FFMPEG,
    [
      ...['-v', 'error', '-i', src, '-map', '0:v:0'],
      ...['-vf', `fps=${rate.toFixed(4)},scale='min(426,iw)':-2,tile=3x2:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', '-y', out],
    ],
    { nice: 8, incoming: true, timeout: REF_TIMEOUTS.clip, onDemand: true },
  );
}

// ---------------------------------------------------------------- sounds (options only)

/**
 * A sound as an option keeps it: AAC in m4a (plays in every browser), its channels as sent, at most audioSeconds. The
 * input came from an agent: only the incoming demuxers read it, and only its first audio stream is taken.
 */
async function playableAudio(src: string, out: string): Promise<AudioProbe> {
  await run(
    FFMPEG,
    [
      ...['-v', 'error', '-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(REF_LIMITS.audioSeconds + 0.5)],
      ...['-map_metadata', '-1', '-map_chapters', '-1'],
      ...['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-y', out],
    ],
    { nice: 5, incoming: true, timeout: REF_TIMEOUTS.sound },
  );
  return probeAudio(out);
}

const tenth = (x: number): number => Math.round(x * 10) / 10;

/**
 * The integrated loudness and true peak in ffmpeg's ebur128 summary — the meter's own block, which starts a line with
 * the filter's log context (an input's tags print indented: a tag that reads like a summary is never taken for one,
 * A12 OPTM-4). null without one; no `tp` when the peak can't be read (unknown, never -70: that left room to raise).
 */
export function loudnessOf(stderr: string): RefLoudness | null {
  const at = [...stderr.matchAll(/^\[Parsed_ebur128_\d+ @ [^\]\n]+\] Summary:$/gm)].at(-1);
  if (at?.index === undefined) return null;
  const summary = stderr.slice(at.index);
  const i = Number(/^ {4}I:\s+(-?[\d.]+) LUFS$/m.exec(summary)?.[1]);
  const tp = Number(/^ {2}True peak:\n {4}Peak:\s+(-?[\d.]+) dBFS$/m.exec(summary)?.[1]);
  if (!Number.isFinite(i)) return null;
  return { i: tenth(i), ...(Number.isFinite(tp) ? { tp: tenth(tp) } : {}) };
}

/**
 * Integrated loudness (EBU R128) and true peak of a file's first audio stream, measured once when it is stored, so a
 * group of sounds can play level (lib/options.ts levelGains); null without sound or when it can't be measured.
 */
export async function measureLoudness(file: string): Promise<RefLoudness | null> {
  try {
    // The measurement is the summary at the end of stderr; the per-frame log stays out of it.
    const { stderr } = await run(
      FFMPEG,
      ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'],
      { nice: 8, incoming: true, timeout: REF_TIMEOUTS.loudness },
    );
    return loudnessOf(stderr);
  } catch {
    return null;
  }
}

async function put(slug: string, file: string, src: string, keep: boolean): Promise<void> {
  await putKey(store.refKey(slug, file), file, src, keep);
}

async function putKey(key: string, file: string, src: string, keep: boolean): Promise<void> {
  await storage().put(key, src, { keep, contentType: CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
}

/** Removes what was stored for references that didn't make it onto a note. */
async function discard(slug: string, refs: NoteRef[]): Promise<void> {
  for (const r of refs)
    for (const f of store.refFiles(r))
      await storage()
        .remove(store.refKey(slug, f))
        .catch(() => {});
}

/** Records references on a note (see store.addRefs), removing their stored files when that fails. */
export async function saveRefs(commentId: string, slug: string, refs: NoteRef[], req: RefRequest): Promise<Comment> {
  try {
    return store.addRefs(commentId, refs, { by: req.by, by_id: req.by_id, note: req.note });
  } catch (e) {
    await discard(slug, refs);
    throw e;
  }
}

/**
 * Stores an image or a clip (the caller's file stays where it is) and adds it to a note. The kind follows from the
 * file: one picture is an image, motion (a video or an animated GIF) a clip.
 */
export async function attachRefFile(commentId: string, file: string, req: RefRequest & { kind?: 'image' | 'clip' }): Promise<RefAttached> {
  const hit = store.findComment(commentId);
  if (!hit) throw new Error(`no note ${commentId}`);
  if ((hit.comment.refs?.length || 0) >= store.REFS_PER_NOTE) throw new Error(`a note carries at most ${store.REFS_PER_NOTE} references`);
  const ref = await storeRefFile(hit.slug, file, req);
  const comment = await saveRefs(commentId, hit.slug, [ref], req);
  return { ref, comment, slug: hit.slug };
}

/** The same for one of a person's drafts (lib/drafts.ts): stored alike, recorded on the draft without an event. */
export async function attachDraftRefFile(
  slug: string,
  owner: string,
  id: string,
  file: string,
  req: RefRequest & { kind?: 'image' | 'clip' },
): Promise<RefAttached> {
  const d = listDrafts(slug, owner).find((x) => x.id === id);
  if (!d) throw new Error('no such draft');
  if ((d.refs?.length || 0) >= store.REFS_PER_NOTE) throw new Error(`a note carries at most ${store.REFS_PER_NOTE} references`);
  const ref = await storeRefFile(slug, file, req);
  try {
    return { ref, comment: addDraftRefs(slug, owner, id, [ref]), slug };
  } catch (e) {
    await discard(slug, [ref]);
    throw e;
  }
}

/**
 * Stores an image or a clip (the caller's file stays where it is) as a reference of a note on `slug`, not recorded on
 * any note yet. The kind follows from the file: one picture is an image, motion (a video or an animated GIF) a clip.
 */
function storeRefFile(slug: string, file: string, req: RefRequest & { kind?: 'image' | 'clip' }): Promise<NoteRef> {
  return storeFile(file, (f) => store.refKey(slug, f), req, { audio: false });
}

/**
 * The file of an option (lib/options.ts, lib/asks.ts) stored at `keyOf(file)`: an image, a clip or a sound — a file
 * without pictures is a sound —, checked like any reference, re-encoded where the browser needs it, and a sound (or a
 * clip's sound) measured once for levelling. One job of the queue (lib/jobs.ts, PRIORITY.option): a question's files and
 * its upload URLs are worked on one at a time, with every other heavy job, and a hosted workspace's full queue refuses
 * it (QueueFullError, 503) instead of starting another ffmpeg (A12 OPTM-2).
 */
export function storeOptionFile(file: string, keyOf: (file: string) => string, req: RefRequest): Promise<NoteRef> {
  return heavy(() => storeFile(file, keyOf, req, { audio: true }), PRIORITY.option);
}

async function storeFile(
  file: string,
  keyOf: (file: string) => string,
  req: RefRequest & { kind?: 'image' | 'clip' },
  o: { audio: boolean },
): Promise<NoteRef> {
  const size = fs.statSync(file).size;
  if (o.audio && (await soundOnly(file))) return storeAudio(file, size, keyOf, req);
  const { meta, kind } = await inspect(file, o.audio ? NOT_READABLE_OPTION : NOT_READABLE);
  if (req.kind && req.kind !== kind)
    throw new Error(req.kind === 'image' ? 'that file has motion: attach it as a clip' : 'that file is one picture: attach it as an image');
  const limit = kind === 'image' ? REF_LIMITS.imageBytes : REF_LIMITS.clipBytes;
  if (size > limit) throw new Error(`${kind === 'image' ? 'an image' : 'a clip'} may be at most ${limit / 1024 / 1024} MB`);
  // A clip's sound is re-encoded with its picture (and measured, an option's): its header is checked first too.
  if (kind === 'clip' && meta.audio) {
    checkSound(meta.audio, 'the clip’s sound');
    // An option's clip plays level with the sounds of its group: its sound is one of theirs.
    if (o.audio) checkSoundCodec(meta.audio.codec, 'the clip’s sound');
  }
  const ref = base(kind, req);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ref-'));
  const save = (name: string, src: string, keep: boolean) => putKey(keyOf(name), name, src, keep);
  try {
    const stillFile = path.join(work, 'still.jpg');
    if (kind === 'image') {
      // A single-frame GIF becomes a PNG (only PNG, JPEG and WebP are served as images).
      const ext = IMAGE_CODECS[meta.codec] || '.png';
      let src = file;
      if (!IMAGE_CODECS[meta.codec]) {
        src = path.join(work, 'image.png');
        await run(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-y', src], {
          nice: 5,
          incoming: true,
          timeout: REF_TIMEOUTS.picture,
          onDemand: true,
        });
      }
      await still(src, stillFile);
      Object.assign(ref, { file: `${ref.id}${ext}`, still: `${ref.id}.t.jpg`, width: meta.width, height: meta.height, bytes: fs.statSync(src).size });
      await save(ref.file as string, src, true);
    } else {
      const mp4 = path.join(work, 'clip.mp4');
      const out = await playableClip(file, mp4);
      const duration = Math.round((out.duration || meta.duration) * 100) / 100;
      await still(mp4, stillFile, Math.min(0.1, duration / 2));
      const stripFile = path.join(work, 'strip.jpg');
      await strip(mp4, duration, stripFile);
      // An option's clip with sound plays level with the others of its group.
      const loudness = o.audio && out.audio ? await measureLoudness(mp4) : null;
      Object.assign(ref, {
        file: `${ref.id}.mp4`,
        still: `${ref.id}.t.jpg`,
        strip: `${ref.id}.s.jpg`,
        width: out.width,
        height: out.height,
        duration,
        bytes: fs.statSync(mp4).size,
        ...(loudness ? { loudness } : {}),
      });
      await save(ref.file as string, mp4, false);
      await save(ref.strip as string, stripFile, false);
    }
    await save(ref.still as string, stillFile, false);
  } catch (e) {
    await removeKeys(store.refFiles(ref).map(keyOf));
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return ref;
}

/** Whether a file is a sound: the incoming demuxers read it, it has an audio stream and no pictures (a cover is none). */
async function soundOnly(file: string): Promise<boolean> {
  try {
    await probe(file, { incoming: true });
    return false;
  } catch {
    try {
      return (await probeAudio(file)).duration > 0;
    } catch {
      return false;
    }
  }
}

async function storeAudio(file: string, size: number, keyOf: (file: string) => string, req: RefRequest): Promise<NoteRef> {
  if (size > REF_LIMITS.audioBytes) throw new Error(`a sound may be at most ${REF_LIMITS.audioBytes / 1024 / 1024} MB`);
  const meta = await probeAudio(file);
  if (meta.duration > REF_LIMITS.audioSeconds + 0.5) throw new Error(`a sound may be at most ${REF_LIMITS.audioSeconds} s long`);
  checkSoundCodec(meta.codec);
  checkSound(meta);
  const ref = base('audio', req);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ref-'));
  try {
    const m4a = path.join(work, 'audio.m4a');
    const out = await playableAudio(file, m4a);
    const loudness = await measureLoudness(m4a);
    Object.assign(ref, {
      file: `${ref.id}.m4a`,
      duration: Math.round(out.duration * 100) / 100,
      bytes: fs.statSync(m4a).size,
      ...(loudness ? { loudness } : {}),
    });
    await putKey(keyOf(ref.file as string), ref.file as string, m4a, false);
    return ref;
  } catch (e) {
    await removeKeys(store.refFiles(ref).map(keyOf));
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- moments of renders

export interface FrameTarget {
  /** The video (slug). */
  video: string;
  /** Default: its newest render. */
  v?: number;
  frame: number;
  /** The last frame of a range (inclusive), at most REF_LIMITS.clipSeconds after `frame`. */
  to_frame?: number;
}

/** Checks a frame reference and names the render it points at (throws with a message for people). */
export function frameTarget(t: FrameTarget): { review: Review; ver: Version } {
  const review = store.loadReview(t.video);
  if (!review || review.archived || !review.versions.length) throw new Error('that video is not in the library');
  const ver = t.v ? review.versions.find((x) => x.v === t.v) : review.versions.at(-1);
  if (!ver) throw new Error(`that video has no v${t.v}`);
  if (!Number.isInteger(t.frame) || t.frame < 0 || t.frame >= ver.frames) throw new Error(`frame ${t.frame} is outside 0–${ver.frames - 1} of v${ver.v}`);
  if (t.to_frame !== undefined) {
    if (!Number.isInteger(t.to_frame) || t.to_frame <= t.frame || t.to_frame >= ver.frames)
      throw new Error(`the range must end after frame ${t.frame} and before ${ver.frames}`);
    if ((t.to_frame - t.frame) / ver.fps > REF_LIMITS.clipSeconds) throw new Error(`a range may be at most ${REF_LIMITS.clipSeconds} s long`);
  }
  return { review, ver };
}

/**
 * A reference to a moment (or a range) of a render in this library, with the frame stored as a still (and the last
 * frame of a range), frame-exact like screenshots. `slug` = the review of the note it goes on (where the stills live).
 */
export async function frameRef(slug: string, t: FrameTarget, req: RefRequest, keyOf?: (file: string) => string): Promise<NoteRef> {
  const { review, ver } = frameTarget(t);
  const src = await store.ensureVersionFile(review, ver.v);
  if (!src) throw new Error(`the bytes of v${ver.v} are gone`);
  const ref: NoteRef = {
    ...base('frame', req),
    video: t.video,
    name: path.basename(review.video),
    v: ver.v,
    frame: t.frame,
    ...(t.to_frame !== undefined ? { to_frame: t.to_frame } : {}),
    timecode: timecode(t.frame, ver.fps),
    fps: ver.fps,
    width: ver.width,
    height: ver.height,
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ref-'));
  try {
    const meta = { ...(review.meta || {}), fps: ver.fps, width: ver.width, height: ver.height, frames: ver.frames };
    const grab = async (frame: number, file: string) => {
      const png = path.join(work, `${frame}.png`);
      await grabFrame(src, frame, meta, png);
      const jpg = path.join(work, `${frame}.jpg`);
      await still(png, jpg);
      await (keyOf ? putKey(keyOf(file), file, jpg, false) : put(slug, file, jpg, false));
    };
    ref.still = `${ref.id}.t.jpg`;
    await grab(t.frame, ref.still);
    if (t.to_frame !== undefined) {
      ref.end = `${ref.id}.e.jpg`;
      await grab(t.to_frame, ref.end);
    }
    return ref;
  } catch (e) {
    if (keyOf) await removeKeys(store.refFiles(ref).map(keyOf));
    else await discard(slug, [ref]);
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function removeKeys(keys: string[]): Promise<void> {
  for (const k of keys)
    await storage()
      .remove(k)
      .catch(() => {});
}

/**
 * An image reference that doesn't belong to a note (a playbook's): checked like a note's image (the incoming demuxers
 * only), stored as sent (a one-frame GIF as PNG) with a JPEG still, at `keyOf(file)`.
 */
export async function imageRef(file: string, keyOf: (file: string) => string, req: RefRequest): Promise<NoteRef> {
  const size = fs.statSync(file).size;
  const { meta, kind } = await inspect(file);
  if (kind !== 'image') throw new Error('that file has motion: a playbook reference is a picture, a link or a moment of a render');
  if (size > REF_LIMITS.imageBytes) throw new Error(`an image may be at most ${REF_LIMITS.imageBytes / 1024 / 1024} MB`);
  const ref = base('image', req);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-ref-'));
  try {
    const ext = IMAGE_CODECS[meta.codec] || '.png';
    let src = file;
    if (!IMAGE_CODECS[meta.codec]) {
      src = path.join(work, 'image.png');
      await run(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-y', src], {
        nice: 5,
        incoming: true,
        timeout: REF_TIMEOUTS.picture,
        onDemand: true,
      });
    }
    const stillFile = path.join(work, 'still.jpg');
    await still(src, stillFile);
    Object.assign(ref, { file: `${ref.id}${ext}`, still: `${ref.id}.t.jpg`, width: meta.width, height: meta.height, bytes: fs.statSync(src).size });
    await putKey(keyOf(ref.file as string), ref.file as string, src, true);
    await putKey(keyOf(ref.still as string), ref.still as string, stillFile, false);
    return ref;
  } catch (e) {
    await removeKeys(store.refFiles(ref).map(keyOf));
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A reference's file on this disk (a working copy with remote storage), for agents; null when it is gone. */
export const refFile = (slug: string, file: string | undefined): Promise<string | null> => (file ? store.ensureRefFile(slug, file) : Promise.resolve(null));

// ---------------------------------------------------------------- references that come with a new note

/** A link or a frame reference as a request names it (files come separately, once the note exists). */
export type InlineRef = { kind: 'link'; url: string; caption?: string } | ({ kind: 'frame'; caption?: string } & FrameTarget);

/**
 * Builds the link and frame references of a note about to be written on review `slug` (frame stills are stored right
 * away): record them with the note, or remove them with `discardRefs` when the note isn't written.
 */
export async function inlineRefs(slug: string, inputs: InlineRef[], req: RefRequest): Promise<NoteRef[]> {
  if (inputs.length > store.REFS_PER_NOTE) throw new Error(`a note carries at most ${store.REFS_PER_NOTE} references`);
  const out: NoteRef[] = [];
  try {
    for (const i of inputs) {
      const one = { ...req, caption: i.caption };
      out.push(i.kind === 'link' ? linkRef(i.url, one) : await frameRef(slug, i, one));
    }
    return out;
  } catch (e) {
    await discard(slug, out);
    throw e;
  }
}

/** Removes the stored files of references that were built but not recorded. */
export const discardRefs = discard;
