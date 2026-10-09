// YouTube's verdict after an upload it took: the real YouTube adapter and the real publish queue against the fake
// platforms (test/lib/fakePlatforms.ts — no network), with the queue's own clock. A video YouTube rejects or can't
// process after the upload fails its post — posted or scheduled — with the reason, the video's id kept (Retry asks
// YouTube again, it never uploads a second time) and the post in the inbox; nothing looks at it again by itself. A
// video gone from the channel keeps where its post stood: someone may have deleted it there.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Post } from '../../lib/types.ts';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { addConnection, changeConnection } = await import('../../lib/publish/connections.ts');
const posts = await import('../../lib/publish/posts.ts');
const { createPublisher, createAdapters } = await import('../../lib/publish/queue.ts');
const { createYouTube, CHUNK_UNIT } = await import('../../lib/publish/youtube.ts');
const { endpointsFrom } = await import('../../lib/publish/net.ts');
const { PublishError } = await import('../../lib/publish/adapter.ts');

const fakes = await startFakePlatforms();
after(() => fakes.close());
const adapters = () => createAdapters({ env: { VR_PUBLISH_ENDPOINTS: JSON.stringify(fakes.endpoints) }, chunkBytes: CHUNK_UNIT, resumeWaits: [0] });

const redirect = 'http://app.test/api/publish/oauth/callback';
async function secretOf() {
  const yt = adapters().youtube;
  const verifier = 'v'.repeat(43);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consent = await fetch(yt.authUrl({ clientId: fakes.clientId, redirectUri: redirect, state: 's', challenge }), { redirect: 'manual' });
  const code = new URL(String(consent.headers.get('location'))).searchParams.get('code') as string;
  return yt.exchange({ secret: { client_id: fakes.clientId, client_secret: fakes.clientSecret }, code, redirectUri: redirect, verifier });
}
const conn = addConnection({ kind: 'youtube', label: 'Tube', secret: await secretOf(), by: 'Olivia' });
changeConnection(conn.id, { state: 'ready', accounts: [{ id: 'UC_fake_channel', platform: 'youtube', name: 'Studio Channel' }], audited: true });

let n = 0;
/** A final video with a YouTube post a person published. */
function published(fields: Record<string, unknown> = {}) {
  const file = makeVideo(path.join(dir, `renders/spot-${++n}.mp4`), { w: 160, h: 90, fps: 25, dur: 2, freq: 400 + n * 50 });
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  store.setApproval(slug, { status: 'approved' }, 'tester');
  store.setFinal(slug, {}, 'tester');
  const { post } = posts.draftPost({
    slug,
    platform: 'youtube',
    fields: { connection: conn.id, title: 'Spot', visibility: 'public', ai_generated: false, youtube: { made_for_kids: false }, ...fields },
    by: 'agent:writer',
  });
  return posts.publishPost(post.id, { confirm: { platform: 'youtube', account: post.account, digest: posts.digestOf(post) }, by: 'Olivia' });
}
const now = (id: string) => posts.findPost(id) as NonNullable<ReturnType<typeof posts.findPost>>;
const inInbox = (id: string) => posts.failedPosts().some((x) => x.post.id === id);
const looksAt = (remote: string) => fakes.seen.filter((s) => s.method === 'GET' && s.path.startsWith('/youtube/v3/videos') && s.path.includes(remote)).length;
const uploads = () => fakes.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/upload/youtube/v3/videos')).length;

let clock = Date.now();
const queue = createPublisher({ adapters: adapters(), now: () => clock, workspaces: () => ['w1'], log: () => {} });
// the store writes real times (published_at, next_try): the queue's clock never runs behind them
const tick = async () => {
  clock = Math.max(clock, Date.now());
  await queue.tick();
  await queue.idle();
};

