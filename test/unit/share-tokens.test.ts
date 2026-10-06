// Review-link tokens at rest: shares.json keys links by the token's SHA-256 and keeps only a sealed copy, so a leaked
// file or backup opens no link. Stores from before (tokens as keys) keep working and are rewritten on start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { DATA } = await import('../../lib/paths.ts');
const shares = await import('../../lib/shares.ts');
const store = await import('../../lib/store.ts');

const FILE = path.join(DATA, 'shares.json');
const raw = () => fs.readFileSync(FILE, 'utf8');

test('a new link: no token in the file, found by its token, copied again by the owner', () => {
  const s = shares.createShare({ folder: 'Acme' }, { label: 'Acme room', by: 'tester' });
  assert.ok(!raw().includes(s.token), 'the token itself is nowhere in shares.json');
  const keys = Object.keys(JSON.parse(raw()).shares);
  assert.deepEqual(keys, [shares.tokenKey(s.token)]);
  assert.match(keys[0], /^sha256:[0-9a-f]{64}$/);
  assert.equal(shares.resolveShare(s.token)?.label, 'Acme room');
  // one character off (never the token itself: one in 64 ends in "x")
  assert.equal(shares.resolveShare(`${s.token.slice(0, -1)}${s.token.endsWith('x') ? 'y' : 'x'}`), null);
  const listed = shares.listShares({ folder: 'Acme' });
  assert.equal(listed[0]?.token, s.token, 'the owner can still copy the link');
  assert.equal((listed[0] as { sealed?: string }).sealed, undefined, 'the sealed copy never leaves lib/shares');
  shares.recordVisit(s.token, { open: true, name: 'Mia' });
  assert.equal(shares.resolveShare(s.token)?.stats?.opens, 1);
  assert.ok(shares.revokeShare(s.token));
  assert.equal(shares.resolveShare(s.token), null);
});

test('a shares.json from before: its links keep working, and the start-up migration hashes them', () => {
  const legacy = 'OldStyleToken_abcdefghijkl';
  const file = JSON.parse(raw());
  file.shares[legacy] = { slug: 'x__spot.mp4', label: 'Legacy client', created: '2026-09-01T10:00:00+02:00', by: 'tester' };
  fs.writeFileSync(FILE, JSON.stringify(file));
  assert.equal(shares.resolveShare(legacy)?.label, 'Legacy client', 'read as before, without a rewrite');
  assert.ok(shares.migrateShareTokens());
  assert.ok(!raw().includes(legacy), 'no token in clear after the migration');
  assert.equal(shares.resolveShare(legacy)?.label, 'Legacy client');
  assert.ok(shares.listShares('x__spot.mp4').some((s) => s.token === legacy));
  assert.equal(shares.migrateShareTokens(), false, 'nothing left to migrate');
});

test('a sealed copy from another key is not shown again, but the link still opens', () => {
  const s = shares.createShare('x__teaser.mp4', { label: 'Teaser', by: 'tester' });
  const file = JSON.parse(raw());
  file.shares[shares.tokenKey(s.token)].sealed = 'AAAA.BBBB.CCCC';
  fs.writeFileSync(FILE, JSON.stringify(file));
  assert.ok(!shares.listShares('x__teaser.mp4').length);
  assert.equal(shares.resolveShare(s.token)?.label, 'Teaser');
});

// Links from before link ids: their notes carry no link id either, and they count as the link's own while no other
// link ever covered the video. That needs each link's real id, which a hashed key no longer tells.
function oldClientNote(name: string): string {
  const video = makeVideo(path.join(dir, `old/${name}.mp4`), { w: 160, h: 90, dur: 1 });
  age(video);
  store.createOrGetReview(video, { by: 'tester' });
  const slug = path.resolve(video).split('/').join('__');
  store.addComment(slug, { frame: 3, text: `before link ids (${name})`, author: 'guest:Mia' });
  return slug;
}
const seen = (token: string, slug: string) => shares.visibleNotes(must(shares.resolveShare(token)), must(store.loadReview(slug))).map((c) => c.text);
const idOf = (token: string) => JSON.parse(raw()).shares[shares.tokenKey(token)]?.id;

test('a link from before link ids keeps showing its old client notes once its token is stored hashed', () => {
  const slug = oldClientNote('spot');
  const legacy = 'LegacyNotesToken_abcdefgh';
  const file = JSON.parse(raw());
  file.shares[legacy] = { slug, label: 'Old client', created: '2026-06-01T10:00:00+02:00', by: 'tester' };
  fs.writeFileSync(FILE, JSON.stringify(file));
  assert.deepEqual(seen(legacy, slug), ['before link ids (spot)'], 'read from the old file');
  const derived = shares.shareId(must(shares.resolveShare(legacy)));
  assert.ok(shares.migrateShareTokens());
  assert.equal(idOf(legacy), derived, 'the link keeps the id its notes were made with, now stored');
  assert.deepEqual(seen(legacy, slug), ['before link ids (spot)'], 'and its old notes');
});

test('links hashed before ids were stored get their id at the next start', () => {
  const slug = oldClientNote('teaser');
  const legacy = 'LegacyHashedToken_abcdefg';
  const file = JSON.parse(raw());
  file.shares[legacy] = { slug, label: 'Old client', created: '2026-06-01T10:00:00+02:00', by: 'tester' };
  fs.writeFileSync(FILE, JSON.stringify(file));
  shares.migrateShareTokens();
  const derived = idOf(legacy);
  // What an earlier start-up wrote: hashed and sealed, but no id.
  const hashed = JSON.parse(raw());
  delete hashed.shares[shares.tokenKey(legacy)].id;
  fs.writeFileSync(FILE, JSON.stringify(hashed));
  assert.ok(shares.migrateShareTokens(), 'there is something to do');
  assert.equal(idOf(legacy), derived, 'the id comes from the sealed token');
  assert.deepEqual(seen(legacy, slug), ['before link ids (teaser)']);
  assert.equal(shares.migrateShareTokens(), false, 'nothing left to do');
});
