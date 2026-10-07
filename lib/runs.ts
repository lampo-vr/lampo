// Runs: one stretch of an agent's work on one video (lib/types.ts Run), opened by something a person did (Send, Ask,
// Nudge, Answer, Try again) or by the agent's own write, and ended by handing something back. Its plan is the
// person's notes, its result a version. This module is the store and the rules; server/runs.ts decides when they apply
// (what people and agents do, the clock) and tells the app.
//
// Kept per video in data/<slug>/runs.jsonl: one line per run (its head, its kept steps and a small clock), rewritten
// under the video's lock, atomically. A question on a folder before V1 has no video folder yet: its runs live in the
// workspace's data/runs.jsonl (like the questions themselves in data/asks.json — folders are renamed, and those runs are
// few). Lines this version can't read are kept as they are. The server holds the files it works with in memory and
// writes them out soon after a change; every other process (`vr`, the stdio MCP server) only reads them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_ID } from './activity.ts';
import { words } from './activityText.ts';
import { agentKindOf } from './agentKind.ts';
import { cleanAgentName, cutChars } from './names.ts';
import { dataDir, isoLocal, reviewDir, reviewFile } from './paths.ts';
import { RENDER_STAGES, RENDER_TOOLS } from './render/tools.ts';
import { currentWorkspace, wsKey } from './scope.ts';
import { listSlugs, setVersionRunProvider, withLock, writeAtomic } from './store.ts';
import { compareTime, oneLine } from './time.ts';
import type {
  ActivityWords,
  AgentActivityKind,
  AgentKind,
  Run,
  RunBrief,
  RunDelivery,
  RunPhase,
  RunPlanItem,
  RunProgress,
  RunResult,
  RunState,
  RunStepLine,
  RunStepType,
} from './types.ts';

/** How much is kept. */
export const RUN_LIMITS = {
  /** Steps per run (progress keeps only the first and last line of a stretch). */
  steps: 200,
  /** Runs per video: the oldest ended ones go first. */
  runs: 1000,
  /** Runs on folders, per workspace. */
  folderRuns: 200,
  /** An ended run keeps its steps this long, then only its head. */
  stepDays: 90,
  /** The person's words that opened it. */
  requestChars: 500,
};

/** The clock of a run (tests lower these). */
export const RUN_TIMES = {
  /** No sign for this long: lost, for a run Lampo started and reads (this machine, a runner). */
  lostStarted: 5 * 60_000,
  /** … for an agent Lampo hears only through its calls. */
  lostCalls: 20 * 60_000,
  /** … and this much longer while a render reports. */
  lostRender: 10 * 60_000,
  /** Lost this long: closed as stopped, without blame. */
  closeLost: 60 * 60_000,
  /** A run Lampo started is stopped after this long without a sign … */
  silence: 30 * 60_000,
  /** … and after this long in all. */
  cap: 3 * 3600_000,
  /** The library shows an ended run this long. */
  brief: 24 * 3600_000,
  /** An activity that names a run which ended this recently still joins it (its last lines arrive late). */
  late: 2 * 60_000,
};

// A run's id: `run_` and 12 hex digits (lib/activity.ts holds the one pattern: `vr` checks LAMPO_RUN by it).
export { RUN_ID };
export const newRunId = (): string => `run_${crypto.randomBytes(6).toString('hex')}`;

/** What only the server keeps of a run (never in the API): the clock it counts by. */
export interface RunClock {
  /** worked_s is counted up to here. */
  tick?: string;
  /** When it went lost. */
  lost?: string;
  /** When it first began working (its `started` event). */
  began?: string;
  /** Notes added while it worked, told to the agent up to here (the new-notes line). */
  told?: string;
  /** The agent's questions during the run, by note id. */
  qs?: string[];
  /** Questions asked without an id Lampo heard. */
  asked?: number;
  /** The process this machine started for it, when its id isn't the run's. */
  proc?: string;
}

/** A run as kept: its head, its steps (oldest first) and its clock. */
export interface StoredRun extends Run {
  steps: RunStepLine[];
  clock: RunClock;
}

