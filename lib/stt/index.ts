// Speech-to-text for voice notes: audio file → text. Local by default (transcribe.cpp in a worker process, nothing
// leaves the machine), or any OpenAI-compatible server. Engine choice and the rules in policy.ts come from
// bench/stt/RESULTS.md; configuration: docs/speech.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.ts';
import { CACHE } from '../paths.ts';
import { FFMPEG, run } from '../probe.ts';
import { internal } from '../publicError.ts';
import type { TranscriptRepair } from '../types.ts';
import { type RepairDeps, repairCollapses } from './collapse.ts';
import { type Dropped, dropHallucinations, stripHallucinations } from './hallucinations.ts';
import { httpTranscribe } from './http.ts';
import { type EngineState, LocalEngine, MissingModelError } from './local.ts';
import { MODELS, type ModelPreset, modelFile } from './models.ts';
import { type Attempt, isSilent, type SttResult, transcribeWithPolicy, vocabularyPrompt } from './policy.ts';

type SttSettings = Config['stt'];

export interface SttStatus {
  backend: SttSettings['backend'];
  available: boolean;
  state: EngineState | 'off';
  model: string | null;
  device: string | null;
  error: string | null;
  /** 0–1 while the speech model downloads (first use), null otherwise. */
  progress: number | null;
}

let engine: LocalEngine | null = null;
let engineKey = '';

const threads = (s: SttSettings) => s.threads || Math.min(4, os.availableParallelism());
export const modelsDir = (s: SttSettings): string => s.models_dir || path.join(CACHE, 'models');

function localEngine(s: SttSettings, log: (m: string) => void): LocalEngine {
  const key = JSON.stringify([s.model, modelsDir(s), threads(s), s.idle_unload_minutes]);
  if (!engine || key !== engineKey) {
    engine?.stop();
    engine = new LocalEngine({ model: s.model, modelsDir: modelsDir(s), threads: threads(s), idleMs: s.idle_unload_minutes * 60_000, log });
    engineKey = key;
  }
  return engine;
}

let installed: boolean | undefined;
/** transcribe.cpp ships as an optional dependency with prebuilt natives; a platform without one has no local engine. */
function engineInstalled(): boolean {
  if (installed === undefined) {
    try {
      import.meta.resolve('transcribe-cpp');
      installed = true;
    } catch {
      installed = false;
    }
  }
  return installed;
}

export function sttAvailable(s: SttSettings): boolean {
  if (s.backend === 'off') return false;
  if (s.backend === 'http') return !!s.http?.url;
  return engineInstalled() && engine?.error?.startsWith('transcribe-cpp is not installed') !== true;
}

export function sttStatus(s: SttSettings): SttStatus {
  const available = sttAvailable(s);
  if (s.backend !== 'local')
    return { backend: s.backend, available, state: available ? 'ready' : 'off', model: s.http?.model || null, device: null, error: null, progress: null };
  return {
    backend: 'local',
    available,
    state: engine?.state || 'idle',
    model: engine?.info?.model || s.model,
    device: engine?.info?.device || null,
    error: engine?.error || null,
    progress: engine?.progress ?? null,
  };
}

/**
 * The engine's status as anyone may read it (`/api/info` is public): the model by its name, never the server's path to
 * it, and that the engine fails without what it said (its last error names files and hosts). The server's admins read
 * the whole status (server/routes/system.ts).
 */
export function publicSttStatus(s: SttStatus): SttStatus {
  return { ...s, model: s.model ? s.model.split(/[\\/]/).pop() || null : null, error: s.error ? 'the speech engine is not working' : null };
}

/** Warm the local engine at server start: loads a model that is already on disk (or downloads it with `prefetch`). */
export function preloadStt(s: SttSettings, log: (m: string) => void = console.log): void {
  if (s.backend !== 'local' || !engineInstalled()) return;
  localEngine(s, log)
    .ensure({ download: s.prefetch })
    .catch((e: Error) => {
      if (e instanceof MissingModelError) log(`speech: ${e.message}; it downloads with the first voice note (or set stt.prefetch)`);
      else log(`speech: ${e.message}`);
    });
}

