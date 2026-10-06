// Recordings waiting to become notes (types.ts Recording): kept with the video until their maker sends or discards
// them, so a reload loses nothing — `data/<slug>/recordings/<rec id>.json` (the recording, its event log and its drafts)
// and `<rec id>.m4a` (the audio, once it arrived). Hearing is lib/stt's `transcribeTimed`; lib/recording.ts turns the
// words and the log into drafts. Sent notes carry their own clip of the audio (a voice note), so the recording goes when
// it has been sent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { reviewDir } from './paths.ts';
import { FFMPEG, run } from './probe.ts';
import { clipBounds, segmentRecording } from './recording.ts';
import { writeAtomic } from './store.ts';
import { transcribeTimed } from './stt/index.ts';
import { compareTime } from './time.ts';
import type { Recording, RecordingDraft, RecordingEvent, Version } from './types.ts';

/** A recording as kept: the public part plus the event log the drafts are made from. */
export interface StoredRecording extends Recording {
  events: RecordingEvent[];
}

const ID = /^rec_[a-f0-9]{12}$/;
export const isRecordingId = (id: string): boolean => ID.test(id);
export const newRecordingId = (): string => `rec_${crypto.randomBytes(6).toString('hex')}`;
export const newDraftId = (): string => `d_${crypto.randomBytes(5).toString('hex')}`;

export const recordingsDir = (slug: string): string => path.join(reviewDir(slug), 'recordings');
const jsonFile = (slug: string, id: string) => path.join(recordingsDir(slug), `${id}.json`);
export const audioFile = (slug: string, id: string): string => path.join(recordingsDir(slug), `${id}.m4a`);

export function saveRecording(r: StoredRecording): void {
  fs.mkdirSync(recordingsDir(r.slug), { recursive: true });
  writeAtomic(jsonFile(r.slug, r.id), JSON.stringify(r));
}

export function loadRecording(slug: string, id: string): StoredRecording | null {
  if (!isRecordingId(id)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(jsonFile(slug, id), 'utf8')) as StoredRecording;
    return r.id === id && r.slug === slug ? r : null;
  } catch {
    return null;
  }
}

/** The video's recordings, oldest first. */
export function listRecordings(slug: string): StoredRecording[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(recordingsDir(slug));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => loadRecording(slug, n.slice(0, -5)))
    .filter((r): r is StoredRecording => !!r)
    .sort((a, b) => compareTime(a.created, b.created));
}

export function removeRecording(slug: string, id: string): void {
  if (!isRecordingId(id)) return;
  fs.rmSync(jsonFile(slug, id), { force: true });
  fs.rmSync(audioFile(slug, id), { force: true });
}

/** What the API shows: everything but the event log. */
export function publicRecording(r: StoredRecording): Recording {
  const { events: _events, ...rest } = r;
  return rest;
}

/** Words with timings from what the engine heard; engines that only time lines have their words spread over them. */
function timedWords(heard: { words: { text: string; t0: number; t1: number }[]; segments: { text: string; t0: number; t1: number }[] }) {
  if (heard.words.length) return heard.words;
  const out: { text: string; t0: number; t1: number }[] = [];
  for (const s of heard.segments) {
    const list = s.text.split(/\s+/).filter(Boolean);
    const step = (s.t1 - s.t0) / Math.max(1, list.length);
    for (const [i, text] of list.entries()) out.push({ text, t0: s.t0 + i * step, t1: s.t0 + (i + 1) * step });
  }
  return out;
}

/**
 * Hears a recording's audio and makes its drafts. A failure keeps the audio and says why; the shapes drawn still become
 * drafts (they don't need words). Returns the recording as saved.
 */
export async function hearRecording(
  slug: string,
  id: string,
  ver: Pick<Version, 'fps' | 'frames' | 'width' | 'height'>,
  stt: Config['stt'],
  log: (m: string) => void = console.error,
): Promise<StoredRecording | null> {
  const r = loadRecording(slug, id);
  if (!r) return null;
  const base = { events: r.events, fps: ver.fps, frames: ver.frames, width: ver.width, height: ver.height, newId: newDraftId };
  let drafts: RecordingDraft[];
  try {
    const heard = await transcribeTimed(audioFile(slug, id), stt, log);
    drafts = segmentRecording({ ...base, words: timedWords(heard) });
    const next: StoredRecording = { ...r, state: 'ready', drafts, ...(heard.text.trim() ? {} : { silent: true }) };
    delete next.error;
    // Sent or discarded while it was being heard: nothing to keep.
    if (!loadRecording(slug, id)) return null;
    saveRecording(next);
    return next;
  } catch (e) {
    log(`recording ${id}: ${(e as Error).message}`);
    drafts = segmentRecording({ ...base, words: [] });
    if (!loadRecording(slug, id)) return null;
    const next: StoredRecording = { ...r, state: 'failed', error: (e as Error).message, drafts };
    saveRecording(next);
    return next;
  }
}

/** A draft's stretch of the recording as its own voice clip (m4a), a little wider than the words so none is cut. */
export async function clipOf(slug: string, id: string, t0: number, t1: number, out: string): Promise<string> {
  const { from, to } = clipBounds(t0, t1);
  await run(
    FFMPEG,
    [
      '-v',
      'error',
      '-ss',
      from.toFixed(3),
      '-to',
      to.toFixed(3),
      '-i',
      audioFile(slug, id),
      '-vn',
      '-ac',
      '1',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      '-y',
      out,
    ],
    { incoming: true },
  );
  return out;
}
