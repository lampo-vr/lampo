// A move into a hosted server whose renders live in an S3 bucket, and on from it: `vr admin import` puts every version,
// reference, fix preview and skill file through the storage adapter (into the bucket, `stored: 's3'`), the notes'
// screenshots beside review.json; `vr export` on that server reads them back through the adapter, its accounts travel as
// people (`person:<n>`) that `--people` maps again, and a second workspace gets the same bytes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import type { BundleManifest } from '../../lib/bundle.ts';
import type { ImportReport } from '../../lib/bundleImport.ts';
import { isolatedEnv, must, ROOT, tmpdir, vr, vrAsync } from '../lib/helpers.ts';
import { mockS3 } from '../lib/mockStores.ts';

const s3 = await mockS3();
const { env } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_STORAGE: 's3',
    VR_S3_ENDPOINT: s3.url,
    VR_S3_BUCKET: 'bucket',
    VR_S3_ACCESS_KEY_ID: 'AKTEST',
    VR_S3_SECRET_ACCESS_KEY: 'shh',
    VR_S3_REGION: 'auto',
  },
});
const src = tmpdir('vr-test-move-s3-');
fs.writeFileSync(path.join(src, 'config.json'), '{}');
const machine: NodeJS.ProcessEnv = {
  ...env,
  VR_DATA: path.join(src, 'data'),
  VR_CACHE: path.join(src, 'cache'),
  VR_CONFIG: path.join(src, 'config.json'),
  XDG_CONFIG_HOME: path.join(src, 'xdg-config'),
};
for (const k of Object.keys(machine)) if (k === 'VR_MODE' || k.startsWith('VR_S3_') || k === 'VR_STORAGE') delete machine[k];
execFileSync(process.execPath, [path.join(ROOT, 'test/lib/bundleSource.ts'), path.join(src, 'facts.json')], { env: machine, stdio: 'pipe' });
const facts = JSON.parse(fs.readFileSync(path.join(src, 'facts.json'), 'utf8'));
const bundle = path.join(src, 'bundle.tar');
assert.equal(vr(['export', bundle], machine).code, 0);

const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const { inWorkspace } = await import('../../lib/paths.ts');
after(() => s3.close());
const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });

const A = '__@uploads__Client A__Reels__~2__clip.mp4';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** `vr` against this store, waiting without blocking: the bucket answers from this very process. */
const vrHere = (args: string[], e: NodeJS.ProcessEnv = env): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    const p = vrAsync(args, e);
    p.stdin.end();
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
const report = (r: { code: number; out: string; err: string }): ImportReport => {
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test('into the bucket: versions, references, previews and skill files through the adapter; screenshots beside review.json', async () => {
  report(await vrHere(['admin', 'import', bundle, '--workspace', 'w1', '--owner', 'owner@example.com', '--json', '--no-derive']));
  const review = must(inWorkspace('w1', () => store.loadReview(A)));
  assert.deepEqual(
    review.versions.map((v) => v.stored),
    ['s3', 's3'],
  );
  for (const v of [1, 2])
    assert.equal(
      sha(must(s3.objects.get(`versions/${A}/v${v}.mp4`))),
      sha(fs.readFileSync(path.join(src, 'data-versions', facts.slugs.a, `v${v}.mp4`))),
      `v${v} in the bucket`,
    );
  const keys = [...s3.objects.keys()];
  assert.ok(
    keys.some((k) => k.startsWith(`refs/${A}/r_`)),
    'references',
  );
  assert.ok(
    keys.some((k) => k.startsWith(`previews/${A}/p_`)),
    'the fix preview',
  );
  assert.ok(
    keys.some((k) => /^playbooks\/pb_[a-f0-9]+\/skills\/sk_[a-f0-9]+\/preset\.json$/.test(k)),
    "the skill's file",
  );
  const drawn = must(review.comments.find((c) => c.id === facts.notes.drawn));
  assert.ok(fs.existsSync(path.join(env.VR_DATA as string, A, must(drawn.shots?.marked))), 'the screenshot beside review.json');
});

test('and on from the server: its export reads the bucket, its accounts travel as people, --people maps them again', async () => {
  const again = path.join(src, 'again.tar');
  const r = await vrHere(['export', again, '--json'], { ...env, VR_WORKSPACE: 'w1' });
  assert.equal(r.code, 0, r.err);
  const m = JSON.parse(r.out) as BundleManifest;
  assert.equal(m.counts.versions, 5);
  assert.deepEqual(m.owner.names, [], 'a server has no machine owner');
  assert.deepEqual(
    m.people.map((p) => p.name),
    ['Olivia'],
  );
  const w2 = ws.createWorkspace({ name: 'Second', ownerId: owner.id }).id;
  const got = report(
    await vrHere([
      'admin',
      'import',
      again,
      '--workspace',
      w2,
      '--owner',
      'owner@example.com',
      '--people',
      'Olivia=owner@example.com',
      '--json',
      '--no-derive',
    ]),
  );
  assert.ok(got.reviews.every((x) => x.action === 'import'));
  assert.equal(sha(must(s3.objects.get(`w/${w2}/versions/${A}/v2.mp4`))), sha(must(s3.objects.get(`versions/${A}/v2.mp4`))), "w2's own copy");
  const note = must(inWorkspace(w2, () => store.loadReview(A))?.comments.find((c) => c.id === facts.notes.drawn));
  assert.deepEqual([note.author, note.author_id], ['Olivia', owner.id], 'the account again, by id');
});
