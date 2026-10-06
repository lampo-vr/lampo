// A slug is one directory name (255 bytes on APFS, ext4, …). Renders deep in a cloud-drive folder have longer paths;
// they get a shortened slug with a hash of the whole path, and every slug that fits stays exactly as it was.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { slugify } = await import('../../lib/paths.ts');
const store = await import('../../lib/store.ts');

// Over 300 bytes, like "…/Library/CloudStorage/GoogleDrive-…/Shared drives/<client>/<campaign>/…/export/<name>.mp4" —
// on its own, without the temp dir (Linux's /tmp is 50 bytes shorter than macOS's).
const deep = path.join(
  dir,
  'Library/CloudStorage/GoogleDrive-someone@example.com/Shared drives/Acme Corporation International',
  'Campaign 2026 Spring Summer Relaunch (final approved brief)/04 Post-production and finishing/Social cutdowns',
  'Round 3 for the client review',
  'export/acme-spring-relaunch_reel-9x16_v012_final.mp4',
);
const bytes = (s: string) => Buffer.byteLength(s);

test('short paths keep the slug they always had', () => {
  const file = path.join(dir, 'proj/export/spot.mp4');
  assert.equal(slugify(file), path.resolve(file).split('/').join('__'));
  const upload = '/@uploads/Acme/Reels/spot.mp4';
  assert.equal(slugify(upload), '__@uploads__Acme__Reels__spot.mp4');
});

test('a long path gets a slug that fits one directory name, keeps its end and stays unique', () => {
  assert.ok(bytes(path.resolve(deep)) > 300, `the test path is long (${bytes(path.resolve(deep))} bytes)`);
  const slug = slugify(deep);
  assert.ok(bytes(slug) <= 255, `fits (${bytes(slug)} bytes)`);
  assert.equal(slug, slugify(deep), 'stable');
  assert.match(slug, /^__.*acme-spring-relaunch_reel-9x16_v012_final\.mp4~[0-9a-f]{16}$/, 'readable end, hash last');
  assert.notEqual(slugify(deep.replace('Acme Corporation', 'Acme Corporatio_')), slug, 'another long path, another slug');
  const upload = `/@uploads/${'Campaign folder with a long name/'.repeat(9)}spot.mp4`;
  assert.ok(slugify(upload).startsWith('__@uploads__'), 'an upload stays recognisable as one');
  assert.ok(bytes(slugify(upload)) <= 255);
});

test('a render with a 343-byte path can be tracked and reviewed', () => {
  makeVideo(deep, { dur: 1 });
  age(deep);
  const { review } = store.createOrGetReview(deep, { by: 'tester' });
  assert.equal(review.video, path.resolve(deep), 'the full path stays the source of truth');
  const slug = slugify(deep);
  assert.equal(store.loadReview(slug)?.video, path.resolve(deep));
  const c = store.addComment(slug, { frame: 3, text: 'Logo später', author: 'tester' });
  assert.equal(store.loadReview(slug)?.comments[0]?.id, c.id);
});
