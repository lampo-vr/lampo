// Messages between the server and the speech worker (lib/stt/worker.ts).
import type { DeviceInfo } from './models.ts';

export type WorkerIn =
  | { type: 'load'; path: string; threads: number }
  | { type: 'run'; id: number; pcm: Float32Array; language?: string; prompt?: string; timed?: boolean; lateStart?: boolean }
  | { type: 'exit' };

export type WorkerOut =
  | { type: 'hello'; devices: DeviceInfo[] }
  | { type: 'loaded'; device: string; arch: string; ms: number }
  | { type: 'result'; id: number; text: string; language: string; ms: number; words?: Timed[]; segments?: Timed[] }
  | { type: 'failed'; id?: number; error: string };

/** A timed piece of a transcript, in seconds (words when the model times them, segments always). */
export interface Timed {
  text: string;
  t0: number;
  t1: number;
}
