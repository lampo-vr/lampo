// covers: lib/store.ts lib/archive.ts lib/folders.ts lib/folderIds.ts lib/names.ts lib/shares.ts
// A name that came in as JSON can hold a lone surrogate ("odd\ud800name.mp4"), and a name cut with `slice` can end in
// half an emoji: stored as it is, every URL built from it (encodeURIComponent) throws — in the browser while the library
// renders, on the server while the inbox or search answers —, for everyone in the workspace. Names are made
// well-formed where they come in and cut by characters, never through one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { uploadName, uploadFolder } = await import('../../lib/store.ts');
const { safeSegment } = await import('../../lib/archive.ts');
const { normFolder, folderName } = await import('../../lib/folders.ts');
const { parseFolders, cleanArchived, foldersFile, archivedProjectOf, checkNotArchived } = await import('../../lib/folderIds.ts');
const { repairFolders } = await import('../../lib/folders.ts');
const { cutChars, wellFormed, cleanDisplayName, cleanAgentName, shownName } = await import('../../lib/names.ts');
const { guestName } = await import('../../lib/shares.ts');

const encodes = (s: string | null) => {
  assert.ok(s?.isWellFormed(), JSON.stringify(s));
  assert.doesNotThrow(() => encodeURIComponent(s as string));
};
/** An emoji astride a limit of `n` characters (UTF-16 units: the emoji is two). */
const astride = (n: number) => `${'a'.repeat(n - 1)}😀b`;

test('an upload’s name with a lone surrogate is made well-formed, so URLs can be built from it', () => {
  const name = uploadName('odd\ud800name.mp4');
  assert.ok(name.isWellFormed(), JSON.stringify(name));
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.equal(name, 'odd�name.mp4');
  assert.equal(uploadName('Über Spot.mp4'), 'Über Spot.mp4', 'a proper name stays as it is');
});

test('a path segment with a lone surrogate is made well-formed too', () => {
  for (const raw of ['a\udc00b', '\ud83d', 'end\ud800']) {
    const s = safeSegment(raw);
    assert.ok(s.isWellFormed(), JSON.stringify(s));
    assert.doesNotThrow(() => encodeURIComponent(s));
  }
  assert.equal(safeSegment('Kapitel 1'), 'Kapitel 1');
});

test('a folder from an upload, or named for a folder made, moved into or found: well-formed, never cut through a letter', () => {
  for (const clean of [uploadFolder, normFolder, folderName]) {
    for (const raw of ['Acme\ud800', '\udfffAcme/Reels', 'Acme/\udc00\ud800']) encodes(clean(raw));
    assert.equal(clean('Acme\ud800/Reels'), 'Acme\ufffd/Reels', 'the lone half becomes U+FFFD, as on the disk');
    // a long name with an emoji at its 60th character: kept whole, the cut after it
    assert.equal(clean(astride(60)), `${'a'.repeat(59)}😀`);
    assert.equal(clean(`Brand/${astride(60)}`), `Brand/${'a'.repeat(59)}😀`);
    assert.equal(clean('Acme/Spring Sale'), 'Acme/Spring Sale', 'a proper name stays as it is');
  }
});

test('names cut by characters: an emoji at the limit is kept or left out whole', () => {
  assert.equal(cutChars('short', 10), 'short');
  assert.equal(cutChars(astride(5), 5), 'aaaa😀');
  assert.equal(cutChars('😀😀😀', 2), '😀😀');
  encodes(guestName(`${'a'.repeat(39)}𝐀b`));
  assert.equal(guestName(`${'a'.repeat(39)}𝐀b`), `${'a'.repeat(39)}𝐀`);
  assert.equal(guestName('Max Mustermann'), 'Max Mustermann');
});

test('parsed JSON made well-formed: every string, keys too; what needs nothing comes back as it was', () => {
  const body = JSON.parse('{"label":"Client\\ud800","list":["a","\\udfff"],"deep":{"x\\ud800":{"y":"\\ud800z"}},"n":1,"ok":true,"none":null}');
  const out = wellFormed(body);
  assert.deepEqual(out, { label: 'Client\ufffd', list: ['a', '\ufffd'], deep: { 'x\ufffd': { y: '\ufffdz' } }, n: 1, ok: true, none: null });
  assert.ok(JSON.stringify(out).isWellFormed() && !/\\ud[89a-f]/i.test(JSON.stringify(out)));
  const fine = { a: 'Über', b: ['😀'], c: { d: 1 } };
  assert.equal(wellFormed(fine), fine, 'the same object');
  const buf = Buffer.from([0xed, 0xa0, 0x80]);
  assert.equal(wellFormed(buf), buf, 'bytes are no JSON');
  // a key named __proto__ stays a key: it never becomes the object's prototype
  const sly = wellFormed(JSON.parse('{"__proto__":{"polluted":"\\ud800"},"x":"\\ud800"}'));
  assert.equal(Object.getPrototypeOf(sly), Object.prototype);
  assert.equal((sly as { polluted?: string }).polluted, undefined);
  assert.deepEqual(Object.keys(sly), ['__proto__', 'x']);
  assert.equal(({} as { polluted?: string }).polluted, undefined);
});

test('folders.json as an older version kept it reads well-formed', () => {
  const f = parseFolders(JSON.stringify({ folders: ['Acme\ud800', 'Acme\ud800/Reels', 'Plain'], ids: { 'Acme\ud800': 'f_0123456789ab' } }));
  assert.deepEqual(f.folders, ['Acme\ufffd', 'Acme\ufffd/Reels', 'Plain']);
  assert.deepEqual(f.ids, { 'Acme\ufffd': 'f_0123456789ab' });
});

test('an archived project’s record reads well-formed too, from a whole file or a damaged one, and still locks its project', () => {
  const stored = { folders: ['Old\ud800', 'Old\ud800/Reels'], archived: { 'Old\ud800': { at: '2026-10-07T10:00:00', by: 'Olivia\udfff' } } };
  assert.deepEqual(cleanArchived(parseFolders(JSON.stringify(stored)).archived), { 'Old\ufffd': { at: '2026-10-07T10:00:00', by: 'Olivia\ufffd' } });
  assert.deepEqual(cleanArchived(stored.archived), { 'Old\ufffd': { at: '2026-10-07T10:00:00', by: 'Olivia\ufffd' } });
  // the videos inside read their folder well-formed (lib/store.ts shownNames): the lock still holds for them
  fs.mkdirSync(path.dirname(foldersFile()), { recursive: true });
  fs.writeFileSync(foldersFile(), JSON.stringify(stored));
  assert.equal(archivedProjectOf('Old\ufffd/Reels'), 'Old\ufffd');
  assert.throws(() => checkNotArchived('Old\ufffd'), { status: 423 });
  // a damaged file: what its text still says is recovered well-formed, the archived mark with it
  fs.writeFileSync(foldersFile(), `${JSON.stringify(stored).slice(0, -1)},"ids":{`);
  const r = repairFolders();
  assert.equal(r.state, 'damaged');
  assert.deepEqual(
    r.folders.filter((x) => x.startsWith('Old')),
    ['Old\ufffd', 'Old\ufffd/Reels'],
  );
  fs.rmSync(foldersFile());
});

test('display names come in well-formed, and a stored one reads well-formed', () => {
  assert.equal(cleanDisplayName('Olivia\udfff'), 'Olivia\ufffd');
  assert.equal(cleanAgentName('codex\ud800'), 'codex\ufffd');
  encodes(shownName('Max\ud800'));
  encodes(shownName('agent:reel\udc00'));
  assert.equal(shownName('Olivia'), 'Olivia');
});
