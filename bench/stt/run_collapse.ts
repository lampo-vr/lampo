// A render's transcript before and after the collapse repair (lib/stt/collapse.ts), on make_music_intro.py's clips,
// through the app's own speech code:
//   before — one Whisper pass, as transcripts were heard until 2026-10-01 (no filter, no repair);
//   alone  — transcribeTimed with the repair and no second listener (Whisper only: the models folder holds Whisper);
//   second — transcribeTimed with the repair and Parakeet on disk as the second listener.
// Scores each clip against the TTS text (word error rate), counts the words heard in the first 30-second window and
// any invented line left, and times every run on a warm engine.
//
// Usage: node bench/stt/run_collapse.ts --manifest <out>/music-intro.jsonl --models <dir with both .gguf files>
//                                       [--modes before,alone,second] [--repeat 3] [--json results.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    manifest: { type: 'string' },
    models: { type: 'string' },
    modes: { type: 'string', default: 'before,alone,second' },
    repeat: { type: 'string', default: '1' },
    json: { type: 'string' },
  },
});
if (!opt.manifest || !opt.models) throw new Error('--manifest and --models are required');

// A throwaway store before the app's modules resolve theirs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-collapse-'));
process.env.VR_DATA = path.join(tmp, 'data');
process.env.VR_CACHE = path.join(tmp, 'cache');
const { sttConfig } = await import('../../lib/config.ts');
const { decodePcm, stopStt, transcribeTimed } = await import('../../lib/stt/index.ts');
const { LocalEngine } = await import('../../lib/stt/local.ts');
const { MODELS } = await import('../../lib/stt/models.ts');
const { transcribeWithPolicy } = await import('../../lib/stt/policy.ts');
const { hallucinationKind } = await import('../../lib/stt/hallucinations.ts');
const { spreadWords } = await import('../../lib/transcript.ts');

interface Clip {
  id: string;
  lang: string;
  cond: string;
  path: string;
  ref: string;
}
interface Timed {
  text: string;
  t0: number;
  t1: number;
}
const clips: Clip[] = fs
  .readFileSync(opt.manifest, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Whisper alone: a models folder with only its file.
const whisperOnly = path.join(tmp, 'whisper-only');
fs.mkdirSync(whisperOnly);
fs.symlinkSync(path.resolve(opt.models, MODELS['whisper-turbo'].file), path.join(whisperOnly, MODELS['whisper-turbo'].file));

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[hyp.length] / ref.length;
}

const settings = (models: string) => sttConfig({ stt: { model: 'whisper-turbo', models_dir: models, languages: [] } }, {});

// before: the old path, one pass straight from the engine.
const plain = new LocalEngine({ model: 'whisper-turbo', modelsDir: whisperOnly, threads: Math.min(4, os.availableParallelism()), idleMs: 600_000 });
async function before(file: string): Promise<{ words: Timed[]; lines: Timed[] }> {
  const pcm = await decodePcm(file);
  const r = await transcribeWithPolicy((a) => plain.run(pcm, a, 600_000), { languages: [], seconds: pcm.length / 16000, timed: true });
  const lines = r.segments ?? [];
  return { words: r.words?.length ? r.words : lines.flatMap(spreadWords), lines };
}
async function after(file: string, models: string): Promise<{ words: Timed[]; lines: Timed[]; repairs: number }> {
  const t = await transcribeTimed(file, settings(models), () => {}, { repair: true });
  const words = t.words.length ? t.words : t.segments.flatMap(spreadWords);
  return { words, lines: t.segments.length ? t.segments : t.words, repairs: t.repairs?.length ?? 0 };
}

const modes = opt.modes.split(',');
const rounds = Number(opt.repeat);
type Row = { id: string; mode: string; round: number; wer: number; in30: number; invented: number; repairs: number; sec: number };
const rows: Row[] = [];
// One mode at a time over every clip, its engines warmed first: the timings are per clip, not per model load. Whisper's
// output on a hard window changes from run to run (its fallback samples), so --repeat runs the whole set again.
for (let round = 1; round <= rounds; round++)
  for (const mode of modes) {
    const hear = (file: string) =>
      mode === 'before' ? before(file).then((r) => ({ ...r, repairs: 0 })) : after(file, mode === 'alone' ? whisperOnly : opt.models);
    await hear(clips[0].path);
    for (const c of clips) {
      const t0 = performance.now();
      const r = await hear(c.path);
      rows.push({
        id: c.id,
        mode,
        round,
        wer: wer(norm(c.ref), norm(r.words.map((w) => w.text).join(' '))),
        in30: r.words.filter((w) => w.t0 < 30).reduce((n, w) => n + norm(w.text).length, 0),
        invented: r.lines.filter((l) => hallucinationKind(l.text) === 'credit').length,
        repairs: r.repairs,
        sec: (performance.now() - t0) / 1000,
      });
    }
    // One model resident at a time (the second listener only beside the Whisper that asks it).
    plain.stop();
    stopStt();
  }
for (const c of clips) {
  const cells = modes.map((mode) => {
    const r = rows.filter((x) => x.id === c.id && x.mode === mode);
    const pct = r.map((x) => `${(x.wer * 100).toFixed(0)}`).join('/');
    return `${mode} ${pct.padStart(rounds * 3 + rounds - 1)}% ${r.map((x) => x.in30).join('/')} w<30s${r.some((x) => x.invented) ? ' credit' : ''}${r.some((x) => x.repairs) ? ' rep' : ''}`;
  });
  console.log(`${c.id.padEnd(16)} ${cells.join(' | ')}`);
}

console.log(`\nper round (${rounds}): mode · mean WER · clips > 50 % wrong · credits left · words in the first 30 s · time`);
for (const mode of modes) {
  const r = rows.filter((x) => x.mode === mode);
  const per = (f: (x: Row) => number) => (r.reduce((n, x) => n + f(x), 0) / rounds).toFixed(1);
  console.log(
    `${mode.padEnd(8)} ${((r.reduce((n, x) => n + x.wer, 0) / r.length) * 100).toFixed(1).padStart(5)} % · ${per((x) => (x.wer > 0.5 ? 1 : 0))} · ${per((x) => x.invented)} · ${per((x) => x.in30)} · ${per((x) => x.sec)} s`,
  );
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(rows, null, 1));
plain.stop();
stopStt();
fs.rmSync(tmp, { recursive: true, force: true });
setTimeout(() => process.exit(0), 300);
