// A render's transcript, made once per its bytes: the speech engine (lib/stt/) hears the audio with timings, and
// lib/transcript.ts puts the words on the render's frames. Kept in cache/transcripts/<renderKey>.json like the Auto-check's
// results: two videos holding the same render share it, and a cleared cache only costs hearing it again.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { cacheDir } from './paths.ts';
import { Memo } from './rateLimit.ts';
import { renderKey } from './renderKey.ts';
import { workspaceOfKey, wsKey } from './scope.ts';
import { writeAtomic } from './store.ts';
import { transcribeTimed } from './stt/index.ts';
import { buildTranscript, TRANSCRIPT_VERSION, toVtt } from './transcript.ts';
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
  forgetCaptions(renderKey(ver));
}

// ---------------------------------------------------------------- captions, as an embed's player asks for them

/**
 * How many renders' captions are kept in memory: whether there are any and their language (a few bytes each), and the
 * WebVTT itself (a 4-hour talk's is a few hundred KB), by count and by bytes.
 */
export const CAPTIONS_KEPT = { summaries: 10_000, texts: 2_000, textBytes: 32 * 2 ** 20 } as const;
// An embed's player asks on every page view of the site it sits on whether its version has captions, and for them when
// they are turned on. A long transcript is megabytes to read and parse, so both are kept per render (`wsKey`: each
// workspace its own entries), each checked against the file — inode, size and time: every write is an atomic rename,
// `vr` in another process too — and dropped with the transcript. Bounded: visitors reach these. What is asked for stays
// (a hit counts as a use), and a full memory makes room in the workspace holding the most (`Memo`), so one workspace's
// many long videos can't push the other workspaces' captions out.
const summaries = new Memo<{ stamp: string; has: boolean; lang: string | null }>(CAPTIONS_KEPT.summaries, { groupOf: workspaceOfKey });
const texts = new Memo<{ stamp: string; vtt: string | null }>(CAPTIONS_KEPT.texts, {
  maxBytes: CAPTIONS_KEPT.textBytes,
  // as UTF-16, what a string may take in memory
  weigh: (kept) => 2 * (kept.vtt?.length ?? 0),
  groupOf: workspaceOfKey,
});
/** The two, for the server's list of what it keeps in memory (server/routes/shares/access.ts keptInMemory). */
export const captionsMemory = { captionSummaries: summaries, captionTexts: texts };

function stampOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

function forgetCaptions(rk: string): void {
  summaries.delete(wsKey(rk));
  texts.delete(wsKey(rk));
}

/** A version's captions as an embed offers them: null when it wasn't heard or nothing is said; their language when it is a code. */
export function captionsOf(ver: Pick<Version, 'hash' | 'sample'>): { lang: string | null } | null {
  const rk = renderKey(ver);
  const stamp = stampOf(transcriptFile(rk));
  let kept = summaries.get(wsKey(rk));
  if (kept?.stamp !== stamp) {
    const t = stamp === 'none' ? null : cachedTranscript(ver);
    const has = !!t?.lines.length;
    kept = { stamp, has, lang: has && t && /^[a-z]{2,3}$/.test(t.language) ? t.language : null };
    summaries.set(wsKey(rk), kept);
  }
  return kept.has ? { lang: kept.lang } : null;
}

/** A version's captions as WebVTT (its transcript's lines; never its engine or hash), or null when it has none. */
export function captionsVtt(ver: Pick<Version, 'hash' | 'sample'>): string | null {
  const rk = renderKey(ver);
  const stamp = stampOf(transcriptFile(rk));
  let kept = texts.get(wsKey(rk));
  if (kept?.stamp !== stamp) {
    const t = stamp === 'none' ? null : cachedTranscript(ver);
    kept = { stamp, vtt: t?.lines.length ? toVtt(t) : null };
    texts.set(wsKey(rk), kept);
  }
  return kept.vtt;
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
      forgetCaptions(rk);
      return t;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
