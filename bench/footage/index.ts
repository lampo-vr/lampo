#!/usr/bin/env node
// The footage indexer (prototype, not wired into the app): clips → shots (cuts) → camera move per shot → keyframes →
// on-screen text (OCR) + what is said (transcript) → image embeddings → one SQLite file (node:sqlite, no server).
//   node bench/footage/index.ts [--db file] [--models clip-b32:q8,siglip2-b16:q8:squash,…] [--ocr tesseract[,vision]|off]
//                               [--threads 4] [--clips dir]
// A model is key:dtype[:fit] (fit: crop · squash · pad, default crop). Timings per stage go to <db>.timings.json.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Analysis, analysisHeight, decodeClip, keyframesFor, probeClip, type ShotMotion, shotMotion } from './analyse.ts';
import { CLIPS_DIR, WORK_DIR, writeJson } from './common.ts';
import { type Dtype, type Fit, framesAt, loadEmbedder } from './embed.ts';
import { cleanOcr, OCR_MIN_CONF, type OcrLineLite } from './find.ts';

// Lampo's own pieces run against a throwaway store (never a live one)
process.env.VR_DATA ||= path.join(WORK_DIR, 'store', 'data');
process.env.VR_CACHE ||= path.join(WORK_DIR, 'store', 'cache');
const { cutsFromDiffs } = await import('../../lib/cuts.ts');

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clips (id INTEGER PRIMARY KEY, file TEXT UNIQUE, width INT, height INT, fps REAL, frames INT, duration REAL, audio INT);
CREATE TABLE IF NOT EXISTS shots (id INTEGER PRIMARY KEY, clip_id INT, n INT, f_in INT, f_out INT, motion TEXT, speed TEXT, zoom REAL, dx REAL, dy REAL, path REAL, text TEXT, said TEXT);
CREATE TABLE IF NOT EXISTS keyframes (id INTEGER PRIMARY KEY, shot_id INT, frame INT, thumb TEXT);
CREATE TABLE IF NOT EXISTS vectors (kf_id INT, model TEXT, vec BLOB, PRIMARY KEY (kf_id, model));
CREATE TABLE IF NOT EXISTS ocr (kf_id INT, engine TEXT, text TEXT, conf REAL);
CREATE VIRTUAL TABLE IF NOT EXISTS shot_words USING fts5(text, said, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`;

interface Timing {
  stage: string;
  wallMs: number;
  cpuMs: number;
  items: number;
}

/** Runs ffmpeg with -benchmark and returns its CPU time (user + sys), which a child's wall clock hides. */
function ffmpegCpu(args: string[]): { cpuMs: number; wallMs: number } {
  const t0 = performance.now();
  const r = spawnSync('ffmpeg', ['-benchmark', '-hide_banner', '-nostats', '-v', 'info', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-400)}`);
  const m = /utime=([\d.]+)s stime=([\d.]+)s/.exec(r.stderr);
  return { cpuMs: m ? (Number(m[1]) + Number(m[2])) * 1000 : 0, wallMs: performance.now() - t0 };
}

