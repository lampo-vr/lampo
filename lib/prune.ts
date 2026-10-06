// Size caps for cache directories that fill up on their own (scrub copies, exact frames grabbed for agents). The
// oldest files go first; the cache is regenerable, so this is best effort and never fails the caller.
import fs from 'node:fs';
import path from 'node:path';

/** Exact frames grabbed for agents (full-size PNGs): each such cache keeps about this much. */
export const FRAME_CACHE_BYTES = 1e9;

/** Deletes the oldest files (by mtime) in `dir` until the rest fits `capBytes`. Only files `matches` accepts count. */
export function pruneDir(dir: string, capBytes: number, matches: (name: string) => boolean = () => true): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter(matches)
      .map((f) => ({ f: path.join(dir, f), st: fs.statSync(path.join(dir, f)) }))
      .filter((x) => x.st.isFile());
    let total = files.reduce((s, x) => s + x.st.size, 0);
    for (const x of files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)) {
      if (total <= capBytes) break;
      fs.rmSync(x.f, { force: true });
      total -= x.st.size;
    }
  } catch {}
}
