// A sentence with markup inside it — "Press <0>C</0> to add a note", "Signed in as <0>{email}</0>" — translated as a
// whole, so German can move the parts where German wants them. Numbered tags wrap their text with `tags[i]`;
// `{name}` placeholders take `values` (text or elements). The rendering itself is rich.ts.
import { type ReactNode, useSyncExternalStore } from 'react';
import { currentLang, type Key, type Lang, message, subscribeLang } from './index.ts';
import { rich, type Tags } from './rich.ts';

/** The language on screen, rendering again when it switches. The app's root uses it (a switch renders everything again,
 * in one pass); so does anything that skips that render — a memo'd component — or keeps words in a useMemo (list
 * `lang` among its dependencies). */
export const useLang = (): Lang => useSyncExternalStore(subscribeLang, currentLang, currentLang);

export function T({ k, values = {}, tags = [] }: { k: Key; values?: Record<string, ReactNode>; tags?: Tags }) {
  useLang();
  const n = typeof values.n === 'number' ? values.n : 0;
  return <>{rich(message(k, n), values, tags)}</>;
}
