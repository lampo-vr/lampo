// Which language a render's burned-in text is in: what the spell check reads it in, and what Auto-check says it checked.
// Text read off frames is short and full of names, numbers and brand words, and a recogniser left to itself (macOS
// NaturalLanguage) names rare languages for it — "Norwegian Bokmål" for a German or English caption. So the languages
// the work is in come first (the transcript's, the account's, the server's), the words themselves decide between them,
// and an engine's guess outside them counts only for a long sample it is sure of. Browser-safe: the player names the
// language through `shownTextLanguage`.

/** What every spell engine here has dictionaries for: always among the candidates. */
export const DICTIONARY_LANGS: readonly string[] = ['de', 'en'];
/** Distinct words a sample needs before a language nobody expects may be named… */
export const LONG_SAMPLE = 40;
/** …and how sure the engine must be of it (0–1). */
export const SURE = 0.9;

// Short, frequent words that tell the languages apart. Words two of them share ("in", "die" vs "die") count for both;
// letters only one alphabet has weigh in below.
const FUNCTION_WORDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    de: 'der die das den dem des ein eine einen einem einer und oder aber ist sind war hat haben wird werden nicht kein keine mit für auf aus bei nach von vom zum zur zu im ins am an als auch nur noch schon jetzt hier mehr sehr wie was wer wo wir ihr sie er es ich du dein deine dich dir mein unser euer sich so dass wenn weil über unter durch gegen ohne bis um neu alle jeder heute mal',
    en: 'the a an and or but is are was were be been has have had will would not no with for on of to in at by from as also only just now here more very how what who where we you they he she it my your our their this that these those if because about over under through without up out all every today new get one',
    fr: 'le la les un une des du de et ou mais est sont avec pour sur dans par pas ne plus très comme qui que nous vous ils elle il je tu ce cette ces votre notre leur aussi',
    es: 'el la los las un una unos y o pero es son está con para por sin en del al no más muy como qué quién nosotros ustedes ellos ella yo tu su sus este esta también',
    it: 'il lo la gli le un una uno e o ma è sono con per su nel della del non più molto come che chi noi voi loro lei lui io tu questo questa anche',
    nl: 'de het een en of maar is zijn was met voor op uit bij naar van niet geen ook nog nu hier meer heel hoe wat wie waar wij jij zij hij ik deze dit dat',
    pt: 'o os as um uma e ou mas é são está com para por sem em do da dos das no na não mais muito como que quem nós vocês eles ela eu você seu sua este esta também',
    sv: 'och eller men är var har hade blir inte ingen med för på av till från vid som också bara nu här mer mycket hur vad vem var vi ni de han hon den det jag du min din vår detta',
    nb: 'og eller men er var har hadde blir ikke ingen med for på av til fra ved som også bare nå her mer veldig hvordan hva hvem hvor vi dere de han hun den det jeg du min din vår dette',
    da: 'og eller men er var har havde bliver ikke ingen med for på af til fra ved som også kun nu her mere meget hvordan hvad hvem hvor vi de han hun den det jeg du min din vores dette',
    pl: 'i lub ale jest są był z dla na w do od przez nie bez też tylko już tu więcej bardzo jak co kto gdzie my wy oni ona on ja ty ten ta to',
  }).map(([lang, words]) => [lang, new Set(words.split(' '))]),
);

// Letters a language writes and its likely neighbours here don't: a hint, not a verdict.
const LETTERS: Record<string, RegExp> = {
  de: /[äöüß]/,
  fr: /[éèêëàâçœîïôûù]/,
  es: /[ñ¿¡áéíóú]/,
  pt: /[ãõçáâêôà]/,
  sv: /[åäö]/,
  nb: /[æøå]/,
  da: /[æøå]/,
  pl: /[ąćęłńśźż]/,
  it: /[àèéìòù]/,
};

/** "de-DE" → "de", "zh-Hans" → "zh". */
export const baseLang = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0] ?? '';

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 2);

export interface TextLanguageOptions {
  /** The languages the work is in, the most likely first: the transcript's, then the account's, then the server's. */
  preferred?: readonly (string | null | undefined)[];
  /** An engine's guesses, language → probability (macOS NaturalLanguage, the dictionaries' share of known words). */
  detected?: Readonly<Record<string, number>> | null;
}

/** The language `text` is in, or null when nothing says. Never a language outside `preferred` and the dictionaries'
 * unless the sample is long (`LONG_SAMPLE` distinct words), the engine is sure of it (`SURE`) and the words agree. */
export function textLanguage(text: string, { preferred = [], detected = null }: TextLanguageOptions = {}): string | null {
  const words = wordsOf(text);
  if (!words.length) return null;
  const expected = [...new Set(preferred.filter((l): l is string => !!l).map(baseLang))].filter(Boolean);
  const candidates = [...new Set([...expected, ...DICTIONARY_LANGS])];
  const guesses = new Map<string, number>();
  for (const [code, p] of Object.entries(detected ?? {})) {
    const l = baseLang(code);
    if (l && Number.isFinite(p)) guesses.set(l, Math.max(guesses.get(l) ?? 0, p));
  }
  const lower = text.toLowerCase();
  const evidence = (l: string): number => {
    const fw = FUNCTION_WORDS[l];
    const share = fw ? words.filter((w) => fw.has(w)).length / words.length : 0;
    const letters = LETTERS[l]?.test(lower) ? 0.2 : 0;
    return share + letters + 0.25 * (guesses.get(l) ?? 0);
  };
  // candidates in order: on a tie the one the work is expected in wins
  let best = candidates[0] as string;
  for (const l of candidates) if (evidence(l) > evidence(best)) best = l;
  const top = [...guesses].sort((a, b) => b[1] - a[1])[0];
  if (top && !candidates.includes(top[0]) && top[1] >= SURE && new Set(words).size >= LONG_SAMPLE && evidence(top[0]) > evidence(best)) return top[0];
  if (evidence(best) > 0) return best;
  return expected[0] ?? null;
}

/** The languages the spell check reads the words in: the text's, then the dictionaries every engine has. */
export const spellLanguages = (lang: string | null): string[] => [...new Set([...(lang ? [lang] : []), ...DICTIONARY_LANGS])];

/** The language an Auto-check result may name. A result from before this rule (no `spelling.languages`) came from an
 * unchecked guess: only a dictionary's language is trusted from it. */
export function shownTextLanguage(result: { text_language?: string | null; spelling?: { languages?: string[] } } | null | undefined): string | null {
  const lang = result?.text_language || null;
  if (!lang) return null;
  return result?.spelling?.languages || DICTIONARY_LANGS.includes(baseLang(lang)) ? lang : null;
}
