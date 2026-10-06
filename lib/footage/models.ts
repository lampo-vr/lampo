// The image/text model footage search uses: SigLIP B/16-224, int8 (Google, Apache-2.0), as the ONNX export made for
// transformers.js, downloaded on first use into the cache — pinned to one revision, every file checked by size and
// SHA-256 before it is used. Choice and numbers: bench/footage/RESULTS.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CACHE } from '../paths.ts';

export interface ModelFile {
  /** Path inside the repository (and inside the model's folder here). */
  path: string;
  bytes: number;
  sha256: string;
}

export interface FootageModel {
  id: string;
  repo: string;
  /** The commit the files are taken from: a later push to the repository changes nothing here. */
  revision: string;
  license: string;
  /** Square input of the vision tower, px. */
  size: number;
  dim: number;
  /** What every pixel is normalised with: (x / 255 − mean) / std. */
  mean: number;
  std: number;
  /** Tokens per text (SigLIP was trained on lower-case text padded to 64). */
  textLength: number;
  vision: ModelFile;
  text: ModelFile;
  tokenizer: ModelFile;
  tokenizerConfig: ModelFile;
}

export const SIGLIP: FootageModel = {
  id: 'siglip-b16-int8',
  repo: 'Xenova/siglip-base-patch16-224',
  revision: '4649052661e53c7000355844105f8a1792088239',
  license: 'Apache-2.0 (Google SigLIP)',
  size: 224,
  dim: 768,
  mean: 0.5,
  std: 0.5,
  textLength: 64,
  vision: { path: 'onnx/vision_model_quantized.onnx', bytes: 99499129, sha256: 'ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058' },
  text: { path: 'onnx/text_model_quantized.onnx', bytes: 111475220, sha256: 'ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2' },
  tokenizer: { path: 'tokenizer.json', bytes: 2398744, sha256: '4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08' },
  tokenizerConfig: { path: 'tokenizer_config.json', bytes: 739, sha256: '9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2' },
};

export const filesOf = (m: FootageModel): ModelFile[] => [m.vision, m.text, m.tokenizer, m.tokenizerConfig];
export const modelBytes = (m: FootageModel): number => filesOf(m).reduce((n, f) => n + f.bytes, 0);

/** Where the models live: VR_FOOTAGE_MODELS, else <cache>/models/ (shared by every workspace: the model is no team's). */
export const footageModelsDir = (): string => process.env.VR_FOOTAGE_MODELS || path.join(CACHE, 'models');
export const modelDir = (m: FootageModel, root = footageModelsDir()): string => path.join(root, m.repo.split('/').at(-1) as string);
/** A file checked once is marked (`.ok`), so a start doesn't hash 200 MB again. */
const marker = (file: string, f: ModelFile) => `${file}.${f.sha256.slice(0, 12)}.ok`;

/** Whether every file is there, at its size and checked. */
export function modelReady(m: FootageModel, root = footageModelsDir()): boolean {
  const dir = modelDir(m, root);
  return filesOf(m).every((f) => {
    const file = path.join(dir, f.path);
    try {
      return fs.statSync(file).size === f.bytes && fs.existsSync(marker(file, f));
    } catch {
      return false;
    }
  });
}

const downloads = new Map<string, Promise<string>>();
const progress = new Map<string, number>();
/** 0–1 while the model downloads (all its files together), else null. */
export const downloadProgress = (m: FootageModel, root = footageModelsDir()): number | null => progress.get(modelDir(m, root)) ?? null;

/**
 * The model's folder, downloaded once (each file streamed to a .part file, size + SHA-256 checked, then renamed); a
 * file already there is checked once. Concurrent callers share one download.
 */
export function ensureModel(m: FootageModel, { root = footageModelsDir(), log = console.log, fetchImpl = fetch }: EnsureOptions = {}): Promise<string> {
  const dir = modelDir(m, root);
  if (modelReady(m, root)) return Promise.resolve(dir);
  let p = downloads.get(dir);
  if (!p) {
    p = fetchAll(m, dir, log, fetchImpl).finally(() => {
      downloads.delete(dir);
      progress.delete(dir);
    });
    downloads.set(dir, p);
  }
  return p;
}

export interface EnsureOptions {
  root?: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

const sha256Of = async (file: string): Promise<string> => {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
};

async function fetchAll(m: FootageModel, dir: string, log: (msg: string) => void, fetchImpl: typeof fetch): Promise<string> {
  const total = modelBytes(m);
  let done = 0;
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  let said = false;
  for (const f of filesOf(m)) {
    const file = path.join(dir, f.path);
    if (fs.existsSync(marker(file, f)) && fs.statSync(file).size === f.bytes) {
      done += f.bytes;
      continue;
    }
    // a file someone put there (a copy from another machine): checked, not fetched again
    if (fs.existsSync(file) && fs.statSync(file).size === f.bytes && (await sha256Of(file)) === f.sha256) {
      fs.writeFileSync(marker(file, f), '');
      done += f.bytes;
      continue;
    }
    if (!said) {
      log(`footage model: downloading ${m.repo} (${mb(total - done)}, ${m.license}) …`);
      said = true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`;
    const res = await fetchImpl(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`footage model download failed: HTTP ${res.status} for ${f.path}`);
    const part = `${file}.part`;
    const hash = crypto.createHash('sha256');
    let got = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      got += chunk.length;
      progress.set(dir, Math.min(1, (done + got) / total));
    });
    try {
      await pipeline(body, fs.createWriteStream(part));
      const sum = hash.digest('hex');
      if (got !== f.bytes || sum !== f.sha256) throw new Error(`footage model file ${f.path} is corrupt (got ${got} bytes, sha256 ${sum.slice(0, 12)}…)`);
      fs.renameSync(part, file);
      fs.writeFileSync(marker(file, f), '');
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    done += f.bytes;
  }
  if (said) log(`footage model: ${m.id} ready`);
  return dir;
}
