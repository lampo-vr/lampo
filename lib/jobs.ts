// One heavy background job at a time (ffmpeg-bound work), highest priority first, so a burst of new renders never
// saturates the machine while someone is watching. Lower number = sooner.
// poster: a missing poster at start-up (may download the render from remote storage first; one at a time).
// preview: a new render compared with the fix previews notes were verified on, and a full render with the partial
// renders approved before it (lib/parts.ts; a few frames; settles notes). A part's whole video is put together as
// the scrub copy (lib/splice.ts).
// crc: checksums for folder downloads (reads files, no ffmpeg): they only make the next download resumable.
// transcript: what is said in a render (the speech engine), when someone asks for it or an older version has one.
// sprite: the library cards' hover-scrub strip, the least urgent of all (made on the first request for it).
// recording: recorded feedback being heard — its maker waits for the drafts, so right after scrub copies; also a
// render's shots for a partial render (lib/cuts.ts), which the player's where-menu waits for.
// option: the file of an option an agent offers before it renders (lib/refs.ts storeOptionFile: a sound re-encoded and
// measured, a clip, a picture) — the agent's call waits for it, so before posters; one at a time like the rest, never
// a question's files all at once (A12 OPTM-2).
// Fair between the people who run workspaces (a hosted server's teams): the owners with work waiting take turns — the
// one served longest ago next —, within an owner's turn their workspaces take turns the same way, and each turn runs
// that workspace's most urgent job (priority, then arrival). So no backlog, of any priority and spread over any number
// of one account's workspaces, holds another team's next job back by more than one job per owner with work waiting
// (A12 WS-6, D2). With one workspace (the machine) this is the plain order of priority, then arrival.
// Bounded per workspace on a hosted server (QUEUE_LIMITS): past it a job is refused with QueueFullError — a clear
// answer to whoever asked (503 + a sentence), logged once —, never dropped without a word; work the server owes (a
// note's fix check, a recording its maker waits for) is queued anyway (`mustRun`). The last `reserved` places under the
// cap are kept for what a player waits on — a scrub copy, a part's splice (`reserved: true`) —, so a backlog of other
// work never leaves a video unplayable.
// A job named by a `key` that took the whole process down is not started again after CRASHES_ALLOWED such ends
// (lib/crashGuard.ts): the start-up warm-up queued the same job on every start, a crash loop (A13 MEDIA-1).
import { CrashedJobError, crashedTooOften, jobEnded, jobStarts } from './crashGuard.ts';
import { boundToWorkspace, DEFAULT_WORKSPACE, explicitWorkspace } from './scope.ts';

export { CrashedJobError } from './crashGuard.ts';

// publish: a platform's encode of a final video (the publish kit, or the file a post sends when the final itself isn't
// what the platform takes) — someone waits for it, but never a player.
export const PRIORITY = {
  scrub: 0,
  recording: 0.5,
  option: 0.75,
  poster: 1,
  diff: 2,
  preview: 3,
  analysis: 4,
  publish: 4.5,
  transcript: 5,
  qa: 6,
  crc: 7,
  sprite: 8,
  // footage search's index (lib/footage/): after everything a review needs, so it never delays one; a video's work is
  // cut into chunks of a minute (or 48 keyframes), each a job of its own, so a long take never holds the queue.
  footage: 9,
} as const;

/**
 * How many jobs one workspace may have waiting at once, and how many of those places only what a player waits on may
 * take. No cap on the machine; a hosted server sets one (server/context.ts).
 */
export const QUEUE_LIMITS = { perWorkspace: Number.POSITIVE_INFINITY, reserved: 0 };
/** What a hosted server allows: far more than a team's uploads need, far less than a flood of requests could queue. */
export const HOSTED_QUEUE_LIMIT = 200;
/** Of those, the places kept for scrub copies and splices a player waits on. */
export const HOSTED_QUEUE_RESERVED = 20;

