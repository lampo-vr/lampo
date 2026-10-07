// Partial renders arriving and settling (lib/part.ts has the rules, lib/splice.ts the ffmpeg side). An agent sends a
// stretch only where a person allowed it (a note's or a request's PART RENDER OK), whole shots of the newest version
// and the same length as what it replaces: a part never ripples the rest of the video. Its handles are compared with
// the base (the seam). A part is never final; once the next full render arrives, the parts people approved are
// compared with its same frames, the way fix previews are (lib/previews.ts).
import { cachedCuts } from './cuts.ts';
import { analysisSize, BLOCK_CHANGED, blockDiff, greyFilter } from './diff.ts';
import { checkReviewOpen } from './folderIds.ts';
import { MAX_HANDLES, onGrid, PART_HANDLES, partBounds, partEnd, partSpan, partsBefore } from './part.ts';
import { isoLocal, slugify } from './paths.ts';
import { checkIncoming, FFMPEG, isVideoContainer, probe, run } from './probe.ts';
import { seekTime } from './shots.ts';
import { checkSeam } from './splice.ts';
import { approvalsOf, verdictOn } from './stage.ts';
import * as store from './store.ts';
import { timecode } from './time.ts';
import type { Comment, PartRequest, ProbeResult, Review, Version, VersionPart } from './types.ts';

/** Refused with a status a client can act on (409: send a full render instead). */
const refuse = (message: string, status = 409) => Object.assign(new Error(message), { status });

/**
 * The partial renders people allowed on a video: notes (not won't-fix) and requests, on `base`'s frame grid. A moved
 * store's requests count as its notes do (`readHistory`): the opt-in is a person's, made before the move.
 */
export function allowedParts(review: Review, base: Version, events = store.readHistory({ limit: 5000 })): PartRequest[] {
  const out: PartRequest[] = [];
  const fpsOf = (v: number | undefined) => review.versions.find((x) => x.v === v)?.fps ?? base.fps;
  for (const c of review.comments) if (c.part && c.status !== 'wontfix') out.push(onGrid(c.part, fpsOf(c.v), base.fps));
  const slug = slugify(review.video);
  for (const e of events) if (e.type === 'request' && e.part && e.slug === slug) out.push(onGrid(e.part, fpsOf(e.v), base.fps));
  return out;
}

export interface PartPush {
  /** The base frame the part's stretch starts at (its handles come before it). */
  at: number;
  handles?: number;
}

/**
 * Checks a partial render against the video's newest version and works out what it replaces; throws (409) when it
 * can't be one: nobody allowed a part there, another frame size or rate, or a length that doesn't end on a shot.
 */
export async function planPart(review: Review, file: string, push: PartPush): Promise<{ part: VersionPart; meta: ProbeResult }> {
  const base = review.versions.at(-1);
  if (!base) throw refuse('the video has no version to patch');
  const handles = push.handles ?? PART_HANDLES;
  if (!Number.isInteger(handles) || handles < 0 || handles > MAX_HANDLES) throw refuse(`handles must be 0–${MAX_HANDLES} frames`, 400);
  if (!Number.isInteger(push.at) || push.at < 0 || push.at >= base.frames) throw refuse(`--part-at must be a frame of v${base.v} (0–${base.frames - 1})`, 400);
  let meta: ProbeResult;
  try {
    meta = await probe(file, { incoming: true });
  } catch {
    throw refuse('this is not a video ffmpeg can read', 422);
  }
  if (!isVideoContainer(meta.format) || !meta.frames || !meta.width) throw refuse('the part has no video frames', 422);
  checkIncoming(meta);
  if (meta.width !== base.width || meta.height !== base.height || Math.abs(meta.fps - base.fps) > 0.01)
    throw refuse(
      `the part is ${meta.width}×${meta.height} at ${meta.fps} fps, v${base.v} is ${base.width}×${base.height} at ${base.fps} fps: render it the same size and frame rate, or send a full render`,
    );
  const allowed = allowedParts(review, base).filter((p) => p.in === push.at);
  if (!allowed.length) throw refuse(`no note allows a part render at frame ${push.at} of v${base.v} (PART RENDER OK): send a full render`);
  // It may end where the person's stretch ends, or on a later cut (the next shot too, after a seam that jumped).
  const ends = [...allowed.map((p) => p.out + 1), ...(cachedCuts(base) ?? [])];
  const end = partEnd({ at: push.at, length: meta.frames, handles, baseFrames: base.frames, ends });
  if (end === null) {
    const want = allowed[0] as PartRequest;
    const { pre, post } = partBounds({ at: want.in, frames: want.out - want.in + 1, handles }, base.frames);
    throw refuse(
      `the length changed: frames ${want.in}–${want.out} with ${handles} handles are ${pre + want.out - want.in + 1 + post} frames, the part has ${meta.frames}. A part never moves what follows it: send a full render`,
    );
  }
  return { part: { of: base.v, at: push.at, frames: end - push.at, handles }, meta };
}

/** A partial render becomes the next version: checked, its seams compared, stored like an upload (lib/store.ts). */
export async function ingestPart(file: string, o: store.IngestOptions & PartPush): Promise<store.IngestResult> {
  if (!o.slug) throw refuse('a part needs the video it patches (--to <video>)', 400);
  const review = store.loadReview(o.slug);
  if (!review) throw refuse('no such video', 404);
  checkReviewOpen(review);
  store.checkNotSample(review);
  const { part } = await planPart(review, file, o);
  const seam = await checkSeam(review, part, file);
  return store.ingestUpload(file, { ...o, part: { ...part, ...(seam ? { seam } : {}) } });
}