// The second listener (lib/stt/collapse.ts): Parakeet, only when its model is already on disk — never downloaded for
// this. It is loaded only to check a suspect stretch of a render and lets its memory go a minute after its last one,
// so a second model never stays loaded next to the first.
const SECOND_IDLE_MS = 60_000;
let listener: LocalEngine | null = null;
let listenerKey = '';

/** The second listener's model, when it is on disk and not the engine's own. */
export function secondListenerModel(s: SttSettings): ModelPreset | null {
  const preset = MODELS['parakeet-v3'];
  if (s.model === preset.id) return null;
  try {
    return fs.statSync(modelFile(modelsDir(s), preset)).size === preset.bytes ? preset : null;
  } catch {
    return null;
  }
}

function secondListener(s: SttSettings, log: (m: string) => void): LocalEngine | null {
  const preset = secondListenerModel(s);
  if (!preset) return null;
  const key = JSON.stringify([modelsDir(s), threads(s)]);
  if (!listener || key !== listenerKey) {
    listener?.stop();
    listener = new LocalEngine({ model: preset.id, modelsDir: modelsDir(s), threads: threads(s), idleMs: SECOND_IDLE_MS, log });
    listenerKey = key;
  }
  return listener;
}

export function stopStt(): void {
  engine?.stop();
  listener?.stop();
}

const RATE = 16000;
/**
 * How much of a file's audio is decoded and heard at once: 30 minutes of 16 kHz float PCM is 115 MB, held while the
 * engine hears it. A longer file is heard window after window, never cut at the first.
 */
export const PCM_WINDOW_SECONDS = 1800;
/** The most windows one file is heard in (a day of audio): past that it is refused, never heard in part. */
export const PCM_WINDOWS_MAX = 48;

/**
 * Mono 16 kHz float PCM, the format every engine takes: `seconds` of the file from `from` on, and never more (what
 * follows is the next window's; run() fails rather than cut an answer short).
 */
export async function decodePcm(file: string, { from = 0, seconds = PCM_WINDOW_SECONDS }: { from?: number; seconds?: number } = {}): Promise<Float32Array> {
  const seek = from > 0 ? ['-ss', from.toFixed(3)] : [];
  const { stdout } = await run(
    FFMPEG,
    ['-v', 'error', ...seek, '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'],
    {
      // what -t lets through, and a frame of the resampler's slack
      maxBuffer: Math.ceil(seconds * RATE) * 4 + 64 * 1024,
    },
  );
  const samples = Math.min(Math.floor(stdout.length / 4), Math.round(seconds * RATE));
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + samples * 4));
}

/**
 * A file's audio window after window (where each starts, in seconds, and its samples) until it ends: one window in
 * memory at a time. Throws past PCM_WINDOWS_MAX windows.
 */
async function* pcmWindows(file: string): AsyncGenerator<{ from: number; pcm: Float32Array }> {
  for (let i = 0; ; i++) {
    const from = i * PCM_WINDOW_SECONDS;
    const pcm = await decodePcm(file, { from });
    if (pcm.length || i === 0) yield { from, pcm };
    // a window short of full (a second's slack for the resampler) was the last
    if (pcm.length < (PCM_WINDOW_SECONDS - 1) * RATE) return;
    if (i + 1 >= PCM_WINDOWS_MAX) throw new Error(`the audio runs longer than ${(PCM_WINDOWS_MAX * PCM_WINDOW_SECONDS) / 3600} hours: too long to hear`);
  }
}

// A first voice note may have to wait for the model download; it gets this long before it is saved without a
// transcript (the download carries on for the next one).
const FIRST_USE_WAIT_MS = 20_000;

/**
 * Transcript of an audio file (a voice note: its first window, PCM_WINDOW_SECONDS, is heard); '' for silence; null when
 * no engine is available or it failed (logged).
 */
