// covers: lib/store.ts lib/archive.ts
// A name that came in as JSON can hold a lone surrogate ("odd\ud800name.mp4"): stored as it is, every URL the browser
// builds from it (encodeURIComponent) throws while the library renders, for everyone in the workspace. Names are made
// well-formed where they come in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { uploadName } = await import('../../lib/store.ts');
const { safeSegment } = await import('../../lib/archive.ts');

test('an upload’s name with a lone surrogate is made well-formed, so URLs can be built from it', () => {
  const name = uploadName('odd\ud800name.mp4');
  assert.ok(name.isWellFormed(), JSON.stringify(name));
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal(name, 'odd�name.mp4');
  assert.equal(uploadName('Über Spot.mp4'), 'Über Spot.mp4', 'a proper name stays as it is');
});

test('a path segment with a lone surrogate is made well-formed too', () => {
  for (const raw of ['a\udc00b', '\ud83d', 'end\ud800']) {
    const s = safeSegment(raw);
    assert.ok(s.isWellFormed(), JSON.stringify(s));
    assert.doesNotThrow(() => encodeURIComponent(s));
  }
  assert.equal(safeSegment('Kapitel 1'), 'Kapitel 1');
});
