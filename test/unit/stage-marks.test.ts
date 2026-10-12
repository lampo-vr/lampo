// The labels on a paused frame (web/src/player/marks.ts): a dark chip that fits its words exactly, in English and in
// German, by its box's left edge (above the box where there is room, else below it, inside its corner only with room
// for neither) and never past the frame's edges; its words carry no outline. Every box is a light or yellow line over a
// dark one, inside the frame.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Diff, QaItem } from '../../web/src/api/types.ts';
import { de } from '../../web/src/i18n/de.ts';
import { setDictionary } from '../../web/src/i18n/index.ts';
import { boxLabel, frameMarks } from '../../web/src/player/marks.ts';

type Attrs = Record<string, string>;
const attrs = (tag: string): Attrs => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const n = (a: Attrs, k: string) => Number(a[k]);

/** The chip, its words and their place, from a label's markup. */
function chipOf(svg: string) {
  const label = /<g data-mark-label="">(<rect [^>]*\/>)<text ([^>]*)>([^<]*)<\/text><\/g>/.exec(svg);
  assert.ok(label, `a label: ${svg}`);
  const chip = attrs(label[1]);
  const text = attrs(label[2]);
  const box = { x: n(chip, 'x'), y: n(chip, 'y'), w: n(chip, 'width'), h: n(chip, 'height') };
  const fs = n(text, 'font-size');
  return { chip, text, words: label[3], box, fs, left: n(text, 'x') - box.x, right: box.x + box.w - (n(text, 'x') + n(text, 'textLength')) };
}

const W = 1920;
const H = 1080;
const sw = 4; // a 1080p frame's stroke
const gap = sw * 2;

test('a label is a dark chip around its words, the same room on each side, the words without an outline', () => {
  const l = chipOf(boxLabel({ x: 700, y: 380, w: 520, h: 320 }, sw, W, H, 'CHANGED SINCE V2'));
  assert.equal(l.words, 'CHANGED SINCE V2');
  assert.equal(l.chip.fill, 'rgba(19,19,20,0.9)');
  assert.equal(l.fs, 36);
  // Martian Mono's glyphs are 0.7 em wide: the words are held to that width, whatever face draws them
  assert.equal(n(l.text, 'textLength'), Math.round(16 * 0.7 * 36 * 10) / 10);
  assert.equal(l.text.lengthAdjust, 'spacingAndGlyphs');
  assert.ok(Math.abs(l.left - l.right) < 0.2 && l.left > 0, `the room each side: ${l.left} | ${l.right}`);
  assert.ok(!('stroke' in l.text) && !('style' in l.text), `no outline round the letters: ${JSON.stringify(l.text)}`);
  // the capitals in the middle of the chip, top to bottom
  const capTop = n(l.text, 'y') - 0.8 * l.fs;
  assert.ok(Math.abs(capTop - l.box.y - (l.box.y + l.box.h - n(l.text, 'y'))) < 0.2, 'as much room above the capitals as below');
});

test('above the box where there is room, else below it, from its left edge; inside its corner only with neither', () => {
  const above = chipOf(boxLabel({ x: 700, y: 380, w: 520, h: 320 }, sw, W, H, 'CHANGED SINCE V2'));
  assert.equal(above.box.x, 700);
  assert.ok(Math.abs(above.box.y + above.box.h - (380 - gap)) < 0.2, `just above the box: ${JSON.stringify(above.box)}`);
  // at the top of the frame, and a little down from it but not enough for the chip: below the box, never over it
  for (const y of [0, 40]) {
    const below = chipOf(boxLabel({ x: 300, y, w: 700, h: 240 }, sw, W, H, 'CHANGED SINCE V2'));
    assert.deepEqual([below.box.x, below.box.y], [300, y + 240 + gap], `just below the box at y ${y}`);
  }
  // a box nearly the frame's height: no room above or below, so inside its top-left corner
  const tall = chipOf(boxLabel({ x: 300, y: 30, w: 700, h: 1000 }, sw, W, H, 'CHANGED SINCE V2'));
  assert.deepEqual([tall.box.x, tall.box.y], [300 + gap, 30 + gap], 'inside the top-left corner');
  // room for the chip below only just: it still goes below, its foot on the frame's margin
  const ch = 1.7 * 36;
  const snug = chipOf(boxLabel({ x: 300, y: 20, w: 700, h: H - gap * 2 - ch - 20 }, sw, W, H, 'AUTO-CHECK'));
  assert.ok(Math.abs(snug.box.y + snug.box.h - (H - gap)) < 0.2, `below, down to the margin: ${JSON.stringify(snug.box)}`);
});

