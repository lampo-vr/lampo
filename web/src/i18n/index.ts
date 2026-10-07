// The UI's words, in English and German. gettext style: the English text is the key (`t('Add video')`), so the code
// reads as it did and English needs no dictionary at runtime; German is a separate chunk, loaded before the app starts
// when it is the page's language (main.tsx) and before the words change when someone switches (loadLang).
//
// A switch happens in place: the other language's words load while the page stays as it is, then the store says so and
// the app renders again in one pass (boot.tsx's root, memo'd components and <T> subscribe through useLang in T.tsx).
// So nothing may work words out once and keep them: labels outside a component go through `perLang`, a memo'd
// component calls useLang(), and a useMemo whose result has words in it lists the language among its dependencies
// (test/unit/i18n.test.ts finds the first two kinds).
//
// - Every key is listed in en.ts (the source of truth); de.ts must translate every one (a missing German key is a type
//   error), and test/unit/i18n.test.ts keeps en.ts in step with the t() / <T> calls in the code.
// - `{name}` placeholders take params; a plural is 'one|other' and picks a form by the `n` param.
// - A context prefix keeps words apart that German says differently: 'client::…' are the client pages (their own
//   file, de.client.ts, which addresses the reader as "Sie"; the owner app says "du").
// - Rich text (<b>, <code>, links inside a sentence) goes through <T> (T.tsx) with numbered tags: 'Press <0>C</0>'.
// - Agent-facing text (lampo, MCP, INBOX.md, events) is never translated: it is a data contract.
import { LANG_KEY, type Lang, pickLang } from '../../../lib/themeBoot.ts';
import type { Key } from './en.ts';

export type { Key, Lang };
export type Params = Record<string, string | number | null | undefined>;

// Also imported by unit tests in Node: reach the browser through globalThis, typed by what is used.
interface Env {
  document?: { documentElement: { lang: string } };
  navigator?: { languages?: readonly string[]; language?: string };
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  addEventListener?: (type: 'storage', l: (e: { key: string | null; newValue: string | null }) => void) => void;
}
const env = globalThis as unknown as Env;
const languages = (): readonly string[] => env.navigator?.languages || [env.navigator?.language || ''];

let lang: Lang = 'en';
let dict: Readonly<Record<string, string>> | null = null;
// Bumped whenever the words change (a switch, or a test's setDictionary): what perLang made before is made again.
let generation = 0;
const listeners = new Set<() => void>();

/** The language on screen. */
export const currentLang = (): Lang => lang;

