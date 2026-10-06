// Elements maps (lib/elements.ts), the rules ported from a renderer's review loop: where an element is between its
// keys and outside its runs, what a drawing points at (the closest match under a box, an arrow by its tip, a ring by its
// extent, a range across its frames, the nearest element over empty space, the full-frame ground only under a large
// box), thinning, every refusal of a map, fitting one to its version, and the words agents read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boxAt,
  checkElementMap,
  ELEMENT_LIMITS,
  ElementMapError,
  fitElementMap,
  legendLine,
  onWords,
  pointedAt,
  readElementMap,
  thin,
} from '../../lib/elements.ts';
import type { Comment, ElementKey, ElementMap, MapElement, Shape, Version } from '../../lib/types.ts';
import { SCENE_MAP } from '../lib/elements.ts';

const el = (id: string, name: string, keys: ElementKey[], runs?: [number, number][]): MapElement => ({
  id,
  name,
  kind: 'text',
  keys,
  ...(runs ? { runs } : {}),
});
// The renderer's own test record, as test/lib/elements.ts keeps it.
const MAP: ElementMap = SCENE_MAP;
const elementOf = (id: string) => MAP.elements.find((e) => e.id === id) as MapElement;

type Note = Pick<Comment, 'frame' | 'range' | 'drawing' | 'scope'>;
const note = (frame: number, drawing: Shape[], o: Partial<Note> = {}): Note => ({ frame, range: null, drawing, ...o });
const box = (x: number, y: number, w: number, h: number): Shape => ({ type: 'box', x, y, w, h });
const arrow = (x1: number, y1: number, x2: number, y2: number): Shape => ({ type: 'arrow', x1, y1, x2, y2 });
const ids = (n: Note) => pointedAt(n, MAP).elements;

test('an element moves in a straight line between its keys, and is gone outside its runs', () => {
  const card = elementOf('card');
  assert.deepEqual(boxAt(card, 4), [360, 400, 220, 130], 'halfway from f0 to f8');
  assert.deepEqual(boxAt(card, 60), [720, 400, 220, 130], 'after its last move it rests');
  assert.equal(boxAt(elementOf('badge'), 20), null, 'before its run');
  assert.equal(
    boxAt(
      {
        ...card,
        runs: [
          [0, 59],
          [61, 119],
        ],
      },
      60,
    ),
    null,
    'in the gap between two runs',
  );
  assert.deepEqual(
    boxAt(
      {
        ...card,
        runs: [
          [0, 59],
          [61, 119],
        ],
      },
      61,
    ),
    [720, 400, 220, 130],
  );
  // without runs (another renderer): from its first key to its last, and nothing outside
  const plain = { keys: card.keys.slice(1, 3) };
  assert.equal(boxAt(plain, 7), null);
  assert.deepEqual(boxAt(plain, 8), [600, 400, 220, 130]);
  assert.deepEqual(boxAt(plain, 15), [720, 400, 220, 130]);
  assert.equal(boxAt(plain, 16), null);
  // a run that starts before the first key holds that key's box (Scene's rule)
  assert.deepEqual(boxAt({ keys: card.keys.slice(1, 3), runs: [[2, 20]] }, 3), [600, 400, 220, 130]);
});

test('a box points at what lies closest under it, an arrow at what its tip touches, a ring by its extent', () => {
  assert.deepEqual(ids(note(30, [box(690, 380, 290, 170)])), ['card'], 'the card, not the full-frame background it lies on');
  assert.deepEqual(ids(note(45, [arrow(1300, 700, 1540, 880)])), ['badge']);
  const ring: Shape = {
    type: 'freehand',
    points: [
      [1580, 50],
      [1820, 40],
      [1830, 200],
      [1590, 190],
      [1580, 50],
    ],
  };
  assert.deepEqual(ids(note(20, [ring])), ['logo']);
  assert.deepEqual(ids(note(70, [box(860, 880, 300, 140)])), ['cta', 'caption'], 'the box holds the button and the caption over it');
  // an arrow pointing at an empty place names what its tail starts on ("move this there")
  assert.deepEqual(ids(note(30, [arrow(1650, 100, 1100, 700)])), ['logo']);
  // two shapes: each one's elements, in the order they were drawn, once each
  assert.deepEqual(ids(note(45, [arrow(1300, 700, 1540, 880), box(690, 380, 290, 170), box(1490, 850, 110, 70)])), ['badge', 'card']);
  // a box drawn the other way round (negative width and height) is the same box
  assert.deepEqual(ids(note(30, [box(980, 550, -290, -170)])), ['card']);
});

test('a note about the whole video, or without a drawing, points at nothing', () => {
  assert.deepEqual(pointedAt(note(30, [box(690, 380, 290, 170)], { scope: 'video' }), MAP), { elements: [] });
  assert.deepEqual(pointedAt(note(30, []), MAP), { elements: [] });
  assert.deepEqual(pointedAt(note(30, [box(690, 380, 290, 170)]), { ...MAP, elements: [] }), { elements: [] });
});

