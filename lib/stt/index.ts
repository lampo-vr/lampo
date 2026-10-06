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

/** Mono 16 kHz float PCM, the format every engine takes. */
export async function decodePcm(file: string): Promise<Float32Array> {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], {
    maxBuffer: 16000 * 4 * 60 * 30,
  });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length - (stdout.length % 4)));
}

// A first voice note may have to wait for the model download; it gets this long before it is saved without a
// transcript (the download carries on for the next one).
const FIRST_USE_WAIT_MS = 20_000;

/** Transcript of an audio file; '' for silence; null when no engine is available or it failed (logged). */
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

async function heardTimed(file: string, s: SttSettings, log: (m: string) => void, opts: { repair?: boolean }): Promise<TimedTranscript> {
  const pcm = await decodePcm(file);
  const seconds = pcm.length / 16000;
  if (isSilent(pcm))
    return { text: '', language: '', words: [], segments: [], engine: s.backend === 'http' ? `http:${s.http?.model || 'whisper-1'}` : `local:${s.model}` };
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