/** The workspace has as many jobs waiting as it may: this one isn't queued, and whoever asked is told. */
export class QueueFullError extends Error {
  status = 503;
  retryAfter = 60;
  /** The same sentence for everyone (lib/publicError.ts): no path, no ref. */
  publicText: string;
  constructor(waiting: number) {
    super(`this workspace has ${waiting} jobs waiting already (the most one workspace may): try again in a few minutes`);
    this.publicText = this.message;
  }
}

interface Job {
  fn: () => unknown;
  priority: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Arrival order. */
  seq: number;
  /** The workspace that queued it: whose turn it takes. */
  ws: string;
  /** The account that runs that workspace (its owner), or the workspace itself when that can't be told. */
  who: string;
  /** What the job is, for the crash guard (lib/crashGuard.ts): the same work on the same render has the same key. */
  key?: string;
}

const queue: Job[] = [];
let running = 0;
const LIMIT = 1;
/** The jobs running now, with the workspace each runs for. */
const current = new Map<Promise<unknown>, string>();
let draining = false;
let arrived = 0;
// When each owner and each workspace with work waiting was last served (a counter, not a clock); forgotten once
// nothing waits.
const servedWho = new Map<string, number>();
const servedWs = new Map<string, number>();
let turns = 0;
/** Jobs waiting per workspace (not the one running). */
const waitingIn = new Map<string, number>();
/** Workspaces refused since their queue was last below the cap (each said once in the log). */
const refusing = new Set<string>();

// Who runs a workspace, as lib/workspaces.ts knows it (it registers itself: this module imports nothing of it).
let ownerOf: (ws: string) => string | null = () => null;
export function setJobOwner(fn: (ws: string) => string | null): void {
  ownerOf = fn;
}
/** Who runs a workspace, for other queues that take turns the same way (the publish queue): null when it can't be told. */
export function workspaceOwner(ws: string): string | null {
  try {
    return ownerOf(ws);
  } catch {
    return null;
  }
}

const workspaceNow = (): string => explicitWorkspace() ?? DEFAULT_WORKSPACE;

type Room = { reserved?: boolean };
const capOf = ({ reserved = false }: Room): number => QUEUE_LIMITS.perWorkspace - (reserved ? 0 : QUEUE_LIMITS.reserved);

/** Whether the workspace running now may queue another job (QueueFullError from heavy() otherwise); `reserved`: one a player waits on. */
export const jobRoom = (ws = workspaceNow(), room: Room = {}): boolean => (waitingIn.get(ws) ?? 0) < capOf(room);

/** Throws QueueFullError, said once in the log, when the workspace running now may queue nothing more. */
export function needJobRoom(ws = workspaceNow(), room: Room = {}): void {
  if (jobRoom(ws, room)) return;
  const n = waitingIn.get(ws) ?? 0;
  if (!refusing.has(ws)) {
    refusing.add(ws);
    console.error(`jobs: workspace ${ws} has ${n} jobs waiting (the most one workspace may); more are refused until some are done`);
  }
  throw new QueueFullError(n);
}

/** Runs fn — something that queues work nobody waits on right now (a warm-up) — and lets a full queue pass: logged once. */
export function unlessBusy(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof QueueFullError)) throw e;
  }
}

/** Whether the job named `key` took its process down too often to be started (heavy() refuses it with CrashedJobError). */
export const jobCrashed = (key: string): boolean => crashedTooOften(key);

/**
 * Queues fn for the workspace running now. Rejects with QueueFullError when that workspace has as many jobs waiting as
 * it may, unless `mustRun` (work the server owes: settling notes, a recording its maker waits for); `reserved` (what a
 * player waits on) may also take the places kept for it. `key` names the work (kind and render, through `wsKey`): a
 * job that took the process down CRASHES_ALLOWED times is refused with CrashedJobError, owed or not.
 */
