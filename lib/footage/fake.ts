// The stand-in for the image/text model that tests use (VR_FOOTAGE_MODEL=fake): deterministic vectors, no model files,
// no download. A picture's vector says which named colours it is close to; a text's, which colour words it names. So a
// test clip of red, blue and green shots answers "red" with its red shot, the way the real model answers "a red car".
const COLOURS: [string, [number, number, number]][] = [
  ['red', [220, 40, 40]],
  ['green', [40, 180, 60]],
  ['blue', [40, 70, 220]],
  ['yellow', [230, 210, 40]],
  ['white', [240, 240, 240]],
  ['black', [15, 15, 15]],
  ['orange', [240, 140, 30]],
  ['purple', [130, 50, 170]],
  ['cyan', [40, 200, 210]],
  ['magenta', [220, 40, 200]],
  ['grey', [128, 128, 128]],
];
/** Dimensions after the colours: other words, hashed (a text never comes out empty). */
const WORD_DIMS = 5;
export const FAKE_DIM = COLOURS.length + WORD_DIMS;
export const FAKE_SIZE = 32;

const unit = (v: Float32Array): Float32Array => {
  let s = 0;
  for (const x of v) s += x * x;
  const k = s ? 1 / Math.sqrt(s) : 0;
  return v.map((x) => x * k);
};

/** A picture (size × size × 3 RGB): the mean colour of what isn't letterbox black, against each named colour. */
export function fakeImage(rgb: Uint8Array): Float32Array {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const pr = rgb[i] as number;
    const pg = rgb[i + 1] as number;
    const pb = rgb[i + 2] as number;
    if (pr < 8 && pg < 8 && pb < 8) continue;
    r += pr;
    g += pg;
    b += pb;
    n++;
  }
  const mean = n ? [r / n, g / n, b / n] : [0, 0, 0];
  const v = new Float32Array(FAKE_DIM);
  COLOURS.forEach(([, c], i) => {
    const d2 = (mean[0] - c[0]) ** 2 + (mean[1] - c[1]) ** 2 + (mean[2] - c[2]) ** 2;
    v[i] = Math.exp(-d2 / (2 * 60 ** 2));
  });
  return unit(v);
}

/** A text: its colour words, and every other word in one of a few hashed dimensions. */
export function fakeText(text: string): Float32Array {
  const v = new Float32Array(FAKE_DIM);
  for (const w of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    const at = COLOURS.findIndex(([name]) => name === w || (name === 'grey' && w === 'gray'));
    if (at >= 0) v[at] = (v[at] as number) + 1;
    else {
      let h = 0;
      for (const ch of w) h = (h * 31 + (ch.codePointAt(0) as number)) >>> 0;
      const d = COLOURS.length + (h % WORD_DIMS);
      v[d] = (v[d] as number) + 0.3;
    }
  }
  return unit(v);
}
