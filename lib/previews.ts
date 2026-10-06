// Fix previews: a still or a short clip of a fix, made in the project (After Effects, Premiere, Resolve, …) before
// anything is rendered, so a reviewer can check the fix without waiting for a render. Checked with ffprobe, kept like
// renders (the storage adapter: data/<slug>/previews/ on this disk, the bucket with Bunny/S3), and compared with the
// next render automatically: with the measure the version diff uses (lib/diff.ts, worst 16×16 block of 160 px grey
// frames), so a moved caption or a changed grade counts and codec noise doesn't.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisSize, BLOCK_CHANGED, blockDiff, greyFilter } from './diff.ts';
import { checkReviewOpen } from './folderIds.ts';
import { isoLocal } from './paths.ts';
import { FFMPEG, isVideoContainer, probe, run } from './probe.ts';
import { colorFilter, seekTime } from './shots.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import { compTime, timecode, timeToFrame } from './time.ts';
import type { Comment, FixPreview, MediaMeta, ProbeResult, Review, Version } from './types.ts';

export const PREVIEW_LIMITS = {
  /** Sent inline (base64 through MCP or the JSON API). */
  inlineBytes: 8 * 1024 * 1024,
  /** Uploaded through a one-time URL. */
  uploadBytes: 200 * 1024 * 1024,
  clipSeconds: 10,
  maxSide: 8192,
} as const;

const STILL_CODECS: Record<string, string> = { png: '.png', mjpeg: '.jpg', webp: '.webp' };
const STILL_FORMATS = new Set(['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2']);

export interface PreviewRequest {
  kind: 'still' | 'clip';
  /** The frame of the newest render the preview shows (a clip: its first frame). Default: the note's frame. */
  frame?: number;
  source?: FixPreview['source'];
  /** Mark the note fixed with it (the agent's usual step); otherwise it is added as a reply. */
  fixed?: boolean;
  note?: string;
  by: string;
}

/** A fix preview for a note, to be uploaded later (one-time upload URLs): who attaches it goes with the ticket. */
export interface PreviewTarget {
  comment: string;
  request: Omit<PreviewRequest, 'by'>;
}

export interface Attached {
  preview: FixPreview;
  comment: Comment;
  slug: string;
}

const newId = () => `p_${crypto.randomBytes(5).toString('hex')}`;

/** The frame a preview shows, mapped onto another render (same position in seconds, as notes carry over). */
export function previewFrameIn(review: Review, p: Pick<FixPreview, 'frame' | 'v'>, v: number): number {
  const own = review.versions.find((x) => x.v === p.v);
  const ver = review.versions.find((x) => x.v === v);
  if (!own || !ver || own.v === ver.v) return p.frame;
  return timeToFrame(p.frame / own.fps, ver.fps);
}

/** "p_1a2b3c4d5e still of f123 on v3 by agent:x · confirmed in v4", for agents (vr, MCP). */
export function describePreview(p: FixPreview): string {
  const what = p.kind === 'clip' ? `clip f${p.frame}–${p.frame + (p.frames || 1) - 1}` : `still of f${p.frame}`;
  const outcome = p.confirmed ? ` · confirmed in v${p.confirmed.v}` : p.mismatch ? ` · v${p.mismatch.v} differs: ${p.mismatch.reason}` : '';
  return `${p.id} ${what} on v${p.v} by ${p.by}${outcome}`;
}

/** Where a note sits in the project the newest render came from ("12.400 s · frame 310 in After Effects · …"). */
export function projectPosition(review: Review, c: Comment): string | null {
  const latest = review.versions.at(-1);
  const at = latest ? compTime(latest, store.frameIn(review, c, latest.v)) : null;
  if (!latest?.source || !at) return null;
  return `${at.seconds.toFixed(3)} s · frame ${at.frame} in ${store.describeSource(latest.source)} (v${latest.v})`;
}

// Same picture shape as the render (a half-resolution preview is fine, another aspect ratio is another picture).
function sameAspect(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) <= 0.01 * (b.width / b.height);
}

