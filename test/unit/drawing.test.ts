import assert from 'node:assert/strict';
import test from 'node:test';
import { describeShape, drawingMarkup, drawingSvg, MARK_COLOR, shapeMarkup, simplifyPoints, strokeFor } from '../../lib/drawing.ts';
import type { Shape } from '../../lib/types.ts';

test('stroke width scales with the short side of the video', () => {
  assert.equal(strokeFor(1080, 1920), 7);
  assert.equal(strokeFor(1920, 1080), 7);
  assert.equal(strokeFor(160, 90), 3); // never thinner than 3 px
});

test('svg uses the video pixel grid as its viewBox', () => {
  const svg = drawingSvg([{ type: 'box', x: 180, y: 1040, w: 720, h: 400 }], 1080, 1920);
  assert.match(svg, /width="1080" height="1920" viewBox="0 0 1080 1920"/);
  assert.match(svg, /<rect x="180" y="1040" width="720" height="400"/);
  assert.ok(svg.includes(MARK_COLOR));
});

test('each shape type renders with a dark halo under the colour stroke', () => {
  const sw = 7;
  const box = shapeMarkup({ type: 'box', x: 1, y: 2, w: 3, h: 4 }, sw);
  assert.equal((box.match(/<rect /g) || []).length, 2);
  const arrow = shapeMarkup({ type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0 }, sw);
  assert.equal((arrow.match(/<polygon /g) || []).length, 2);
  assert.match(arrow, /points="100,0 /); // head tip at x2,y2
  const pen = shapeMarkup(
    {
      type: 'freehand',
      points: [
        [0, 0],
        [10, 10],
        [20, 0],
      ],
    },
    sw,
  );
  assert.match(pen, /points="0,0 10,10 20,0"/);
  assert.equal(shapeMarkup({ type: 'nope' } as unknown as Shape, sw), '');
  assert.equal(drawingMarkup([], 10, 10), '');
  assert.ok(shapeMarkup({ type: 'box', x: 0, y: 0, w: 1, h: 1, color: '#00ff00' }, sw).includes('#00ff00'));
});

test('describeShape gives the coordinates agents read', () => {
  assert.equal(describeShape({ type: 'box', x: 180.4, y: 1040, w: 720, h: 400 }), 'box x180 y1040 w720 h400');
  assert.equal(describeShape({ type: 'arrow', x1: 540, y1: 300, x2: 540, y2: 700 }), 'arrow 540,300 → 540,700');
  assert.equal(
    describeShape({
      type: 'freehand',
      points: [
        [10, 20],
        [30, 5],
      ],
    }),
    'freehand around x10–30 y5–20',
  );
});

test('simplifyPoints drops near duplicates but keeps the end point', () => {
  const pts = [
    [0, 0],
    [1, 0],
    [2, 0],
    [10, 0],
    [10.4, 0.2],
  ];
  const out = simplifyPoints(pts, 4);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out.at(-1), [10, 0]);
  assert.ok(out.length < pts.length);
  assert.deepEqual(
    simplifyPoints(
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      4,
    ).at(-1),
    [2, 2],
  );
});

test('a colour that is not plain CSS colour syntax never reaches the markup', () => {
  const box = (color: string) => ({ type: 'box', x: 1, y: 2, w: 3, h: 4, color }) as Shape;
  assert.match(shapeMarkup(box('#ff2d55'), 2), /stroke="#ff2d55"/);
  assert.match(shapeMarkup(box('rgba(255, 45, 85, 0.75)'), 2), /stroke="rgba\(255, 45, 85, 0\.75\)"/);
  const evil = shapeMarkup(box('red" onload="alert(1)'), 2);
  assert.ok(!evil.includes('onload'), evil);
  assert.match(evil, new RegExp(`stroke="${MARK_COLOR.replace(/[()]/g, '\\$&')}"`));
  assert.ok(!drawingMarkup([box('x"/><script>')], 100, 100, 'blue" onclick="x').includes('script'));
});
