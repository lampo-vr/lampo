// Where the tests' temp files go, and that they go away again. A process gets one run root, <tmp>/vr-runs/<pid>-XXXXXX/,
// the first time it asks for a temp dir, and every tmpdir() is made inside it. The root is removed when the process
// exits, however it exits: passed, failed, thrown, process.exit, Ctrl-C, a SIGTERM from the suite runner. So are the
// browsers and servers it started (ownChild), which would otherwise go on without it. A SIGKILL runs no hook: the next
// test process that starts removes a root whose process is gone (sweep), and a server or a Chrome notices by itself
// that its test is gone (./withParent.ts, `pipe` in launch()). LAMPO_KEEP_TMP=1 keeps the root for a look afterwards.
//
// Before this, every test made its dirs straight in <tmp> and nothing removed them, nor the profiles of browsers killed
// before they closed: tens of GB a week on a busy machine. sweep() also removes those, a bounded amount at a time.
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { settings } from '../../lib/env.ts';

/** The machine's temp dir as a real path (a Mac's /var/folders/… is /private/var/folders/…). */
export const TMP = fs.realpathSync(os.tmpdir());
/** Every process's run root is in here: finding the ones whose process is gone reads this short list, not <tmp>. */
export const RUNS = path.join(TMP, 'vr-runs');
/** In a root kept with LAMPO_KEEP_TMP: the sweep leaves it alone for a day after it was kept. */
const KEPT = '.kept';
/** When the sweep last went through <tmp> itself (its mtime). */
const SWEPT = '.swept';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Whether the run root stays when the process exits. */
export const keepTmp = (): boolean => !!settings.LAMPO_KEEP_TMP && settings.LAMPO_KEEP_TMP !== '0';

let root: string | null = null;
/** This process's run root, made on first use. */
export function runRoot(): string {
  if (!root) {
    fs.mkdirSync(RUNS, { recursive: true });
    root = fs.mkdtempSync(path.join(RUNS, `${process.pid}-`));
  }
  return root;
}

/** A fresh temp dir inside this process's run root: removed when the process exits. */
export function tmpdir(prefix = 'vr-test-'): string {
  return fs.mkdtempSync(path.join(runRoot(), prefix));
}

/**
 * Loaded first into a server a test starts (`node ...WITH_PARENT server/index.ts`): it stops when the test process
 * is gone, a SIGKILL'd one too (./withParent.ts).
 */
export const WITH_PARENT = ['--import', `${pathToFileURL(path.join(import.meta.dirname, 'withParent.ts')).href}?parent=${process.pid}`];

const groups = new Set<number>();
/**
 * `child` ends with this process. It was spawned `detached`, so it leads a process group of its own (what it starts
 * goes in that group), and whatever is left of the group when this process exits is stopped: SIGTERM, then SIGKILL.
 * Once the child has exited, what it left in its group is killed and the group forgotten: its id can be another's then.
 */
export function ownChild(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  groups.add(pid);
  child.once('exit', () => {
    groups.delete(pid);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  });
}

/**
 * The groups among `pgids` with a member still running, from one `ps` (all of them when ps can't say). A member that
 * has ended is a zombie until this process reaps it, which it does only after its exit hook: counted as running, the
 * groups this process leads would always take the whole grace.
 */
function running(pgids: number[]): number[] {
  try {
    const live = new Set<number>();
    for (const line of execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000 }).split('\n')) {
      const [pgid, stat] = line.trim().split(/\s+/);
      if (stat && !stat.startsWith('Z')) live.add(Number(pgid));
    }
    return pgids.filter((g) => live.has(g));
  } catch {
    return pgids;
  }
}

/** SIGTERM to each group, up to `graceMs` for them to go, then SIGKILL to what is left; synchronous (an exit hook). */
function endGroups(pgids: number[], graceMs: number): void {
  const signal = (pgid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(-pgid, sig);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  // a Chrome that gets SIGTERM closes itself (a SIGKILL'd Google Chrome leaves its code-sign clone behind)
  let live = pgids.filter((g) => signal(g, 'SIGTERM'));
  const until = Date.now() + graceMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (live.length && Date.now() < until) {
    Atomics.wait(nap, 0, 0, 50);
    live = running(live);
  }
  for (const g of live) signal(g, 'SIGKILL');
}

let ended = false;
/** Stops what this process started and removes its run root (or marks it kept); synchronous, for an `exit` hook. */
function end(): void {
  if (ended) return;
  ended = true;
  try {
    if (groups.size) endGroups([...groups], 2000);
  } catch {}
  if (!root) return;
  try {
    if (keepTmp()) {
      fs.writeFileSync(path.join(root, KEPT), '');
      fs.writeSync(2, `kept ${root} (LAMPO_KEEP_TMP)\n`);
    } else fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}

if (isMainThread) {
  // After every `exit` listener, not as one of them: the code under test has its own, which write into the root as the
  // process ends (lib/shares.ts flushes a link's stats then). An `exit` listener of ours ran before those registered
  // later, and the files they wrote stayed in a root nothing removed until the next start. Node emits `exit` through
  // process.emit, looked up when it exits (signal-exit hooks it the same way).
  const emit = process.emit;
  process.emit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]) {
    const result = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'exit') end();
    return result;
  } as typeof process.emit;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      // Something else here handles it (the suite runner, a test's own handler): it decides how this ends, and the
      // `exit` hook cleans up when it does.
      if (process.listenerCount(sig) > 1) return;
      end();
      // then the end the signal would have had without this handler: the exit status still names it
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

