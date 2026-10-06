// Words in footage: what OCR read in a shot's keyframes worth keeping, and how a request's words are matched against
// it and against what is said (bench/footage/find.ts, as measured). Browser-safe.

export interface OcrLineLite {
  text: string;
  conf: number;
}

/** Confidence a line needs per engine (tesseract's are word means, Vision's 0.3 / 0.5 / 1). */
export const OCR_MIN_CONF: Record<string, number> = { tesseract: 0.75, vision: 0.5 };

/** What the OCR read that is worth keeping: confident lines with a real word in them (≥ 4 letters, or two of ≥ 3) —
 * photos make tesseract see "ee", "BLE", "nee". */
export function cleanOcr(lines: readonly OcrLineLite[], minConf: number): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.conf < minConf) continue;
    const words = l.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
    const long = words.filter((w) => /\p{L}{4,}/u.test(w)).length;
    const mid = words.filter((w) => /\p{L}{3,}|\p{N}{2,}/u.test(w)).length;
    if (!long && mid < 2) continue;
    out.push(words.join(' '));
  }
  return [...new Set(out)];
}

const STOP = new Set('the a an and or of in on at to with is are was this that der die das und ein eine mit im am zu'.split(' '));
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // one edit (OCR misreads a letter)
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
}

/** Share of the query's words found in a text (one edit allowed for words of 5+ letters). */
export function wordMatch(query: string, text: string): number {
  const q = fold(query)
    .split(' ')
    .filter((w) => w && !STOP.has(w));
  if (!q.length || !text) return 0;
  const t = fold(text).split(' ');
  return q.filter((w) => t.some((x) => near(w, x))).length / q.length;
}
