// Recorded feedback over HTTP: a recording is made in two steps (its event log, then its audio), heard in the
// background (the job queue, right after scrub copies: someone waits for it), reviewed as drafts by the person who made
// it and sent as ordinary notes — each with its own clip of the audio and `recording: {id, t0, t1}`. Only the maker sees,
// changes, sends or discards a recording, in the app: an API token gets 403, as with drafts. lib/recording.ts has the
// rules, lib/recordings.ts the files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { heavy, PRIORITY } from '../../lib/jobs.ts';
import { cacheDir, isoLocal } from '../../lib/paths.ts';
import { probeAudio, probeFormat } from '../../lib/probe.ts';
import { shownTo } from '../../lib/publicError.ts';
import { normalizeRange } from '../../lib/range.ts';
import { RateLimit } from '../../lib/rateLimit.ts';
import { RECORDING_MAX_BYTES, RECORDING_MAX_EVENTS, RECORDING_MAX_SECONDS } from '../../lib/recording.ts';
import {
  audioFile,
  clipOf,
  hearRecording,
  isRecordingId,
  listRecordings,
  loadRecording,
  newRecordingId,
  publicRecording,
  recordingsDir,
  removeRecording,
  type StoredRecording,
  saveRecording,
} from '../../lib/recordings.ts';
import type { CommentInput } from '../../lib/store.ts';
import * as store from '../../lib/store.ts';
import { sttAvailable } from '../../lib/stt/index.ts';
import { forSpeaker } from '../../lib/stt/policy.ts';
import { SEVERITIES } from '../../lib/time.ts';
import type { Comment, Recording, RecordingDraft, RecordingEvent, RecordingSent, RecordingsResponse, Version } from '../../lib/types.ts';
import { toM4a } from '../../lib/voice.ts';
import type { ServerContext } from '../context.ts';
import { accountOf, getReview, getVersion, isOwn, sanitizeDrawing } from '../helpers.ts';
import { audienceOf, body, fail, HttpError, router, sendInternal } from '../http.ts';
import { freeBytes } from '../ready.ts';
import { prepareNote, shotsToFollow } from './review.ts';

const AUDIO_CONTAINERS = new Set(['matroska', 'webm', 'ogg', 'mov', 'mp4', 'wav']);
/** The longest a recording's clock (its events) and its audio may run: the recorder stops at the limit, a moment late. */
const LONGEST = RECORDING_MAX_SECONDS + 5;
const TOO_LONG = `a recording is at most ${RECORDING_MAX_SECONDS / 60} minutes`;
const sec = z.number().min(0).max(LONGEST);

// The audio arrives whole (a body of its own); one over the size a recording may have is refused in the same words as
// one that runs too long.
const rawAudio = express.raw({ type: () => true, limit: RECORDING_MAX_BYTES });
const audioBody: typeof rawAudio = (req, res, next) =>
  rawAudio(req, res, (e?: unknown) => next((e as { type?: string } | undefined)?.type === 'entity.too.large' ? fail(413, TOO_LONG) : e));
const unit = z.number().min(0).max(1);
const frameNo = z.number().int().min(0).max(100_000_000);

const Event = z.discriminatedUnion('k', [
  z.object({ t: sec, k: z.literal('frame'), f: frameNo }),
  z.object({ t: sec, k: z.literal('play') }),
  z.object({ t: sec, k: z.literal('pause') }),
  z.object({ t: sec, k: z.literal('seek'), f: frameNo }),
  z.object({ t: sec, k: z.literal('pointer'), x: unit, y: unit }),
  z.object({ t: sec, k: z.literal('click'), x: unit, y: unit }),
  z.object({ t: sec, k: z.literal('stroke'), f: frameNo, shape: z.unknown() }),
]);
const NewRecording = z.object({
  v: z.number().int().min(1),
  duration: sec,
  events: z.array(Event).max(RECORDING_MAX_EVENTS),
});

const Draft = z.object({
  id: z.string().regex(/^d_[a-f0-9]{10}$/),
  frame: frameNo,
  range: z.object({ in: frameNo, out: frameNo }).nullable(),
  text: z.string().max(20000),
  heard: z.string().max(20000),
  severity: z.enum(SEVERITIES),
  tags: z.array(z.string().max(60)).max(12),
  drawing: z.array(z.unknown()).max(50),
  t0: sec,
  t1: sec,
  spot: z.tuple([unit, unit]).optional(),
});
const DraftsPatch = z.object({ drafts: z.array(Draft).max(500) });
const SendBody = z.object({ ids: z.array(z.string()).max(500).optional() });