/** "seam clean" · "seam jumps at 00:04:00 (f120)": how a part fits, for agents. */
export function seamLine(p: VersionPart, fps: number): string {
  if (!p.seam) return 'no handles, seams not checked';
  if (p.seam === 'clean') return 'seams clean';
  return `the motion doesn't match at ${timecode(p.seam.jump, fps)} (f${p.seam.jump}): render the next shot too, or a full render`;
}

// ---------------------------------------------------------------- the next full render answers for the parts

/** Notes a part version settled: fixed in it and checked there (a part sent before it, for the same note, didn't). */
const notesOf = (review: Review, part: Version): Comment[] => review.comments.filter((c) => c.status === 'verified' && c.fixed_in_v === part.v);

/** Approved: a team or client approval stands on it, or a fix was checked on it. */
export function partApproved(review: Review, part: Version): boolean {
  const history = approvalsOf(review);
  return (['team', 'client'] as const).some((who) => verdictOn(history, who, part.v)?.status === 'approved') || notesOf(review, part).length > 0;
}

/** The approved parts the newest version (a full render) hasn't been compared with yet. */
export function partsToConfirm(review: Review): Version[] {
  const latest = review.versions.at(-1);
  if (!latest || latest.part) return [];
  return partsBefore(review.versions, latest.v).filter((p) => p.part && !p.part.confirmed && !p.part.mismatch && partApproved(review, p));
}

async function grey(file: string, from: number, n: number, ver: Version): Promise<Buffer[]> {
  const size = analysisSize(ver.width, ver.height);
  const { stdout } = await run(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      seekTime(from, ver.fps).toFixed(6),
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
    { nice: 12, maxBuffer: 1 << 29 },
  );
  const px = size.w * size.h;
  const out: Buffer[] = [];
  for (let i = 0; i + px <= stdout.length && out.length < n; i += px) out.push(stdout.subarray(i, i + px));
  return out;
}

export interface PartMatch {
  diff: number;
  /** The first frame of the part's stretch that differs (a frame of the video). */
  frame?: number;
  reason?: string;
}

/** Compares a part's stretch (its own frames, as uploaded) with the same frames of a full render. */
export async function matchPart(review: Review, part: Version, full: Version): Promise<PartMatch> {
  const p = part.part as VersionPart;
  const span = partSpan(p);
  if (full.width / full.height !== part.width / part.height) return { diff: 255, frame: span.in, reason: `v${full.v} has another frame shape` };
  if (Math.abs(full.fps - part.fps) > 0.01 || span.out >= full.frames)
    return { diff: 255, frame: span.in, reason: `v${full.v} has another length or frame rate` };
  const own = await store.ensureOwnFile(review, part.v);
  const theirs = await store.ensureVersionFile(review, full.v);
  if (!own || !theirs) return { diff: 255, frame: span.in, reason: 'the bytes are gone' };
  const { pre } = partBounds(p, part.frames);
  const [a, b] = await Promise.all([grey(own, pre, p.frames, part), grey(theirs, span.in, p.frames, full)]);
  const size = analysisSize(full.width, full.height);
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = blockDiff(a[i] as Buffer, b[i] as Buffer, size.w, size.h).worst;
    if (d >= BLOCK_CHANGED) return { diff: Math.round(d * 10) / 10, frame: span.in + i };
    worst = Math.max(worst, d);
  }
  if (a.length < p.frames || b.length < p.frames) return { diff: 255, frame: span.in + Math.min(a.length, b.length), reason: 'could not decode every frame' };
  return { diff: Math.round(worst * 10) / 10 };
}

/**
 * Compares the newest full render with every approved part before it: a match is recorded on the part (and said on
 * the notes it settled), a difference too — those notes go back to "check fixes" with where it differs. Returns how
 * many parts were settled. Heavy (ffmpeg): run it through the job queue.
 */
export async function confirmParts(slug: string): Promise<number> {
  const review = store.loadReview(slug);
  if (!review) return 0;
  const todo = partsToConfirm(review);
  const full = review.versions.at(-1) as Version;
  let settled = 0;
  for (const part of todo) {
    const m = await matchPart(review, part, full);
    if (settlePart(slug, part.v, full.v, m)) settled++;
  }
  return settled;
}

function settlePart(slug: string, partV: number, fullV: number, m: PartMatch): boolean {
  const at = isoLocal();
  return store.mutate(slug, (review) => {
    const part = review.versions.find((x) => x.v === partV);
    const p = part?.part;
    if (!part || !p || p.confirmed || p.mismatch || review.versions.at(-1)?.v !== fullV) return false;
    const where = `frames ${p.at}–${p.at + p.frames - 1}`;
    const ok = m.frame === undefined;
    const text = ok
      ? `V${fullV} matches the part approved in V${partV} (${where}, block difference ${m.diff}).`
      : `V${fullV} differs from the part approved in V${partV} at ${timecode(m.frame as number, part.fps)} (f${m.frame}${m.reason ? `: ${m.reason}` : `, block difference ${m.diff}`}): check it again.`;
    if (ok) p.confirmed = { v: fullV, diff: m.diff, at };
    else p.mismatch = { v: fullV, diff: m.diff, at, frame: m.frame as number };
    for (const c of notesOf(review, part)) {
      const reply = ok ? { by: 'system', text, at } : { by: 'system', text, status: 'fixed' as const, fixed_in_v: fullV, at };
      if (!ok) {
        c.status = 'fixed';
        c.fixed_in_v = fullV;
      }
      c.replies.push(reply);
      // A match only informs (the version event says it); a difference sends the fix back to the person.
      if (!ok) store.logEvent({ type: 'status', by: 'system', review, comment: c, reply });
    }
    store.logEvent({ type: 'version', by: 'system', review, v: fullV, text });
    return true;
  });
}