async function inspect(file: string, kind: FixPreview['kind']): Promise<ProbeResult> {
  let meta: ProbeResult;
  try {
    meta = await probe(file, { incoming: true });
  } catch {
    throw new Error(kind === 'still' ? 'not an image ffmpeg can read (send a PNG, JPEG or WebP)' : 'not a video ffmpeg can read');
  }
  if (!meta.width || !meta.height || meta.width > PREVIEW_LIMITS.maxSide || meta.height > PREVIEW_LIMITS.maxSide)
    throw new Error(`the picture must be between 1 and ${PREVIEW_LIMITS.maxSide} px on each side`);
  const format = (meta.format || '').split(',');
  if (kind === 'still') {
    if (!STILL_CODECS[meta.codec] || !format.some((f) => STILL_FORMATS.has(f))) throw new Error('a still must be a PNG, JPEG or WebP image');
    if (meta.frames > 1) throw new Error('a still is one image (send a clip for motion)');
  } else {
    if (!isVideoContainer(meta.format)) throw new Error(`a clip must be a video file (mp4, mov, webm, mkv), not ${meta.format || 'this'}`);
    if (!meta.frames) throw new Error('the clip has no frames');
    if (meta.duration > PREVIEW_LIMITS.clipSeconds + 0.5)
      throw new Error(`a clip may be at most ${PREVIEW_LIMITS.clipSeconds} s long; render the full version instead`);
  }
  return meta;
}

// Clips play in any browser afterwards: H.264 in mp4, even dimensions, audio kept when there is some.
async function playableClip(src: string, out: string): Promise<ProbeResult> {
  await run(
    FFMPEG,
    [
      ...['-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-t', String(PREVIEW_LIMITS.clipSeconds + 0.5)],
      // Tagged BT.709 on the way in, so the comparison reads the colours back exactly as they were meant.
      ...['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv', '-pix_fmt', 'yuv420p'],
      ...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16'],
      ...['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', out],
    ],
    // the agent that attaches it waits: an on-demand place (lib/probe.ts ON_DEMAND)
    { nice: 5, incoming: true, onDemand: true },
  );
  return probe(out);
}

/**
 * Stores a preview file for a note (the caller's file stays where it is) and records it: as the fix when `fixed`,
 * else as a reply. Validated with ffprobe first; clips are re-encoded so every browser plays them.
 */
