// An agent on another machine: `vr` and the MCP server against a hosted server over HTTP. Login with a token or a
// password, push renders, pin notes, read them with screenshots that land on this machine, follow the live feed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type CallToolResult, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AskView } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo, must, ROOT, sleep, tmpdir, until, VR } from '../lib/helpers.ts';
import { client } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server' } });
const { startFeed } = await import('../../server/feed.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const { ctx, base: url, server } = await startApp();
const feed = startFeed(ctx.broadcast, { interval: 100 });
after(() => feed.stop());
/** What the server was asked, in order (path and query): a listener before the app's own. */
const asked: string[] = [];
server.prependListener('request', (req: http.IncomingMessage) => asked.push(req.url || ''));
let ownerToken = '';

// The agent's machine: its own config and cache dirs, nothing of the server's store.
const agentHome = tmpdir('vr-agent-');
const agentEnv: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(agentHome, 'config'),
  XDG_CACHE_HOME: path.join(agentHome, 'cache'),
  VR_DATA: path.join(agentHome, 'no-local-store'),
  VR_CACHE: path.join(agentHome, 'no-local-cache'),
};
for (const k of ['VR_MODE', 'VR_TOKEN', 'VR_SERVER', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID']) delete agentEnv[k];

interface Run {
  code: number;
  out: string;
  err: string;
}
// Async on purpose: the server runs in this process, a synchronous exec would block it.
function vr(args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [VR, ...args], { env: { ...agentEnv, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(input ?? '');
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

before(async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  ownerToken = auth.createToken(owner.id, 'test').token;
});

const clip = makeVideo(path.join(dir, 'renders/clip.mp4'), { w: 320, h: 180, dur: 1 });
let noteId = '';

test('vr login with a token, whoami, and the server is where everything goes', async () => {
  const r = await vr(['login', url, '--token', ownerToken]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /signed in to http:\/\/127\.0\.0\.1:\d+ as Olivia <olivia@example\.com> \(owner\)/);
  const file = path.join(agentHome, 'config/video-review/credentials.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const who = await vr(['whoami']);
  assert.match(who.out, /server: http:\/\/127\.0\.0\.1:\d+\nsigned in as: Olivia/);
  assert.match((await vr(['help'])).out, /server: http:\/\/127\.0\.0\.1:\d+ \(as Olivia\)/);
});

test('vr push uploads a render; the same bytes again change nothing', async () => {
  const r = await vr(['push', clip, '--folder', 'Acme/Reels']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /added: \/@uploads\/Acme\/Reels\/clip\.mp4 \(v1\)\s+\[Acme\/Reels\]/);
  assert.match((await vr(['push', clip, '--folder', 'Acme/Reels'])).out, /unchanged: .* already v1/);
  const ls = await vr(['ls']);
  assert.match(ls.out, /0 open .* v1 .*\/@uploads\/Acme\/Reels\/clip\.mp4\s+\[Acme\/Reels\]/);
});

test('vr add pins a note; screenshots land on this machine; open, show, prompt use local paths', async () => {
  // An agent reviewing footage itself files feedback explicitly; without --kind its note would be a question.
  const r = await vr([
    'add',
    'clip.mp4',
    '--frame',
    '12',
    '--text',
    'Logo zu früh',
    '--kind',
    'feedback',
    '--severity',
    'must',
    '--box',
    '10,10,40,20',
    '--by',
    'agent:remote',
  ]);
  assert.equal(r.code, 0, r.err);
  noteId = must(/(c_[0-9a-f]{6}) pinned at \S+ \(f12, v1\) by agent:remote/.exec(r.out)?.[1], r.out);
  const marked = must(/marked: (.+\.png)/.exec(r.out)?.[1], 'marked path');
  assert.ok(marked.startsWith(path.join(agentHome, 'cache/video-review/')), marked);
  assert.ok(fs.existsSync(marked));
  const open = await vr(['open', 'clip.mp4', '--json']);
  const c = JSON.parse(open.out).comments[0];
  assert.ok(fs.existsSync(c.shots.clean) && c.shots.clean.startsWith(agentHome), 'clean frame downloaded');
  assert.match((await vr(['show', noteId])).out, /Logo zu früh/);
  const prompt = (await vr(['prompt', 'clip.mp4'])).out;
  assert.match(prompt, /Open \(1, 1 must\)/);
  assert.match(prompt, new RegExp(`marked: ${agentHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(prompt, /Review data: http:\/\/127\.0\.0\.1:\d+\/api\/review\//);
  assert.match(prompt, /vr push <file> --to "\/@uploads\/Acme\/Reels\/clip\.mp4"/);

  // Outside a named session vr still writes as an agent (agent:vr): a question, not feedback from the token's person.
  const q = await vr(['add', 'clip.mp4', '--frame', '5', '--text', 'Absicht?']);
  assert.equal(q.code, 0, q.err);
  const asked = JSON.parse((await vr(['open', 'clip.mp4', '--json', '--all'])).out).comments.find((x: { text: string }) => x.text === 'Absicht?');
  assert.deepEqual([asked?.author, asked?.kind], ['agent:vr', 'question']);
  assert.equal((await vr(['wontfix', asked.id, '--note', 'asked elsewhere'])).code, 0, 'closed again: the next test counts open notes');
});

test('an elements map goes to the server (vr elements, vr push --elements); vr open there says what the note points at', async () => {
  const map = (fps: number) => {
    const file = path.join(dir, `renders/clip.elements.${fps}.json`);
    const logo = { id: 'logo', name: 'Logo', kind: 'image', keys: [[0, 20, 20, 80, 40]], runs: [[0, 29]] };
    fs.writeFileSync(file, JSON.stringify({ v: 1, fps, size: [640, 360], elements: [logo] }));
    return file;
  };
  const r = await vr(['elements', 'clip.mp4', map(30)]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'v1: elements: 1 named, 1 keys (scaled from 640×360): notes say what they point at\n');
  const open = await vr(['open', 'clip.mp4']);
  assert.match(open.out, new RegExp(`${noteId} .* · on #logo\\n`));
  assert.match(open.out, /\n {2}elements: #logo "Logo"\n/);
  assert.deepEqual(JSON.parse((await vr(['open', 'clip.mp4', '--json'])).out).comments[0].elements, ['logo']);
  // what only the version can tell is the server's to refuse
  const at25 = await vr(['elements', 'clip.mp4', map(25)]);
  assert.equal(at25.code, 1);
  assert.match(at25.err, /the elements map is refused: it is at 25 fps, v1 at 30/);
  const push = await vr(['push', clip, '--folder', 'Acme/Reels', '--elements', map(30)]);
  assert.equal(push.code, 0, push.err);
  assert.match(push.out, /unchanged: .* already v1 .*\n {4}elements: 1 named, 1 keys \(scaled from 640×360\)/);
});

test('vr watch follows the server live and heartbeats its session', async () => {
  // A Claude Code session on the agent's machine, as ~/.claude/sessions/<pid>.json describes it.
  fs.mkdirSync(path.join(agentHome, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(agentHome, '.claude/sessions/4242.json'),
    JSON.stringify({ name: 'remote-agent', sessionId: 'sess-remote-1', pid: 4242, cwd: '/work/acme' }),
  );
  const streams = ctx.hub.clients();
  const w = spawn(process.execPath, [VR, 'watch', '--everyone'], {
    env: { ...agentEnv, HOME: agentHome, CLAUDE_PID: '4242', CLAUDE_CODE_SESSION_ID: 'sess-remote-1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  w.stdout.on('data', (d) => {
    out += d;
  });
  try {
    // Ready when its live stream is open on the server (a note sent before that is one it never hears of).
    await until(() => ctx.hub.clients() > streams, 'vr watch connected to the live events');
    const request = client(Number(new URL(url).port));
    const slug = '__@uploads__Acme__Reels__clip.mp4';
    const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, {
      body: { frame: 20, text: 'Farbe kälter' },
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(note.status, 200, note.text);
    await until(() => out.includes('Farbe kälter'), "the note's line").catch(() => {});
    const line = must(
      out.split('\n').find((l) => l.includes('Farbe kälter')),
      out,
    );
    assert.match(line, /NEW SHOULD \[-\] c_[0-9a-f]{6} 00:00:20 f20 v1 clip\.mp4 — "Farbe kälter" · marked: (\S+_marked\.png) · video: \/@uploads\//);
    const marked = must(/marked: (\S+)/.exec(line)?.[1], line);
    assert.ok(fs.existsSync(marked), 'the marked frame was downloaded before the line was printed');
    // The heartbeat is its own request, sent alongside the stream: wait for it to land, then check what it says.
    const listed = async () => (await request('GET', '/api/sessions', { headers: { Authorization: `Bearer ${ownerToken}` } })).json().sessions;
    await until(async () => (await listed()).length > 0, 'the heartbeat of vr watch').catch(() => {});
    const sessions = await listed();
    assert.deepEqual(
      sessions.map((s: { name: string; sessionId: string; cwd: string }) => [s.name, s.sessionId, s.cwd]),
      [['remote-agent', 'sess-remote-1', '/work/acme']],
      'the watching agent can be assigned videos',
    );
  } finally {
    w.kill();
  }
});

test('vr fix, then a new render goes up as v2 and carries the open note', async () => {
  assert.match((await vr(['fix', noteId, '--note', 'Logo 4 Frames später', '--by', 'agent:remote'])).out, new RegExp(`${noteId}: fixed in v1`));
  const v2 = makeVideo(path.join(dir, 'renders/clip-v2.mp4'), { w: 320, h: 180, dur: 1, freq: 700 });
  const r = await vr(['push', v2, '--to', 'clip.mp4']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new version: \/@uploads\/Acme\/Reels\/clip\.mp4 \(v2\)/);
  assert.match(r.out, /1 open comment\(s\) carried forward/);
  assert.match((await vr(['inbox'])).out, /NEW SHOULD .*Farbe kälter/);
  assert.match((await vr(['status', 'clip.mp4', 'rendering v3', '--by', 'agent:remote'])).out, /status: "rendering v3"/);
});

test('vr source and vr preview go to the server (the preview through a one-time upload URL)', async () => {
  const src = await vr(['source', 'clip.mp4', '--app', 'After Effects', '--project', '/Volumes/Jobs/clip.aep', '--comp', 'Main', '--by', 'agent:remote']);
  assert.equal(src.code, 0, src.err);
  assert.equal(src.out.trim(), 'v2: After Effects · clip.aep · Main');
  const png = path.join(dir, 'renders/fix.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', '-y', png]);
  const r = await vr(['preview', noteId, png, '--frame', '3', '--by', 'agent:remote']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${noteId}: preview p_[a-f0-9]{10} still of f3 on v2 by agent:remote`));
  const show = (await vr(['show', noteId])).out;
  assert.match(show, /project: 0\.400 s · frame 12 in After Effects · clip\.aep · Main \(v2\)/, 'the note at 0:00:12 on the project timeline');
  assert.match(show, /preview p_[a-f0-9]{10} still of f3 on v2 by agent:remote/);
});

test('vr ref goes to the server: an image inline, a moment of a render; vr show gives their URLs', async () => {
  const png = path.join(dir, 'renders/ref.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=200x100', '-frames:v', '1', '-y', png]);
  const img = await vr(['ref', noteId, png, '--caption', 'so', '--note', 'Meinst du das?', '--by', 'agent:remote']);
  assert.equal(img.code, 0, img.err);
  assert.match(img.out, new RegExp(`^${noteId}: reference r_[a-f0-9]{10} image 200×100 — "so" \\(by agent:remote\\)`));
  const moment = await vr(['ref', noteId, '--video', 'clip.mp4', '--frame', '5', '--by', 'agent:remote']);
  assert.equal(moment.code, 0, moment.err);
  const show = (await vr(['show', noteId])).out;
  const at = show.match(/\n\s+(http:\/\/127\.0\.0\.1:\d+\/api\/refs\/\S+\.png)\n/)?.[1];
  assert.ok(at, show);
  assert.equal((await fetch(at, { headers: { Authorization: `Bearer ${ownerToken}` } })).status, 200);
});

test('vr ask goes to the server: a small take inline, a big one through its upload URL; vr show tells the folder’s question', async () => {
  const takes = path.join(dir, 'takes');
  fs.mkdirSync(takes, { recursive: true });
  // a take past what goes inline (8 MB): a minute of stereo 48 kHz WAV
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*441*t):s=48000:d=60',
    '-y',
    path.join(takes, 'long.wav'),
  ]);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*330*t):s=48000:d=1', '-y', path.join(takes, 'short.wav')]);
  assert.ok(fs.statSync(path.join(takes, 'long.wav')).size > 8 * 1024 * 1024);
  const file = path.join(takes, 'ask.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        id: 'voice',
        label: 'Narrator',
        items: [
          { id: 'v1', label: 'Short', path: 'short.wav' },
          { id: 'v2', label: 'Long', path: 'long.wav' },
        ],
      },
    ]),
  );
  const asked = await vr(['ask', '--folder', 'Remote/Launch', '--text', 'Which narrator?', '--options', file, '--by', 'agent:remote']);
  assert.equal(asked.code, 0, asked.err);
  const id = must(/^(c_[0-9a-f]{6}) asked on folder Remote\/Launch \(no video yet\): voice \(one of 2\)$/m.exec(asked.out)?.[1], asked.out);
  const view = (await (await fetch(`${url}/api/asks/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()) as AskView;
  assert.deepEqual(
    view.options[0].items.map((it) => [it.ref?.kind, !!it.ref?.loudness]),
    [
      ['audio', true],
      ['audio', true],
    ],
    'both takes stored and measured, the big one through its upload URL',
  );
  const answered = await fetch(`${url}/api/asks/${id}/answer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ picks: { voice: ['v2'] }, note: 'slower' }),
  });
  assert.equal(answered.status, 200);
  const show = await vr(['show', id]);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /QUESTION {2}folder Remote\/Launch \(no video yet\)/);
  assert.match(show.out, /options voice "Narrator" \(pick one\): v1 Short \(audio 1\.0 s\) · v2 Long \(audio 60\.0 s\)/);
  assert.match(show.out, /↳ Olivia \[verified\]: PICKED voice=v2 · note: "slower"/);
});

// A12 OPT-8: each file under 8 MB went inline however many there were, and a question's request body could pass the
// server's 26 MB JSON limit (413). Past a total, the rest go by upload URL.
test('vr ask with takes that together pass the server’s request limit: the rest go by upload URL', async () => {
  const takes = path.join(agentHome, 'many');
  fs.mkdirSync(takes, { recursive: true });
  const items = [];
  for (let i = 0; i < 4; i++) {
    const f = path.join(takes, `t${i}.wav`);
    execFileSync(FFMPEG, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=0.2*sin(2*PI*${300 + i * 50}*t)|0.2*sin(2*PI*${301 + i * 50}*t):s=48000:d=32`,
      '-y',
      f,
    ]);
    assert.ok(fs.statSync(f).size > 6e6 && fs.statSync(f).size < 8 * 1024 * 1024);
    items.push({ id: `t${i}`, path: `t${i}.wav` });
  }
  const file = path.join(takes, 'ask.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'bed', label: 'Music bed', items }]));
  const asked = await vr(['ask', '--folder', 'Remote/Launch', '--text', 'Which bed?', '--options', file, '--by', 'agent:remote']);
  assert.equal(asked.code, 0, asked.err);
  const id = must(/^(c_[0-9a-f]{6}) asked on folder/m.exec(asked.out)?.[1], asked.out);
  const view = (await (await fetch(`${url}/api/asks/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()) as AskView;
  assert.deepEqual(
    view.options[0].items.map((it) => it.ref?.kind),
    ['audio', 'audio', 'audio', 'audio'],
    'every take stored',
  );
});

test('vr playbook reads the server’s playbook; export downloads skills with their files; suggestions go to the server', async () => {
  const playbooks = await import('../../lib/playbooks.ts');
  playbooks.writeText('', 'rules', '- Always end on the logo', { by: 'Olivia' });
  playbooks.putSkill('', { name: 'house-export', description: 'The studio export', body: 'ProRes 422 for masters.' }, { by: 'Olivia' });
  const preset = path.join(dir, 'master.epr');
  fs.writeFileSync(preset, '<master/>');
  await playbooks.addSkillFile('', 'house-export', 'master.epr', preset, 'Olivia');
  const read = await vr(['playbook', 'clip.mp4']);
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /^# Playbook: /);
  assert.match(read.out, /- Always end on the logo/);
  assert.match(read.out, /revisions in force: House r3/);
  const to = path.join(agentHome, 'exported');
  const exp = await vr(['playbook', 'export', '--to', to]);
  assert.equal(exp.code, 0, exp.err);
  assert.equal(fs.readFileSync(path.join(to, 'house-export', 'master.epr'), 'utf8'), '<master/>', 'the file came down to this machine');
  assert.match(fs.readFileSync(path.join(to, 'house-export', 'SKILL.md'), 'utf8'), /^---\nname: house-export\n/);
  const sug = await vr([
    'playbook',
    'propose',
    'house',
    '--section',
    'rules',
    '--text',
    '- End on the logo, 2 s',
    '--reason',
    'Clients keep asking for longer',
    '--by',
    'agent:remote',
  ]);
  assert.equal(sug.code, 0, sug.err);
  const id = must(/(pp_[0-9a-f]{12})/.exec(sug.out)?.[1], sug.out);
  assert.equal(playbooks.findProposal(id)?.proposal.by, 'agent:remote', 'recorded on the server, as the agent');
  assert.match((await vr(['playbook', 'status', id])).out, /rules of House · pending/);
});

test('an interrupted vr push continues where it stopped', async () => {
  const big = makeVideo(path.join(dir, 'renders/big.mp4'), { w: 640, h: 360, dur: 3, pattern: 'testsrc2' });
  const size = fs.statSync(big).size;
  const tus = await import('tus-js-client');
  const { FileUrlStorage } = tus as unknown as { FileUrlStorage: new (f: string) => never };
  fs.mkdirSync(path.join(agentHome, 'cache/video-review'), { recursive: true });
  // The first third goes up, then the connection "drops": what an earlier vr push would leave behind.
  const uploadUrl = await new Promise<string>((resolve, reject) => {
    const up = new tus.Upload(fs.createReadStream(big), {
      endpoint: `${url}/api/uploads`,
      uploadSize: size,
      chunkSize: Math.ceil(size / 3),
      metadata: { filename: 'big.mp4', folder: 'Resume' },
      headers: { Authorization: `Bearer ${ownerToken}` },
      urlStorage: new FileUrlStorage(path.join(agentHome, 'cache/video-review/uploads.json')),
      onChunkComplete: () => {
        up.abort();
        resolve(String(up.url));
      },
      onError: reject,
    });
    up.start();
  });
  const r = await vr(['push', big, '--folder', 'Resume']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /added: \/@uploads\/Resume\/big\.mp4 \(v1\)/);
  const id = must(uploadUrl.split('/').pop(), uploadUrl);
  const outcome = (await client(Number(new URL(url).port))('GET', `/api/upload-results/${id}`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json();
  assert.equal(outcome.status, 'done', 'the same upload was finished, not a new one');
});

test('the MCP server works against the hosted server too', async () => {
  const mcp = new Client({ name: 'remote-test', version: '1.0.0' });
  // A stdio MCP server follows the hosted server's live events from the moment it is connected.
  const streams = ctx.hub.clients();
  await mcp.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: agentEnv as Record<string, string>, stderr: 'ignore' }),
  );
  try {
    const call = async (name: string, args: object) => (await mcp.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult;
    // A note without a drawing comes as words; asked for, its marked frame comes from the server's screenshot.
    const plain = await call('get_open_notes', { video: 'clip.mp4' });
    assert.ok(!plain.isError, JSON.stringify(plain.content));
    assert.match((plain.content[0] as { text: string }).text, /Farbe kälter/);
    assert.ok(!plain.content.some((c) => c.type === 'image'), 'no picture without a drawing');
    const notes = await call('get_open_notes', { video: 'clip.mp4', images: 'all' });
    const [first, ...rest] = notes.content;
    assert.match((first as { text: string }).text, /Farbe kälter/);
    assert.ok(
      rest.some((c) => c.type === 'image'),
      'the marked frame as an image',
    );
    const frame = await call('get_frame', { video: 'clip.mp4', frame: 3 });
    assert.equal(frame.content[1]?.type, 'image');
    // Subscribed to the inbox, it hears of new notes through the server's live events.
    const updates: string[] = [];
    mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await mcp.subscribeResource({ uri: 'vr://inbox' });
    // A note added before its stream is open would never reach it: wait for the stream, not for a time.
    await until(() => ctx.hub.clients() > streams, 'the MCP server connected to the live events');
    const added = await call('add_note', { video: 'clip.mp4', frame: 4, text: 'MCP hier', by: 'agent:mcp-remote' });
    assert.match((added.content[0] as { text: string }).text, /pinned at .* by agent:mcp-remote\nmarked: \//);
    await until(() => updates.includes('vr://inbox'), 'the inbox update').catch(() => {});
    assert.deepEqual(updates, ['vr://inbox']);
  } finally {
    await mcp.close();
  }
});

test('vr login with a password makes a token that vr logout revokes', async () => {
  const before = auth.listTokens().length;
  const r = await vr(['login', url, '--email', 'olivia@example.com'], { VR_PASSWORD: 'a long password' });
  assert.equal(r.code, 0, r.err);
  assert.equal(auth.listTokens().length, before + 1);
  const out = await vr(['logout']);
  assert.match(out.out, /signed out of .* \(token revoked\)/);
  assert.equal(auth.listTokens().length, before);
  assert.match((await vr(['whoami'])).out, /local store:/);
  const bad = await vr(['login', url, '--email', 'olivia@example.com'], { VR_PASSWORD: 'wrong password!' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /wrong email or password/);
});

test('vr login --email reads email and password from piped stdin (scripts)', async () => {
  // a bare --email asks for the address too; without it, vr login goes to the browser (browser-login.test.ts)
  const r = await vr(['login', url, '--email'], {}, 'olivia@example.com\na long password\n');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /signed in to .* as .*olivia@example.com/);
  assert.match((await vr(['logout'])).out, /token revoked/);
});

test('vr login --token - reads the token from stdin; a token on the command line is warned about', async () => {
  const token = auth.createToken(must(auth.findUserByEmail('olivia@example.com')).id, 'piped').token;
  const piped = await vr(['login', url, '--token', '-'], {}, `${token}\n`);
  assert.equal(piped.code, 0, piped.err);
  assert.match(piped.out, /signed in to .* as Olivia/);
  assert.equal(piped.err, '', 'nothing to warn about');
  const empty = await vr(['login', url, '--token', '-'], {}, '');
  assert.equal(empty.code, 1);
  assert.match(empty.err, /no token/);
  // Other users of this machine can read a process's arguments while it runs (ps), and the shell keeps them.
  const literal = await vr(['login', url, '--token', token]);
  assert.equal(literal.code, 0, literal.err);
  assert.match(literal.err, /warning: .*process list.*--token -/);
  assert.ok(!literal.err.includes(token), 'the warning does not repeat the token');
});

test('AGENT-12: vr login over plain http to another machine sends nothing unless --insecure; this machine is fine', async () => {
  const token = auth.createToken(must(auth.findUserByEmail('olivia@example.com')).id, 'insecure').token;
  // The same server under an address that isn't this machine's loopback by name: as a server elsewhere on the network.
  const elsewhere = url.replace('127.0.0.1', '0.0.0.0');
  await vr(['logout']);
  const tokens = auth.listTokens().length;
  const byPassword = await vr(['login', elsewhere, '--email', 'olivia@example.com'], { VR_PASSWORD: 'a long password' });
  assert.equal(byPassword.code, 1);
  assert.match(byPassword.err, /plain http.*--insecure/);
  assert.equal(auth.listTokens().length, tokens, 'the password was never sent');
  const byToken = await vr(['login', elsewhere, '--token', '-'], {}, `${token}\n`);
  assert.equal(byToken.code, 1);
  assert.ok(!byToken.err.includes(token));
  assert.match((await vr(['whoami'])).out, /local store:/, 'nothing saved');
  // Asked for: it signs in, and says what it means.
  const asked = await vr(['login', elsewhere, '--token', '-', '--insecure'], {}, `${token}\n`);
  assert.equal(asked.code, 0, asked.err);
  assert.match(asked.err, /warning: .*plain http/);
  assert.match((await vr(['logout'])).out, /signed out/);
  // https and this machine's own loopback say nothing
  const here = await vr(['login', url, '--token', '-'], {}, `${token}\n`);
  assert.equal(here.code, 0, here.err);
  assert.equal(here.err, '');
  // (signed in as before: the test below pushes)
});

test('A12-D13: a stdio wait against the server asks only for what is new, and only when something happened', async () => {
  const mcp = new Client({ name: 'remote-wait', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: agentEnv as Record<string, string>, stderr: 'ignore' }),
  );
  try {
    const call = async (name: string, args: object) => (await mcp.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult;
    const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
    await call('list_videos', {});
    await sleep(800); // its live stream is open
    asked.length = 0;
    const quiet = await call('wait_for_feedback', { video: 'clip.mp4', timeout_s: 4 });
    assert.match(text(quiet), /No new feedback in 4 s/);
    const reads = asked.filter((u) => u.startsWith('/api/inbox'));
    // It read the server's recent log once a second, 2,000 events (~888 KB) each time.
    assert.ok(reads.length <= 3, `${reads.length} reads in a quiet 4 s wait:\n${reads.join('\n')}`);
    assert.ok(
      reads.every((u) => /[?&]since=/.test(u)),
      `only what is new:\n${reads.join('\n')}`,
    );
    // Something happens: the stream it follows wakes it at once.
    const { slugify } = await import('../../lib/paths.ts');
    const slug = slugify(must(store.listReviews().find((r) => r.video.endsWith('/clip.mp4'))).video);
    const waiting = call('wait_for_feedback', { video: 'clip.mp4', timeout_s: 20 });
    await sleep(1000);
    const t = Date.now();
    store.addComment(slug, { frame: 6, text: 'woken by the stream', author: 'Olivia' });
    const got = await waiting;
    assert.match(text(got), /woken by the stream/);
    assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
  } finally {
    await mcp.close();
  }
});

// Last: it puts a second clip.mp4 on the server, which the tests above name by its file name alone.
test('a video named by its whole path is that video, even when another has the same file name', async () => {
  assert.equal((await vr(['push', clip, '--folder', 'Other'])).code, 0);
  for (const name of ['/@uploads/Acme/Reels/clip.mp4', '@uploads/Acme/Reels/clip.mp4', 'Acme/Reels/clip.mp4']) {
    const r = await vr(['open', name]);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.match(r.out, /^\/@uploads\/Acme\/Reels\/clip\.mp4\n/, name);
  }
  // Only the file name: both are meant, so vr asks which.
  const both = await vr(['open', 'clip.mp4']);
  assert.equal(both.code, 1);
  assert.match(both.err, /"clip\.mp4" matches 2 videos/);
});
