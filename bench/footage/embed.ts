// Image and text embeddings on the CPU, in Node: ONNX Runtime through transformers.js (its tokenizers and model
// classes), with the pictures prepared by ffmpeg instead of sharp — frames come out of the decoder already at the
// model's size, so nothing decodes a JPEG in JS. Three ways to make a 16:9 frame square: `crop` (the centre square, what
// CLIP was trained with), `squash` (the whole frame, stretched — SigLIP's own processor does this) and `pad` (the whole
// frame, letterboxed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../../lib/env.ts';
import { MODELS_DIR } from './common.ts';
import { MODELS, type ModelSpec } from './models.ts';

export type Dtype = 'fp32' | 'q8';
export type Fit = 'crop' | 'squash' | 'pad';

export interface Embedder {
  spec: ModelSpec;
  dtype: Dtype;
  size: number;
  /** RGB pictures size × size × 3 → unit vectors. */
  images(rgb: Uint8Array[]): Promise<Float32Array[]>;
  texts(q: string[]): Promise<Float32Array[]>;
  /** The text side only (a query). */
  dispose(): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: transformers.js is a bench-only dependency, loaded from bench/footage/node_modules
type Any = any;
let tf: Any = null;
async function transformers(): Promise<Any> {
  if (!tf) {
    tf = await import('@huggingface/transformers');
    tf.env.localModelPath = `${MODELS_DIR}/`;
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.useBrowserCache = false;
  }
  return tf;
}

export const specOf = (key: string): ModelSpec => {
  const s = MODELS.find((m) => m.key === key);
  if (!s) throw new Error(`unknown model ${key} (${MODELS.map((m) => m.key).join(', ')})`);
  return s;
};

function norm(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) ** 2;
  const k = 1 / Math.sqrt(s || 1);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) * k;
  return out;
}

function rows(t: { data: Float32Array; dims: number[] }): Float32Array[] {
  const [n, d] = t.dims as [number, number];
  return Array.from({ length: n }, (_, i) => norm(t.data.slice(i * d, (i + 1) * d)));
}

export async function loadEmbedder(key: string, dtype: Dtype, threads: number, { text = true, vision = true } = {}): Promise<Embedder> {
  const spec = specOf(key);
  if (!spec.vision[dtype]) throw new Error(`${key} has no ${dtype} vision model in this bench`);
  const T = await transformers();
  // LAMPO_ORT_SPIN=0: worker threads sleep instead of spin-waiting between ops — less CPU burnt on a shared server
  const spin = settings.LAMPO_ORT_SPIN === '0' ? { extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } } : {};
  const session_options = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', ...spin };
  const pre = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, spec.repo, 'preprocessor_config.json'), 'utf8')) as {
    do_normalize?: boolean;
    image_mean?: number[];
    image_std?: number[];
  };
  const mean = pre.do_normalize === false ? [0, 0, 0] : (pre.image_mean ?? [0.48145466, 0.4578275, 0.40821073]);
  const std = pre.do_normalize === false ? [1, 1, 1] : (pre.image_std ?? [0.26862954, 0.26130258, 0.27577711]);
  const opts = (d: Dtype) => ({ dtype: d, device: 'cpu', session_options, local_files_only: true });
  const clip = spec.family === 'clip';
  const visionModel = vision ? await (clip ? T.CLIPVisionModelWithProjection : T.SiglipVisionModel).from_pretrained(spec.repo, opts(dtype)) : null;
  const textModel = text ? await (clip ? T.CLIPTextModelWithProjection : T.SiglipTextModel).from_pretrained(spec.repo, opts('q8')) : null;
  const tokenizer = text ? await T.AutoTokenizer.from_pretrained(spec.repo) : null;
  const S = spec.size;
  return {
    spec,
    dtype,
    size: S,
    async images(rgb) {
      if (!visionModel) throw new Error('vision model not loaded');
      const data = new Float32Array(rgb.length * 3 * S * S);
      rgb.forEach((px, b) => {
        const base = b * 3 * S * S;
        for (let c = 0; c < 3; c++) {
          const m = mean[c] as number;
          const sd = std[c] as number;
          const o = base + c * S * S;
          for (let i = 0; i < S * S; i++) data[o + i] = ((px[i * 3 + c] as number) / 255 - m) / sd;
        }
      });
      const out = await visionModel({ pixel_values: new T.Tensor('float32', data, [rgb.length, 3, S, S]) });
      return rows(clip ? out.image_embeds : out.pooler_output);
    },
    async texts(q) {
      if (!textModel || !tokenizer) throw new Error('text model not loaded');
      // SigLIP was trained on lower-case text padded to 64 tokens; CLIP pools at its end token (padding is harmless)
      const inputs = clip
        ? tokenizer(q, { padding: 'max_length', truncation: true, max_length: 77 })
        : tokenizer(
            q.map((s) => s.toLowerCase()),
            { padding: 'max_length', truncation: true, max_length: 64 },
          );
      const out = await textModel(inputs);
      return rows(clip ? out.text_embeds : out.pooler_output);
    },
    async dispose() {
      await visionModel?.dispose?.();
      await textModel?.dispose?.();
    },
  };
}

/** ffmpeg's filter for one way of making the frame a size × size square. */
export function fitFilter(fit: Fit, size: number): string {
  if (fit === 'squash') return `scale=${size}:${size}:flags=area`;
  if (fit === 'pad') return `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=area,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:black`;
  return `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=area,crop=${size}:${size}`;
}

/** The given frames of a clip, frame-exact (select by number), at size × size RGB — one decode for all of them. */
export function framesAt(file: string, frames: number[], size: number, fit: Fit): Promise<Uint8Array[]> {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const select = `select='${sorted.map((f) => `eq(n\\,${f})`).join('+')}'`;
  const frameSize = size * size * 3;
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v',
      'error',
      '-threads',
      '2',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `${select},${fitFilter(fit, size)}`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      const all = Buffer.concat(chunks);
      const n = all.length / frameSize;
      if (code !== 0 || n !== sorted.length) return reject(new Error(`${file}: got ${n} of ${sorted.length} frames`));
      const byFrame = new Map(sorted.map((f, i) => [f, new Uint8Array(all.subarray(i * frameSize, (i + 1) * frameSize))]));
      resolve(frames.map((f) => byFrame.get(f) as Uint8Array));
    });
  });
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
};
