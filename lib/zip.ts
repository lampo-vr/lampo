// Store-only ZIP for "Download all". Video is compressed already, so every entry is stored as it is (method 0) and the
// archive's length is known before the first byte goes out. When every entry's CRC-32 is known (lib/archive.ts caches
// them) each byte is known too: the archive is deterministic, so any byte range can be served and an interrupted
// download resumes. Without the CRCs it streams with data descriptors (each CRC follows its entry's data): the same
// length, but no ranges. ZIP64 fields appear only where a size or an offset needs them (4 GB and up), so ordinary
// archives stay readable by every unzipper. The format is APPNOTE 6.3.10.
import zlib from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, "/"-separated and already safe (see safeZipName in lib/archive.ts). */
  name: string;
  size: number;
  /** CRC-32 of the bytes, or null when not known yet (the archive then streams with data descriptors). */
  crc: number | null;
  mtime: Date;
  /** Bytes start..end (inclusive) of the entry. */
  read(start: number, end: number): AsyncIterable<Buffer>;
}

export interface ZipPlan {
  length: number;
  /** Every byte is known up front: ranges can be served. */
  deterministic: boolean;
  /** The archive, or bytes start..end (inclusive) of it; ranges only when deterministic. */
  bytes(range?: { start: number; end: number }): AsyncGenerator<Buffer>;
}

const U32 = 0xffffffff;
const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;
const MADE_BY = (3 << 8) | 45; // Unix, spec 4.5
const FILE_MODE = (0o100644 << 16) >>> 0;

// DOS time is local time by convention (macOS's ditto and Archive Utility read only this field); the extended
// timestamp field (0x5455) carries the exact Unix time for unzippers that prefer it.
function dosTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const y = Math.min(year, 2107) - 1980;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const unixTime = (d: Date) => Math.max(0, Math.min(U32, Math.floor(d.getTime() / 1000)));

function extendedTime(d: Date): Buffer {
  const b = Buffer.alloc(9);
  b.writeUInt16LE(0x5455, 0);
  b.writeUInt16LE(5, 2);
  b.writeUInt8(1, 4); // modification time present
  b.writeUInt32LE(unixTime(d), 5);
  return b;
}

function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => {
    b.writeBigUInt64LE(BigInt(v), 4 + 8 * i);
  });
  return b;
}

interface Laid {
  entry: ZipEntry;
  name: Buffer;
  offset: number;
  /** The entry's size needs ZIP64 fields. */
  big: boolean;
  /** Its local header offset needs a ZIP64 field in the central directory. */
  far: boolean;
  descLen: number;
  centralLen: number;
}

type Seg = { at: number; len: number } & ({ kind: 'buf'; buf: Buffer } | { kind: 'data'; i: number } | { kind: 'desc'; i: number } | { kind: 'tail' });

/**
 * Lays out an archive. `zip64At` is where 32-bit fields give out (tests lower it to exercise ZIP64 with small files).
 */