const at = (ms: number): string => isoLocal(new Date(ms));
const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Today's activity kinds as the run's step types (Linear's five, plus progress). */
export function stepTypeOf(kind: AgentActivityKind): RunStepType {
  switch (kind) {
    case 'ask':
      return 'elicitation';
    case 'upload':
    case 'render':
      return 'progress';
    case 'status':
    case 'say':
      return 'thought';
    case 'error':
      return 'error';
    default:
      return 'action';
  }
}

const PROGRESS_WHAT = new Set<RunProgress['what']>(['render', 'upload', 'check']);
const PROGRESS_STAGES = new Set<string>(RENDER_STAGES);
const PROGRESS_TOOLS = new Set<string>(RENDER_TOOLS);
/** The longest time left a progress line may claim (a week). */
export const PROGRESS_ETA_MAX = 7 * 24 * 3600;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const frameCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1e8;

/**
 * A render's or upload's progress as a caller sent it (`vr render`, an upload), bounded: a known `what`, a stage and a
 * tool from `vr render`'s lists (lib/render/tools.ts), the percent clamped to 0–100, whole frames (done ≤ total), the
 * time left at most a week, a whole version number. Anything else in it is dropped; no known stage, no progress at all.
 * One rule for every way in: the activity file, the hosted batches (whose schema says the same), what runs keep.
 */
export function cleanProgress(p: unknown): RunProgress | undefined {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const x = p as Record<string, unknown>;
  if (!PROGRESS_WHAT.has(x.what as RunProgress['what']) || typeof x.stage !== 'string' || !PROGRESS_STAGES.has(x.stage)) return undefined;
  const out: RunProgress = { what: x.what as RunProgress['what'], stage: x.stage, pct: finite(x.pct) ? Math.max(0, Math.min(100, Math.round(x.pct))) : null };
  const f = Array.isArray(x.frames) && x.frames.length === 2 && frameCount(x.frames[0]) && frameCount(x.frames[1]) && x.frames[1] >= 1 ? x.frames : null;
  if (f) out.frames = [Math.min(f[0], f[1]), f[1]];
  if (finite(x.eta_s) && x.eta_s >= 0) out.eta_s = Math.min(Math.round(x.eta_s), PROGRESS_ETA_MAX);
  if (typeof x.tool === 'string' && PROGRESS_TOOLS.has(x.tool)) out.tool = x.tool;
  if (typeof x.v === 'number' && Number.isInteger(x.v) && x.v >= 1 && x.v <= 1e6) out.v = x.v;
  return out;
}

/** A plan item the agent answered: fixed, asked the person about, left as it is, or replied to. */
const ANSWERED = new Set<RunPlanItem['state']>(['fixed', 'asked', 'wontfix', 'replied']);
export const isAnswered = (p: RunPlanItem): boolean => ANSWERED.has(p.state);
const allAnswered = (r: Run): boolean => r.plan.every(isAnswered);

/** An agent's name without whose it is (`claude-code · Sam` → `claude-code`): how its writes name it (`agent:claude-code`). */
export const agentBase = (name: string): string => name.replace(/ · [^·]*$/, '').trim();
/** Whose agent it is (`· Sam`), or '' for an agent of this machine. */
const ownerOf = (name: string): string => / · ([^·]*)$/.exec(name)?.[1]?.trim() ?? '';
/** Whether a write's author (`agent:x`) or an activity's name is the run's agent. */
export function sameAgent(runAgent: string, other: string): boolean {
  const o = cleanAgentName(other.replace(/^agent:/, ''));
  if (!o) return false;
  if (o === runAgent) return true;
  return agentBase(o) === agentBase(runAgent) && (!ownerOf(o) || !ownerOf(runAgent) || ownerOf(o) === ownerOf(runAgent));
}

// ---------------------------------------------------------------- the files

export const runsFile = (slug: string | null): string => (slug === null ? path.join(dataDir(), 'runs.jsonl') : path.join(reviewDir(slug), 'runs.jsonl'));
const lockOf = (slug: string | null): string => (slug === null ? path.join(dataDir(), '.runs') : reviewDir(slug));

interface Held {
  ws: string;
  slug: string | null;
  /** The file as last read or written (inode, size, mtime). */
  stat: string;
  runs: StoredRun[];
  /** Lines this version can't read: written back as they are. */
  raw: string[];
  /** Changed in memory, not written yet (the server only). */
  dirty: boolean;
  used: number;
}

/** By workspace and video ('' = the workspace's folder runs). Bounded; never forgets a change it hasn't written. */
const held = new Map<string, Held>();
const HELD_MAX = 2000;
/** Where each run is (by workspace and id): its video, or '' for a folder's. */
const where = new Map<string, string>();
const WHERE_MAX = 100_000;
/** Videos with a run that hasn't ended: what the server's clock looks at. */
const open = new Map<string, { ws: string; slug: string | null }>();
/** Workspaces whose every video's runs were looked through once (a run asked for by id that isn't in memory). */
const scanned = new Set<string>();

function statOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

const isStored = (x: unknown): x is StoredRun => {
  const r = x as Partial<StoredRun> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    RUN_ID.test(r.id) &&
    typeof r.state === 'string' &&
    typeof r.started === 'string' &&
    Array.isArray(r.plan) &&
    !!r.agent &&
    typeof r.agent.name === 'string'
  );
};

