// The conversion funnel's first-party counts (the operator's page, web/src/operator/): eight steps, each counted once
// per workspace, the first time it happens, with the UTC day and the plan when it is known — never an account, a name,
// an address, an IP, a device, a video or anything a visitor typed. The conversion moments (a card shown, used, put
// away, room made instead) are counted per ISO week (Monday, UTC) by moment and place, never by who.
//
//   data/funnel.json  {v, workspaces: {<id>: {steps: {<step>: {day, plan?}}}}, moments: {<monday>: {"id|where|e": n}},
//                     rolled: {<monday>: {signups, reached: {<step>: n}}}}                                     (0600)
//
// One file for the whole server (the operator's), next to workspaces.json — never a workspace's own folder. Counted only
// where a billing module runs on a hosted server (`countWhen`, set by the app): a self-hosted Lampo counts nothing.
// Step records are kept 13 months from the sign-up; after that only their sign-up week's counts remain (`rolled`). A
// file that can't be read is never taken for an empty one: writes are refused (logged once) and the report says so.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.ts';
import { withLock, writeAtomic } from './store.ts';
import type { FunnelReport, FunnelStep, MomentEvent, MomentId } from './types.ts';

export const FUNNEL_FILE = path.join(DATA, 'funnel.json');
const LOCK_DIR = path.join(DATA, '.funnel');

/** The steps, in the order a workspace goes through them. */
export const FUNNEL_STEPS: readonly FunnelStep[] = [
  'signup',
  'setup_done',
  'video_first',
  'link_first',
  'link_opened_first',
  'fix_checked_first',
  'trial_end',
  'plan_paid',
];
/** Steps a sign-up week can only have reached once its trials have ended. */
const AFTER_TRIAL = new Set<FunnelStep>(['trial_end', 'plan_paid']);
export const MOMENT_IDS: readonly MomentId[] = ['trial_popover', 'loop', 'link_open', 'invite_beyond', 'banner', 'limit_sheet'];
export const MOMENT_EVENTS: readonly MomentEvent[] = ['shown', 'used', 'dismissed', 'made_room'];
/** A trial's length: a sign-up week is read in full once its last sign-up's trial has ended. */
export const TRIAL_DAYS = 14;
/** Step records are kept this long after the sign-up (13 months), then only as their week's counts. */
export const KEEP_DAYS = 396;
const DAY = 86_400_000;
/** A workspace id as lib/workspaces.ts makes them. */
const WORKSPACE = /^(w1|w_[a-z0-9]{12})$/;
/** A plan id as a module names it. */
const PLAN = /^[a-z0-9_-]{1,32}$/;

interface StepRecord {
  /** The UTC day it first happened. */
  day: string;
  /** The workspace's plan then, when known. */
  plan?: string;
}
interface FunnelFile {
  v: 1;
  workspaces: Record<string, { steps: Partial<Record<FunnelStep, StepRecord>> }>;
  /** Monday (UTC) → `id|where|event` → count. */
  moments: Record<string, Record<string, number>>;
  /** Sign-up weeks past KEEP_DAYS: counts only. */
  rolled: Record<string, { signups: number; reached: Partial<Record<FunnelStep, number>> }>;
}

/** The funnel file exists but can't be read: nothing is written over it, and the report can't be made. */
export class FunnelUnreadableError extends Error {
  status = 503;
  publicText = 'the counts can’t be read right now: try again later';
}

let counts: () => boolean = () => false;
/** Whether this server counts (a hosted server with a billing module); the app sets it, everything else asks it. */
export const countWhen = (fn: () => boolean): void => {
  counts = fn;
};
export const counting = (): boolean => {
  try {
    return counts();
  } catch {
    return false;
  }
};

export const utcDay = (t: number | Date = Date.now()): string => new Date(t).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number): string => utcDay(dayMs(day) + n * DAY);
/** The Monday (UTC) of the week a day is in. */
export const mondayOf = (day: string): string => addDays(day, -((new Date(dayMs(day)).getUTCDay() + 6) % 7));

