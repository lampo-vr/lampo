// Reads the PNGs Chrome writes (8-bit RGB or RGBA, not interlaced) into pixels, and compares two of them: enough for a
// screenshot baseline without a dependency.
import zlib from 'node:zlib';

/** @returns {{ width: number, height: number, channels: number, data: Buffer }} */
export function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || body[12] !== 0 || ![2, 6].includes(color)) throw new Error(`unsupported PNG (depth ${depth}, colour ${color})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** How many pixels differ by more than `threshold` in any colour channel; `size` when the pictures don't match in size. */
export function diffPng(a, b, threshold = 24) {
  const x = readPng(a);
  const y = readPng(b);
  if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}×${x.height} vs ${y.width}×${y.height}`, changed: 0, total: 0 };
  let changed = 0;
  for (let i = 0, j = 0; i < x.data.length; i += x.channels, j += y.channels)
    if (
      Math.abs(x.data[i] - y.data[j]) > threshold ||
      Math.abs(x.data[i + 1] - y.data[j + 1]) > threshold ||
      Math.abs(x.data[i + 2] - y.data[j + 2]) > threshold
    )
      changed++;
  return { changed, total: x.width * x.height };
}
