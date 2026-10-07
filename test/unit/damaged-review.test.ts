// One review.json that can't be read (cut short by a crash, edited by hand) takes only its own video away: the library
// lists the others and says one is left out, search, status and the inbox answer, `vr ls` and `vr open` of another video
// work. Opening the damaged one still fails, and the log says which file once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const { slugify, reviewFile } = await import('../../lib/paths.ts');
const app = await startApp({ loadSessions: async () => [] });

test('one damaged review.json leaves the rest of the store working', async () => {
  const [good, bad] = ['good.mp4', 'bad.mp4'].map((n) => {
    const f = makeVideo(path.join(dir, n), { dur: 0.5 });
    age(f);
    store.createOrGetReview(f, { by: 'setup' });
    return f as string;
  });
  // what a crash between the write and the disk's flush leaves behind
  fs.writeFileSync(reviewFile(slugify(bad as string)), '{"video": "/x/bad.mp4", "versions": [');
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    const lib = await app.request('GET', '/api/library');
    assert.equal(lib.status, 200, lib.text);
    assert.deepEqual(
      lib.json().videos.map((v: { video: string }) => path.basename(v.video)),
      ['good.mp4'],
    );
    assert.deepEqual(lib.json().degraded, ['videos'], 'the library says one is left out');
    for (const p of ['/api/search?q=good', '/api/status', '/api/inbox']) assert.equal((await app.request('GET', p)).status, 200, p);
    assert.equal((await app.request('GET', '/api/library')).status, 200, 'asked again');
  } finally {
    console.error = consoleError;
  }
  assert.equal(logged.filter((l) => l.includes('bad.mp4') && l.includes("can't be read")).length, 1, `said once: ${logged.join(' | ')}`);
  const ls = vr(['ls'], env);
  assert.equal(ls.code, 0, ls.err);
  assert.match(ls.out, /good\.mp4/);
  const open = vr(['open', good as string], env);
  assert.equal(open.code, 0, open.err);
  // the damaged one itself is not made up
  assert.notEqual((await app.request('GET', `/api/review/${encodeURIComponent(slugify(bad as string))}`)).status, 200);
});
