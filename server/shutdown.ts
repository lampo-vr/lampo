// A graceful stop (SIGTERM from Docker, systemd or a deploy): no new connections, live streams closed, and a bounded
// wait for work that would otherwise be lost: uploads being registered (their bytes are in, the version isn't yet), the
// heavy job running right now, and what deleted videos are removing from storage (what that wait cuts short stays
// written down, and the next process finishes it: lib/store.ts finishRemovals). Queued jobs are simply started again by
// the next process.
import { drainJobs } from '../lib/jobs.ts';
import { removalsSettled } from '../lib/store.ts';

/** Work a shutdown waits for. */
export interface InFlight {
  track<T>(p: Promise<T>): Promise<T>;
  settled(): Promise<void>;
}

export function createInFlight(): InFlight {
  const running = new Set<Promise<unknown>>();
  return {
    track(p) {
      running.add(p);
      p.finally(() => running.delete(p)).catch(() => {});
      return p;
    },
    settled: () => Promise.allSettled([...running]).then(() => {}),
  };
}

/** Waits at most `timeoutMs` for tracked work, the running job and removals from storage; true when all ended in time. */
export async function drain(inflight: InFlight, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const done = Promise.all([inflight.settled(), drainJobs(), removalsSettled()]).then(() => true);
  const out = await Promise.race([done, new Promise<boolean>((r) => (timer = setTimeout(r, timeoutMs, false)))]);
  clearTimeout(timer);
  return out;
}
