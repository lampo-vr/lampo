// A graceful stop (SIGTERM from Docker, systemd or a deploy): no new connections, live streams closed, and a bounded
// wait for work that would otherwise be lost: uploads being registered (their bytes are in, the version isn't yet) and
// the heavy job running right now. Queued jobs are simply started again by the next process.
import { drainJobs } from '../lib/jobs.ts';

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

/** Waits at most `timeoutMs` for tracked work and the running job; true when everything finished in time. */
export async function drain(inflight: InFlight, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const done = Promise.all([inflight.settled(), drainJobs()]).then(() => true);
  const out = await Promise.race([done, new Promise<boolean>((r) => (timer = setTimeout(r, timeoutMs, false)))]);
  clearTimeout(timer);
  return out;
}