const empty = (): FunnelFile => ({ v: 1, workspaces: {}, moments: {}, rolled: {} });

/** The file as it is: empty when there is none yet; throws FunnelUnreadableError when it can't be read. */
function load(): FunnelFile {
  let raw: string;
  try {
    raw = fs.readFileSync(FUNNEL_FILE, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw new FunnelUnreadableError((e as Error).message);
  }
  try {
    const f = JSON.parse(raw) as Partial<FunnelFile>;
    if (!f || typeof f !== 'object' || !f.workspaces || typeof f.workspaces !== 'object') throw new Error('not a funnel file');
    return { v: 1, workspaces: f.workspaces, moments: f.moments ?? {}, rolled: f.rolled ?? {} };
  } catch (e) {
    throw new FunnelUnreadableError((e as Error).message);
  }
}

/** The earliest day a workspace has a step on. */
const firstDay = (steps: Partial<Record<FunnelStep, StepRecord>>): string | null =>
  Object.values(steps).reduce<string | null>((a, s) => (s && (!a || s.day < a) ? s.day : a), null);

/** Steps past keeping: rolled into their sign-up week's counts (a workspace that never signed up here just goes). */
function prune(f: FunnelFile, today: string): void {
  const cut = addDays(today, -KEEP_DAYS);
  for (const [ws, w] of Object.entries(f.workspaces)) {
    const first = w.steps.signup?.day ?? firstDay(w.steps);
    if (!first || first >= cut) continue;
    if (w.steps.signup) {
      const week = mondayOf(w.steps.signup.day);
      const r = f.rolled[week] ?? { signups: 0, reached: {} };
      f.rolled[week] = r;
      r.signups += 1;
      for (const step of FUNNEL_STEPS) if (step !== 'signup' && w.steps[step]) r.reached[step] = (r.reached[step] ?? 0) + 1;
    }
    delete f.workspaces[ws];
  }
}

let warned = false;
/** Changes the file under its lock; false when nothing changed or the file can't be read (logged once). */
function change(fn: (f: FunnelFile) => boolean, today: string): boolean {
  try {
    return withLock(LOCK_DIR, () => {
      const f = load();
      if (!fn(f)) return false;
      prune(f, today);
      fs.mkdirSync(DATA, { recursive: true });
      writeAtomic(FUNNEL_FILE, `${JSON.stringify(f)}\n`);
      fs.chmodSync(FUNNEL_FILE, 0o600);
      return true;
    });
  } catch (e) {
    if (!warned) console.error(`funnel: not counted (${(e as Error).message})`);
    warned = true;
    return false;
  }
}

// What is recorded already, so the requests that could be a first time (every upload, every check) don't read the file.
// Keyed by workspace id and step: a few entries per workspace, never more than the steps.
const known = new Set<string>();

/**
 * Records a step for a workspace the first time it happens; true when this was the first time. Nothing when this
 * server doesn't count, or when the step was recorded before.
 */
export function recordStep(workspace: string, step: FunnelStep, { plan, at = Date.now() }: { plan?: string; at?: number } = {}): boolean {
  if (!counting() || !FUNNEL_STEPS.includes(step) || !WORKSPACE.test(workspace)) return false;
  const key = `${workspace}|${step}`;
  if (known.has(key)) return false;
  const today = utcDay(at);
  let read = false;
  let had = false;
  const wrote = change((f) => {
    read = true;
    const w = f.workspaces[workspace] ?? { steps: {} };
    f.workspaces[workspace] = w;
    had = !!w.steps[step];
    if (had) return false;
    w.steps[step] = { day: today, ...(plan && PLAN.test(plan) ? { plan } : {}) };
    return true;
  }, today);
  // remembered once it is on disk (or was there already); a file that couldn't be read is asked again next time
  if (wrote || (read && had)) known.add(key);
  return wrote;
}

/** Notes the plan on a step recorded without one (it was learnt a moment later). */
export function notePlan(workspace: string, step: FunnelStep, plan: unknown): void {
  if (!counting() || typeof plan !== 'string' || !PLAN.test(plan)) return;
  change((f) => {
    const s = f.workspaces[workspace]?.steps[step];
    if (!s || s.plan) return false;
    s.plan = plan;
    return true;
  }, utcDay());
}

/** Counts what a conversion moment did, in this week (UTC), by moment and place: never who. */
export function recordMoment(e: MomentEvent, id: MomentId, where: string | undefined, at = Date.now()): boolean {
  if (!counting() || !MOMENT_EVENTS.includes(e) || !MOMENT_IDS.includes(id) || (where !== undefined && !/^[a-z0-9_-]{1,24}$/.test(where))) return false;
  const today = utcDay(at);
  const week = mondayOf(today);
  return change((f) => {
    const w = f.moments[week] ?? {};
    f.moments[week] = w;
    const k = `${id}|${where ?? ''}|${e}`;
    w[k] = (w[k] ?? 0) + 1;
    return true;
  }, today);
}

/** Tests: forget what this process knows is recorded (the file was replaced under it). */
export const forgetKnown = (): void => known.clear();

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * The operator's page: the `weeks` sign-up weeks up to this one, oldest first, each with its sign-ups and how many of
 * them reached each step (the steps after the trial only once the week's trials have ended); the mature weeks together
 * with the median days from sign-up; and what the conversion moments did in those weeks. Throws FunnelUnreadableError.
 */
export function funnelReport(weeks: number, now = Date.now()): FunnelReport {
  const f = load();
  const today = utcDay(now);
  const last = mondayOf(today);
  const list = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  const byWeek = new Map<string, Partial<Record<FunnelStep, StepRecord>>[]>(list.map((w) => [w, []]));
  for (const w of Object.values(f.workspaces)) {
    const s = w.steps.signup;
    if (s) byWeek.get(mondayOf(s.day))?.push(w.steps);
  }
  // a week is read in full once the trial of its last sign-up (its Sunday's) has ended
  const matureWeek = (week: string) => addDays(week, 6 + TRIAL_DAYS) < today;
  const cohorts: FunnelReport['cohorts'] = list.map((week) => {
    const ws = byWeek.get(week) ?? [];
    const mature = matureWeek(week);
    const reached = Object.fromEntries(
      FUNNEL_STEPS.map((step) => [step, AFTER_TRIAL.has(step) && !mature ? null : ws.filter((x) => !!x[step]).length]),
    ) as Record<FunnelStep, number | null>;
    return { week, signups: ws.length, mature, reached };
  });
  const matureSteps = list.filter(matureWeek).flatMap((w) => byWeek.get(w) ?? []);
  const steps: FunnelReport['steps'] = FUNNEL_STEPS.map((step) => {
    const hit = matureSteps.filter((x) => !!x[step]);
    const days = step === 'signup' ? [] : hit.map((x) => (dayMs((x[step] as StepRecord).day) - dayMs((x.signup as StepRecord).day)) / DAY);
    return { step, count: hit.length, medianDays: step === 'signup' ? null : median(days) };
  });
  const tally = new Map<string, FunnelReport['moments'][number]>();
  for (const week of list)
    for (const [k, n] of Object.entries(f.moments[week] ?? {})) {
      const [id, where, e] = k.split('|') as [MomentId, string, MomentEvent];
      if (!MOMENT_IDS.includes(id) || !MOMENT_EVENTS.includes(e) || !Number.isFinite(n)) continue;
      const key = `${id}|${where}`;
      const row = tally.get(key) ?? { id, ...(where ? { where } : {}), shown: 0, used: 0, dismissed: 0, made_room: 0 };
      row[e] += n;
      tally.set(key, row);
    }
  const counted = Object.values(f.workspaces).some((w) => !!w.steps.signup) || Object.keys(f.rolled).length > 0;
  return { counting: counted, weeks, from: list[0] as string, to: today, cohorts, steps, moments: [...tally.values()] };
}