export function planZip(entries: ZipEntry[], { zip64At = U32 }: { zip64At?: number } = {}): ZipPlan {
  // An empty entry has no data segment to compute its CRC from: it is 0.
  const crcs: (number | null)[] = entries.map((e) => (e.size === 0 ? 0 : e.crc));
  const streaming = crcs.some((c) => c === null);
  const flags = UTF8 | (streaming ? DESCRIPTOR : 0);
  const laid: Laid[] = [];
  const segs: Seg[] = [];
  let at = 0;
  const push = (seg: Seg) => {
    segs.push(seg);
    at += seg.len;
  };

  for (const [i, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, 'utf8');
    const big = entry.size >= zip64At;
    const far = at >= zip64At;
    const { time, date } = dosTime(entry.mtime);
    const ext = Buffer.concat([...(big ? [zip64Extra(streaming ? [0, 0] : [entry.size, entry.size])] : []), extendedTime(entry.mtime)]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : streaming ? 20 : 10, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(streaming ? 0 : (crcs[i] as number), 14);
    const size32 = big ? U32 : streaming ? 0 : entry.size;
    local.writeUInt32LE(size32, 18);
    local.writeUInt32LE(size32, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(ext.length, 28);
    const header = Buffer.concat([local, name, ext]);
    const descLen = streaming ? (big ? 24 : 16) : 0;
    const zip64Fields = (big ? 2 : 0) + (far ? 1 : 0);
    const centralLen = 46 + name.length + (zip64Fields ? 4 + 8 * zip64Fields : 0) + 9;
    laid.push({ entry, name, offset: at, big, far, descLen, centralLen });
    push({ at, len: header.length, kind: 'buf', buf: header });
    if (entry.size) push({ at, len: entry.size, kind: 'data', i });
    if (descLen) push({ at, len: descLen, kind: 'desc', i });
  }

  const cdOffset = at;
  const cdSize = laid.reduce((s, l) => s + l.centralLen, 0);
  const needs64 = laid.length >= 0xffff || cdOffset >= zip64At || cdSize >= zip64At;
  const tailLen = cdSize + (needs64 ? 56 + 20 : 0) + 22;
  push({ at, len: tailLen, kind: 'tail' });
  const length = at;

  function descriptor(l: Laid, crc: number): Buffer {
    const b = Buffer.alloc(l.descLen);
    b.writeUInt32LE(0x08074b50, 0);
    b.writeUInt32LE(crc, 4);
    if (l.big) {
      b.writeBigUInt64LE(BigInt(l.entry.size), 8);
      b.writeBigUInt64LE(BigInt(l.entry.size), 16);
    } else {
      b.writeUInt32LE(l.entry.size, 8);
      b.writeUInt32LE(l.entry.size, 12);
    }
    return b;
  }

  function tail(): Buffer {
    const parts: Buffer[] = [];
    for (const [i, l] of laid.entries()) {
      const { time, date } = dosTime(l.entry.mtime);
      const extra64 = [...(l.big ? [l.entry.size, l.entry.size] : []), ...(l.far ? [l.offset] : [])];
      const ext = Buffer.concat([...(extra64.length ? [zip64Extra(extra64)] : []), extendedTime(l.entry.mtime)]);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(MADE_BY, 4);
      h.writeUInt16LE(l.big || l.far ? 45 : streaming ? 20 : 10, 6);
      h.writeUInt16LE(flags, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(crcs[i] as number, 16);
      h.writeUInt32LE(l.big ? U32 : l.entry.size, 20);
      h.writeUInt32LE(l.big ? U32 : l.entry.size, 24);
      h.writeUInt16LE(l.name.length, 28);
      h.writeUInt16LE(ext.length, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attributes
      h.writeUInt32LE(FILE_MODE, 38);
      h.writeUInt32LE(l.far ? U32 : l.offset, 42);
      parts.push(h, l.name, ext);
    }
    if (needs64) {
      const e64 = Buffer.alloc(56);
      e64.writeUInt32LE(0x06064b50, 0);
      e64.writeBigUInt64LE(44n, 4);
      e64.writeUInt16LE(MADE_BY, 12);
      e64.writeUInt16LE(45, 14);
      e64.writeUInt32LE(0, 16);
      e64.writeUInt32LE(0, 20);
      e64.writeBigUInt64LE(BigInt(laid.length), 24);
      e64.writeBigUInt64LE(BigInt(laid.length), 32);
      e64.writeBigUInt64LE(BigInt(cdSize), 40);
      e64.writeBigUInt64LE(BigInt(cdOffset), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
      loc.writeUInt32LE(1, 16);
      parts.push(e64, loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(laid.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(laid.length, 0xffff), 10);
    end.writeUInt32LE(cdSize >= zip64At ? U32 : cdSize, 12);
    end.writeUInt32LE(cdOffset >= zip64At ? U32 : cdOffset, 16);
    parts.push(end);
    const out = Buffer.concat(parts);
    if (out.length !== tailLen) throw new Error(`zip: central directory is ${out.length} bytes, planned ${tailLen}`);
    return out;
  }

  async function* bytes(range?: { start: number; end: number }): AsyncGenerator<Buffer> {
    const start = range?.start ?? 0;
    const end = range?.end ?? length - 1;
    if (start < 0 || end >= length || start > end) throw new RangeError('zip: range outside the archive');
    if (streaming && (start !== 0 || end !== length - 1)) throw new Error('zip: ranges need every CRC');
    for (const seg of segs) {
      const segEnd = seg.at + seg.len - 1;
      if (segEnd < start || seg.at > end) continue;
      const from = Math.max(start, seg.at) - seg.at;
      const to = Math.min(end, segEnd) - seg.at;
      if (seg.kind === 'buf') yield seg.buf.subarray(from, to + 1);
      else if (seg.kind === 'data') {
        const l = laid[seg.i];
        let crc = 0;
        let seen = 0;
        for await (const chunk of l.entry.read(from, to)) {
          if (streaming) crc = zlib.crc32(chunk, crc);
          seen += chunk.length;
          yield chunk;
        }
        if (seen !== to - from + 1) throw new Error(`zip: ${l.entry.name} changed size while it was read`);
        if (streaming) crcs[seg.i] = crc;
      } else if (seg.kind === 'desc') yield descriptor(laid[seg.i], crcs[seg.i] as number).subarray(from, to + 1);
      else yield tail().subarray(from, to + 1);
    }
  }

  return { length, deterministic: !streaming, bytes };
}
