// ffprobe metadata + content hash. Read-only on the video.
import { type ChildProcess, type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explicitWorkspace, severalWorkspaces } from './paths.ts';
import type { ProbeResult } from './types.ts';

export const FFMPEG = process.env.VR_FFMPEG || findBin('ffmpeg');
export const FFPROBE = process.env.VR_FFPROBE || findBin('ffprobe');

function findBin(name: string): string {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (fs.existsSync(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  return name;
}

// Background work (analysis, diff, pre-review, proxies) runs niced, so it never competes with playback in the browser.
export const BG_NICE = 12;
export function lower(pid: number | undefined, n = BG_NICE): void {
  if (!pid) return;
  try {
    os.setPriority(pid, n);
  } catch {}
}

export interface RunOptions {
  input?: string | Buffer;
  maxBuffer?: number;
  nice?: number;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit in ms, after which the process is killed (default: 30 s for ffprobe, `MEDIA_TIMEOUT_MS` else). */
  timeout?: number;
  /** The inputs came from outside (a client's or an agent's file): only the incoming demuxers may read them, in every mode. */
  incoming?: boolean;
  /** How much of stderr is kept, from its end (default STDERR_KEEP): raise it only for a run whose stderr is its answer. */
  stderrLimit?: number;
  /**
   * Someone waits for this run, outside the job queue (a frame, a note's screenshots, a contact sheet, a reference):
   * it takes a place in the on-demand gate (ON_DEMAND) and runs on ON_DEMAND.threads threads.
   */
  onDemand?: boolean;
  /** ffmpeg's threads for its inputs, filters and output (default: the machine's or container's, at most 8). */
  threads?: number;
}

/**
 * ffmpeg runs someone waits for right now, outside the job queue: at most `atOnce` of them at once across the server,
 * each on `threads` threads, the others waiting their turn — at most `waiting` of them, each at most `waitMs` —, past
 * that MediaBusyError (503 + Retry-After). One viewer's 40 parallel frame requests ran 33 ffmpeg with 573 threads, near
 * a container's process limit, and an encoder that can't start a thread fails (A13 MEDIA-4).
 * While the server has several workspaces, each takes at most `perWorkspace.atOnce` of the places and
 * `perWorkspace.waiting` of the waiting ones, and a freed place goes to the waiting workspace with the fewest running:
 * one account's 300 frame requests took them all, and another team's note was refused in 19 ms (A13 VERIFY-2). A lone
 * workspace (a person's own machine) keeps the whole gate.
 */
export const ON_DEMAND = { atOnce: 4, threads: 2, waiting: 100, waitMs: 30_000, perWorkspace: { atOnce: 2, waiting: 10 } };

/** The on-demand gate is full: whoever asked may ask again in a moment. */
export class MediaBusyError extends Error {
  status = 503;
  retryAfter = 5;
  /** The same sentence for everyone (lib/publicError.ts). */
  publicText = 'the server is busy making pictures right now: try again in a moment';
  constructor() {
    super('the server is busy making pictures right now: try again in a moment');
  }
}

interface Waiting {
  ws: string;
  go: () => void;
  timer: NodeJS.Timeout;
}
// Places by workspace id (ours, never a visitor's: one key per workspace with a run going); '' for work outside one.
const onDemandIn = new Map<string, number>();
let onDemandRunning = 0;
const onDemandWaiting: Waiting[] = [];
const runningIn = (ws: string): number => onDemandIn.get(ws) ?? 0;
/** Whether a run for `ws` may start now: a place is free, and the workspace is under its share of them. */
const mayStart = (ws: string): boolean => onDemandRunning < ON_DEMAND.atOnce && (!severalWorkspaces() || runningIn(ws) < ON_DEMAND.perWorkspace.atOnce);
const started = (ws: string): void => {
  onDemandRunning++;
  onDemandIn.set(ws, runningIn(ws) + 1);
};
const ended = (ws: string): void => {
  onDemandRunning--;
  const n = runningIn(ws) - 1;
  if (n > 0) onDemandIn.set(ws, n);
  else onDemandIn.delete(ws);
};
/** Free places go to those waiting: each time the oldest of the workspace with the fewest running that may start. */
function handOver(): void {
  for (;;) {
    let pick: Waiting | undefined;
    for (const w of onDemandWaiting) if (mayStart(w.ws) && (!pick || runningIn(w.ws) < runningIn(pick.ws))) pick = w;
    if (!pick) return;
    onDemandWaiting.splice(onDemandWaiting.indexOf(pick), 1);
    clearTimeout(pick.timer);
    started(pick.ws);
    pick.go();
  }
}
/** A place in the on-demand gate for the workspace running now; the returned function gives it back. */
async function onDemandPlace(): Promise<() => void> {
  const ws = explicitWorkspace() ?? '';
  if (mayStart(ws)) started(ws);
  else {
    if (onDemandWaiting.length >= ON_DEMAND.waiting) throw new MediaBusyError();
    if (severalWorkspaces() && onDemandWaiting.filter((w) => w.ws === ws).length >= ON_DEMAND.perWorkspace.waiting) throw new MediaBusyError();
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = {
        ws,
        go: resolve,
        timer: setTimeout(() => {
          onDemandWaiting.splice(onDemandWaiting.indexOf(entry), 1);
          reject(new MediaBusyError());
        }, ON_DEMAND.waitMs),
      };
      onDemandWaiting.push(entry);
    });
    // handOver counted the place for it
  }
  let given = false;
  return () => {
    if (given) return;
    given = true;
    ended(ws);
    handOver();
  };
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export type RunError = Error & RunResult & { code: number | null };

/**
 * Demuxers for files that come from outside: uploaded renders, fix previews, voice notes, and on a hosted instance every
 * input (they all arrived as uploads). Anything else (HLS or concat playlists, image sequences, raw streams, network
 * or device demuxers) is refused by ffmpeg itself before it reads the file as that format.
 */
// gif: references on notes may be GIFs (a single picture or motion), lib/refs.ts. mp3: the sounds agents offer as
// options (lib/options.ts) — a voice from a speech engine usually comes as one.
export const INCOMING_FORMATS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'ogg', 'wav', 'mp3', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2', 'gif'].join(
  ',',
);

