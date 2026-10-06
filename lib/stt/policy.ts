// Engine-independent rules for turning a voice note into text (why: bench/stt/RESULTS.md).
//  1. Never force a language on the first pass: a fixed hint makes engines invent text on silence and garbles notes
//     in the other language. Auto-detect; only when the detected language is not one the reviewer speaks, run once
//     more with the first of them.
//  2. A vocabulary prompt (Whisper only, opt-in) fixes English terms in German notes but occasionally collapses a
//     clip: re-run without it when the output looks broken.
//  3. Silence is an empty note, not "Thank you." — gate on level before any model sees it.

export interface Attempt {
  language?: string;
  prompt?: string;
  /** Ask for timings (a render's transcript): words where the engine has them, segments otherwise. */
  timed?: boolean;
  /** Whisper only: the first line may start anywhere in the window, not within its first second. A window that opens
   * on music otherwise tends to collapse into an invented line (lib/stt/collapse.ts); only for hearing a stretch again. */
  lateStart?: boolean;
}

export interface SttResult {
  text: string;
  /** Detected language ('' when the engine doesn't report one, e.g. Parakeet). */
  language: string;
  /** Timed runs only, seconds. */
  words?: { text: string; t0: number; t1: number }[];
  segments?: { text: string; t0: number; t1: number }[];
}

export type RunAttempt = (a: Attempt) => Promise<SttResult>;

export interface PolicyOptions {
  /** Languages the reviewer speaks; the first is the fallback. Empty = accept whatever is detected. */
  languages: string[];
  /** Vocabulary prompt (only passed when the engine's model takes one). */
  prompt?: string | null;
  /** Length of the audio in seconds (for the collapse guard). */
  seconds: number;
  /** Timings with the text (a render's transcript). */
  timed?: boolean;
}

// Scripts written with Latin letters; a prompt run that answers in another script has collapsed.
const LATIN_LANGS = new Set('af,ca,cs,cy,da,de,en,es,et,eu,fi,fr,ga,gl,hr,hu,id,is,it,lt,lv,ms,mt,nl,no,nb,nn,pl,pt,ro,sk,sl,sq,sv,sw,tr,vi'.split(','));
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * What a person's own speech (voice notes, recorded feedback) is listened for: the languages they chose — `[]` is
 * Automatic, any language as detected — else the server's list.
 */
export function forSpeaker<S extends { languages: string[] }>(stt: S, mine: string[] | undefined): S {
  return mine ? { ...stt, languages: mine } : stt;
}

export function needsLanguageRetry(detected: string, languages: string[]): boolean {
  if (!languages.length || !detected) return false;
  return !languages.includes(detected.toLowerCase());
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The prompt run produced something that is not a transcript of this clip. */
export function promptCollapsed(text: string, seconds: number, languages: string[]): boolean {
  const latinOnly = languages.length > 0 && languages.every((l) => LATIN_LANGS.has(l.toLowerCase()));
  if (latinOnly && NON_LATIN.test(text)) return true;
  return seconds >= 4 && words(text) < seconds / 2;
}

export async function transcribeWithPolicy(run: RunAttempt, { languages, prompt, seconds, timed }: PolicyOptions): Promise<SttResult> {
  const t = timed ? { timed: true } : {};
  let r = await run(prompt ? { prompt, ...t } : t);
  if (prompt && promptCollapsed(r.text, seconds, languages)) r = await run(t);
  if (needsLanguageRetry(r.language, languages)) r = await run({ language: languages[0], ...t });
  return { ...r, text: r.text.trim() };
}

/**
 * Loudest 30 ms window, as RMS (0–1). Anything under ~-48 dBFS is a mic left open, not speech — no model gets to
 * hallucinate on it.
 */
export function peakRms(pcm: Float32Array, rate = 16000): number {
  const win = Math.max(1, Math.round(rate * 0.03));
  let best = 0;
  for (let i = 0; i < pcm.length; i += win) {
    let sq = 0;
    const end = Math.min(pcm.length, i + win);
    for (let j = i; j < end; j++) sq += pcm[j] * pcm[j];
    best = Math.max(best, Math.sqrt(sq / (end - i)));
  }
  return best;
}

export const SILENCE_RMS = 0.004;
export const isSilent = (pcm: Float32Array, rate = 16000): boolean => pcm.length < rate * 0.3 || peakRms(pcm, rate) < SILENCE_RMS;

/** Comma-joined vocabulary for Whisper's initial prompt (bounded: long prompts hurt more than they help). */
export function vocabularyPrompt(terms: readonly string[] | undefined): string | null {
  const list = [...new Set((terms || []).map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return null;
  let out = '';
  for (const t of list) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > 400) break;
    out = next;
  }
  return out;
}
