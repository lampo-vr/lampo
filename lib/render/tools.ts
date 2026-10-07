// What `vr render` knows about render tools: which one a command runs (by argv[0] / argv[1]) and how each says how far
// it is. Pure and browser-safe: lib/render/run.ts feeds it the tool's output as it comes, the tests feed it recorded
// lines. Checked against the tools' own sources (2026-10-07):
// - Remotion's CLI (packages/cli/src/progress-bar.ts, render-flows/render.ts): with stdout not a TTY it prints one line
//   per update, `Bundling 45%`, `Rendered 340/900, time remaining: 12s`, `Encoded 120/900`; in a terminal (or older
//   versions) the bar lines `Rendering frames ━━━ 340/900`, `Encoding video ━━━ 120/900`, `Muxing video …`.
// - ffmpeg (ffmpeg.html; the keys as ffmpeg 8.0 writes them): `-progress <url>` writes key=value blocks every
//   `-stats_period` (0.5 s), each ending `progress=continue|end`; `frame`, `out_time_us` (and `out_time_ms`, also µs).
// - aerender: `PROGRESS:  0:00:01:05 (31): …` lines after `Start:` and `Duration:` (German `Anfang`, `Dauer`), errors
//   `aerender Error: …`, as nexrender's parser reads them (Adobe documents no line format).
// - Blender (source/blender/render/intern/pipeline.cc): `Fra: N | …` while a frame renders headless, `Rendering frame N`
//   as an animation's frame starts, `Video append frame N` as one is written; 4.x printed `Fra:N Mem:…`.
import type { RunProgress } from '../types.ts';

export const RENDER_TOOLS = ['remotion', 'ffmpeg', 'aerender', 'blender'] as const;
export type RenderTool = (typeof RENDER_TOOLS)[number];
/** The stages of a render as the person sees them; the percentage starts again at each. */
export const RENDER_STAGES = ['bundling', 'rendering', 'encoding', 'uploading', 'checking'] as const;
export type RenderStage = (typeof RENDER_STAGES)[number];

/** One reading of how far a tool is: its stage, the share of that stage (null when it can't say), frames when it says. */
export interface Reading {
  stage: RenderStage;
  pct: number | null;
  frames?: [done: number, total: number];
}

/** A RunProgress as the contract has it, from a reading (`what` follows the stage). */
export function progressOf(r: Reading, extra: { eta_s?: number; tool?: RenderTool | null; v?: number | null } = {}): RunProgress {
  const what = r.stage === 'uploading' ? 'upload' : r.stage === 'checking' ? 'check' : 'render';
  return {
    what,
    stage: r.stage,
    pct: r.pct === null ? null : Math.max(0, Math.min(100, Math.round(r.pct))),
    ...(r.frames ? { frames: r.frames } : {}),
    ...(extra.eta_s !== undefined ? { eta_s: extra.eta_s } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.v ? { v: extra.v } : {}),
  };
}

// ---------------------------------------------------------------- which tool

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'yarn', 'bun', 'npm']);
/** A program's name as typed or as a path: `/opt/x/bin/FFmpeg.exe` → `ffmpeg`. */
export const programName = (s: string | undefined): string =>
  (s ?? '')
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '') ?? '';

/** The tool a command runs, by its first words: `ffmpeg …`, `npx remotion render …`, `aerender …`, `blender …`. */
export function toolOf(argv: readonly string[]): RenderTool | null {
  const first = programName(argv[0]);
  if (first === 'ffmpeg' || first === 'aerender' || first === 'blender') return first;
  const words = argv.slice(1).filter((a) => !a.startsWith('-'));
  const remotion = (w: string | undefined) => !!w && (w === 'remotion' || w.startsWith('remotion@') || w === '@remotion/cli' || w.startsWith('@remotion/cli@'));
  if (first === 'remotion') return words[0] === 'render' ? 'remotion' : null;
  if (RUNNERS.has(first)) {
    // `npx remotion render`, `npx --yes remotion render`, `pnpm exec remotion render`, `npx -p @remotion/cli remotion render`
    const i = words.findIndex(remotion);
    if (i >= 0 && i <= 2) {
      const next = remotion(words[i + 1]) ? words[i + 2] : words[i + 1];
      if (next === 'render') return 'remotion';
    }
  }
  return null;
}

