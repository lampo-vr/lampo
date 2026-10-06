// The tar a bundle travels in (lib/bundle.ts): POSIX ustar, regular files only, written and read here without a
// dependency. The reader is for files from outside (`vr admin import`), so it takes only what the writer makes: a
// header whose checksum adds up, a plain relative name of letters, digits, `.`, `_`, `-` and `/` (never `.` or `..`, never
// absolute), a regular file or a pax header that carries a size — no link, folder, device or GNU long name — and every
// name once. Anything else is a TarError and the whole archive is refused.
import crypto from 'node:crypto';
import fs from 'node:fs';

const BLOCK = 512;
const CHUNK = 1 << 20;
/** The largest size the 11 octal digits of a ustar header hold; past it a pax header carries the size. */
const USTAR_MAX = 0o77777777777;
/** What one name may be: our layout's names are short and plain. */
const NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class TarError extends Error {
  status = 400;
}

/** Whether a name is one this format writes and reads: relative, plain, no part that climbs. */
export const tarName = (name: string): boolean =>
  NAME.test(name) && name.length <= 255 && !name.split('/').some((p) => p === '.' || p === '..') && !!splitName(name);

/** A name as ustar keeps it: up to 100 bytes, or a folder part of up to 155 in `prefix` and the rest. */
function splitName(name: string): { prefix: string; name: string } | null {
  if (name.length <= 100) return { prefix: '', name };
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1))
    if (i <= 155 && name.length - i - 1 <= 100 && name.length - i - 1 > 0) return { prefix: name.slice(0, i), name: name.slice(i + 1) };
  return null;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(full: string, size: number, type: '0' | 'x', mtime: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  const { prefix, name } = splitName(full) ?? { prefix: '', name: full };
  b.write(name, 0, 100, 'ascii');
  if (prefix) b.write(prefix, 345, 155, 'ascii');
  b.write(octal(0o644, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(mtime, 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return b;
}

/** A pax record "<len> key=value\n", its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

export interface TarWriter {
  /** Adds a file from this disk; resolves with the sha256 of the bytes written (read once, while writing). */
  file(name: string, src: string): Promise<{ sha256: string; size: number }>;
  /** Adds bytes held in memory. */
  buffer(name: string, data: Buffer): Promise<{ sha256: string; size: number }>;
  /** Ends the archive (two empty blocks) and closes the file. */
  close(): Promise<void>;
  /** Bytes written so far. */
  readonly bytes: number;
}

/** A new archive at `file` (written over). Entries keep the order they are added in. */
export async function openTarWriter(file: string, mtime = Math.floor(Date.now() / 1000)): Promise<TarWriter> {
  const fh = await fs.promises.open(file, 'w', 0o600);
  let bytes = 0;
  const seen = new Set<string>();
  const write = async (b: Buffer) => {
    await fh.write(b, 0, b.length);
    bytes += b.length;
  };
  const begin = async (name: string, size: number) => {
    if (!tarName(name)) throw new TarError(`not a name a bundle may hold: ${JSON.stringify(name).slice(0, 120)}`);
    if (seen.has(name)) throw new TarError(`${name} is in the archive already`);
    seen.add(name);
    if (size > USTAR_MAX) {
      const pax = Buffer.from(paxRecord('size', String(size)), 'utf8');
      await write(header('PaxHeader', pax.length, 'x', mtime));
      await write(pad(pax));
    }
    await write(header(name, size > USTAR_MAX ? 0 : size, '0', mtime));
  };
  const pad = (b: Buffer) => (b.length % BLOCK ? Buffer.concat([b, Buffer.alloc(BLOCK - (b.length % BLOCK))]) : b);
  return {
    get bytes() {
      return bytes;
    },
    async file(name, src) {
      const src0 = await fs.promises.open(src, 'r');
      try {
        const st = await src0.stat();
        if (!st.isFile()) throw new TarError(`${name}: not a regular file`);
        const size = st.size;
        await begin(name, size);
        const h = crypto.createHash('sha256');
        const buf = Buffer.alloc(CHUNK);
        let done = 0;
        while (done < size) {
          const { bytesRead } = await src0.read(buf, 0, Math.min(CHUNK, size - done), done);
          if (!bytesRead) throw new Error(`${name} got shorter while it was being read: try again`);
          const part = buf.subarray(0, bytesRead);
          h.update(part);
          await write(part);
          done += bytesRead;
        }
        // a file that grew while it was read: its bytes in the archive are the first `size`, but say so
        if ((await src0.stat()).size !== size) throw new Error(`${name} changed while it was being read: try again`);
        if (size % BLOCK) await write(Buffer.alloc(BLOCK - (size % BLOCK)));
        return { sha256: h.digest('hex'), size };
      } finally {
        await src0.close();
      }
    },
    async buffer(name, data) {
      await begin(name, data.length);
      await write(pad(data));
      return { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
    },
    async close() {
      await write(Buffer.alloc(BLOCK * 2));
      await fh.close();
    },
  };
}

export interface TarEntry {
  name: string;
  size: number;
}

export interface TarLimits {
  /** At most this many entries. */
  entries: number;
  /** The most one entry may be, by its name (the caller's layout knows what each holds). */
  maxSize(name: string): number;
}

function readOctal(b: Buffer, start: number, len: number, what: string): number {
  const s = b
    .subarray(start, start + len)
    .toString('ascii')
    .replace(/[\0 ]+$/, '')
    .replace(/^ +/, '');
  if (!/^[0-7]*$/.test(s)) throw new TarError(`a header's ${what} is not a number`);
  return s ? Number.parseInt(s, 8) : 0;
}

function checkHeader(b: Buffer): void {
  const stored = readOctal(b, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (b[i] as number);
  if (sum !== stored) throw new TarError('a header’s checksum does not add up: the archive is damaged');
  if (b.subarray(257, 263).toString('latin1') !== 'ustar\0') throw new TarError('not a ustar archive');
}

/** The size a pax header carries; any other key is refused (this format writes none). */
function paxSize(data: Buffer): number {
  const text = data.toString('utf8');
  let size: number | null = null;
  for (let i = 0; i < text.length; ) {
    const sp = text.indexOf(' ', i);
    const len = Number(text.slice(i, sp));
    if (sp < 0 || !Number.isSafeInteger(len) || len <= 0 || i + len > text.length) throw new TarError('a pax header is damaged');
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    const key = rec.slice(0, eq);
    if (key !== 'size' || !/^\d{1,16}$/.test(rec.slice(eq + 1))) throw new TarError(`a pax header carries ${JSON.stringify(key).slice(0, 40)}: refused`);
    size = Number(rec.slice(eq + 1));
    i += len;
  }
  if (size === null || !Number.isSafeInteger(size)) throw new TarError('a pax header without a size');
  return size;
}

/**
 * Reads an archive entry by entry: `visit` gets each file's name and size and must read its bytes from `chunks` (what
 * it leaves unread is skipped). Throws a TarError on anything this format doesn't write, before `visit` sees it.
 */
export async function readTar(file: string, limits: TarLimits, visit: (entry: TarEntry, chunks: AsyncIterable<Buffer>) => Promise<void>): Promise<number> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const total = (await fh.stat()).size;
    let pos = 0;
    let entries = 0;
    let paxPending: number | null = null;
    const seen = new Set<string>();
    const block = Buffer.alloc(BLOCK);
    const readBlock = async (): Promise<boolean> => {
      if (pos + BLOCK > total) throw new TarError('the archive ends in the middle of an entry (cut off?)');
      const { bytesRead } = await fh.read(block, 0, BLOCK, pos);
      if (bytesRead !== BLOCK) throw new TarError('the archive could not be read to its end');
      pos += BLOCK;
      return !block.every((x) => x === 0);
    };
    for (;;) {
      if (!(await readBlock())) {
        // the end: a second empty block, then nothing but empty blocks (tar pads to its record size)
        if (await readBlock()) throw new TarError('an empty block in the middle of the archive');
        const rest = Buffer.alloc(Math.min(CHUNK, Math.max(0, total - pos)));
        while (pos < total) {
          const { bytesRead } = await fh.read(rest, 0, Math.min(rest.length, total - pos), pos);
          if (!rest.subarray(0, bytesRead).every((x) => x === 0)) throw new TarError('there is more after the end of the archive');
          pos += bytesRead;
        }
        if (paxPending !== null) throw new TarError('a pax header at the end, with no file after it');
        return entries;
      }
      checkHeader(block);
      const type = String.fromCharCode(block[156] as number);
      const rawName = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      let size = readOctal(block, 124, 12, 'size');
      if (type === 'x') {
        if (paxPending !== null) throw new TarError('two pax headers in a row');
        if (size > 4096) throw new TarError('a pax header that large is not one this format writes');
        const data = Buffer.alloc(size);
        const { bytesRead } = await fh.read(data, 0, size, pos);
        if (bytesRead !== size) throw new TarError('the archive ends in a pax header');
        pos += Math.ceil(size / BLOCK) * BLOCK;
        paxPending = paxSize(data);
        continue;
      }
      if (type !== '0' && type !== '\0') {
        const what = type === '1' || type === '2' ? 'a link' : type === '5' ? 'a folder' : `an entry of type ${JSON.stringify(type)}`;
        throw new TarError(`${what} in the archive (${JSON.stringify(rawName).slice(0, 80)}): only plain files are taken`);
      }
      const name = prefix ? `${prefix}/${rawName}` : rawName;
      if (!tarName(name)) throw new TarError(`a name a bundle never holds: ${JSON.stringify(name).slice(0, 120)}`);
      if (seen.has(name)) throw new TarError(`${name} is in the archive twice`);
      seen.add(name);
      if (paxPending !== null) {
        size = paxPending;
        paxPending = null;
      }
      if (++entries > limits.entries) throw new TarError(`more than ${limits.entries} files in the archive`);
      if (size > limits.maxSize(name)) throw new TarError(`${name} is ${size} bytes, more than such a file may be (${limits.maxSize(name)})`);
      if (pos + size > total) throw new TarError(`the archive ends inside ${name} (cut off?)`);
      const start = pos;
      let read = 0;
      const chunks: AsyncIterable<Buffer> = {
        async *[Symbol.asyncIterator]() {
          const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
          while (read < size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - read), start + read);
            if (!bytesRead) throw new TarError(`the archive ends inside ${name}`);
            read += bytesRead;
            // a copy: the caller may keep it while the next one is read
            yield Buffer.from(buf.subarray(0, bytesRead));
          }
        },
      };
      await visit({ name, size }, chunks);
      pos = start + Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await fh.close();
  }
}