function parse(text: string): { runs: StoredRun[]; raw: string[] } {
  const runs: StoredRun[] = [];
  const raw: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let x: unknown;
    try {
      x = JSON.parse(line);
    } catch {
      raw.push(line);
      continue;
    }
    if (!isStored(x)) {
      raw.push(line);
      continue;
    }
    runs.push({ ...x, steps: Array.isArray(x.steps) ? x.steps : [], clock: x.clock && typeof x.clock === 'object' ? x.clock : {} });
  }
  return { runs, raw };
}

function index(key: string, h: Held): void {
  for (const r of h.runs) {
    if (where.size >= WHERE_MAX) where.delete(where.keys().next().value as string);
    where.set(wsKey(r.id), h.slug ?? '');
  }
  if (h.runs.some((r) => r.ended === null)) open.set(key, { ws: h.ws, slug: h.slug });
  else open.delete(key);
}

function hold(slug: string | null): Held {
  const key = wsKey(slug ?? '');
  const h = held.get(key);
  if (h?.dirty) {
    h.used = Date.now();
    return h;
  }
  const file = runsFile(slug);
  const stat = statOf(file);
  if (h && h.stat === stat) {
    h.used = Date.now();
    return h;
  }
  let text = '';
  if (stat !== 'none')
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {}
  const fresh: Held = { ws: currentWorkspace(), slug, stat, ...parse(text), dirty: false, used: Date.now() };
  if (!h && held.size >= HELD_MAX) {
    let oldest: string | null = null;
    let when = Number.POSITIVE_INFINITY;
    for (const [k, x] of held)
      if (!x.dirty && x.used < when) {
        when = x.used;
        oldest = k;
      }
    if (oldest !== null) held.delete(oldest);
  }
  held.set(key, fresh);
  index(key, fresh);
  return fresh;
}

/** A video's runs (null: the workspace's folder runs), oldest first. Shared: change them only through `changeRuns`. */
export function readRuns(slug: string | null): readonly StoredRun[] {
  return hold(slug).runs;
}

/** Changes a video's runs in memory; the server writes them out (`flushRuns`). Returns what `fn` returns. */
export function changeRuns<T>(slug: string | null, fn: (runs: StoredRun[]) => T): T {
  const h = hold(slug);
  const out = fn(h.runs);
  h.dirty = true;
  index(wsKey(slug ?? ''), h);
  return out;
}

/** Whether a video's runs wait to be written. */
export const isDirty = (slug: string | null): boolean => !!held.get(wsKey(slug ?? ''))?.dirty;

/**
 * Writes a video's runs if they changed: compacted, under the video's lock, atomically. A video that is gone (removed)
 * takes its runs with it: false, and they are forgotten.
 */
export function flushRuns(slug: string | null, now = Date.now()): boolean {
  const key = wsKey(slug ?? '');
  const h = held.get(key);
  if (!h?.dirty) return true;
  if (slug !== null && !fs.existsSync(reviewFile(slug))) {
    held.delete(key);
    open.delete(key);
    return false;
  }
  for (const r of h.runs) compact(r, now);
  trimRuns(h.runs, slug === null ? RUN_LIMITS.folderRuns : RUN_LIMITS.runs);
  const lines = [...h.raw, ...h.runs.map((r) => JSON.stringify(r))];
  const file = runsFile(slug);
  withLock(lockOf(slug), () => writeAtomic(file, lines.length ? `${lines.join('\n')}\n` : ''));
  h.stat = statOf(file);
  h.dirty = false;
  index(key, h);
  return true;
}

/** Every place (workspace, video) with runs that haven't ended, or that wait to be written. */
export function openPlaces(): { ws: string; slug: string | null }[] {
  const out = new Map(open);
  for (const [k, h] of held) if (h.dirty) out.set(k, { ws: h.ws, slug: h.slug });
  return [...out.values()];
}