// ---------------------------------------------------------------- lines as they come

// Colours and links (OSC 8) a tool prints even into a pipe.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** A line as a person reads it: no colours, no links' escape codes, no carriage returns. */
export const plain = (s: string): string => s.replace(ANSI, '').replace(/\r/g, '');

const ratio = (done: number, total: number): number | null => (total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : null);
const framesOf = (done: number, total: number): [number, number] | undefined =>
  total > 0 && Number.isInteger(done) && Number.isInteger(total) ? [Math.min(done, total), total] : undefined;

/** One line of `remotion render` (stdout, not a TTY): bundling, rendering or encoding, or null for anything else. */
export function remotionLine(line: string): Reading | null {
  const l = plain(line).trim();
  if (/^Bundl(?:ing|ed)\b/.test(l)) {
    const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(l);
    return { stage: 'bundling', pct: pct ? Math.min(100, Number(pct[1])) : /^Bundled/.test(l) ? 100 : null };
  }
  // its words, then (in a terminal) a bar, then N/M and at most the time left: a composition's own log line that
  // starts alike is no match
  const m =
    /^(Render(?:ing|ed)|Encod(?:ing|ed)|Mux(?:ing|ed))(?:\s+(?:frames|still|video|audio|GIF))?\s+[━╸╺\s]*(?:(\d+)\s*\/\s*(\d+)(?:$|,\s*time remaining|\s+(?:\d+h\s*)?(?:\d+m\s*)?\d+s remaining$)|(\d+ms)$)/.exec(
      l,
    );
  if (!m) return null;
  const stage: RenderStage = m[1].startsWith('Render') ? 'rendering' : 'encoding';
  if (m[2] !== undefined) {
    const [done, total] = [Number(m[2]), Number(m[3])];
    return { stage, pct: ratio(done, total), ...(framesOf(done, total) ? { frames: framesOf(done, total) } : {}) };
  }
  // A bar that ended (`Rendered frames ━━━ 1234ms`) in a terminal: that stage is done.
  return /ed$/.test(m[1]) ? { stage, pct: 100 } : null;
}

// ---------------------------------------------------------------- ffmpeg

/** What an ffmpeg command says of its own length: frames asked for, a duration, where it starts, the output's rate. */
export interface FfmpegPlan {
  inputs: string[];
  frames?: number;
  seconds?: number;
  /** -ss: where reading starts (seconds), taken off the input's length. */
  start?: number;
  /** -r after the last input: the output's frames per second. */
  fps?: number;
  /** The command names its own -progress: vr render can't read it, and leaves it alone. */
  ownProgress: boolean;
}

/** An ffmpeg time: `[-][HH:]MM:SS[.m…]` or `[-]S[.m…][s|ms|us]`; null when it is none. */
export function ffmpegTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^(-?)(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return (m[1] ? -1 : 1) * (Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]));
  m = /^(-?\d+(?:\.\d+)?)(s|ms|us)?$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === 'ms' ? v / 1000 : m[2] === 'us' ? v / 1e6 : v;
}

