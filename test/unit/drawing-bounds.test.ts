// covers: lib/drawing.ts server/helpers.ts lib/store.ts lib/bundleExport.ts server/routes/shares/guest.ts
// A drawing stays within reach of its picture, whoever sends it: a box 1e15 wide from a review link's visitor (no
// account needed) is kept within the picture, so it can't stop the store's export ("nothing was written") later. One a
// store kept from before reads back within the picture, and the export goes on with a warning instead of refusing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { fitDrawing } = await import('../../lib/drawing.ts');
const { sanitizeDrawing } = await import('../../server/helpers.ts');
const { exportBundle } = await import('../../lib/bundleExport.ts');

const W = 160;
const H = 90;
function track(name: string): string {
  const file = makeVideo(path.join(dir, 'renders', name), { w: W, h: H, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  folders.moveVideo(slug, 'Acme', 'tester');
  return slug;
}
const within = (s: { type: string; x?: number; y?: number; w?: number; h?: number }) =>
  s.type === 'box' &&
  (s.x as number) >= -W &&
  (s.y as number) >= -H &&
  (s.x as number) + (s.w as number) <= 2 * W &&
  (s.y as number) + (s.h as number) <= 2 * H;

test('a box out of all proportion is brought within reach of the picture: its corners, so its size too', () => {
  const huge = [{ type: 'box', x: 10, y: 10, w: 1e15, h: 1e15 }];
  const [kept] = sanitizeDrawing(huge, { width: W, height: H });
  assert.deepEqual(kept, { type: 'box', x: 10, y: 10, w: 2 * W - 10, h: 2 * H - 10 });
  const fit = fitDrawing([...huge, { type: 'arrow', x1: -1e12, y1: 0, x2: 5, y2: 5 }, { type: 'box', x: 1, y: 2, w: 3, h: 4, color: '#fff' }], W, H);
  assert.equal(fit.fixed, 2);
  assert.ok(within(fit.shapes[0] as never), JSON.stringify(fit.shapes[0]));
  assert.deepEqual(fit.shapes[1], { type: 'arrow', x1: -W, y1: 0, x2: 5, y2: 5 });
  assert.deepEqual(fit.shapes[2], { type: 'box', x: 1, y: 2, w: 3, h: 4, color: '#fff' }, 'a shape within reach comes back as it was');
  assert.deepEqual(fitDrawing([{ type: 'box', x: 'a', y: 0, w: 1, h: 1 }, null], W, H), { shapes: [], fixed: 2 }, 'what isn’t a shape goes');
});

test('a review link’s visitor sends a box 1e15 wide: it is stored within the picture', async () => {
  const slug = track('link.mp4');
  const { request } = await startApp({ token: 'test-token', loadSessions: async () => [] });
  const made = await request('POST', '/api/folder-shares', { body: { folder: 'Acme', download: 'original', notes: 'all', versions: 'all', label: 'Acme' } });
  assert.equal(made.status, 200, made.text);
  const { token } = made.json();
  const room = (await request('GET', `/api/g/${token}`)).json();
  const id = room.videos.find((v: { name?: string; video?: string }) => /link\.mp4/.test(v.name ?? v.video ?? ''))?.slug ?? room.videos[0].slug;
  const noted = await request('POST', `/api/g/${token}/comments`, {
    body: { name: 'Mia', slug: id, frame: 3, text: 'Logo', drawing: [{ type: 'box', x: 10, y: 10, w: 1e15, h: 1e15 }] },
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });
  assert.equal(noted.status, 200, noted.text);
  const kept = store.loadReview(slug)?.comments.find((c) => c.id === noted.json().id);
  assert.ok(kept && kept.drawing.length === 1 && within(kept.drawing[0]), JSON.stringify(kept?.drawing));
});

test('a drawing a store kept from before reads back within the picture, and the export goes on with a warning', async () => {
  const slug = track('old.mp4');
  const c = store.addComment(slug, { frame: 3, text: 'from before', severity: 'must', author: 'Mia' });
  // as an older version stored it: written into review.json by hand, past what a bundle takes (1e6)
  const file = path.join(path.dirname(store.eventsFile()), slug, 'review.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.comments.find((x: { id: string }) => x.id === c.id).drawing = [{ type: 'box', x: 10, y: 10, w: 1e15, h: 4 }];
  fs.writeFileSync(file, JSON.stringify(raw));
  const read = store.loadReview(slug)?.comments.find((x) => x.id === c.id);
  assert.ok(read && within(read.drawing[0]), JSON.stringify(read?.drawing));
  const r = await exportBundle({ out: path.join(dir, 'out.tar') });
  assert.ok(fs.statSync(r.file).size > 0);
  assert.ok(
    r.warnings.some((w) => /1 drawing on old\.mp4 went far past the picture: brought within it/.test(w)),
    JSON.stringify(r.warnings),
  );
});
