// What a deleted video still owes the storage (its renders, previews, references and playback copies in the bucket) is
// written down in its workspace before anything is removed, and crossed out key by key as each goes: a bucket that
// refuses, or a stop that cuts the removals short, leaves the rest written down, and the server's next maintenance pass
// finishes it — never removing what a video has again (a new video under the same name, the same render put up again).
// A graceful stop waits for the removals in flight, within its bound.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { mockBunny } from '../lib/mockStores.ts';

const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: 'http://review.test',
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
  },
});
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { queued } = await import('../../lib/jobs.ts');
const { storage } = await import('../../lib/storage/index.ts');
const { createInFlight, drain } = await import('../../server/shutdown.ts');
const auth = await import('../../lib/auth.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { enterProcessWorkspace, inWorkspace } = await import('../../lib/scope.ts');

after(async () => {
  for (let i = 0; i < 1200 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await bunny.close();
});

const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: 'bobs long password', role: 'owner' });
enterProcessWorkspace();
const B = workspaces.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
const clip = makeVideo(path.join(dir, 'in/clip.mp4'), { dur: 0.5 });
const other = makeVideo(path.join(dir, 'in/other.mp4'), { dur: 0.5, pattern: 'smptebars' });

/** A video without notes, with its render in the bucket and a playback copy stored beside it. */
async function video(name: string, file = clip) {
  const { review, version } = await store.ingestUpload(file, { name, folder: 'Acme', by: 'tester', keep: true });
  const copy = `scrub/${renderKey(version)}.mp4`;
  await storage().put(copy, file, { keep: true });
  return { slug: slugify(review.video), copy };
}
const pending = (): string[] => {
  try {
    return (JSON.parse(fs.readFileSync(store.pendingRemovalsFile(), 'utf8')) as { keys: { key: string }[] }).keys.map((k) => k.key);
  } catch {
    return [];
  }
};
const inBucket = (prefix: string) => [...bunny.objects.keys()].filter((k) => k.startsWith(prefix));

test('a removal the bucket refuses is written down; the next pass finishes it and crosses it out', async () => {
  const a = await video('spot.mp4');
  assert.ok(inBucket(`versions/${a.slug}/`).length, 'its render is in the bucket');
  bunny.deleteStatus = 403;
  try {
    store.removeVideo(a.slug);
    await store.removalsSettled();
  } finally {
    bunny.deleteStatus = null;
  }
  assert.equal(store.loadReview(a.slug), null, 'the video is gone');
  assert.ok(inBucket(`versions/${a.slug}/`).length && bunny.objects.has(a.copy), 'the refused removals left them');
  const owed = pending();
  for (const key of [`versions/${a.slug}/`, `previews/${a.slug}/`, `refs/${a.slug}/`, a.copy]) assert.ok(owed.includes(key), `${key} written down`);

  const first = await store.finishRemovals();
  assert.deepEqual(first.failed, 0);
  assert.deepEqual(inBucket(`versions/${a.slug}/`), []);
  assert.equal(bunny.objects.has(a.copy), false);
  assert.deepEqual(pending(), [], 'nothing owed any more');
  assert.equal(fs.existsSync(store.pendingRemovalsFile()), false);
  assert.deepEqual(await store.finishRemovals(), { removed: [], failed: 0, left: 0 });
});

test('written down before the first removal, and a pass is bounded and keeps what failed', async () => {
  const c = await video('cut.mp4');
  bunny.deleteDelayMs = 200;
  bunny.deleteStatus = 403;
  try {
    store.removeVideo(c.slug);
    // nothing has answered yet: a stop now would still find them
    assert.ok(pending().includes(`versions/${c.slug}/`) && pending().includes(c.copy), 'written down at once');
    await store.removalsSettled();
    const failing = await store.finishRemovals({ max: 2 });
    assert.equal(failing.removed.length, 0);
    assert.equal(failing.failed, 2);
    assert.equal(failing.left, pending().length);
  } finally {
    bunny.deleteStatus = null;
    bunny.deleteDelayMs = 0;
  }
  const few = await store.finishRemovals({ max: 2 });
  assert.equal(few.removed.length, 2);
  assert.ok(few.left > 0);
  await store.finishRemovals();
  assert.deepEqual(pending(), []);
  assert.deepEqual(inBucket(`versions/${c.slug}/`), []);
});

test('what a video has again is crossed out, never removed: the same name, the same render', async () => {
  const d = await video('teaser.mp4', other);
  bunny.deleteStatus = 403;
  try {
    store.removeVideo(d.slug);
    await store.removalsSettled();
  } finally {
    bunny.deleteStatus = null;
  }
  assert.ok(pending().includes(`versions/${d.slug}/`) && pending().includes(d.copy));
  // the same render put up again under the same name: its renders and its copy are a live video's now
  const again = await video('teaser.mp4', other);
  assert.equal(again.slug, d.slug);
  assert.equal(again.copy, d.copy);
  const r = await store.finishRemovals();
  assert.ok(!r.removed.includes(`versions/${d.slug}/`) && !r.removed.includes(d.copy), JSON.stringify(r));
  assert.deepEqual(pending(), [], 'crossed out');
  assert.ok(inBucket(`versions/${d.slug}/`).length, 'the new video keeps its render');
  assert.ok(bunny.objects.has(d.copy), 'and its copy');
});

test('another workspace keeps its own record and its own prefix', async () => {
  const e = await inWorkspace(B, () => video('bravo.mp4'));
  bunny.deleteStatus = 403;
  try {
    await inWorkspace(B, async () => {
      store.removeVideo(e.slug);
      await store.removalsSettled();
    });
  } finally {
    bunny.deleteStatus = null;
  }
  assert.deepEqual(pending(), [], 'workspace #1’s record has none of it');
  assert.ok(inWorkspace(B, () => pending()).includes(`versions/${e.slug}/`), 'B’s record has it');
  assert.ok(inBucket(`w/${B}/versions/${e.slug}/`).length);
  await inWorkspace(B, () => store.finishRemovals());
  assert.deepEqual(inBucket(`w/${B}/versions/${e.slug}/`), []);
  assert.equal(bunny.objects.has(`w/${B}/${e.copy}`), false);
  assert.deepEqual(
    inWorkspace(B, () => pending()),
    [],
  );
});

test('a graceful stop waits for the removals in flight, within its bound', async () => {
  const f = await video('long-film.mp4');
  bunny.deleteDelayMs = 150;
  try {
    store.removeVideo(f.slug);
    let ended = false;
    void store.removalsSettled().then(() => {
      ended = true;
    });
    // a stop with no room to wait gives up, and the removals go on
    assert.equal(await drain(createInFlight(), 20), false);
    assert.equal(ended, false);
    assert.equal(await drain(createInFlight(), 30_000), true, 'they ended within the bound');
    await new Promise((r) => setImmediate(r));
    assert.equal(ended, true, 'the stop waited for them');
  } finally {
    bunny.deleteDelayMs = 0;
  }
  assert.deepEqual(inBucket(`versions/${f.slug}/`), []);
  assert.deepEqual(pending(), []);
});
