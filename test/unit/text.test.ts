// Text engines of the pre-review without the engines themselves: tesseract TSV → Vision-shaped lines, hunspell's
// pipe output, the compound/guess rules, and the engine choice when nothing is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// A fake hunspell: knows a handful of words, suggests like the real one (-a pipe protocol).
const fake = path.join(dir, 'hunspell');
fs.writeFileSync(
  fake,
  `#!/usr/bin/env node
const known = new Set(['Hintergrund', 'hell', 'ist', 'zu', 'Geburtstag', 'Kuchen', 'kuchen', 'Event', 'kosten', 'Kosten', 'the', 'logo']);
if (process.argv.includes('-D')) { console.error('AVAILABLE DICTIONARIES (path is not mandatory for -d option):\\n/usr/share/hunspell/de_DE\\n/usr/share/hunspell/en_US'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const out = ['@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.2)'];
  for (const line of input.split('\\n').filter(Boolean)) {
    const w = line.replace(/^\\^/, '');
    if (known.has(w)) out.push('*');
    else if (w === 'Hintergrnud') out.push('& Hintergrnud 2 0: Hintergrunde, Hintergrund');
    else out.push('# ' + w + ' 0');
    out.push('');
  }
  process.stdout.write(out.join('\\n') + '\\n');
});
`,
);
fs.chmodSync(fake, 0o755);
process.env.VR_HUNSPELL = fake;
const { tsvToPage } = await import('../../lib/text/tesseract.ts');
const { checkWords, dictionaryShares, hunspellDictionaries, hunspellSpell, bestGuess } = await import('../../lib/text/hunspell.ts');
const { distance, matchCase } = await import('../../lib/text/words.ts');

test('tesseract TSV becomes lines with normalised word boxes and 0–1 confidence', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t',
    '4\t1\t1\t1\t1\t0\t100\t50\t300\t40\t-1\t',
    '5\t1\t1\t1\t1\t1\t100\t50\t120\t40\t96.5\tHallo',
    '5\t1\t1\t1\t1\t2\t240\t52\t160\t38\t91.5\tWelt!',
    '5\t1\t2\t1\t1\t1\t500\t400\t50\t20\t-1\t ',
    '5\t1\t3\t1\t1\t1\t600\t450\t100\t25\t80\tUnten',
  ].join('\n');
  const page = tsvToPage('/f.jpg', tsv);
  assert.equal(page.width, 1000);
  assert.equal(page.lines.length, 2);
  const [a, b] = page.lines;
  assert.equal(a.text, 'Hallo Welt!');
  assert.equal(a.conf, 0.94);
  assert.deepEqual(a.box, { x: 0.1, y: 0.1, w: 0.3, h: 0.08 });
  assert.deepEqual(
    a.words?.map((w) => w.text),
    ['Hallo', 'Welt!'],
  );
  assert.equal(b.text, 'Unten');
});

test('hunspell: dictionaries found, pipe output parsed (ok, suggestions, unknown)', async () => {
  assert.deepEqual(await hunspellDictionaries(), ['de_DE', 'en_US']);
  const r = await checkWords(['hell', 'Hintergrnud', 'Qwrtz'], ['de_DE', 'en_US']);
  assert.deepEqual(r.get('hell'), { ok: true, suggestions: [] });
  assert.deepEqual(r.get('Hintergrnud'), { ok: false, suggestions: ['Hintergrunde', 'Hintergrund'] });
  assert.deepEqual(r.get('Qwrtz'), { ok: false, suggestions: [] });
});

test('hunspell spelling: case variants, German compounds with a linking s, closest guess', async () => {
  const spell = hunspellSpell(['de_DE', 'en_US']);
  const r = await spell(['HELL', 'Geburtstagskuchen', 'Eventkosten', 'Hintergrnud'], 'Der Hintergrund ist zu hell');
  assert.equal(r.verdicts.HELL.ok, true);
  assert.equal(r.verdicts.Geburtstagskuchen.ok, true);
  assert.equal(r.verdicts.Eventkosten.ok, true);
  assert.deepEqual(r.verdicts.Hintergrnud, { ok: false, guess: 'Hintergrund' });
});

test('hunspell guesses the language by what share of the words each dictionary knows (lib/text/language.ts weighs it)', async () => {
  // the fake knows the same words in both: a tie, which the language rules settle by the words themselves
  assert.deepEqual(await dictionaryShares('Der Hintergrund ist zu hell', ['de_DE', 'en_US']), { de: 0.75, en: 0.75 });
  assert.equal(await dictionaryShares('12 · 34', ['de_DE']), null);
  // the speller leaves the language to those rules: no guess of its own
  assert.equal((await hunspellSpell(['de_DE', 'en_US'])(['hell'], 'hell', ['de', 'en'])).lang, null);
});

test('distance counts a swap as one edit; guesses keep the first letter on a tie; case follows the word', () => {
  assert.equal(distance('Skincrae', 'skincare'), 1);
  assert.equal(distance('Hintergrnud', 'Hintergrund'), 1);
  assert.equal(bestGuess('Hintergrnud', ['Hintergrunde', 'Hintergrund']), 'Hintergrund');
  assert.equal(bestGuess('xyz', []), null);
  assert.equal(matchCase('Skincrae', 'skincare'), 'Skincare');
  assert.equal(matchCase('LOGO', 'logo'), 'LOGO');
  assert.equal(matchCase('logo', 'logo'), 'logo');
});

test('no engines installed: text checks are skipped with a reason, not an error', {
  skip: process.platform === 'darwin' && 'a Mac always has Vision',
}, async () => {
  process.env.VR_TESSERACT = path.join(dir, 'no-such-tesseract');
  process.env.VR_HUNSPELL = path.join(dir, 'no-such-hunspell');
  const { textTools } = await import('../../lib/text/index.ts');
  const t = await textTools('auto');
  assert.equal(t.ocr, null);
  assert.equal(t.spell, null);
  assert.match(t.notes.join(' '), /install tesseract/);
});