// ffprobe only reads headers: a probe that takes longer is stuck on a hostile file.
const PROBE_TIMEOUT_MS = 30_000;
/** The longest one ffmpeg run may take (VR_MEDIA_TIMEOUT, seconds); work on long renders passes its own limit. */
export const MEDIA_TIMEOUT_MS = (Number(process.env.VR_MEDIA_TIMEOUT) || 3600) * 1000;

let hostedFormats: string | null = null;
/**
 * On a hosted instance every file ffmpeg or ffprobe opens came from an upload: all inputs are held to the incoming
 * demuxers. Locally the renders are the person's own files, in whatever container their editor writes.
 */
export function restrictFormats(on: boolean): void {
  hostedFormats = on ? INCOMING_FORMATS : null;
}

/**
 * ffmpeg and ffprobe may only read local files and pipes. A crafted upload (an HLS or concat playlist dressed up as
 * a video) must never make them fetch URLs or other files. Goes before every -i (ffmpeg) or first (ffprobe); with a
 * format list, every input whose format ffmpeg detects (no `-f` of ours before it) must be one of those demuxers.
 */
export function safeArgs(cmd: string, args: readonly string[], formats: string | null = hostedFormats, threads?: number): string[] {
  const only = formats ? ['-format_whitelist', formats] : [];
  if (cmd === FFPROBE) return ['-protocol_whitelist', 'file,pipe', ...(args.includes('-f') || args.includes('-format_whitelist') ? [] : only), ...args];
  if (cmd !== FFMPEG) return [...args];
  // Threads as many as this machine or container really has: ffmpeg counts the host's CPUs, so in a container capped at
  // 8 of 32 each run started ~3 × 32 threads, a few runs at once used up the container's process limit and an encoder
  // could not start ("ff_frame_thread_encoder_init failed" on Accept). A caller's own -threads stays; `threads` sets
  // fewer (a run someone waits for: one picture needs no more than two).
  const n = String(threads ?? ffmpegThreads());
  const own = args.includes('-threads');
  const out: string[] = own ? [] : ['-filter_threads', n, '-filter_complex_threads', n];
  let forced = false;
  args.forEach((a, i) => {
    if (a === '-f') forced = true;
    if (a === '-i') {
      out.push('-protocol_whitelist', 'file,pipe', ...(forced ? [] : only));
      if (!own) out.push('-threads', n);
      forced = false;
    }
    // the output is the last argument: its encoder gets the same number
    if (!own && i === args.length - 1 && args.length > 1 && args[i - 1] !== '-i') out.push('-threads', n);
    out.push(a);
  });
  return out;
}

