// Publishing's edges on a hosted server, from the delta review (A12 PUB-5, PUB-6, …): the plan's gate on Retry, what
// an agent's token may change or delete (drafts only; a post that went out is never deleted), and more below.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { PostView } from '../../lib/types.ts';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const fakes = await startFakePlatforms();
const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, ...fakes.env } });
const { startApp } = await import('../lib/app.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const ext = await import('../../server/extension.ts');
const auth = await import('../../lib/auth.ts');
const { addConnection, changeConnection } = await import('../../lib/publish/connections.ts');
const posts = await import('../../lib/publish/posts.ts');

// a plan module that refuses publishing
const MODULE = path.join(dir, 'cloud-module.ts');
fs.writeFileSync(
  MODULE,
  `export default async () => ({
  name: 'stand-in',
  entitlements: {
    get: async () => ({ plan: 'free', usage: {} }),
    canUpload: async () => ({ ok: true }), canAddMember: async () => ({ ok: true }), canAddVideo: async () => ({ ok: true }), canShare: async () => ({ ok: true }),
    canPublish: async () => ({ ok: false, reason: 'plan', message: 'Publishing is on the Team plan.' }),
  },
  routes: [],
});
`,
);
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const host = ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) });
const locked = await ext.loadExtension(host, { ...process.env, VR_CLOUD_MODULE: MODULE });
const { request } = await startApp({ ctx, headers: { Connection: 'close', Host: 'review.test' } });
// the queue and the fake platforms keep the process alive: without this the file never ends under `npm test`
after(async () => {
  await ctx.publisher.stop();
  await fakes.close();
});
const enc = encodeURIComponent;
const as: Record<string, Record<string, string>> = {};
let slug = '';
let connId = '';

