// transcribe.cpp through its Node binding (npm `transcribe-cpp`, prebuilt natives via koffi) — the exact path the
// server would use in-process: load the GGUF once, keep one session, transcribe 16 kHz mono float32 PCM.
//
// Usage: node run_node.mjs --model file.gguf --manifest manifest.jsonl --out results/x.jsonl
//                          [--name label] [--cpu] [--threads 4] [--language de] [--vocab vocab.txt] [--module path]
// --module points at an installed transcribe-cpp when it is not resolvable from here (bench installs live outside
// the repo).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const T_START = performance.now();
const { values: opt } = parseArgs({
  options: {
    model: { type: 'string' },
    manifest: { type: 'string' },
    out: { type: 'string' },
    name: { type: 'string' },
    cpu: { type: 'boolean', default: false },
    threads: { type: 'string', default: '4' },
    language: { type: 'string' },
    vocab: { type: 'string' },
    module: { type: 'string', default: 'transcribe-cpp' },
    only: { type: 'string' },
  },
});
const tc = await import(opt.module.startsWith('/') ? path.join(opt.module, 'dist/index.js') : opt.module);

// 16-bit PCM WAV → Float32Array (the bench writes exactly that format).
function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = size / 2;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return pcm;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

let clips = fs
  .readFileSync(opt.manifest, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
if (opt.only) clips = clips.filter((c) => opt.only.split(',').some((p) => c.subset.startsWith(p)));
const vocab = opt.vocab
  ? fs
      .readFileSync(opt.vocab, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

const tLoad = performance.now();
const device = opt.cpu ? tc.getAvailableBackends().find((d) => d.deviceType === 'cpu') : undefined;
const model = await tc.TranscribeModel.load(opt.model, device ? { device } : {});
const session = model.createSession({ nThreads: Number(opt.threads) });
const isWhisper = model.accepts?.({ kind: 'whisper' });
const runOpts = {
  ...(opt.language ? { language: opt.language } : {}),
  ...(isWhisper && vocab.length ? { family: { kind: 'whisper', initialPrompt: vocab.join(', ') } } : {}),
};
const loadS = (performance.now() - tLoad) / 1000;

let lastLanguage = '';
const run = async (file) => {
  const r = await session.run(readWav(file), runOpts);
  lastLanguage = r.language;
  return r.text;
};
const tw = performance.now();
await run(clips[0].path); // warm-up, not scored
const firstS = (performance.now() - tw) / 1000;

fs.mkdirSync(path.dirname(opt.out), { recursive: true });
const out = fs.createWriteStream(opt.out);
for (const c of clips) {
  const t = performance.now();
  const cpu0 = process.cpuUsage();
  let hyp;
  try {
    hyp = await run(c.path);
  } catch (e) {
    hyp = `<error ${e.name}: ${e.message}>`;
  }
  const sec = Number(((performance.now() - t) / 1000).toFixed(4));
  const used = process.cpuUsage(cpu0);
  const cpu = Number(((used.user + used.system) / 1e6).toFixed(4)); // all threads: contention-proof cost
  out.write(`${JSON.stringify({ id: c.id, hyp: (hyp || '').trim(), sec, cpu, lang: lastLanguage })}\n`);
}
const meta = {
  engine: opt.name || path.basename(opt.model),
  model: opt.model,
  language: opt.language || null,
  vocab: isWhisper && vocab.length > 0,
  threads: Number(opt.threads),
  device: model.device?.name,
  startup_s: Number(((tLoad - T_START) / 1000).toFixed(2)),
  load_s: Number(loadS.toFixed(2)),
  first_call_s: Number(firstS.toFixed(2)),
  peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  mlx_peak_mb: null,
};
out.end(`${JSON.stringify({ meta })}\n`);
console.log(JSON.stringify(meta));
session.dispose?.();
model.dispose();