export async function attachPreview(commentId: string, file: string, req: PreviewRequest): Promise<Attached> {
  const hit = store.findComment(commentId);
  if (!hit) throw new Error(`no note ${commentId}`);
  const { slug, review, comment } = hit;
  checkReviewOpen(review);
  const latest = review.versions.at(-1) as Version;
  const frame = req.frame ?? store.frameIn(review, comment, latest.v);
  if (!Number.isInteger(frame) || frame < 0 || frame >= latest.frames) throw new Error(`frame ${frame} is outside 0–${latest.frames - 1} of v${latest.v}`);
  const size = fs.statSync(file).size;
  if (size > PREVIEW_LIMITS.uploadBytes) throw new Error(`a preview may be at most ${PREVIEW_LIMITS.uploadBytes / 1024 / 1024} MB`);

  let meta = await inspect(file, req.kind);
  if (!sameAspect(meta, latest))
    throw new Error(
      `the preview is ${meta.width}×${meta.height} but v${latest.v} is ${latest.width}×${latest.height}: export the same frame shape (any resolution)`,
    );
  const id = newId();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-preview-'));
  try {
    let ext = STILL_CODECS[meta.codec] || '.mp4';
    let src = file;
    let keep = true;
    if (req.kind === 'clip') {
      src = path.join(work, `${id}.mp4`);
      meta = await playableClip(file, src);
      ext = '.mp4';
      keep = false;
    }
    // In render frames (a 50 fps clip over a 25 fps render covers half as many).
    const frames = req.kind === 'clip' ? Math.max(1, Math.round((meta.frames / meta.fps) * latest.fps)) : undefined;
    if (frames && frame + frames > latest.frames) throw new Error(`the clip runs past the end of v${latest.v} (frame ${frame} + ${frames} frames)`);
    const preview: FixPreview = {
      id,
      kind: req.kind,
      frame,
      ...(frames ? { frames, fps: meta.fps } : {}),
      v: latest.v,
      by: req.by,
      at: isoLocal(),
      width: meta.width,
      height: meta.height,
      file: `${id}${ext}`,
      bytes: fs.statSync(src).size,
      ...(req.source ? { source: { ...req.source, ...(req.source.project ? { project: store.fileName(req.source.project) } : {}) } } : {}),
    };
    const key = store.previewKey(slug, preview.file);
    await storage().put(key, src, { keep, contentType: ext === '.mp4' ? 'video/mp4' : ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}` });
    try {
      store.mutate(slug, (r) => {
        const c = r.comments.find((x) => x.id === commentId);
        if (!c) throw new Error(`no note ${commentId}`);
        c.previews = [...(c.previews || []), preview];
      });
      const what = `${req.kind === 'clip' ? `clip of ${frames} frames from` : 'still of'} ${timecode(frame, latest.fps)} (f${frame}) on top of v${latest.v}`;
      const note = [req.note?.trim(), `Preview: ${what}.`].filter(Boolean).join(' ');
      const updated = store.updateComment(commentId, { status: req.fixed ? 'fixed' : undefined, note, preview: id, by: req.by });
      return { preview, comment: updated, slug };
    } catch (e) {
      await storage()
        .remove(key)
        .catch(() => {});
      throw e;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- matching a later render

/** One picture as grey analysis pixels. `frame`: a frame of a video (seek like screenshots); else the first image. */
async function grey(file: string, size: { w: number; h: number }, o: { frame?: number; fps?: number; meta: FrameColour; last?: boolean }): Promise<Buffer> {
  const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(o.meta.pix_fmt || '');
  // Full-range RGB first, the way the browser shows it; a transparent still counts as composited over black.
  const colour = alpha ? `format=rgba,premultiply=inplace=1,format=rgb24` : colorFilter(o.meta);
  const seek = o.frame !== undefined && o.fps ? ['-ss', seekTime(o.frame, o.fps).toFixed(6)] : o.last ? ['-sseof', '-0.5'] : [];
  const { stdout } = await run(
    FFMPEG,
    [
      ...['-v', 'error', ...seek, '-i', file, '-map', '0:v:0', ...(o.last ? [] : ['-frames:v', '1'])],
      ...['-vf', `${colour},${greyFilter(size.h)}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    ],
    { nice: 12 },
  );
  const n = size.w * size.h;
  const whole = stdout.length - (stdout.length % n);
  if (whole < n) throw new Error('could not decode the picture');
  // From the last half second (-sseof) the final frame is the clip's last.
  return o.last ? stdout.subarray(whole - n, whole) : stdout.subarray(0, n);
}

/** What colorFilter() needs to turn a picture into RGB the way the browser shows it. */
type FrameColour = MediaMeta & { height?: number };

export interface MatchResult {
  /** Worst block difference (0–255); a render matches below BLOCK_CHANGED. */
  diff: number;
  match: boolean;
  /** Why they can't be compared (then match is false). */
  reason?: string;
}

