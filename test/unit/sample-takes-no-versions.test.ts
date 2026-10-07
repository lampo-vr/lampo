// The first run's sample takes no versions but its own two: a render put there would count against no plan and go for
// good with "Remove the sample". An upload by the sample's id is refused (409) — over tus, at the store and as a part —
// and nothing is stored; one named like the sample in its folder is a video of its own, and counts. A sample that took
// versions before it refused them keeps them: they count, and removing the sample is refused while they are on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test', VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { ingestPart } = await import('../../lib/parts.ts');
const { usageOf } = await import('../../server/extension.ts');
const { slugify, versionsDir, DEFAULT_WORKSPACE } = await import('../../lib/paths.ts');
const { inWorkspace } = await import('../../lib/scope.ts');

const { request } = await startApp({ headers: { Connection: 'close' } });

const olivia = await auth.createUser({ email: 'olivia@review.test', name: 'Olivia', password: 'a long enough password', role: 'owner' });
const H = { Authorization: `Bearer ${auth.createToken(olivia.id, 'uploads').token}` };
const inW1 = <T>(fn: () => T): T => inWorkspace(DEFAULT_WORKSPACE, fn);

let n = 0;
/** A render with its own picture (so every upload is new bytes). */
function render(): string {
  const file = path.join(dir, 'incoming', `r${++n}.mp4`);
  makeVideo(file, { w: 64, h: 36, dur: 0.5, pattern: n % 2 ? 'testsrc' : 'testsrc2', freq: 200 + n * 40 });
  age(file);
  return file;
}

const made = await request('POST', '/api/onboarding/sample', { body: {}, headers: H });
assert.equal(made.status, 200, made.text);
const sample = inW1(() => store.listReviews().find((r) => r.onboarding_sample));
assert.ok(sample, 'a sample');
const slug = slugify(sample.video);
const files = () => inW1(() => fs.readdirSync(path.join(versionsDir(), slug)).sort());
const versions = () => inW1(() => store.loadReview(slug)?.versions.length);
const own = files();
assert.equal(own.length, 2, `the sample's own two: ${own}`);

test('an upload by the sample’s id is refused over tus, and nothing is stored or counted', async () => {
  const before = usageOf(DEFAULT_WORKSPACE).bytes;
  const r = await tusUpload(request, render(), { filename: 'spot.mp4', slug }, H);
  assert.equal(r.status, 409, r.text);
  assert.match(r.text, /sample/);
  assert.deepEqual(files(), own);
  assert.equal(versions(), 2);
  assert.equal(usageOf(DEFAULT_WORKSPACE).bytes, before);
});

test('at the store too (vr push --to, MCP on the server), and as a part', async () => {
  const file = render();
  await assert.rejects(
    async () => inW1(() => store.ingestUpload(file, { name: 'spot.mp4', slug, keep: true, by: 'Olivia' })),
    (e: Error & { status?: number }) => e.status === 409 && /sample/.test(e.message),
  );
  await assert.rejects(
    async () => inW1(() => ingestPart(file, { name: 'spot.mp4', slug, keep: true, by: 'Olivia', at: 10 })),
    (e: Error & { status?: number }) => e.status === 409 && /sample/.test(e.message),
  );
  assert.deepEqual(files(), own);
  assert.equal(versions(), 2);
});

test('an upload named like the sample, in its folder, is a video of its own and counts', async () => {
  const before = usageOf(DEFAULT_WORKSPACE).bytes;
  const file = render();
  const size = fs.statSync(file).size;
  const r = await tusUpload(request, file, { filename: sample.source?.name ?? '', folder: sample.folder ?? '' }, H);
  assert.equal(r.status, 200, r.text);
  const out = r.json();
  assert.equal(out.created, true, 'a new video');
  assert.notEqual(out.slug, slug);
  assert.deepEqual(files(), own, 'the sample got nothing');
  assert.equal(usageOf(DEFAULT_WORKSPACE).bytes, before + size, 'counted against the plan');
});

test('a sample that took a version before keeps it: counted, and not removed with the sample', async () => {
  // what a store from before the refusal holds: someone's render as the sample's V3 (only the sample's own making may
  // still add a version, so it stands in for that upload)
  const file = render();
  const size = fs.statSync(file).size;
  const before = usageOf(DEFAULT_WORKSPACE).bytes;
  await inW1(() => store.ingestUpload(file, { name: 'spot.mp4', slug, by: 'Olivia', sample: sample.onboarding_sample }));
  assert.equal(versions(), 3);
  assert.equal(usageOf(DEFAULT_WORKSPACE).bytes, before + size, 'the team’s render counts');
  const gone = await request('DELETE', '/api/onboarding/sample', { headers: H });
  assert.equal(gone.status, 409, gone.text);
  assert.equal(files().length, 3, 'versions/ kept');
  assert.equal(versions(), 3);
});
