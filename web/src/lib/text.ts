// Matching text the way people type it: case, accents and German spelling don't matter ("uberblendung" finds
// "Überblendung", "strasse" finds "Straße"), the same rules as the server's search (lib/search.ts). No DOM: the
// library model and its unit tests use it too.

const one = (c: string) => c.normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase();

/** Lower case, accents off, ß → ss. */
export const fold = (s: string): string => [...s].map(one).join('');

/**
 * Where `words` (already folded) occur in `text`: [from, to) ranges in the original string, sorted and merged, for
 * marking matches in a result list.
 */
export function marks(text: string, words: string[]): [number, number][] {
  if (!words.length) return [];
  // The folded text, and for each of its characters the index of the original character it came from.
  let folded = '';
  const origin: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = one(c);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
    i += c.length;
  }
  const ranges: [number, number][] = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0 && w; at = folded.indexOf(w, at + w.length)) {
      const from = origin[at] as number;
      const lastSource = origin[at + w.length - 1] as number;
      ranges.push([from, lastSource + ((text.codePointAt(lastSource) ?? 0) > 0xffff ? 2 : 1)]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
