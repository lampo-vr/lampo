// Names inside a "Download all" zip come from folder and video names people typed (a client's folder, an upload's
// file name). Whatever they are, an entry must unpack as a plain relative file on macOS, Windows and Linux.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { safeSegment, entryName, dedupe } = await import('../../lib/archive.ts');

const unpackable = (name: string) => {
  assert.ok(!name.startsWith('/') && !/^[A-Za-z]:/.test(name), `relative: ${name}`);
  for (const seg of name.split('/')) {
    assert.ok(seg && seg !== '.' && seg !== '..', `no empty or dot segment: ${name}`);
    assert.doesNotMatch(seg, /[\p{Cc}\p{Cf}\\:*?"<>|]/u, `no control, bidi or reserved characters: ${JSON.stringify(seg)}`);
    assert.doesNotMatch(seg, /[. ]$/, `no trailing dot or space (Windows drops them): ${JSON.stringify(seg)}`);
    assert.doesNotMatch(seg, /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])(\..*)?$/i, `no device name: ${seg}`);
  }
  assert.ok(name.length <= 200, `short enough to unpack on Windows: ${name.length}`);
};

test('traversal, device names, bidi overrides and control characters never reach an entry', () => {
  const nasty = [
    entryName('../../etc', ['..', '/abs', 'C:\\x'], '../../passwd', 1, '.mp4'),
    entryName('Acme', ['CONIN$', 'com¹', 'nul.txt'], 'aux', 2, '.mov'),
    entryName('Acme', [], 'invoice\u202Egnp.mp4', 3, '.mp4'),
    entryName('Acme', ['a\u200Bb', 'line\u2028break'], 'tab\there\nnew', 4, '.webm'),
    entryName('Acme', [], 'x', 5, '.mp4\u0000.exe'),
  ];
  for (const n of nasty) unpackable(n);
  assert.equal(nasty[2]?.split('/').pop(), 'invoicegnp.mp4_v3.mp4', 'the override is gone, the name reads as it is');
  assert.ok(nasty[4]?.endsWith('_v5.mp4'), 'an odd extension becomes .mp4');
});

test('names cut to length end without a dot or space, and deep folder trees shrink the folders, not the file', () => {
  assert.equal(safeSegment(`${'a'.repeat(119)}. tail`), 'a'.repeat(119));
  const deep = entryName(
    'Client',
    Array.from({ length: 12 }, (_, i) => `Folder number ${i} with a long descriptive name`),
    'spot_final_master',
    7,
    '.mp4',
  );
  unpackable(deep);
  assert.ok(deep.endsWith('/spot_final_master_v7.mp4'), deep);
});

test('names that differ only in case are told apart', () => {
  assert.deepEqual(dedupe(['A/spot_v1.mp4', 'A/SPOT_v1.mp4']), ['A/spot_v1.mp4', 'A/SPOT_v1 (2).mp4']);
});
