// Stylesheets stay in their lane. The shared sheets (tokens, controls, the design system's families, the app chrome)
// define the global classes; every other sheet belongs to one page or component and only styles its own classes —
// a page sheet that restyles `.menu` or `.btn` on its own changes every menu or button in the app (it happened: a
// page file's global class broke the agent menu). Rules:
//   1. every selector in a scoped sheet names at least one class of that sheet — one it defines, or one no other sheet
//      mentions (`.lib-toolbar .btn` and `.popover.display-pop` are fine; `.btn`, `.btn.ok kbd` or `body` are not: a
//      variant of a shared control lives in controls.css or system.css, page-wide rules in layout.css);
//   2. a class is defined by one sheet: two scoped sheets never both define it (a selector defines the first class of
//      its only compound with classes — `.film.pending` defines film, `.pending` is a state; `.guest .tc` styles tc in
//      the guest page's context and defines nothing).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseCss, type Rule, splitTop, stylesheets } from '../lib/css.ts';

/** The global sheets: they may define shared classes. mobile.css and theme.css override across the app by design. */
const SHARED = new Set(['base.css', 'controls.css', 'primitives.css', 'system.css', 'ui.css', 'layout.css', 'overlays.css', 'status.css']);
const OVERRIDES = new Set(['mobile.css', 'theme.css', 'index.css']);

const name = (f: string) => path.basename(f);
/** The compound selectors of one selector, left to right (`.a .b > .c` → [.a, .b, .c]). */
const compounds = (sel: string) =>
  sel
    .replace(/\s*([>+~])\s*/g, ' ')
    .split(' ')
    .filter(Boolean);
/** Classes a compound names outside :not()/:is()/:has() arguments (those only narrow it down). */
const classesOf = (compound: string) =>
  [...compound.replace(/:(not|is|where|has)\((?:[^()]|\([^()]*\))*\)/g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

const sheets = stylesheets().map((f) => ({ file: f, rules: parseCss(f) }));
/** The class a selector defines: the first class of its only compound with classes (`.film.pending` → film: `.pending`
 * is a state of it; `.hero h1` → hero). A selector with classes in two compounds (`.guest .tc`) styles one class in the
 * context of another and defines neither. */
const defines = (sel: string) => {
  const classed = compounds(sel)
    .map(classesOf)
    .filter((c) => c.length);
  return classed.length === 1 ? classed[0][0] : undefined;
};
const lead = (r: Rule) => r.selectors.map(defines).filter((c): c is string => !!c);

const shared = new Set(sheets.filter((s) => SHARED.has(name(s.file))).flatMap((s) => s.rules.flatMap(lead)));
const scoped = sheets.filter((s) => !SHARED.has(name(s.file)) && !OVERRIDES.has(name(s.file)));
/** What each scoped sheet owns: the classes it defines that no shared sheet defines. */
const owns = new Map(scoped.map((s) => [s.file, new Set(s.rules.flatMap(lead).filter((c) => !shared.has(c)))]));

/** Every class each sheet mentions anywhere (the overrides left out). */
const mentions = new Map<string, Set<string>>();
for (const s of sheets)
  if (!OVERRIDES.has(name(s.file)))
    for (const r of s.rules)
      for (const sel of r.selectors) for (const c of compounds(sel).flatMap(classesOf)) mentions.set(c, (mentions.get(c) ?? new Set()).add(s.file));

test('a page or component stylesheet only styles its own classes (shared classes only inside them)', () => {
  const offenders: string[] = [];
  for (const s of scoped) {
    const defined = owns.get(s.file) ?? new Set();
    const onlyHere = (c: string) => !shared.has(c) && mentions.get(c)?.size === 1;
    const mine = { has: (c: string) => defined.has(c) || onlyHere(c) };
    for (const r of s.rules)
      for (const sel of r.selectors) {
        const classes = compounds(sel).flatMap(classesOf);
        if (!classes.some((c) => mine.has(c))) offenders.push(`${name(s.file)}:${r.line} ${sel}`);
      }
  }
  assert.deepEqual(offenders, [], 'scope the rule under a class of this sheet, or move it to a shared sheet (controls.css, system.css)');
});

test('two stylesheets never define the same class', () => {
  const byClass = new Map<string, string[]>();
  for (const s of scoped) for (const c of owns.get(s.file) ?? []) byClass.set(c, [...(byClass.get(c) ?? []), name(s.file)]);
  const clashes = [...byClass].filter(([, files]) => files.length > 1).map(([c, files]) => `.${c}: ${files.join(', ')}`);
  assert.deepEqual(clashes, [], 'rename one of them (a prefix of its page) or move the shared one to a shared sheet');
});

test('the CSS reader sees every sheet (a parse slip would let the checks above pass on nothing)', () => {
  for (const s of sheets) assert.ok(s.rules.length > 0 || name(s.file) === 'index.css', `${name(s.file)}: no rules read`);
  assert.deepEqual(splitTop('.a:is(.b, .c), .d'), ['.a:is(.b, .c)', '.d']);
  assert.deepEqual(compounds('.a > .b  .c+.d'), ['.a', '.b', '.c', '.d']);
  assert.deepEqual(classesOf('.a.b:not(.c)'), ['a', 'b']);
});