/** A draft as kept: frames inside the version, a range only when it is one, shapes that are shapes. */
function cleanDraft(d: z.output<typeof Draft>, ver: Version): RecordingDraft {
  const frame = Math.max(0, Math.min(ver.frames - 1, d.frame));
  let range = null;
  try {
    range = d.range ? normalizeRange(d.range, ver.frames) : null;
  } catch {
    range = null;
  }
  return {
    id: d.id,
    frame: range ? Math.max(range.in, Math.min(range.out, frame)) : frame,
    range,
    text: d.text.trim(),
    heard: d.heard,
    severity: d.severity,
    tags: d.tags.map((x) => x.trim()).filter(Boolean),
    drawing: sanitizeDrawing(d.drawing, ver),
    t0: d.t0,
    t1: Math.max(d.t0, d.t1),
    ...(d.spot ? { spot: d.spot } : {}),
  };
}

/** What a person may read of a failure: a refusal says why; anything else stays in the log (5xx details are nobody's). */
export function refusal(rec: Pick<StoredRecording, 'id'>, e: unknown): { error: string } {
  if (e instanceof HttpError && e.status < 500) return { error: e.message };
  console.error(`recording ${rec.id}: ${(e as Error).message}`);
  return { error: 'a note could not be saved' };
}

export interface PreparedRecording {
  /** The drafts ready to be written, in the order they were said, each as the note it becomes. */
  notes: { draft: RecordingDraft; input: CommentInput }[];
  /** Not picked, or not ready after a failure: they stay with the recording. */
  left: RecordingDraft[];
  error?: string;
}

/**
 * A recording's drafts made ready to be written (each with its clip of the audio as its voice note, the words as heard
 * as its transcript, its screenshots), without writing them: the caller writes them in one batch — on their own
 * (…/recordings/:id/send) or with the person's other drafts (POST …/drafts/send). Nothing said and nothing drawn: dropped.
 */
export async function prepareRecording(ctx: ServerContext, req: Request, rec: StoredRecording, pick: Set<string> | null): Promise<PreparedRecording> {
  const slug = rec.slug;
  const hasAudio = fs.existsSync(audioFile(slug, rec.id));
  const out: PreparedRecording = { notes: [], left: [] };
  for (const d of [...rec.drafts].sort((a, z) => a.t0 - z.t0)) {
    if ((pick && !pick.has(d.id)) || out.error) {
      out.left.push(d);
      continue;
    }
    if (!d.text && !d.drawing.length) continue;
    let voiceId: string | null = null;
    if (hasAudio && d.t1 > d.t0) {
      voiceId = crypto.randomBytes(8).toString('hex');
      const clip = path.join(cacheDir(), 'voice', `${voiceId}.m4a`);
      fs.mkdirSync(path.dirname(clip), { recursive: true });
      try {
        await clipOf(slug, rec.id, d.t0, d.t1, clip);
      } catch (e) {
        console.error(`recording ${rec.id}: no clip for ${d.id}: ${(e as Error).message}`);
        voiceId = null;
      }
    }
    try {
      const input = await prepareNote(
        ctx,
        req,
        slug,
        {
          v: rec.v,
          frame: d.frame,
          range: d.range,
          text: d.text,
          tags: d.tags,
          severity: d.severity,
          kind: 'feedback',
          drawing: d.drawing,
          voiceId,
          // What was said, word for word: agents read it next to the note's (edited) text.
          voiceTranscript: d.heard || null,
        },
        { recording: { id: rec.id, t0: d.t0, t1: d.t1 } },
      );
      out.notes.push({ draft: d, input });
    } catch (e) {
      out.error = refusal(rec, e).error;
      out.left.push(d);
    }
  }
  return out;
}

/** After a send: the recording keeps what is left, or goes. */
export function settleRecording(rec: StoredRecording, left: RecordingDraft[]): void {
  if (left.length) saveRecording({ ...rec, drafts: [...left].sort((a, z) => a.t0 - z.t0) });
  else removeRecording(rec.slug, rec.id);
}

/** A recording as its maker reads it here: why hearing it failed only in words for them (lib/publicError.ts). */
const shown = (req: Request, r: StoredRecording): Recording => {
  const out = publicRecording(r);
  return out.error ? { ...out, error: shownTo(audienceOf(req), out.error, 'the recording could not be heard') } : out;
};