let threadsCache: number | undefined;
/**
 * The CPUs this process may use: a cgroup's CPU quota (a container's `cpus:`) when there is one, else the machine's
 * logical CPUs; at most 8 per ffmpeg run (more threads stop helping one encode and only cost memory).
 */
export function ffmpegThreads(): number {
  if (threadsCache !== undefined) return threadsCache;
  let cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) cpus = Math.min(cpus, Math.max(1, Math.ceil(Number(quota) / Number(period))));
  } catch {
    // not on cgroup v2 (a Mac, an older Linux): the machine's count
  }
  threadsCache = Math.max(1, Math.min(8, cpus));
  return threadsCache;
}

/** Kills a child that outlives its wall-clock limit; the returned function says whether that happened. */
function deadline(p: ChildProcess, ms: number): () => boolean {
  let hit = false;
  const t = setTimeout(() => {
    hit = true;
    p.kill('SIGKILL');
  }, ms);
  t.unref();
  p.once('close', () => clearTimeout(t));
  return () => hit;
}

/**
 * What is kept of a media tool's stderr: its end. A damaged or crafted input makes ffmpeg print a line for every
 * broken frame (even at `-v error`), so all of it could fill the server's memory; what went wrong is said last.
 */
export const STDERR_KEEP = 256 * 1024;

/** The last `limit` bytes of a stream, kept as they arrive: memory stays bounded however much is written. */
export function tailOf(limit = STDERR_KEEP): { push: (d: Buffer) => void; text: () => string } {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    push(d) {
      parts.push(d);
      size += d.length;
      while (parts.length > 1 && size - (parts[0] as Buffer).length >= limit) size -= (parts.shift() as Buffer).length;
    },
    text() {
      const all = Buffer.concat(parts);
      return all.subarray(Math.max(0, all.length - limit)).toString();
    },
  };
}

export type MediaProcess = ChildProcessWithoutNullStreams & {
  /** The end of what it printed on stderr (STDERR_KEEP at most): stderr is always read, so it never stalls on a full pipe. */
  stderrTail: () => string;
};

