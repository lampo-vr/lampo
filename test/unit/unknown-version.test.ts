// A version nobody has is an error, the same over HTTP as on the machine (A12 INV-6). The API used to take an unknown
// `v` for the newest version: `vr note --v 5` against a server with only V1 recorded the note on V1 without a word,
// while the same call on the machine said "no v5". In a frame-exact tool a note, a render source or a transcript must
// land on the version it names, or nowhere.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { createRemoteBackend } = await import('../../lib/backend/remote.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const app = createApp(ctx);
let server: http.Server;
let port = 0;
let request: Request;
let token = '';
let slug = '';

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  token = auth.createToken(owner.id, 'agent').token;
  request = client(port, { Host: 'review.test', Authorization: `Bearer ${token}` });
  const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Spots' });
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('INV-6: a note on a version the video doesn’t have is refused, and nothing lands on another version', async () => {
  const before = store.loadReview(slug)?.comments.length;
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { v: 5, frame: 0, text: 'on V5' } });
  assert.equal(r.status, 404, r.text);
  assert.match(r.json().error, /no v5/);
  assert.equal(store.loadReview(slug)?.comments.length, before, 'no note anywhere');
  // the version it has, and none named: the newest, as always
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { v: 1, frame: 0, text: 'on V1' } })).status, 200);
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 0, text: 'newest' } })).status, 200);
});

test('INV-6: every route that takes a version answers an unknown one with 404', async () => {
  const s = encodeURIComponent(slug);
  for (const url of [
    `/media/${s}/v9`,
    `/api/waveform/${s}/9`,
    `/api/review/${s}/frame?v=9&frame=0`,
    `/api/review/${s}/transcript?v=9`,
    `/api/review/${s}/part?v=9&in=0`,
  ]) {
    const r = await request('GET', url);
    assert.equal(r.status, 404, `${url}: ${r.status} ${r.text}`);
  }
  assert.equal((await request('GET', `/api/waveform/${s}/1`)).status, 200);
});

test('INV-6: vr against a server says what it says on the machine', async () => {
  const note = { v: 5, frame: 0, range: null, text: 'on V5', tags: [], severity: 'should' as const, drawing: [], author: 'agent:x' };
  const remote = createRemoteBackend({ server: `http://127.0.0.1:${port}`, token }, { cacheRoot: tmpdir() });
  await assert.rejects(remote.addNote(slug, note), /no v5/);
  const { createLocalBackend } = await import('../../lib/backend/local.ts');
  await assert.rejects(createLocalBackend().addNote(slug, note), /no v5/);
});
