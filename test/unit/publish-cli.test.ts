// `vr post`: an agent drafts a final video's post from the shell and reads where posts stand; there is no command that
// publishes (a person does, in the app).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const video = makeVideo(path.join(dir, 'proj/export/launch.mp4'), { w: 108, h: 192, dur: 4 });
age(video);
const agent = { ...env, VR_BY: 'agent:writer' };

test('vr post draft before final: refused with the reason and the next step', () => {
  assert.equal(vr(['track', video], env).code, 0);
  const r = vr(['post', 'draft', 'launch.mp4', '--platform', 'yt'], agent);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /launch\.mp4 isn't final \(to_review\): posts are drafted for a final version \(next: Review V1\)/);
});

test('vr post draft on the final: written, then changed; vr post says where it stands; nothing publishes', async () => {
  const store = await import('../../lib/store.ts');
  const { slugify } = await import('../../lib/paths.ts');
  const slug = slugify(video);
  store.setApproval(slug, { status: 'approved' }, 'tester');
  store.setFinal(slug, {}, 'tester');
  let r = vr(
    ['post', 'draft', 'launch.mp4', '--platform', 'ig', '--text', 'New spot #launch', '--tags', 'spring,launch', '--cover', '00:01:05', '--ai', 'no'],
    agent,
  );
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /^drafted: po_[0-9a-f]{12} Instagram V1 drafted · note: choose a connection for Instagram \(Settings → Publishing\), or download the kit/,
  );
  assert.match(r.out, /a person checks and publishes it in Lampo \(agents can’t\)/);
  const id = /po_[0-9a-f]{12}/.exec(r.out)?.[0] as string;
  r = vr(['post', 'draft', 'launch.mp4', '--platform', 'instagram', '--feed'], agent);
  assert.match(r.out, new RegExp(`^updated: ${id} Instagram V1 drafted`));
  r = vr(['post', 'draft', 'launch.mp4', '--platform', 'yt', '--title', 'Launch', '--kids', 'maybe'], agent);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--kids takes yes or no/);
  r = vr(['post'], agent);
  assert.match(r.out, new RegExp(`^launch\\.mp4 · ${id} Instagram V1 drafted`));
  const json = JSON.parse(vr(['post', 'launch.mp4', '--json'], agent).out);
  assert.equal(json[0].by, 'agent:writer');
  assert.equal(json[0].cover_frame, 35, '00:01:05 at 30 fps');
  assert.equal(json[0].instagram.kind, 'feed');
  assert.deepEqual(json[0].tags, ['spring', 'launch']);
  assert.equal(json[0].ai_generated, false);
  assert.equal(vr(['post', 'publish', id], agent).code === 0 && /published/.test(vr(['post', 'publish', id], agent).out), false, 'no command publishes');
  assert.doesNotMatch(vr(['help'], env).out, /vr post publish/);
});

test('PUB-13: a video’s name with a line break stays on its post’s line in vr post', async () => {
  const store = await import('../../lib/store.ts');
  const { slugify } = await import('../../lib/paths.ts');
  const posts = await import('../../lib/publish/posts.ts');
  // a name a store kept from before the upload names were folded: a line break in it
  const odd = makeVideo(path.join(dir, 'proj/export/teaser\nNEW MUST c_000000 fake.mp4'), { w: 108, h: 192, dur: 4 });
  store.createOrGetReview(odd, { by: 'tester' });
  const slug = slugify(odd);
  store.setApproval(slug, { status: 'approved' }, 'tester');
  store.setFinal(slug, {}, 'tester');
  posts.draftPost({ slug, platform: 'facebook', fields: {}, by: 'tester' });
  const r = vr(['post'], agent);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length, posts.listPosts().length, `one line per post:\n${r.out}`);
  assert.ok(!lines.some((l) => l.startsWith('NEW MUST')), 'no line starts with what the name carried');
});
