// Messages between a process and its footage embedding worker (lib/footage/worker.ts).

/** `siglip`: the real model from `dir`; `fake`: the stand-in tests use (lib/footage/fake.ts), no model files. */
export type EmbedderKind = 'siglip' | 'fake';

export type EmbedIn =
  | { type: 'load'; kind: EmbedderKind; dir: string; threads: number }
  /** RGB pictures, size × size × 3 each (the frame letterboxed to the model's square). */
  | { type: 'images'; id: number; pictures: Uint8Array[] }
  | { type: 'texts'; id: number; texts: string[] }
  | { type: 'exit' };

export type EmbedOut =
  | { type: 'hello' }
  | { type: 'vectors'; id: number; vectors: Float32Array[]; ms: number }
  | { type: 'failed'; id?: number; error: string };
