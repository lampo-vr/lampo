// The parts of the MCP server that keep an agent's tokens down (mcp/lean.ts, mcp/format.ts): schemas announced
// without boilerplate but validated in full, the lean tool set, and the part of a frame a drawing is about.
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { trimmed, trimSchema, toolFilter, LEAN_TOOLS } = await import('../../mcp/lean.ts');
const { cropAround } = await import('../../mcp/format.ts');

test('trimmed schemas: no boilerplate, hidden fields still validated', async () => {
  const schema = z.object({
    id: z.string(),
    frame: z.number().int().min(0).optional(),
    v: z.number().int().min(1).optional(),
    range: z.object({ in: z.number().int(), out: z.number().int() }).optional(),
    by: z.string().optional().meta({ hidden: true }),
    old: z.boolean().optional().meta({ deprecated: true }),
    refs: z
      .array(z.object({ url: z.string().optional(), caption: z.string().optional() }))
      .optional()
      .meta({ brief: true })
      .describe('as in attach_reference'),
  });
  const t = trimmed(schema);
  const json = t['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as { properties: Record<string, Record<string, unknown>> };
  const text = JSON.stringify(json);
  assert.ok(!text.includes('$schema') && !text.includes('9007199254740991'), text);
  assert.deepEqual(Object.keys(json.properties).sort(), ['frame', 'id', 'range', 'refs', 'v']);
  assert.deepEqual(json.properties.frame, { type: 'integer' }, 'minimum 0 goes');
  assert.equal(json.properties.v.minimum, 1, 'a real bound stays');
  assert.deepEqual(json.properties.refs, { type: 'array', description: 'as in attach_reference', items: { type: 'object' } });
  // Validation is zod's, hidden fields and bounds included.
  const ok = await t['~standard'].validate({ id: 'c_1', by: 'agent:x', old: true });
  assert.ok(!('issues' in ok && ok.issues), JSON.stringify(ok));
  const bad = await t['~standard'].validate({ id: 'c_1', frame: -1 });
  assert.ok('issues' in bad && bad.issues?.length, 'frame −1 is still refused');
  assert.deepEqual(trimSchema({ a: [{ $schema: 'x', minimum: -9007199254740991 }] }), { a: [{}] });
});

test('the lean tool set', () => {
  assert.ok(toolFilter(undefined)('set_status') && toolFilter('all')('show_review'), 'everything by default');
  const lean = toolFilter('lean');
  for (const t of LEAN_TOOLS) assert.ok(lean(t), t);
  for (const t of ['set_status', 'show_review', 'review_frame', 'attach_preview', 'list_folders']) assert.ok(!lean(t), t);
  const two = toolFilter(' get_note , mark_fixed ');
  assert.ok(two('get_note') && two('mark_fixed') && !two('add_note'), 'a list of names');
});

test('cropAround: the drawing with room around it, the whole frame when it is most of it', () => {
  // A box in the middle of a 1080×1920 frame: twice its size, centred on it.
  assert.deepEqual(cropAround([{ type: 'box', x: 320, y: 760, w: 440, h: 300 }], 1080, 1920), { x: 100, y: 610, w: 880, h: 600 });
  // A vertical arrow: never thinner than half its height.
  assert.deepEqual(cropAround([{ type: 'arrow', x1: 540, y1: 900, x2: 540, y2: 1500 }], 1080, 1920), { x: 240, y: 600, w: 600, h: 1200 });
  // At the frame's edge the crop moves inside it.
  const edge = cropAround([{ type: 'box', x: 80, y: 1580, w: 920, h: 220 }], 1080, 1920);
  assert.deepEqual(edge, { x: 0, y: 1380, w: 1080, h: 540 });
  // A freehand ring (a recording's spot) counts by its points.
  const ring = cropAround(
    [
      {
        type: 'freehand',
        points: [
          [500, 500],
          [560, 560],
        ],
      },
    ],
    1920,
    1080,
  );
  assert.ok(ring && ring.w >= 432 && ring.h >= 432 && ring.x <= 500 && ring.x + ring.w >= 560);
  // Most of the frame, or nothing drawn: no crop.
  assert.equal(cropAround([{ type: 'box', x: 100, y: 100, w: 800, h: 1600 }], 1080, 1920), null);
  assert.equal(cropAround([], 1080, 1920), null);
});
