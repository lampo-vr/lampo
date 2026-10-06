// The UI's languages: the catalog matches the code, German translates every key with the same placeholders and plural
// forms and no English left over, t()/<T> fill and pick forms, the pre-paint script picks the same language as the
// app does, and nothing keeps words from before a switch (module-level words, memo'd components that don't follow it).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSync } from 'vite';
import { LANG_KEY, pickLang, THEME_BOOT } from '../../lib/themeBoot.ts';
import { catalog, definedKeys, usedKeys } from '../../scripts/i18n.ts';
import { de } from '../../web/src/i18n/de.ts';
import { EN } from '../../web/src/i18n/en.ts';
import { english, message, perLang, setDictionary, t } from '../../web/src/i18n/index.ts';
import { rich } from '../../web/src/i18n/rich.ts';

const I18N = path.join(import.meta.dirname, '../../web/src/i18n');

test('en.ts lists exactly the keys the code uses (npm run i18n)', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(path.join(I18N, 'en.ts'), 'utf8'), catalog(usedKeys()), 'run `npm run i18n` after changing UI text');
});

test('German translates every key once, in the right file', () => {
  const owner = definedKeys(path.join(I18N, 'de.ts'));
  const client = definedKeys(path.join(I18N, 'de.client.ts'));
  assert.deepEqual([...owner, ...client].sort(), [...EN].sort(), 'every key, no extras');
  assert.ok(client.every((k) => k.startsWith('client::')) && owner.every((k) => !k.startsWith('client::')), 'client pages in de.client.ts');
});

const marks = (s: string) => (s.match(/\{\w+\}|<\/?\d+>/g) ?? []).sort();
test('a "|" only ever separates the two plural forms (any other one cuts the text in half on screen)', () => {
  for (const key of EN) assert.ok(english(key).split('|').length <= 2, `more than one "|": ${key}`);
});
test('German keeps every placeholder, tag and plural form', () => {
  for (const key of EN) {
    const en = english(key);
    const g = de[key];
    assert.equal(g.split('|').length, en.split('|').length, `plural forms: ${key}`);
    for (const [e, d] of en.split('|').map((form, i) => [form, g.split('|')[i] as string]))
      assert.deepEqual([...new Set(marks(d))], [...new Set(marks(e))], `placeholders and tags: ${key} → ${g}`);
    assert.equal(/^\s/.test(g), /^\s/.test(en), `leading space: ${key}`);
    assert.equal(/\s$/.test(g), /\s$/.test(en), `trailing space: ${key}`);
  }
});

// Words that give away an untranslated English phrase. Code, commands and names stay as they are.
const ENGLISH = /(?<!\p{L})(the|and|with|your|you|this|that|from|into|not|what|which|when|there|here|will|would|should|could|have|been|every|only)(?!\p{L})/iu;
const VERBATIM = /<\d+>[^<]*<\/\d+>|vr [a-z-]+(?: [^\s,.;:)]+)*|--[a-z-]+|[\w.+-]+@[\w.-]+|[A-Z_]{3,}|https?:\S+|\{\w+\}/g;
test('no English left in the German', () => {
  const left = EN.filter((k) => ENGLISH.test(de[k].replace(VERBATIM, ' ')));
  assert.deepEqual(left, [], `untranslated: ${left.map((k) => `${k} → ${de[k]}`).join('\n')}`);
});

// A12-D4: a link that shows the notes from all links shows a note from any link on the video, with its writer's name.
// Where the visitor's page asks for the name it says who sees the notes, and never that only this link's visitors do.
test('the client page says who sees a client’s notes', () => {
  const said = EN.filter((k) => k.startsWith('client::') && /knows who wrote each note/.test(k));
  assert.ok(said.length > 0, 'the name prompt');
  for (const k of said) {
    assert.doesNotMatch(english(k), /only people with this link/i, k);
    assert.match(english(k), /team sees your notes|They see your notes/, k);
    assert.match(english(k), /this link or another that shows the notes from all links/, k);
  }
});