/** Test dirs as mkdtemp named them before the run root: vr-<words>-XXXXXX (a random part with a capital or a digit, so
 * no word like "models" is taken for one). */
const FLAT = /^(vr-[a-z0-9]+(?:-[a-z0-9]+)*-)(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6}$/;
/** …except the app's own work dirs (lib/, server/, mcp/): a Lampo running on this machine makes and removes those. */
export const APP_PREFIXES = new Set([
  'vr-ask-',
  'vr-avatar-',
  'vr-avatar-in-',
  'vr-footage-',
  'vr-footage-sheet-',
  'vr-import-',
  'vr-mcp-preview-',
  'vr-mcp-ref-',
  'vr-playbook-in-',
  'vr-preview-',
  'vr-preview-in-',
  'vr-qa-',
  'vr-ref-',
  'vr-ref-in-',
  'vr-strip-',
]);
/** The profile puppeteer makes for a browser launched without one (what launch() did before). */
const PROFILE = /^puppeteer_dev_chrome_profile-[A-Za-z0-9]{6}$/;

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
/** How long ago `file` changed, or -1 when it isn't there. */
const ageOf = (file: string, now: number): number => {
  try {
    return now - fs.lstatSync(file).mtimeMs;
  } catch {
    return -1;
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** Every running process's command line, or null when ps can't say (then no profile is taken for unused). */
const commandLines = (): string | null => {
  try {
    return execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
};

/**
 * Removes what earlier test processes left in `tmp`, never anything else, at most `max` entries or `budgetMs` per call
 * (a first run on a full disk doesn't stall: the next start goes on); never throws. Every call: the run roots whose
 * process is gone (a kept one a day after it was kept). At most hourly, while nothing is left over: in <tmp> itself,
 * test dirs from before the run root and the profiles puppeteer made, both once a day has passed since they last
 * changed, a profile only when no running process names it.
 */
export function sweep({ tmp = TMP, budgetMs = 2000, max = 2000 }: { tmp?: string; budgetMs?: number; max?: number } = {}): string[] {
  const removed: string[] = [];
  const now = Date.now();
  const room = () => removed.length < max && Date.now() - now < budgetMs;
  const remove = (p: string) => {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
      removed.push(p);
    } catch {}
  };
  const runs = path.join(tmp, path.basename(RUNS));
  for (const name of list(runs)) {
    if (!room()) return removed;
    const pid = Number(/^(\d+)-[A-Za-z0-9]{6}$/.exec(name)?.[1]);
    // this pid's own roots too: a worker thread's, or one of its own a moment from now
    if (!pid || pid === process.pid || alive(pid)) continue;
    const kept = ageOf(path.join(runs, name, KEPT), now);
    if (kept >= 0 && kept < DAY) continue;
    remove(path.join(runs, name));
  }

  const swept = path.join(runs, SWEPT);
  const since = ageOf(swept, now);
  if (since >= 0 && since < HOUR) return removed;
  const stamp = (t: number) => {
    try {
      fs.mkdirSync(runs, { recursive: true });
      fs.closeSync(fs.openSync(swept, 'a'));
      fs.utimesSync(swept, t / 1000, t / 1000);
    } catch {}
  };
  // taken now, so the processes starting beside this one skip the pass
  stamp(now);
  let running: string | null | undefined;
  for (const name of list(tmp)) {
    if (!room()) {
      // more left: the next start goes on with it
      stamp(0);
      return removed;
    }
    const flat = FLAT.exec(name);
    if (flat && !APP_PREFIXES.has(flat[1])) {
      if (ageOf(path.join(tmp, name), now) > DAY) remove(path.join(tmp, name));
    } else if (PROFILE.test(name) && ageOf(path.join(tmp, name), now) > DAY) {
      if (running === undefined) running = commandLines();
      if (running !== null && !running.includes(name)) remove(path.join(tmp, name));
    }
  }
  return removed;
}

// Best effort on every load: a failure here never stops a test.
if (isMainThread) {
  try {
    sweep();
  } catch {}
}