export function recordingRoutes(ctx: ServerContext): Router {
  const r = router();
  // Recordings made per person per hour: enough for a day of reviewing, not for filling a disk.
  const made = new RateLimit(60, 3600_000);

  const mine = (req: Request, rec: StoredRecording) => isOwn(req, rec.by, rec.by_id);
  // What someone said into the microphone and hasn't sent is theirs, in the app, like their drafts (./drafts.ts): never
  // with an API token, which acts for the person but is how agents and scripts reach the server.
  const person = (req: Request) => {
    if (req.auth?.via === 'token') throw fail(403, 'recordings are kept in the app, for people: not with an API token');
  };
  const own = (req: Request, slug: string, id: string): StoredRecording => {
    person(req);
    getReview(slug);
    const rec = isRecordingId(id) ? loadRecording(slug, id) : null;
    // Someone else's recording doesn't exist for you.
    if (!rec || !mine(req, rec)) throw fail(404, 'no such recording');
    return rec;
  };
  const tell = (slug: string, id: string) => ctx.broadcast('recording', { slug, id });

  // Heard in the languages its maker speaks (Settings → Voice notes), like a voice note.
  const hear = (rec: StoredRecording, req: Request) => {
    const review = getReview(rec.slug);
    const ver = getVersion(review, rec.v);
    const stt = forSpeaker(ctx.cfg.stt, req.auth?.user?.prefs?.voice_languages);
    heavy(() => hearRecording(rec.slug, rec.id, ver, stt), PRIORITY.recording, { mustRun: true })
      .catch((e: Error) => console.error(`recording ${rec.id}: ${e.message}`))
      .finally(() => tell(rec.slug, rec.id));
  };

  r.get('/api/review/:slug/recordings', (req, res) => {
    const slug = req.params.slug;
    person(req);
    getReview(slug);
    const out: RecordingsResponse = {
      recordings: listRecordings(slug)
        .filter((x) => mine(req, x))
        .map((x) => shown(req, x)),
    };
    res.json(out);
  });

  // The event log first (small, JSON): the recording exists, waiting for its audio.
  r.post('/api/review/:slug/recordings', express.json({ limit: '6mb' }), (req, res) => {
    const slug = req.params.slug;
    person(req);
    const review = getReview(slug);
    if (!sttAvailable(ctx.cfg.stt)) throw fail(409, 'speech-to-text is off on this server: recorded feedback needs it');
    const b = body(NewRecording, req);
    const ver = getVersion(review, b.v);
    const by = ctx.actor(req);
    if (!made.take(req.auth?.user?.id || by)) throw fail(429, 'too many recordings in the last hour');
    const events: RecordingEvent[] = [];
    for (const e of b.events) {
      if (e.k === 'stroke') {
        const [shape] = sanitizeDrawing([e.shape], ver);
        if (shape) events.push({ t: e.t, k: 'stroke', f: Math.min(e.f, ver.frames - 1), shape });
      } else if (e.k === 'frame' || e.k === 'seek') events.push({ ...e, f: Math.min(e.f, ver.frames - 1) });
      else events.push(e);
    }
    const by_id = accountOf(req, by);
    const rec: StoredRecording = {
      id: newRecordingId(),
      slug,
      v: ver.v,
      by,
      ...(by_id ? { by_id } : {}),
      created: isoLocal(),
      duration: b.duration,
      state: 'uploading',
      drafts: [],
      events,
    };
    saveRecording(rec);
    res.json(shown(req, rec));
  });

  // Then its audio: what the browser recorded (webm/opus, mp4/aac, ogg) or a wav; nothing else reaches ffmpeg's decoders.
  // As long as a recording may be and no longer: its header's duration is the sender's word (a browser's webm has none),
  // so the audio is turned into m4a up to just past the limit, and what reached it is refused, not kept cut.
  r.put('/api/review/:slug/recordings/:id/audio', audioBody, async (req, res) => {
    const slug = req.params.slug;
    const rec = own(req, slug, req.params.id);
    if (rec.state !== 'uploading') throw fail(409, 'this recording has its audio already');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'no audio');
    fs.mkdirSync(recordingsDir(slug), { recursive: true });
    // the disk keeps its reserve (LAMPO_MIN_FREE) for renders and the store, as for notes' screenshots
    const free = freeBytes(recordingsDir(slug));
    if (free !== null && free < (ctx.cfg.min_free_bytes ?? 0) + req.body.length + 64e6)
      throw fail(507, 'the server has no room for recordings right now: try again later');
    const raw = path.join(recordingsDir(slug), `${rec.id}.raw`);
    const file = audioFile(slug, rec.id);
    fs.writeFileSync(raw, req.body);
    try {
      const format = await probeFormat(raw);
      if (!format.split(',').some((f) => AUDIO_CONTAINERS.has(f))) throw fail(400, 'not an audio recording');
      await toM4a(raw, file, { maxSeconds: LONGEST + 1 });
      if ((await probeAudio(file)).duration > LONGEST) {
        fs.rmSync(file, { force: true });
        throw fail(413, TOO_LONG);
      }
    } finally {
      fs.rmSync(raw, { force: true });
    }
    const next: StoredRecording = { ...rec, state: 'hearing' };
    saveRecording(next);
    hear(next, req);
    tell(slug, rec.id);
    res.json(shown(req, next));
  });

  // Hear it again (after a failure: the engine was busy, down, or still loading its model).
  r.post('/api/review/:slug/recordings/:id/hear', (req, res) => {
    const rec = own(req, req.params.slug, req.params.id);
    if (rec.state !== 'failed') throw fail(409, 'only a recording that could not be heard is heard again');
    if (!fs.existsSync(audioFile(rec.slug, rec.id))) throw fail(409, 'the audio of this recording is gone');
    const next: StoredRecording = { ...rec, state: 'hearing' };
    delete next.error;
    saveRecording(next);
    hear(next, req);
    tell(rec.slug, rec.id);
    res.json(shown(req, next));
  });

  r.get('/api/review/:slug/recordings/:id/audio', (req, res) => {
    const rec = own(req, req.params.slug, req.params.id);
    const file = audioFile(rec.slug, rec.id);
    if (!fs.existsSync(file)) throw fail(404, 'no audio yet');
    res.type('audio/mp4');
    sendInternal(res, file);
  });

  // The maker's edits: the whole list of drafts as it stands (deleted and joined ones are simply not in it).
  r.patch('/api/review/:slug/recordings/:id', express.json({ limit: '2mb' }), (req, res) => {
    const rec = own(req, req.params.slug, req.params.id);
    if (rec.state !== 'ready' && rec.state !== 'failed') throw fail(409, 'the drafts are still being made');
    const ver = getVersion(getReview(rec.slug), rec.v);
    const b = body(DraftsPatch, req);
    const next: StoredRecording = { ...rec, drafts: b.drafts.map((d) => cleanDraft(d, ver)) };
    saveRecording(next);
    res.json(shown(req, next));
  });

  // Send: every draft (or the ones named) becomes an ordinary note, in the order they were said, each with its clip of
  // the audio, all in one batch. A draft that fails stays, with the error, for another try; the recording goes once
  // nothing is left.
  r.post('/api/review/:slug/recordings/:id/send', express.json(), async (req, res) => {
    const slug = req.params.slug;
    const rec = own(req, slug, req.params.id);
    if (rec.state !== 'ready' && rec.state !== 'failed') throw fail(409, 'the drafts are still being made');
    const b = body(SendBody, req);
    const made = await prepareRecording(ctx, req, rec, b.ids ? new Set(b.ids) : null);
    let notes: Comment[] = [];
    let { left, error } = made;
    try {
      notes = made.notes.length
        ? store.addComments(
            slug,
            made.notes.map((x) => x.input),
          )
        : [];
    } catch (e) {
      ({ error } = refusal(rec, e));
      left = [...made.notes.map((x) => x.draft), ...left];
    }
    settleRecording(rec, left);
    if (notes.length) {
      ctx.broadcast('review', { slug });
      ctx.broadcast('library', { slug });
      // sent to the video's agent: its run opens, or takes them (a person with the agents right only: server/runs.ts)
      ctx.runs.fromPerson(req, slug, { how: 'send', notes: notes.map((c) => c.id) });
    }
    shotsToFollow(ctx, slug, notes);
    tell(slug, rec.id);
    const out: RecordingSent = { notes, left, ...(error ? { error } : {}) };
    res.json(out);
  });

  r.delete('/api/review/:slug/recordings/:id', (req, res) => {
    const rec = own(req, req.params.slug, req.params.id);
    removeRecording(rec.slug, rec.id);
    tell(rec.slug, rec.id);
    res.json({ ok: true });
  });

  return r;
}
