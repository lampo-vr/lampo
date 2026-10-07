// Long renders: `lampo render --detach` hands the render to a small supervisor of its own (a `lampo` process in a session of
// its own, so it outlives the agent's shell: Claude Code ends a foreground Bash call after 10 minutes at most and `-p`
// kills background shells soon after its result) and returns at once; `lampo render wait <id>` blocks for at most 9
// minutes and says one line: still rendering, or how it ended. The supervisor runs the same job as the foreground
// (lib/render/job.ts) and keeps its state in the cache (`<LAMPO_CACHE>/renders/<id>/`, 0600), never in data/.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE, isoLocal } from '../paths.ts';
import type { RunProgress } from '../types.ts';
import { type RenderJob, took } from './job.ts';

export const RENDER_ID = /^r_[0-9a-f]{10}$/;
/** The longest `lampo render wait` blocks: under the 10 minutes a foreground Bash call of Claude Code may take. */
export const WAIT_MAX_MS = 9 * 60_000;
/** Finished renders' folders are kept this long (a late `wait` still answers), then cleared at the next detach. */
const KEEP_MS = 7 * 24 * 3600_000;

export interface RenderState {
  id: string;
  state: 'starting' | 'running' | 'done' | 'failed';
  /** The supervisor's pid; the tool's process group once it runs. */
  supervisor?: number;
  pid?: number;
  started: string;
  updated: string;
  /** "V4" when it becomes a version, else "". */
  label: string;
  progress?: RunProgress;
  /** The output's size, when that is all there is to say. */
  bytes?: number;
  elapsed_s?: number;
  /** How it ended: the exit code `lampo` passes on, and its lines for the model. */
  code?: number;
  lines?: string[];
}

/** A detached job: the render, and how often its progress may go to Lampo. */
export interface DetachedJob {
  id: string;
  job: RenderJob;
  every: number;
}

export const rendersDir = (): string => path.join(CACHE, 'renders');
const dirOf = (id: string) => path.join(rendersDir(), id);
export const newRenderId = (): string => `r_${crypto.randomBytes(5).toString('hex')}`;

/** Written whole or not at all, readable by its owner only. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readState(id: string): RenderState | null {
  if (!RENDER_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'state.json'), 'utf8')) as RenderState;
  } catch {
    return null;
  }
}

function writeState(s: RenderState): void {
  writeJson(path.join(dirOf(s.id), 'state.json'), { ...s, updated: isoLocal() });
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const ended = (s: RenderState) => s.state === 'done' || s.state === 'failed';

/** The supervisor's pid: as it wrote it, else as it was started. */
function supervisorOf(s: RenderState): number | undefined {
  if (s.supervisor) return s.supervisor;
  try {
    return Number(fs.readFileSync(path.join(dirOf(s.id), 'supervisor.pid'), 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}

/** Clears the folders of renders that ended (or whose supervisor is gone) more than a week ago; nothing else. */
function prune(now = Date.now()): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(rendersDir()).filter((n) => RENDER_ID.test(n));
  } catch {
    return;
  }
  for (const id of names) {
    const s = readState(id);
    const at = s ? Date.parse(s.updated) : Number.NaN;
    if (!s || !Number.isFinite(at) || now - at < KEEP_MS) continue;
    if (ended(s) || !alive(supervisorOf(s))) fs.rmSync(dirOf(id), { recursive: true, force: true });
  }
}

const SUPERVISOR = fileURLToPath(new URL('./supervisor.ts', import.meta.url));

/**
 * Starts the render under its supervisor and waits a moment for it to begin: the state it reached (running, or failed
 * already, e.g. a command that isn't there).
 */
export async function startDetached(d: DetachedJob, label: string): Promise<RenderState> {
  prune();
  const dir = dirOf(d.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, 'job.json'), d);
  const first: RenderState = { id: d.id, state: 'starting', started: isoLocal(), updated: isoLocal(), label };
  writeState(first);
  const log = fs.openSync(path.join(dir, 'supervisor.log'), 'a', 0o600);
  try {
    // a session of its own: the agent's shell ending (or its process group being stopped) doesn't end the render
    const child = spawn(process.execPath, [SUPERVISOR, dir], {
      cwd: d.job.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'ignore', log],
      windowsHide: true,
    });
    child.unref();
    // beside the state, never in it: the supervisor writes the state from its first moment
    if (child.pid) fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(child.pid), { mode: 0o600 });
  } finally {
    fs.closeSync(log);
  }
  for (let i = 0; i < 50; i++) {
    const s = readState(d.id);
    if (s && s.state !== 'starting') return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readState(d.id) ?? first;
}

