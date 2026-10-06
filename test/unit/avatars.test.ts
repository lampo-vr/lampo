// Profile pictures (lib/avatars.ts): an uploaded picture is checked like any file from outside, cut to its centre
// square and kept as a 256 px JPEG through the storage adapter; the account names the file; a new picture replaces the
// old one; the team's pictures are served to signed-in people only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const auth = await import('../../lib/auth.ts');
const { AVATAR_FILE, avatarKey, removeAvatar, saveAvatar } = await import('../../lib/avatars.ts');
const { probe } = await import('../../lib/probe.ts');
const { storage } = await import('../../lib/storage/index.ts');

const picture = (name: string, w: number, h: number, color = 'orange') => {
  const file = path.join(dir, name);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-frames:v', '1', '-y', file]);
  return file;
};
const stored = (file: string) => storage().localPath(avatarKey(file));

const { base } = await startApp({ token: 't', loadSessions: async () => [] });

test('a wide picture becomes a 256 px square JPEG; a new one replaces the old; removing brings back initials', async () => {
  const sam = await auth.createUser({ email: 'sam@example.com', name: 'Sam', password: 'correct horse battery', role: 'member' });
  const first = await saveAvatar(sam.id, picture('wide.png', 800, 400));
  assert.match(first.avatar ?? '', AVATAR_FILE);
  const meta = await probe(stored(first.avatar as string));
  assert.deepEqual([meta.width, meta.height, meta.codec], [256, 256, 'mjpeg']);
  const second = await saveAvatar(sam.id, picture('tall.jpg', 300, 900, 'blue'));
  assert.notEqual(second.avatar, first.avatar, 'a new picture, a new name (no stale copies)');
  assert.ok(!fs.existsSync(stored(first.avatar as string)), 'the old picture is gone');
  const cleared = await removeAvatar(sam.id);
  assert.equal(cleared.avatar, undefined);
  assert.ok(!fs.existsSync(stored(second.avatar as string)));
});

test('only still pictures: a video, a text file or an absurd size are refused, and nothing is stored', async () => {
  const kim = await auth.createUser({ email: 'kim@example.com', name: 'Kim', password: 'correct horse battery', role: 'member' });
  const video = makeVideo(path.join(dir, 'clip.mp4'), { dur: 1 });
  await assert.rejects(saveAvatar(kim.id, video), /one still picture/);
  const text = path.join(dir, 'note.txt');
  fs.writeFileSync(text, 'not a picture');
  await assert.rejects(saveAvatar(kim.id, text), /not a picture/);
  await assert.rejects(saveAvatar(kim.id, picture('huge.png', 9000, 10)), /between 1 and 8192 px/);
  assert.equal(auth.getUser(kim.id)?.avatar, undefined);
});

test('API: set your own picture, the team sees it beside notes, signed-out nobody does', async () => {
  const data = fs.readFileSync(picture('me.png', 120, 120, 'green')).toString('base64');
  // On the machine itself the owner is signed in without a password (one app).
  const put = await fetch(`${base}/api/auth/me/avatar`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
  assert.equal(put.status, 200);
  const { user } = (await put.json()) as { user: { name: string; avatar: string } };
  assert.match(user.avatar, AVATAR_FILE);
  const { people } = (await (await fetch(`${base}/api/people`)).json()) as { people: { name: string; avatar: string | null }[] };
  const mine = people.find((p) => p.name === user.name);
  assert.equal(mine?.avatar, `/api/avatars/${user.avatar}`);
  const img = await fetch(`${base}${mine?.avatar}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  // Through a proxy (not the machine itself) and without a session: sign in first.
  const outside = await fetch(`${base}${mine?.avatar}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(outside.status, 401);
  // Not an account's picture: nothing, whatever the name looks like.
  assert.equal((await fetch(`${base}/api/avatars/u_000000000000-00000000.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/api/avatars/..%2Fusers.json`)).status, 404);
  const bad = await fetch(`${base}/api/auth/me/avatar`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: 'bm90IGEgcGljdHVyZQ==' }),
  });
  assert.equal(bad.status, 400);
  const del = await fetch(`${base}/api/auth/me/avatar`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(((await del.json()) as { user: { avatar?: string } }).user.avatar, undefined);
});
