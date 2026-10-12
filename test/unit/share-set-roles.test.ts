// Who may make a link for a chosen set of videos (POST /api/set-shares): whoever may share (`share`: owners, admins,
// members) — a person in the app, never an API token (PERSON_ONLY: a link lets whoever holds it act as the client);
// reviewers may not. On a hosted server, as its people meet it. An API token lists such a link like any other: without
// its token.
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
let server: http.Server;
let request: Request;
const as: Record<string, Record<string, string>> = {};
const slugs: string[] = [];

async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0], ...origin };
}

before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port, { Host: 'review.test' });
  for (const [name, role] of [
    ['olivia', 'owner'],
    ['ada', 'admin'],
    ['max', 'member'],
    ['rita', 'reviewer'],
  ] as const) {
    await auth.createUser({ email: `${name}@example.com`, name, password: PASSWORD, role });
    as[name] = await signIn(`${name}@example.com`);
  }
  const made = await request('POST', '/api/auth/tokens', { body: { name: 'agent' }, headers: as.olivia as Record<string, string> });
  assert.equal(made.status, 200, made.text);
  as.token = { Authorization: `Bearer ${made.json().token}` };
  for (const name of ['intro', 'outro']) {
    const clip = makeVideo(path.join(dir, 'up', `${name}.mp4`), { dur: 1 });
    age(clip);
    const up = await tusUpload(request, clip, { filename: `${name}.mp4`, folder: 'Reels' }, as.token as Record<string, string>);
    assert.equal(up.status, 200, up.text);
    slugs.push(up.json().slug);
  }
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('owners, admins and members make one in the app; a reviewer can’t; an API token never, whoever’s it is', async () => {
  const make = (who: string) => request('POST', '/api/set-shares', { body: { slugs, label: `from ${who}` }, headers: as[who] as Record<string, string> });
  for (const who of ['olivia', 'ada', 'max']) {
    const r = await make(who);
    assert.equal(r.status, 200, `${who}: ${r.text}`);
    assert.equal(r.json().kind, 'set');
    assert.ok(r.json().token, `${who}: the link just made carries its token`);
  }
  const reviewer = await make('rita');
  assert.equal(reviewer.status, 403, reviewer.text);
  const token = await make('token');
  assert.equal(token.status, 403, token.text);
  assert.equal(token.json().person, true, 'a person’s act');
  // an API token lists them like every link: never with a token
  const listed = await request('GET', '/api/shares', { headers: as.token as Record<string, string> });
  assert.equal(listed.status, 200, listed.text);
  const sets = (listed.json().shares as { kind: string; token?: string }[]).filter((s) => s.kind === 'set');
  assert.equal(sets.length, 3);
  for (const s of sets) assert.equal(s.token, undefined);
});