/** spawn() for ffmpeg/ffprobe with the protocol whitelist (and on a hosted instance the format list) and a deadline. */
export function spawnMedia(cmd: string, args: readonly string[], env?: NodeJS.ProcessEnv, timeout = MEDIA_TIMEOUT_MS): MediaProcess {
  const p = spawn(cmd, safeArgs(cmd, args), { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
  deadline(p, timeout);
  const kept = tailOf();
  p.stderr.on('data', (d: Buffer) => kept.push(d));
  return Object.assign(p, { stderrTail: kept.text });
}

export async function run(cmd: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  if (!options.onDemand) return runNow(cmd, args, options);
  const done = await onDemandPlace();
  try {
    return await runNow(cmd, args, { ...options, threads: options.threads ?? ON_DEMAND.threads });
  } finally {
    done();
  }
}

function runNow(
  cmd: string,
  args: readonly string[],
  { input, maxBuffer = 64 * 1024 * 1024, nice, env, timeout, incoming = false, stderrLimit = STDERR_KEEP, threads }: RunOptions,
): Promise<RunResult> {
  const limit = timeout ?? (cmd === FFPROBE ? PROBE_TIMEOUT_MS : MEDIA_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, safeArgs(cmd, args, incoming ? INCOMING_FORMATS : hostedFormats, threads), {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    const expired = deadline(p, limit);
    if (nice) lower(p.pid, nice);
    const out: Buffer[] = [];
    const err = tailOf(stderrLimit);
    let size = 0;
    p.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= maxBuffer) out.push(d);
    });
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', reject);
    // A tool stopped at its deadline whose children still hold its output open (a script, a CLI that forks) would keep
    // 'close' from coming: what it said so far is all there will be.
    p.on('exit', () => {
      if (!expired()) return;
      p.stdout.destroy();
      p.stderr.destroy();
    });
    p.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = err.text();
      if (code === 0 && !expired()) resolve({ stdout, stderr });
      else {
        const why = expired()
          ? `${path.basename(cmd)} took longer than ${Math.round(limit / 1000)} s and was stopped`
          : `${cmd} exited ${code}: ${stderr.slice(-600)}`;
        reject(Object.assign(new Error(why), { stdout, stderr, code }) as RunError);
      }
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export const runBg = (cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> => run(cmd, args, { ...opts, nice: BG_NICE });

const rate = (s: string | undefined): number => {
  if (!s || s === '0/0') return 0;
  const [a, b] = s.split('/').map(Number);
  return b ? a / b : a;
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  pix_fmt?: string;
  color_space?: string;
  color_range?: string;
  start_time?: string;
  sample_rate?: string;
  channels?: number;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

function pickFps(v: FfprobeStream): number {
  const r = rate(v.r_frame_rate);
  const avg = rate(v.avg_frame_rate);
  if (r && avg && Math.abs(r - avg) / r < 0.01) return r;
  return avg || r || 30;
}

function parseProbe(json: FfprobeOutput): ProbeResult {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error('no video stream');
  const a = streams.find((s) => s.codec_type === 'audio');
  let width = v.width || 0;
  let height = v.height || 0;
  const rot = Number(v.tags?.rotate || (v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  const fps = pickFps(v);
  const duration = Number(v.duration || json.format?.duration || 0);
  const frames = Number(v.nb_frames) || Math.round(duration * fps);
  return {
    fps: Math.round(fps * 100000) / 100000,
    width,
    height,
    duration: Math.round(duration * 1000) / 1000,
    frames,
    codec: v.codec_name || '',
    pix_fmt: v.pix_fmt || '',
    color_space: v.color_space || null,
    color_range: v.color_range || null,
    start_time: Number(v.start_time || 0),
    rotation: rot,
    audio: a ? { codec: a.codec_name || '', sample_rate: Number(a.sample_rate), channels: a.channels || 0 } : null,
    format: json.format?.format_name || '',
  };
}

// Containers accepted from uploads. Anything else (playlists, image sequences, raw streams) is refused before
// ffmpeg does real work on it.
const VIDEO_CONTAINERS = new Set(['mov', 'mp4', 'matroska', 'webm']);
export const isVideoContainer = (format: string | undefined): boolean => !!format && format.split(',').some((f) => VIDEO_CONTAINERS.has(f));

const probeArgs = (file: string) => ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file];

/**
 * Just the container of a file that came from outside ("matroska,webm", "ogg" …), or "" when ffprobe cannot read it
 * as one of the incoming demuxers.
 */
export async function probeFormat(file: string): Promise<string> {
  try {
    // Plain value output: csv quotes anything with a comma ("matroska,webm" arrived with its quotes).
    const args = ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1:nokey=1', file];
    const { stdout } = await run(FFPROBE, ['-format_whitelist', INCOMING_FORMATS, ...args]);
    return stdout.toString().trim();
  } catch {
    return '';
  }
}

/** A sound's first audio stream (lib/refs.ts, the options agents offer). */
export interface AudioProbe {
  duration: number;
  codec: string;
  sample_rate: number;
  channels: number;
  format: string;
}

/** The first audio stream of a file that came from outside (only the incoming demuxers read it); throws without one. */
export async function probeAudio(file: string): Promise<AudioProbe> {
  const { stdout } = await run(FFPROBE, ['-format_whitelist', INCOMING_FORMATS, ...probeArgs(file)]);
  const json = JSON.parse(stdout.toString()) as FfprobeOutput;
  const a = (json.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw new Error('no audio stream');
  const duration = Number(a.duration || json.format?.duration || 0);
  return {
    duration: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : 0,
    codec: a.codec_name || '',
    sample_rate: Number(a.sample_rate) || 0,
    channels: a.channels || 0,
    format: json.format?.format_name || '',
  };
}

/** `incoming`: the file came from outside (an upload, a preview), so only the incoming demuxers may read it. */
export async function probe(file: string, { incoming = false } = {}): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, [...(incoming ? ['-format_whitelist', INCOMING_FORMATS] : []), ...probeArgs(file)]);
  return parseProbe(JSON.parse(stdout.toString()));
}

export function probeSync(file: string): ProbeResult {
  const out = execFileSync(FFPROBE, safeArgs(FFPROBE, probeArgs(file)), {
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return parseProbe(JSON.parse(out.toString()));
}

/**
 * What an incoming render may be before any real work starts on it (VR_MAX_SIDE px, VR_MAX_DURATION s, VR_MAX_ASPECT
 * between its long and its short side).
 */
export const INCOMING_LIMITS = {
  maxSide: Number(process.env.VR_MAX_SIDE) || 8192,
  minSide: 32,
  maxAspect: Math.max(1, Number(process.env.VR_MAX_ASPECT) || 8),
  maxSeconds: Number(process.env.VR_MAX_DURATION) || 4 * 3600,
  maxFps: 240,
};

/**
 * The tallest an analysis picture gets for its width (the diff's 160 px, footage search's 128, Auto-check's 64): 1:4.
 * A taller render is squeezed for analysis, so no aspect ratio makes its frames big — a 16×8192 one made 128 × 65536
 * frames and froze the server for seconds per chunk (A13 MEDIA-2). Real renders (9:16 is 1:1.8) keep their shape.
 */
export const ANALYSIS_TALLEST = 4;
/** The height of a w px wide analysis picture of a width×height render: the aspect's, a multiple of `step`, at most 1:4. */
export const analysisRows = (w: number, width: number, height: number, step = 2): number =>
  Math.max(step, Math.min(ANALYSIS_TALLEST * w, Math.round((w * height) / width / step) * step));

/**
 * A `select` expression that passes exactly these frames, by decode index (`n`), escaped for a filter graph. FFmpeg 5.1.9,
 * 7.1.4, 8.0.2 and later refuse an expression nested more than 100 deep, and `eq(n,a)+eq(n,b)+…` nests one level per
 * frame: Auto-check's half-second samples of anything longer than about 50 s failed ("Error reinitializing filters!").
 * Evenly spaced runs become one term, `between(n,a,b)*not(mod(n-a,step))`, single frames `eq(n,f)`, and the terms are
 * summed as a balanced tree: a few levels deep, however many frames.
 */
export function selectFrames(frames: readonly number[]): string {
  const f = [...new Set(frames)].sort((a, b) => a - b);
  const terms: string[] = [];
  for (let i = 0; i < f.length; ) {
    const a = f[i] as number;
    const step = (f[i + 1] ?? a) - a;
    let j = i;
    while (j + 1 < f.length && (f[j + 1] as number) - (f[j] as number) === step) j++;
    if (j - i >= 2) {
      terms.push(step === 1 ? `between(n\\,${a}\\,${f[j]})` : `between(n\\,${a}\\,${f[j]})*not(mod(n-${a}\\,${step}))`);
      i = j + 1;
    } else {
      terms.push(`eq(n\\,${a})`);
      i++;
    }
  }
  const sum = (t: string[]): string => {
    if (t.length <= 1) return t[0] ?? '0';
    const half = Math.ceil(t.length / 2);
    return `(${sum(t.slice(0, half))}+${sum(t.slice(half))})`;
  };
  return sum(terms);
}

/**
 * Refuses renders whose headers promise more than any real render is: absurd sizes, durations or frame rates would
 * make every later job (posters, sprites, diffs, proxies) run for hours or allocate gigabytes; a sliver (16×8192) or a
 * thumbnail (16×16) is no render either.
 */
export function checkIncoming(meta: ProbeResult, limits = INCOMING_LIMITS): void {
  if (meta.width > limits.maxSide || meta.height > limits.maxSide)
    throw new Error(`the video is ${meta.width}×${meta.height}; at most ${limits.maxSide} px on each side`);
  if (meta.width < limits.minSide || meta.height < limits.minSide)
    throw new Error(`the video is ${meta.width}×${meta.height}; at least ${limits.minSide} px on each side`);
  const aspect = Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height);
  if (aspect > limits.maxAspect) throw new Error(`the video is ${meta.width}×${meta.height}; at most ${limits.maxAspect}:1 either way`);
  if (!(meta.duration <= limits.maxSeconds)) throw new Error(`the video says it is ${Math.round(meta.duration)} s long; at most ${limits.maxSeconds} s`);
  if (!(meta.fps > 0 && meta.fps <= limits.maxFps)) throw new Error(`the video's frame rate (${meta.fps}) is outside 1–${limits.maxFps} fps`);
  if (meta.frames > limits.maxSeconds * limits.maxFps) throw new Error(`the video says it has ${meta.frames} frames`);
}

// Content hash: sha1(size + first MiB + last MiB). Cheap on big renders, changes on every re-render
// (the mp4 index holds per-sample sizes). Memoised per (path, size, mtime).
const MB = 1024 * 1024;
const hashMemo = new Map<string, string>();
export function quickHash(file: string, st: fs.Stats = fs.statSync(file)): string {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const memo = hashMemo.get(key);
  if (memo) return memo;
  const h = crypto.createHash('sha1');
  h.update(String(st.size));
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(MB, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (st.size > MB) {
      const tail = Buffer.alloc(Math.min(MB, st.size - MB));
      fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
      h.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  const hex = h.digest('hex');
  hashMemo.set(key, hex);
  return hex;
}

// A closer look than quickHash (Version.sample): renders in codecs with a constant frame size (uncompressed, v210,
// DNxHD/HR) keep their size, head and tail when a re-render changes only frames in the middle. Many small slices see
// more frames (and more rows of each) than a few big ones for the same bytes read.
const SLICES = 256;
const SLICE = 4096;
const sampleMemo = new Map<string, string>();
export function sampleHash(file: string, st: fs.Stats = fs.statSync(file)): string {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const memo = sampleMemo.get(key);
  if (memo) return memo;
  const h = crypto.createHash('sha1');
  h.update(quickHash(file, st));
  const lo = Math.min(MB, st.size);
  const span = Math.max(lo, st.size - MB) - lo;
  if (span > 0) {
    const buf = Buffer.alloc(Math.min(SLICE, span));
    const fd = fs.openSync(file, 'r');
    try {
      for (let i = 0; i < SLICES; i++) {
        const n = fs.readSync(fd, buf, 0, buf.length, lo + Math.floor(((span - buf.length) * i) / (SLICES - 1)));
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const hex = h.digest('hex');
  sampleMemo.set(key, hex);
  return hex;
}