test('over empty space a drawing names nothing under it, and the element nearest it', () => {
  assert.deepEqual(pointedAt(note(30, [box(1000, 380, 120, 100)]), MAP), { elements: [], near: 'card' });
  // over nothing but the ground, without the ground under it: no element on screen then at all
  const bare: ElementMap = { ...MAP, elements: MAP.elements.filter((e) => e.id !== 'bg') };
  assert.deepEqual(pointedAt(note(30, [arrow(300, 700, 320, 720)]), bare), { elements: [] }, 'an arrow has nothing to be near');
  assert.deepEqual(
    pointedAt(note(3, [box(1000, 380, 120, 100)]), { ...bare, elements: bare.elements.filter((e) => e.id === 'badge') }),
    { elements: [] },
    'nothing on screen yet',
  );
});

test('the full-frame ground counts only under a box about as large', () => {
  // a small box where only the background is: not the background, the nearest element instead
  assert.deepEqual(pointedAt(note(30, [box(300, 650, 120, 80)]), MAP), { elements: [], near: 'card' });
  // a box over most of the frame: the background first, then what lies inside it
  assert.deepEqual(ids(note(30, [box(0, 0, 1920, 1000)])), ['bg', 'title', 'card']);
  // an arrow whose tip is on nothing else, and whose tail is on nothing: the ground under its tip
  assert.deepEqual(ids(note(30, [arrow(300, 700, 1000, 650)])), ['bg']);
});

test('a range points at what is under its drawing anywhere across it', () => {
  // the card slides in from x 120 to 720 over f0–f15: at f0 it isn't under the box yet, by f8 it is
  const drawing = [box(590, 390, 240, 150)];
  assert.deepEqual(pointedAt(note(0, drawing), MAP), { elements: [], near: 'card' });
  assert.deepEqual(ids(note(0, drawing, { range: { in: 0, out: 14 } })), ['card']);
  // the caption shows only from f61: a range that ends before it doesn't name it
  assert.deepEqual(ids(note(40, [box(860, 880, 300, 140)], { range: { in: 40, out: 60 } })), ['cta']);
  assert.deepEqual(ids(note(40, [box(860, 880, 300, 140)], { range: { in: 40, out: 70 } })), ['cta', 'caption']);
  // a long range is read at a sample of its frames, and still finds what stays a while
  const long: ElementMap = {
    ...MAP,
    elements: [
      el(
        'late',
        'Late',
        [
          [5000, 100, 100, 100, 100],
          [5040, 100, 100, 100, 100],
        ],
        [[5000, 5040]],
      ),
    ],
  };
  assert.deepEqual(pointedAt(note(0, [box(90, 90, 120, 120)], { range: { in: 0, out: 6000 } }), long).elements, ['late']);
});

test('thinning keeps the keys a straight line needs, and both ends of every stretch', () => {
  const straight: ElementKey[] = Array.from({ length: 11 }, (_, f) => [f, 100 + 10 * f, 50, 200, 100]);
  assert.deepEqual(thin(straight), [straight[0], straight[10]]);
  // a bend at f5: the line bends there
  const bend: ElementKey[] = Array.from({ length: 11 }, (_, f) => [f, f <= 5 ? 10 * f : 50, 0, 10, 10]);
  assert.deepEqual(
    thin(bend).map((k) => k[0]),
    [0, 5, 10],
  );
  // within 3 px of the line is the line; 4 px off is a key
  const jitter = (d: number): ElementKey[] => Array.from({ length: 5 }, (_, f) => [f, 10 * f + (f === 2 ? d : 0), 0, 10, 10]);
  assert.deepEqual(
    thin(jitter(3)).map((k) => k[0]),
    [0, 4],
  );
  assert.deepEqual(
    thin(jitter(4)).map((k) => k[0]),
    [0, 2, 4],
  );
  // a gap (f6–f9 not on screen): each stretch keeps its ends, so no line is drawn across it
  const gap: ElementKey[] = [...straight.slice(0, 6), ...straight.slice(10)].concat([[11, 210, 50, 200, 100]]);
  assert.deepEqual(
    thin(gap).map((k) => k[0]),
    [0, 5, 10, 11],
  );
  // keys already thinned (no two on neighbouring frames) stay as they are
  assert.deepEqual(thin(elementOf('card').keys), elementOf('card').keys);
});

const map = (o: Record<string, unknown> = {}) => ({ ...structuredClone(MAP), ...o });
const refused = (value: unknown, pattern: RegExp) =>
  assert.throws(
    () => checkElementMap(value),
    (e: Error) => e instanceof ElementMapError && pattern.test(e.message),
  );

