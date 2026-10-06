// A render's transcript, made once per its bytes: the speech engine (lib/stt/) hears the audio with timings, and
// lib/transcript.ts puts the words on the render's frames. Kept in cache/transcripts/<renderKey>.json like the Auto-check's
// results: two videos holding the same render share it, and a cleared cache only costs hearing it again.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { cacheDir } from './paths.ts';
import { renderKey } from './renderKey.ts';
import { wsKey } from './scope.ts';
import { writeAtomic } from './store.ts';
import { transcribeTimed } from './stt/index.ts';
import { buildTranscript, TRANSCRIPT_VERSION } from './transcript.ts';
import type { Transcript, Version } from './types.ts';

const dir = () => path.join(cacheDir(), 'transcripts');
export const transcriptFile = (hash: string): string => path.join(dir(), `${hash}.json`);

export function cachedTranscript(ver: Pick<Version, 'hash' | 'sample'>): Transcript | null {
  try {
    const t: Transcript = JSON.parse(fs.readFileSync(transcriptFile(renderKey(ver)), 'utf8'));
    return t.transcript_version === TRANSCRIPT_VERSION ? t : null;
  } catch {
    return null;
  }
}

export function forgetTranscript(ver: Pick<Version, 'hash' | 'sample'>): void {
  fs.rmSync(transcriptFile(renderKey(ver)), { force: true });
}

const inflight = new Map<string, Promise<Transcript>>();

/**
 * Hears `file` (the bytes of `ver`) and keeps the transcript; one run per render at a time. A render is heard in its
 * own language: detected, or `language` when someone picked it. Never the listeners' languages (voice notes use
 * those): a Swedish film heard "in German" came out as a German-Swedish mix with invented words.
 */
export function makeTranscript(file: string, ver: Version, stt: Config['stt'], log?: (m: string) => void, language?: string): Promise<Transcript> {
  const hit = cachedTranscript(ver);
  if (hit) return Promise.resolve(hit);
  const rk = renderKey(ver);
  const key = wsKey(rk);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const heard = await transcribeTimed(file, { ...stt, languages: language ? [language] : [] } as Config['stt'], log, { repair: true });
      const t = buildTranscript(heard, { hash: ver.hash, fps: ver.fps, frames: ver.frames }, new Date().toISOString());
      fs.mkdirSync(dir(), { recursive: true });
      writeAtomic(transcriptFile(rk), JSON.stringify(t));
      return t;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
