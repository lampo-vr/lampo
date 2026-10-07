// Hashes dropped files off the main thread (hash.ts asks): each file's SHA-256 a piece at a time, with how far it got.
import { Sha256 } from './sha256.ts';

/** Bytes read at once: a few frames of a camera file, small enough to keep the worker's memory flat. */
const PIECE = 8 * 1024 * 1024;

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; file: Blob }>) => void) | null; postMessage: (m: unknown) => void };

scope.onmessage = async (e) => {
  const { id, file } = e.data;
  const h = new Sha256();
  try {
    for (let at = 0; at < file.size; at += PIECE) {
      h.update(new Uint8Array(await file.slice(at, at + PIECE).arrayBuffer()));
      scope.postMessage({ id, read: Math.min(file.size, at + PIECE) });
    }
    scope.postMessage({ id, hex: h.hex() });
  } catch {
    // a file that went away or can't be read (moved on the disk meanwhile): it goes without a hash
    scope.postMessage({ id, hex: null });
  }
};
