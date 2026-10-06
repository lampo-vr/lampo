// What a review link is called, to its owner and to its visitors. A link nobody named is called "Review link" (it was
// "Client" for a video and "Review" for a folder): its owner sees that, its visitors see no name at all — a default is
// not a name, and "Client" under the video's title told a colleague or a producer they were one. A name someone gave
// the link is what visitors read.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';

const { dir } = isolatedEnv();
const { request: owner, port } = await startApp({ loadSessions: async () => [] });
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const { slugify } = await import('../../lib/paths.ts');

const guest = client(port, { 'x-forwarded-for': '203.0.113.21' });
const enc = encodeURIComponent;

function track(rel: string, folder: string): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  folders.moveVideo(slug, folder, 'tester');
  return slug;
}

/** The link's label as its owner lists it, and as its visitor reads it on the link and on its video's page. */
async function seen(token: string, slug: string | null): Promise<{ owner: string; link: string; page: string }> {
  const list = slug ? (await owner('GET', `/api/review/${enc(slug)}/shares`)).json() : (await owner('GET', '/api/shares')).json();
  const mine = list.shares.find((s: { token: string }) => s.token === token);
  const link = (await guest('GET', `/api/g/${token}`)).json();
  const page = (await guest('GET', `/api/g/${token}/review/${link.videos[0].slug}`)).json();
  return { owner: mine.label, link: link.label, page: page.label };
}

test('a link nobody named is "Review link" to its owner and has no name for its visitors', async () => {
  const slug = track('a/spot.mp4', 'Acme');
  const video = (await owner('POST', `/api/review/${enc(slug)}/shares`, { body: {} })).json();
  assert.deepEqual(await seen(video.token, slug), { owner: 'Review link', link: '', page: '' });
  const folder = (await owner('POST', '/api/folder-shares', { body: { folder: 'Acme' } })).json();
  assert.deepEqual(await seen(folder.token, null), { owner: 'Review link', link: '', page: '' });
});

test('the old defaults ("Client", "Review") aren’t shown as names either; a name someone gave the link is', async () => {
  const slug = track('b/teaser.mp4', 'Bravo');
  for (const label of ['Client', 'Review']) {
    const s = (await owner('POST', `/api/review/${enc(slug)}/shares`, { body: { label } })).json();
    assert.deepEqual(await seen(s.token, slug), { owner: label, link: '', page: '' }, label);
  }
  const named = (await owner('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Mia at Northwind' } })).json();
  assert.deepEqual(await seen(named.token, slug), { owner: 'Mia at Northwind', link: 'Mia at Northwind', page: 'Mia at Northwind' });
  assert.equal(shares.guestLabel({ label: 'Review link' }), '');
  assert.equal(shares.guestLabel({ label: 'Producers' }), 'Producers');
});

test('a name longer than a link keeps ends at a word with "…", never in the middle of one', () => {
  const long = 'Northwind Q4 launch film — director’s cut for the board, second pass with new music and the longer end card';
  const kept = shares.cleanLabel(long);
  assert.ok(Array.from(kept).length <= shares.LABEL_MAX, kept);
  assert.equal(kept, 'Northwind Q4 launch film — director’s cut for the board, second pass with new…');
  assert.equal(shares.cleanLabel(`  ${'Producers'}  `), 'Producers');
  // one word too long for a space to cut at: cut, but still said to be cut
  const word = 'x'.repeat(120);
  assert.equal(shares.cleanLabel(word), `${'x'.repeat(shares.LABEL_MAX - 1)}…`);
});
