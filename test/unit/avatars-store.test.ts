// Profile pictures on the store most machines have: the default one under ~/.video-review, a folder whose name starts
// with a dot. Express's sendFile refuses any path with a dot segment unless told otherwise, so every picture answered
// 404 there while the tests' own stores (no dot anywhere) passed (audit A12, MEDIA-2).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FFMPEG, isolatedEnv, tmpdir } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const home = tmpdir('vr-home-');
const APP = path.join(home, '.video-review');
isolatedEnv({ vars: { VR_DATA: path.join(APP, 'data'), VR_CACHE: path.join(APP, 'cache') } });
const auth = await import('../../lib/auth.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

let server: http.Server;
let request: Request;
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 't', loadSessions: async () => [] })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  request = client((server.address() as AddressInfo).port);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('the owner’s picture is served from a store under a dot folder', async () => {
  const png = path.join(home, 'me.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=300x200', '-frames:v', '1', '-y', png]);
  const put = await request('PUT', '/api/auth/me/avatar', { body: { data: fs.readFileSync(png).toString('base64') } });
  assert.equal(put.status, 200, put.text);
  const file = put.json().user.avatar as string;
  assert.ok(file);
  const people = (await request('GET', '/api/people')).json().people as { avatar: string | null }[];
  const url = people.find((p) => p.avatar)?.avatar as string;
  assert.ok(url, 'the picture is listed');
  const got = await request('GET', url);
  assert.equal(got.status, 200, `${url}: ${got.status} ${got.text.slice(0, 80)}`);
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.ok(auth.listUsers().some((u) => u.avatar === file));
});

// Profile pictures are people's, not a cache: cache/ is disposable and backups leave it out (docs/go-live.md), so on this
// disk they live in data/avatars/, and a store that kept them in cache/avatars/ moves them once (DOCS-16).
test('pictures are kept in data/, and those in the old cache/avatars/ move there once', async () => {
  const { migrateAvatars } = await import('../../lib/avatars.ts');
  const { CACHE, DATA } = await import('../../lib/paths.ts');
  const mine = auth.listUsers().find((u) => u.avatar);
  assert.ok(mine?.avatar);
  assert.ok(fs.existsSync(path.join(DATA, 'avatars', mine.avatar)), 'a new upload lands in data/avatars');
  assert.ok(!fs.existsSync(path.join(CACHE, 'avatars', mine.avatar)));

  // A picture from before: in the cache, named by an account.
  const ada = await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: 'a long password', role: 'member' });
  const old = `${ada.id}-0123abcd.jpg`;
  fs.mkdirSync(path.join(CACHE, 'avatars'), { recursive: true });
  fs.copyFileSync(path.join(DATA, 'avatars', mine.avatar), path.join(CACHE, 'avatars', old));
  auth.setAvatar(ada.id, old);
  assert.equal(migrateAvatars(), 1);
  assert.ok(fs.existsSync(path.join(DATA, 'avatars', old)));
  assert.ok(!fs.existsSync(path.join(CACHE, 'avatars')), 'the old folder is gone');
  assert.equal(migrateAvatars(), 0, 'a second run does nothing');
  const got = await request('GET', `/api/avatars/${old}`);
  assert.equal(got.status, 200, got.text);
});
