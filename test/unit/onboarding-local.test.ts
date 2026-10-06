// The first run on a person's own machine: the owner made on the very first start (a store without a video) gets
// it, an owner made for a store that already has videos (from before accounts) doesn't; at the machine there is nobody
// to invite, and every local agent is the owner's — one connecting ticks "Connect an agent".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// A home of its own and a folder "Add video" browses from, with renders in the places the setup looks
const HOME = path.join(dir, 'home');
const PROJECTS = path.join(dir, 'projects');
process.env.HOME = HOME;
fs.writeFileSync(process.env.VR_CONFIG as string, JSON.stringify({ browse_root: PROJECTS }));
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const machine = async () => (await startApp({ loadSessions: async () => [] })).request;

test('the very first start: the owner gets the first run, four steps (nobody to invite at the machine), the setup due', async () => {
  const request = await machine();
  const owner = auth.localOwner();
  assert.ok(owner?.local);
  assert.match(owner.prefs?.onboarding?.since ?? '', /^\d{4}-/);
  assert.equal(owner.prefs?.onboarding?.setup_due, true);
  const r = (await request('GET', '/api/onboarding')).json();
  assert.deepEqual(
    r.steps.map((s: { id: string }) => s.id),
    ['sample', 'video', 'agent', 'share'],
    'renders are linked where they are: the video before the agent',
  );
  assert.equal(r.invited_by, null);
});

test('where renders land: folders with videos in the likely places, newest first, at the machine only', async () => {
  const touch = (file: string, ago: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() - ago * 1000);
    fs.utimesSync(file, t, t);
  };
  touch(path.join(PROJECTS, 'northwind/out/coast-v2.mp4'), 10);
  touch(path.join(PROJECTS, 'northwind/out/coast-v1.mp4'), 60);
  touch(path.join(PROJECTS, 'northwind/out/notes.txt'), 5);
  touch(path.join(HOME, 'Movies/Renders/teaser.mov'), 120);
  touch(path.join(HOME, 'Desktop/screen.mov'), 3600);
  touch(path.join(PROJECTS, '.cache/hidden.mp4'), 1);
  touch(path.join(PROJECTS, 'node_modules/pkg/clip.mp4'), 1);
  touch(path.join(PROJECTS, 'deep/a/b/far.mp4'), 1);
  touch(path.join(dir, 'elsewhere/linked.mp4'), 1);
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(PROJECTS, 'link'));
  const request = await machine();
  const r = await request('GET', '/api/onboarding/folders');
  assert.equal(r.status, 200, r.text);
  const real = (p: string) => fs.realpathSync(p);
  const folders = r.json().folders as { path: string; count: number; files: { name: string; size: number | null; mtime: string | null }[] }[];
  assert.deepEqual(
    folders.map((f) => [f.path, f.count]),
    [
      [path.join(real(PROJECTS), 'northwind/out'), 2],
      [path.join(real(HOME), 'Movies/Renders'), 1],
      [path.join(real(HOME), 'Desktop'), 1],
    ],
    'no dot folders, node_modules, deeper folders or symlinks; newest first',
  );
  assert.deepEqual(
    folders[0]?.files.map((f) => f.name),
    ['coast-v2.mp4', 'coast-v1.mp4'],
    'videos only, newest first',
  );
  assert.equal(folders[0]?.files[0]?.size, 1);
  assert.equal(r.headers['cache-control'], 'no-store');
  // a phone with the LAN link, a proxy in front: never a path on this disk
  const far = await request('GET', '/api/onboarding/folders', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.notEqual(far.status, 200);
});

test('the agents installed here, looked for and never run: the stand-in Claude Code where VR_CLAUDE_BIN says', async () => {
  const stub = path.join(dir, 'stub-bin/claude');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `#!/bin/sh\ntouch ${path.join(dir, 'ran')}\n`, { mode: 0o755 });
  process.env.VR_CLAUDE_BIN = stub;
  try {
    const request = await machine();
    const r = await request('GET', '/api/onboarding/agents');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      r.json().found.find((a: { kind: string }) => a.kind === 'claude-code'),
      { kind: 'claude-code', version: null },
    );
    assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'nothing was run');
    assert.notEqual((await request('GET', '/api/onboarding/agents', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 200);
  } finally {
    delete process.env.VR_CLAUDE_BIN;
  }
});

test('an agent connecting at the machine is the owner’s: “Connect an agent” ticks', async () => {
  const request = await machine();
  const hb = await request('POST', '/api/agents/heartbeat', { body: { session_id: 's-1', name: 'spot-edit', kind: 'claude-code' } });
  assert.equal(hb.status, 200, hb.text);
  const r = (await request('GET', '/api/onboarding')).json();
  assert.deepEqual(
    r.steps.filter((s: { done: boolean }) => s.done).map((s: { id: string }) => s.id),
    ['agent'],
  );
});

test('a store that already has videos when its owner is made (from before accounts) gets no first run', async () => {
  fs.rmSync(path.join(dir, 'data/users.json'));
  const film = makeVideo(path.join(dir, 'work/spot.mp4'), { dur: 1 });
  store.createOrGetReview(film);
  const request = await machine();
  const owner = auth.localOwner();
  assert.ok(owner?.local);
  assert.equal(owner.prefs, undefined, 'someone who already uses Lampo is never greeted like a newcomer');
  assert.deepEqual((await request('GET', '/api/onboarding')).json().steps, []);
});
