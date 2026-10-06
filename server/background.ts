// Work the server does on its own when a render arrives: poster, loudness/freeze analysis, the diff against the
// previous version, the comparison with fix previews notes were verified on, and the automatic pre-review. All heavy
// work goes through the one-at-a-time job queue. Renders in remote storage are fetched as local working copies first
// (ffmpeg needs files).

import type { Config } from '../lib/config.ts';
import { cachedCuts, shotCuts } from '../lib/cuts.ts';
import { cachedDiff, computeDiff } from '../lib/diff.ts';
import { createIndexer, type Indexer } from '../lib/footage/indexer.ts';
import { heavy, jobCrashed, needJobRoom, PRIORITY, QueueFullError, unlessBusy } from '../lib/jobs.ts';
import { analysis, cachedAnalysis, cachedPoster, cachedSprite, poster, sprite } from '../lib/media.ts';
import { confirmParts, partsToConfirm } from '../lib/parts.ts';
import { projectDirOf, slugify } from '../lib/paths.ts';
import { confirmPreviews, previewsToCheck } from '../lib/previews.ts';
import { cachedQa, runQa } from '../lib/qa.ts';
import { renderKey } from '../lib/renderKey.ts';
import { wsKey } from '../lib/scope.ts';
import * as store from '../lib/store.ts';
import { sttAvailable } from '../lib/stt/index.ts';
import { cachedTranscript, forgetTranscript, makeTranscript } from '../lib/transcripts.ts';
import type { DiffResult, QaResult, Review, TranscriptAnswer, Version } from '../lib/types.ts';
import type { Broadcast } from './events.ts';
import type { Playback } from './playback.ts';

/** A cached result, or a note that it is being computed / cannot be (`failed`: it ran and couldn't be made). */
export type Started<K extends string, T> =
  | ({ [key in K]: T } & { pending?: undefined; none?: undefined })
  | { pending: true }
  | { none: true; error?: string; failed?: true };

/** What a pre-review that couldn't read its render says, to `vr qa` and the API (the player has its own words): never
 * ffmpeg's output, which goes to the server's log. */
export const QA_FAILED = 'the pre-review could not read this version; `vr qa --rerun` tries it again';

export interface Background {
  /** Everything the latest version needs before someone opens it. */
  warm(review: Review): void;
  /** `languages`: the account's (prefs.voice_languages) when someone asked; the on-screen text is read in the
   * transcript's language, these and the server's speech languages first (lib/text/language.ts). A check that failed
   * answers `failed` until `again` (Run again) tries it once more. */
  startQa(review: Review, v: number, languages?: string[], again?: boolean): Started<'qa', QaResult>;
  startDiff(review: Review, v: number): Started<'diff', DiffResult>;
  /** Any two versions compared, waiting for the result (queued like every heavy job): carrying an approval over. */
  compare(review: Review, oldV: number, newV: number): Promise<DiffResult>;
  /** Loudness + freezes for one version in the background; true when it had to start. */
  startAnalysis(review: Review, v: number): boolean;
  /** The newest render's hover-scrub sprite (a file path), made on first request as the least urgent job of all. */
  startSprite(review: Review): Started<'sprite', string>;
  /** Compares a newer render with the fix previews notes were verified on; true when it had to start. */
  checkPreviews(review: Review): boolean;
  /** Compares the newest full render with the partial renders people approved before it; true when it had to start. */
  checkParts(review: Review): boolean;
  /** Where version v's shots begin (lib/cuts.ts): what a partial render snaps to. Found once per render. */
  startCuts(review: Review, v: number): Started<'cuts', number[]>;
  /** What is said in version v: the transcript, or that it is being heard / can't be. `language`: the render's, when
   * someone picked it (else detected); `again`: forget what was heard (or that it failed) and hear it again. */
  startTranscript(review: Review, v: number, language?: string, again?: boolean): TranscriptAnswer;
  /** Footage search's index (lib/footage/): the newest version of every video, read in the background when it is on. */
  footage: Indexer;
}

