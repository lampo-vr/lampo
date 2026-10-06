// The language of a render's on-screen text (lib/text/language.ts): German and English captions read as what they are,
// whatever a recogniser guesses for a few words of them; a rare language only for a long sample it is sure of; the
// languages the work is in decide when the words don't; and what a result from before may still name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARY_LANGS, LONG_SAMPLE, shownTextLanguage, spellLanguages, textLanguage } from '../../lib/text/language.ts';

// What macOS NaturalLanguage answered for captions like these (tools/ocr.swift `lang`): short text gets wild guesses.
const GERMAN = 'Jetzt neu\nDie Sommer-Kollektion ist da\nNur für kurze Zeit\nHol dir deinen Rabatt\nLink in Bio';
const ENGLISH = 'New drop\nThe summer collection is here\nOnly for a short time\nGet your discount now\nLink in bio';

test('a German caption reads as German, even when the recogniser says Norwegian Bokmål', () => {
  assert.equal(textLanguage(GERMAN), 'de');
  assert.equal(textLanguage(GERMAN, { detected: { nb: 0.62, da: 0.21, de: 0.12 } }), 'de');
  assert.equal(textLanguage(GERMAN, { detected: { nb: 0.97 } }), 'de', 'a short sample never names a rare language');
  assert.equal(textLanguage(GERMAN, { preferred: ['en'], detected: { nb: 0.9 } }), 'de', 'the words outweigh a preference');
});

test('an English caption reads as English, even when the recogniser says Norwegian Bokmål', () => {
  assert.equal(textLanguage(ENGLISH), 'en');
  assert.equal(textLanguage(ENGLISH, { detected: { nb: 0.55, en: 0.3 } }), 'en');
  assert.equal(textLanguage(ENGLISH, { preferred: ['de'], detected: { nb: 0.95 } }), 'en');
});

test('names and numbers say nothing: the language the work is in, or none', () => {
  const names = 'LAMPO\nSTUDIO\n2026\nKAFFEE\nTEAM';
  // NaturalLanguage: { it: 0.54, … } for these
  assert.equal(textLanguage(names, { detected: { it: 0.54, es: 0.2 } }), null, 'never Italian');
  assert.equal(textLanguage(names, { preferred: ['de'], detected: { it: 0.54 } }), 'de');
  assert.equal(textLanguage('SALE 2026', { preferred: ['en', 'de'] }), 'en');
  assert.equal(textLanguage('SALE 2026', { preferred: [null, 'de-DE', 'en'] }), 'de', 'the transcript has none: the account’s');
  assert.equal(textLanguage('SALE 2026'), null);
  assert.equal(textLanguage('2026 · 00:12', { preferred: ['de'] }), null, 'no words at all');
});

test('a language nobody expects only for a long sample the recogniser is sure of, and that the words agree with', () => {
  const swedish = [
    'Det här är vår nya kollektion och den finns bara i butiken',
    'Fri frakt för alla som handlar idag hos oss',
    'Vi har sydda klänningar byxor jackor skjortor och mjuka tröjor',
    'Varje plagg tillverkas lokalt av hållbara material från gården',
    'Kom förbi vår butik på torget eller beställ hem till dörren',
    'Erbjudandet gäller hela veckan medan lagret räcker',
  ].join('\n');
  assert.ok(new Set(swedish.toLowerCase().split(/[^\p{L}]+/u)).size >= LONG_SAMPLE);
  assert.equal(textLanguage(swedish, { detected: { sv: 0.97 } }), 'sv');
  assert.equal(textLanguage(swedish, { detected: { sv: 0.7 } }), 'de', 'not sure enough: one of the expected ones');
  const longGerman = Array.from({ length: 8 }, (_, i) => `${GERMAN} Folge ${i} Teil${i}x`).join('\n');
  assert.equal(textLanguage(longGerman, { detected: { nb: 0.95 } }), 'de', 'sure but wrong: the German words win');
  // an expected language is a candidate like German and English
  assert.equal(textLanguage('Det här är vår nya kollektion och den finns', { preferred: ['sv'], detected: { sv: 0.6 } }), 'sv');
});

test('the spell check reads the words in the text’s language and the dictionaries’ ones', () => {
  assert.deepEqual(spellLanguages('de'), ['de', 'en']);
  assert.deepEqual(spellLanguages('sv'), ['sv', ...DICTIONARY_LANGS]);
  assert.deepEqual(spellLanguages(null), ['de', 'en']);
});

test('a result from before names only a dictionary’s language; a new one names what it checked in', () => {
  assert.equal(shownTextLanguage({ text_language: 'nb', spelling: { state: 'checked', words: 47 } as never }), null);
  assert.equal(shownTextLanguage({ text_language: 'de' }), 'de');
  assert.equal(shownTextLanguage({ text_language: 'sv', spelling: { languages: ['sv', 'de', 'en'] } }), 'sv');
  assert.equal(shownTextLanguage({ text_language: null }), null);
  assert.equal(shownTextLanguage(null), null);
});