async function main() {
  const dbFile = arg('db', path.join(WORK_DIR, 'index.db'));
  const clipsDir = arg('clips', CLIPS_DIR);
  const ocrEngines = arg('ocr', 'tesseract')
    .split(',')
    .filter((e) => e && e !== 'off');
  const threads = Number(arg('threads', '4'));
  const models = arg('models', 'siglip-b16:q8:pad')
    .split(',')
    .filter(Boolean)
    .map((m) => {
      const [key, dtype = 'q8', fit = 'crop'] = m.split(':') as [string, Dtype?, Fit?];
      return { key, dtype: dtype as Dtype, fit: fit as Fit, name: `${key}:${dtype}:${fit}` };
    });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const fresh = !fs.existsSync(dbFile);
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const timings: Timing[] = [];
  const time = (stage: string, wallMs: number, cpuMs: number, items: number) => {
    const t = timings.find((x) => x.stage === stage);
    if (t) {
      t.wallMs += wallMs;
      t.cpuMs += cpuMs;
      t.items += items;
    } else timings.push({ stage, wallMs, cpuMs, items });
  };

  const files = fs
    .readdirSync(clipsDir)
    .filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f))
    .sort();
  const kfDir = path.join(path.dirname(dbFile), 'keyframes');
  const thumbDir = path.join(path.dirname(dbFile), 'thumbs');
  let footageSecs = 0;

  // ---------------------------------------------------------------- shots, moves, keyframes, text, words
  if (fresh || !db.prepare('SELECT count(*) n FROM shots').get()?.n) {
    const insClip = db.prepare('INSERT INTO clips (file, width, height, fps, frames, duration, audio) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insShot = db.prepare(
      'INSERT INTO shots (clip_id, n, f_in, f_out, motion, speed, zoom, dx, dy, path, text, said) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insKf = db.prepare('INSERT INTO keyframes (shot_id, frame, thumb) VALUES (?, ?, ?)');
    const insWords = db.prepare('INSERT INTO shot_words (rowid, text, said) VALUES (?, ?, ?)');
    const insOcr = db.prepare('INSERT INTO ocr (kf_id, engine, text, conf) VALUES (?, ?, ?, ?)');
    const lib = await import('../../lib/text/tesseract.ts');
    const vision = await import('../../lib/text/vision.ts');
    for (const file of files) {
      const full = path.join(clipsDir, file);
      const info = await probeClip(full);
      footageSecs += info.duration;
      // one decode: cuts + motion
      const dec = await decodeClip(full, info);
      time('decode 128 px + cuts + motion (JS)', dec.decodeMs, dec.cpuMs, info.frames);
      const cuts = cutsFromDiffs(dec.diffs)
        .map((c: { frame: number }) => c.frame)
        .filter((c: number) => c < info.frames);
      const bounds = [0, ...cuts, info.frames];
      const shots: { in: number; out: number; motion: ShotMotion; kfs: number[] }[] = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const a = bounds[i] as number;
        const b = bounds[i + 1] as number;
        shots.push({
          in: a,
          out: b,
          motion: shotMotion(dec.pairs as Analysis['pairs'], a, b, info.fps, 128, analysisHeight(info.width, info.height)),
          kfs: keyframesFor(a, b, info.fps),
        });
      }
      // keyframes: full size for the OCR, a 360 px thumbnail kept for contact sheets — one decode
      const all = shots.flatMap((s) => s.kfs);
      const cdir = path.join(kfDir, path.basename(file));
      const tdir = path.join(thumbDir, path.basename(file));
      fs.mkdirSync(cdir, { recursive: true });
      fs.mkdirSync(tdir, { recursive: true });
      const select = `select='${all.map((f) => `eq(n\\,${f})`).join('+')}'`;
      const long = info.width >= info.height ? 'scale=360:-2' : 'scale=-2:360';
      const g = ffmpegCpu([
        '-y',
        '-i',
        full,
        '-filter_complex',
        `[0:v]${select},split=2[a][b];[b]${long}:flags=area[t]`,
        '-map',
        '[a]',
        '-fps_mode',
        'passthrough',
        '-q:v',
        '2',
        path.join(cdir, '%04d.jpg'),
        '-map',
        '[t]',
        '-fps_mode',
        'passthrough',
        '-q:v',
        '4',
        path.join(tdir, '%04d.jpg'),
      ]);
      time('keyframe grabs (ffmpeg)', g.wallMs, g.cpuMs, all.length);
      const sorted = [...all].sort((x, y) => x - y);
      const nameOf = (f: number) => `${String(sorted.indexOf(f) + 1).padStart(4, '0')}.jpg`;
      // OCR every keyframe, with each engine asked for; the raw lines are kept (ocr table), the first engine's
      // cleaned lines become the shot's text
      const pagesBy = new Map<string, OcrLineLite[][]>();
      for (const engine of ocrEngines) {
        const imgs = sorted.map((f) => path.join(cdir, nameOf(f)));
        const t0 = performance.now();
        const pages = engine === 'vision' ? await vision.visionOcr(imgs) : await lib.tesseractOcr(['eng', 'deu'])(imgs);
        // the engines run as child processes (a few at once): wall time here, CPU per frame in speed.ts
        time(`ocr (${engine})`, performance.now() - t0, 0, imgs.length);
        pagesBy.set(
          engine,
          pages.map((p) => p.lines),
        );
      }
      const texts = new Map<number, string[]>();
      const first = ocrEngines[0];
      if (first) for (const [i, lines] of (pagesBy.get(first) ?? []).entries()) texts.set(sorted[i] as number, cleanOcr(lines, OCR_MIN_CONF[first] ?? 0.75));
      // what is said: a transcript next to the clip (here: the voice-over's script with its timings)
      const wordsFile = full.replace(/\.[^.]+$/, '.words.json');
      const words: { text: string; t0: number; t1: number }[] = fs.existsSync(wordsFile) ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')).words : [];
      const clipId = Number(insClip.run(file, info.width, info.height, info.fps, info.frames, info.duration, info.audio ? 1 : 0).lastInsertRowid);
      shots.forEach((s, n) => {
        const text = [...new Set(s.kfs.flatMap((f) => texts.get(f) ?? []))].join(' · ');
        const said = words
          .filter((w) => {
            const mid = ((w.t0 + w.t1) / 2) * info.fps;
            return mid >= s.in && mid < s.out;
          })
          .map((w) => w.text)
          .join(' ');
        const m = s.motion;
        const id = Number(insShot.run(clipId, n, s.in, s.out, m.kind, m.speed, m.zoom, m.dx, m.dy, m.path, text, said).lastInsertRowid);
        if (text || said) insWords.run(id, text, said);
        for (const f of s.kfs) {
          const kf = Number(insKf.run(id, f, path.relative(path.dirname(dbFile), path.join(tdir, nameOf(f)))).lastInsertRowid);
          for (const [engine, pages] of pagesBy) for (const l of pages[sorted.indexOf(f)] ?? []) insOcr.run(kf, engine, l.text, l.conf);
        }
      });
      console.log(`${file.padEnd(26)} ${String(shots.length).padStart(3)} shots ${String(all.length).padStart(3)} keyframes`);
    }
  }

  // ---------------------------------------------------------------- embeddings, per model
  const kfs = db
    .prepare('SELECT k.id, k.frame, c.file FROM keyframes k JOIN shots s ON s.id = k.shot_id JOIN clips c ON c.id = s.clip_id ORDER BY c.file, k.frame')
    .all() as { id: number; frame: number; file: string }[];
  const byClip = new Map<string, { id: number; frame: number }[]>();
  for (const k of kfs) byClip.set(k.file, [...(byClip.get(k.file) ?? []), k]);
  const insVec = db.prepare('INSERT OR REPLACE INTO vectors (kf_id, model, vec) VALUES (?, ?, ?)');
  for (const m of models) {
    const have = (db.prepare('SELECT count(*) n FROM vectors WHERE model = ?').get(m.name) as { n: number }).n;
    if (have === kfs.length) continue;
    const e = await loadEmbedder(m.key, m.dtype, threads, { text: false });
    let prepMs = 0;
    let embMs = 0;
    let embCpu = 0;
    for (const [file, list] of byClip) {
      const t0 = performance.now();
      const rgb = await framesAt(
        path.join(clipsDir, file),
        list.map((k) => k.frame),
        e.size,
        m.fit,
      );
      prepMs += performance.now() - t0;
      for (let i = 0; i < list.length; i += 8) {
        const batch = rgb.slice(i, i + 8);
        const t1 = performance.now();
        const c1 = process.cpuUsage();
        const vecs = await e.images(batch);
        const c2 = process.cpuUsage(c1);
        embMs += performance.now() - t1;
        embCpu += (c2.user + c2.system) / 1000;
        vecs.forEach((v, j) => {
          insVec.run((list[i + j] as { id: number }).id, m.name, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        });
      }
    }
    time(`frames at model size (ffmpeg) ${m.name}`, prepMs, 0, kfs.length);
    time(`embed ${m.name} (${threads} threads)`, embMs, embCpu, kfs.length);
    await e.dispose();
    console.log(
      `${m.name}: ${kfs.length} keyframes in ${(embMs / 1000).toFixed(1)} s (${(embMs / kfs.length).toFixed(0)} ms each, ${(embCpu / kfs.length).toFixed(0)} ms CPU)`,
    );
  }
  if (footageSecs) timings.push({ stage: 'footage seconds', wallMs: 0, cpuMs: 0, items: Math.round(footageSecs) });
  const tf = `${dbFile}.timings.json`;
  const prev = fs.existsSync(tf) ? (JSON.parse(fs.readFileSync(tf, 'utf8')) as Timing[]) : [];
  writeJson(tf, [...prev.filter((p) => !timings.some((t) => t.stage === p.stage)), ...timings]);
  db.close();
}

if (import.meta.main) {
  // the vision helper compiles once (macOS); make sure ffmpeg exists before a long run
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  await main();
}