export function ffmpegPlan(args: readonly string[]): FfmpegPlan {
  const plan: FfmpegPlan = { inputs: [], ownProgress: false };
  let lastInput = -1;
  args.forEach((a, i) => {
    if (a === '-i' && args[i + 1] !== undefined) {
      plan.inputs.push(args[i + 1]);
      lastInput = i + 1;
    }
    if (a === '-progress') plan.ownProgress = true;
  });
  // Output options: after the last input. An input's own -t / -ss (before its -i) limits what is read of it.
  let outT: number | null = null;
  let outTo: number | null = null;
  let outSs: number | null = null;
  let inT: number | null = null;
  let inSs: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    const out = i > lastInput;
    if (a === '-frames:v' || a === '-vframes' || a === '-frames') {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) plan.frames = n;
    } else if (a === '-t') {
      if (out) outT = ffmpegTime(v);
      else if (inT === null) inT = ffmpegTime(v);
    } else if (a === '-to' && out) outTo = ffmpegTime(v);
    else if (a === '-ss') {
      if (out) outSs = ffmpegTime(v);
      else if (inSs === null) inSs = ffmpegTime(v);
    } else if ((a === '-r' || a === '-r:v') && out) {
      const r = ratioOrNumber(v);
      if (r) plan.fps = r;
    } else continue;
    i++; // its value is read: never an option of its own
  }
  const seconds = outT ?? (outTo !== null ? outTo - (outSs ?? 0) : null) ?? inT;
  if (seconds !== null && seconds > 0) plan.seconds = seconds;
  const start = (inSs ?? 0) + (outSs ?? 0);
  if (start > 0) plan.start = start;
  return plan;
}