export function heavy<T>(
  fn: () => T | Promise<T>,
  priority = 5,
  { mustRun = false, reserved = false, key }: { mustRun?: boolean; reserved?: boolean; key?: string } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (key && crashedTooOften(key)) {
      reject(new CrashedJobError(key));
      return;
    }
    // The job runs for the workspace that queued it, whichever job's end happens to start it (lib/scope.ts).
    const ws = workspaceNow();
    if (!mustRun) {
      try {
        needJobRoom(ws, { reserved });
      } catch (e) {
        reject(e);
        return;
      }
    }
    let who: string | null = null;
    try {
      who = ownerOf(ws);
    } catch {}
    queue.push({ fn: boundToWorkspace(fn), priority, resolve: resolve as (value: unknown) => void, reject, seq: arrived++, ws, who: who ?? `ws:${ws}`, key });
    waitingIn.set(ws, (waitingIn.get(ws) ?? 0) + 1);
    pump();
  });
}

/** Whether job a goes before job b of the same workspace: the better priority, then the one that came first. */
const sooner = (a: Job, b: Job): boolean => a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);

/** Whether a's turn comes before b's: served longer ago by `served` (by `key`), else the more urgent job. */
const before = (a: Job, b: Job, served: Map<string, number>, key: (j: Job) => string): boolean => {
  const x = served.get(key(a)) ?? -1;
  const y = served.get(key(b)) ?? -1;
  return x < y || (x === y && sooner(a, b));
};

/**
 * The next job: each workspace with work waiting offers its most urgent one, each owner the offer of their workspace
 * served longest ago, and the owner served longest ago goes.
 */
function takeNext(): Job {
  const offer = new Map<string, number>();
  queue.forEach((j, i) => {
    const o = offer.get(j.ws);
    if (o === undefined || sooner(j, queue[o] as Job)) offer.set(j.ws, i);
  });
  const byWho = new Map<string, number>();
  for (const i of offer.values()) {
    const j = queue[i] as Job;
    const o = byWho.get(j.who);
    if (o === undefined || before(j, queue[o] as Job, servedWs, (x) => x.ws)) byWho.set(j.who, i);
  }
  let at = -1;
  for (const i of byWho.values()) if (at < 0 || before(queue[i] as Job, queue[at] as Job, servedWho, (x) => x.who)) at = i;
  const [job] = queue.splice(at, 1) as [Job];
  servedWs.set(job.ws, ++turns);
  servedWho.set(job.who, turns);
  const left = (waitingIn.get(job.ws) ?? 1) - 1;
  if (left > 0) waitingIn.set(job.ws, left);
  else waitingIn.delete(job.ws);
  if (left < capOf({})) refusing.delete(job.ws);
  if (!queue.length) {
    servedWs.clear();
    servedWho.clear();
  }
  return job;
}

function pump() {
  while (!draining && running < LIMIT && queue.length) {
    const job = takeNext();
    running++;
    if (job.key) jobStarts(job.key);
    const p = Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (job.key) jobEnded();
        running--;
        current.delete(p);
        pump();
      });
    current.set(p, job.ws);
  }
}

/**
 * A workspace was deleted (lib/deletion.ts): its waiting jobs are dropped (they reject), and this resolves once the one
 * running for it, if any, has ended — so nothing it writes lands after the workspace's files are gone.
 */
export function dropJobsOf(ws: string): Promise<void> {
  for (let i = queue.length - 1; i >= 0; i--) {
    const j = queue[i] as Job;
    if (j.ws !== ws) continue;
    queue.splice(i, 1);
    j.reject(new Error('the workspace was deleted'));
  }
  waitingIn.delete(ws);
  refusing.delete(ws);
  servedWs.delete(ws);
  const mine = [...current].filter(([, w]) => w === ws).map(([p]) => p);
  return Promise.allSettled(mine).then(() => {});
}

/** For a shutdown: starts no further job and resolves once the ones already running have finished. */
export function drainJobs(): Promise<void> {
  draining = true;
  return Promise.allSettled([...current.keys()]).then(() => {});
}

export const queued = (): number => queue.length + running;
