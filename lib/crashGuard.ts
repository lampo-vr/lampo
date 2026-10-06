// Background jobs that took the whole process down. A job named by a key (lib/jobs.ts `heavy(…, { key })`) leaves a
// marker while it runs; a process that dies under it (the kernel's out-of-memory killer, a crash in native code) can't
// remove it, so the next start finds it and counts that job as crashed. A job that ended its process CRASHES_ALLOWED
// times is not started again — every start used to queue the same job again (the warm-up's diff), a crash loop until
// someone removed the video (A13 MEDIA-1). A graceful stop (SIGTERM, Ctrl-C) removes the marker: an interrupted job is
// no crash. Kept in the cache, like what the jobs make: clearing the cache gives every job its chances back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE } from './paths.ts';

/** How often a job may end its process before it is no longer started by itself (once more after the first: a
 * deploy's kill or a power cut can stop any job once). */
export const CRASHES_ALLOWED = 2;

/** The job ended the process too often: it isn't run again (clearing the cache allows it again). */
export class CrashedJobError extends Error {
  status = 422;
  /** The same sentence for everyone (lib/publicError.ts): no key, no path. */
  publicText = 'this work stopped the server before, so it is not run again';
  key: string;
  constructor(key: string) {
    super('this work stopped the server before, so it is not run again');
    this.key = key;
  }
}

const dir = () => path.join(CACHE, '.jobs');
const ledgerFile = () => path.join(dir(), 'crashed.json');
const RUN = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const ownMarker = () => path.join(dir(), `run-${RUN}.json`);

let crashes: Record<string, number> | null = null;

const alive = (pid: number): boolean => {
  // our own pid on another run's marker: the process before us had it (pid 1 in a container)
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function save(): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${ledgerFile()}.${RUN}`;
    fs.writeFileSync(tmp, JSON.stringify(crashes));
    fs.renameSync(tmp, ledgerFile());
  } catch (e) {
    console.error(`jobs: could not keep the crashed jobs: ${(e as Error).message}`);
  }
}

/** The ledger, with the markers of processes that died since counted in (once: each marker is claimed by renaming). */
function ledger(): Record<string, number> {
  if (crashes) return crashes;
  try {
    const kept = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    crashes = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
  } catch {
    crashes = {};
  }
  const found = crashes as Record<string, number>;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => n.startsWith('run-') && n.endsWith('.json') && n !== path.basename(ownMarker()));
  } catch {}
  let counted = false;
  for (const name of names) {
    const file = path.join(dir(), name);
    try {
      const { pid, key } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; key?: string };
      if (alive(Number(pid))) continue;
      // another process starting at the same moment may count the same marker: only the one that moves it does
      const claimed = `${file}.${RUN}`;
      fs.renameSync(file, claimed);
      fs.rmSync(claimed, { force: true });
      if (typeof key !== 'string' || !key) continue;
      found[key] = (found[key] ?? 0) + 1;
      counted = true;
      console.error(
        `jobs: ${key} was running when the server stopped without a goodbye (${found[key]} of ${CRASHES_ALLOWED} times)${found[key] >= CRASHES_ALLOWED ? '; it is not run again' : ''}`,
      );
    } catch {}
  }
  if (counted) save();
  return found;
}

/** Whether the job named `key` ended its process too often to be started again. */
export const crashedTooOften = (key: string): boolean => (ledger()[key] ?? 0) >= CRASHES_ALLOWED;

/** The job named `key` starts in this process (one at a time: lib/jobs.ts runs one heavy job at once). */
export function jobStarts(key: string): void {
  ledger();
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(ownMarker(), JSON.stringify({ pid: process.pid, key, at: new Date().toISOString() }));
  } catch (e) {
    console.error(`jobs: could not mark ${key} as running: ${(e as Error).message}`);
  }
}

/** The job ended, well or with an error of its own: the process is still here. */
export function jobEnded(): void {
  try {
    fs.rmSync(ownMarker(), { force: true });
  } catch {}
}

/** A graceful stop: whatever runs now is interrupted, not crashed. */
export const jobsInterrupted = jobEnded;
