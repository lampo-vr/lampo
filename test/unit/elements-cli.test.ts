// Elements maps through `vr` on the local store: `vr push --help` names --elements, a bad map is refused before the
// render goes up, `vr push --elements` and `vr elements` attach one (per version, beside the review, scaled to the
// version), and then `vr open` (lines and --json), `vr show` and INBOX.md say what each note points at — and where a
// part render for it may go (part_ok).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SCENE_MAP, writeJson } from '../lib/elements.ts';
import { isolatedEnv, makeVideo, must, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_BY: 'agent:scene' } });
const store = await import('../../lib/store.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { WATCH_NOW_LINE } = await import('../../lib/handoff.ts');

// The film at a third of the stage's size: the map (written at 1920×1080) is scaled to it.
const render = makeVideo(path.join(dir, 'renders/launch.mp4'), { w: 640, h: 360, fps: 30, dur: 4 });
const render2 = makeVideo(path.join(dir, 'renders/launch-2.mp4'), { w: 640, h: 360, fps: 30, dur: 4, pattern: 'testsrc2' });
const mapFile = writeJson(path.join(dir, 'renders/launch.elements.json'), SCENE_MAP);
let slug = '';
const ids: Record<string, string> = {};

test('vr push --help prints its usage on stdout, --elements in it; any command’s --help its own lines', () => {
  const r = vr(['push', '--help'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.match(r.out, /^ {2}vr push <file> \[--folder "Project\/Sub"\]/m);
  assert.match(r.out, /\[--elements map\.json\]/);
  assert.match(r.out, /--part-at <frame>/);
  assert.doesNotMatch(r.out, /vr open|vr login/, 'only push’s lines');
  assert.match(vr(['elements', '--help'], env).out, /^ {2}vr elements <video> <map\.json> \[--v N\]/m);
  assert.match(vr(['open', '--help'], env).out, /^ {2}vr open <video\|slug> \[--all\] \[--brief\]/m);
});

test('a bad map is refused before the render goes up; nothing is made', () => {
  const bad = writeJson(path.join(dir, 'renders/bad.json'), { ...SCENE_MAP, elements: [{ ...SCENE_MAP.elements[0], id: 'no spaces' }] });
  const r = vr(['push', render, '--elements', bad, '--folder', 'Acme'], env);
  assert.equal(r.code, 1);
  assert.match(r.err, /bad\.json: the elements map is refused: elements\.0\.id: an id is 1–40 letters, digits, _ or -/);
  assert.equal(store.listReviews().length, 0, 'no video was made');
  assert.match(vr(['push', render, '--elements', path.join(dir, 'nope.json')], env).err, /nope\.json: no such file/);
  assert.match(vr(['push', render, '--to', 'x', '--part-at', '40', '--elements', mapFile], env).err, /a part takes no elements map/);
});

test('vr push --elements: the render and where its elements are, scaled to it, kept per version beside the review', () => {
  const r = vr(['push', render, '--elements', mapFile, '--folder', 'Acme', '--json'], env);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  slug = out.slug;
  assert.deepEqual(out.elements, { v: 1, elements: 7, keys: 17, scaled_from: [1920, 1080] });
  const review = must(store.loadReview(slug));
  const file = path.join(env.VR_DATA as string, slug, 'elements', `${renderKey(must(review.versions[0]))}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored.size, [640, 360]);
  assert.deepEqual(stored.elements.find((e: { id: string }) => e.id === 'card').keys[1], [8, 200, 133.33, 73.33, 43.33]);
  // versions/ holds the render only: a map is never kept with the bytes that can't be made again
  assert.deepEqual(fs.readdirSync(path.join(`${env.VR_DATA}-versions`, slug)), ['v1.mp4']);
  // the same render again (an unchanged one) still takes its map, and says so before the line that says to listen
  const again = vr(['push', render, '--elements', mapFile, '--folder', 'Acme'], env);
  assert.equal(again.code, 0, again.err);
  assert.match(
    again.out,
    /^unchanged: .*launch\.mp4 is already v1 with these exact bytes\n {4}elements: 7 named, 17 keys \(scaled from 1920×1080\): notes say what they point at\n/,
  );
  assert.ok(again.out.endsWith(`${WATCH_NOW_LINE}\n`));
});

test('vr open and vr show: each note’s line says what it points at and where a part may go; the names once, above', () => {
  // Drawn on the 640×360 render: the card's box at f30, an arrow to the badge (a part allowed), the button and the
  // caption over a stretch, empty space next to the card, and a note without a drawing.
  const add = (o: Parameters<typeof store.addComment>[1]) => store.addComment(slug, { v: 1, author: 'Rita', ...o });
  ids.card = add({ frame: 30, text: 'The price is hard to read', drawing: [{ type: 'box', x: 230, y: 127, w: 97, h: 57 }] }).id;
  ids.badge = add({
    frame: 45,
    text: 'Too red',
    drawing: [{ type: 'arrow', x1: 433, y1: 233, x2: 513, y2: 293 }],
    part: { in: 40, out: 79 },
  }).id;
  ids.range = add({ frame: 70, range: { in: 70, out: 90 }, text: 'Overlaps the button', drawing: [{ type: 'box', x: 287, y: 293, w: 100, h: 47 }] }).id;
  ids.empty = add({ frame: 30, text: 'Put the logo here', drawing: [{ type: 'box', x: 333, y: 127, w: 40, h: 33 }] }).id;
  ids.words = add({ frame: 50, text: 'Title feels small' }).id;
  const r = vr(['open', 'launch.mp4'], env);
  assert.equal(r.code, 0, r.err);
  const line = (id: string) =>
    must(
      r.out.split('\n').find((l) => l.startsWith(`${id}  `)),
      id,
    );
  assert.match(line(ids.card as string), / v1 {2}\[-\] · on #card$/);
  assert.match(line(ids.badge as string), / · on #badge · part f40–f79$/);
  assert.match(line(ids.range as string), / range 70-90 {2}v1 {2}\[-\] · on #cta, #caption$/);
  assert.match(line(ids.empty as string), / · near #card$/);
  assert.match(line(ids.words as string), /v1 {2}\[-\]$/, 'no drawing: nothing');
  assert.match(r.out, /\n {2}elements: #card "Price card", #badge "New", #cta "Try it", #caption "Every morning we start"\n/);
  // the PART RENDER OK line stays as it was
  assert.match(r.out, /\n {4}PART RENDER OK: frames 40–79, handles 12\n/);
  const json = JSON.parse(vr(['open', 'launch.mp4', '--json'], env).out);
  const of = (id: string) => json.comments.find((c: { id: string }) => c.id === id);
  assert.deepEqual(of(ids.card as string).elements, ['card']);
  assert.equal(of(ids.card as string).part_ok, undefined);
  assert.deepEqual([of(ids.badge as string).elements, of(ids.badge as string).part_ok], [['badge'], { from: 40, to: 79 }]);
  assert.deepEqual(of(ids.range as string).elements, ['cta', 'caption']);
  assert.deepEqual([of(ids.empty as string).elements, of(ids.empty as string).near], [[], 'card']);
  assert.deepEqual(of(ids.words as string).elements, []);
  const show = vr(['show', ids.badge as string], env).out;
  assert.match(show, /\n {2}elements: #badge "New"\n/);
  assert.match(show, / · on #badge · part f40–f79\n/);
  assert.deepEqual(JSON.parse(vr(['show', ids.badge as string, '--json'], env).out).part_ok, { from: 40, to: 79 });
});

test('INBOX.md: a new note’s entry says what it points at, and the names', () => {
  store.writeInbox();
  const inbox = fs.readFileSync(path.join(env.VR_DATA as string, 'INBOX.md'), 'utf8');
  const entry = (id: string) =>
    must(
      inbox.split('\n## ').find((b) => b.includes(` · ${id}`)),
      id,
    );
  assert.match(entry(ids.card as string), /\n- at: 00:01:00 · frame 30 · on #card\n- elements: #card "Price card"\n/);
  assert.match(entry(ids.badge as string), /\n- at: 00:01:15 · frame 45 · on #badge · part f40–f79\n- elements: #badge "New"\n/);
  assert.match(entry(ids.words as string), /\n- at: 00:01:20 · frame 50\n- text: Title feels small/);
});

test('vr elements replaces a version’s map, refuses a bad one whole and keeps the old', () => {
  const renamed = { ...SCENE_MAP, elements: SCENE_MAP.elements.map((e) => (e.id === 'card' ? { ...e, id: 'price', name: 'Price' } : e)) };
  const r = vr(['elements', 'launch.mp4', writeJson(path.join(dir, 'renamed.json'), renamed), '--v', '1'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'v1: elements: 7 named, 17 keys (scaled from 1920×1080): notes say what they point at\n');
  assert.match(vr(['open', 'launch.mp4'], env).out, new RegExp(`${ids.card}  .* · on #price\\n`));
  const file = path.join(env.VR_DATA as string, slug, 'elements', `${renderKey(must(must(store.loadReview(slug)).versions[0]))}.json`);
  const before = fs.readFileSync(file);
  const at25 = vr(['elements', 'launch.mp4', writeJson(path.join(dir, 'at25.json'), { ...SCENE_MAP, fps: 25 })], env);
  assert.equal(at25.code, 1);
  assert.match(at25.err, /the elements map is refused: it is at 25 fps, v1 at 30: write it at the version's frame rate/);
  const tooMany = { ...SCENE_MAP, elements: [{ ...SCENE_MAP.elements[0], keys: Array.from({ length: 2001 }, (_, f) => [f, 0, 0, 1920, 1080]) }] };
  assert.match(vr(['elements', 'launch.mp4', writeJson(path.join(dir, 'many.json'), tooMany)], env).err, /2001 keys, at most 2000 for v1 \(120 frames\)/);
  assert.ok(fs.readFileSync(file).equals(before), 'the map in place is untouched');
  assert.match(vr(['elements', 'launch.mp4', mapFile, '--v', '9'], env).err, /no v9/);
  assert.match(vr(['elements', 'launch.mp4'], env).err, /usage: vr elements <video> <map\.json> \[--v N\]/);
});

test('a new version gets its own map; notes on the old one keep reading the old one', () => {
  const r = vr(['push', render2, '--to', 'launch.mp4', '--elements', mapFile], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new version: .*launch\.mp4 \(v2\)/);
  assert.match(r.out, /\n {4}elements: 7 named, 17 keys/);
  const review = must(store.loadReview(slug));
  assert.equal(fs.readdirSync(path.join(env.VR_DATA as string, slug, 'elements')).length, 2);
  assert.notEqual(renderKey(must(review.versions[0])), renderKey(must(review.versions[1])));
  // v1's notes read v1's map (where the card is "price" now)
  assert.match(vr(['open', 'launch.mp4'], env).out, new RegExp(`${ids.card}  .* · on #price\\n`));
});
