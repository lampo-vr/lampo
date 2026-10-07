// On a person's own machine footage search is on until they turn it off (footage.json). A setting that is there and
// can't be read is never taken for "nothing said" (which would turn it back on): search stays off and says why, until
// `vr footage on` or `off` writes it again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

// the stand-in model, never the real one (nothing here indexes anyway)
isolatedEnv({ vars: { VR_STT: 'off', VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake' } });
const { footageState, writeSetting } = await import('../../lib/footage/settings.ts');
const { dataDir } = await import('../../lib/paths.ts');

test('nothing said: on; a setting that can’t be read: off, and why; written again: as written', () => {
  assert.deepEqual(footageState(), { on: true });
  writeSetting(false, 'Sam');
  assert.equal(footageState().on, false);
  const file = path.join(dataDir(), 'footage.json');
  for (const damaged of ['{"on": fal', '{"on": "no"}', 'null']) {
    fs.writeFileSync(file, damaged);
    const s = footageState();
    assert.equal(s.on, false, damaged);
    assert.match(s.why ?? '', /can’t be read/);
  }
  writeSetting(true, 'Sam');
  assert.deepEqual(footageState(), { on: true });
});
