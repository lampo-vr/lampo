// Keeping open pages in step without refetch storms: an event about one video names it (also 'library'), and the
// library answers for just the videos a page asks about (GET /api/library?slug=…), so a change is one small fetch.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { LibraryResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const files = ['a', 'b', 'c'].map((n) => makeVideo(path.join(dir, `Acme/export/${n}.mp4`), { dur: 1 }));
for (const f of files) {
  age(f);
  store.createOrGetReview(f, { by: 'tester' });
}
const [A, B, C] = files.map((f) => slugify(f)) as [string, string, string];

const { ctx, base } = await startApp({ token: 't', loadSessions: async () => [] });
const heard: { type: string; data: Record<string, unknown> }[] = [];
ctx.hub.listen((type, data) => heard.push({ type, data: data as Record<string, unknown> }));

const library = async (q = '') => (await (await fetch(`${base}/api/library${q}`)).json()) as LibraryResponse;

test('GET /api/library?slug=… answers for those videos only, with the whole folder list', async () => {
  const all = await library();
  assert.equal(all.videos.length, 3);
  store.mutate(A, (r) => {
    r.folder = 'Acme';
  });
  const two = await library(`?slug=${encodeURIComponent(A)}&slug=${encodeURIComponent(C)}`);
  assert.deepEqual(two.videos.map((v) => v.slug).sort(), [A, C].sort());
  assert.ok(two.folders.includes('Acme'), 'folders are always the whole list');
  const one = await library(`?slug=${encodeURIComponent(B)}`);
  assert.deepEqual(
    one.videos.map((v) => v.slug),
    [B],
  );
  const gone = await library('?slug=nothing-here');
  assert.deepEqual(gone.videos, [], 'a video that is gone is simply missing');
});

test('events about one video name it, the library event included', async () => {
  heard.length = 0;
  const r = await fetch(`${base}/api/review/${encodeURIComponent(B)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame: 3, text: 'Warmer', severity: 'should' }),
  });
  assert.equal(r.status, 200);
  const lib = heard.filter((e) => e.type === 'library');
  assert.ok(lib.length > 0);
  assert.ok(
    lib.every((e) => e.data.slug === B),
    JSON.stringify(lib),
  );
  assert.ok(heard.some((e) => e.type === 'review' && e.data.slug === B));
  heard.length = 0;
  const moved = await fetch(`${base}/api/review/${encodeURIComponent(C)}/folder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: 'Globex' }),
  });
  assert.equal(moved.status, 200);
  assert.deepEqual(
    heard.filter((e) => e.type === 'library').map((e) => e.data.slug),
    [C],
    'a move names the video (its library entry carries the new folder list)',
  );
});