export async function transcribeFile(file: string, s: SttSettings, log: (m: string) => void = console.error): Promise<string | null> {
  if (!sttAvailable(s)) return null;
  try {
    const pcm = await decodePcm(file);
    if (isSilent(pcm)) return '';
    const seconds = pcm.length / 16000;
    const opts = { languages: s.languages, seconds };
    if (s.backend === 'http' && s.http) {
      const http = s.http;
      return stripHallucinations((await transcribeWithPolicy((a) => httpTranscribe(pcm, a, http), { ...opts, prompt: vocabularyPrompt(s.vocabulary) })).text);
    }
    const eng = localEngine(s, log);
    const ready = eng.ensure({ download: true });
    const waited = await Promise.race([ready.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), FIRST_USE_WAIT_MS).unref())]);
    if (!waited) {
      log(`speech: model not ready yet (${eng.state}); this note is saved without a transcript`);
      ready.catch(() => {});
      return null;
    }
    const prompt = eng.info?.family === 'whisper' ? vocabularyPrompt(s.vocabulary) : null;
    const timeout = Math.max(30_000, seconds * 4000);
    const runOnce = (a: Attempt): Promise<SttResult> => eng.run(pcm, a, timeout);
    return stripHallucinations((await transcribeWithPolicy(runOnce, { ...opts, prompt })).text);
  } catch (e) {
    log(`speech: ${(e as Error).message}`);
    return null;
  }
}

/** A render's speech with timings (lib/transcripts.ts). */
export interface TimedTranscript {
  text: string;
  language: string;
  words: { text: string; t0: number; t1: number }[];
  segments: { text: string; t0: number; t1: number }[];
  /** Who heard it: "local:<model>" or "http:<model>". */
  engine: string;
  /** 'line' when a repair mixed engine-timed words with words spread over a line; absent = `words` are the engine's
   * own timings whenever there are any. */
  timing?: 'word' | 'line';
  /** Stretches the first pass lost and that were heard again (lib/stt/collapse.ts). */
  repairs?: TranscriptRepair[];
}

const joined = (list: { text: string }[]) =>
  list
    .map((x) => x.text.trim())
    .filter(Boolean)
    .join(' ');

/**
 * What is said in a video file, timed: words where the engine times them, segments otherwise. Silence (music only, no
 * voice) is an empty transcript, and lines Whisper invents over music ("Svensktextning.nu") never make it in. With
 * `repair` (a render's transcript) a stretch whose window collapsed is heard again (lib/stt/collapse.ts). Unlike a
 * voice note this waits for the model however long it takes to download, and throws when no engine is available or
 * it fails — the caller records why.
 */
export async function transcribeTimed(
  file: string,
  s: SttSettings,
  log: (m: string) => void = console.error,
  opts: { repair?: boolean } = {},
): Promise<TimedTranscript> {
  if (!sttAvailable(s)) throw new Error('speech is off on this server');
  try {
    return await heardTimed(file, s, log, opts);
  } catch (e) {
    // What an engine says when it fails (a speech server's traceback and hosts, a model's path, a worker's stderr) is
    // the server's business: only the machine's owner reads it as it is (lib/publicError.ts).
    throw internal(e);
  }
}

/** What was heard in a window, on the whole file's clock (`from`: where the window starts, in seconds). */
function shifted(t: TimedTranscript, from: number): TimedTranscript {
  if (!from) return t;
  const on = <T extends { t0: number; t1: number }>(x: T): T => ({ ...x, t0: x.t0 + from, t1: x.t1 + from });
  return { ...t, words: t.words.map(on), segments: t.segments.map(on), ...(t.repairs ? { repairs: t.repairs.map(on) } : {}) };
}

/**
 * The file heard window after window (pcmWindows), each on the file's clock, joined in order: a window that is silence
 * adds nothing, a failing one fails the whole (nothing heard in part is kept as if it were all). One window (every file
 * up to PCM_WINDOW_SECONDS) is heard exactly as it always was.
 */
