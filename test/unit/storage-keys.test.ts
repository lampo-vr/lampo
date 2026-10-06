// Storage keys name places inside the store, never outside it: a render's key is checked like a review's id, and no part
// of any key climbs out (A12 MEDIA-3). Every key the app builds today comes from slugify() and ids, so these are the
// keys a later caller with looser input could make.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { localPathOf } = await import('../../lib/storage/index.ts');
const paths = await import('../../lib/paths.ts');

test('MEDIA-3: a render’s key names a video by an id a review could have, like previews and refs', () => {
  assert.equal(localPathOf('versions/spot/v1.mp4'), path.join(paths.VERSIONS, 'spot', 'v1.mp4'));
  // a prefix delete (`remove('versions/<slug>/')`) names the video's folder
  assert.equal(localPathOf('versions/spot'), path.join(paths.VERSIONS, 'spot'));
  for (const key of ['versions//v1.mp4', 'versions/w/v1.mp4', `versions/${'a'.repeat(300)}/v1.mp4`, 'versions/'])
    assert.throws(() => localPathOf(key), /not a video id/, key);
  for (const key of ['previews/w/p.mp4', 'refs//r.jpg']) assert.throws(() => localPathOf(key), /not a video id/, key);
});

test('MEDIA-3: no part of any key climbs out of where it lives', () => {
  for (const key of [
    'versions/../x/v1.mp4',
    'versions/./v1.mp4',
    'versions/spot/../../users.json',
    'previews/spot/../../../etc/hosts',
    'refs/spot/./../x',
    'playbooks/../users.json',
    'avatars/../secret.key',
    'asks/c_1/../../users.json',
    'scrub/../../data/users.json',
    'scrub/a\0b.mp4',
  ])
    assert.throws(() => localPathOf(key), key);
  // what the app's keys look like stays as it was
  assert.equal(localPathOf('scrub/abc123.mp4'), path.join(paths.CACHE, 'scrub', 'abc123.mp4'));
  assert.equal(localPathOf('refs/spot/r_1.t.jpg'), path.join(paths.DATA, 'spot', 'refs', 'r_1.t.jpg'));
  assert.equal(localPathOf('avatars/u_1-ab.jpg'), path.join(paths.DATA, 'avatars', 'u_1-ab.jpg'));
});
