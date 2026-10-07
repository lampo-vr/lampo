// A client's file reference on a hosted server with two workspaces. The review page sends every image or clip through
// a one-time upload URL: that request carries no sign-in, so it runs in no workspace, and the ticket's own check (the
// link is still valid) has to run in the workspace the URL was handed out in — for a link of either workspace.
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
const { inWorkspace } = await import('../../lib/paths.ts');
const { revokeShare, updateShare } = await import('../../lib/shares.ts');
const store = await import('../../lib/store.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;

let server: http.Server;
let port = 0;
let request: Request;
const owners: Record<string, Record<string, string>> = {};
let B = '';

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
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const png = path.join(dir, 'ref.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', png]);

/** A video and a review link to it in one workspace (its owner's session works there). */
async function linkIn(workspace: string) {
  const who = owners[workspace];
  const token = (await request('POST', '/api/auth/tokens', { body: { name: 'upload' }, headers: who })).json().token;
  const clip = makeVideo(path.join(dir, workspace, 'intro.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'intro.mp4', folder: 'Reels' }, { Authorization: `Bearer ${token}` });
  assert.equal(up.status, 200, up.text);
  const link = await request('POST', `/api/review/${enc(up.json().slug)}/shares`, { body: { label: 'Client' }, headers: who });
  assert.equal(link.status, 200, link.text);
  return link.json().token as string;
}

/** What a visitor's browser does: a note, a ticket for a picture on it, then the picture to the one-time URL. */
async function attach(link: string) {
  const guest = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
  const id = (await guest('GET', `/api/g/${link}`)).json().videos[0].slug;
  const note = await guest('POST', `/api/g/${link}/comments`, { body: { name: 'Mia', slug: id, frame: 3, text: 'like this picture' } });
  assert.equal(note.status, 200, note.text);
  const ticket = await guest('POST', `/api/g/${link}/comments/${note.json().id}/refs`, { body: { name: 'Mia', kind: 'image' } });
  assert.equal(ticket.status, 200, ticket.text);
  const url = new URL(ticket.json().upload.url, PUBLIC).pathname;
  const body = fs.readFileSync(png);
  // a fresh connection, as the page's upload is: nothing of the visit before it rides along
  const put = await client(port, { Host: 'review.test', ...origin })('PUT', url, { body, headers: { 'content-length': String(body.length) } });
  return { put, url, guest };
}

for (const which of ['w1', 'B']) {
  test(`a client's picture through the one-time upload URL lands on their note (a link of ${which === 'w1' ? 'workspace #1' : 'the second workspace'})`, async () => {
    const workspace = which === 'w1' ? 'w1' : B;
    const link = await linkIn(workspace);
    const { put, url } = await attach(link);
    assert.equal(put.status, 200, `${put.status} ${put.text}`);
    const ref = put.json().ref;
    assert.equal(ref.kind, 'image');
    assert.match(ref.src, new RegExp(`^/api/g/${link}/refs/`), 'answered as the link shows it');
    const outcome = await request('GET', url);
    assert.equal(outcome.status, 200, outcome.text);
  });
}

test('a link revoked after the URL was handed out takes nothing: refused in its own workspace, not by a lookup elsewhere', async () => {
  const link = await linkIn(B);
  const guest = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
  const id = (await guest('GET', `/api/g/${link}`)).json().videos[0].slug;
  const note = (await guest('POST', `/api/g/${link}/comments`, { body: { name: 'Mia', slug: id, frame: 3, text: 'and this one' } })).json();
  const ticket = (await guest('POST', `/api/g/${link}/comments/${note.id}/refs`, { body: { name: 'Mia', kind: 'image' } })).json();
  assert.equal(
    inWorkspace(B, () => revokeShare(link)),
    true,
  );
  const body = fs.readFileSync(png);
  const put = await request('PUT', new URL(ticket.upload.url, PUBLIC).pathname, { body, headers: { 'content-length': String(body.length) } });
  assert.equal(put.status, 410, put.text);
  assert.match(put.json().error, /not valid any more/);
});

test('a password set after the URL was handed out: the file isn’t taken, the visitor has to know it now', async () => {
  const link = await linkIn('w1');
  const guest = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
  const id = (await guest('GET', `/api/g/${link}`)).json().videos[0].slug;
  const note = (await guest('POST', `/api/g/${link}/comments`, { body: { name: 'Mia', slug: id, frame: 3, text: 'one more' } })).json();
  const ticket = (await guest('POST', `/api/g/${link}/comments/${note.id}/refs`, { body: { name: 'Mia', kind: 'image' } })).json();
  inWorkspace('w1', () => updateShare(link, { password: 'now it is locked' }));
  assert.equal((await guest('GET', `/api/g/${link}/review/${id}`)).status, 401, 'the link asks for it');
  const body = fs.readFileSync(png);
  const put = await request('PUT', new URL(ticket.upload.url, PUBLIC).pathname, { body, headers: { 'content-length': String(body.length) } });
  assert.equal(put.status, 401, put.text);
  const kept = inWorkspace('w1', () =>
    store
      .listReviews()
      .flatMap((r) => r.comments)
      .find((c) => c.id === note.id),
  );
  assert.ok(kept, 'the note is there');
  assert.equal(kept.refs?.length ?? 0, 0, 'and carries no picture');
});