// AGENTS.md "Vocabulary": a *Version*, never "a render"; a *Note*, never "comment"; a fix is *checked*, never
// "verified"; *Approve* / *Request changes*, never "verdict" or "sign-off" — in German too (de.ts's header). "render" as
// a verb stays; each such key is named here, so a new one is read before it ships (A12 INV-11).
const RENDER_THE_VERB = new Set([
  '{n} fix checked on a preview · V{w} to render|{n} fixes checked on a preview · V{w} to render',
  'Quick check: render only this part',
  'Quick check: render only this part ({stretch})',
  'Quick check: render only this part (finding the shots…)',
  'Render it in full for final',
  'Render the fixes checked on previews',
  'The motion doesn’t match at {tc} — render the next shot too, or the whole video',
  // the first run: an agent that renders the next version
  'It reads your notes, fixes the video and renders the next version. Pick it, and connect it right here.',
  'Pin a note to the exact frame. Your agent fixes it and renders V2. <0>You check before and after.</0>',
]);
// The OAuth consent screen: an app's own claim about itself is "not verified" — not a fix being checked.
const APP_NOT_VERIFIED = /: not verified\. Continue only if/;
test('UI text keeps to the vocabulary, English and German', () => {
  const off: string[] = [];
  for (const key of EN) {
    const en = english(key).replace(/\{\w+\}/g, '{}'); // placeholders are names in code, not words on screen
    if (/\brenders?\b/i.test(en) && !RENDER_THE_VERB.has(key)) off.push(`render: ${key}`);
    if (/\bcomment/i.test(en)) off.push(`comment: ${key}`);
    if (/\bverif/i.test(en) && !APP_NOT_VERIFIED.test(en)) off.push(`verify: ${key}`);
    if (/\bverdict|\bsign-off/i.test(en)) off.push(`verdict: ${key}`);
    if (/\bRenders?\b/.test(de[key])) off.push(`Render: ${key} → ${de[key]}`);
    if (/kommentier|Kommentar/i.test(de[key])) off.push(`kommentieren: ${key} → ${de[key]}`);
  }
  assert.deepEqual(off, [], 'a Version, a Note, checked, Approve (AGENTS.md "Vocabulary")');
});

test('t(): placeholders, plurals, contexts, and the German words', () => {
  setDictionary('en', null);
  assert.equal(t('{n} note|{n} notes', { n: 1 }), '1 note');
  assert.equal(t('{n} note|{n} notes', { n: 3 }), '3 notes');
  assert.equal(t('client::Download all'), 'Download all', 'the context never shows');
  assert.equal(t('Open {video}', {}), 'Open {video}', 'a missing param stays visible');
  setDictionary('de', de);
  assert.equal(t('{n} note|{n} notes', { n: 1 }), '1 Notiz');
  assert.equal(t('{n} note|{n} notes', { n: 2 }), '2 Notizen');
  assert.equal(t('client::Download all'), 'Alle herunterladen');
  assert.equal(t('Approved V{v}', { v: 6 }), 'V6 freigegeben');
  setDictionary('en', null);
});

test('<T>: numbered tags and placeholders in the order the language wants', () => {
  setDictionary('de', de);
  const html = renderToStaticMarkup(
    createElement('p', null, rich(message('Try again in <0>{label}</0>.'), { label: '04:12' }, [(c) => createElement('b', null, c)])),
  );
  assert.equal(html, '<p>Versuch es in <b>04:12</b> erneut.</p>');
  setDictionary('en', null);
});

/** Runs the pre-paint script with a stored choice and browser languages; returns <html lang>. */
function boot(stored: string | null, languages: string[]): string {
  const html = { lang: '', setAttribute: () => {} };
  const context = {
    localStorage: { getItem: (k: string) => (k === LANG_KEY ? stored : null) },
    navigator: { languages, language: languages[0] ?? '' },
    window: { matchMedia: null },
    matchMedia: null,
    document: { documentElement: html, querySelector: () => null },
  };
  vm.runInNewContext(THEME_BOOT, context);
  return html.lang;
}

