// The store-only ZIP writer behind "Download all", checked by two independent readers (Python's zipfile and Info-ZIP's
// unzip): deterministic archives and streamed ones (data descriptors), ZIP64 (forced with small files, and a real
// archive past 4 GB as a sparse file), ranges that add up to the whole, empty entries and non-ASCII names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { planZip, type ZipEntry, type ZipPlan } from '../../lib/zip.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-zip-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function* slices(buf: Buffer, start: number, end: number, chunk = 1000): AsyncGenerator<Buffer> {
  for (let i = start; i <= end; i += chunk) yield buf.subarray(i, Math.min(end + 1, i + chunk));
}

function entry(name: string, data: Buffer, { knownCrc = true } = {}): ZipEntry {
  return { name, size: data.length, crc: knownCrc ? zlib.crc32(data) : null, mtime: new Date('2026-09-28T12:34:56Z'), read: (s, e) => slices(data, s, e) };
}

async function collect(plan: ZipPlan, range?: { start: number; end: number }): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of plan.bytes(range)) parts.push(b);
  return Buffer.concat(parts);
}

// Python reads the central directory, checks every CRC (testzip) and hands back names, sizes and contents.
function python(file: string): { bad: string | null; entries: { name: string; size: number; sha: string }[] } {
  const script = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "entries": [{"name": i.filename, "size": i.file_size, "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
}
const unzipOk = (file: string) => /No errors detected/.test(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const files = [
  { name: 'Reels/spot_v3.mp4', data: crypto.randomBytes(70_001) },
  { name: 'Reels/Übergang – Schnitt_v1.mov', data: crypto.randomBytes(12_345) },
  { name: 'Reels/Spring/empty_v1.mp4', data: Buffer.alloc(0) },
  { name: 'Reels/Spring/teaser_v2.mp4', data: crypto.randomBytes(3) },
];

for (const [label, opts] of [
  ['deterministic', { knownCrc: true, zip64At: undefined }],
  ['streamed (data descriptors)', { knownCrc: false, zip64At: undefined }],
  ['deterministic, ZIP64 forced', { knownCrc: true, zip64At: 10 }],
  ['streamed, ZIP64 forced', { knownCrc: false, zip64At: 10 }],
] as const) {
  test(`zip ${label}: valid for Python and unzip, names and bytes intact, length as planned`, async () => {
    const plan = planZip(
      files.map((f) => entry(f.name, f.data, { knownCrc: opts.knownCrc })),
      { zip64At: opts.zip64At },
    );
    assert.equal(plan.deterministic, opts.knownCrc);
    const out = await collect(plan);
    assert.equal(out.length, plan.length, 'Content-Length is exact before the first byte');
    const file = path.join(dir, `${label.replace(/\W+/g, '-')}.zip`);
    fs.writeFileSync(file, out);
    const got = python(file);
    assert.equal(got.bad, null, 'every CRC checks out');
    assert.deepEqual(
      got.entries,
      files.map((f) => ({ name: f.name, size: f.data.length, sha: sha(f.data) })),
    );
    assert.ok(unzipOk(file), 'unzip -t agrees');
  });
}

test('the same entries give the same bytes; ranges of a deterministic archive add up to the whole', async () => {
  const plan = () => planZip(files.map((f) => entry(f.name, f.data)));
  const whole = await collect(plan());
  assert.equal(sha(await collect(plan())), sha(whole), 'deterministic');
  const p = plan();
  for (const cut of [1, 30, 29_999, 70_050, whole.length - 23, whole.length - 1]) {
    const a = await collect(p, { start: 0, end: cut - 1 });
    const b = await collect(p, { start: cut, end: whole.length - 1 });
    assert.equal(sha(Buffer.concat([a, b])), sha(whole), `split at ${cut}`);
  }
  assert.equal(sha(await collect(p, { start: 100, end: 199 })), sha(whole.subarray(100, 200)));
});

test('a streamed archive refuses ranges (its CRCs are only known after reading)', async () => {
  const plan = planZip(files.map((f) => entry(f.name, f.data, { knownCrc: false })));
  await assert.rejects(collect(plan, { start: 10, end: 20 }), /ranges need every CRC/);
});

test('an entry that changes size while it is read breaks the archive instead of corrupting it silently', async () => {
  const data = crypto.randomBytes(5000);
  const plan = planZip([{ ...entry('a.mp4', data), read: (s, e) => slices(data, s, Math.min(e, 999)) }]);
  await assert.rejects(collect(plan), /changed size/);
});

// A real archive past 4 GB: one entry of 4.3 GB (zeros, never held in memory) followed by a small one, written as a
// sparse file. Python lists it and reads the small entry that sits behind the 4 GB mark.
test('ZIP64 for real: a 4.3 GB entry and a file behind it', { timeout: 180_000 }, async () => {
  const size = 4_300_000_000;
  const zero = Buffer.alloc(8 << 20);
  async function* zeros(start: number, end: number): AsyncGenerator<Buffer> {
    for (let i = start; i <= end; i += zero.length) yield zero.subarray(0, Math.min(zero.length, end + 1 - i));
  }
  const tail = crypto.randomBytes(4096);
  const plan = planZip([{ name: 'big/huge_v1.mov', size, crc: null, mtime: new Date('2026-09-28T00:00:00Z'), read: zeros }, entry('big/after_v1.mp4', tail)]);
  const file = path.join(dir, 'big.zip');
  const fd = fs.openSync(file, 'w');
  let pos = 0;
  try {
    for await (const b of plan.bytes()) {
      // Zero chunks leave holes, so the test writes kilobytes, not gigabytes.
      if (!(b.length === zero.length && b.equals(zero)) && !(b.length > 64 && b.every((x) => x === 0))) fs.writeSync(fd, b, 0, b.length, pos);
      pos += b.length;
    }
    fs.ftruncateSync(fd, pos);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(pos, plan.length);
  const script = `
import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
i = z.infolist()
print(json.dumps({"sizes": [x.file_size for x in i], "after": hashlib.sha256(z.read(i[1])).hexdigest(), "offset": i[1].header_offset}))
`;
  const got = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
  assert.deepEqual(got.sizes, [size, tail.length]);
  assert.equal(got.after, sha(tail));
  assert.ok(got.offset > 0xffffffff, 'the second entry really sits past 4 GB');
  assert.match(execFileSync('unzip', ['-l', file], { encoding: 'utf8' }), /4300000000\s+.*huge_v1\.mov/);
});
