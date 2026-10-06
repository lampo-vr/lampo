// The guest crawl on a hosted server with two workspaces (A12 GUEST-15): a visitor of a link in the second workspace
// walks everything the link answers — the room, the video, a note with references, a picture through its one-time
// upload URL and the URL's outcome, the archive's facts, the transcript, a download — and none of it names the other
// workspace's videos or folders, the workspace's id, the server's upload slugs, the folders above the link, or anyone's
// address. guest-privacy.test.ts does the same on the machine, where slugs are disk paths.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;

let server: http.Server;
let port = 0;
let request: Request;
let B = '';
const owners: Record<string, Record<string, string>> = {};

async function signIn(email: string, workspace?: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  let cookie = String([r.headers['set-cookie']].flat()[0]).split(';')[0];
  if (workspace) {
    const s = await request('POST', '/api/workspaces/switch', { body: { id: workspace }, headers: { Cookie: cookie, ...origin } });
    assert.equal(s.status, 200, s.text);
    cookie = String([s.headers['set-cookie']].flat()[0]).split(';')[0];
  }
  return { Cookie: cookie, ...origin };
}

/** A render uploaded into a workspace's folder, as its owner's agent would (tus with a token). */
async function upload(workspace: string, name: string, folder: string): Promise<string> {
  const who = owners[workspace];
  const token = (await request('POST', '/api/auth/tokens', { body: { name: 'upload' }, headers: who })).json().token;
  const clip = makeVideo(path.join(dir, workspace, name), { w: 160, h: 90, dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: name, folder }, { Authorization: `Bearer ${token}` });
  assert.equal(up.status, 200, up.text);
  return up.json().slug as string;
}

let slugA = '';
let slugB = '';
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  await auth.createUser({ email: 'alice@example.com', name: 'Alice', password: PASSWORD, role: 'owner' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'reviewer' });
  B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  owners.w1 = await signIn('alice@example.com');
  owners[B] = await signIn('bob@example.com', B);
  slugA = await upload('w1', 'northwind-secret.mp4', 'Northwind/Board');
  slugB = await upload(B, 'intro.mp4', 'Studio/Reels/Launch');
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('a link in the second workspace names nothing of the first, nor its own workspace, slugs or folders above it', async () => {
  const made = await request('POST', '/api/folder-shares', {
    body: { folder: 'Studio/Reels', notes: 'all', versions: 'all', download: 'original', label: 'Client' },
    headers: owners[B],
  });
  assert.equal(made.status, 200, made.text);
  const token = made.json().token as string;

  const surface: string[] = [];
  const fetched = new Set<string>();
  const visitor = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
  const seen = async (method: string, url: string, body?: unknown) => {
    const r = await visitor(method, url, body === undefined ? {} : { body });
    surface.push(String(r.status), JSON.stringify(r.headers), r.text);
    return r;
  };
  const crawl = async (text: string): Promise<void> => {
    for (const [url] of text.matchAll(/\/(?:api|media|data)\/g\/[^"\s\\]+/g)) {
      if (fetched.has(url)) continue;
      fetched.add(url);
      const r = await visitor('GET', url, { headers: { range: 'bytes=0-65535' } });
      surface.push(String(r.status), JSON.stringify(r.headers), r.headers['content-type']?.includes('json') ? r.text : '');
      if (r.headers['content-type']?.includes('json')) await crawl(r.text);
    }
  };

  const room = await seen('GET', `/api/g/${token}`);
  assert.equal(room.status, 200, room.text);
  assert.equal(room.json().folder, 'Reels', 'the folder by its own name');
  const id = room.json().videos[0].slug as string;
  assert.equal(room.json().videos[0].folder, 'Launch', 'the video by where it sits below');
  await crawl(room.text);
  const note = await seen('POST', `/api/g/${token}/comments`, {
    name: 'Mia',
    slug: id,
    frame: 3,
    text: 'like this picture',
    refs: [{ kind: 'frame', video: id, frame: 5 }],
  });
  assert.equal(note.status, 200, note.text);
  const ticket = await seen('POST', `/api/g/${token}/comments/${note.json().id}/refs`, { name: 'Mia', kind: 'image' });
  assert.equal(ticket.status, 200, ticket.text);
  const png = path.join(dir, 'look.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', png]);
  const url = new URL(ticket.json().upload.url, PUBLIC).pathname;
  const data = fs.readFileSync(png);
  const put = await client(port, { Host: 'review.test', ...origin })('PUT', url, { body: data, headers: { 'content-length': String(data.length) } });
  surface.push(String(put.status), JSON.stringify(put.headers), put.text);
  assert.equal(put.status, 200, put.text);
  await seen('GET', url);
  for (const p of [`/api/g/${token}/review/${id}`, `/api/g/${token}/review/${id}/transcript`, `/api/g/${token}/archive/info`])
    await crawl((await seen('GET', p)).text);
  await seen('GET', `/api/g/${token}/download/${id}/v1?kind=original&name=Mia`);
  // the other workspace's video, asked for by its slug: the same miss as anything unknown
  await seen('GET', `/api/g/${token}/review/${enc(slugA)}`);

  assert.ok(fetched.size >= 4, `crawled the guest URLs (${fetched.size})`);
  const all = surface.join('\n');
  for (const secret of ['Northwind', 'northwind-secret', 'Board', 'Studio', slugA, slugB, '@uploads', `/${B}/`, `"${B}"`, 'alice@', 'bob@', dir]) {
    const at = all.indexOf(secret);
    assert.ok(at < 0, `a visitor must never see ${JSON.stringify(secret)}: …${all.slice(Math.max(0, at - 200), at + 80)}…`);
  }
});
