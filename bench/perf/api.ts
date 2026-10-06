// API timings on a store made by synth.ts: starts the server on a free port (never the app's own), times each read
// endpoint (the first call, then the median and p95 of the next ones), its size (the JSON, and what travels to a client
// that accepts brotli), and what the event stream sends when one note is added and resolved.
//
//   node bench/perf/api.ts <synth dir> [runs=15]
//
// Load on the machine skews every number: run it when `sysctl -n vm.loadavg` is low, and compare runs of one sitting.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { freePort, ROOT, sleep } from '../../test/lib/helpers.ts';

const [dirArg, runsArg = '15'] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node bench/perf/api.ts <synth dir> [runs]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const RUNS = Number(runsArg);
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VR_|^CLAUDE/.test(k)));
Object.assign(env, {
  VR_DATA: path.join(dir, 'data'),
  VR_CACHE: path.join(dir, 'cache'),
  VR_CONFIG: path.join(dir, 'config.json'),
  VR_HOST: '127.0.0.1',
  VR_PORT: String(port),
  VR_STT: 'off',
  VR_USER: 'Sam',
  VR_CLAUDE_BIN: '/usr/bin/false',
});
const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.ts')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => proc.kill('SIGKILL'));
for (let t = Date.now(); ; await sleep(100)) {
  if (Date.now() - t > 30000) throw new Error('server did not start');
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
}

const library = (await (await fetch(`${BASE}/api/library`)).json()) as { videos: { slug: string }[] };
const slug = library.videos[Math.floor(library.videos.length / 2)]?.slug as string;
const enc = encodeURIComponent;
const ENDPOINTS: Record<string, string> = {
  library: '/api/library',
  status: '/api/status',
  insights: '/api/insights?period=30d',
  review: `/api/review/${enc(slug)}`,
  search: '/api/search?q=logo%20grade',
  'for-you': '/api/for-you',
  info: '/api/info',
  'auth/status': '/api/auth/status',
};

const pct = (list: number[], p: number) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((p / 100) * list.length))] as number;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const rows: string[] = [];
for (const [name, url] of Object.entries(ENDPOINTS)) {
  const times: number[] = [];
  let bytes = 0;
  let serverTiming = '';
  let wire = 0;
  let first = 0;
  for (let i = 0; i <= RUNS; i++) {
    const t = performance.now();
    const res = await fetch(BASE + url, { headers: { 'Accept-Encoding': 'identity' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = performance.now() - t;
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    if (i === 0) {
      first = ms;
      bytes = buf.length;
    } else times.push(ms);
  }
  // As a browser gets it: brotli if the server offers it (node:http, so nothing decodes it on the way).
  const raw = await new Promise<{ size: number; timing: string }>((resolve, reject) => {
    const req = http.get(`${BASE}${url}`, { headers: { 'Accept-Encoding': 'br, gzip' } }, (res) => {
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
      });
      res.on('end', () => resolve({ size, timing: String(res.headers['server-timing'] || '') }));
    });
    req.on('error', reject);
  });
  wire = raw.size;
  serverTiming = raw.timing;
  rows.push(
    `| ${name} | ${first.toFixed(1)} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} | ${kb(bytes)} | ${kb(wire)} |${serverTiming ? ` ${serverTiming} |` : ''}`,
  );
}

// The event stream: what one browser tab receives while a note is added, then resolved (a second client here stands in
// for every other open tab/device — each receives the same bytes).
const received: { type: string; bytes: number }[] = [];
const ac = new AbortController();
const stream = await fetch(`${BASE}/api/events`, { signal: ac.signal });
const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
void (async () => {
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done) return;
    buf += Buffer.from(value as Uint8Array).toString('utf8');
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const msg = buf.slice(0, i + 2);
      buf = buf.slice(i + 2);
      const type = /^event: (.+)$/m.exec(msg)?.[1];
      if (type) received.push({ type, bytes: Buffer.byteLength(msg) });
    }
  }
})();
await sleep(500);
const post = async (url: string, method: string, body: object) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ id?: string; comment?: { id: string } }>;
};
const t0 = performance.now();
const note = await post(`/api/review/${enc(slug)}/comments`, 'POST', { frame: 10, text: 'Perf probe note', severity: 'should' });
const addMs = performance.now() - t0;
await sleep(1500);
const afterAdd = received.splice(0);
const t1 = performance.now();
await post(`/api/comments/${note.comment?.id ?? note.id}`, 'PATCH', { status: 'fixed' });
const patchMs = performance.now() - t1;
await sleep(1500);
const afterPatch = received.splice(0);
ac.abort();
const describe = (list: typeof received) => {
  const types = new Map<string, number>();
  for (const m of list) types.set(m.type, (types.get(m.type) || 0) + 1);
  return `${list.length} messages, ${kb(list.reduce((s, m) => s + m.bytes, 0))}: ${[...types].map(([t, n]) => `${t}×${n}`).join(', ')}`;
};

console.log(
  `\n${library.videos.length} videos · ${os.cpus().length} cores · load ${os
    .loadavg()
    .map((l) => l.toFixed(1))
    .join(' ')} · ${RUNS} runs\n`,
);
console.log('| endpoint | first ms | median ms | p95 ms | JSON | over the wire (br, gzip accepted) |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const r of rows) console.log(r);
console.log(`\nadd a note: ${addMs.toFixed(1)} ms; SSE per client: ${describe(afterAdd)}`);
console.log(`resolve it: ${patchMs.toFixed(1)} ms; SSE per client: ${describe(afterPatch)}`);
proc.kill();
process.exit(0);
