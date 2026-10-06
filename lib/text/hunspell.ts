// Spelling without macOS: the hunspell binary in ispell pipe mode (-a) with the German and English dictionaries
// (Debian/Ubuntu: hunspell-de-de, hunspell-en-us). Same rules as tools/ocr.swift: a word is fine when any case
// variant is valid in either language or it splits into valid compound parts (with a linking "s"); a misspelling
// gets the closest suggestion.
import { runBg } from '../probe.ts';
import type { SpellResult } from './types.ts';
import { distance } from './words.ts';

const hunspell = () => process.env.VR_HUNSPELL || 'hunspell';
const WANTED = ['de_DE', 'en_US', 'en_GB'];

/** Installed dictionaries we can use (e.g. ["de_DE", "en_US"]); null when hunspell is missing. */
export async function hunspellDictionaries(): Promise<string[] | null> {
  try {
    // `hunspell -D` lists the search path and dictionaries on stderr, then waits for input (stdin is closed).
    const { stderr, stdout } = await runBg(hunspell(), ['-D'], { input: '' }).catch((e: { stderr?: string; stdout?: Buffer }) => ({
      stderr: e.stderr || '',
      stdout: e.stdout || Buffer.alloc(0),
    }));
    const names = new Set(
      `${stderr}\n${stdout}`
        .split('\n')
        .map((l) => l.trim().split('/').pop() || '')
        .filter(Boolean),
    );
    if (!/AVAILABLE DICTIONARIES/i.test(`${stderr}${stdout}`)) return null;
    const found = WANTED.filter((d) => names.has(d));
    // One English variant is enough.
    return found.filter((d) => !(d === 'en_GB' && found.includes('en_US')));
  } catch {
    return null;
  }
}

type Verdict = { ok: boolean; suggestions: string[] };

/** One batch through `hunspell -a`: every word on its own line (^ = never a command), one result block per line. */
export async function checkWords(words: string[], dicts: string[]): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  const list = [...new Set(words)].filter((w) => w && !/\s/.test(w));
  if (!list.length) return out;
  const { stdout } = await runBg(hunspell(), ['-a', '-i', 'UTF-8', '-d', dicts.join(',')], { input: `${list.map((w) => `^${w}`).join('\n')}\n` });
  const blocks = stdout
    .toString()
    .split('\n')
    .slice(1) // version banner
    .join('\n')
    .split(/\n\n/);
  list.forEach((w, i) => {
    const lines = (blocks[i] || '').split('\n').filter(Boolean);
    const bad = lines.filter((l) => l[0] === '&' || l[0] === '#');
    const suggestions = bad.flatMap((l) => (l[0] === '&' ? l.slice(l.indexOf(':') + 1).split(', ') : [])).map((s) => s.trim());
    out.set(w, { ok: lines.length > 0 && bad.length === 0, suggestions: suggestions.filter(Boolean) });
  });
  return out;
}

const variants = (w: string): string[] => {
  const v = [w, w.toLowerCase(), w[0].toUpperCase() + w.slice(1).toLowerCase()];
  if (w === w.toUpperCase()) v.push(w[0] + w.slice(1).toLowerCase());
  return [...new Set(v)];
};

// German compounds: "Eventkosten" = Event + kosten, "Geburtstagskuchen" = Geburtstag + s + kuchen (two levels deep).
// Parts of at least 4 letters: shorter splits make almost anything look valid.
function splits(w: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 4; i <= w.length - 4; i++) out.push([w.slice(0, i), w.slice(i)]);
  return out;
}

/** Closest guess; on a tie keep the first letter (typos rarely hit it), then hunspell's order. */
export function bestGuess(word: string, guesses: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const g of guesses) {
    const score = distance(word, g) * 2 + (g[0]?.toLowerCase() === word[0]?.toLowerCase() ? 0 : 1);
    if (score < bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best;
}

export function hunspellSpell(dicts: string[]): (words: string[], text: string, languages?: string[]) => Promise<SpellResult> {
  // the dictionaries installed are German and English (WANTED): `languages` asks for nothing more they could check in
  return async (words) => {
    if (!words.length) return { lang: null, verdicts: {} };
    const valid = new Map<string, boolean>();
    const check = async (ws: string[]) => {
      const todo = [...new Set(ws.flatMap(variants))].filter((w) => !valid.has(w));
      for (const [w, v] of await checkWords(todo, dicts)) valid.set(w, v.ok);
    };
    const isValid = (w: string) => variants(w).some((v) => valid.get(v));

    const first = await checkWords([...new Set(words.flatMap(variants))], dicts);
    for (const [w, v] of first) valid.set(w, v.ok);

    // Compounds, two levels deep: check every candidate part in one batch per level.
    const failing = words.filter((w) => !isValid(w) && w.length >= 8);
    const level1 = failing.flatMap(splits);
    await check(level1.flatMap(([l, r]) => [l, r, l.endsWith('s') ? l.slice(0, -1) : l]));
    const rightFailing = [...new Set(level1.map(([, r]) => r).filter((r) => !isValid(r) && r.length >= 8))];
    await check(rightFailing.flatMap((r) => splits(r).flat()));
    const compound = (w: string, depth = 0): boolean => {
      if (w.length < 8 || depth > 1) return false;
      return splits(w).some(([l, r]) => (isValid(r) || compound(r, depth + 1)) && (isValid(l) || (l.endsWith('s') && l.length > 4 && isValid(l.slice(0, -1)))));
    };

    const verdicts: SpellResult['verdicts'] = {};
    for (const w of words) {
      if (isValid(w) || compound(w)) verdicts[w] = { ok: true, guess: null };
      else verdicts[w] = { ok: false, guess: bestGuess(w, [...(first.get(w)?.suggestions || []), ...(first.get(w.toLowerCase())?.suggestions || [])]) };
    }
    // the text's language is lib/text/language.ts's to say, from dictionaryShares (TextTools.detect)
    return { lang: null, verdicts };
  };
}

/** What share of the text's words each dictionary knows ("de" → 0.8, "en" → 0.3): the language guess without macOS. */
export async function dictionaryShares(text: string, dicts: string[]): Promise<Record<string, number> | null> {
  const tokens = [...new Set(text.split(/[^\p{L}]+/u).filter((t) => t.length >= 3))].slice(0, 400);
  if (!tokens.length || !dicts.length) return null;
  const out: Record<string, number> = {};
  for (const d of dicts) {
    const res = await checkWords(tokens, [d]);
    const lang = d.slice(0, 2);
    out[lang] = Math.max(out[lang] ?? 0, [...res.values()].filter((v) => v.ok).length / tokens.length);
  }
  return out;
}
