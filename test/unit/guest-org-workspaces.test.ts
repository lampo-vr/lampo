// Whose team a review link says it comes from, on a hosted server with several workspaces: each link names its own
// workspace's team. The server-wide name (org_name / VR_ORG_NAME) is workspace #1's — the operator's own team — and
// never shows on another team's links.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_ORG_NAME: 'Northwind Studio' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;
let server: http.Server;
let port = 0;
let request: Request;
let B = '';
const sessions: Record<string, Record<string, string>> = {};

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

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
before(async () => {
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  await auth.createUser({ email: 'alice@example.com', name: 'Alice', password: PASSWORD, role: 'owner' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'reviewer' });
  B = ws.createWorkspace({ name: 'Bravo Pictures', ownerId: bob.id }).id;
  sessions.w1 = await signIn('alice@example.com');
  sessions[B] = await signIn('bob@example.com', B);
});
after(() => {
  ctx.mail.stop();
  server.closeAllConnections();
  server.close();
});

/** A video in a workspace and a review link to it; what the link's visitor is told about whose it is. */
async function linkIn(workspace: string): Promise<{ room: string; page: string }> {
  const who = sessions[workspace] as Record<string, string>;
  const token = (await request('POST', '/api/auth/tokens', { body: { name: 'upload' }, headers: who })).json().token;
  const clip = makeVideo(path.join(dir, workspace, 'intro.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'intro.mp4', folder: 'Reels' }, { Authorization: `Bearer ${token}` });
  assert.equal(up.status, 200, up.text);
  const link = (await request('POST', `/api/review/${enc(up.json().slug)}/shares`, { body: { label: 'Client' }, headers: who })).json().token;
  const guest = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
  const room = (await guest('GET', `/api/g/${link}`)).json();
  const page = (await guest('GET', `/api/g/${link}/review/${room.videos[0].slug}`)).json();
  return { room: room.org, page: page.org };
}

test('each review link names its own workspace’s team; the server’s name is workspace #1’s', async () => {
  assert.deepEqual(await linkIn('w1'), { room: 'Northwind Studio', page: 'Northwind Studio' });
  assert.deepEqual(await linkIn(B), { room: 'Bravo Pictures', page: 'Bravo Pictures' }, 'never another team’s name');
});

// A sign-up's workspace starts out named after its owner: a person's name, which a link would pass off as a team's
// (audit A12 verification: WS-7's rest). Until someone names it, visitors read no team name — only the sharer.
test('a sign-up’s workspace that nobody named shows no team name on its links; once named, its name', async () => {
  const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol Example', password: PASSWORD, role: 'reviewer' });
  const C = ws.createWorkspace({ name: 'Carol Example', ownerId: carol.id, signup: true }).id;
  sessions[C] = await signIn('carol@example.com', C);
  assert.deepEqual(await linkIn(C), { room: null, page: null }, 'not the owner’s own name as the team’s');
  ws.renameWorkspace(C, 'Cobalt Films');
  assert.deepEqual(await linkIn(C), { room: 'Cobalt Films', page: 'Cobalt Films' });
});

// The invite email and the invite page say the same (A12 VE2b-6): an unnamed sign-up workspace is no team's name — the
// inviter is named, and anyone with an account may still join with it; and the server's team name (VR_ORG_NAME) is
// workspace #1's, never in the subject of another workspace's invite.
test('an invite into a workspace nobody named names the inviter, not the placeholder; once named, its name', async () => {
  const dana = await auth.createUser({ email: 'dana@example.com', name: 'Dana Example', password: PASSWORD, role: 'reviewer' });
  const D = ws.createWorkspace({ name: 'Dana Example', ownerId: dana.id, signup: true }).id;
  const who = await signIn('dana@example.com', D);
  const outbox = path.join(dir, 'cache', 'outbox');
  const invite = async (email: string) => {
    const r = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', email, send: true }, headers: who });
    assert.equal(r.status, 200, r.text);
    await ctx.mail.flush();
    const mail = readOutbox(outbox).findLast((m) => m.to === email);
    assert.ok(mail, `no mail to ${email}`);
    const token = /#\/invite\/([\w-]+)/.exec(mail.text)?.[1] as string;
    const peek = await request('POST', '/api/auth/invite/peek', { body: { token }, headers: origin });
    assert.equal(peek.status, 200, peek.text);
    return { mail, peek: peek.json() };
  };
  const first = await invite('client@example.com');
  assert.doesNotMatch(first.mail.text, /workspace named/, first.mail.text);
  assert.doesNotMatch(first.mail.subject, /Northwind Studio/, 'workspace #1’s team name');
  assert.equal(first.peek.workspace, undefined, JSON.stringify(first.peek));
  assert.equal(first.peek.several, true, 'an account here may still join with its own password');
  assert.equal(first.peek.by, 'Dana Example');

  ws.renameWorkspace(D, 'Delta Films');
  const named = await invite('client2@example.com');
  assert.match(named.mail.text, /workspace named “Delta Films”/);
  assert.doesNotMatch(named.mail.subject, /Northwind Studio/);
  assert.equal(named.peek.workspace, 'Delta Films');
  // workspace #1's own invites keep the server's team name
  const own = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', email: 'client3@example.com', send: true }, headers: sessions.w1 });
  assert.equal(own.status, 200, own.text);
  await ctx.mail.flush();
  assert.match(readOutbox(outbox).findLast((m) => m.to === 'client3@example.com')?.subject ?? '', /Northwind Studio/);
});
