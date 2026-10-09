// Working copies in use. A remote store's local copies are pruned to a budget (lib/storage/index.ts), and a copy handed
// to a piece of work must still be there when that work opens it: a comparison fetches the old version, then the new
// one, and the second download's prune took the first; a copy bigger than the whole budget went at once. Work that
// fetches copies (every job of lib/jobs.ts, a splice, every request the server answers) holds what it was handed until
// it ends, and a held copy is never pruned: the cache runs over its budget meanwhile, and the next prune after the work
// ends brings it back. No other imports: lib/jobs.ts uses it too.
import { AsyncLocalStorage } from 'node:async_hooks';

/** One piece of work: what it holds, whether it still runs, and the work it runs inside (which holds it all too). */
interface Work {
  held: Set<string>;
  open: boolean;
  outer: Work | undefined;
}

/** How many pieces of work hold each copy (by its path). */
const holders = new Map<string, number>();
const work = new AsyncLocalStorage<Work>();

/** Whether a piece of work still holds `file`. */
export const isHeld = (file: string): boolean => holders.has(file);

/**
 * `file` was handed to the work running now: held until that work ends, and by the work around it as long as that
 * runs. Nothing outside any work, and never by work that has ended (a context kept from it, as `AsyncResource.bind`
 * keeps one for later, holds nothing).
 */
export function holdForWork(file: string): void {
  for (let w = work.getStore(); w; w = w.outer) {
    if (!w.open || w.held.has(file)) continue;
    w.held.add(file);
    holders.set(file, (holders.get(file) ?? 0) + 1);
  }
}

/** Runs `fn` as one piece of work: every working copy handed out inside it stays until it has settled. */
export async function holdingWorkFiles<T>(fn: () => T | Promise<T>): Promise<T> {
  const w: Work = { held: new Set(), open: true, outer: work.getStore() };
  try {
    return await work.run(w, fn);
  } finally {
    w.open = false;
    for (const f of w.held) {
      const n = (holders.get(f) ?? 1) - 1;
      if (n > 0) holders.set(f, n);
      else holders.delete(f);
    }
  }
}

/**
 * A request's handler as one piece of work, for as long as its answer is going: what it fetches (a version to grab a
 * frame of, a poster, a note's screenshots) stays until the answer has gone. Outside any work a copy was safe only until
 * the next download: a frame grab waiting for an ffmpeg place lost its copy to another request's download meanwhile.
 * Express middleware shape, without importing Express: `res` only has to say when it closes.
 */
export function holdingForResponse(_req: unknown, res: { once(event: 'close', listener: () => void): unknown }, next: () => void): void {
  void holdingWorkFiles(
    () =>
      new Promise<void>((answered) => {
        res.once('close', () => answered());
        next();
      }),
  ).catch(() => {});
}