test('the pre-paint script and the app pick the same language', () => {
  const cases: [string | null, string[]][] = [
    [null, ['de-DE', 'en']],
    [null, ['en-GB', 'de']],
    [null, ['fr-FR', 'de-AT']],
    [null, ['fr-FR']],
    [null, []],
    ['de', ['en-US']],
    ['en', ['de-DE']],
    ['xx', ['de-CH']],
  ];
  for (const [stored, languages] of cases) assert.equal(boot(stored, languages), pickLang(stored, languages), `${stored} ${languages.join(',')}`);
  assert.equal(pickLang(null, ['de-DE', 'de']), 'en', 'a German browser still starts in English');
  assert.equal(pickLang('de', ['en-US']), 'de', 'German once chosen in Settings');
  assert.equal(pickLang('auto', ['de-DE']), 'en', 'an old "auto" choice means English now');
});

test('perLang makes its words again after a switch, and keeps the same object meanwhile', () => {
  setDictionary('en', null);
  const labels = perLang(() => ({ add: t('Add video') }));
  const first = labels();
  assert.equal(labels(), first, 'the same object while the language stays');
  setDictionary('de', de);
  assert.equal(labels().add, 'Video hinzufügen');
  assert.notEqual(labels(), first);
  setDictionary('en', null);
  assert.equal(labels().add, 'Add video');
});

// A language switch renders the app again in place (i18n/index.ts, boot.tsx): words worked out while a module loads, or
// inside a memo'd component that doesn't follow the language, would stay as they were. Labels outside a component go
// through perLang; a memo'd component calls useLang().
const WEB = path.join(import.meta.dirname, '../../web/src');
// Calls that are fine at a module's top level: the language machinery itself, and English keys.
const MACHINERY = new Set(['perLang', 'subscribeLang', 'english', 'preloadLang', 'loadLang', 'detectLang', 'setDictionary', 'langPref', 'setLangPref']);
type Node = { type: string; start: number; end: number; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';
function walk(node: unknown, visit: (n: Node) => boolean | undefined): void {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit);
    return;
  }
  if (!isNode(node) || visit(node) === false) return;
  for (const [k, v] of Object.entries(node)) if (k !== 'type' && k !== 'start' && k !== 'end' && v && typeof v === 'object') walk(v, visit);
}
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const calleeName = (n: Node): string => {
  const c = n.callee as Node & { name?: string; property?: Node & { name?: string } };
  return c.type === 'Identifier' ? (c.name ?? '') : c.type === 'MemberExpression' ? (c.property?.name ?? '') : '';
};
async function sourcesOf(dir: string): Promise<string[]> {
  const fs = await import('node:fs');
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/i18n\/(en|de|de\.client)\.ts$/.test(f))
    .map((f) => path.join(dir, f));
}

test('no words are worked out when a module loads, and every memo’d component follows the language', async () => {
  const fs = await import('node:fs');
  const early: string[] = [];
  const deaf: string[] = [];
  for (const file of await sourcesOf(WEB)) {
    const code = fs.readFileSync(file, 'utf8');
    const { program, errors } = parseSync(file, code, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
    assert.equal(errors.length, 0, `${file} parses`);
    // What the module imports from the words: i18n/index.ts, terms.ts, status/stageText.ts.
    const words = new Set<string>();
    walk(program, (n) => {
      if (n.type !== 'ImportDeclaration') return;
      const from = String((n.source as { value: string }).value);
      if (!/i18n\/(index|terms)\.ts$|stageText\.ts$/.test(from)) return false;
      for (const s of n.specifiers as { local: { name: string } }[]) if (!MACHINERY.has(s.local.name)) words.add(s.local.name);
      return false;
    });
    const where = (n: Node) => `${path.relative(WEB, file)}:${code.slice(0, n.start).split('\n').length}`;
    if (words.size)
      walk(program, (n) => {
        if (FUNCTION.has(n.type)) return false;
        if (n.type === 'CallExpression' && words.has(calleeName(n))) early.push(`${where(n)} ${code.slice(n.start, n.end).slice(0, 60)}`);
      });
    walk(program, (n) => {
      if (n.type !== 'CallExpression' || calleeName(n) !== 'memo') return;
      const fn = (n.arguments as Node[])[0];
      if (fn && FUNCTION.has(fn.type) && !code.slice(fn.start, fn.end).includes('useLang()')) deaf.push(where(n));
    });
  }
  assert.deepEqual(early, [], 'words at a module’s top level stay in the first language: wrap them in perLang(() => …)');
  assert.deepEqual(deaf, [], 'a memo’d component skips the render a language switch makes: call useLang() in it');
});
