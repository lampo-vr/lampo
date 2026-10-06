// Small hardening from the security review: the LAN cookie can't be read by scripts, an invite made out to an e-mail
// can only be taken by that e-mail, and a client's old notes (from before notes carried their link) never show on
// another client's link.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');

test('the LAN cookie is HttpOnly (a script on the page can’t read the key to the whole store)', async () => {
  const token = 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const { request } = await startApp({ lan: true, token, loadSessions: async () => [] });
  // A phone on the LAN (the forwarding header makes the request count as remote).
  const r = await request('GET', `/api/info?t=${token}`, { headers: { 'X-Forwarded-For': '192.168.1.20' } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie']), /vr_t=[a-f0-9]+;.*HttpOnly/);
});

test('an invite made out to an e-mail can only be accepted with that e-mail', async () => {
  const admin = await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: 'a long password', role: 'owner' });
  const { token } = auth.createInvite({ role: 'reviewer', email: 'mia@example.com', by: { id: admin.id, name: admin.name } });
  // Refused without naming the address it is for (the refusal would tell a leaked link's reader what to type).
  await assert.rejects(
    auth.acceptInvite(token, { name: 'Eve', email: 'eve@example.com', password: 'a long password' }),
    (e: Error) => /another e-mail/.test(e.message) && !e.message.includes('mia@'),
  );
  const mia = (await auth.acceptInvite(token, { name: 'Mia', email: 'MIA@example.com', password: 'a long password' })).user;
  assert.equal(mia.email, 'mia@example.com');
  // Without an e-mail on the invite, any address may take it (as before).
  const open = auth.createInvite({ role: 'reviewer', by: { id: admin.id, name: admin.name } });
  assert.equal((await auth.acceptInvite(open.token, { name: 'Max', email: 'max@example.com', password: 'a long password' })).user.email, 'max@example.com');
});

test('old client notes (no link id) show on a link only when no other link ever covered the video', () => {
  const video = makeVideo(path.join(dir, 'Acme/spot.mp4'), { w: 160, h: 90, dur: 1 });
  age(video);
  store.createOrGetReview(video, { by: 'tester' });
  const slug = path.resolve(video).split('/').join('__');
  store.addComment(slug, { frame: 3, text: 'from before link ids', author: 'guest:Mia' });
  const first = shares.createShare(slug, { label: 'Mia' });
  const seen = (s: ReturnType<typeof shares.createShare>) => shares.visibleNotes(s, must(store.loadReview(slug))).map((c) => c.text);
  assert.deepEqual(seen(first), ['from before link ids'], 'the only link: the note is its own');
  const second = shares.createShare(slug, { label: 'Another client' });
  assert.deepEqual(seen(second), [], 'a second link can’t tell whose it was: hidden');
  assert.deepEqual(seen(first), [], 'and on the first one too, once it’s ambiguous');
  assert.deepEqual(seen(shares.updateShare(second.token, { notes: 'all' }) ?? second), ['from before link ids'], "'all' shows every client note, as before");
});