export interface BackgroundOptions {
  /** Read files next to a render (caption files for the typo check): local mode only. */
  projectFiles?: boolean;
  /** The speech settings now (Settings can change them while the server runs). */
  stt?: () => Config['stt'];
  /** Footage search's indexer (tests: one with a stand-in model); default: the process's own. */
  footage?: Indexer;
}

/**
 * What a job is to the crash guard (lib/crashGuard.ts): its kind and the renders it reads, per workspace. A job that
 * took the server down twice isn't started again — on a start's warm-up or anywhere else.
 */
const jobKey = (kind: string, ...vers: Version[]): string => wsKey(`${kind}:${vers.map((v) => renderKey(v)).join('_')}`);

/** A video removed while its job waited or ran (the sample removed during its warm-up): nothing to say about it. */
const removed = (review: Review): boolean => !store.loadReview(slugify(review.video));

async function bytes(review: Review, v: number): Promise<string> {
  const file = await store.ensureVersionFile(review, v);
  if (!file) throw new Error(`the bytes of v${v} are gone`);
  return file;
}

/**
 * The videos waiting on a job keyed by a render's bytes (its hash): two videos can hold the same render (a copy tracked
 * twice, the same export uploaded to two folders), and the one that asked second joins the job the first started. Each
 * of them must hear its progress and its end — a player waits for that event, not for a timer.
 */
export function sharedJobs() {
  // Per workspace (wsKey): another team's video with the same bytes never joins this job nor hears of it.
  const running = new Map<string, Map<string, { slug: string; v: number }>>();
  return {
    /** Adds (slug, v) to the job of `hash`; true when it has to start (nobody was waiting on it yet). */
    join(hash: string, slug: string, v: number): boolean {
      const waiting = running.get(wsKey(hash));
      const who = { slug, v };
      if (waiting) {
        waiting.set(`${slug}\0${v}`, who);
        return false;
      }
      running.set(wsKey(hash), new Map([[`${slug}\0${v}`, who]]));
      return true;
    },
    /** Everyone waiting on the job of `hash`, now. */
    waiting(hash: string): { slug: string; v: number }[] {
      return [...(running.get(wsKey(hash))?.values() ?? [])];
    },
    done(hash: string): void {
      running.delete(wsKey(hash));
    },
    /** Whether the job of `hash` is under way. */
    busy(hash: string): boolean {
      return running.has(wsKey(hash));
    },
  };
}