test('at the right edge the chip moves left into the frame; at the bottom it moves up', () => {
  const right = chipOf(boxLabel({ x: 1700, y: 400, w: 220, h: 200 }, sw, W, H, 'CHANGED SINCE V2'));
  assert.ok(Math.abs(right.box.x + right.box.w - (W - gap)) < 0.2, `flush with the frame's right edge, less its margin: ${JSON.stringify(right.box)}`);
  const corner = chipOf(boxLabel({ x: 1880, y: 1060, w: 40, h: 20 }, sw, W, H, 'AUTO-CHECK'));
  assert.ok(corner.box.x + corner.box.w <= W - gap + 0.1 && corner.box.y + corner.box.h <= H - gap + 0.1, `inside: ${JSON.stringify(corner.box)}`);
});

test('a frame too narrow for the chip makes the chip smaller, still the whole of its words', () => {
  const l = chipOf(boxLabel({ x: 10, y: 40, w: 60, h: 30 }, 2, 160, 90, 'CHANGED SINCE V2'));
  assert.ok(l.fs < 18, `smaller than 9 strokes: ${l.fs}`);
  assert.ok(l.box.x >= 4 - 0.1 && l.box.x + l.box.w <= 160 - 4 + 0.1, `inside the frame: ${JSON.stringify(l.box)}`);
  assert.ok(Math.abs(l.left - l.right) < 0.2, 'the same room each side');
});

test('German: the label fits its own words (an umlaut is one letter)', () => {
  setDictionary('de', de);
  try {
    const diff = { old: { v: 2 }, ranges: [{ kind: 'video', in: 0, out: 24, box: { x: 1600, y: 360, w: 320, h: 300 } }] } as unknown as Diff;
    const l = chipOf(frameMarks({ placed: [], frame: 12, selected: null, W, H, diff, qaPick: null }));
    assert.equal(l.words, 'GEÄNDERT SEIT V2');
    assert.equal(n(l.text, 'textLength'), Math.round(16 * 0.7 * 36 * 10) / 10);
    assert.ok(l.box.x + l.box.w <= W - gap + 0.1, `inside the frame: ${JSON.stringify(l.box)}`);
  } finally {
    setDictionary('en', null);
  }
});

test('a box along the frame’s edges keeps its lines inside the frame', () => {
  const diff = { old: { v: 1 }, ranges: [{ kind: 'video', in: 0, out: 24, box: { x: 1536, y: 0, w: 384, h: 384 } }] } as unknown as Diff;
  const svg = frameMarks({ placed: [], frame: 12, selected: null, W, H, diff, qaPick: null });
  const lines = [...svg.matchAll(/<rect [^>]*stroke-dasharray[^>]*\/>|<rect [^>]*stroke="rgba\(0,0,0,0.55\)"[^>]*\/>/g)].map((m) => m[0]);
  assert.equal(lines.length, 2, `the box's two lines: ${svg}`);
  for (const line of lines) {
    const a = attrs(line);
    const half = n(a, 'stroke-width') / 2;
    assert.ok(n(a, 'x') + n(a, 'width') + half <= W + 0.1 && n(a, 'y') - half >= -0.1, `inside: ${line}`);
  }
});

test('every box is a light (or yellow) line over a dark one; the changed label is neutral, Auto-check’s yellow', () => {
  const diff = { old: { v: 1 }, ranges: [{ kind: 'video', in: 0, out: 24, box: { x: 700, y: 380, w: 520, h: 320 } }] } as unknown as Diff;
  const qaPick = { key: 'k', kind: 'typo', severity: 'should', tags: [], frame: 12, text: '', box: { x: 100, y: 600, w: 300, h: 80 } } as QaItem;
  const svg = frameMarks({ placed: [], frame: 12, selected: null, W, H, diff, qaPick });
  for (const [mark, line, words] of [
    ['changed', '#eeebe4', '#eeebe4'],
    ['auto-check', '#ffc043', '#ffc043'],
  ]) {
    const g = new RegExp(`<g data-mark="${mark}">(.*?)<g data-mark-label="">(.*?)</g></g>`).exec(svg);
    assert.ok(g, `${mark}: drawn`);
    const lines = [...g[1].matchAll(/<rect [^>]*\/>/g)].map((m) => attrs(m[0]));
    assert.equal(lines.length, 2, `${mark}: two lines`);
    assert.equal(lines[0].stroke, 'rgba(0,0,0,0.55)', `${mark}: the dark one first, under`);
    assert.ok(n(lines[0], 'stroke-width') > n(lines[1], 'stroke-width'), `${mark}: the dark line wider`);
    assert.equal(lines[1].stroke, line, `${mark}: the line on top`);
    assert.equal(attrs(/<text ([^>]*)>/.exec(g[2])?.[1] ?? '').fill, words, `${mark}: its words' colour`);
  }
});
