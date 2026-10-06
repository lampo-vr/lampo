// Readiness: can this instance do its work right now? `/readyz` answers load balancers and compose with one boolean
// per check (no paths, no error texts: the endpoint is public); the details go to the log, at start and whenever a
// check changes. Liveness (`/healthz`) stays a plain "the process answers".
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, DATA, VERSIONS } from '../lib/paths.ts';
import { FFMPEG, FFPROBE, run } from '../lib/probe.ts';
import { rootStorage } from '../lib/storage/index.ts';
import { checkWorkspaces } from '../lib/workspaces.ts';

/**
 * How long `ffmpeg -version` may take before the check says no: a health probe must answer, and a hung tool is a tool
 * that doesn't work (A12 INV-7). Tests lower it.
 */
export const READY_LIMITS = { toolMs: 5000 };

export type CheckName = 'data' | 'disk' | 'ffmpeg' | 'storage' | 'public_url';

export interface ReadyReport {
  ok: boolean;
  /** Draining for a shutdown: not ready, whatever the checks say. */
  stopping: boolean;
  /** public_url only in server mode. */
  checks: Partial<Record<CheckName, boolean>>;
  /** For the log only: what failed, with paths and messages. */
  details: Partial<Record<CheckName, string>>;
}

export interface Readiness {
  check(): Promise<ReadyReport>;
  /** Logs the checks once (at start), plus configuration warnings that don't make the instance unready. */
  logStartup(): Promise<void>;
}

/** Free bytes on the file system holding dir (the nearest existing parent), or null when it can't be told. */
export function freeBytes(dir: string): number | null {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const s = fs.statfsSync(d);
      return s.bavail * s.bsize;
    } catch {
      if (path.dirname(d) === d) return null;
    }
  }
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

export function createReadiness({
  minFree,
  stopping,
  cacheMs = 30_000,
  warnings = [],
  publicUrl,
}: {
  minFree: number;
  stopping: () => boolean;
  cacheMs?: number;
  warnings?: string[];
  /** Server mode: whether the public URL is set (a hosted instance without one is only a local test). */
  publicUrl?: boolean;
}): Readiness {
  // Slow or remote checks are remembered for a while: a probe every few seconds must not become an API call each.
  const memo = new Map<string, { at: number; p: Promise<string | null> }>();
  const cached = (key: string, fn: () => Promise<string | null>) => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.p;
    const p = fn().catch((e: Error) => e.message);
    memo.set(key, { at: Date.now(), p });
    return p;
  };

  async function data(): Promise<string | null> {
    const probe = path.join(DATA, `.ready-${process.pid}`);
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
    } catch (e) {
      return `${DATA} is not writable: ${(e as Error).message}`;
    }
    // A moved store whose workspaces.json can't be read answers every signed-in request with 503 (lib/workspaces.ts).
    try {
      checkWorkspaces();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async function disk(): Promise<string | null> {
    const dirs = [DATA, CACHE, ...(rootStorage().kind === 'local' ? [VERSIONS] : [])];
    const low = dirs
      .map((d) => ({ d, free: freeBytes(d) }))
      .filter((x) => x.free !== null && x.free < minFree)
      .map((x) => `${x.d}: ${gb(x.free as number)} free (minimum ${gb(minFree)})`);
    return low.length ? low.join('; ') : null;
  }

  const ffmpeg = () =>
    cached('ffmpeg', async () => {
      await run(FFMPEG, ['-hide_banner', '-version'], { timeout: READY_LIMITS.toolMs });
      await run(FFPROBE, ['-hide_banner', '-version'], { timeout: READY_LIMITS.toolMs });
      return null;
    });

  const store = () =>
    cached('storage', async () => {
      await rootStorage().check();
      return null;
    });

  let last = '';
  async function check(): Promise<ReadyReport> {
    const [d, k, f, s] = await Promise.all([data(), disk(), ffmpeg(), store()]);
    const u = publicUrl === false ? 'no public URL (VR_PUBLIC_URL): fine for a local test, not for people' : null;
    const found = { data: d, disk: k, ffmpeg: f, storage: s, ...(publicUrl === undefined ? {} : { public_url: u }) };
    const details = Object.fromEntries(Object.entries(found).filter(([, v]) => v !== null)) as ReadyReport['details'];
    const checks = Object.fromEntries(Object.entries(found).map(([name, why]) => [name, !why])) as ReadyReport['checks'];
    const report = { ok: !stopping() && Object.values(found).every((why) => !why), stopping: stopping(), checks, details };
    const summary = JSON.stringify(details);
    if (summary !== last) {
      for (const [name, why] of Object.entries(details)) console.error(`not ready (${name}): ${why}`);
      if (last && summary === '{}') console.log('ready again');
      last = summary;
    }
    return report;
  }

  return {
    check,
    async logStartup() {
      const r = await check();
      if (r.ok) console.log(`ready: data writable, disk above ${gb(minFree)} free, ffmpeg found, storage (${rootStorage().kind}) reachable`);
      for (const w of warnings) console.warn(`warning: ${w}`);
    },
  };
}
