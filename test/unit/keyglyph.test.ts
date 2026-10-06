// Keyframe glyphs (web/src/ui/glyphs.ts): meaning is carried by shape, not only by colour, and the three renderers
// (the <KeyGlyph> component and CSS pseudo-elements through the --kg-* masks, the timeline canvas through Path2D) draw
// the same geometry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { STAGES } from '../../lib/stage.ts';
import { KIND_SHAPE, LANE_SHAPE, SEVERITY_SHAPE, SHAPES, STAGE_SHAPE } from '../../web/src/ui/glyphs.ts';
import { ROOT } from '../lib/helpers.ts';

test('the four severities differ by shape, so they read without colour', () => {
  const shapes = Object.values(SEVERITY_SHAPE);
  assert.equal(shapes.length, 4);
  assert.equal(new Set(shapes).size, 4, `severity shapes repeat: ${shapes.join(', ')}`);
  assert.equal(new Set(shapes.map((s) => SHAPES[s])).size, 4, 'and the drawn paths differ too');
});

test('notes that are not feedback never look like a severity', () => {
  for (const kind of Object.values(KIND_SHAPE)) assert.ok(!Object.values(SEVERITY_SHAPE).includes(kind), `${kind} is also a severity shape`);
});

test('every stage and lane has a glyph; open work, work in hand, approved and final look different', () => {
  for (const s of STAGES) assert.ok(SHAPES[STAGE_SHAPE[s]], `no glyph for ${s}`);
  const families = new Set([STAGE_SHAPE.to_review, STAGE_SHAPE.in_progress, STAGE_SHAPE.team_approved, STAGE_SHAPE.final]);
  assert.equal(families.size, 4);
  for (const lane of ['needs_you', 'fixing', 'approved', 'final']) assert.ok(SHAPES[LANE_SHAPE[lane] as keyof typeof SHAPES], lane);
});

test('the CSS masks draw exactly the paths the canvas draws', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles/base.css'), 'utf8');
  for (const [name, d] of Object.entries(SHAPES)) {
    const line = css.split('\n').find((l) => l.trim().startsWith(`--kg-${name}:`));
    assert.ok(line, `--kg-${name} missing in base.css`);
    assert.ok(line.includes(`d='${d}'`), `--kg-${name} differs from glyphs.ts (regenerate the token)`);
    assert.ok(line.includes("fill-rule='evenodd'"), `--kg-${name} must fill even-odd like the canvas`);
  }
});

test('no status dot glows: glyphs are flat', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'web/src/styles/ui.css'), 'utf8');
  const kg = ui.slice(ui.indexOf('.kg {'), ui.indexOf('}', ui.indexOf('.kg {')));
  assert.ok(!/box-shadow|filter/.test(kg), 'the glyph has no glow or halo');
  const controls = fs.readFileSync(path.join(ROOT, 'web/src/styles/controls.css'), 'utf8');
  const sev = controls.slice(controls.indexOf('.sev::before {'), controls.indexOf('}', controls.indexOf('.sev::before {')));
  assert.ok(!/box-shadow|border-radius: 50%/.test(sev), 'severity marks are glyphs, not glowing dots');
});
