// What an error says depends on who asked, never on the mode (audit A12: INV-1, INV-4, GUEST-8). The machine's owner at
// the machine gets ffmpeg's output and the paths: they are their own files. Everyone else — a review-link visitor (on the
// machine too, through the tunnel), a token or a session on another device, an agent over MCP, every caller of a hosted
// server — gets a plain sentence with a ref to the log line, whether the failure is a 5xx or a 4xx a route made of it.
// The walk: the same broken files and the same damaged render, asked by each audience on the machine and on a server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const { slugify, CACHE, DATA, HOME, VERSIONS } = await import('../../lib/paths.ts');
const auth = await import('../../lib/auth.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

// A render that lives in a client's folder under someone's home: the names a visitor must never learn.
const video = makeVideo(path.join(dir, 'Users/olivia-home/Clients/Acme/export/spot.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(video);
const note = store.addComment(slug, { frame: 3, text: 'Logo später', author: 'tester' });

// A PNG whose header reads fine and whose picture doesn't: probing passes, converting fails inside ffmpeg.
const goodPng = path.join(dir, 'good.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', goodPng]);
const png = fs.readFileSync(goodPng);
const idat = png.indexOf('IDAT');
for (let i = idat + 8; i < png.length - 16; i++) png[i] = (png[i] as number) ^ 0x5a;
const brokenPng = png.toString('base64');
// A clip that probes fine but can't be made playable (1×1 pixels).
const tinyClip = path.join(dir, 'tiny.mkv');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1x1:rate=10:duration=1', '-c:v', 'ffv1', '-y', tinyClip]);
const brokenClip = fs.readFileSync(tinyClip).toString('base64');

let machine: http.Server;
let hosted: http.Server;
let onMachine: Request;
let onServer: Request;
let token = '';
const logged: unknown[][] = [];
const consoleError = console.error;
before(async () => {
  machine = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => machine.listen(0, '127.0.0.1', r));
  onMachine = client((machine.address() as AddressInfo).port);
  hosted = http.createServer(createApp(createContext({ cfg: { ...loadConfig(), mode: 'server' }, token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => hosted.listen(0, '127.0.0.1', r));
  onServer = client((hosted.address() as AddressInfo).port);
  const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  token = auth.createToken(max.id, 'agent').token;
  console.error = (...a: unknown[]) => logged.push(a);
});
after(() => {
  console.error = consoleError;
  for (const s of [machine, hosted]) {
    s.closeAllConnections();
    s.close();
  }
});

// What only the owner may read: the store, the home folder and the client's folder, the tool and its output.
const SECRETS = [dir, fs.realpathSync(os.tmpdir()), os.tmpdir(), DATA, CACHE, VERSIONS, HOME, 'olivia-home', 'Clients', 'exited', '@ 0x', '/opt/', '/usr/'];
function plain(what: string, status: number, text: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what} (${status}) names ${JSON.stringify(s)}: ${text.slice(0, 300)}`);
  assert.match(text, /\(ref [0-9a-f]{8}\)/, `${what}: a ref to the log line`);
  const ref = /\(ref ([0-9a-f]{8})\)/.exec(text)?.[1] as string;
  assert.ok(
    logged.some((line) => line.join(' ').includes(ref)),
    `${what}: the whole error is in the log under its ref`,
  );
}
const enc = encodeURIComponent;
const bearer = () => ({ Authorization: `Bearer ${token}` });
// What the tunnel and other devices look like to the machine.
const visitor = { 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7' };

let link = '';
let guestId = '';
let guestNote = '';
test('setup: a review link that takes notes, and a client note on it', async () => {
  const made = await onMachine('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Acme', notes: 'all', versions: 'all' } });
  assert.equal(made.status, 200, made.text);
  link = made.json().token;
  guestId = (await onMachine('GET', `/api/g/${link}`, { headers: visitor })).json().videos[0].slug;
  const n = await onMachine('POST', `/api/g/${link}/comments`, { body: { name: 'Ann', slug: guestId, frame: 3, text: 'x' }, headers: visitor });
  assert.equal(n.status, 200, n.text);
  guestNote = n.json().id;
});

test('a file that fails inside ffmpeg (4xx): the machine’s owner reads ffmpeg, everyone else a sentence', async () => {
  const body = { kind: 'image', data: brokenPng };
  const owner = await onMachine('POST', `/api/comments/${note.id}/refs`, { body });
  assert.equal(owner.status, 422, owner.text);
  assert.match(owner.text, /exited/, 'the owner at the machine sees what ffmpeg said');

  const others: [string, Promise<{ status: number; text: string }>][] = [
    ['a token on the machine', onMachine('POST', `/api/comments/${note.id}/refs`, { body, headers: bearer() })],
    ['a token on a server', onServer('POST', `/api/comments/${note.id}/refs`, { body, headers: bearer() })],
    [
      'a review-link visitor (GUEST-8)',
      onMachine('POST', `/api/g/${link}/comments/${guestNote}/refs`, { body: { name: 'Ann', kind: 'clip', data: brokenClip }, headers: visitor }),
    ],
    [
      'a visitor at the machine itself',
      onMachine('POST', `/api/g/${link}/comments/${guestNote}/refs`, { body: { name: 'Ann', kind: 'clip', data: brokenClip } }),
    ],
  ];
  for (const [what, p] of others) {
    const r = await p;
    assert.ok(r.status >= 400 && r.status < 500, `${what}: ${r.status} ${r.text}`);
    plain(what, r.status, r.text);
  }
  // A refusal written for the caller stays as it was: nothing internal in it, nothing to hide.
  const words = await onServer('POST', `/api/comments/${note.id}/refs`, {
    body: { kind: 'image', data: Buffer.from('not a picture').toString('base64') },
    headers: bearer(),
  });
  assert.equal(words.status, 422);
  assert.doesNotMatch(words.text, /ref [0-9a-f]{8}/, words.text);
});

test('a damaged render (5xx): a visitor on the machine (INV-1) and an agent on a server (INV-4) get a sentence', async () => {
  // The stored copy of the render goes bad (a disk error, a copy taken while it was still being written).
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(VERSIONS).filter((f) => f.endsWith('.mp4'))) fs.writeFileSync(f, 'garbage');

  const guest = await onMachine('POST', `/api/g/${link}/comments`, { body: { name: 'Ann', slug: guestId, frame: 5, text: 'y' }, headers: visitor });
  assert.ok(guest.status >= 500, `${guest.status} ${guest.text}`);
  plain('a visitor’s note on the machine', guest.status, guest.text);

  const owner = await onMachine('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 5, text: 'z' } });
  assert.ok(owner.status >= 500, `${owner.status} ${owner.text}`);
  assert.match(owner.text, /exited|garbage|Invalid data|moov/i, `the owner at the machine sees why: ${owner.text}`);

  const tokenOnMachine = await onMachine('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 5, text: 'z' }, headers: bearer() });
  assert.ok(tokenOnMachine.status >= 500, `${tokenOnMachine.status} ${tokenOnMachine.text}`);
  plain('a token on the machine', tokenOnMachine.status, tokenOnMachine.text);

  const port = (hosted.address() as AddressInfo).port;
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: bearer() } }));
  try {
    const r = (await c.callTool({ name: 'get_frame', arguments: { video: slug, frame: 3 } })) as { content: { text?: string }[]; isError?: boolean };
    assert.equal(r.isError, true);
    plain('an agent’s get_frame on a server', 200, r.content[0]?.text ?? '');
  } finally {
    await c.close();
  }
});

test('what counts as internal: a tool’s or the system’s words, as they are or carried on; never the caller’s own input', async () => {
  const { isInternal } = await import('../../lib/publicError.ts');
  assert.ok(isInternal(Object.assign(new Error('x'), { stderr: 'moov atom not found' })), 'a RunError');
  assert.ok(isInternal(Object.assign(new Error('x'), { errno: -2, syscall: 'open' })), 'an errno error');
  assert.ok(isInternal(new Error('could not convert: ffmpeg exited 1: [mjpeg @ 0x1234abcd] broken')), 'tool output carried on');
  assert.ok(isInternal(new Error('voice/a: /usr/bin/ffmpeg exited null: Error while decoding stream #0:0')), 'a run a signal ended, carried on (A12 OPTM-1)');
  assert.ok(isInternal(new Error("ENOENT: no such file or directory, open '/srv/x'")), 'a file system error carried on');
  assert.ok(isInternal(Object.assign(new Error('that file could not be converted'), { cause: { stderr: '…' } })), 'through the cause');
  // An answer that repeats a path the caller typed tells them nothing new, and must read the same whatever is there.
  assert.ok(!isInternal(new Error('no reviewed video matches "/data/versions/x/v1.mp4"')));
  assert.ok(!isInternal(new Error('not an image or a video this app can read')));
});