before(async () => {
  for (const [name, role] of [
    ['olivia', 'owner'],
    ['max', 'member'],
  ] as const) {
    const u = await auth.createUser({ email: `${name}@example.com`, name, password: `${name}s password 1`, role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    as[`${name}Agent`] = { Authorization: `Bearer ${auth.createToken(u.id, `${name} agent`).token}` };
  }
  const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 144, h: 256, fps: 25, dur: 4 });
  slug = (await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Brand' }, as.olivia)).json().slug;
  assert.equal((await request('PUT', `/api/review/${enc(slug)}/approval`, { body: { status: 'approved', v: 1 }, headers: as.olivia })).status, 200);
  assert.equal((await request('PUT', `/api/review/${enc(slug)}/final`, { body: { v: 1 }, headers: as.olivia })).status, 200);
  const c = addConnection({ kind: 'zernio', label: 'Social', secret: { api_key: fakes.apiKey }, by: 'olivia' });
  changeConnection(c.id, {
    state: 'ready',
    accounts: [
      { id: 'acc_ig_1', platform: 'instagram', name: 'Studio Reels' },
      { id: 'acc_fb_1', platform: 'facebook', name: 'Page' },
    ],
  });
  connId = c.id;
});

/** A post of the platform as the queue would have left it. */
async function postIn(platform: 'instagram' | 'facebook' | 'youtube', state: 'failed' | 'cancelled', o: { remote?: string } = {}): Promise<string> {
  const d = await request('POST', `/api/review/${enc(slug)}/posts`, { body: { platform, connection: connId, ai_generated: false }, headers: as.olivia });
  assert.ok(d.status === 201 || d.status === 200, d.text);
  const id = d.json().id as string;
  posts.changePost(id, (p) => {
    p.state = state;
    p.error = 'It failed.';
    if (o.remote) p.remote_id = o.remote;
    else delete p.remote_id;
  });
  return id;
}

test('PUB-5: the plan’s gate holds Retry as it holds Publish', async () => {
  const id = await postIn('facebook', 'failed');
  ctx.extension = locked;
  try {
    const retry = await request('POST', `/api/posts/${id}/retry`, { headers: as.olivia });
    assert.equal(retry.status, 402, retry.text);
    assert.equal(posts.findPost(id)?.state, 'failed', 'nothing queued');
  } finally {
    ctx.extension = ext.NO_EXTENSION;
  }
});

test('PUB-6: an agent’s token changes and deletes drafts only; a failed or cancelled post is a person’s; one that went out is never deleted', async () => {
  const failed = await postIn('instagram', 'failed');
  // an agent turning the failed post back into a draft would take it out of its owner's inbox
  const redraft = await request('PATCH', `/api/posts/${failed}`, { body: { description: 'x' }, headers: as.maxAgent });
  assert.equal(redraft.status, 403, redraft.text);
  const viaDraft = await request('POST', `/api/review/${enc(slug)}/posts`, { body: { platform: 'instagram', description: 'y' }, headers: as.maxAgent });
  assert.equal(viaDraft.status, 403, viaDraft.text);
  const del = await request('DELETE', `/api/posts/${failed}`, { headers: as.maxAgent });
  assert.equal(del.status, 403, del.text);
  assert.equal(posts.findPost(failed)?.state, 'failed', 'still there, still failed');
  // a person may
  assert.equal((await request('PATCH', `/api/posts/${failed}`, { body: { description: 'z' }, headers: as.max })).status, 200);
  assert.equal((await request('DELETE', `/api/posts/${failed}`, { headers: as.max })).status, 200);
  // a post the platform holds is never deleted, by anyone
  const live = await postIn('facebook', 'cancelled', { remote: 'zp_live_1' });
  const gone = await request('DELETE', `/api/posts/${live}`, { headers: as.olivia });
  assert.equal(gone.status, 409, gone.text);
  assert.ok(posts.findPost(live), 'kept: it is history');
  // an agent still drafts and deletes its drafts
  const yt = await request('POST', `/api/review/${enc(slug)}/posts`, { body: { platform: 'youtube', title: 'T' }, headers: as.maxAgent });
  assert.equal(yt.status, 201, yt.text);
  const ytId = (yt.json() as PostView).id;
  assert.equal((await request('PATCH', `/api/posts/${ytId}`, { body: { title: 'T2' }, headers: as.maxAgent })).status, 200);
  assert.equal((await request('DELETE', `/api/posts/${ytId}`, { headers: as.maxAgent })).status, 200);
});

/** Another final video in the same folder (its own slug), uploaded by Olivia. */
async function finalUpload(name: string): Promise<string> {
  const f = makeVideo(path.join(dir, `renders/${name}`), { w: 144, h: 256, fps: 25, dur: 4, freq: 500 + name.length * 13 });
  const s = (await tusUpload(request, f, { filename: name, folder: 'Brand' }, as.olivia)).json().slug as string;
  assert.equal((await request('PUT', `/api/review/${enc(s)}/approval`, { body: { status: 'approved', v: 1 }, headers: as.olivia })).status, 200);
  assert.equal((await request('PUT', `/api/review/${enc(s)}/final`, { body: { v: 1 }, headers: as.olivia })).status, 200);
  return s;
}

test('PUB-7: a deleted video’s kit is no longer served, and its posts don’t attach to a later video of the same name', async () => {
  const teaser = await finalUpload('teaser.mp4');
  const id = (await request('POST', `/api/review/${enc(teaser)}/posts`, { body: { platform: 'ig', cover_frame: 12 }, headers: as.maxAgent })).json().id;
  await request('POST', `/api/posts/${id}/kit`, { headers: as.maxAgent });
  let kit: { state: string; files: { name: string; kind: string }[] } = { state: 'none', files: [] };
  for (let i = 0; i < 600 && kit.state !== 'ready'; i++) {
    kit = (await request('GET', `/api/posts/${id}/kit`, { headers: as.maxAgent })).json();
    if (kit.state !== 'ready') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(kit.state, 'ready', JSON.stringify(kit));
  const video = kit.files.find((f) => f.kind === 'video')?.name as string;
  assert.equal((await request('GET', `/api/posts/${id}/kit/${enc(video)}`, { headers: as.maxAgent })).status, 200);
  const del = await request('DELETE', `/api/library/${enc(teaser)}`, { headers: as.olivia });
  assert.equal(del.status, 200, del.text);
  for (const u of [`/api/posts/${id}/kit/${enc(video)}`, `/api/posts/${id}/kit/kit.zip`, `/api/posts/${id}/cover.jpg`]) {
    const r = await request('GET', u, { headers: as.maxAgent });
    assert.equal(r.status, 404, `${u} after the video was deleted: ${r.status}`);
  }
  // a new video under the same name and folder: the old post is the old video's, not this one's
  const again = await finalUpload('teaser.mp4');
  assert.equal(again, teaser, 'the same slug');
  const listed = (await request('GET', `/api/review/${enc(again)}/posts`, { headers: as.olivia })).json().posts as PostView[];
  assert.ok(!listed.some((p) => p.id === id), 'the orphan isn’t listed with the new video');
  const fresh = await request('POST', `/api/review/${enc(again)}/posts`, { body: { platform: 'ig' }, headers: as.maxAgent });
  assert.equal(fresh.status, 201, `a new post for the new video, not the orphan changed: ${fresh.text}`);
  assert.notEqual(fresh.json().id, id);
});

test('PUB-9: the cover frame is held inside the version, and one cover is kept per post', async () => {
  const yt = (await request('POST', `/api/review/${enc(slug)}/posts`, { body: { platform: 'youtube', title: 'Covers' }, headers: as.maxAgent })).json()
    .id as string;
  // past any video's length the API refuses the number itself (lib/inputs.ts, A12 PUB-13)
  assert.equal((await request('PATCH', `/api/posts/${yt}`, { body: { cover_frame: 2 ** 52 }, headers: as.maxAgent })).status, 400);
  for (const f of [1, 2, 3, 99, 100000, 10_000_000]) {
    const r = await request('PATCH', `/api/posts/${yt}`, { body: { cover_frame: f }, headers: as.maxAgent });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json().cover_frame <= 99, `frame ${f} kept as ${r.json().cover_frame}: the version has 100 frames`);
    assert.equal((await request('GET', `/api/posts/${yt}/cover.jpg`, { headers: as.max })).status, 200);
  }
  const { kitDir } = await import('../../lib/publish/kit.ts');
  const jpegs = fs.readdirSync(kitDir(yt)).filter((f) => f.endsWith('.jpg'));
  assert.equal(jpegs.length, 1, `one cover kept: ${jpegs.join(', ')}`);
});

// last in the file: it spends the workspace's checks
test('PUB-16: adding a posting-API key, or changing one, asks the platform and counts against the checks’ limit', async () => {
  const c = addConnection({ kind: 'zernio', label: 'Checked', secret: { api_key: fakes.apiKey }, by: 'olivia' });
  let checks = 0;
  for (; checks < 40; checks++) {
    const r = await request('POST', `/api/publish/connections/${c.id}/check`, { headers: as.olivia });
    if (r.status === 429) break;
    assert.equal(r.status, 200, r.text);
  }
  assert.ok(checks > 0 && checks < 40, `the checks have a limit (${checks})`);
  const seen = fakes.seen.length;
  const renew = await request('PATCH', `/api/publish/connections/${c.id}`, { body: { api_key: fakes.apiKey }, headers: as.olivia });
  assert.equal(renew.status, 429, renew.text);
  const add = await request('POST', '/api/publish/connections', { body: { kind: 'zernio', api_key: fakes.apiKey }, headers: as.olivia });
  assert.equal(add.status, 429, add.text);
  assert.equal(fakes.seen.length, seen, 'the platform wasn’t asked');
  assert.ok(
    !(await request('GET', '/api/publish/connections', { headers: as.olivia })).json().connections.some((x: { label: string }) => x.label === 'Zernio'),
  );
  // a label is no question to the platform
  assert.equal((await request('PATCH', `/api/publish/connections/${c.id}`, { body: { label: 'Renamed' }, headers: as.olivia })).status, 200);
});