/** Calls `l` after the words on screen changed language (useLang in T.tsx); returns the unsubscribe. */
export function subscribeLang(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A value with words in it that lives outside a component (a module's labels, options, help rows): made on first
 * use and made again after a language switch, the same object meanwhile. `const KINDS = perLang(() => […])`, read as
 * `KINDS()` while rendering. */
export function perLang<T>(make: () => T): () => T {
  let made: T;
  let madeAt = -1;
  return () => {
    if (madeAt !== generation) {
      made = make();
      madeAt = generation;
    }
    return made;
  };
}

/** The locale for Intl formatting: German, or the browser's own English variant (dates in en-GB stay en-GB). */
export function locale(): string {
  if (lang === 'de') return 'de-DE';
  return languages().find((l) => l.toLowerCase().startsWith('en')) || 'en-US';
}

/** The language index.html decided on before the first paint (lib/themeBoot.ts), or the same rule outside a page. */
export function detectLang(): Lang {
  const shown = env.document?.documentElement.lang;
  if (shown === 'de' || shown === 'en') return shown;
  let stored: string | null = null;
  try {
    stored = env.localStorage?.getItem(LANG_KEY) ?? null;
  } catch {}
  return pickLang(stored);
}

const words = (l: Lang): Promise<Readonly<Record<string, string>> | null> => (l === 'de' ? import('./de.ts').then((m) => m.de) : Promise.resolve(null));

/** Starts fetching `l`'s words without showing them (a pointer on the language switch): the switch is then instant. */
export function preloadLang(l: Lang): void {
  void words(l).catch(() => {});
}

function use(l: Lang, w: Readonly<Record<string, string>> | null): void {
  if (l === lang && w === dict) return;
  lang = l;
  dict = w;
  generation++;
  if (env.document) env.document.documentElement.lang = l;
  for (const f of listeners) f();
}

let asked = 0;
/** Shows `l`: its words load first (German is its own chunk) while the page stays as it is, then every word on screen
 * changes in one render. Before the app starts (main.tsx), this is the page's language. A later call wins over an
 * earlier one still loading; a failed load leaves the language as it was (and rejects). */
export async function loadLang(l: Lang): Promise<void> {
  const ticket = ++asked;
  let w: Awaited<ReturnType<typeof words>>;
  try {
    w = await words(l);
  } catch (e) {
    if (ticket === asked) throw e;
    return;
  }
  if (ticket === asked) use(l, w);
}

// Another tab of the app switched (the choice is this device's): this one follows, in place too.
env.addEventListener?.('storage', (e) => {
  if (e.key === LANG_KEY) loadLang(pickLang(e.newValue)).catch(() => {});
});

/**
 * A page that shows only visitors' words (an Embed link's player, web/src/embed/): `l` with the visitor pages' German
 * alone (de.client.ts), not the app's whole dictionary. Its keys are `client::` ones.
 */
export async function loadClientLang(l: Lang): Promise<void> {
  use(l, l === 'de' ? (await import('./de.client.ts')).client : null);
}

/** For tests: use these words directly. */
export function setDictionary(l: Lang, w: Readonly<Record<string, string>> | null): void {
  use(l, w);
  generation++;
}

const CONTEXT = /^[a-z]+::/;
/** 'client::Save' → 'Save': the English text of a key. */
export const english = (key: string): string => key.replace(CONTEXT, '');

let rules: Intl.PluralRules | null = null;
let rulesFor = '';
/** 'one|other' → the form for n. */
export function plural(message: string, n: number): string {
  const bar = message.indexOf('|');
  if (bar < 0) return message;
  if (rulesFor !== lang) {
    rules = new Intl.PluralRules(locale());
    rulesFor = lang;
  }
  return rules?.select(n) === 'one' ? message.slice(0, bar) : message.slice(bar + 1);
}

const number = (v: number) => (Number.isInteger(v) && Math.abs(v) < 10000 ? String(v) : v.toLocaleString(locale()));

/** Fills `{name}` placeholders; unknown ones stay as they are (a missing param is visible, not silently empty). */
export function fill(message: string, params?: Params): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? (typeof params[name] === 'number' ? number(params[name]) : String(params[name] ?? '')) : m,
  );
}

/** The words for `key` in the current language, with the plural form picked but no placeholders filled (for <T>). */
export function message(key: Key, n?: number): string {
  const m = dict?.[key] ?? english(key);
  return m.includes('|') ? plural(m, n ?? 0) : m;
}

/** The words for `key` in the current language. */
export function t(key: Key, params?: Params): string {
  return fill(message(key, Number(params?.n ?? 0)), params);
}

function keep(p: Lang | 'auto'): void {
  try {
    if (p === 'auto') env.localStorage?.removeItem(LANG_KEY);
    else env.localStorage?.setItem(LANG_KEY, p);
  } catch {}
}

/** Stores this device's choice ('auto' and 'en' = English; the pre-paint script reads it on the next load) and
 * switches the page to it in place (loadLang). When the words don't arrive, the page and the stored choice stay as they
 * were (and it rejects). The account copy is the caller's business (LangSwitch). */
export async function setLangPref(p: Lang | 'auto'): Promise<void> {
  const before = langPref();
  keep(p);
  try {
    await loadLang(p === 'de' ? 'de' : 'en');
  } catch (e) {
    if (langPref() === p) keep(before);
    throw e;
  }
}

/** This device's stored choice. */
export function langPref(): Lang | 'auto' {
  try {
    const v = env.localStorage?.getItem(LANG_KEY);
    if (v === 'en' || v === 'de') return v;
  } catch {}
  return 'auto';
}
