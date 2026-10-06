#!/usr/bin/env node
// CPU cost of indexing, per stage: image embeddings per model (each variant in a fresh process: load time, latency at
// batch 1 and 8, CPU ms per frame, peak RSS, files on disk), the text side (one query), OCR per keyframe (tesseract,
// macOS Vision) and decoding (1080p and 4K H.264 at 128 px for cuts + motion, keyframe grabs by seek).
//   node bench/footage/speed.ts [--threads 1,4] [--variants clip-b32:q8,…] [--skip-models] [--skip-decode] [--skip-ocr] [--tag mac]
// "CPU ms per frame" is user + system time of the whole process (ONNX Runtime's threads included): it does not depend
// on how busy the machine is, and divided by the cores you give it, it is the time per frame on an idle box.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIPS_DIR, MODELS_DIR, median, pct, RESULTS_DIR, WORK_DIR, writeJson } from './common.ts';
import { type Dtype, framesAt, loadEmbedder } from './embed.ts';
import { MODELS } from './models.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};

interface ChildResult {
  variant: string;
  threads: number;
  loadMs: number;
  rssLoadedMB: number;
  b1: { medianMs: number; p90Ms: number; minMs: number; cpuMs: number };
  b8: { perFrameMs: number; cpuMsPerFrame: number };
  textMs: number;
  peakRssMB: number;
}

async function child(variant: string, threads: number): Promise<ChildResult> {
  const [key, dtype] = variant.split(':') as [string, Dtype];
  const t0 = performance.now();
  const e = await loadEmbedder(key, dtype, threads, { text: false });
  const loadMs = performance.now() - t0;
  const rssLoadedMB = process.memoryUsage().rss / 1e6;
  const frames = await framesAt(
    path.join(CLIPS_DIR, 'reel_lifestyle.mp4'),
    Array.from({ length: 24 }, (_, i) => 30 + i * 80),
    e.size,
    'squash',
  );
  for (let i = 0; i < 3; i++) await e.images([frames[i] as Uint8Array]);
  const wall: number[] = [];
  const c0 = process.cpuUsage();
  for (const f of frames) {
    const t = performance.now();
    await e.images([f]);
    wall.push(performance.now() - t);
  }
  const c1 = process.cpuUsage(c0);
  const cpuB1 = (c1.user + c1.system) / 1000 / frames.length;
  const c2 = process.cpuUsage();
  const tb = performance.now();
  for (let r = 0; r < 3; r++) await e.images(frames.slice(r * 8, r * 8 + 8));
  const b8wall = (performance.now() - tb) / 24;
  const c3 = process.cpuUsage(c2);
  await e.dispose();
  // the text side: one query, as at search time
  const tq = await loadEmbedder(key, dtype, threads, { vision: false });
  await tq.texts(['warm up']);
  const tt: number[] = [];
  for (const q of [
    'product close-up on white',
    'waves crashing on the shore',
    'someone tying their shoelaces',
    'city skyline at night',
    'latte art next to a laptop',
  ]) {
    const t = performance.now();
    await tq.texts([`a photo of ${q}`]);
    tt.push(performance.now() - t);
  }
  await tq.dispose();
  return {
    variant,
    threads,
    loadMs: Math.round(loadMs),
    rssLoadedMB: Math.round(rssLoadedMB),
    b1: { medianMs: Math.round(median(wall)), p90Ms: Math.round(pct(wall, 90)), minMs: Math.round(Math.min(...wall)), cpuMs: Math.round(cpuB1) },
    b8: { perFrameMs: Math.round(b8wall), cpuMsPerFrame: Math.round((c3.user + c3.system) / 1000 / 24) },
    textMs: Math.round(median(tt)),
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}

const sizeMB = (repo: string, file: string) => {
  const p = path.join(MODELS_DIR, repo, file);
  return fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1e6) : 0;
};

