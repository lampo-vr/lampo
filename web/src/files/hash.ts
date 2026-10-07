// Names dropped files by their bytes (SHA-256) while the check before an upload is open, in a worker (hashWorker.ts):
// what the workspace holds already is then committed without sending a byte. Only files up to HASH_MAX: a camera file's
// hash would keep a laptop busy for minutes, and dedupe is a bonus here (`lampo files push` is the fast path, it hashes
// natively and remembers). Smallest first, so the many small files (fonts, graphics) are named early.

/** The largest file the browser hashes before it is sent. */
export const HASH_MAX = 256e6;

export interface HashProgress {
  /** The files' hashes so far (null: it couldn't be read). */
  hashes: Map<File, string | null>;
  /** Bytes read of those that will be hashed. */
  read: number;
  total: number;
  done: boolean;
}

/** Starts hashing `files` (those up to HASH_MAX); `onProgress` hears each step. Returns a stop. */
export function hashFiles(files: File[], onProgress: (p: HashProgress) => void): () => void {
  const todo = files.filter((f) => f.size <= HASH_MAX).sort((a, b) => a.size - b.size);
  const total = todo.reduce((s, f) => s + f.size, 0);
  const hashes = new Map<File, string | null>();
  let read = 0;
  let current = 0;
  if (!todo.length || typeof Worker === 'undefined') {
    onProgress({ hashes, read: 0, total: 0, done: true });
    return () => {};
  }
  const worker = new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' });
  let last = 0;
  const next = () => {
    const file = todo[current];
    if (!file) {
      worker.terminate();
      onProgress({ hashes, read: total, total, done: true });
      return;
    }
    worker.postMessage({ id: current, file });
  };
  worker.onmessage = (e: MessageEvent<{ id: number; read?: number; hex?: string | null }>) => {
    const { id, hex } = e.data;
    const file = todo[id];
    if (!file || id !== current) return;
    if (hex !== undefined) {
      hashes.set(file, hex);
      read += file.size;
      current++;
      onProgress({ hashes, read, total, done: false });
      next();
    } else if (performance.now() - last > 120) {
      // a big file's progress, a few times a second
      last = performance.now();
      onProgress({ hashes, read: read + (e.data.read ?? 0), total, done: false });
    }
  };
  worker.onerror = () => {
    worker.terminate();
    onProgress({ hashes, read: total, total, done: true });
  };
  next();
  return () => worker.terminate();
}
