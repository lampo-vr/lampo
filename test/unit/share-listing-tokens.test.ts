// A review link's token opens it to anyone who holds it. A person's own browser gets the tokens of the links it lists
// (the share dialog and Settings → Review links copy, edit and revoke by them); an API token — an agent — never reads
// one in a listing: `GET /api/shares` would hand it every client link of the workspace in one call, and with a link
// it could approve as the client, which sign-off by people forbids (audit A12 verification: VB-4).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;
let server: http.Server;
let request: Request;
let owner: Record<string, string> = {};
let member: Record<string, string> = {};
let agent: Record<string, string> = {};
let slug = '';
const links: string[] = [];

async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0], ...origin };
}

before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Host: 'review.test' });
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
  owner = await signIn('olivia@example.com');
  member = await signIn('max@example.com');
  const made = await request('POST', '/api/auth/tokens', { body: { name: 'agent' }, headers: member });
  assert.equal(made.status, 200, made.text);
  agent = { Authorization: `Bearer ${made.json().token}` };
  const clip = makeVideo(path.join(dir, 'up', 'intro.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'intro.mp4', folder: 'Reels' }, agent);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  // the owner's links, one on the video and one on its folder
  for (const [url, body] of [
    [`/api/review/${enc(slug)}/shares`, { label: 'Client' }],
    ['/api/folder-shares', { folder: 'Reels', label: 'Agency' }],
  ] as const) {
    const r = await request('POST', url, { body, headers: owner });
    assert.equal(r.status, 200, r.text);
    links.push(r.json().token);
  }
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const LISTINGS = () => ['/api/shares', `/api/review/${enc(slug)}/shares`, `/api/folder-shares?folder=${enc('Reels')}`];

test('an API token’s listings name every link without its token', async () => {
  for (const url of LISTINGS()) {
    const r = await request('GET', url, { headers: agent });
    assert.equal(r.status, 200, `${url}: ${r.text}`);
    const shares = r.json().shares as { token?: string; id: string; label: string }[];
    assert.ok(shares.length >= 1, `${url} lists the links`);
    for (const s of shares) {
      assert.equal(s.token, undefined, `${url}: ${s.label} carries no token`);
      assert.ok(s.id, `${url}: ${s.label} keeps its id`);
    }
    for (const t of links) assert.ok(!r.text.includes(t), `${url}: no link's token anywhere in the answer`);
  }
});

test('a person’s own browser gets the tokens it copies, edits and revokes by', async () => {
  for (const headers of [owner, member]) {
    const all = (await request('GET', '/api/shares', { headers })).json().shares as { token?: string }[];
    assert.deepEqual(all.map((s) => s.token).sort(), [...links].sort(), 'Settings → Review links copies them');
    const here = (await request('GET', `/api/review/${enc(slug)}/shares`, { headers })).json().shares as { token?: string }[];
    assert.equal(here.length, 2);
    assert.ok(
      here.every((s) => s.token && links.includes(s.token)),
      'the share dialog copies them',
    );
  }
});

// Making a link of its own was the way around: a token made one, approved through it "as the client", and revoked it —
// the client's approval stayed (A12 VE2b-1). A review link is a person's to make, change and revoke.
test('an API token makes, changes and revokes no review link: a person’s, like credentials (403 person)', async () => {
  const [videoLink, folderLink] = links as [string, string];
  for (const [method, url, body] of [
    ['POST', `/api/review/${enc(slug)}/shares`, { label: 'From the agent', approve: true }],
    ['POST', '/api/folder-shares', { folder: 'Reels', label: 'From the agent' }],
    ['PATCH', `/api/shares/${videoLink}`, { approve: true }],
    ['DELETE', `/api/shares/${folderLink}`, undefined],
  ] as const) {
    const r = await request(method, url, { body, headers: agent });
    assert.equal(r.status, 403, `${method} ${url}: ${r.text}`);
    assert.equal(r.json().person, true, `${method} ${url}`);
  }
  // nothing was made or ended: the owner's two links, as they were
  const all = (await request('GET', '/api/shares', { headers: owner })).json().shares as { token: string; label: string }[];
  assert.deepEqual(all.map((s) => s.token).sort(), [...links].sort());
  // the person behind the token still makes one in the app
  const own = await request('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Max’s own' }, headers: member });
  assert.equal(own.status, 200, own.text);
  assert.match(own.json().token, /^[A-Za-z0-9_-]{20,40}$/);
});