/** Compares a preview with the same moment of a render: a still with one frame, a clip by its first and last frame. */
export async function matchPreview(previewFile: string, p: FixPreview, render: string, ver: Version, meta: MediaMeta, frame: number): Promise<MatchResult> {
  if (!sameAspect(p, ver)) return { diff: 255, match: false, reason: `v${ver.v} has another frame shape (${ver.width}×${ver.height})` };
  const last = frame + (p.frames || 1) - 1;
  if (last >= ver.frames) return { diff: 255, match: false, reason: `v${ver.v} ends before the preview's frame` };
  const size = analysisSize(ver.width, ver.height);
  // Height matters: untagged video is BT.709 from 720 lines up (colorFilter), as the player and screenshots read it.
  const renderAt = (f: number) => grey(render, size, { frame: f, fps: ver.fps, meta: { ...meta, height: ver.height } });
  const pmeta = await probe(previewFile);
  const pairs: [Buffer, Buffer][] = [[await grey(previewFile, size, { meta: pmeta }), await renderAt(frame)]];
  if (p.kind === 'clip' && last > frame) pairs.push([await grey(previewFile, size, { meta: pmeta, last: true }), await renderAt(last)]);
  const diff = Math.max(...pairs.map(([a, b]) => blockDiff(a, b, size.w, size.h).worst));
  return { diff: Math.round(diff * 10) / 10, match: diff < BLOCK_CHANGED };
}

/** Notes verified on a preview that a newer render hasn't been compared with yet. */
export function previewsToCheck(review: Review): { comment: Comment; preview: FixPreview }[] {
  const latest = review.versions.at(-1);
  if (!latest) return [];
  const out: { comment: Comment; preview: FixPreview }[] = [];
  for (const c of review.comments) {
    if (c.status !== 'verified' || !c.verified_on || c.verified_on.v >= latest.v) continue;
    const p = c.previews?.find((x) => x.id === c.verified_on?.preview);
    if (p) out.push({ comment: c, preview: p });
  }
  return out;
}

/**
 * Compares the newest render with every preview a note was verified on: a match confirms the fix (the note stays
 * verified, now on a render); a mismatch sends the note back to "check fixes" with the reason. Returns how many notes
 * were settled. Heavy (ffmpeg): run it through the job queue.
 */
export async function confirmPreviews(slug: string): Promise<number> {
  const review = store.loadReview(slug);
  if (!review) return 0;
  const todo = previewsToCheck(review);
  if (!todo.length) return 0;
  const ver = review.versions.at(-1) as Version;
  const render = await store.ensureVersionFile(review, ver.v);
  if (!render) return 0;
  let settled = 0;
  for (const { comment, preview } of todo) {
    const file = await store.ensurePreviewFile(slug, preview.file);
    const frame = previewFrameIn(review, preview, ver.v);
    const result: MatchResult = file
      ? await matchPreview(file, preview, render, ver, review.meta || {}, frame)
      : { diff: 255, match: false, reason: 'the preview file is gone' };
    if (settlePreview(slug, comment.id, preview.id, ver.v, result)) settled++;
  }
  return settled;
}

// Writes one comparison, unless the note changed meanwhile (reopened, verified again on another preview, …).
function settlePreview(slug: string, commentId: string, previewId: string, v: number, r: MatchResult): boolean {
  const at = isoLocal();
  const what = r.match
    ? `V${v} matches the preview this fix was verified on (block difference ${r.diff}).`
    : `V${v} doesn't match the preview this fix was verified on (${r.reason || `block difference ${r.diff}, a match stays below ${BLOCK_CHANGED}`}): check it again.`;
  return store.mutate(slug, (review) => {
    const c = review.comments.find((x) => x.id === commentId);
    const p = c?.previews?.find((x) => x.id === previewId);
    if (!c || !p || c.status !== 'verified' || c.verified_on?.preview !== previewId || c.verified_on.v >= v) return false;
    delete c.verified_on;
    if (r.match) {
      p.confirmed = { v, diff: r.diff, at };
      const reply = { by: 'system', text: what, preview: previewId, at };
      c.replies.push(reply);
      store.logEvent({ type: 'preview', by: 'system', review, comment: c, reply });
    } else {
      p.mismatch = { v, diff: r.diff, at, reason: r.reason || `block difference ${r.diff}` };
      const reply = { by: 'system', text: what, status: 'fixed' as const, fixed_in_v: v, preview: previewId, at };
      c.status = 'fixed';
      c.fixed_in_v = v;
      c.replies.push(reply);
      store.logEvent({ type: 'status', by: 'system', review, comment: c, reply });
    }
    return true;
  });
}