/** A run by its id in this workspace, wherever it is kept (the first miss looks through every video once). */
export function findRun(id: string): { slug: string | null; run: StoredRun } | null {
  if (!RUN_ID.test(id)) return null;
  const look = (slug: string | null) => {
    const run = hold(slug).runs.find((r) => r.id === id);
    return run ? { slug, run } : null;
  };
  const known = where.get(wsKey(id));
  if (known !== undefined) {
    const hit = look(known || null);
    if (hit) return hit;
  }
  const ws = currentWorkspace();
  if (scanned.has(ws)) return null;
  scanned.add(ws);
  for (const slug of [null, ...listSlugs()]) {
    if (slug !== null && statOf(runsFile(slug)) === 'none' && !held.has(wsKey(slug))) continue;
    const hit = look(slug);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- keeping

/**
 * Keeps a step: the same line again moves to its new time; a stretch of progress keeps its first and last line; past
 * the limit the oldest plain step goes (the first one, questions, errors and the hand-back stay).
 */
export function keepStep(r: StoredRun, step: RunStepLine): void {
  const last = r.steps.at(-1);
  if (last && last.text === step.text && last.type === step.type) {
    r.steps[r.steps.length - 1] = step;
    return;
  }
  const before = r.steps.at(-2);
  if (step.type === 'progress' && last?.type === 'progress' && before?.type === 'progress') {
    r.steps[r.steps.length - 1] = step;
    return;
  }
  r.steps.push(step);
  if (r.steps.length > RUN_LIMITS.steps) dropStep(r);
}

const KEPT_TYPES = new Set<RunStepType>(['elicitation', 'error', 'response']);
function dropStep(r: StoredRun): void {
  const i = r.steps.findIndex((s, n) => n > 0 && !KEPT_TYPES.has(s.type));
  r.steps.splice(i > 0 ? i : 1, 1);
}

/** Before a write: at most RUN_LIMITS.steps steps, none for a run that ended more than RUN_LIMITS.stepDays ago. */
export function compact(r: StoredRun, now = Date.now()): void {
  if (r.ended !== null && now - ms(r.ended) > RUN_LIMITS.stepDays * 86_400_000) {
    r.steps = [];
    return;
  }
  while (r.steps.length > RUN_LIMITS.steps) dropStep(r);
}

/** At most `max` runs: the oldest that ended go first (one that is still going is never dropped). */
function trimRuns(runs: StoredRun[], max: number): void {
  while (runs.length > max) {
    const i = runs.findIndex((r) => r.ended !== null);
    if (i < 0) return;
    runs.splice(i, 1);
  }
}

// ---------------------------------------------------------------- the rules

/** Counting states: worked_s grows while the agent is at it (never while it waits for the person). */
const COUNTED = new Set<RunState>(['starting', 'working', 'lost']);

/** Adds the time since the last count, up to `until`. */
function count(r: StoredRun, until: number): void {
  const from = ms(r.clock.tick) || ms(r.started);
  if (COUNTED.has(r.state) && until > from) {
    const s = Math.floor((until - from) / 1000);
    r.worked_s += s;
    r.clock.tick = at(from + s * 1000);
  } else if (until > from) r.clock.tick = at(until);
}

/** worked_s as of `now`: a lost run counts up to its last sign. */
export function workedAt(r: Run & { clock?: RunClock }, now = Date.now()): number {
  if (r.ended !== null || !COUNTED.has(r.state)) return r.worked_s;
  const from = ms(r.clock?.tick) || ms(r.started);
  const until = r.state === 'lost' ? ms(r.seen) : now;
  return r.worked_s + Math.max(0, Math.floor((until - from) / 1000));
}

function setState(r: StoredRun, to: RunState, now: number): void {
  if (r.state === to) return;
  count(r, now);
  r.state = to;
  r.clock.tick = at(now);
}

/** What the run handed back so far: the version, and the plan's counts. */
function resultOf(r: StoredRun): RunResult {
  const n = (s: RunPlanItem['state']) => r.plan.filter((p) => p.state === s).length;
  const asked = Math.max(n('asked'), (r.clock.qs?.length ?? 0) + (r.clock.asked ?? 0));
  return { ...(r.result ?? {}), fixed: n('fixed'), asked, wontfix: n('wontfix') };
}
function refreshResult(r: StoredRun): void {
  const res = resultOf(r);
  if (r.result || res.fixed || res.asked || res.wontfix || r.ended !== null) r.result = res;
}

/** Ends a run (first match of the done rule, a failure, a stop): worked time up to its end, progress gone. */
export function endRun(r: StoredRun, state: Extract<RunState, 'done' | 'failed' | 'stopped' | 'needs_you'>, now: number, error?: ActivityWords): void {
  if (r.ended !== null) return;
  // a lost run worked up to its last sign
  count(r, r.state === 'lost' ? Math.max(ms(r.seen), ms(r.clock.tick)) : now);
  r.state = state;
  r.ended = at(now);
  r.progress = null;
  delete r.clock.lost;
  if (state !== 'needs_you') delete r.needs;
  if (error) r.error = error;
  refreshResult(r);
}

/** How long without a sign before a run reads as lost. */
export function lostAfter(r: Run): number {
  const base = r.delivery === 'machine' || r.delivery === 'runner' ? RUN_TIMES.lostStarted : RUN_TIMES.lostCalls;
  return base + (r.progress?.what === 'render' ? RUN_TIMES.lostRender : 0);
}

/**
 * What time alone does to a run: no sign for a while → lost; lost for an hour → closed as stopped, without blame. A run
 * that waits for the person (needs you) or for its agent to begin (queued) waits; its process (a run Lampo started)
 * has its own clock. Returns the phase to tell, if any.
 */
export function settle(r: StoredRun, now = Date.now()): 'lost' | 'ended' | null {
  if (r.ended !== null) return null;
  let became: 'lost' | null = null;
  if (r.state === 'working' || r.state === 'starting') {
    const since = ms(r.seen) + lostAfter(r);
    if (now < since) return null;
    count(r, ms(r.seen));
    r.state = 'lost';
    r.clock.tick = r.seen;
    r.clock.lost = at(since);
    became = 'lost';
  }
  if (r.state === 'lost' && now - ms(r.clock.lost) >= RUN_TIMES.closeLost) {
    endRun(r, 'stopped', ms(r.clock.lost) + RUN_TIMES.closeLost);
    return 'ended';
  }
  return became;
}

/** Whether time alone would move a run now (`settle`): it went quiet, or has been lost an hour. */
export function due(r: Run & { clock?: RunClock }, now = Date.now()): boolean {
  if (r.ended !== null) return false;
  if (r.state === 'working' || r.state === 'starting') return now >= ms(r.seen) + lostAfter(r);
  return r.state === 'lost' && now - ms(r.clock?.lost) >= RUN_TIMES.closeLost;
}

/** A sign of life that names no video of this run: seen, and a lost run revives. True when its state changed. */
export function alive(r: StoredRun, now: number): boolean {
  if (r.ended !== null) return false;
  if (now > ms(r.seen)) r.seen = at(now);
  if (r.state !== 'lost') return false;
  setState(r, 'working', now);
  delete r.clock.lost;
  return true;
}

/** This machine started the agent for the run (server/agentRuns.ts): delivered, starting, its log kept there. */
export function machineBegan(r: StoredRun, proc: string, now: number): void {
  r.delivery = 'machine';
  r.log = true;
  if (proc !== r.id) r.clock.proc = proc;
  else delete r.clock.proc;
  if (now > ms(r.seen)) r.seen = at(now);
  if (r.state === 'queued') setState(r, 'starting', now);
}

export interface OpenRun {
  /** Its id when it must be known before (a process started for it carries it in LAMPO_RUN). */
  id?: string;
  slug: string | null;
  folder?: string;
  agent: Run['agent'];
  opened_by: Run['opened_by'];
  delivery?: RunDelivery;
  notes?: readonly string[];
  request?: string | null;
  follows?: string;
  /** Its first state: queued (a person sent it), working (an agent's own write) or needs you (an agent's question). */
  state?: Extract<RunState, 'queued' | 'starting' | 'working' | 'needs_you'>;
}

/** The person's words that opened a run, as it keeps them: one line, cut. */
export const requestText = (s: string): string => cutChars(oneLine(s).trim(), RUN_LIMITS.requestChars);

export function newRun(o: OpenRun, now = Date.now()): StoredRun {
  const t = at(now);
  const request = o.request ? requestText(o.request) : '';
  const state = o.state ?? 'queued';
  return {
    id: o.id && RUN_ID.test(o.id) ? o.id : newRunId(),
    slug: o.slug,
    ...(o.folder ? { folder: o.folder } : {}),
    agent: o.agent,
    opened_by: o.opened_by,
    delivery: o.delivery ?? 'listening',
    state,
    started: t,
    ended: null,
    seen: t,
    worked_s: 0,
    plan: [...new Set(o.notes ?? [])].map((id) => ({ id, state: 'todo' as const, at: t })),
    now: null,
    ...(request ? { request } : {}),
    ...(o.follows ? { follows: o.follows } : {}),
    steps: [],
    clock: { tick: t, ...(state === 'working' || state === 'needs_you' ? { began: t } : {}) },
  };
}

/** Notes sent to a run that is open: they join its plan ("added while it works" once it has begun). */
export function addNotes(r: StoredRun, ids: readonly string[], now = Date.now()): string[] {
  const added: string[] = [];
  for (const id of ids) {
    if (r.plan.some((p) => p.id === id)) continue;
    r.plan.push({ id, state: 'todo', at: at(now), ...(r.state !== 'queued' ? { added: true } : {}) });
    added.push(id);
  }
  return added;
}

/** One sign of the agent, as the server resolved it. */
export interface Sign {
  at: number;
  kind: AgentActivityKind;
  words: ActivityWords;
  /** A note id (or a version) it was about. */
  target?: string | null;
  progress?: RunProgress | null;
  /** A wait that handed the run's work over (a batch, what waited for it). */
  handed?: boolean;
  /** Plan notes at the frame it looked at (get_frame). */
  atFrame?: readonly string[];
  /** A sign only: no step, no `now` (a wait handing the run over says nothing new to read). */
  quiet?: boolean;
  /** What a question it asked is about, when the video says (the note it made). */
  needs?: Run['needs'];
}

const plainKey = (w: ActivityWords) => w.key ?? '';

/** The agent asked the person something: the run needs them, and the note in hand (if any) is asked about. */
export function askedPerson(r: StoredRun, now: number, needs?: Run['needs']): RunPhase | null {
  const was = r.state;
  if (needs?.note) {
    if (!r.clock.qs) r.clock.qs = [];
    const qs = r.clock.qs;
    if (!qs.includes(needs.note)) {
      qs.push(needs.note);
      // the same question heard first without its id (its activity, then its event): counted once
      if (r.clock.asked) r.clock.asked--;
    }
  } else if (!r.needs || was !== 'needs_you') r.clock.asked = (r.clock.asked ?? 0) + 1;
  const doing = r.plan.filter((p) => p.state === 'doing').sort((a, b) => compareTime(b.at ?? '', a.at ?? ''))[0];
  if (doing) {
    doing.state = 'asked';
    doing.at = at(now);
  }
  r.needs = needs ? { ...(r.needs ?? {}), ...needs } : (r.needs ?? { kind: 'question' });
  if (was !== 'needs_you') setState(r, 'needs_you', now);
  refreshResult(r);
  return was !== 'needs_you' ? 'needs_you' : null;
}

/** A plan note's status as it now is (by anyone on the editor's side, through any way in). */
export function noteMoved(r: StoredRun, id: string, to: RunPlanItem['state'], now: number): boolean {
  const p = r.plan.find((x) => x.id === id);
  if (!p || p.state === to) return false;
  // reading a note never takes back what was done to it
  if (to === 'doing' && p.state !== 'todo') return false;
  p.state = to;
  p.at = at(now);
  if (to === 'fixed' && r.result?.v) p.v = r.result.v;
  if (to === 'todo') delete p.v;
  refreshResult(r);
  return true;
}

/**
 * One sign of the agent: it is seen; queued, starting or lost become working (a wait that hands nothing over leaves a
 * queued run queued); its words become `now` and a step; the plan moves; a question needs the person, an error fails
 * the run; and a wait after handing back ends it. Returns the phases to tell.
 */
export function applySign(r: StoredRun, s: Sign): RunPhase[] {
  const out: RunPhase[] = [];
  if (r.ended !== null) return out;
  const now = s.at;
  if (now > ms(r.seen)) r.seen = at(now);
  const type = stepTypeOf(s.kind);
  const bare = s.kind === 'wait' && !s.handed;
  if ((r.state === 'queued' && !bare) || r.state === 'starting' || r.state === 'lost') {
    setState(r, 'working', now);
    delete r.clock.lost;
    if (!r.clock.began) {
      r.clock.began = at(now);
      out.push('started');
    }
  }
  if (s.progress !== undefined) r.progress = s.progress;
  // "Thinking" says nothing the person can read: a sign, never a step.
  if (!s.quiet && plainKey(s.words) !== 'Thinking') {
    const line: RunStepLine = { ...s.words, at: at(now), type, ...(s.target ? { target: s.target } : {}) };
    keepStep(r, line);
    r.now = { ...s.words, type, at: line.at };
  }
  const key = plainKey(s.words);
  const id = s.target && /^c_[0-9a-f]+$/i.test(s.target) ? s.target : null;
  if (id) {
    if (key.startsWith('Fixed ')) noteMoved(r, id, 'fixed', now);
    else if (key.startsWith('Left ')) noteMoved(r, id, 'wontfix', now);
    else if (key.startsWith('Replied ')) noteMoved(r, id, 'replied', now);
    else if (s.kind === 'read' || key.startsWith('Attached a fix preview')) noteMoved(r, id, 'doing', now);
  }
  for (const n of s.atFrame ?? []) noteMoved(r, n, 'doing', now);
  if (type === 'elicitation') {
    const phase = askedPerson(r, now, s.needs);
    if (phase) out.push(phase);
  } else if (type === 'error') {
    endRun(r, 'failed', now, s.words);
    out.push('ended');
    return out;
  }
  // The done rule, 2: it waits again after handing back (a version, or every plan note answered).
  if (bare && !handsOwnEnd(r) && handedBack(r)) {
    endRun(r, r.state === 'needs_you' ? 'needs_you' : 'done', now);
    out.push('ended');
    return out;
  }
  if (checkDone(r, now)) out.push('ended');
  return out;
}

/** A run whose end Lampo sees itself (its process exits): the done rule's first part, never a guess. */
const handsOwnEnd = (r: Run) => r.delivery === 'machine' || r.delivery === 'runner';
const handedBack = (r: Run) => !!r.result?.v || (r.plan.length > 0 && allAnswered(r));

/**
 * The done rule, 4 — for agents Lampo can't see end: every plan note answered and a version arrived since the run
 * opened. A question still open ends it as needing you. True when it ended.
 */
export function checkDone(r: StoredRun, now: number): boolean {
  if (r.ended !== null || handsOwnEnd(r) || r.state === 'queued') return false;
  if (!r.result?.v || !allAnswered(r)) return false;
  endRun(r, r.state === 'needs_you' ? 'needs_you' : 'done', now);
  return true;
}

/** A version arrived from the run: its result, its fixes landed in it; progress done. */
export function versionLanded(r: StoredRun, v: number, now: number): RunPhase[] {
  r.result = { ...resultOf(r), v };
  r.progress = null;
  for (const p of r.plan) if (p.state === 'fixed' && !p.v) p.v = v;
  return r.ended === null && checkDone(r, now) ? ['ended'] : [];
}

/** The person answered: a run that needed them works again (unless another question of it is still open). */
export function answered(r: StoredRun, now: number, still?: string | null): boolean {
  if (r.ended !== null || r.state !== 'needs_you') return false;
  if (still) {
    r.needs = { kind: r.needs?.kind ?? 'question', note: still };
    return false;
  }
  delete r.needs;
  setState(r, 'working', now);
  // its time waiting for the person isn't the agent's, nor does the clock of "lost" count it
  r.seen = at(Math.max(now, ms(r.seen)));
  return true;
}

/** How a run Lampo started on this machine ended (server/agentRuns.ts), by the done rule's first part. */
export interface Exit {
  /** The process's phase: finished (by itself), stopped, timeout, failed (couldn't start). */
  phase: 'finished' | 'stopped' | 'timeout' | 'failed';
  code: number | null;
  summary?: string | null;
  tokens?: RunResult['tokens'];
  cost_usd?: number | null;
}

export function processEnded(r: StoredRun, e: Exit, now: number): RunPhase[] {
  const more: Partial<RunResult> = {
    ...(e.summary ? { summary: cutChars(oneLine(e.summary).trim(), 300) } : {}),
    ...(e.tokens && (e.tokens.input || e.tokens.output) ? { tokens: e.tokens } : {}),
    ...(e.cost_usd != null ? { cost_usd: e.cost_usd } : {}),
  };
  const merge = () => {
    r.result = { ...resultOf(r), ...more };
  };
  if (r.ended !== null) {
    merge();
    return [];
  }
  if (more.summary) {
    const line: RunStepLine = { text: more.summary, at: at(now), type: 'response' };
    keepStep(r, line);
    r.now = { text: more.summary, type: 'response', at: line.at };
  }
  if (e.phase === 'stopped') endRun(r, 'stopped', now);
  else if (e.phase === 'timeout') endRun(r, 'failed', now, words('Stopped at the time limit'));
  else if (e.phase === 'failed') endRun(r, 'failed', now, words('Couldn’t start'));
  else if (e.code !== 0) endRun(r, 'failed', now, words('Stopped with an error'));
  else endRun(r, r.state === 'needs_you' ? 'needs_you' : 'done', now);
  merge();
  return ['ended'];
}

// ---------------------------------------------------------------- what callers read

/** A run as the API shows it: its head (worked time as of now), without its steps or clock. */
export function shownRun(r: StoredRun, now = Date.now()): Run {
  const { steps: _steps, clock, ...head } = r;
  return { ...head, worked_s: workedAt(r, now) };
}

export function briefOf(r: StoredRun, now = Date.now()): RunBrief {
  const s = shownRun(r, now);
  return {
    id: s.id,
    agent: s.agent,
    state: s.state,
    started: s.started,
    ended: s.ended,
    worked_s: s.worked_s,
    now: s.now,
    ...(s.progress !== undefined ? { progress: s.progress } : {}),
    ...(s.result ? { result: s.result } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.needs ? { needs: s.needs } : {}),
    planned: s.plan.length,
    answered: s.plan.filter(isAnswered).length,
  };
}

/** The run a video's card shows: the open one (the newest), else the last that ended in the past day. */
export function cardRun(runs: readonly StoredRun[], now = Date.now()): StoredRun | null {
  let best: StoredRun | null = null;
  for (const r of runs) {
    if (r.ended === null) {
      if (!best || best.ended !== null || compareTime(r.started, best.started) >= 0) best = r;
    } else if (now - ms(r.ended) <= RUN_TIMES.brief && (!best || (best.ended !== null && compareTime(r.ended, best.ended) >= 0))) best = r;
  }
  return best;
}

/** A video's card line (summary): its run as of now — time's moves seen, not written (the server's clock writes them). */
export function briefFor(slug: string, now = Date.now()): RunBrief | null {
  const r = cardRun(readRuns(slug), now);
  if (!r) return null;
  if (!due(r, now)) return briefOf(r, now);
  const copy = structuredClone(r);
  settle(copy, now);
  return briefOf(copy, now);
}

/** Newest first. `started` has whole seconds: of two opened in the same second the later (kept after it) comes first. */
export const newestFirst = (runs: readonly StoredRun[]): StoredRun[] => [...runs].reverse().sort((a, b) => compareTime(b.started, a.started));

/** An agent's kind and name as a run keeps them. */
export const runAgent = (name: string, kind?: AgentKind | null, sessionId?: string | null): Run['agent'] => ({
  name: cleanAgentName(name) || 'agent',
  kind: kind ?? agentKindOf(name),
  ...(sessionId ? { session_id: sessionId } : {}),
});

/**
 * The line a listening agent's next Lampo answer ends with when notes were added to its run while it worked (§4.6):
 * how many, where, and how to read only them. One line, appended; the video's name is someone's, so oneLine'd.
 */
export function newNotesLine(o: { video: string; timecodes: readonly string[]; since: string }): string {
  const n = o.timecodes.length;
  const tc = o.timecodes.slice(0, 3).join(', ') + (n > 3 ? ', …' : '');
  return oneLine(
    `${n} new note${n === 1 ? '' : 's'} on ${path.basename(o.video)} since you started (${tc}): read ${n === 1 ? 'it' : 'them'} with get_open_notes since "${o.since}".`,
  );
}

/** Notes added to a run that its agent wasn't told of yet: their ids and when the first came. */
export function untold(r: Run & { clock?: RunClock }): { ids: string[]; since: string } | null {
  const after = ms(r.clock?.told);
  const fresh = r.plan.filter((p) => p.added && p.state === 'todo' && ms(p.at) > after);
  if (!fresh.length) return null;
  const first = Math.min(...fresh.map((p) => ms(p.at)));
  return { ids: fresh.map((p) => p.id), since: new Date(Math.floor(first / 1000) * 1000).toISOString() };
}

/**
 * The run a version registered now belongs to (registerVersion, under the video's lock): the open run an agent is at
 * on this video — the one whose agent wrote it when several are, else the one heard from last. A run nobody began
 * (queued) makes no version. Read only: it never writes.
 */
export function versionRunOf(slug: string, by: string): string | undefined {
  try {
    const going = readRuns(slug).filter((r) => r.ended === null && r.state !== 'queued');
    if (!going.length) return undefined;
    const own = going.find((r) => sameAgent(r.agent.name, by));
    return (own ?? [...going].sort((a, b) => compareTime(b.seen, a.seen))[0])?.id;
  } catch {
    return undefined;
  }
}
setVersionRunProvider(versionRunOf);
