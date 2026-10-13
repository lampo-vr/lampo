// Which files of an area a `lampo files pull` names (docs/files.md "Agents"): paths and globs as the app's Copy for an
// agent hands them out (`--only 'Music/**' --only 'Footage/Day 1/A001.mov'`). Matched like the area's own paths: a
// path that differs only in case is the same place (lib/fileText.ts caseKey). Browser-safe: no Node imports.
import { caseKey } from './fileText.ts';

/** A pattern as given: `./` in front and `/` at its end said nothing more than the path itself. */
const tidy = (p: string): string => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/** True when a pattern names exactly one path (no `*`, `?`): a file, or a folder and everything in it. */
export const isExactPattern = (p: string): boolean => !/[*?]/.test(p);

/** One name of a pattern as a regular expression: `*` any run inside a name, `?` one character, anything else as is. */
function nameRegex(name: string): RegExp {
  const src = [...name].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[\\^$.|+()[\]{}]/g, '\\$&'))).join('');
  return new RegExp(`^${src}$`, 'u');
}

/**
 * A matcher for patterns: `*` and `?` inside a name, `**` for any number of names (none too), a pattern without them
 * the path itself or a folder of that name with everything in it. `match(path)` is the index of the first pattern that
 * takes it, else -1.
 */
export function globMatcher(patterns: readonly string[]): { match(path: string): number } {
  const compiled = patterns.map((raw) => {
    const p = caseKey(tidy(raw));
    if (isExactPattern(p)) return { exact: p };
    const names = p.split('/').map((n) => (n === '**' ? null : nameRegex(n)));
    return { names };
  });
  const walk = (names: (RegExp | null)[], parts: string[], i: number, j: number): boolean => {
    if (i === names.length) return j === parts.length;
    const n = names[i];
    if (n === null) {
      for (let k = j; k <= parts.length; k++) if (walk(names, parts, i + 1, k)) return true;
      return false;
    }
    return j < parts.length && n.test(parts[j] as string) && walk(names, parts, i + 1, j + 1);
  };
  return {
    match(path) {
      const key = caseKey(path);
      const parts = key.split('/');
      for (const [i, c] of compiled.entries()) {
        if ('exact' in c) {
          if (c.exact === '' || key === c.exact || key.startsWith(`${c.exact}/`)) return i;
        } else if (walk(c.names, parts, 0, 0)) return i;
      }
      return -1;
    },
  };
}
