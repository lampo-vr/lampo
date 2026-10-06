// A process that stops between YouTube taking the upload and the post keeping the video's id (A12 PUB-2): while the
// cover is being set, a deploy or a crash. The next start must find the upload where it ended — YouTube's session is
// kept until the id is — and never upload the final a second time.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { addConnection, changeConnection } = await import('../../lib/publish/connections.ts');
const posts = await import('../../lib/publish/posts.ts');
const { createPublisher, createAdapters } = await import('../../lib/publish/queue.ts');
const { CHUNK_UNIT } = await import('../../lib/publish/youtube.ts');

const fakes = await startFakePlatforms();
const fakeUrl = new URL(fakes.url);
let thumbAsked = 0;
const hung: http.ServerResponse[] = [];
// YouTube's upload host as a pass-through to the fake, except thumbnails.set, which never answers: the process "stops" there
const proxy = http.createServer((req, res) => {
  if (req.url?.startsWith('/upload/youtube/v3/thumbnails/set')) {
    thumbAsked++;
    req.resume();
    hung.push(res);
    return;
  }
  const out = http.request({ host: fakeUrl.hostname, port: fakeUrl.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode || 500, r.headers);
    r.pipe(res);
  });
  out.on('error', () => res.destroy());
  req.pipe(out);
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const P = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
after(async () => {
  for (const r of hung) r.destroy();
  proxy.closeAllConnections();
  proxy.close();
  await fakes.close();
});
const endpoints = { ...fakes.endpoints, youtubeUpload: `${P}/upload/youtube/v3` };
const adapters = () => createAdapters({ env: { VR_PUBLISH_ENDPOINTS: JSON.stringify(endpoints) }, chunkBytes: CHUNK_UNIT, resumeWaits: [0] });

test('PUB-2: a stop while the cover is set: the next start finds the finished upload, one video on the channel', async () => {
  const file = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 4 });
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  store.setApproval(slug, { status: 'approved' }, 'tester');
  store.setFinal(slug, {}, 'tester');

  // a signed-in YouTube connection (through the fake Google)
  const yt = adapters().youtube;
  const verifier = 'v'.repeat(43);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'http://app.test/api/publish/oauth/callback';
  const consent = await fetch(yt.authUrl({ clientId: fakes.clientId, redirectUri: redirect, state: 's', challenge }), { redirect: 'manual' });
  const code = new URL(String(consent.headers.get('location'))).searchParams.get('code') as string;
  const secret = await yt.exchange({ secret: { client_id: fakes.clientId, client_secret: fakes.clientSecret }, code, redirectUri: redirect, verifier });
  const conn = addConnection({ kind: 'youtube', label: 'Tube', secret, by: 'Olivia' });
  changeConnection(conn.id, { state: 'ready', accounts: [{ id: 'UC_fake_channel', platform: 'youtube', name: 'Studio Channel' }], audited: true });

  const { post } = posts.draftPost({
    slug,
    platform: 'youtube',
    fields: { connection: conn.id, title: 'Spot', ai_generated: false, youtube: { made_for_kids: false }, cover_frame: 10 },
    by: 'agent:writer',
  });
  posts.publishPost(post.id, { confirm: { platform: 'youtube', account: post.account, digest: posts.digestOf(post) }, by: 'Olivia' });

  // the running process: the upload ends, the cover hangs
  fakes.knobs.foreignSession = P; // YouTube names its session on its upload host (here: the pass-through)
  const a = createPublisher({ adapters: adapters(), workspaces: () => ['w1'], log: () => {} });
  void a.tick();
  await until(() => thumbAsked === 1, 'the upload finished and the cover is being set', 20_000);
  assert.equal(fakes.videos.size, 1);
  const mid = posts.findPost(post.id);
  assert.equal(mid?.remote_id, undefined, 'the id isn’t kept yet');
  assert.ok(mid?.session, 'so the session is: it is what finds the upload again');

  // the process stops here; the next one starts and works the post
  const b = createPublisher({ adapters: adapters(), workspaces: () => ['w1'], log: () => {} });
  void b.tick();
  await until(() => thumbAsked === 2, 'the next start set the cover of the same video', 20_000);
  assert.equal(fakes.videos.size, 1, 'the final went up once');
  for (const r of hung) r.destroy();
  await until(() => posts.findPost(post.id)?.state === 'posted', 'posted', 20_000);
  const done = posts.findPost(post.id);
  assert.equal(done?.remote_id, [...fakes.videos.keys()][0]);
  assert.equal(done?.session, undefined, 'the session goes with the id kept');
  await a.stop();
  await b.stop();
});
