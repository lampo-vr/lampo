// lib/tar.ts, the archive a bundle travels in: what the writer makes, the reader reads back byte for byte (and the
// system's tar too); anything else — a climbing or absolute name, a link, a folder, a GNU long name, a pax header that
// carries more than a size, a damaged header, a name twice, a cut-off archive, bytes after its end — is refused whole.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from '../lib/helpers.ts';

const { openTarWriter, readTar, tarName, TarError } = await import('../../lib/tar.ts');

const dir = tmpdir('vr-test-tar-');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const limits = { entries: 100, maxSize: () => 1e9 };

async function read(file: string): Promise<{ name: string; data: Buffer }[]> {
  const out: { name: string; data: Buffer }[] = [];
  await readTar(file, limits, async (e, chunks) => {
    const parts: Buffer[] = [];
    for await (const c of chunks) parts.push(c);
    out.push({ name: e.name, data: Buffer.concat(parts) });
  });
  return out;
}

/** A header block as any tar tool could write it, for what our writer won't. */
function header(name: string, size: number, type = '0', prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const entry = (name: string, data: Buffer, type = '0', prefix = '') => [
  header(name, data.length, type, prefix),
  data,
  Buffer.alloc((512 - (data.length % 512)) % 512),
];
const archive = (file: string, ...parts: Buffer[][]) => {
  fs.writeFileSync(file, Buffer.concat([...parts.flat(), Buffer.alloc(1024)]));
  return file;
};

test('what the writer makes reads back byte for byte, a long name in two parts included; the system tar reads it too', async () => {
  const file = path.join(dir, 'ok.tar');
  const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
  fs.writeFileSync(path.join(dir, 'big.bin'), big);
  const long = `playbooks/p001/files/skills/sk_0123456789ab/${'a'.repeat(90)}.json`;
  const w = await openTarWriter(file);
  const m = await w.buffer('manifest.json', Buffer.from('{}'));
  const b = await w.file('reviews/r0001/versions/v1.mp4', path.join(dir, 'big.bin'));
  await w.buffer(long, Buffer.from('x'));
  await w.buffer('empty.json', Buffer.alloc(0));
  await w.close();
  assert.equal(m.sha256, sha(Buffer.from('{}')));
  assert.deepEqual([b.sha256, b.size], [sha(big), big.length]);
  const got = await read(file);
  assert.deepEqual(
    got.map((e) => e.name),
    ['manifest.json', 'reviews/r0001/versions/v1.mp4', long, 'empty.json'],
  );
  assert.equal(sha(got[1]?.data as Buffer), sha(big));
  assert.equal(execFileSync('tar', ['tf', file], { encoding: 'utf8' }).trim().split('\n')[2], long);
});

test('the writer takes plain relative names only, each once', async () => {
  for (const bad of ['../x', '/etc/x', 'a/../b', 'a//b', './a', 'a b', 'ä', '', `${'x'.repeat(101)}`]) assert.equal(tarName(bad), false, bad);
  assert.equal(tarName('reviews/r0001/files/c_abc123_clean.png'), true);
  const w = await openTarWriter(path.join(dir, 'dup.tar'));
  await w.buffer('a.json', Buffer.from('1'));
  await assert.rejects(w.buffer('a.json', Buffer.from('2')), TarError);
  await assert.rejects(w.buffer('../a.json', Buffer.from('2')), TarError);
  await w.close();
});

test('the reader refuses anything else, whole', async () => {
  const one = Buffer.from('hello');
  const cases: [string, Buffer[][], RegExp][] = [
    ['climbs', [entry('../../etc/x', one)], /never holds/],
    ['absolute', [entry('/etc/x', one)], /never holds/],
    ['climbs in its prefix', [entry('x', one, '0', '../..')], /never holds/],
    ['symlink', [entry('a', Buffer.alloc(0), '2')], /a link/],
    ['hard link', [entry('a', Buffer.alloc(0), '1')], /a link/],
    ['folder', [entry('a', Buffer.alloc(0), '5')], /a folder/],
    ['GNU long name', [entry('././@LongLink', one, 'L')], /type "L"/],
    ['twice', [entry('a', one), entry('a', one)], /twice/],
    ['pax path', [entry('PaxHeader', Buffer.from('15 path=/etc/x\n'), 'x'), entry('a', one)], /carries "path"/],
  ];
  for (const [what, parts, why] of cases) await assert.rejects(read(archive(path.join(dir, `${what}.tar`), ...parts)), why, what);
  // a header that doesn't add up
  const damaged = Buffer.concat([...entry('a', one).flat(), Buffer.alloc(1024)]);
  damaged[10] = 0x41;
  fs.writeFileSync(path.join(dir, 'damaged.tar'), damaged);
  await assert.rejects(read(path.join(dir, 'damaged.tar')), /checksum/);
  // cut off inside an entry, bytes after the end
  const whole = Buffer.concat([...entry('a', Buffer.alloc(2000, 1)).flat(), Buffer.alloc(1024)]);
  fs.writeFileSync(path.join(dir, 'cut.tar'), whole.subarray(0, 1500));
  await assert.rejects(read(path.join(dir, 'cut.tar')), /cut off|ends/);
  fs.writeFileSync(path.join(dir, 'tail.tar'), Buffer.concat([whole, Buffer.from('more')]));
  await assert.rejects(read(path.join(dir, 'tail.tar')), /more after the end/);
  // more entries, or a larger one, than the caller allows: said before a byte of it is read
  await assert.rejects(
    readTar(archive(path.join(dir, 'many.tar'), entry('a', one), entry('b', one)), { entries: 1, maxSize: () => 10 }, async () => {}),
    /more than 1 files/,
  );
  await assert.rejects(
    readTar(archive(path.join(dir, 'large.tar'), entry('a', one)), { entries: 5, maxSize: () => 4 }, async () => {}),
    /more than such a file may be/,
  );
});
