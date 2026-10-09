// Runs an agent's render command for `lampo render`: an argument list (never a shell), in a process group of its own so a
// stop reaches everything it started, stdin closed (a tool that asks a question fails instead of hanging), stdout and
// stderr captured (Remotion prints a line per update when they aren't a terminal) and read by the tool's parser
// (lib/render/tools.ts). ffmpeg gets `-progress pipe:3`. Without a parser, or before a known tool has said anything,
// how far it is comes from the output file growing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { type GroupStop, groupAlive, stopGroup } from '../processGroup.ts';
import {
  aerenderReader,
  blenderFrames,
  blenderReader,
  type FfmpegTotal,
  ffmpegPlan,
  ffmpegReader,
  type Reading,
  type RenderTool,
  remotionLine,
  toolOf,
  withFfmpegProgress,
} from './tools.ts';

/** The pipe ffmpeg writes its -progress blocks to. */
const PROGRESS_FD = 3;
/** Lines of the tool's output kept for a failure's words (stdout and stderr as they came). */
const TAIL_LINES = 200;
/** A known tool that hasn't said how far it is by then: the output file's size stands in. */
const QUIET_MS = 5000;
/** A stop: the signal asked for, SIGTERM this long after, SIGKILL as long after that (lib/processGroup.ts). */
const STOP_GRACE_MS = 5000;

export interface ToolRun {
  /** The process (group) id, once it started. */
  pid: number | undefined;
  tool: RenderTool | null;
  /**
   * Stops the whole render, the tool and everything it started: `sig` first, then SIGTERM and SIGKILL to whatever of its
   * group is left (SIGKILL: at once). `done` then waits for the group to end.
   */
  signal(sig: NodeJS.Signals): void;
  done: Promise<ToolResult>;
}

export interface ToolResult {
  /** The tool's exit code; 128 + n for a signal; 127 when it couldn't start. */
  code: number;
  signal: NodeJS.Signals | null;
  /** Why it couldn't start (not found, not allowed). */
  startError?: string;
  /** Its last lines, stdout and stderr as they came. */
  tail: string[];
  elapsedMs: number;
}

export interface ToolRunOptions {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The file (or folder of frames) it writes, for the growing-file reading. */
  out: string | null;
  /** How far it is, as often as the tool says it; `bytes`: the output's size (file readings). */
  onReading: (r: Reading, from: 'tool' | 'file', bytes?: number) => void;
  /** The tool's own output, for `--verbose`. */
  echo?: (chunk: Buffer) => void;
  /** An input's length and rate (ffprobe), for ffmpeg's total. */
  probe?: (file: string) => Promise<{ duration: number; fps: number } | null>;
  /** A stop's steps apart (STOP_GRACE_MS; tests shorten it). */
  stopGraceMs?: number;
}

/** The output's size: a file's, or the files' in a folder of frames (one level). Null when there is nothing yet. */
export function outputBytes(out: string): number | null {
  try {
    const st = fs.statSync(out);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return null;
    let sum = 0;
    const names = fs.readdirSync(out).slice(0, 20_000);
    for (const n of names)
      try {
        const f = fs.statSync(path.join(out, n));
        if (f.isFile()) sum += f.size;
      } catch {}
    return sum;
  } catch {
    return null;
  }
}

