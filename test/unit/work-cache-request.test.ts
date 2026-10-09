// covers: lib/storage/held.ts server/app.ts server/routes/media.ts lib/storage/index.ts
// A request the server answers holds the working copies it was handed until its answer has gone, like a job does
// (lib/storage/held.ts): a frame grab of a version on a remote store (a mock Bunny zone, with a budget for less than
// two versions) waits for an ffmpeg place after its copy came, while another request downloads another version; the
// first copy is still there when its grab runs, and both frames come.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, tmpdir, until } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';
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
    VR_BUNNY_CDN_URL: 'https://cdn.review.test',
    VR_BUNNY_TOKEN_KEY: 'token-key',
    VR_OCR: 'off',
  },
});
const auth = await import('../../lib/auth.ts');
const probe = await import('../../lib/probe.ts');
const { queued } = await import('../../lib/jobs.ts');
const { createBunnyStore } = await import('../../lib/storage/bunny.ts');
const { createRemoteStorage, setStorage } = await import('../../lib/storage/index.ts');
const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
after(async () => {
  ctx.mail.stop();
  await bunny.close();
});

const owner = await auth.createUser({ email: 'o@example.com', name: 'Owner', password: 'a long password', role: 'owner' });
ctx.setup.token = null;
const asOwner = { Authorization: `Bearer ${auth.createToken(owner.id, 't').token}` };

/** A video put up through the API: its slug and its version's key in the bucket. */
async function upload(name: string, freq: number): Promise<{ slug: string; key: string }> {
  const clip = makeVideo(path.join(dir, 'in', name), { w: 320, h: 180, fps: 25, dur: 2, freq });
  age(clip);
  const up = await tusUpload(request, clip, { filename: name, folder: 'X' }, asOwner);
  assert.equal(up.status, 200, up.text);
  const slug = up.json().slug as string;
  const key = [...bunny.objects.keys()].find((k) => k.startsWith(`versions/${slug}/v1`));
  assert.ok(key, `the version of ${name} is in the bucket`);
  return { slug, key };
}

test('a frame grab waiting for its turn keeps its copy while another request downloads another version', { timeout: 300_000 }, async () => {
  const a = await upload('first.mp4', 440);
  const b = await upload('second.mp4', 660);
  await until(() => queued() === 0, 'the uploads’ warm-up to finish', 120_000);
  // from here on: a fresh working-copy cache with room for less than both versions
  const size = (key: string) => (bunny.objects.get(key) as Buffer).length;
  const work = tmpdir('vr-work-request-');
  setStorage(
    createRemoteStorage(createBunnyStore({ zone: 'zone', access_key: 'secret', storage_url: bunny.url }), {
      workDir: work,
      workCacheBytes: size(a.key) + size(b.key) - 1,
    }),
  );
  const copy = (key: string) => path.join(work, key);
  // the one ffmpeg place is taken until `hold` goes: each grab waits for it after its copy came
  const hold = path.join(dir, 'hold');
  fs.writeFileSync(hold, '');
  const was = probe.ON_DEMAND.atOnce;
  probe.ON_DEMAND.atOnce = 1;
  const busy = probe.run('/bin/sh', ['-c', `while [ -f ${JSON.stringify(hold)} ]; do sleep 0.05; done`], { onDemand: true });
  try {
    const first = request('GET', `/api/review/${a.slug}/frame?frame=5`, { headers: asOwner });
    await until(() => fs.existsSync(copy(a.key)), 'the first request’s copy to come', 60_000);
    const second = request('GET', `/api/review/${b.slug}/frame?frame=5`, { headers: asOwner });
    await until(() => fs.existsSync(copy(b.key)), 'the second request’s copy to come', 60_000);
    assert.ok(fs.existsSync(copy(a.key)), 'the first request’s copy is still there while its grab waits');
    fs.rmSync(hold);
    await busy;
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 200, one.text);
    assert.equal(two.status, 200, two.text);
  } finally {
    fs.rmSync(hold, { force: true });
    probe.ON_DEMAND.atOnce = was;
    setStorage(null);
  }
});
