// What each screen downloads, from the built UI (web/dist): the start (entry + boot + what they import statically,
// the German words left out), then per screen its lazy chunk and the chunks it pulls in that the start doesn't have.
// Sizes gzipped (level 9) and brotli, each file on its own as it travels; CSS next to JS.
//
//   npm run build && node bench/perf/bundles.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIST = path.join(ROOT, 'web/dist');
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const entry = /<script[^>]+type="module"[^>]+src="\/?(assets\/[^"]+\.js)"/.exec(html)?.[1];
const read = (f) => fs.readFileSync(path.join(DIST, f));
const files = fs.readdirSync(path.join(DIST, 'assets'));
const byName = (prefix) => files.find((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js'));

// A chunk and everything it imports statically.
function closure(start, seen = new Set()) {
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of read(file)
      .toString()
      .matchAll(/(?:from|import)\s*["`]\.\/([\w.-]+\.js)["`]/g))
      walk(`assets/${m[1]}`);
  };
  walk(start);
  return seen;
}
const dynamicOf = (file) =>
  [
    ...read(file)
      .toString()
      .matchAll(/import\(\s*["`]\.\/([\w.-]+\.js)["`]\s*\)/g),
  ].map((m) => `assets/${m[1]}`);

const size = (list) => {
  let gz = 0;
  let br = 0;
  for (const f of list) {
    const b = read(f);
    gz += zlib.gzipSync(b, { level: 9 }).length;
    br += zlib.brotliCompressSync(b).length;
  }
  return { gz: gz / 1024, br: br / 1024 };
};

const startup = closure(entry);
for (const d of dynamicOf(entry)) if (!path.basename(d).startsWith('de-')) closure(d, startup);
const startCss = files.filter((f) => f.endsWith('.css') && (f.startsWith('boot-') || f.startsWith('index-'))).map((f) => `assets/${f}`);

const rows = [['start (entry + boot)', [...startup], startCss]];
for (const [name, chunk] of [
  ['library', 'Library'],
  ['player', 'Player'],
  ['for you', 'ForYou'],
  ['settings', 'Settings'],
  ['client pages', 'Guest'],
  ['sign-in', 'AuthScreens'],
]) {
  const f = byName(chunk);
  if (!f) continue;
  const js = [...closure(`assets/${f}`)].filter((x) => !startup.has(x));
  const css = files.filter((x) => x.endsWith('.css') && x.startsWith(`${chunk}-`)).map((x) => `assets/${x}`);
  rows.push([name, js, css]);
}
const insights = files.find((f) => /^Insights-.*\.js$/.test(f));
if (insights) rows.push(['insights', [...closure(`assets/${insights}`)].filter((x) => !startup.has(x)), []]);

console.log('| screen | JS files | JS gzip | JS brotli | CSS gzip |');
console.log('|---|---:|---:|---:|---:|');
for (const [name, js, css] of rows) {
  const j = size(js);
  const c = size(css);
  console.log(`| ${name} | ${js.length} | ${j.gz.toFixed(1)} KB | ${j.br.toFixed(1)} KB | ${c.gz.toFixed(1)} KB |`);
}
console.log("\n(a screen lists only what the start doesn't already load)");