async function heardTimed(file: string, s: SttSettings, log: (m: string) => void, opts: { repair?: boolean }): Promise<TimedTranscript> {
  const parts: TimedTranscript[] = [];
  for await (const { from, pcm } of pcmWindows(file)) {
    if (isSilent(pcm)) continue;
    parts.push(shifted(await heardWindow(pcm, s, log, opts), from));
  }
  const [first] = parts;
  if (!first)
    return { text: '', language: '', words: [], segments: [], engine: s.backend === 'http' ? `http:${s.http?.model || 'whisper-1'}` : `local:${s.model}` };
  if (parts.length === 1) return first;
  const repairs = parts.flatMap((p) => p.repairs ?? []);
  return {
    text: joined(parts),
    language: parts.find((p) => p.language)?.language ?? '',
    words: parts.flatMap((p) => p.words),
    segments: parts.flatMap((p) => p.segments),
    engine: first.engine,
    ...(parts.some((p) => p.timing === 'line') ? { timing: 'line' as const } : {}),
    ...(repairs.length ? { repairs } : {}),
  };
}

/** One window's audio heard, timed on its own clock (heardTimed puts it on the file's). */
async function heardWindow(pcm: Float32Array, s: SttSettings, log: (m: string) => void, opts: { repair?: boolean }): Promise<TimedTranscript> {
  const seconds = pcm.length / 16000;
  const policy = { languages: s.languages, seconds, timed: true };
  const heard = (r: SttResult, engine: string): TimedTranscript & { dropped: Dropped[] } => {
    const { segments, words, dropped } = dropHallucinations(r);
    return { text: dropped.length ? joined(words.length ? words : segments) : r.text, language: r.language, words, segments, engine, dropped };
  };
  if (s.backend === 'http' && s.http) {
    const http = s.http;
    const r = await transcribeWithPolicy((a) => httpTranscribe(pcm, a, http), { ...policy, prompt: vocabularyPrompt(s.vocabulary) });
    const { dropped: _, ...t } = heard(r, `http:${http.model || 'whisper-1'}`);
    return t;
  }
  const eng = localEngine(s, log);
  await eng.ensure({ download: true });
  const whisper = eng.info?.family === 'whisper';
  const prompt = whisper ? vocabularyPrompt(s.vocabulary) : null;
  const timeout = (secs: number) => Math.max(60_000, secs * 4000);
  const r = await transcribeWithPolicy((a) => eng.run(pcm, a, timeout(seconds)), { ...policy, prompt });
  const { dropped, ...first } = heard(r, `local:${eng.info?.model || s.model}`);
  // Whisper's windows are what collapses; other models hear the file as one.
  if (!opts.repair || !whisper) return first;

  // A cut is heard in the language the whole render was heard in: a few seconds are easily taken for another one.
  const language = r.language || s.languages[0];
  const second = secondListener(s, log);
  const deps: RepairDeps = {
    engine: first.engine,
    again: (cut) => eng.run(cut, { timed: true, lateStart: true, ...(language ? { language } : {}) }, timeout(cut.length / 16000)),
    log,
  };
  if (second) {
    deps.second = async (cut) => {
      await second.ensure({ download: false }); // never fetched for this; run() then finds it loaded
      return (await second.run(cut, { timed: true }, timeout(cut.length / 16000))).words ?? [];
    };
    deps.secondEngine = `local:${MODELS['parakeet-v3'].id}`;
  }
  const fixed = await repairCollapses(pcm, { ...first, dropped }, deps);
  if (!fixed.repairs.length) return first;
  return {
    ...first,
    text: joined(fixed.words.length ? fixed.words : fixed.segments),
    words: fixed.words,
    segments: fixed.segments,
    ...(fixed.timing ? { timing: fixed.timing } : {}),
    repairs: fixed.repairs,
  };
}