/** A line splitter for a stream of bytes (UTF-8 kept whole across chunks); lines over 64 KB are cut. */
function lines(onLine: (l: string) => void): { push(b: Buffer): void; end(): void } {
  const dec = new StringDecoder('utf8');
  let rest = '';
  const take = (s: string) => {
    rest += s;
    // a terminal-style tool rewrites one line with \r: each rewrite is a line here
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop() ?? '';
    if (rest.length > 64 * 1024) rest = rest.slice(-64 * 1024);
    for (const p of parts) onLine(p);
  };
  return {
    push: (b) => take(dec.write(b)),
    end() {
      take(dec.end());
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

export function runTool(o: ToolRunOptions): ToolRun {
  const started = Date.now();
  const tool = toolOf(o.argv);
  const [cmd, ...rawArgs] = o.argv;
  const args = tool === 'ffmpeg' ? withFfmpegProgress(rawArgs, PROGRESS_FD) : [...rawArgs];
  const readsProgress = tool === 'ffmpeg' && !rawArgs.includes('-progress');
  const group = process.platform !== 'win32';
  const child = spawn(cmd as string, args, {
    cwd: o.cwd,
    env: o.env,
    // its own process group (and session): a stop reaches the tool and all it started, never lampo itself
    detached: group,
    stdio: readsProgress ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const tail: string[] = [];
  const keep = (l: string) => {
    tail.push(l.length > 2000 ? `${l.slice(0, 2000)}…` : l);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  let saidAnything = false;
  const fromTool = (r: Reading | null) => {
    if (!r) return;
    saidAnything = true;
    o.onReading(r, 'tool');
  };

  // the tool's own reader of its lines (ffmpeg's comes on its progress pipe)
  let total: FfmpegTotal = {};
  let lineReader: ((l: string) => Reading | null) | null = null;
  if (tool === 'remotion') lineReader = remotionLine;
  else if (tool === 'aerender') lineReader = aerenderReader();
  else if (tool === 'blender') lineReader = blenderReader(blenderFrames(rawArgs));
  if (tool === 'ffmpeg') {
    const plan = ffmpegPlan(rawArgs);
    total = plan.frames
      ? { frames: plan.frames }
      : plan.seconds
        ? { seconds: plan.seconds, ...(plan.fps ? { frames: Math.round(plan.seconds * plan.fps) } : {}) }
        : {};
    // Without a length of its own, the first input's (ffprobe), less where it starts; a file on this disk only.
    const input = plan.inputs[0];
    if (!plan.frames && !plan.seconds && input && o.probe) {
      const file = path.resolve(o.cwd, input);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(input) && fs.existsSync(file))
        o.probe(file)
          .then((p) => {
            if (!p || !(p.duration > 0)) return;
            const seconds = Math.max(0, p.duration - (plan.start ?? 0));
            if (seconds > 0) total = { seconds, frames: Math.round(seconds * (plan.fps ?? p.fps)) };
          })
          .catch(() => {});
    }
  }

  const onLine = (l: string) => {
    keep(l);
    if (lineReader) fromTool(lineReader(l));
  };
  const outLines = lines(onLine);
  const errLines = lines(onLine);
  child.stdout?.on('data', (b: Buffer) => {
    o.echo?.(b);
    outLines.push(b);
  });
  child.stderr?.on('data', (b: Buffer) => {
    o.echo?.(b);
    errLines.push(b);
  });
  if (readsProgress) {
    const read = ffmpegReader(() => total);
    const progress = lines((l) => fromTool(read(l)));
    const pipe = child.stdio[PROGRESS_FD] as NodeJS.ReadableStream | null;
    pipe?.on('data', (b: Buffer) => progress.push(b));
    pipe?.on('error', () => {});
  }

  // The output growing: for a tool without a reader, or one that has said nothing for a while.
  let lastBytes: number | null = null;
  const ticker = setInterval(() => {
    if (!o.out || (tool && (saidAnything || Date.now() - started < QUIET_MS))) return;
    const bytes = outputBytes(o.out);
    if (bytes === null || bytes === lastBytes) return;
    lastBytes = bytes;
    o.onReading({ stage: 'rendering', pct: null }, 'file', bytes);
  }, 1000);
  ticker.unref();

  // a stop under way: the render has ended only once its whole group has (whatever the tool left behind is stopped too)
  let stopping: GroupStop | null = null;
  // the group seen empty after the tool ended: never signalled again (its id may be another's by then)
  let gone = false;
  const done = new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (code: number, signal: NodeJS.Signals | null, startError?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      outLines.end();
      errLines.end();
      void (stopping?.done ?? Promise.resolve()).then(() => {
        if (!child.pid || !group || !groupAlive(child.pid)) gone = true;
        resolve({ code, signal, ...(startError ? { startError } : {}), tail, elapsedMs: Date.now() - started });
      });
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      const why = e.code === 'ENOENT' ? `command not found: ${cmd}` : e.code === 'EACCES' ? `not allowed to run ${cmd}` : e.message;
      finish(e.code === 'ENOENT' ? 127 : 126, null, why);
    });
    child.on('exit', (code, signal) => {
      const n = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
      // What it started may still hold its output open: what came so far is all that is read.
      const grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(n, signal);
      }, 2000);
      grace.unref();
      child.once('close', () => {
        clearTimeout(grace);
        finish(n, signal);
      });
    });
  });

  return {
    pid: child.pid,
    tool,
    signal(sig) {
      if (!child.pid || gone) return;
      if (!group) {
        try {
          child.kill(sig);
        } catch {}
        return;
      }
      if (!stopping) stopping = stopGroup(child.pid, { first: sig, graceMs: o.stopGraceMs ?? STOP_GRACE_MS, ref: true });
      else if (sig === 'SIGKILL') stopping.kill();
    },
    done,
  };
}
