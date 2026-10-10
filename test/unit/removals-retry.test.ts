// What a deleted video still owes the storage (its renders, previews, references and playback copies in the bucket) is
// written down in its workspace before anything is removed, by exact name, and crossed out key by key as each goes: a
// bucket that refuses, or a stop that cuts the removals short, leaves the rest written down, and the server's next
// maintenance pass finishes it — never a whole prefix, and never what a video has again (a new video under the same
// name, even one whose bytes are still going up; the same render put up again). A graceful stop waits for the removals
// in flight, within its bound.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
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
/** Adds keys to the workspace's record as a deletion (or an older record) would have them. */
const owe = (...keys: string[]) => {
  const file = store.pendingRemovalsFile();
  const at = new Date().toISOString();
  const kept = pending().map((key) => ({ key, at }));
  fs.writeFileSync(file, JSON.stringify({ keys: [...kept, ...keys.map((key) => ({ key, at }))] }));
};
/** Deletes a video while the bucket refuses every removal: what it owes stays written down. */
async function deleteRefused(slug: string) {
  bunny.deleteStatus = 403;
  try {
    store.removeVideo(slug);
    await store.removalsSettled();
  } finally {
    bunny.deleteStatus = null;
  }
}
/** The DELETEs the bucket was sent from request number `from` on. */
const deletesFrom = (from: number) =>
  bunny.requests
    .slice(from)
    .filter((r) => r.method === 'DELETE')
    .map((r) => decodeURIComponent(r.path));

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
  for (const key of [`versions/${a.slug}/v1.mp4`, a.copy]) assert.ok(owed.includes(key), `${key} written down`);
  assert.deepEqual(
    owed.filter((k) => k.endsWith('/')),
    [],
    'exact keys only, never a whole prefix',
  );

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
    assert.ok(pending().includes(`versions/${c.slug}/v1.mp4`) && pending().includes(c.copy), 'written down at once');
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
  assert.ok(pending().includes(`versions/${d.slug}/v1.mp4`) && pending().includes(d.copy));
  // the same render put up again under the same name: its renders and its copy are a live video's now
  const again = await video('teaser.mp4', other);
  assert.equal(again.slug, d.slug);
  assert.equal(again.copy, d.copy);
  const r = await store.finishRemovals();
  assert.ok(!r.removed.includes(`versions/${d.slug}/v1.mp4`) && !r.removed.includes(d.copy), JSON.stringify(r));
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
  assert.ok(inWorkspace(B, () => pending()).includes(`versions/${e.slug}/v1.mp4`), 'B’s record has it');
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

test('a pass while a same-name upload is still going up keeps the new V1, and it plays', async () => {
  const g = await video('q.mp4');
  await deleteRefused(g.slug);
  const key = `versions/${g.slug}/v1.mp4`;
  const under = (k: string) => k.startsWith(`versions/${g.slug}/`);
  assert.ok(pending().some(under), 'what the deleted video had under its id is owed');
  // a new video under the same name: its bytes reach the bucket while its upload is still going on
  const fresh = makeVideo(path.join(dir, 'in/fresh.mp4'), { dur: 0.5, freq: 880, pattern: 'rgbtestsrc' });
  bunny.heldPuts = [];
  const up = store.ingestUpload(fresh, { name: 'q.mp4', folder: 'Acme', by: 'tester', keep: true });
  try {
    await until(() => (bunny.heldPuts?.length ?? 0) > 0 && bunny.objects.has(key), 'the new V1’s bytes in the bucket, its upload still going on');
    // owed by its exact name too, as a record read before the upload would have it: the upload's hold keeps it
    owe(key);
    const pass = await store.finishRemovals();
    assert.ok(bunny.objects.has(key), 'the new V1 is still in the bucket');
    assert.ok(!pass.removed.includes(key), JSON.stringify(pass));
    assert.deepEqual(
      pending().filter((k) => under(k) && k !== key),
      [],
      'the upload crossed out what its video id owed before its first byte',
    );
  } finally {
    const held = bunny.heldPuts ?? [];
    bunny.heldPuts = null;
    for (const answer of held) answer();
  }
  const { review, version } = await up;
  assert.equal(version.v, 1);
  assert.deepEqual(bunny.objects.get(key), fs.readFileSync(fresh), 'the bucket holds the new V1');
  // it plays: read back from the bucket, not from a working copy
  fs.rmSync(storage().localPath(key), { force: true });
  const file = await store.ensureVersionFile(review, 1);
  assert.ok(file, 'the V1 is there to play');
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(fresh));
  // and the next pass leaves it alone too
  await store.finishRemovals();
  assert.ok(bunny.objects.has(key));
  assert.ok(!pending().includes(key), 'crossed out: its video is someone’s again');
});

