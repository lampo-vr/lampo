// covers: server/routes/recordings.ts lib/recordings.ts server/index.ts server/shutdown.ts
// A deploy stops the server (SIGTERM) while it hears recordings: the one being heard ends with the process, one queued
// behind it never runs, and one whose audio was on its way lost it. The next start takes them up: what was queued is
// heard by itself (no "Hear it again", no request), and the one without audio says so, its drawing a draft — none
// "hearing" or "uploading" for good. The real server process, twice, on one throwaway store, with a stand-in speech
// engine.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort, isolatedEnv, makeVideo, ROOT, until } from '../lib/helpers.ts';
import { client, cookieFrom, tusUpload } from '../lib/http.ts';

// The engine: before the stop it holds what it is asked (the hearing in flight when the deploy comes) until `release`,
// then fails it; after the restart it answers.
let phase: 1 | 2 = 1;
const asked: Record<1 | 2, number> = { 1: 0, 2: 0 };
const held: http.ServerResponse[] = [];
let failing = false;
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    asked[phase]++;
    if (phase === 1 && failing) return void res.writeHead(500).end('{"error":"stopped"}');
    if (phase === 1) return void held.push(res);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'Make the title bigger.',
        language: 'english',
        words: [
          { word: 'Make', start: 0.2, end: 0.4 },
          { word: 'bigger.', start: 0.5, end: 0.9 },
        ],
        segments: [],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));
const release = () => {
  failing = true;
  for (const res of held.splice(0)) res.writeHead(500).end('{"error":"stopped"}');
};

const port = await freePort();
const PUBLIC = `http://127.0.0.1:${port}`;
const { dir, env } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_HOST: '127.0.0.1',
    VR_PORT: String(port),
    VR_STT: 'http',
    VR_STT_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`,
    VR_OCR: 'off',
  },
});
const auth = await import('../../lib/auth.ts');
const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const bearer = { Authorization: `Bearer ${auth.createToken(olivia.id, 'test').token}` };

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 2 });
const mic = fs.readFileSync(makeVideo(path.join(dir, 'mic/take.mp4'), { w: 32, h: 32, fps: 5, dur: 3, freq: 330 }));

let proc: ChildProcess | null = null;
let log = '';
async function start(): Promise<ChildProcess> {
  log = '';
  const p = spawn(process.execPath, [path.join(ROOT, 'server/index.ts')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', (d) => (log += d));
  p.stderr?.on('data', (d) => (log += d));
  proc = p;
  await until(async () => {
    if (p.exitCode !== null) throw new Error(`the server exited before it answered:\n${log}`);
    return fetch(`${PUBLIC}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
  }, 'the server answers');
  return p;
}
after(() => {
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
  stt.close();
});

const request = client(port, { Connection: 'close' });
const signIn = async () => {
  const r = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' }, headers: { Origin: PUBLIC } });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), Origin: PUBLIC };
};

test('recordings a deploy cut off are taken up at the next start: heard by themselves, or told their audio never came', { timeout: 180_000 }, async () => {
  const first = await start();
  const up = await tusUpload(request, video, { filename: 'spot.mp4', folder: 'Acme' }, bearer);
  assert.equal(up.status, 200, up.text);
  const slug = up.json().slug as string;
  const base = `/api/review/${encodeURIComponent(slug)}/recordings`;
  let me = await signIn();
  const make = async (events: unknown[]) => {
    const r = await request('POST', base, { body: { v: 1, duration: 3, events }, headers: me });
    assert.equal(r.status, 200, r.text);
    return r.json().id as string;
  };
  const withAudio = async (id: string) => {
    const r = await request('PUT', `${base}/${id}/audio`, { body: mic, headers: { ...me, 'content-type': 'audio/mp4' } });
    assert.equal(r.status, 200, r.text);
  };
  // A is heard (the engine holds it), B waits in the queue behind it, C's audio never arrives
  const a = await make([{ t: 0, k: 'frame', f: 5 }]);
  await withAudio(a);
  await until(() => asked[1] === 1, 'the engine hears A');
  const b = await make([{ t: 0, k: 'frame', f: 30 }]);
  await withAudio(b);
  const c = await make([
    { t: 0, k: 'frame', f: 12 },
    { t: 0.4, k: 'stroke', f: 12, shape: { type: 'box', x: 10, y: 10, w: 40, h: 20 } },
  ]);
  // the deploy: SIGTERM; the hearing in flight ends with an error, the one queued never starts
  const exited = new Promise((r) => first.once('exit', r));
  first.kill('SIGTERM');
  await until(() => log.includes('stopping'), 'the server stops');
  release();
  await exited;
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(env.VR_DATA as string, slug, 'recordings', `${id}.json`), 'utf8')).state;
  assert.deepEqual([onDisk(a), onDisk(b), onDisk(c)], ['failed', 'hearing', 'uploading'], 'what the stop left');
  assert.ok(!asked[1] || onDisk(b) === 'hearing', 'B was never heard');

  phase = 2;
  await start();
  me = await signIn();
  // a later job through the same queue: anything taken up at the start was queued before it, and more urgent
  const transcript = `/api/review/${encodeURIComponent(slug)}/transcript?v=1`;
  await request('GET', transcript, { headers: me });
  await until(async () => (await request('GET', transcript, { headers: me })).json().state === 'ready', 'the render heard', 60_000);
  const list = (await request('GET', base, { headers: me })).json().recordings as {
    id: string;
    state: string;
    audio?: false;
    error?: string;
    drafts: { frame: number; text: string }[];
  }[];
  const got = (id: string) => list.find((x) => x.id === id);
  assert.equal(got(b)?.state, 'ready', `B heard by itself after the start: ${JSON.stringify(got(b))}\n${log}`);
  assert.equal(got(b)?.drafts[0]?.text, 'Make bigger.');
  assert.equal(got(b)?.drafts[0]?.frame, 30);
  assert.equal(got(c)?.state, 'failed', JSON.stringify(got(c)));
  assert.equal(got(c)?.audio, false, 'C: nothing to hear again');
  assert.equal(got(c)?.drafts.length, 1, 'C: its drawing is a draft');
  assert.equal(got(a)?.state, 'failed', 'A: its hearing failed, Hear it again stays');
  const again = await request('POST', `${base}/${a}/hear`, { headers: me });
  assert.equal(again.status, 200, again.text);
  await until(
    async () => (await request('GET', base, { headers: me })).json().recordings.find((x: { id: string }) => x.id === a)?.state === 'ready',
    'A heard again',
  );
});
