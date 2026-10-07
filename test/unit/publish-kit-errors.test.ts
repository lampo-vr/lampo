// A publishing kit that couldn't be made says so by audience: its failure (ffmpeg's output, the store's file paths)
// is the machine's owner's to read and the server log's; a member's API token or browser on a hosted server gets a
// sentence. The render behind the kit is damaged on purpose so the encode fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const { request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });

test('a failed kit names no tool, exit code or path to a member', async () => {
  await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'olivias password 1', role: 'owner' });
  const member = await auth.createUser({ email: 'm@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
  const login = await request('POST', '/api/auth/login', { body: { email: 'o@example.com', password: 'olivias password 1' }, headers: { Origin: PUBLIC } });
  const asOwner = { Cookie: cookieFrom(login), Origin: PUBLIC };
  const asMember = { Authorization: `Bearer ${auth.createToken(member.id, 'agent').token}` };
  const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 144, h: 256, fps: 25, dur: 2 });
  const up = await tusUpload(request, spot, { filename: 'spot.mp4' }, asOwner);
  assert.equal(up.status, 200, up.text);
  const enc = encodeURIComponent(up.json().slug as string);
  assert.equal((await request('PUT', `/api/review/${enc}/approval`, { body: { status: 'approved', v: 1 }, headers: asOwner })).status, 200);
  assert.equal((await request('PUT', `/api/review/${enc}/final`, { body: { v: 1, confirm: true }, headers: asOwner })).status, 200);
  const draft = await request('POST', `/api/review/${enc}/posts`, { body: { platform: 'youtube', title: 't' }, headers: asMember });
  assert.ok(draft.status < 300, draft.text);
  const id = draft.json().id as string;
  // every stored copy of V1 damaged (the store's own, never the render it came from)
  const walk = (p: string): string[] =>
    fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
  const copies = walk(dir).filter((f) => /^v1\.\w+$/.test(path.basename(f)) && !f.includes(`${path.sep}renders${path.sep}`));
  assert.ok(copies.length, 'the stored V1');
  for (const f of copies) fs.writeFileSync(f, Buffer.alloc(4096, 7));
  const made = await request('POST', `/api/posts/${id}/kit`, { headers: asMember });
  assert.equal(made.status, 202, made.text);
  const kit = await until(async () => {
    const k = (await request('GET', `/api/posts/${id}/kit`, { headers: asMember })).json() as { state: string; error?: string };
    return k.state === 'failed' || k.state === 'ready' ? k : null;
  }, 'the kit ends');
  assert.equal(kit.state, 'failed');
  assert.ok(kit.error, 'a sentence');
  for (const secret of [dir, 'ffmpeg', 'exited', 'versions/', 'moov']) assert.ok(!kit.error.includes(secret), `names ${JSON.stringify(secret)}: ${kit.error}`);
  // the person in the browser reads the same sentence
  const seen = (await request('GET', `/api/posts/${id}/kit`, { headers: asOwner })).json() as { error?: string };
  assert.equal(seen.error, kit.error);
});