test('a pass removes only the exact keys written down: never a whole prefix, not even one an older record names', async () => {
  const h = await video('legacy.mp4');
  await deleteRefused(h.slug);
  // something nothing names under the deleted video's id, and a record from before with whole prefixes
  const orphan = `versions/${h.slug}/v7.mp4`;
  await storage().put(orphan, clip, { keep: true });
  owe(`versions/${h.slug}/`, `previews/${h.slug}/`, `refs/${h.slug}/`);
  const from = bunny.requests.length;
  await store.finishRemovals();
  const sent = deletesFrom(from);
  assert.ok(sent.length, 'the exact keys went');
  assert.deepEqual(
    sent.filter((p) => p.endsWith('/')),
    [],
    `never a prefix: ${sent.join(', ')}`,
  );
  assert.equal(bunny.objects.has(`versions/${h.slug}/v1.mp4`), false, 'the deleted V1 is gone');
  assert.ok(bunny.objects.has(orphan), 'what nothing named stays');
  assert.deepEqual(pending(), [], 'the prefixes crossed out, not removed');
});

test('a same-name upload first removes the rest of what the deleted video owes; while the bucket refuses, it is refused to be tried again', async () => {
  // a deleted video with two versions, a draft's reference and a fix preview, removed while the bucket refused
  const m = await video('trailer.mp4');
  await store.ingestUpload(other, { name: 'trailer.mp4', folder: 'Acme', by: 'tester', keep: true });
  const v1 = `versions/${m.slug}/v1.mp4`;
  const v2 = `versions/${m.slug}/v2.mp4`;
  const ref = `refs/${m.slug}/r_draft.jpg`;
  const preview = `previews/${m.slug}/p_fix.mp4`;
  for (const key of [ref, preview]) await storage().put(key, clip, { keep: true });
  await deleteRefused(m.slug);
  owe(ref, preview); // as the deletion writes down a draft's reference and a note's fix preview
  for (const key of [v1, v2, ref, preview]) assert.ok(pending().includes(key) && bunny.objects.has(key), `${key} owed and still there`);

  // a new video under the same name while the bucket still refuses: refused, nothing of it written, nothing crossed out
  const fresh = makeVideo(path.join(dir, 'in/trailer-new.mp4'), { dur: 0.5, freq: 660, pattern: 'rgbtestsrc' });
  const from = bunny.requests.length;
  bunny.deleteStatus = 403;
  try {
    await assert.rejects(store.ingestUpload(fresh, { name: 'trailer.mp4', folder: 'Acme', by: 'tester', keep: true }), (e: Error & { status?: number }) => {
      assert.equal(e.status, 503, e.message);
      assert.match(e.message, /upload again in a moment/);
      return true;
    });
  } finally {
    bunny.deleteStatus = null;
  }
  assert.deepEqual(
    bunny.requests.slice(from).filter((r) => r.method === 'PUT'),
    [],
    'not a byte of the new video before what is owed is gone',
  );
  assert.equal(store.loadReview(m.slug), null, 'no video made');
  for (const key of [v2, ref, preview]) assert.ok(pending().includes(key), `${key} still owed`);

  // the bucket answers again: the upload removes the deleted video's other keys first, then writes over its V1
  const { version } = await store.ingestUpload(fresh, { name: 'trailer.mp4', folder: 'Acme', by: 'tester', keep: true });
  assert.equal(version.v, 1);
  for (const key of [v2, ref, preview]) assert.equal(bunny.objects.has(key), false, `${key} of the deleted video is gone`);
  assert.deepEqual(bunny.objects.get(v1), fs.readFileSync(fresh), 'the new V1 in its place');
  assert.deepEqual(
    pending().filter((k) => k.includes(`/${m.slug}/`)),
    [],
    'nothing owed under the name any more',
  );
  const sent = deletesFrom(from);
  assert.deepEqual(
    sent.filter((p) => p.endsWith('/')),
    [],
    `exact keys only: ${sent.join(', ')}`,
  );
  assert.ok(!sent.some((p) => p.endsWith(v1)), 'the key it writes itself is written over, never removed');
});

test('each key is crossed out as it goes, not when the pass ends', async () => {
  const k = await video('steps.mp4');
  await deleteRefused(k.slug);
  // its V1 and its render's three copies
  const owed = pending().length;
  assert.equal(owed, 4, JSON.stringify(pending()));
  bunny.deleteDelayMs = 400;
  try {
    const pass = store.finishRemovals();
    await until(() => pending().length > 0 && pending().length < owed, 'crossed out while the others still go');
    const { removed } = await pass;
    assert.equal(removed.length, owed);
  } finally {
    bunny.deleteDelayMs = 0;
  }
  assert.deepEqual(pending(), []);
});
