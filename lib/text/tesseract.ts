// Linux (or any machine without macOS Vision): tesseract, one process per frame, a few in parallel. The TSV output
// has word boxes and confidences; words are grouped back into lines so the result looks like Vision's.
import os from 'node:os';
import { settings } from '../env.ts';
import { runBg } from '../probe.ts';
import type { OcrLine, OcrPage, OcrWord } from './types.ts';

const tesseract = () => settings.LAMPO_TESSERACT || 'tesseract';

/** Installed language data, e.g. ["deu", "eng", "osd"]; null when tesseract is missing. */
export async function tesseractLanguages(): Promise<string[] | null> {
  try {
    const { stdout, stderr } = await runBg(tesseract(), ['--list-langs']);
    return `${stdout}\n${stderr}`
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]{3,}$/i.test(l));
  } catch {
    return null;
  }
}

interface Row {
  level: number;
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

function parseTsv(tsv: string): { width: number; height: number; rows: Row[] } {
  let width = 0;
  let height = 0;
  const rows: Row[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12) continue;
    const [level, , block, par, ln, , left, top, w, h, conf] = c.slice(0, 11).map(Number);
    const text = c.slice(11).join('\t');
    if (level === 1) {
      width = w;
      height = h;
    }
    if (level === 5) rows.push({ level, key: `${block}.${par}.${ln}`, left, top, width: w, height: h, conf, text });
  }
  return { width, height, rows };
}

export function tsvToPage(file: string, tsv: string): OcrPage {
  const { width: W, height: H, rows } = parseTsv(tsv);
  const lines = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.conf < 0 || !r.text.trim()) continue;
    const l = lines.get(r.key) || [];
    l.push(r);
    lines.set(r.key, l);
  }
  const box = (x: number, y: number, w: number, h: number) => ({ x: x / W, y: y / H, w: w / W, h: h / H });
  const out: OcrLine[] = [];
  for (const words of lines.values()) {
    const x0 = Math.min(...words.map((w) => w.left));
    const y0 = Math.min(...words.map((w) => w.top));
    const x1 = Math.max(...words.map((w) => w.left + w.width));
    const y1 = Math.max(...words.map((w) => w.top + w.height));
    const ws: OcrWord[] = words.map((w) => ({ text: w.text.trim(), box: box(w.left, w.top, w.width, w.height) }));
    out.push({
      text: ws.map((w) => w.text).join(' '),
      conf: words.reduce((s, w) => s + w.conf, 0) / words.length / 100,
      box: box(x0, y0, x1 - x0, y1 - y0),
      words: ws,
    });
  }
  return { path: file, width: W, height: H, lines: out, error: null };
}

export function tesseractOcr(langs: string[]): (images: string[]) => Promise<OcrPage[]> {
  // psm 11 = sparse text: captions and titles scattered over a picture, not a page of prose.
  const args = (img: string) => [img, 'stdout', '-l', langs.join('+'), '--psm', '11', 'tsv'];
  // One thread per process and several processes: frames are independent, and OpenMP inside each would oversubscribe.
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const parallel = Math.max(1, Math.min(4, os.availableParallelism() - 1));
  return async (images) => {
    const pages: OcrPage[] = new Array(images.length);
    let next = 0;
    const worker = async () => {
      while (next < images.length) {
        const i = next++;
        try {
          const { stdout } = await runBg(tesseract(), args(images[i]), { env, maxBuffer: 16 * 1024 * 1024 });
          pages[i] = tsvToPage(images[i], stdout.toString());
        } catch (e) {
          pages[i] = { path: images[i], width: 0, height: 0, lines: [], error: (e as Error).message.split('\n')[0] };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, images.length) }, worker));
    return pages;
  };
}
