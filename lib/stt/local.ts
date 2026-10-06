// The local speech engine: a forked worker (lib/stt/worker.ts) that keeps one transcribe.cpp model warm. Started at
// server start when the model is already on disk, otherwise on the first voice note (which may download it). The
// worker exits after an idle period to give its 1–3 GB back, is restarted after a crash, and a crash loop parks the
// engine for a while instead of respawning forever.
import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type DeviceInfo, downloadProgress, ensureModel, type ModelPreset, modelFile, pickModel } from './models.ts';
import type { Attempt, SttResult } from './policy.ts';
import type { WorkerIn, WorkerOut } from './protocol.ts';

export interface LocalEngineOptions {
  /** auto | a preset id | path to a .gguf file */
  model: string;
  modelsDir: string;
  threads: number;
  idleMs: number;
  log?: (msg: string) => void;
  /** Tests swap in a fake worker. */
  workerPath?: string;
  fetchImpl?: typeof fetch;
}

export type EngineState = 'idle' | 'starting' | 'downloading' | 'loading' | 'ready' | 'error';

export interface EngineInfo {
  model: string;
  family: ModelPreset['family'] | 'unknown';
  device: string | null;
}

/** Returns true when it took the message. */
type Waiter = (m: WorkerOut) => boolean;

interface Pending {
  resolve: (r: SttResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const CRASH_WINDOW_MS = 10 * 60_000;
const PARK_MS = 5 * 60_000;

export class MissingModelError extends Error {}

export class LocalEngine {
  state: EngineState = 'idle';
  error: string | null = null;
  info: EngineInfo | null = null;
  #downloading: ModelPreset | null = null;
  /** 0–1 while the model downloads, null otherwise. */
  get progress(): number | null {
    return this.state === 'downloading' && this.#downloading ? downloadProgress(this.#opts.modelsDir, this.#downloading) : null;
  }
  #opts: LocalEngineOptions;
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #pending = new Map<number, Pending>();
  #waiters: Waiter[] = [];
  #seq = 0;
  #idle: NodeJS.Timeout | null = null;
  #crashes: number[] = [];
  #parkedUntil = 0;
  #stderr = '';

  constructor(opts: LocalEngineOptions) {
    this.#opts = opts;
  }

  #log(msg: string) {
    (this.#opts.log || console.log)(msg);
  }

  /** Worker up and model loaded. `download`: fetch a missing model (else MissingModelError). */
  ensure({ download }: { download: boolean }): Promise<void> {
    if (Date.now() < this.#parkedUntil) return Promise.reject(new Error(`speech engine paused after repeated crashes: ${this.error}`));
    if (!this.#ready) {
      // An engine coming up is not idle: a timer armed by the previous call must not stop it halfway.
      if (this.#idle) clearTimeout(this.#idle);
      this.#idle = null;
      this.#ready = this.#boot(download).catch((e: Error) => {
        this.#ready = null;
        if (!(e instanceof MissingModelError)) {
          this.state = 'error';
          this.error = e.message;
        } else this.state = 'idle';
        this.#kill();
        throw e;
      });
    }
    return this.#ready;
  }

  async #boot(download: boolean): Promise<void> {
    this.state = 'starting';
    this.error = null;
    this.#stderr = '';
    const child = fork(this.#opts.workerPath || WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    this.#child = child;
    child.stderr?.on('data', (d: Buffer) => {
      this.#stderr = (this.#stderr + d.toString()).slice(-2000);
    });
    child.on('message', (m: WorkerOut) => this.#onMessage(m));
    child.on('exit', (code, signal) => this.#onExit(child, code, signal));

    // First start on a machine compiles the Metal kernels (~20 s on an M1 Max); macOS caches them for every later one.
    const hello = await this.#next('hello', 120_000);
    const devices: DeviceInfo[] = hello.type === 'hello' ? hello.devices : [];
    const pick = pickModel(this.#opts.model, devices);
    let file: string;
    if ('path' in pick) {
      if (!fs.existsSync(pick.path)) throw new Error(`speech model not found: ${pick.path}`);
      file = pick.path;
      this.info = { model: pick.path, family: pick.family, device: null };
    } else {
      file = modelFile(this.#opts.modelsDir, pick);
      this.info = { model: pick.id, family: pick.family, device: null };
      if (!fs.existsSync(file) || fs.statSync(file).size !== pick.bytes) {
        if (!download) throw new MissingModelError(`speech model ${pick.id} is not downloaded yet`);
        this.state = 'downloading';
        this.#downloading = pick;
        file = await ensureModel(this.#opts.modelsDir, pick, (m) => this.#log(m), this.#opts.fetchImpl);
      }
    }
    this.#downloading = null;
    this.state = 'loading';
    this.#send({ type: 'load', path: file, threads: this.#opts.threads });
    // The very first load on a machine compiles GPU kernels and reads the file cold (~30 s measured).
    const loaded = await this.#next('loaded', 180_000);
    if (loaded.type === 'loaded') {
      this.info = { ...this.info, device: loaded.device };
      this.#log(`speech: ${this.info.model} on ${loaded.device} (loaded in ${(loaded.ms / 1000).toFixed(1)} s)`);
    }
    this.state = 'ready';
    this.#touch();
  }

  /** One engine call (the policy in policy.ts decides how many). */
  async run(pcm: Float32Array, attempt: Attempt, timeoutMs: number): Promise<SttResult> {
    await this.ensure({ download: true });
    const id = ++this.#seq;
    return new Promise<SttResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`speech engine timed out after ${Math.round(timeoutMs / 1000)} s`));
        this.#kill();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({
        type: 'run',
        id,
        pcm,
        ...(attempt.language ? { language: attempt.language } : {}),
        ...(attempt.prompt ? { prompt: attempt.prompt } : {}),
        ...(attempt.timed ? { timed: true } : {}),
        ...(attempt.lateStart ? { lateStart: true } : {}),
      });
    }).finally(() => this.#touch());
  }

  stop(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    if (this.#child?.connected) this.#send({ type: 'exit' });
    this.#child = null;
    this.#ready = null;
    this.#failWaiters('speech engine stopped');
    if (this.state === 'ready') this.state = 'idle';
  }

  // A worker that is let go of never answers: whoever waits for its hello or loaded fails now, not at the timeout.
  #failWaiters(error: string) {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const w of waiting) w({ type: 'failed', error });
  }

  #send(m: WorkerIn) {
    this.#child?.send(m);
  }

  #next(type: 'hello' | 'loaded', timeoutMs: number): Promise<WorkerOut> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`speech worker did not answer (${type})`));
      }, timeoutMs);
      const waiter: Waiter = (m) => {
        if (m.type !== type && !(m.type === 'failed' && m.id === undefined)) return false;
        clearTimeout(timer);
        if (m.type === 'failed') reject(new Error(m.error));
        else resolve(m);
        return true;
      };
      this.#waiters.push(waiter);
    });
  }

  #onMessage(m: WorkerOut) {
    if ((m.type === 'result' || m.type === 'failed') && m.id !== undefined) {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.type === 'result') p.resolve({ text: m.text, language: m.language, ...(m.words ? { words: m.words, segments: m.segments } : {}) });
      else p.reject(new Error(m.error));
      return;
    }
    this.#waiters = this.#waiters.filter((w) => !w(m));
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    // stop()/kill() let go of a worker before it exits; by then its requests are settled and a new worker may already
    // be serving others.
    if (this.#child !== child) return;
    this.#child = null;
    this.#ready = null;
    const why = new Error(`speech engine stopped (${signal || `exit ${code}`})${this.#stderr ? `: ${this.#stderr.trim().split('\n').pop()}` : ''}`);
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(why);
      this.#pending.delete(id);
    }
    for (const w of this.#waiters) w({ type: 'failed', error: why.message });
    this.#waiters = [];
    if (code === 0) return;
    this.state = 'error';
    this.error = why.message;
    this.#log(why.message);
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.#crashes.length >= 3) {
      this.#parkedUntil = now + PARK_MS;
      this.#crashes = [];
      this.#log('speech engine crashed 3 times in 10 minutes; pausing it for 5 minutes');
    }
  }

  #kill() {
    const c = this.#child;
    this.#child = null;
    this.#ready = null;
    this.#failWaiters('speech engine stopped');
    if (this.state === 'ready') this.state = 'idle';
    c?.kill('SIGKILL');
  }

  #touch() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (this.state === 'ready' && !this.#pending.size) this.stop();
    }, this.#opts.idleMs);
    this.#idle.unref();
  }
}
