// `vr render` against a hosted server (a throwaway app in server mode): a real ffmpeg render on the agent's machine goes
// up as the next version with the upload's progress, Lampo hears the render's progress through the activity batches
// (under the agent's name and its account), and a failure reaches it as an error with its words redacted. The server
// never runs anything: the command runs where `vr` runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type http from 'node:http';
import path from 'node:path';
import { before, test } from 'node:test';
import type { ActivityRecord } from '../../lib/activity.ts';
import type { AgentActivityResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo, tmpdir, until, VR } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server' } });
const auth = await import('../../lib/auth.ts');

const { base, server } = await startApp();
/** What vr posted as activity, batch by batch: a listener before the app's own. */
const posted: ActivityRecord[][] = [];
server.prependListener('request', (req: http.IncomingMessage) => {
  if (req.method !== 'POST' || req.url !== '/api/agents/activity') return;
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    try {
      posted.push((JSON.parse(body) as { entries: ActivityRecord[] }).entries);
    } catch {}
  });
});

// The agent's machine: its own config, cache and work folder; nothing of the server's store, never a saved login.
const home = tmpdir('vr-render-agent-');
const work = path.join(home, 'work');
const agentEnv: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  VR_DATA: path.join(home, 'no-local-store'),
  VR_CACHE: path.join(home, 'no-local-cache'),
  VR_BY: 'agent:reel-cut',
};
for (const k of ['VR_MODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'LAMPO_RUN', 'VR_REMOTE']) delete agentEnv[k];
const src = makeVideo(path.join(work, 'src.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
let token = '';

// Async: the server runs in this process.
function vr(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [VR, ...args], { cwd: work, env: { ...agentEnv, VR_SERVER: base, VR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}
const get = async <T>(url: string): Promise<T> => (await fetch(base + url, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<T>;

before(async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  token = auth.createToken(owner.id, 'agent').token;
  const first = await vr(['push', src, '--name', 'spot.mp4', '--folder', 'Acme']);
  assert.equal(first.code, 0, first.err);
});

test('a render on the agent’s machine goes up as the next version; Lampo hears its progress and the upload’s', async () => {
  const from = posted.length;
  const r = await vr([
    'render',
    '--to',
    'spot.mp4',
    '--out',
    'v2.mp4',
    '--',
    FFMPEG,
    '-y',
    '-i',
    'src.mp4',
    '-vf',
    'negate',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    'v2.mp4',
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^V2 rendered in \d+s and put up for review \(50 frames\)\.$/);
  assert.match(lines[1], /^Now listen with lampo watch/);
  // what was posted: batches (≤ 20 lines, one at most every 2 s), the render's progress, then the upload's
  const sent = posted.slice(from).flat();
  assert.ok(sent.length >= 2, JSON.stringify(sent));
  assert.ok(
    sent.some((l) => l.kind === 'render' && l.progress?.tool === 'ffmpeg' && l.progress.v === 2),
    JSON.stringify(sent),
  );
  assert.ok(sent.some((l) => l.kind === 'upload' && (l.progress?.stage === 'uploading' || l.progress?.stage === 'checking')));
  assert.equal(sent.at(-1)?.text, 'Put a new version up for review');
  assert.ok(sent.every((l) => l.agent === 'reel-cut'));
  // the server shows it under the agent's name and its account, on the video
  const live = await until(async () => {
    const a = await get<AgentActivityResponse>('/api/agent-activity');
    return a.agents.find((x) => x.agent === 'reel-cut · Olivia');
  }, 'the agent’s activity');
  assert.equal(live.current?.text, 'Put a new version up for review');
  const slug = live.slug as string;
  const story = await get<AgentActivityResponse>(`/api/agent-activity?slug=${encodeURIComponent(slug)}`);
  const recent = story.agents.find((x) => x.agent === 'reel-cut · Olivia')?.recent ?? [];
  assert.ok(
    recent.some((a) => a.kind === 'render' && a.progress?.tool === 'ffmpeg'),
    JSON.stringify(recent),
  );
  // the version is there (asked last: the agent's own `vr ls` is activity too)
  const ls = JSON.parse((await vr(['ls', '--json'])).out) as { video: string; v: number }[];
  assert.equal(ls.find((x) => x.video.endsWith('/spot.mp4'))?.v, 2, JSON.stringify(ls));
});

test('a failed render reaches Lampo as an error, its words redacted; nothing goes up', async () => {
  const from = posted.length;
  const r = await vr([
    'render',
    '--to',
    'spot.mp4',
    '--out',
    'v3.mp4',
    '--',
    process.execPath,
    '-e',
    "console.error('Error: upload to https://render:hunter2@cdn.example.com refused'); process.exit(4)",
  ]);
  assert.equal(r.code, 4);
  assert.equal(r.out, 'Render failed (exit 4): Error: upload to https://[redacted]@cdn.example.com refused. The person sees it in Lampo.\n');
  const sent = posted.slice(from).flat();
  const err = sent.find((l) => l.kind === 'error');
  assert.ok(err, JSON.stringify(sent));
  assert.deepEqual(err.vars, { code: 4 });
  assert.ok(!JSON.stringify(sent).includes('hunter2'));
  assert.equal(err.progress?.v, 3);
  const live = await until(async () => {
    const a = await get<AgentActivityResponse>('/api/agent-activity');
    const mine = a.agents.find((x) => x.agent === 'reel-cut · Olivia');
    return mine?.current?.kind === 'error' ? mine : null;
  }, 'the error in Lampo');
  assert.match(live.current?.quote ?? '', /\[redacted\]@cdn\.example\.com refused/);
});

test('--folder: a new video’s V1 goes up into the project on the server (made with it), with the upload’s progress', async () => {
  const from = posted.length;
  const r = await vr([
    'render',
    '--folder',
    'Acme/Launch',
    '--out',
    'launch.mp4',
    '--',
    FFMPEG,
    '-y',
    '-i',
    'src.mp4',
    '-vf',
    'hflip',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    'launch.mp4',
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^V1 rendered in \d+s and put up for review in Acme\/Launch \(50 frames\)\.$/);
  assert.match(lines[1], /^Now listen with lampo watch/);
  const sent = posted.slice(from).flat();
  assert.ok(
    sent.some((l) => l.kind === 'render' && l.progress?.v === 1),
    JSON.stringify(sent),
  );
  assert.equal(sent.at(-1)?.text, 'Put a new version up for review');
  const ls = JSON.parse((await vr(['ls', '--json'])).out) as { video: string; v: number; folder: string | null }[];
  const v1 = ls.find((x) => x.video.endsWith('/launch.mp4'));
  assert.deepEqual([v1?.v, v1?.folder], [1, 'Acme/Launch'], JSON.stringify(ls));
});