/** user + sys seconds and peak RSS of a child, from /usr/bin/time (BSD -l or GNU -v). */
function timed(cmd: string, args: string[]): { cpuS: number; wallS: number; maxRssMB: number } {
  const mac = process.platform === 'darwin';
  const t0 = performance.now();
  const r = spawnSync('/usr/bin/time', [mac ? '-l' : '-v', cmd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wallS = (performance.now() - t0) / 1000;
  const e = r.stderr;
  if (mac) {
    const m = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(e);
    const rss = /(\d+)\s+maximum resident set size/.exec(e);
    return { cpuS: m ? Number(m[2]) + Number(m[3]) : 0, wallS, maxRssMB: rss ? Number(rss[1]) / 1e6 : 0 };
  }
  const u = /User time \(seconds\): ([\d.]+)/.exec(e);
  const s = /System time \(seconds\): ([\d.]+)/.exec(e);
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(e);
  return { cpuS: Number(u?.[1] ?? 0) + Number(s?.[1] ?? 0), wallS, maxRssMB: rss ? Number(rss[1]) / 1024 : 0 };
}

function ocrCost(): Record<string, unknown> {
  const dir = path.join(WORK_DIR, 'keyframes');
  const imgs = fs
    .readdirSync(dir)
    .filter((d) => d.startsWith('reel_'))
    .flatMap((d) =>
      fs
        .readdirSync(path.join(dir, d))
        .slice(0, 3)
        .map((f) => path.join(dir, d, f)),
    )
    .slice(0, 24);
  const out: Record<string, unknown> = { frames: imgs.length };
  const tes = imgs.map((f) => timed('tesseract', [f, 'stdout', '-l', 'eng+deu', '--psm', '11', 'tsv']));
  out.tesseract = {
    cpuMsPerFrame: Math.round((tes.reduce((s, t) => s + t.cpuS, 0) / imgs.length) * 1000),
    wallMsPerFrame: Math.round((tes.reduce((s, t) => s + t.wallS, 0) / imgs.length) * 1000),
    maxRssMB: Math.round(Math.max(...tes.map((t) => t.maxRssMB))),
  };
  const vbin = path.join(WORK_DIR, 'store', 'cache', 'bin', 'vr-ocr');
  if (fs.existsSync(vbin)) {
    const v = timed(vbin, ['ocr', ...imgs]);
    out.vision = {
      cpuMsPerFrame: Math.round((v.cpuS / imgs.length) * 1000),
      wallMsPerFrame: Math.round((v.wallS / imgs.length) * 1000),
      maxRssMB: Math.round(v.maxRssMB),
    };
  }
  return out;
}

function decodeCost(): Record<string, unknown> {
  // 20 s of busy synthetic footage (moving test pattern + grain), H.264 at camera-like bitrates
  const dir = path.join(WORK_DIR, 'decode');
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [name, size, rate] of [
    ['1080p25', '1920x1080', '16M'],
    ['2160p25', '3840x2160', '50M'],
  ] as const) {
    const f = path.join(dir, `${name}.mp4`);
    if (!fs.existsSync(f))
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=s=${size}:r=25:d=20`,
        '-vf',
        'noise=alls=12:allf=t',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        rate,
        '-g',
        '25',
        f,
      ]);
    const row: Record<string, unknown> = {};
    for (const threads of [1, 4]) {
      const r = spawnSync(
        'ffmpeg',
        [
          '-benchmark',
          '-hide_banner',
          '-nostats',
          '-threads',
          String(threads),
          '-i',
          f,
          '-vf',
          'scale=128:72:flags=area',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-y',
          '/dev/null',
        ],
        { encoding: 'utf8' },
      );
      const m = /utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(r.stderr);
      if (m)
        row[`analysis pass, ${threads} thread(s)`] = {
          cpuSPerFootageS: +((Number(m[1]) + Number(m[2])) / 20).toFixed(3),
          wallSPerFootageS: +(Number(m[3]) / 20).toFixed(3),
        };
    }
    // keyframe grabs by accurate seek (lib/shots.ts style), 0.4 a second of footage → 8 grabs in 20 s
    let cpu = 0;
    for (let i = 0; i < 8; i++) {
      const t = (i * 2.5 + 1.1).toFixed(3);
      const r = spawnSync(
        'ffmpeg',
        ['-benchmark', '-hide_banner', '-nostats', '-ss', t, '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', '/dev/null'],
        { encoding: 'utf8' },
      );
      const m = /utime=([\d.]+)s stime=([\d.]+)s/.exec(r.stderr);
      if (m) cpu += Number(m[1]) + Number(m[2]);
    }
    row['keyframe grabs by seek (0.4/s)'] = { cpuSPerFootageS: +(cpu / 20).toFixed(3), cpuMsPerGrab: Math.round((cpu / 8) * 1000) };
    out[name] = row;
  }
  return out;
}

async function main() {
  const threadsList = arg('threads', '1,4').split(',').map(Number);
  const variants = arg('variants', 'clip-b32:fp32,clip-b32:q8,siglip-b16:q8,siglip2-b16:q8,mobileclip-s2:fp32,mobileclip-s2:q8').split(',');
  const rows: (ChildResult & { visionMB: number; textMB: number })[] = [];
  for (const v of process.argv.includes('--skip-models') ? [] : variants) {
    for (const th of threadsList) {
      const r = spawnSync(process.execPath, [process.argv[1] as string, '--child', v, String(th)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const line = r.stdout.trim().split('\n').pop() || '';
      if (!line.startsWith('{')) {
        console.error(`${v} ×${th}: ${r.stderr.slice(-500)}`);
        continue;
      }
      const res = JSON.parse(line) as ChildResult;
      const [key, dtype] = v.split(':') as [string, Dtype];
      const spec = MODELS.find((m) => m.key === key);
      const visionMB = spec ? sizeMB(spec.repo, spec.vision[dtype] as string) : 0;
      const textMB = spec ? sizeMB(spec.repo, spec.text) + sizeMB(spec.repo, 'tokenizer.json') : 0;
      rows.push({ ...res, visionMB, textMB });
      console.log(
        `${v.padEnd(20)} ×${th}: load ${res.loadMs} ms, b1 ${res.b1.medianMs} ms (min ${res.b1.minMs}, p90 ${res.b1.p90Ms}, CPU ${res.b1.cpuMs} ms), b8 ${res.b8.perFrameMs} ms/frame (CPU ${res.b8.cpuMsPerFrame}), query ${res.textMs} ms, peak RSS ${res.peakRssMB} MB, files ${visionMB} + ${textMB} MB`,
      );
    }
  }
  const out: Record<string, unknown> = {
    machine: `${os.cpus()[0]?.model} · ${os.cpus().length} cores · ${Math.round(os.totalmem() / 1e9)} GB · load ${os
      .loadavg()
      .map((x) => x.toFixed(1))
      .join(' ')}`,
    rows,
  };
  if (!process.argv.includes('--skip-ocr')) {
    out.ocr = ocrCost();
    console.log('ocr', JSON.stringify(out.ocr));
  }
  if (!process.argv.includes('--skip-decode')) {
    out.decode = decodeCost();
    console.log('decode', JSON.stringify(out.decode, null, 1));
  }
  writeJson(path.join(RESULTS_DIR, `speed-${arg('tag', 'mac')}.json`), out);
}

if (process.argv[2] === '--child') {
  const r = await child(process.argv[3] as string, Number(process.argv[4]));
  console.log(JSON.stringify(r));
} else await main();