test('the adapter: rejected or failed processing is YouTube’s verdict on the video it holds (its id); gone is not', async () => {
  const { endpoints, named } = endpointsFrom(fakes.env as NodeJS.ProcessEnv);
  const yt = createYouTube({ endpoints, net: { named } });
  const secret = await secretOf();
  const p = published();
  await tick();
  const id = String(now(p.id).remote_id);
  const v = fakes.videos.get(id);
  assert.ok(v);
  const asked = { ...now(p.id) } as Post;
  Object.assign(v.status, { uploadStatus: 'rejected', rejectionReason: 'duplicate' });
  await assert.rejects(
    yt.status(asked, secret, () => {}),
    (e: InstanceType<typeof PublishError>) => e.remoteId === id && /rejected the video \(duplicate\)/.test(e.message),
  );
  Object.assign(v.status, { uploadStatus: 'failed', failureReason: 'codec' });
  await assert.rejects(
    yt.status(asked, secret, () => {}),
    (e: InstanceType<typeof PublishError>) => e.remoteId === id && /couldn’t process the video/.test(e.message),
  );
  fakes.videos.delete(id);
  await assert.rejects(
    yt.status(asked, secret, () => {}),
    (e: InstanceType<typeof PublishError>) => e.remoteId === undefined && /gone from YouTube/.test(e.message),
  );
});

test('posted, then rejected: the look after the upload fails the post with the reason, keeps the id, and Retry only asks', async () => {
  const p = published();
  await tick();
  const sent = now(p.id);
  assert.equal(sent.state, 'posted');
  const id = String(sent.remote_id);
  Object.assign(fakes.videos.get(id)?.status ?? {}, { uploadStatus: 'rejected', rejectionReason: 'duplicate' });
  const ups = uploads();
  clock += 61e3; // the first lock look
  await tick();
  const s = now(p.id);
  assert.equal(s.state, 'failed', 'not posted: YouTube said no');
  assert.equal(s.error, 'YouTube rejected the video (duplicate).');
  assert.equal(s.remote_id, id, 'what YouTube holds is remembered');
  assert.ok(inInbox(p.id), 'a person hears it in the inbox');
  const ev = store.readEvents({ limit: 50 }).filter((e) => e.type === 'post' && e.post?.id === p.id);
  assert.equal(ev.at(-1)?.post?.state, 'failed');
  const looks = looksAt(id);
  clock += 2 * 3600e3; // past every look an upload gets (and short of the six hours a Retry waits for an answer)
  await tick();
  assert.equal(looksAt(id), looks, 'nothing asks again by itself');
  // Retry asks YouTube where it stands; it still says rejected: failed again, never a second upload
  posts.retryPost(p.id, 'Olivia');
  await tick();
  assert.equal(now(p.id).state, 'failed');
  assert.equal(looksAt(id), looks + 1);
  assert.equal(uploads(), ups, 'never uploaded a second time');
});

test('scheduled, then rejected: the look after its time fails the post, and it isn’t looked at every five minutes for good', async () => {
  const at = new Date(clock + 3 * 3600e3).toISOString();
  const p = published({ schedule_at: at });
  await tick();
  const sent = now(p.id);
  assert.equal(sent.state, 'scheduled');
  const id = String(sent.remote_id);
  Object.assign(fakes.videos.get(id)?.status ?? {}, { uploadStatus: 'failed', failureReason: 'codec' });
  clock = Date.parse(at) + 2 * 60e3;
  await tick();
  const s = now(p.id);
  assert.equal(s.state, 'failed');
  assert.match(String(s.error), /^YouTube couldn’t process the video/);
  assert.equal(s.remote_id, id);
  assert.ok(inInbox(p.id));
  const looks = looksAt(id);
  for (let i = 0; i < 4; i++) {
    clock += 5 * 60e3 + 1e3;
    await tick();
  }
  assert.equal(looksAt(id), looks, 'no more looks');
});

test('posted, then gone from the channel: it stays posted (a deletion there is someone’s choice), said once', async () => {
  const p = published();
  await tick();
  const id = String(now(p.id).remote_id);
  fakes.videos.delete(id);
  clock += 61e3;
  await tick();
  const s = now(p.id);
  assert.equal(s.state, 'posted');
  assert.ok(!inInbox(p.id));
  assert.match(String(s.history.at(-1)?.note), /gone from YouTube/);
});
