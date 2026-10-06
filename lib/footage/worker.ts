// The footage embedding worker (forked by lib/footage/embedder.ts): ONNX Runtime and the tokenizer in a process of their
// own, so a native crash takes down this process, never the server, and nothing heavy runs on its event loop. Each side
// of the model (images, texts) is loaded on its first use; requests are answered one at a time.
//   parent → {type:'load', kind, dir, threads} · {type:'images', id, pictures} · {type:'texts', id, texts} · {type:'exit'}
//   worker → {type:'hello'} · {type:'vectors', id, vectors, ms} · {type:'failed', id?, error}
import fs from 'node:fs';
import path from 'node:path';
import { fakeImage, fakeText } from './fake.ts';
import { SIGLIP } from './models.ts';
import type { EmbedderKind, EmbedIn, EmbedOut } from './protocol.ts';

type Ort = typeof import('onnxruntime-node');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
type Tok = import('@huggingface/tokenizers').Tokenizer;

const send = (m: EmbedOut) => process.send?.(m);

let kind: EmbedderKind = 'siglip';
let dir = '';
let threads = 1;
let ort: Ort | null = null;
let vision: Session | null = null;
let text: Session | null = null;
let tokenizer: Tok | null = null;
let padId = 1;
let queue = Promise.resolve();

function unit(data: Float32Array, n: number, d: number): Float32Array[] {
  return Array.from({ length: n }, (_, i) => {
    const v = data.slice(i * d, (i + 1) * d);
    let s = 0;
    for (const x of v) s += x * x;
    const k = 1 / Math.sqrt(s || 1);
    for (let j = 0; j < d; j++) v[j] = (v[j] as number) * k;
    return v;
  });
}

async function runtime(): Promise<Ort> {
  if (!ort) {
    try {
      ort = await import('onnxruntime-node');
    } catch (e) {
      throw new Error(`onnxruntime-node is not installed for this platform: ${(e as Error).message}`);
    }
  }
  return ort;
}

async function session(file: string): Promise<Session> {
  const o = await runtime();
  // Threads sleep between operators instead of spinning (bench/footage: spinning costs 10–40 % more CPU for little speed).
  return o.InferenceSession.create(path.join(dir, file), {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
  });
}

// One picture or text per run, never a batch: the int8 model quantizes its activations with a scale taken over the
// whole input, so a frame batched with others comes out a little different (cosine ~0.99) than on its own. One at a
// time, a frame's vector is the same however the frames were grouped (bench/footage: batch 1 costs the same CPU).
async function images(pictures: Uint8Array[]): Promise<Float32Array[]> {
  if (kind === 'fake') return pictures.map(fakeImage);
  const o = await runtime();
  vision ??= await session(SIGLIP.vision.path);
  const S = SIGLIP.size;
  const out: Float32Array[] = [];
  for (const px of pictures) {
    if (px.length !== S * S * 3) throw new Error(`a picture of ${px.length} bytes, not ${S}×${S} RGB`);
    const data = new Float32Array(3 * S * S);
    for (let c = 0; c < 3; c++) {
      const at = c * S * S;
      for (let i = 0; i < S * S; i++) data[at + i] = ((px[i * 3 + c] as number) / 255 - SIGLIP.mean) / SIGLIP.std;
    }
    const res = await vision.run({ pixel_values: new o.Tensor('float32', data, [1, 3, S, S]) });
    const pooled = res.pooler_output as { data: Float32Array; dims: readonly number[] };
    out.push(...unit(pooled.data, 1, pooled.dims[1] as number));
  }
  return out;
}

async function texts(list: string[]): Promise<Float32Array[]> {
  if (kind === 'fake') return list.map(fakeText);
  const o = await runtime();
  if (!tokenizer) {
    const { Tokenizer } = await import('@huggingface/tokenizers');
    const json = JSON.parse(fs.readFileSync(path.join(dir, SIGLIP.tokenizer.path), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(dir, SIGLIP.tokenizerConfig.path), 'utf8'));
    tokenizer = new Tokenizer(json, config);
    padId = tokenizer.token_to_id('</s>') ?? 1;
  }
  text ??= await session(SIGLIP.text.path);
  // SigLIP was trained on lower-case text padded to 64 tokens; a longer one is cut there (as transformers.js does)
  const L = SIGLIP.textLength;
  const out: Float32Array[] = [];
  const tok = tokenizer;
  for (const t of list) {
    const ids = new BigInt64Array(L).fill(BigInt(padId));
    tok
      .encode(t.toLowerCase())
      .ids.slice(0, L)
      .forEach((id: number, j: number) => {
        ids[j] = BigInt(id);
      });
    const res = await text.run({ input_ids: new o.Tensor('int64', ids, [1, L]) });
    const pooled = res.pooler_output as { data: Float32Array; dims: readonly number[] };
    out.push(...unit(pooled.data, 1, pooled.dims[1] as number));
  }
  return out;
}

async function handle(msg: EmbedIn): Promise<void> {
  if (msg.type === 'load') {
    kind = msg.kind;
    dir = msg.dir;
    threads = Math.max(1, msg.threads);
    return;
  }
  if (msg.type === 'images' || msg.type === 'texts') {
    const t = performance.now();
    try {
      const vectors = msg.type === 'images' ? await images(msg.pictures) : await texts(msg.texts);
      send({ type: 'vectors', id: msg.id, vectors, ms: Math.round(performance.now() - t) });
    } catch (e) {
      send({ type: 'failed', id: msg.id, error: (e as Error).message });
    }
    return;
  }
  if (msg.type === 'exit') process.exit(0);
}

process.on('message', (msg: EmbedIn) => {
  queue = queue.then(() => handle(msg));
});
process.on('disconnect', () => process.exit(0));
send({ type: 'hello' });
