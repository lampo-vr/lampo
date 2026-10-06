// The ⌘K search (lib/search.ts, GET /api/search): every word must match, German spelling both ways, start of text
// beats start of a word beats inside a word, then the most recent; archived videos never show; on a server anyone who
// may view the library can search it, nobody else.
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import type { SearchResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const auth = await import('../../lib/auth.ts');
const shares = await import('../../lib/shares.ts');
const { search, fold } = await import('../../lib/search.ts');

function video(rel: string, folder: string | null): string {
  const file = makeVideo(path.join(dir, rel), { dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}
const spot = video('proj/export/Überblick-Spot.mp4', 'Acme/Reels');
const teaser = video('proj/export/teaser.mp4', 'Acme/Reels/Cutdowns');
const gone = video('proj/export/old-spot.mp4', 'Acme/Reels');

const note = (slug: string, text: string, author = 'tester') => store.addComment(slug, { frame: 3, text, author });
const logoFirst = note(spot, 'Logo zu früh');
const logoWord = note(teaser, 'Das Logo flackert');
const logoInside = note(spot, 'Der Kinologo-Abspann ist zu lang');
const fade = note(teaser, 'Bitte die Überblendung weicher machen', 'guest:Mia');
const replied = note(spot, 'Musik leiser');
store.updateComment(replied.id, { note: 'Straße-Atmo jetzt auch leiser', by: 'agent:promo-edit' });
note(gone, 'Logo auf dem alten Spot');
store.removeVideo(gone);

const ids = (r: SearchResponse) => r.notes.map((n) => n.id);
const { base } = await startApp();

test('folding: case, accents and ß', () => {
  assert.equal(fold('ÄNDERUNG Straße Café'), 'anderung strasse cafe');
});

test('German spelling both ways: Ü, U and UE all find the note', () => {
  for (const q of ['Überblendung', 'uberblendung', 'ueberblendung', 'ÜBERBLENDUNG', 'blendung']) assert.deepEqual(ids(search(q)), [fade.id], q);
  assert.deepEqual(
    search('strasse').notes.map((n) => [n.id, n.reply]),
    [[replied.id, 'Straße-Atmo jetzt auch leiser']],
    'found through the reply, which is shown',
  );
  assert.deepEqual(
    search('ueberblick').videos.map((v) => v.slug),
    [spot],
  );
});

test('ranking: start of the text, then start of a word, then inside a word; archived videos never', () => {
  assert.deepEqual(ids(search('logo')), [logoFirst.id, logoWord.id, logoInside.id]);
  assert.ok(!search('alten').notes.length, 'notes of an archived video stay hidden');
  assert.ok(!search('old').videos.length, 'and so does the video');
});

test('every word has to match; the video name narrows notes but never lists a video’s notes by itself', () => {
  assert.deepEqual(ids(search('logo teaser')), [logoWord.id]);
  assert.deepEqual(ids(search('spot')), [], 'a note has to mention something itself');
  assert.deepEqual(ids(search('mia')), [fade.id], 'who wrote it counts');
  assert.deepEqual(ids(search('logo nirgends')), []);
});

test('videos come with their stage and poster, folders with how many videos they hold', () => {
  const r = search('reels');
  assert.deepEqual(
    r.folders.map((f) => [f.folder, f.name, f.videos]),
    [
      ['Acme/Reels', 'Reels', 2],
      ['Acme/Reels/Cutdowns', 'Cutdowns', 1],
    ],
  );
  assert.deepEqual(r.videos.map((v) => v.slug).sort(), [spot, teaser].sort(), 'folder names find videos too');
  const v = search('teaser').videos[0];
  assert.equal(v?.stage, 'changes');
  assert.equal(v?.stage_label, 'Changes requested');
  assert.match(v?.poster || '', /^\/api\/poster\/.+\.jpg\?h=[0-9a-f]{10}$/);
  // Slugs encode paths, but nothing else in a result may name a place on the server's disk.
  const shown = JSON.stringify(
    ['reels', 'logo', 'teaser', 'mia', 'strasse', ''].map((q) => search(q)),
    (k, x) => (k === 'slug' || k === 'poster' ? undefined : x),
  );
  assert.ok(shown.includes('Überblick-Spot.mp4') && !shown.includes(dir), shown);
});

test('no query: the most recently changed videos; limit caps every group', () => {
  const empty = search('   ');
  assert.deepEqual([empty.folders.length, empty.notes.length], [0, 0]);
  assert.equal(empty.videos.length, 2);
  assert.equal(search('logo', { limit: 1 }).notes.length, 1);
});

// ---------------------------------------------------------------- the API on a server

let member = '';
let reviewer = '';
before(async () => {
  const m = await auth.createUser({ email: 'mo@example.com', name: 'Mo', password: 'correct horse battery', role: 'member' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'correct horse battery', role: 'reviewer' });
  member = auth.createToken(m.id, 'test').token;
  reviewer = auth.createToken(r.id, 'test').token;
});

const get = (url: string, token?: string) => fetch(base + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('API: members and reviewers search the library; signed out or through a review link, nothing', async () => {
  for (const token of [member, reviewer]) {
    const res = await get('/api/search?q=%C3%BCberblendung', token);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SearchResponse;
    assert.deepEqual(ids(body), [fade.id]);
    assert.equal(body.notes[0]?.author, 'guest:Mia');
    assert.equal(body.notes[0]?.kind, 'feedback');
  }
  assert.equal((await get('/api/search?q=logo')).status, 401);
  const link = shares.createShare({ folder: 'Acme' }, { by: 'tester', label: 'Acme' });
  assert.equal((await get(`/api/g/${link.token}/search?q=logo`)).status, 404, 'no search behind a review link');
  assert.equal((await get('/api/search?q=logo&limit=100', member)).status, 400);
});
