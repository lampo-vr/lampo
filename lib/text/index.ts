// Which engines read and spell-check burned-in text for the pre-review:
//   OCR       macOS Vision (tools/ocr.swift) on a Mac with Xcode tools, else tesseract (deu + eng) — LAMPO_OCR overrides
//   spelling  NSSpellChecker on macOS, else hunspell with the de_DE / en_US dictionaries
// A missing engine only skips the text checks; picture and audio checks always run.
import { execFileSync } from 'node:child_process';
import { settings } from '../env.ts';
import { dictionaryShares, hunspellDictionaries, hunspellSpell } from './hunspell.ts';
import { tesseractLanguages, tesseractOcr } from './tesseract.ts';
import type { Detect, Ocr, Spell } from './types.ts';
import { visionBinary, visionDetect, visionOcr, visionSpell } from './vision.ts';

export type { Detect, OcrLine, OcrPage, OcrWord, SpellResult } from './types.ts';

export interface TextTools {
  ocr: Ocr | null;
  spell: Spell | null;
  /** Guesses at the text's language for lib/text/language.ts (NaturalLanguage, or the dictionaries' shares). */
  detect: Detect | null;
  /** e.g. "vision", "tesseract (deu+eng)" */
  engine: string | null;
  /** Why something is missing, for the pre-review notes. */
  notes: string[];
}

const hasXcrun = () => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let cached: Promise<TextTools> | null = null;

/** LAMPO_OCR=auto|vision|tesseract|off. Resolved once per process. */
export function textTools(choice = settings.LAMPO_OCR || 'auto'): Promise<TextTools> {
  if (!cached) cached = pick(choice);
  return cached;
}

async function pick(choice: string): Promise<TextTools> {
  if (choice === 'off') return { ocr: null, spell: null, detect: null, engine: null, notes: ['text checks off (LAMPO_OCR=off)'] };
  const notes: string[] = [];
  let ocr: Ocr | null = null;
  let engine: string | null = null;
  let spell: Spell | null = null;
  let detect: Detect | null = null;

  const mac = hasXcrun();
  if (mac) {
    // Compiling the helper can fail (e.g. a broken Xcode install): then fall back like any other machine.
    const ok = await visionBinary().then(
      () => true,
      (e: Error) => {
        notes.push(`macOS text recognition unavailable: ${e.message.split('\n')[0]}`);
        return false;
      },
    );
    if (ok) {
      spell = visionSpell;
      detect = visionDetect;
      if (choice !== 'tesseract') {
        ocr = visionOcr;
        engine = 'vision';
      }
    }
  }
  if (!ocr && choice !== 'vision') {
    const langs = await tesseractLanguages();
    if (!langs) notes.push('text checks skipped: install tesseract (with German and English language data) for OCR');
    else {
      const use = ['deu', 'eng'].filter((l) => langs.includes(l));
      if (!use.length) notes.push('text checks skipped: tesseract has neither German (deu) nor English (eng) language data');
      else {
        if (use.length < 2) notes.push(`OCR reads ${use[0]} only: install tesseract's ${use[0] === 'eng' ? 'German (deu)' : 'English (eng)'} data too`);
        ocr = tesseractOcr(use);
        engine = `tesseract (${use.join('+')})`;
      }
    }
  }
  if (!ocr && !notes.length) notes.push('text checks skipped: no OCR engine (macOS Vision or tesseract)');
  if (ocr && !spell) {
    const dicts = await hunspellDictionaries();
    if (dicts?.length) {
      spell = hunspellSpell(dicts);
      detect = (text) => dictionaryShares(text, dicts);
    } else notes.push('spell check skipped: install hunspell with the de_DE and en_US dictionaries');
  }
  return { ocr, spell, detect, engine, notes };
}