/** The supervisor itself (lib/render/supervisor.ts runs it): the job from its folder, its state kept there. */
export async function supervise(dir: string): Promise<void> {
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) as DetachedJob;
  let state: RenderState = readState(d.id) ?? { id: d.id, state: 'starting', started: isoLocal(), updated: isoLocal(), label: '' };
  // 'running' once the tool runs: a command that can't start fails while `lampo render --detach` still waits, and says so
  state = { ...state, supervisor: process.pid };
  writeState(state);
  const { enterProcessWorkspace } = await import('../scope.ts');
  enterProcessWorkspace();
  const { openActivitySink } = await import('../activity.ts');
  const { openBackend } = await import('../backend/index.ts');
  const { executeRender } = await import('./job.ts');
  const sink = d.job.agent ? openActivitySink() : null;
  let stopped = false;
  let tool: { signal(sig: NodeJS.Signals): void } | null = null;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(sig, () => {
      stopped = true;
      tool?.signal(sig);
    });
  try {
    const outcome = await executeRender(d.job, {
      backend: openBackend(),
      sink,
      every: d.every,
      stopped: () => stopped,
      onStart: (run) => {
        tool = run;
        if (!run.pid) return;
        state = { ...state, state: 'running', pid: run.pid };
        writeState(state);
      },
      onProgress: (p, more) => {
        state = { ...state, progress: p, elapsed_s: more.elapsed_s, ...(more.bytes !== undefined ? { bytes: more.bytes } : {}) };
        writeState(state);
      },
    });
    await sink?.flush();
    writeState({ ...state, state: outcome.ok ? 'done' : 'failed', code: outcome.code, lines: outcome.lines });
  } catch (e) {
    writeState({ ...state, state: 'failed', code: 1, lines: [`Render failed: its supervisor stopped (${(e as Error).message.split('\n')[0]}).`] });
  }
}

/** "about 4 min left", "about 40 s left". */
function left(s: number): string {
  if (s < 90) return `about ${Math.max(1, Math.round(s / 5) * 5)} s left`;
  if (s < 90 * 60) return `about ${Math.ceil(s / 60)} min left`;
  return `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
}

/** The one line for a render still going. */
export function stillLine(s: RenderState): string {
  const p = s.progress;
  const v = s.label ? ` ${s.label}` : '';
  const doing = p?.stage === 'uploading' ? `uploading${v}` : p?.stage === 'checking' ? `putting${v || ' it'} up` : `rendering${v}`;
  const stage = p?.stage === 'bundling' || p?.stage === 'encoding' ? `${p.stage} ` : '';
  let how: string;
  if (p && p.pct !== null) how = `${stage}${p.pct} %${p.eta_s !== undefined ? `, ${left(p.eta_s)}` : ''}`;
  else how = `${took((s.elapsed_s ?? 0) * 1000)} so far${s.bytes ? `, ${Math.round(s.bytes / 1e6)} MB written` : ''}`;
  return `Still ${doing}: ${how}. Run lampo render wait ${s.id} again now.`;
}

/**
 * Waits for a detached render to end, at most `bound` ms: its own lines and exit code once it ended, else one line
 * saying it goes on (exit 0). A supervisor that is gone without a word is a failure.
 */
export async function waitFor(id: string, bound: number): Promise<{ lines: string[]; code: number }> {
  const until = Date.now() + Math.max(0, Math.min(bound, WAIT_MAX_MS));
  for (;;) {
    const s = readState(id);
    if (!s) return { lines: [`No render ${id} on this machine.`], code: 2 };
    if (ended(s)) return { lines: s.lines ?? [], code: s.code ?? (s.state === 'done' ? 0 : 1) };
    if (!alive(supervisorOf(s))) {
      // it may have ended in the moment between the two reads
      const again = readState(id);
      if (again && ended(again)) continue;
      return { lines: [`Render ${id} stopped without a word: its supervisor is gone. Run it again.`], code: 1 };
    }
    if (Date.now() >= until) return { lines: [stillLine(s)], code: 0 };
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(10, until - Date.now()))));
  }
}
