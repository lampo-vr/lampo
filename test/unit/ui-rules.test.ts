// Rules for the UI's markup that are easy to break and hard to see in a quick look.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const WEB = path.join(import.meta.dirname, '../../web/src');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));

test('film grain never sits on a scrolling box (its overlay would end after one screen and leave an edge)', () => {
  const offenders: string[] = [];
  for (const f of files(WEB))
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/className=["{`]([^"}`]*)["}`]/g)) {
      const cls = m[1].split(/\s+/);
      if (cls.includes('grain') && cls.some((c) => /scroll/.test(c))) offenders.push(`${path.relative(WEB, f)}: ${m[1]}`);
    }
  assert.deepEqual(offenders, [], 'put grain on the fixed parent instead');
});

const source = (f: string) => fs.readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(WEB, f);

test('icon-only buttons are IconButtons (a name and a tooltip, always), outside the primitives themselves', () => {
  const offenders: string[] = [];
  for (const f of files(WEB)) {
    if (rel(f).startsWith('ui/')) continue;
    for (const m of source(f).matchAll(/<button\b[^>]*className=["{`][^"}`]*\bicon-only\b/g)) offenders.push(`${rel(f)}: ${m[0].slice(0, 90)}`);
  }
  assert.deepEqual(offenders, [], 'use <IconButton label="…" icon="…"> from ui/primitives.tsx');
});

test('icons come from ui/icons.tsx only (one set, one stroke rule)', () => {
  // ui/kindIcons.tsx: the project files' kinds, drawn by the same rule, kept out of the start (only the Files screens use them)
  const offenders = files(WEB).filter((f) => !['ui/icons.tsx', 'ui/kindIcons.tsx'].includes(rel(f)) && source(f).includes("from 'lucide-react'"));
  assert.deepEqual(offenders.map(rel), [], 'add a name to ui/icons.tsx instead');
});

test('no browser dialogs: confirm() and alert() block the page; use Confirm (an alert dialog) or a toast', () => {
  // a method of some other object (a payment provider's `actions.confirm(…)`) is no browser dialog; `window.confirm(` is
  const dialog = /(^|[^.\w$])(confirm|alert|prompt)\(|\bwindow\.(confirm|alert|prompt)\(/m;
  const offenders = files(WEB).filter((f) => dialog.test(source(f).replace(/\/\/.*$/gm, '')));
  assert.deepEqual(offenders.map(rel), []);
  // the rule still sees the dialogs it is for
  for (const call of ['confirm("Delete?")', 'window.alert(x)', '  prompt(`Name`)', 'if (!confirm(t("…")))']) assert.ok(dialog.test(call), call);
  for (const call of ['actions.confirm({ redirect })', 'stripe.confirmPayment(o)', 'onConfirm()']) assert.ok(!dialog.test(call), call);
});

test('no var() in a keyframe’s timing function: Safari ignores it there and runs the segment linear', () => {
  const bad: string[] = [];
  for (const f of fs.globSync('styles/*.css', { cwd: WEB })) {
    const css = fs.readFileSync(path.join(WEB, f), 'utf8');
    for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g))
      if (/animation-timing-function\s*:\s*var\(/.test(block[2])) bad.push(`${f} @keyframes ${block[1]}`);
  }
  assert.deepEqual(bad, [], 'spell the curve out (cubic-bezier(…)) inside @keyframes, or time the element instead');
});

test('one class, one thing: a class name on an icon is not also the name of something else a stylesheet styles', () => {
  // Icons carry extra classes (<I name="spark" className="spark" />). Insights named its sparkline .spark too (display
  // block, width 100 %): once that page's CSS was loaded, every sparkle icon stretched across its row and squeezed the
  // agent menu's labels to nothing. A class that only ever sits on icons may be styled bare; one that is shared may not.
  const iconClasses = new Set<string>();
  const otherClasses = new Set<string>();
  for (const f of files(WEB)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<(\w+)\b[^>]*?\bclassName="([^"]+)"/g)) for (const c of m[2].split(/\s+/)) (m[1] === 'I' ? iconClasses : otherClasses).add(c);
  }
  // Utilities are meant to go on anything (a colour, a flex grow, a spin).
  const UTILITIES = new Set(['faint', 'muted', 'grow', 'mono', 'ellipsis', 'spin']);
  const STYLES = path.join(WEB, 'styles');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(STYLES).filter((n) => n.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of css.matchAll(/(^|[}\n])\s*([^{}@]+)\{/g))
      for (const part of sel[2].split(',').map((x) => x.trim())) {
        const m = part.match(/^\.([\w-]+)$/);
        if (m && iconClasses.has(m[1]) && otherClasses.has(m[1]) && !UTILITIES.has(m[1])) offenders.push(`${f}: ${part}`);
      }
  }
  assert.deepEqual(offenders, [], 'give the other element its own class name, or scope the rule to its page');
});

// The words of a template literal, what is left once its `${…}` (and the templates inside them) are taken out.
function literalWords(src: string, i: number): string {
  let out = '';
  const skipTemplate = (j: number): number => {
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') return j + 1;
      else if (src[j] === '$' && src[j + 1] === '{') j = skipExpr(j + 2);
      else j++;
    }
    return j;
  };
  const skipExpr = (j: number): number => {
    for (let depth = 1; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '`') j = skipTemplate(j + 1) - 1;
      else if (c === "'" || c === '"') {
        for (j++; j < src.length && src[j] !== c; j++) if (src[j] === '\\') j++;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    return j;
  };
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      out += src[i + 1];
      i += 2;
    } else if (src[i] === '$' && src[i + 1] === '{') i = skipExpr(i + 2);
    else out += src[i++];
  }
  return out;
}

test('words a person reads in a title or label go through t(), also inside a template (A12 INV-11)', () => {
  // FilmList's notes count said "3 open, 1 must" in English in a German UI, and "must" where the vocabulary says
  // "must-fix": a tooltip built from a template with words of its own.
  const offenders: string[] = [];
  for (const f of files(WEB)) {
    if (rel(f).startsWith('styleguide/')) continue;
    const src = source(f);
    for (const m of src.matchAll(/\b(title|aria-label|placeholder|alt)=\{`/g)) {
      const words = literalWords(src, (m.index ?? 0) + m[0].length);
      if (/\p{L}{3,}/u.test(words)) offenders.push(`${rel(f)}: ${m[1]} "${words.trim()}"`);
    }
  }
  assert.deepEqual(offenders, [], 'put the words in t(…) with placeholders');
});
