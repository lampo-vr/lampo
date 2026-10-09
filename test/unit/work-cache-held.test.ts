// A remote store's working copies (lib/storage/index.ts) against a mock Bunny zone, with a budget smaller than what the
// work needs: the copy handed out is there when the caller opens it, also one bigger than the whole budget (and it is
// not fetched again on the next ask); work that fetches two (a comparison: the old version, then the new one) keeps
// both until it ends, as a job (lib/jobs.ts) or on its own (lib/storage/held.ts); after it, the cache comes back
// within its budget.
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { mockBunny } from '../lib/mockStores.ts';

const bunny = await mockBunny();
const { dir } = isolatedEnv();
const { createBunnyStore } = await import('../../lib/storage/bunny.ts');
const { createRemoteStorage } = await import('../../lib/storage/index.ts');
const { holdingWorkFiles } = await import('../../lib/storage/held.ts');
const { heavy } = await import('../../lib/jobs.ts');
after(() => bunny.close());

const remote = (name: string, cap: number) =>
  createRemoteStorage(createBunnyStore({ zone: 'zone', access_key: 'secret', storage_url: bunny.url }), {
    workDir: path.join(dir, name),
    workCacheBytes: cap,
  });
const gets = (key: string) => bunny.requests.filter((r) => r.method === 'GET' && r.path.endsWith(`/${key}`)).length;
const there = (f: string | null) => !!f && fs.existsSync(f);

test('a copy bigger than the whole budget is there when it is handed out, and the next ask takes it from the disk', async () => {
  bunny.objects.set('versions/a/v1.mp4', Buffer.alloc(101, 1));
  const s = remote('work-a', 100);
  const p = await s.ensureLocal('versions/a/v1.mp4');
  assert.ok(there(p), 'not pruned by its own download');
  assert.equal(fs.statSync(p as string).size, 101);
  const before = gets('versions/a/v1.mp4');
  assert.equal(await s.ensureLocal('versions/a/v1.mp4'), p);
  assert.equal(gets('versions/a/v1.mp4'), before, 'not fetched again');
});

test('a job that fetches two copies over the budget keeps both until it ends; then the cache comes back within it', async () => {
  for (const v of [1, 2, 3]) bunny.objects.set(`versions/b/v${v}.mp4`, Buffer.alloc(60, v));
  const s = remote('work-b', 100);
  const [first, second] = await heavy(async () => {
    const a = await s.ensureLocal('versions/b/v1.mp4');
    const b = await s.ensureLocal('versions/b/v2.mp4');
    // what a comparison does next: open both
    assert.ok(there(a), 'the first is still there after the second came');
    assert.ok(there(b));
    return [a, b];
  });
  // the job is over: the next download prunes what it held, least recently used first
  const third = await s.ensureLocal('versions/b/v3.mp4');
  assert.ok(there(third));
  assert.equal(there(first), false);
  assert.equal(there(second), false);
});

test('work outside the job queue holds its copies the same way, and two pieces of work sharing one copy both keep it', async () => {
  for (const v of [1, 2, 3]) bunny.objects.set(`versions/c/v${v}.mp4`, Buffer.alloc(60, v));
  const s = remote('work-c', 100);
  let release = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  // one holds v1 and waits; another takes v1 too, then v2, and ends
  const one = holdingWorkFiles(async () => {
    const a = await s.ensureLocal('versions/c/v1.mp4');
    await waiting;
    return a;
  });
  const shared = await holdingWorkFiles(async () => {
    const a = await s.ensureLocal('versions/c/v1.mp4');
    const b = await s.ensureLocal('versions/c/v2.mp4');
    assert.ok(there(a) && there(b));
    return a;
  });
  // the second piece of work is over; the first still holds v1
  await s.ensureLocal('versions/c/v3.mp4');
  assert.ok(there(shared), 'still held by the work that waits');
  release();
  const a = await one;
  assert.equal(a, shared);
  await s.ensureLocal('versions/c/v2.mp4');
  assert.equal(there(a), false, 'let go once nobody holds it');
});

test('a context kept from work that has ended holds nothing: what it fetches later can go', async () => {
  for (const v of [1, 2]) bunny.objects.set(`versions/d/v${v}.mp4`, Buffer.alloc(60, v));
  const s = remote('work-d', 100);
  let later: () => Promise<string | null> = async () => null;
  // a callback bound inside work and called after it (as jobs and timers are bound to their workspace)
  await holdingWorkFiles(async () => {
    later = AsyncResource.bind(() => s.ensureLocal('versions/d/v1.mp4'));
  });
  const a = await later();
  assert.ok(there(a), 'handed out whole');
  await s.ensureLocal('versions/d/v2.mp4');
  assert.equal(there(a), false, 'held by nobody: pruned');
});