test('a good map is taken as it is; fields it doesn’t know are dropped', () => {
  const got = checkElementMap({ ...map(), extra: 'x', elements: [{ ...MAP.elements[0], looks: { color: 'red' } }] });
  assert.deepEqual(Object.keys(got).sort(), ['elements', 'fps', 'size', 'v']);
  assert.deepEqual(Object.keys(got.elements[0] as object).sort(), ['id', 'keys', 'kind', 'name', 'runs']);
  assert.deepEqual(checkElementMap(map()), MAP);
});

test('a bad map is refused whole, each way it can be bad', () => {
  refused(map({ v: 2 }), /v must be 1/);
  refused({ v: 1, size: [1920, 1080], elements: [] }, /fps/);
  refused({ v: 1, fps: 30, elements: [] }, /size/);
  refused(map({ size: [1920, 0] }), /size/);
  refused(map({ elements: Array.from({ length: 501 }, (_, i) => el(`e${i}`, 'x', [[0, 0, 0, 1, 1]])) }), /at most 500 elements/);
  refused(map({ elements: [el('two words', 'x', [[0, 0, 0, 1, 1]])] }), /elements\.0\.id: an id is 1–40/);
  for (const id of ['__proto__', 'constructor', 'prototype'])
    refused(JSON.parse(`{"v":1,"fps":30,"size":[1920,1080],"elements":[{"id":"${id}","name":"x","kind":"x","keys":[[0,0,0,1,1]]}]}`), /that id is taken/);
  refused(map({ elements: [el('a'.repeat(41), 'x', [[0, 0, 0, 1, 1]])] }), /elements\.0\.id/);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, 1, 1]]), el('a', 'y', [[0, 0, 0, 1, 1]])] }), /elements\.1\.id: "a" is used twice/);
  refused(map({ elements: [el('a', 'n'.repeat(81), [[0, 0, 0, 1, 1]])] }), /elements\.0\.name: at most 80 characters/);
  refused(map({ elements: [{ ...el('a', 'x', [[0, 0, 0, 1, 1]]), kind: 'k'.repeat(21) }] }), /elements\.0\.kind: at most 20 characters/);
  refused(map({ elements: [el('a', 'x', [])] }), /an element needs a key/);
  refused(
    map({
      elements: [
        el('a', 'x', [
          [5, 0, 0, 1, 1],
          [3, 0, 0, 1, 1],
        ]),
      ],
    }),
    /elements\.0\.keys\.1: keys must be sorted by frame/,
  );
  refused(
    map({
      elements: [
        el('a', 'x', [
          [5, 0, 0, 1, 1],
          [5, 0, 0, 1, 1],
        ]),
      ],
    }),
    /keys must be sorted by frame, one per frame/,
  );
  refused(map({ elements: [el('a', 'x', [[0, Number.POSITIVE_INFINITY, 0, 1, 1]])] }), /elements\.0\.keys\.0\.1/);
  refused(map({ elements: [el('a', 'x', [[0, Number.NaN, 0, 1, 1]])] }), /elements\.0\.keys\.0\.1/);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, -1, 1]])] }), /elements\.0\.keys\.0\.3/);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, 1, -1]])] }), /elements\.0\.keys\.0\.4/);
  refused(map({ elements: [el('a', 'x', [[1.5, 0, 0, 1, 1]])] }), /elements\.0\.keys\.0\.0/);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, 1, 1, 9] as unknown as ElementKey])] }), /elements\.0\.keys\.0/);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, 1, 1]], [[5, 2]])] }), /a run is \[from, to\] with from ≤ to/);
  refused(
    map({
      elements: [
        el(
          'a',
          'x',
          [[0, 0, 0, 1, 1]],
          [
            [0, 10],
            [10, 20],
          ],
        ),
      ],
    }),
    /runs must be sorted and must not overlap/,
  );
  refused(
    map({
      elements: [
        el(
          'a',
          'x',
          [[0, 0, 0, 1, 1]],
          [
            [20, 30],
            [0, 10],
          ],
        ),
      ],
    }),
    /runs must be sorted/,
  );
  const many = Array.from({ length: 2001 }, (_, i): [number, number] => [3 * i, 3 * i + 1]);
  refused(map({ elements: [el('a', 'x', [[0, 0, 0, 1, 1]], many)] }), /at most 2000 runs/);
  // 1 MB in all, however it is made up
  const big = Array.from({ length: 400 }, (_, i) =>
    el(
      `e${i}`,
      'x',
      Array.from({ length: 300 }, (_, f): ElementKey => [f * 2, 1000.123, 1000.123, 1000.123, 1000.123]),
    ),
  );
  refused(map({ elements: big }), /over 1 MB/);
  assert.throws(() => readElementMap(`${' '.repeat(ELEMENT_LIMITS.bytes)}{}`), /over 1 MB/, 'a file is measured before it is parsed');
  assert.throws(() => readElementMap('{"v":1,'), /the elements map is refused: not JSON/);
  refused(null, /refused/);
  refused([], /refused/);
});