export function createBackground(broadcast: Broadcast, playback: Playback, { projectFiles = true, stt, footage }: BackgroundOptions = {}): Background {
  const qaJobs = sharedJobs();
  // A video's footage index changed (indexed, or failed): its card and an open footage search may want to know.
  const footageIndexer = footage ?? createIndexer({ changed: (slug) => broadcast('footage', { slug }) });

  // One job per video version while it waits: a player asking again (and again) joins it instead of queueing another,
  // each taking a turn of its own.
  const analysisPending = new Set<string>();
  const diffPending = new Set<string>();

  function startAnalysis(review: Review, v: number): boolean {
    const ver = review.versions.find((x) => x.v === v);
    if (!ver || !store.versionAvailable(review, ver.v) || cachedAnalysis(ver)) return false;
    const slug = slugify(review.video);
    const key = wsKey(`${slug}\0${ver.v}`);
    if (analysisPending.has(key)) return true;
    needJobRoom();
    analysisPending.add(key);
    heavy(async () => analysis(await bytes(review, ver.v), ver), PRIORITY.analysis, { key: jobKey('analysis', ver) })
      .then(
        () => broadcast('analysis', { slug, v: ver.v }),
        () => {},
      )
      .finally(() => analysisPending.delete(key));
    return true;
  }

  // Diff of version v against v-1, computed once in the background (cached by both hashes).
  function startDiff(review: Review, v: number): Started<'diff', DiffResult> {
    const nv = review.versions.find((x) => x.v === v);
    const ov = review.versions.find((x) => x.v === v - 1);
    if (!nv || !ov) return { none: true };
    const hit = cachedDiff(ov, nv);
    if (hit) return { diff: hit };
    if (!store.versionAvailable(review, nv.v) || !store.versionAvailable(review, ov.v)) return { none: true, error: 'the bytes of one version are gone' };
    const job = jobKey('diff', ov, nv);
    if (jobCrashed(job)) return { none: true, error: 'comparing these versions stopped the server before, so it is not tried again' };
    const key = wsKey(`${slugify(review.video)}\0${v}`);
    if (diffPending.has(key)) return { pending: true };
    needJobRoom();
    diffPending.add(key);
    heavy(async () => computeDiff(await bytes(review, ov.v), ov, await bytes(review, nv.v), nv), PRIORITY.diff, { key: job })
      .then(
        () => broadcast('diff', { slug: slugify(review.video), v }),
        (e: Error) => removed(review) || console.error('diff', e.message),
      )
      .finally(() => diffPending.delete(key));
    return { pending: true };
  }

  async function compare(review: Review, oldV: number, newV: number): Promise<DiffResult> {
    const ov = review.versions.find((x) => x.v === oldV);
    const nv = review.versions.find((x) => x.v === newV);
    if (!ov || !nv) throw new Error(`no v${ov ? newV : oldV}`);
    return (
      cachedDiff(ov, nv) ??
      heavy(async () => computeDiff(await bytes(review, ov.v), ov, await bytes(review, nv.v), nv), PRIORITY.diff, { key: jobKey('diff', ov, nv) })
    );
  }

  // A check that failed on a render (ffmpeg couldn't read it) isn't started again by itself: every look at the player,
  // its poll and `vr qa`'s poll each started it again, and the player said "Checking…" for good. Until the next start
  // or Run again; a full queue is no failure.
  const qaFailed = new Set<string>();

  // Automatic pre-review of a version (OCR typos, safe zones, flash/black frames, loudness, clipping, freezes).
  function startQa(review: Review, v: number, languages: string[] = [], again = false): Started<'qa', QaResult> {
    const ver = review.versions.find((x) => x.v === v);
    if (!ver) return { none: true };
    const hit = cachedQa(ver);
    if (hit) return { qa: hit };
    const slug = slugify(review.video);
    if (!store.versionAvailable(review, ver.v)) return { none: true, error: 'the bytes of this version are gone' };
    // Another video with the same render may be checking it already: this one waits for the same result.
    const key = renderKey(ver);
    if (again && !qaJobs.busy(key)) qaFailed.delete(wsKey(key));
    if (qaFailed.has(wsKey(key))) return { none: true, failed: true, error: QA_FAILED };
    if (!qaJobs.busy(key)) needJobRoom();
    if (qaJobs.join(key, slug, v)) {
      const hash = key;
      const onProgress = (p: object) => {
        for (const w of qaJobs.waiting(hash)) broadcast('qa-progress', { ...w, ...p });
      };
      const projectDir = projectFiles && !store.isUpload(review) ? projectDirOf(review.video) : undefined;
      // the render's own language (when it has been heard), then the account's, then the server's
      const expected = [cachedTranscript(ver)?.language, ...languages, ...(stt?.().languages ?? [])];
      heavy(async () => runQa(await bytes(review, ver.v), ver, review.meta || {}, { projectDir, onProgress, languages: expected }), PRIORITY.qa, {
        key: jobKey('qa', ver),
      })
        .then(
          () => {
            for (const w of qaJobs.waiting(hash)) broadcast('qa', w);
          },
          (e: Error) => {
            if (e instanceof QueueFullError) return;
            qaFailed.add(wsKey(hash));
            if (!removed(review)) console.error('qa', e.message);
            // the players waiting on it ask again and hear that it failed
            for (const w of qaJobs.waiting(hash)) broadcast('qa', w);
          },
        )
        .finally(() => qaJobs.done(hash));
    }
    return { pending: true };
  }

  // Asked for by the cards the first time someone hovers or looks at them, never made ahead (most renders are
  // never scrubbed from the library). A render that can't be tiled isn't retried until the next start.
  const spriteJobs = sharedJobs();
  const spriteFailed = new Set<string>();
  function startSprite(review: Review): Started<'sprite', string> {
    const ver = review.versions.at(-1);
    if (!ver) return { none: true };
    const key = renderKey(ver);
    const hit = cachedSprite(key);
    if (hit) return { sprite: hit };
    if (spriteFailed.has(wsKey(key))) return { none: true, error: 'no sprite for this render' };
    if (!store.versionAvailable(review, ver.v)) return { none: true, error: 'the bytes of this version are gone' };
    if (!spriteJobs.busy(key)) needJobRoom();
    if (spriteJobs.join(key, slugify(review.video), ver.v)) {
      const hash = key;
      heavy(async () => sprite(await bytes(review, ver.v), ver, review.meta), PRIORITY.sprite, { key: jobKey('sprite', ver) })
        .then(
          () => {
            for (const w of spriteJobs.waiting(hash)) broadcast('sprite', w);
          },
          (e: Error) => {
            if (e instanceof QueueFullError) return;
            spriteFailed.add(wsKey(hash));
            if (!removed(review)) console.error('sprite', e.message);
          },
        )
        .finally(() => spriteJobs.done(hash));
    }
    return { pending: true };
  }

  // Once per render: a match confirms the fix, a mismatch sends the note back to "check fixes" (lib/previews.ts).
  const previewsRunning = new Set<string>();
  function checkPreviews(review: Review): boolean {
    const ver = review.versions.at(-1);
    const slug = slugify(review.video);
    if (!ver || !previewsToCheck(review).length || !store.versionAvailable(review, ver.v) || previewsRunning.has(wsKey(slug))) return false;
    previewsRunning.add(wsKey(slug));
    heavy(() => confirmPreviews(slug), PRIORITY.preview, { mustRun: true, key: `${jobKey('previews', ver)}:${slug}` })
      .then(
        (settled) => {
          if (settled) broadcast('review', { slug });
        },
        (e: Error) => removed(review) || console.error('previews', e.message),
      )
      .finally(() => previewsRunning.delete(wsKey(slug)));
    return true;
  }

  // A full render after partial ones: the parts people approved are compared with its same frames (lib/parts.ts).
  const partsRunning = new Set<string>();
  function checkParts(review: Review): boolean {
    const ver = review.versions.at(-1);
    const slug = slugify(review.video);
    if (!ver || ver.part || partsRunning.has(wsKey(slug)) || !partsToConfirm(review).length || !store.versionAvailable(review, ver.v)) return false;
    partsRunning.add(wsKey(slug));
    heavy(() => confirmParts(slug), PRIORITY.preview, { mustRun: true, key: `${jobKey('parts', ver)}:${slug}` })
      .then(
        (settled) => {
          if (settled) {
            broadcast('review', { slug });
            broadcast('library', { slug });
          }
        },
        (e: Error) => removed(review) || console.error('parts', e.message),
      )
      .finally(() => partsRunning.delete(wsKey(slug)));
    return true;
  }

  // Shot boundaries, asked for when someone wants a partial render (the composer's where-menu, a request): they wait
  // for it, so it goes right after the scrub copies.
  const cutJobs = sharedJobs();
  const cutsFailed = new Set<string>();
  function startCuts(review: Review, v: number): Started<'cuts', number[]> {
    const ver = review.versions.find((x) => x.v === v);
    if (!ver) return { none: true, error: `no v${v}` };
    const hit = cachedCuts(ver);
    if (hit) return { cuts: hit };
    const key = renderKey(ver);
    if (cutsFailed.has(wsKey(key))) return { none: true, error: 'the shots of this version could not be found' };
    if (!store.versionAvailable(review, ver.v)) return { none: true, error: 'the bytes of this version are gone' };
    if (!cutJobs.busy(key)) needJobRoom();
    if (cutJobs.join(key, slugify(review.video), v)) {
      heavy(() => shotCuts(() => bytes(review, ver.v), ver), PRIORITY.recording, { key: jobKey('cuts', ver) })
        .then(
          () => {
            for (const w of cutJobs.waiting(key)) broadcast('review', { slug: w.slug });
          },
          (e: Error) => {
            if (e instanceof QueueFullError) return;
            cutsFailed.add(wsKey(key));
            if (!removed(review)) console.error('cuts', e.message);
          },
        )
        .finally(() => cutJobs.done(key));
    }
    return { pending: true };
  }

  // What is said in a render, heard once per its bytes (lib/transcripts.ts); asked for by the player's Transcript tab,
  // an agent (get_transcript, vr transcript), or a new version whose predecessor has one (so what changed is ready).
  const transcriptJobs = sharedJobs();
  const transcriptFailed = new Map<string, string>();
  function startTranscript(review: Review, v: number, language?: string, again = false): TranscriptAnswer {
    const ver = review.versions.find((x) => x.v === v);
    if (!ver) return { state: 'off', v, error: `no v${v}` };
    // a run under way finishes and is kept; asked again after it, the new one replaces it
    const key = renderKey(ver);
    if (again && !transcriptJobs.busy(key)) {
      forgetTranscript(ver);
      transcriptFailed.delete(wsKey(key));
    }
    const hit = cachedTranscript(ver);
    if (hit) return { state: 'ready', v, transcript: hit };
    const settings = stt?.();
    if (!settings || !sttAvailable(settings)) return { state: 'off', v, error: 'speech is off on this server' };
    const failed = transcriptFailed.get(wsKey(key));
    if (failed) return { state: 'failed', v, error: failed };
    if (!store.versionAvailable(review, ver.v)) return { state: 'off', v, error: 'the bytes of this version are gone' };
    if (!transcriptJobs.busy(key)) needJobRoom();
    if (transcriptJobs.join(key, slugify(review.video), v)) {
      const hash = key;
      heavy(async () => makeTranscript(await bytes(review, ver.v), ver, settings, undefined, language), PRIORITY.transcript, {
        key: jobKey('transcript', ver),
      })
        .then(
          () => {
            for (const w of transcriptJobs.waiting(hash)) broadcast('transcript', w);
          },
          (e: Error) => {
            if (e instanceof QueueFullError) return;
            transcriptFailed.set(wsKey(hash), e.message);
            if (!removed(review)) console.error('transcript', e.message);
            for (const w of transcriptJobs.waiting(hash)) broadcast('transcript', w);
          },
        )
        .finally(() => transcriptJobs.done(hash));
    }
    return { state: 'pending', v };
  }

  function warm(review: Review): void {
    const ver = review.versions.at(-1);
    if (!ver || !store.versionAvailable(review, ver.v)) return;
    const slug = slugify(review.video);
    playback.playable(review, ver);
    // Queued like all work that may download a render from remote storage: a restart fetches one at a time.
    if (!cachedPoster(ver))
      heavy(() => poster(() => bytes(review, ver.v), ver, review.meta), PRIORITY.poster, { key: jobKey('poster', ver) }).then(
        () => broadcast('poster', { slug }),
        () => {},
      );
    // Nobody waits on these now: a full queue skips them (said once in the log), and they are made when asked for.
    unlessBusy(() => startAnalysis(review, ver.v));
    if (review.versions.length > 1) unlessBusy(() => startDiff(review, ver.v));
    checkPreviews(review);
    checkParts(review);
    // someone read what the last render said: the new one is heard too, so what the voice-over changed is ready
    const prev = review.versions.at(-2);
    if (prev && cachedTranscript(prev) && !cachedTranscript(ver)) unlessBusy(() => startTranscript(review, ver.v));
    // footage search: the newest version's shots, text and pictures, after everything a review needs (PRIORITY.footage)
    footageIndexer.queue(review);
  }

  return { warm, startQa, startDiff, compare, startAnalysis, startSprite, checkPreviews, checkParts, startCuts, startTranscript, footage: footageIndexer };
}
