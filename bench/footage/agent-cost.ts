#!/usr/bin/env node
// What "find a usable B-roll shot for X" costs an agent, in tokens (bench/tokens/count.ts: text heuristic, Claude's
// image estimate), on this bench's footage library — done for real, with every picture made and measured:
//   (a1) today, careful: list the files, probe them, look at every clip as 4×4 grids of a frame every 2 s, then two
//        close looks (a 5×4 grid at 5 fps) to find the cut points of the candidates.
//   (a2) today, smart: scene detection (ffmpeg's scene score) → one frame per shot in 4×4 grids + the cut times as
//        text, then the same two close looks.
//   (b)  Lampo: the two tool definitions on every turn, one find_footage answer (k = 6) and one footage_sheet image.
//   node bench/footage/agent-cost.ts [--db file] [--model siglip-b16:q8:pad]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { approxTokens, imageSize, imageTokens, toolListCost } from '../tokens/count.ts';
import { BENCH, CLIPS_DIR, RESULTS_DIR, readJson, WORK_DIR, writeJson } from './common.ts';
import { type Dtype, loadEmbedder } from './embed.ts';
import { compactList, contactSheet, loadIndex, parseQuery, prompt, search } from './find.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};
const dbFile = arg('db', path.join(WORK_DIR, 'index.db'));
const model = arg('model', 'siglip-b16:q8:pad');
const out = path.join(WORK_DIR, 'agent-cost');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** The two tools as a client hands them to the model (name, description, input schema — what bench/tokens counts). */
export const FOOTAGE_TOOLS = [
  {
    name: 'find_footage',
    description:
      'Shots in the footage library, one line each: id, clip, in–out, length, aspect, move, score. query = what the picture shows; the rest in filters.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        min_s: { type: 'number' },
        max_s: { type: 'number' },
        motion: { type: 'string', enum: ['static', 'push-in', 'pull-out', 'pan', 'tilt', 'handheld'] },
        text: { type: 'string', description: '"none", or words on screen' },
        said: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    name: 'footage_sheet',
    description: 'One labelled contact sheet of shots by id; frames 3 shows the move.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, frames: { type: 'integer', enum: [1, 3] } },
      required: ['ids'],
    },
  },
];

const img = (file: string) => {
  const s = imageSize(fs.readFileSync(file).toString('base64'));
  return s ? { w: s.w, h: s.h, tokens: imageTokens(s.w, s.h) } : { w: 0, h: 0, tokens: 0 };
};
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const CALL = 40; // a tool call itself (the command or arguments the model writes, kept in context)

const clips = fs
  .readdirSync(CLIPS_DIR)
  .filter((f) => f.endsWith('.mp4'))
  .sort();
const durations = clips.map((f) =>
  Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(CLIPS_DIR, f)]).trim()),
);
const footageMin = durations.reduce((a, b) => a + b, 0) / 60;

// ---------------------------------------------------------------- (a) today
const ls = sh('ls', ['-la', CLIPS_DIR]).replace(new RegExp(CLIPS_DIR, 'g'), 'footage');
const probe = clips
  .map(
    (f) =>
      `${f},${sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'csv=p=0', path.join(CLIPS_DIR, f)])
        .trim()
        .replace(/\n/g, ',')}`,
  )
  .join('\n');
const survey = { calls: 2, text: approxTokens(ls) + approxTokens(probe) };

function grids(kind: 'every2s' | 'scenes') {
  let images = 0;
  let tokens = 0;
  let calls = 0;
  let text = 0;
  for (const f of clips) {
    const full = path.join(CLIPS_DIR, f);
    const dirOf = path.join(out, kind, f);
    fs.mkdirSync(dirOf, { recursive: true });
    const sel = kind === 'every2s' ? 'fps=1/2' : "select='gt(scene,0.3)+eq(n,0)'";
    sh('ffmpeg', ['-v', 'error', '-y', '-i', full, '-vf', `${sel},scale=320:-2,tile=4x4`, '-fps_mode', 'vfr', path.join(dirOf, 'g%02d.jpg')]);
    calls++;
    if (kind === 'scenes') {
      // the cut times, one number a line: what the agent needs to map tiles to timecodes
      const times = sh('ffprobe', ['-v', 'error', '-f', 'lavfi', `movie=${full},select=gt(scene\\,0.3)`, '-show_entries', 'frame=pts_time', '-of', 'csv=p=0']);
      text += approxTokens(times);
      calls++;
    }
    for (const g of fs.readdirSync(dirOf)) {
      const m = img(path.join(dirOf, g));
      images++;
      tokens += m.tokens;
      calls++; // each picture is read with its own call
    }
  }
  return { images, imageTokens: tokens, text, calls };
}
const a1grids = grids('every2s');
const a2grids = grids('scenes');
// two close looks at candidates: 4 s around a cut at 5 fps, 5×4 tiles of 320 px
const close: number[] = [];
for (const [f, t] of [
  ['reel_products_white.mp4', 1.5],
  ['reel_vertical.mp4', 20],
] as const) {
  const o = path.join(out, `close-${f}.jpg`);
  sh('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-t', '4', '-i', path.join(CLIPS_DIR, f), '-vf', 'fps=5,scale=320:-2,tile=5x4', '-frames:v', '1', o]);
  close.push(img(o).tokens);
}
const closeTokens = close.reduce((a, b) => a + b, 0);
const a = (g: typeof a1grids) => {
  const calls = survey.calls + g.calls + 2 * 2;
  return {
    calls,
    images: g.images + 2,
    text: survey.text + g.text,
    imageTokens: g.imageTokens + closeTokens,
    total: survey.text + g.text + g.imageTokens + closeTokens + calls * CALL,
  };
};

// ---------------------------------------------------------------- (b) Lampo
const tools = toolListCost(FOOTAGE_TOOLS);
const ix = loadIndex(dbFile, model);
const [key, dtype] = model.split(':') as [string, Dtype];
const te = await loadEmbedder(key, dtype, 4, { vision: false });
const { queries } = readJson<{ queries: { id: string; q: string }[] }>(path.join(BENCH, 'queries.json'));
const lists: number[] = [];
const sheets: number[] = [];
let example = '';
for (const q of queries) {
  const p = parseQuery(q.q);
  const qv = p.semantic ? ((await te.texts([prompt(p.semantic)]))[0] as Float32Array) : null;
  const hits = search(ix, qv, p, { k: 6 });
  const text = compactList(hits, p, ix.shots.length);
  if (q.id === 'q01') example = text;
  lists.push(approxTokens(text));
  const f = path.join(out, `sheet-${q.id}.jpg`);
  contactSheet(hits, ix.dir, f);
  sheets.push(img(f).tokens);
}
await te.dispose();
const avg = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
const b = { calls: 2, listTokens: avg(lists), sheetTokens: avg(sheets), args: 2 * CALL, total: avg(lists) + avg(sheets) + 2 * CALL };
const TURNS = 8;

const result = {
  footage: { clips: clips.length, minutes: +footageMin.toFixed(1), shots: ix.shots.length },
  a1: a(a1grids),
  a2: a(a2grids),
  b,
  toolsPerTurn: tools.total,
  toolsPerTool: tools.per,
  perHour: {
    a1: Math.round((a(a1grids).total / footageMin) * 60),
    a2: Math.round((a(a2grids).total / footageMin) * 60),
  },
  session8Turns: { b: b.total + TURNS * tools.total },
  example,
};
writeJson(path.join(RESULTS_DIR, 'agent-cost.json'), result);
console.log(JSON.stringify(result, null, 1));
fs.mkdirSync(RESULTS_DIR, { recursive: true });
