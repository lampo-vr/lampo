import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZONE_SHAPES } from '../../lib/zones.ts';

// An app's interface over the picture is one kind of thing in every app: the player draws it the same way (hatched),
// whether or not Auto-check measures it. Dashed guides are margins (title / action safe), never an app's interface.
test('every app preset draws its interface as covered (hatched), none as a dashed guide', () => {
  for (const id of ['ig-reels', 'tiktok', 'yt-shorts', 'stories']) {
    const shapes = ZONE_SHAPES[id];
    assert.ok(shapes?.length, `${id} has zones`);
    for (const z of shapes) assert.equal(z.type, 'unsafe', `${id} ${z.label ?? '(unlabelled)'} is hatched`);
  }
});

test('Auto-check still measures the same Reels zones', () => {
  const checks = ZONE_SHAPES['ig-reels']
    .map((z) => z.check)
    .filter(Boolean)
    .sort();
  assert.deepEqual(checks, ['ig-caption', 'ig-crop', 'ig-crop', 'ig-icons', 'ig-topbar']);
});