test('names reach agents on one line', () => {
  const got = checkElementMap(map({ elements: [el('a', '  Price\ncard now ', [[0, 0, 0, 1, 1]])] }));
  assert.equal(got.elements[0]?.name, 'Price ↵ card ↵ now');
  assert.equal(checkElementMap(map({ elements: [{ ...el('a', 'x', [[0, 0, 0, 1, 1]]), kind: 'te\rxt' }] })).elements[0]?.kind, 'te ↵ xt');
});

const ver = (o: Partial<Version> = {}): Version =>
  ({ v: 1, hash: 'h', mtime: '', size: 1, frames: 120, fps: 30, width: 1920, height: 1080, duration: 4, registered: '', ...o }) as Version;

test('a map is made its version’s: same rate and shape, keys per element at most max(2000, its frames), scaled, thinned', () => {
  assert.throws(() => fitElementMap(MAP, ver({ fps: 25 })), /it is at 30 fps, v1 at 25: write it at the version's frame rate/);
  assert.doesNotThrow(() => fitElementMap(MAP, ver({ fps: 30.004 })), 'a rate as ffprobe rounds it');
  assert.throws(() => fitElementMap(MAP, ver({ width: 1080, height: 1920 })), /it is 1920×1080, v1 is 1080×1920: write the map of this format/);
  assert.throws(() => fitElementMap(MAP, ver({ part: { of: 1, at: 0, frames: 10, handles: 0 }, v: 2 })), /V2 is a part: attach the map to a full render/);
  const keys = (n: number) => Array.from({ length: n }, (_, f): ElementKey => [f, (f * 7) % 13, 0, 10, 10]);
  const one = (n: number): ElementMap => ({ ...MAP, elements: [el('a', 'x', keys(n))] });
  assert.doesNotThrow(() => fitElementMap(one(2000), ver({ frames: 120 })));
  assert.throws(() => fitElementMap(one(2001), ver({ frames: 120 })), /elements\.0\.keys: 2001 keys, at most 2000 for v1 \(120 frames\)/);
  // a 90 s film at 60 fps with a moving camera: a key on every frame is fine
  assert.doesNotThrow(() => fitElementMap(one(5400), ver({ frames: 5400, fps: 30 })));
  assert.throws(() => fitElementMap(one(5401), ver({ frames: 5400 })), /at most 5400/);
  // written at 1920×1080, the version is 640×360: a third
  const fitted = fitElementMap(MAP, ver({ width: 640, height: 360 }));
  assert.deepEqual(fitted.scaled_from, [1920, 1080]);
  assert.deepEqual(fitted.map.size, [640, 360]);
  assert.deepEqual(fitted.map.elements.find((e) => e.id === 'card')?.keys[1], [8, 200, 133.33, 73.33, 43.33]);
  assert.deepEqual(fitted.map.elements.find((e) => e.id === 'card')?.runs, [[0, 119]]);
  assert.equal(fitElementMap(MAP, ver()).scaled_from, undefined);
  // every frame of a straight move is two keys once stored
  const dense = fitElementMap(
    {
      ...MAP,
      elements: [
        el(
          'a',
          'x',
          Array.from({ length: 120 }, (_, f): ElementKey => [f, f * 2, 0, 10, 10]),
        ),
      ],
    },
    ver(),
  );
  assert.equal(dense.map.elements[0]?.keys.length, 2);
});

test('what agents read: " · on #a, #b, #c +N", " · near #card", and one legend of names', () => {
  assert.equal(onWords({ elements: ['title', 'card'] }), ' · on #title, #card');
  assert.equal(onWords({ elements: ['a', 'b', 'c', 'd', 'e'] }), ' · on #a, #b, #c +2');
  assert.equal(onWords({ elements: [], near: 'card' }), ' · near #card');
  assert.equal(onWords({ elements: [] }), '');
  assert.equal(onWords(undefined), '');
  const names = { title: 'Launch day', card: 'Price "card"', bg: 'bg', d: 'Dee' };
  assert.equal(
    legendLine([{ elements: ['title', 'card'] }, { elements: ['card', 'bg'] }, { elements: [], near: 'd' }, null], names),
    `elements: #title "Launch day", #card "Price 'card'", #bg, #d "Dee"`,
  );
  // only the ids the lines show: a fourth is "+1" on its line and not in the legend
  assert.equal(legendLine([{ elements: ['a', 'b', 'c', 'title'] }], names), 'elements: #a, #b, #c');
  assert.equal(legendLine([{ elements: [] }, undefined], names), '');
});