const ratioOrNumber = (s: string | undefined): number | null => {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(s.trim());
  if (!m) return null;
  const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** The command with `-progress pipe:<fd>` (and `-nostats`, unless it names -stats itself) right after `ffmpeg`;
 * unchanged when it names its own -progress. Progress flags only: nothing about what it renders changes. */
export function withFfmpegProgress(args: readonly string[], fd: number): string[] {
  if (args.includes('-progress')) return [...args];
  const stats = args.includes('-stats') || args.includes('-nostats') ? [] : ['-nostats'];
  return ['-progress', `pipe:${fd}`, ...stats, ...args];
}

/** How long the render will be: frames when it says, else seconds (and frames at a known rate). */
export interface FfmpegTotal {
  frames?: number;
  seconds?: number;
}

/** One `-progress` block (its keys up to `progress=…`) as a reading against the total. */
export function ffmpegReading(kv: Readonly<Record<string, string>>, total: FfmpegTotal): Reading | null {
  const frame = Number.parseInt(kv.frame ?? '', 10);
  const us = Number.parseInt(kv.out_time_us ?? kv.out_time_ms ?? '', 10);
  const end = kv.progress === 'end';
  if (end) {
    const n = Number.isFinite(frame) && frame > 0 ? frame : total.frames;
    return { stage: 'rendering', pct: 100, ...(n ? { frames: [n, n] as [number, number] } : {}) };
  }
  if (total.frames && Number.isFinite(frame)) return { stage: 'rendering', pct: ratio(frame, total.frames), frames: framesOf(frame, total.frames) };
  if (total.seconds && Number.isFinite(us) && us >= 0) return { stage: 'rendering', pct: ratio(us / 1e6, total.seconds) };
  return Number.isFinite(frame) ? { stage: 'rendering', pct: null } : null;
}

/** A reader of ffmpeg's -progress stream: feed it lines, it hands back a reading at the end of each block. */
export function ffmpegReader(total: () => FfmpegTotal): (line: string) => Reading | null {
  let block: Record<string, string> = {};
  return (line) => {
    const m = /^\s*([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m) return null;
    block[m[1]] = m[2].trim();
    if (m[1] !== 'progress') return null;
    const done = block;
    block = {};
    return ffmpegReading(done, total());
  };
}

// ---------------------------------------------------------------- aerender

const TC = /(\d{1,2})[:;](\d{2})[:;](\d{2})[:;](\d{2})/;
/** A reader of aerender's lines: the comp's start and duration first, then where it is. */
export function aerenderReader(): (line: string) => Reading | null {
  let start: number[] | null = null;
  let duration: number[] | null = null;
  let fps: number | null = null;
  const parts = (m: RegExpExecArray) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  // Timecodes as frames at the comp's rate; before aerender says it, at 30: start, duration and position are all
  // counted alike, so the share stays right to within a frame a second.
  const frames = ([h, m, s, f]: number[]) => ((h * 60 + m) * 60 + s) * Math.round(fps ?? 30) + f;
  return (raw) => {
    const line = plain(raw);
    let m = /(?:Start|Anfang):\s*(\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/i.exec(line);
    if (m) {
      start = parts(TC.exec(m[1]) as RegExpExecArray);
      return null;
    }
    m = /(?:Duration|Dauer):\s*(\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/i.exec(line);
    if (m) {
      duration = parts(TC.exec(m[1]) as RegExpExecArray);
      return { stage: 'rendering', pct: 0 };
    }
    m = /(?:Frame Rate|Bildrate):\s*(\d+(?:\.\d+)?)/i.exec(line);
    if (m) {
      fps = Number(m[1]) || null;
      return null;
    }
    m = /(\d{1,2}[:;]\d{2}[:;]\d{2}[:;]\d{2})\s+\((\d+)[UL]?\)/.exec(line);
    if (!m || !duration) return null;
    const total = frames(duration);
    const done = frames(parts(TC.exec(m[1]) as RegExpExecArray)) - (start ? frames(start) : 0) + 1;
    return { stage: 'rendering', pct: ratio(done, total), ...(fps && framesOf(done, total) ? { frames: framesOf(done, total) } : {}) };
  };
}

// ---------------------------------------------------------------- Blender

/** The frames a `blender -b …` command renders, in order, when its arguments say (`-s`/`-e`/`-j` + `-a`, or `-f`). */
export function blenderFrames(args: readonly string[]): { first: number; step: number; count: number; list?: number[] } | null {
  let s: number | null = null;
  let e: number | null = null;
  let j = 1;
  let list: number[] | null = null;
  let anim = false;
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--frame-start') s = int(args[++i]);
    else if (a === '-e' || a === '--frame-end') e = int(args[++i]);
    else if (a === '-j' || a === '--frame-jump') j = int(args[++i]) || 1;
    else if (a === '-a' || a === '--render-anim') anim = true;
    else if (a === '-f' || a === '--render-frame') {
      const out: number[] = [];
      for (const part of (args[++i] ?? '').split(',')) {
        const r = /^(\d+)(?:\.\.(\d+))?$/.exec(part);
        if (!r) return null; // relative frames (+N, -N): Blender knows them, we don't
        const [a1, b1] = [Number(r[1]), r[2] ? Number(r[2]) : Number(r[1])];
        for (let f = a1; f <= b1 && out.length < 1e6; f++) out.push(f);
      }
      list = [...(list ?? []), ...out];
    }
  }
  if (list?.length) return { first: list[0], step: 1, count: list.length, list };
  if (anim && s !== null && e !== null && e >= s) return { first: s, step: j, count: Math.floor((e - s) / j) + 1 };
  return null;
}

/** A reader of Blender's lines: which frame it is on, as a share of the frames asked for. */
export function blenderReader(plan: ReturnType<typeof blenderFrames>): (line: string) => Reading | null {
  let done = 0;
  const index = (n: number) => (plan?.list ? plan.list.indexOf(n) : plan ? Math.floor((n - plan.first) / plan.step) : -1);
  return (raw) => {
    const line = plain(raw);
    const at = /\bFra:\s*(\d+)/.exec(line) ?? /\bRendering frame (\d+)/.exec(line);
    const written = /\b(?:Video )?[Aa]ppend frame (\d+)/.exec(line);
    const m = written ?? at;
    if (!m) return null;
    if (!plan) return { stage: 'rendering', pct: null };
    const i = index(Number(m[1]));
    if (i < 0) return null;
    // a frame that is on its way: those before it are done; one written: it is done too
    done = Math.max(done, Math.min(plan.count, i + (written ? 1 : 0)));
    return { stage: 'rendering', pct: ratio(done, plan.count), frames: [done, plan.count] };
  };
}
