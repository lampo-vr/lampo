// /api/info: what the settings screen shows about this instance. The speech languages come from config (`stt.languages`,
// VR_STT_LANGUAGES), so local mode's Settings can say what the engine listens for without reading config.json itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InfoResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_STT: 'off', VR_STT_LANGUAGES: 'de,en' } });
const { base } = await startApp({ token: 't', loadSessions: async () => [] });

test('the speech status carries the languages it listens for, the fallback first', async () => {
  const info = (await (await fetch(`${base}/api/info`)).json()) as InfoResponse;
  assert.equal(info.mode, 'local');
  assert.equal(info.stt?.backend, 'off');
  assert.deepEqual(info.stt?.languages, ['de', 'en']);
});
