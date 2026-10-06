// What the text checks of the pre-review exchange with an OCR / spelling engine.
import type { Rect } from '../types.ts';

/** Normalised (0–1) box with a top-left origin. */
export type NormBox = Rect;

export interface OcrWord {
  text: string;
  box: NormBox;
}

export interface OcrLine {
  text: string;
  /** 0–1 */
  conf: number;
  box: NormBox;
  words?: OcrWord[];
  /** Other readings of the line (Vision only). */
  alts?: string[];
}

export interface OcrPage {
  path: string;
  width: number;
  height: number;
  lines: OcrLine[];
  error?: string | null;
}

export interface SpellResult {
  /** Dominant language of the text, when the engine could tell (an unchecked guess: lib/text/language.ts decides). */
  lang: string | null;
  verdicts: Record<string, { ok: boolean; guess?: string | null }>;
}

export type Ocr = (images: string[]) => Promise<OcrPage[]>;
/** `text` = all recognised text; `languages`: what to check the words in, the text's language first (language.ts
 * spellLanguages) — an engine without those dictionaries checks in the ones it has. */
export type Spell = (words: string[], text: string, languages?: string[]) => Promise<SpellResult>;
/** An engine's guesses at the language of `text`: language → probability (0–1), or null when it can't tell. */
export type Detect = (text: string) => Promise<Record<string, number> | null>;
