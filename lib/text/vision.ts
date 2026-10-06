// macOS: Vision text recognition + NSSpellChecker through tools/ocr.swift, compiled on first use.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, ROOT } from '../paths.ts';
import { runBg } from '../probe.ts';
import type { OcrPage, SpellResult } from './types.ts';

const SWIFT_SRC = path.join(ROOT, 'tools', 'ocr.swift');
const OCR_BIN = path.join(CACHE, 'bin', 'vr-ocr');

let built: Promise<string> | null = null;
export function visionBinary(): Promise<string> {
  const mtime = (p: string) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
  if (mtime(OCR_BIN) > mtime(SWIFT_SRC)) return Promise.resolve(OCR_BIN);
  if (!built) {
    built = (async () => {
      fs.mkdirSync(path.dirname(OCR_BIN), { recursive: true });
      await runBg('xcrun', ['swiftc', '-O', SWIFT_SRC, '-o', `${OCR_BIN}.tmp`]);
      fs.renameSync(`${OCR_BIN}.tmp`, OCR_BIN);
      return OCR_BIN;
    })().finally(() => {
      built = null;
    });
  }
  return built;
}

export async function visionOcr(images: string[]): Promise<OcrPage[]> {
  if (!images.length) return [];
  const { stdout } = await runBg(await visionBinary(), ['ocr', ...images], { maxBuffer: 256 * 1024 * 1024 });
  return stdout
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OcrPage);
}

export async function visionSpell(words: string[], text: string, languages?: string[]): Promise<SpellResult> {
  if (!words.length) return { lang: null, verdicts: {} };
  const { stdout } = await runBg(await visionBinary(), ['spell'], { input: JSON.stringify({ words, text, ...(languages ? { languages } : {}) }) });
  return JSON.parse(stdout.toString() || '{"verdicts":{}}');
}

/** NaturalLanguage's guesses at the text's language (its hypotheses, not a verdict: lib/text/language.ts weighs them). */
export async function visionDetect(text: string): Promise<Record<string, number> | null> {
  if (!text.trim()) return null;
  const { stdout } = await runBg(await visionBinary(), ['lang'], { input: JSON.stringify({ text }) });
  const out = JSON.parse(stdout.toString() || '{}') as { hypotheses?: Record<string, number> };
  return out.hypotheses && Object.keys(out.hypotheses).length ? out.hypotheses : null;
}
