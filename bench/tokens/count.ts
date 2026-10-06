// How many tokens a piece of text or an image costs an agent, without a network or a model's tokenizer. A heuristic
// that tracks real tokenizers within ~15 % on our mix of prose, paths, ids and JSON — good enough to compare before and
// after and to hold budgets (test/unit/token-budget.test.ts); never quote it as an exact price.
//   words: ⌈letters / 5⌉ each (a short word is one token, a long one two or three)
//   digit runs: ⌈digits / 3⌉
//   punctuation and symbols: 0.7 each (tokenizers merge some pairs, like `":` or `//`)
//   other characters (é, →, ü, emoji): 1 each

export function approxTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g)) {
    const s = m[0];
    if (/^[A-Za-z]/.test(s)) n += Math.ceil(s.length / 5);
    else if (/^[0-9]/.test(s)) n += Math.ceil(s.length / 3);
    else n += s.charCodeAt(0) < 128 ? 0.7 : 1;
  }
  return Math.round(n);
}

/**
 * An image's cost for Claude: scaled to fit 1568 px on the long edge and about 1.15 megapixels, then w·h / 750
 * (Anthropic's published estimate). Other models price images differently; the ratio before/after is what matters.
 */
export function imageTokens(w: number, h: number): number {
  let s = Math.min(1, 1568 / Math.max(w, h));
  s = Math.min(s, Math.sqrt(1_150_000 / (w * h)));
  return Math.round((w * s * (h * s)) / 750);
}

/** Width and height of a JPEG or PNG given as base64 (the MCP image content), or null. */
export function imageSize(b64: string): { w: number; h: number } | null {
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(1, 4).toString('latin1') === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** What one MCP tool result costs: its text, its images and their sizes. */
export interface ResultCost {
  text: number;
  images: number;
  imageTokens: number;
  sizes: string[];
  total: number;
}

export function resultCost(content: { type: string; text?: string; data?: string }[]): ResultCost {
  let text = 0;
  let images = 0;
  let img = 0;
  const sizes: string[] = [];
  for (const c of content) {
    if (c.type === 'text' && c.text) text += approxTokens(c.text);
    else if (c.type === 'image' && c.data) {
      const s = imageSize(c.data);
      images++;
      if (s) {
        img += imageTokens(s.w, s.h);
        sizes.push(`${s.w}×${s.h}`);
      }
    }
  }
  return { text, images, imageTokens: img, sizes, total: text + img };
}

/** What the tool list costs on every turn: names, titles, descriptions, input schemas and annotations as JSON. */
export function toolListCost(tools: object[]): { total: number; per: { name: string; tokens: number }[] } {
  const per = tools.map((t) => ({ name: (t as { name: string }).name, tokens: approxTokens(JSON.stringify(t)) }));
  return { total: per.reduce((s, x) => s + x.tokens, 0), per: per.sort((a, b) => b.tokens - a.tokens) };
}
