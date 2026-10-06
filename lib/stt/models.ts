// Speech models for the local engine (transcribe.cpp GGUF files): which one, where it lives, and a verified download.
// Choice and numbers: bench/stt/RESULTS.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ModelPreset {
  id: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  /** transcribe.cpp family: only Whisper takes a vocabulary prompt. */
  family: 'whisper' | 'parakeet' | 'qwen3-asr';
  license: string;
}

const HF = 'https://huggingface.co/handy-computer';

export const MODELS: Record<string, ModelPreset> = {
  'whisper-turbo': {
    id: 'whisper-turbo',
    file: 'whisper-large-v3-turbo-Q8_0.gguf',
    url: `${HF}/whisper-large-v3-turbo-gguf/resolve/main/whisper-large-v3-turbo-Q8_0.gguf`,
    bytes: 886381760,
    sha256: 'b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183',
    family: 'whisper',
    license: 'MIT (OpenAI Whisper weights)',
  },
  'parakeet-v3': {
    id: 'parakeet-v3',
    file: 'parakeet-tdt-0.6b-v3-Q8_0.gguf',
    url: `${HF}/parakeet-tdt-0.6b-v3-gguf/resolve/main/parakeet-tdt-0.6b-v3-Q8_0.gguf`,
    bytes: 739508576,
    sha256: '5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7',
    family: 'parakeet',
    license: 'CC-BY-4.0 (NVIDIA)',
  },
  'qwen3-asr-1.7b': {
    id: 'qwen3-asr-1.7b',
    file: 'Qwen3-ASR-1.7B-Q8_0.gguf',
    url: `${HF}/Qwen3-ASR-1.7B-gguf/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf`,
    bytes: 2185030624,
    sha256: '9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7',
    family: 'qwen3-asr',
    license: 'Apache-2.0',
  },
};

/** The devices transcribe.cpp reports (subset of its BackendInfo). */
export interface DeviceInfo {
  name: string;
  kind: string;
  deviceType: string;
}

/**
 * `auto`: Whisper-turbo where a real GPU exists (Metal, CUDA, a discrete Vulkan card), Parakeet v3 on CPU-only
 * machines — Whisper always encodes a 30 s window and needs 7–10 s per note on a small server. Integrated GPUs count
 * as CPU. Anything else is a preset id or a path to a .gguf file.
 */
export function pickModel(model: string, devices: DeviceInfo[]): ModelPreset | { id: 'custom'; path: string; family: ModelPreset['family'] | 'unknown' } {
  if (model === 'auto') return devices.some((d) => d.deviceType === 'gpu') ? MODELS['whisper-turbo'] : MODELS['parakeet-v3'];
  if (MODELS[model]) return MODELS[model];
  if (model.endsWith('.gguf')) {
    const base = path.basename(model).toLowerCase();
    const family = base.includes('whisper') ? 'whisper' : base.includes('parakeet') ? 'parakeet' : base.includes('qwen3-asr') ? 'qwen3-asr' : 'unknown';
    return { id: 'custom', path: model, family };
  }
  throw new Error(`unknown speech model "${model}" (use auto, ${Object.keys(MODELS).join(', ')} or a path to a .gguf file)`);
}

export const modelFile = (dir: string, preset: ModelPreset): string => path.join(dir, preset.file);

export type DownloadLog = (msg: string) => void;

const downloads = new Map<string, Promise<string>>();
/** How far each running download is (0–1), by target file: the UI shows it while the first voice note waits. */
const fractions = new Map<string, number>();
export const downloadProgress = (dir: string, preset: ModelPreset): number | null => fractions.get(modelFile(dir, preset)) ?? null;

/**
 * The model file, downloaded once into `dir` (streamed to a .part file, size + SHA-256 checked, then renamed).
 * Concurrent callers share one download.
 */
export function ensureModel(dir: string, preset: ModelPreset, log: DownloadLog = console.log, fetchImpl: typeof fetch = fetch): Promise<string> {
  const target = modelFile(dir, preset);
  if (fs.existsSync(target) && fs.statSync(target).size === preset.bytes) return Promise.resolve(target);
  let p = downloads.get(target);
  if (!p) {
    p = download(target, preset, log, fetchImpl).finally(() => {
      downloads.delete(target);
      fractions.delete(target);
    });
    downloads.set(target, p);
  }
  return p;
}

async function download(target: string, preset: ModelPreset, log: DownloadLog, fetchImpl: typeof fetch): Promise<string> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  log(`speech model: downloading ${preset.file} (${mb(preset.bytes)}, ${preset.license}) …`);
  const res = await fetchImpl(preset.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`speech model download failed: HTTP ${res.status} for ${preset.url}`);
  const hash = crypto.createHash('sha256');
  let got = 0;
  let nextTenth = 1;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    got += chunk.length;
    fractions.set(target, Math.min(1, got / preset.bytes));
    const tenth = Math.min(10, Math.floor((got * 10) / preset.bytes));
    if (tenth >= nextTenth) {
      log(`speech model: ${tenth * 10}% (${mb(got)})`);
      nextTenth = tenth + 1;
    }
  });
  try {
    await pipeline(body, fs.createWriteStream(part));
    const sum = hash.digest('hex');
    if (got !== preset.bytes || sum !== preset.sha256)
      throw new Error(`speech model ${preset.file} is corrupt (got ${got} bytes, sha256 ${sum.slice(0, 12)}…)`);
    fs.renameSync(part, target);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  log(`speech model: ${preset.file} ready`);
  return target;
}
