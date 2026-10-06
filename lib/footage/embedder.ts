// The image/text model as a process of its own (lib/footage/worker.ts): started on first use (the model downloads
// then, once), shared by every workspace of this process, stopped after a while without work to give its ~0.5–1 GB
// back. A crash fails the requests in flight and the next call starts a new worker; three crashes in ten minutes park
// it for five. VR_FOOTAGE_MODEL=fake swaps in the stand-in tests use (lib/footage/fake.ts).
import { type ChildProcess, fork } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FAKE_SIZE } from './fake.ts';
import { downloadProgress, ensureModel, footageModelsDir, modelDir, modelReady, SIGLIP } from './models.ts';
import type { EmbedderKind, EmbedIn, EmbedOut } from './protocol.ts';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const CRASH_WINDOW_MS = 10 * 60_000;
const PARK_MS = 5 * 60_000;
/** A request's longest wait (the first one loads a side of the model: seconds on a busy machine). */
const REQUEST_MS = 5 * 60_000;

export interface Embedder {
  readonly kind: EmbedderKind;
  /**
   * What the vectors are tagged with: the model, how frames are fitted to it, and the CPU family — ONNX Runtime's int8
   * kernels differ between ARM and x86 (cosine 0.98–0.99), so an index searches only vectors made where it runs.
   */
  readonly key: string;
  /** Side of the square picture the model takes, px. */
  readonly size: number;
  /** Whether the model's files are here (no download needed before the first use). */
  ready(): boolean;
  /** Downloads the model if it isn't here yet (shared with any running download). */
  prepare(): Promise<void>;
  /** 0–1 while the model downloads, else null. */
  progress(): number | null;
  images(pictures: Uint8Array[]): Promise<Float32Array[]>;
  texts(texts: string[]): Promise<Float32Array[]>;
  stop(): void;
}

export interface EmbedderOptions {
  kind?: EmbedderKind;
  threads?: number;
  idleMs?: number;
  log?: (msg: string) => void;
  /** Tests: another worker script. */
  workerPath?: string;
  fetchImpl?: typeof fetch;
}

interface Pending {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The vector tag for this machine: `siglip-b16-int8-pad@darwin-arm64`. */
export const vectorKey = (kind: EmbedderKind): string => (kind === 'fake' ? 'fake' : `${SIGLIP.id}-pad@${process.platform}-${process.arch}`);

const defaultThreads = (): number => Number(process.env.VR_FOOTAGE_THREADS) || Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));

export function createEmbedder(o: EmbedderOptions = {}): Embedder {
  const kind: EmbedderKind = o.kind ?? (process.env.VR_FOOTAGE_MODEL === 'fake' ? 'fake' : 'siglip');
  // stderr: `vr footage find --json` keeps its stdout for the answer even while the model downloads
  const log = o.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const idleMs = o.idleMs ?? (Number(process.env.VR_FOOTAGE_IDLE_MINUTES) || 10) * 60_000;
  let child: ChildProcess | null = null;
  const pending = new Map<number, Pending>();
  let seq = 0;
  let idle: NodeJS.Timeout | null = null;
  let crashes: number[] = [];
  let parkedUntil = 0;
  let parkedWhy = '';
  let stderr = '';

  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      if (!pending.size) stopWorker();
    }, idleMs);
    idle.unref();
  };

  function stopWorker() {
    if (idle) clearTimeout(idle);
    idle = null;
    const c = child;
    child = null;
    if (c?.connected) c.send({ type: 'exit' } satisfies EmbedIn);
  }

  function start(): ChildProcess {
    stderr = '';
    const c = fork(o.workerPath || WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    c.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    (c.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    c.on('message', (m: EmbedOut) => {
      if (m.type === 'hello' || m.id === undefined) return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.type === 'vectors') p.resolve(m.vectors);
      else p.reject(new Error(m.error));
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      const why = new Error(`the footage model stopped (${signal || `exit ${code}`})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(why);
        pending.delete(id);
      }
      if (code === 0) return;
      const now = Date.now();
      crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (crashes.length >= 3) {
        parkedUntil = now + PARK_MS;
        parkedWhy = why.message;
        crashes = [];
        log('footage model crashed 3 times in 10 minutes; pausing it for 5 minutes');
      }
    });
    c.send({ type: 'load', kind, dir: modelDir(SIGLIP), threads: o.threads ?? defaultThreads() } satisfies EmbedIn);
    return c;
  }

  async function call(msg: { type: 'images'; pictures: Uint8Array[] } | { type: 'texts'; texts: string[] }): Promise<Float32Array[]> {
    if (Date.now() < parkedUntil) throw new Error(`the footage model is paused after repeated crashes: ${parkedWhy}`);
    if (kind === 'siglip' && !modelReady(SIGLIP)) await ensureModel(SIGLIP, { log, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    child ??= start();
    const c = child;
    const id = ++seq;
    // An idle worker never keeps this process alive (`vr` ends when its command does; the worker follows on disconnect).
    c.ref();
    c.channel?.ref();
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the footage model did not answer in ${REQUEST_MS / 1000} s`));
        if (child === c) child = null;
        c.kill('SIGKILL');
      }, REQUEST_MS);
      pending.set(id, { resolve, reject, timer });
      c.send({ ...msg, id } satisfies EmbedIn);
    }).finally(() => {
      if (!pending.size) {
        c.unref();
        c.channel?.unref();
      }
      touch();
    });
  }

  return {
    kind,
    key: vectorKey(kind),
    size: kind === 'fake' ? FAKE_SIZE : SIGLIP.size,
    ready: () => kind === 'fake' || modelReady(SIGLIP),
    async prepare() {
      if (kind === 'siglip' && !modelReady(SIGLIP)) await ensureModel(SIGLIP, { log, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    },
    progress: () => (kind === 'fake' ? null : downloadProgress(SIGLIP, footageModelsDir())),
    images: (pictures) => (pictures.length ? call({ type: 'images', pictures }) : Promise.resolve([])),
    texts: (texts) => (texts.length ? call({ type: 'texts', texts }) : Promise.resolve([])),
    stop: stopWorker,
  };
}

let shared: Embedder | null = null;
/** The process's one embedder (the model is no workspace's: every workspace's index uses it). */
export function embedder(): Embedder {
  shared ??= createEmbedder();
  return shared;
}
/** Tests: forget the shared one (its worker is stopped). */
export function resetEmbedder(next: Embedder | null = null): void {
  shared?.stop();
  shared = next;
}
