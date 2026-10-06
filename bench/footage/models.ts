#!/usr/bin/env node
// The image/text embedding models the bench compares, as exact files from Hugging Face (ONNX exports made for
// transformers.js), downloaded once into cache/footage/models/<repo>/ (cache/ is gitignored).
//   node bench/footage/models.ts            download what is missing, print the list with sizes
//   node bench/footage/models.ts --list     print only
// Total about 1.38 GB. Licences: CLIP MIT (OpenAI), SigLIP / SigLIP 2 Apache-2.0 (Google), MobileCLIP Apple's
// "apple-amlr" model licence (research use) — a reference point here, not a candidate to ship (RESULTS.md).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR } from './common.ts';

export interface ModelSpec {
  /** Short name used in results. */
  key: string;
  repo: string;
  family: 'clip' | 'siglip';
  licence: string;
  /** Files besides the ONNX graphs. */
  meta: string[];
  vision: { fp32?: string; q8?: string };
  text: string;
  /** Input size of the vision tower (for the ffmpeg-direct path). */
  size: number;
}

export const MODELS: ModelSpec[] = [
  {
    key: 'clip-b32',
    repo: 'Xenova/clip-vit-base-patch32',
    family: 'clip',
    licence: 'MIT',
    meta: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'],
    vision: { fp32: 'onnx/vision_model.onnx', q8: 'onnx/vision_model_quantized.onnx' },
    text: 'onnx/text_model_quantized.onnx',
    size: 224,
  },
  {
    key: 'siglip-b16',
    repo: 'Xenova/siglip-base-patch16-224',
    family: 'siglip',
    licence: 'Apache-2.0',
    meta: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'],
    vision: { q8: 'onnx/vision_model_quantized.onnx' },
    text: 'onnx/text_model_quantized.onnx',
    size: 224,
  },
  {
    key: 'siglip2-b16',
    repo: 'onnx-community/siglip2-base-patch16-224-ONNX',
    family: 'siglip',
    licence: 'Apache-2.0',
    meta: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'],
    vision: { q8: 'onnx/vision_model_quantized.onnx' },
    text: 'onnx/text_model_quantized.onnx',
    size: 224,
  },
  {
    key: 'mobileclip-s2',
    repo: 'Xenova/mobileclip_s2',
    family: 'clip',
    licence: 'apple-amlr (research use)',
    meta: ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'],
    vision: { fp32: 'onnx/vision_model.onnx', q8: 'onnx/vision_model_quantized.onnx' },
    text: 'onnx/text_model_quantized.onnx',
    size: 256,
  },
];

export const filesOf = (m: ModelSpec): string[] => [...m.meta, ...Object.values(m.vision), m.text];

async function download(repo: string, file: string): Promise<number> {
  const out = path.join(MODELS_DIR, repo, file);
  if (fs.existsSync(out)) return fs.statSync(out).size;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`);
  if (!res.ok || !res.body) throw new Error(`${repo}/${file}: HTTP ${res.status}`);
  const tmp = `${out}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  fs.renameSync(tmp, out);
  return fs.statSync(out).size;
}

if (import.meta.main) {
  const listOnly = process.argv.includes('--list');
  let total = 0;
  for (const m of MODELS) {
    for (const f of filesOf(m)) {
      const p = path.join(MODELS_DIR, m.repo, f);
      const size = listOnly ? (fs.existsSync(p) ? fs.statSync(p).size : 0) : await download(m.repo, f);
      total += size;
      if (size > 1e6) console.log(`${m.repo}/${f}`.padEnd(70), `${(size / 1e6).toFixed(1).padStart(7)} MB`);
    }
  }
  console.log('total'.padEnd(70), `${(total / 1e6).toFixed(1).padStart(7)} MB`);
}
