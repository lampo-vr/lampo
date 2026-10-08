// The publish queue (lib/publish/queue.ts) with stand-in platforms and its own clock: a post Lampo sends at its time,
// passing failures tried again with growing waits and then given up with the reason, a connection whose sign-in no
// longer works, a final reopened before the time (the post pauses), a platform still working on a post, an upload cut
// off by a restart resumed with its kept session, YouTube's schedule looked at after its time, the private lock found
// on the look after an upload, and taking back what waits or what a platform holds.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { Post, PublishAccount } from '../../lib/types.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { addConnection, changeConnection, findConnection } = await import('../../lib/publish/connections.ts');
const posts = await import('../../lib/publish/posts.ts');
const { createPublisher } = await import('../../lib/publish/queue.ts');
const { PublishError } = await import('../../lib/publish/adapter.ts');
const { seal } = await import('../../lib/publish/seal.ts');
type Adapter = import('../../lib/publish/adapter.ts').Adapter;
type Outcome = import('../../lib/publish/adapter.ts').Outcome;
type PublishTarget = import('../../lib/publish/adapter.ts').PublishTarget;

/** A video of its own for each case, approved and final (one post per platform per final version). */
let n = 0;
function finalVideo(): string {
  const file = makeVideo(path.join(dir, `renders/reel-${++n}.mp4`), { w: 108, h: 192, fps: 25, dur: 4, freq: 300 + n * 40 });
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  store.setApproval(slug, { status: 'approved' }, 'tester');
  store.setFinal(slug, {}, 'tester');
  return slug;
}

/** A platform that answers what the test queues, and records what it was sent. */
function standIn(kind: 'youtube' | 'zernio') {
  const sent: PublishTarget[] = [];
  const looked: string[] = [];
  const answers: (Outcome | Error)[] = [];
  /** What a look at a post answers, by post id (else: out). */
  const looks = new Map<string, Outcome | Error>();
  const adapter: Adapter = {
    kind,
    accounts: async () => [],
    async publish(t) {
      sent.push(t);
      const a = answers.shift() ?? { state: 'posted', remote_id: `r${sent.length}`, url: `https://${kind}.example/${sent.length}` };
      // an error marked `committed` stands for an answer lost after the call that makes the post went out; one with a
      // `session` kept an upload session first (YouTube's, which can find the upload again)
      const said = a as Error & { committed?: boolean; session?: { url: string; total: number } };
      if (a instanceof Error && said.session) t.keepSession(said.session);
      if (a instanceof Error && said.committed) t.committing();
      if (a instanceof Error) throw a;
      return a;
    },
    async status(p) {
      looked.push(p.id);
      const a = looks.get(p.id) ?? { state: 'posted', remote_id: String(p.remote_id), url: p.url ?? 'https://x.example/done' };
      looks.delete(p.id);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { adapter, sent, looked, answers, looks };
}

const yt = standIn('youtube');
const zn = standIn('zernio');
let clock = Date.now();
const changed: string[] = [];
const options = { now: () => clock, backoff: [1000, 5000], maxAttempts: 3, workspaces: () => ['w1'], log: () => {} };
const publisher = createPublisher({ adapters: { youtube: yt.adapter as never, zernio: zn.adapter }, changed: (s) => changed.push(s), ...options });
const run = async () => {
  await publisher.tick();
  await publisher.idle();
};

const account = (id: string, platform: PublishAccount['platform']): PublishAccount => ({ id, platform, name: `${platform} account` });
const social = addConnection({ kind: 'zernio', label: 'Social', secret: { api_key: 'test-key-0123456789' }, by: 'tester' });
changeConnection(social.id, { state: 'ready', accounts: [account('ig1', 'instagram'), account('fb1', 'facebook')] });
const tube = addConnection({
  kind: 'youtube',
  label: 'Tube',
  secret: { client_id: 'client-1234567890', client_secret: 'secret-1234567890', refresh_token: 'rt' },
  by: 'tester',
});
changeConnection(tube.id, { state: 'ready', accounts: [account('UC1', 'youtube')], audited: true });

/** What a person confirms: the platform, the account and the digest of the post as they saw it (PUB-3). */
const confirmOf = (p: Post) => ({ platform: p.platform, account: p.account, digest: posts.digestOf(p) });

/** A draft for the platform on a video, published by a person (the post as stored). */
function published(slug: string, platform: Post['platform'], fields: Record<string, unknown> = {}) {
  const connection = platform === 'youtube' ? tube.id : social.id;
  const kids = platform === 'youtube' ? { youtube: { made_for_kids: false } } : {};
  const { post } = posts.draftPost({ slug, platform, fields: { connection, ai_generated: false, ...kids, ...fields }, by: 'tester' });
  return posts.publishPost(post.id, { confirm: confirmOf(post), by: 'tester' });
}
const now = (id: string) => posts.findPost(id) as NonNullable<ReturnType<typeof posts.findPost>>;

test('a post Lampo sends at its time waits for it, then goes; the file is the final’s', async () => {
  const slug = finalVideo();
  const at = new Date(clock + 3600e3).toISOString();
  const p = published(slug, 'instagram', { schedule_at: at });
  assert.equal(p.next_try, at, 'due at its time, not now');
  await run();
  assert.equal(zn.sent.length, 0, 'not before its time');
  clock += 3600e3;
  await run();
  assert.equal(zn.sent.length, 1);
  assert.equal(zn.sent[0]?.post.id, p.id);
  assert.equal(zn.sent[0]?.key, `lampo-${p.id}-1`);
  assert.equal(now(p.id).state, 'posted');
  assert.equal(now(p.id).file?.kind, 'final', 'a small H.264/AAC MP4 goes as it is');
  assert.ok(changed.includes(slug), 'the browsers were told');
});

test('passing failures are tried again after growing waits, then the post fails with the platform’s reason', async () => {
  const slug = finalVideo();
  zn.answers.push(new PublishError('the connection to the platform dropped', { transient: true }));
  const p = published(slug, 'facebook');
  await run();
  let s = now(p.id);
  assert.equal(s.state, 'queued');
  assert.equal(s.attempts, 1);
  assert.equal(Date.parse(s.next_try as string), clock + 1000);
  assert.match(String(s.error), /dropped/);
  const sent = zn.sent.length;
  await run();
  assert.equal(zn.sent.length, sent, 'not before the wait is over');
  clock += 1000;
  zn.answers.push(new PublishError('Zernio had a problem (502): Lampo tries again', { transient: true }));
  await run();
  s = now(p.id);
  assert.equal(s.attempts, 2);
  assert.equal(Date.parse(s.next_try as string), clock + 5000);
  clock += 5000;
  zn.answers.push(new PublishError('Zernio had a problem (502): Lampo tries again', { transient: true }));
  await run();
  s = now(p.id);
  assert.equal(s.state, 'failed', 'three tries is all');
  assert.equal(s.error, 'Zernio had a problem (502): Lampo tries again.');
  const ev = store.readEvents({ limit: 50 }).filter((e) => e.type === 'post' && e.post?.id === p.id);
  assert.equal(ev.at(-1)?.post?.state, 'failed');
  assert.equal(ev.at(-1)?.post?.error, 'Zernio had a problem (502): Lampo tries again.');
  // a person tries again: a new round, a new key
  posts.retryPost(p.id, 'tester');
  await run();
  assert.equal(now(p.id).state, 'posted');
  assert.equal(zn.sent.at(-1)?.key, `lampo-${p.id}-2`);
});

test('a sign-in that no longer works fails the post and marks the connection, without trying again', async () => {
  const slug = finalVideo();
  yt.answers.push(new PublishError('Google no longer accepts this connection’s sign-in: connect it again in Settings → Publishing', { auth: true }));
  const p = published(slug, 'youtube');
  await run();
  assert.equal(now(p.id).state, 'failed');
  assert.equal(now(p.id).attempts, 1);
  assert.equal(findConnection(tube.id)?.state, 'error');
  assert.match(String(findConnection(tube.id)?.error), /connect it again/);
  changeConnection(tube.id, { state: 'ready', error: null });
});

test('a final reopened before the time pauses what waits: nothing goes out for a version that isn’t final', async () => {
  const slug = finalVideo();
  const p = published(slug, 'instagram', { schedule_at: new Date(clock + 600e3).toISOString() });
  const sent = zn.sent.length;
  store.reopenFinal(slug, {}, 'tester');
  await run();
  const s = now(p.id);
  assert.equal(s.state, 'cancelled');
  assert.match(String(s.error), /^Paused: the video was reopened/);
  clock += 600e3;
  await run();
  assert.equal(zn.sent.length, sent, 'never sent');
  // a newer render after the final: the gate says so
  store.setFinal(slug, {}, 'tester');
  const review = store.loadReview(slug) as NonNullable<ReturnType<typeof store.loadReview>>;
  const v2 = { ...(review.versions[0] as (typeof review.versions)[number]), v: 2 };
  assert.match(String(posts.gateOf({ ...review, versions: [...review.versions, v2] }, s)), /V2 arrived after the final V1/);
  // final again: the paused post is a draft again once changed, and goes
  const back = posts.updatePost(p.id, { schedule_at: null }, 'tester', { person: true });
  assert.equal(back.state, 'draft');
});

test('a platform still at it is looked at again a minute later, until the post is out', async () => {
  const slug = finalVideo();
  zn.answers.push({ state: 'processing', remote_id: 'z9', url: null });
  const p = published(slug, 'facebook');
  await run();
  assert.equal(now(p.id).state, 'uploading');
  assert.equal(now(p.id).remote_id, 'z9');
  const looked = zn.looked.length;
  await run();
  assert.equal(zn.looked.length, looked, 'not looked at before a minute');
  clock += 61e3;
  await run();
  assert.deepEqual(zn.looked.slice(looked), [p.id]);
  assert.equal(now(p.id).state, 'posted');
  assert.equal(now(p.id).url, 'https://x.example/done');
});

test('an upload cut off by a restart resumes with the session the try before kept', async () => {
  const slug = finalVideo();
  const p = published(slug, 'youtube', { title: 'Resumed' });
  // the process stopped mid-upload: the post says uploading, its session sealed beside it
  posts.changePost(p.id, (x) => {
    x.state = 'uploading';
    x.session = seal(p.id, { url: 'https://upload.example/s1', total: 1234 });
  });
  const after = createPublisher({ adapters: { youtube: yt.adapter as never, zernio: zn.adapter }, ...options });
  await after.tick();
  await after.idle();
  assert.deepEqual(yt.sent.at(-1)?.session, { url: 'https://upload.example/s1', total: 1234 }, 'the kept session reached the adapter');
  assert.equal(now(p.id).state, 'posted');
  assert.equal(now(p.id).session, undefined, 'and is gone once it went');
});

test('YouTube holds a schedule: looked at after its time; the private lock is found on the look after an upload', async () => {
  const slug = finalVideo();
  const at = new Date(clock + 7200e3).toISOString();
  yt.answers.push({ state: 'scheduled', remote_id: 'v7', url: 'https://youtube.example/v7' });
  const p = published(slug, 'youtube', { schedule_at: at });
  assert.notEqual(p.next_try, at, 'YouTube holds it: it is sent at once');
  await run();
  assert.equal(now(p.id).state, 'scheduled');
  const looked = yt.looked.length;
  await run();
  assert.equal(yt.looked.length, looked, 'not looked at before its time');
  clock += 7261e3;
  yt.looks.set(p.id, { state: 'posted', remote_id: 'v7', url: 'https://youtube.example/v7', locked: true });
  await run();
  assert.ok(yt.looked.slice(looked).includes(p.id));
  const s = now(p.id);
  assert.equal(s.state, 'posted');
  assert.equal(s.locked, true, 'it never went public: the project is held private');
  assert.match(String(s.history.at(-1)?.note), /kept it private/);
  const ev = store
    .readEvents({ limit: 50 })
    .filter((e) => e.type === 'post' && e.post?.id === p.id)
    .at(-1);
  assert.match(String(ev?.text), /kept private by YouTube: make it public in YouTube Studio/);
  // and a plain upload is looked at once more a minute after it went, for the same reason
  const slug2 = finalVideo();
  const q = published(slug2, 'youtube');
  await run();
  assert.equal(now(q.id).state, 'posted');
  assert.ok(!now(q.id).locked);
  yt.looks.set(q.id, { state: 'posted', remote_id: String(now(q.id).remote_id), url: null, locked: true });
  clock += 61e3;
  await run();
  assert.equal(now(q.id).locked, true);
});

test('taking back: a post waiting here at once; one YouTube holds is YouTube Studio’s, with the link', async () => {
  const slug = finalVideo();
  const waiting = published(slug, 'instagram', { schedule_at: new Date(clock + 9e6).toISOString() });
  const out = await publisher.cancel(waiting.id, 'tester');
  assert.equal(out.state, 'cancelled');
  assert.equal(out.error, 'Cancelled by tester.');
  yt.answers.push({ state: 'scheduled', remote_id: 'v8', url: 'https://youtube.example/v8' });
  const held = published(slug, 'youtube', { schedule_at: new Date(clock + 9e6).toISOString() });
  await run();
  assert.equal(now(held.id).state, 'scheduled');
  await assert.rejects(
    publisher.cancel(held.id, 'tester'),
    (e: InstanceType<typeof posts.PostError>) => e.status === 409 && /YouTube Studio/.test(e.message) && /studio\.youtube\.com\/video\/v8/.test(String(e.next)),
  );
});

// ---------------------------------------------------------------- never twice (A12 PUB-1)

test('PUB-1: a posted video whose later look fails for good stays posted; the connection is marked; nothing is sent again', async () => {
  const slug = finalVideo();
  const p = published(slug, 'youtube');
  await run();
  const first = now(p.id);
  assert.equal(first.state, 'posted');
  const sends = yt.sent.length;
  // a minute later the queue looks for the private lock; the person revoked the sign-in at Google meanwhile
  clock += 61e3;
  yt.looks.set(p.id, new PublishError('Google no longer accepts this connection’s sign-in', { auth: true }));
  await run();
  const s = now(p.id);
  assert.equal(s.state, 'posted', 'it is on YouTube: it stays posted');
  assert.equal(s.remote_id, first.remote_id);
  assert.equal(findConnection(tube.id)?.state, 'error', 'the connection says the sign-in is gone');
  assert.match(String(s.history.at(-1)?.note), /couldn’t be asked/);
  assert.throws(() => posts.retryPost(p.id, 'tester'), /only a failed/);
  changeConnection(tube.id, { state: 'ready', error: null });
  clock += 10 * 60e3;
  await run();
  assert.equal(yt.sent.length, sends, 'never uploaded a second time');
});

test('PUB-1: a post the platform still works on whose look fails for good stays sent; after 6 h it is "sent, not confirmed", and Retry looks again', async () => {
  const slug = finalVideo();
  zn.answers.push({ state: 'processing', remote_id: 'zp_1', url: null });
  const p = published(slug, 'instagram');
  await run();
  assert.equal(now(p.id).state, 'uploading');
  const sends = zn.sent.length;
  clock += 61e3;
  zn.looks.set(p.id, new PublishError('Zernio refused the API key', { auth: true }));
  await run();
  assert.equal(now(p.id).state, 'uploading', 'the platform holds it: still being sent');
  assert.equal(findConnection(social.id)?.state, 'error');
  // nobody fixes the key: the queue gives up looking after 6 h, and says what it knows
  clock += 6 * 3600e3 + 61e3;
  await run();
  let s = now(p.id);
  assert.equal(s.state, 'sent', 'sent, but the platform never said whether it went out');
  assert.equal(s.remote_id, 'zp_1');
  assert.ok(
    posts.failedPosts().some((x) => x.post.id === p.id),
    'it waits in the inbox',
  );
  assert.throws(() => posts.publishPost(p.id, { confirm: confirmOf(s), by: 'tester' }), /went out before/);
  // the key is fixed; Retry asks the platform again instead of sending (the store writes real times: the queue's
  // clock comes back to them)
  changeConnection(social.id, { state: 'ready', error: null });
  clock = Date.now() + 1000;
  posts.retryPost(p.id, 'tester');
  assert.equal(now(p.id).state, 'uploading');
  await run();
  s = now(p.id);
  assert.equal(s.state, 'posted');
  assert.equal(zn.sent.length, sends, 'no second post at the platform');
});

test('PUB-1: an answer lost after the post was asked for is "sent, not confirmed": never sent again by itself, only when a person asks', async () => {
  const slug = finalVideo();
  // the stand-in throws after the create call went out: the adapter said it was committing
  const lost = Object.assign(new PublishError('the connection to the platform dropped', { transient: true }), { committed: true });
  zn.answers.push(lost);
  const p = published(slug, 'facebook');
  const sends = zn.sent.length;
  await run();
  let s = now(p.id);
  assert.equal(s.state, 'sent');
  assert.equal(s.remote_id, undefined);
  clock += 3600e3;
  await run();
  assert.equal(zn.sent.length, sends + 1, 'tried once, never again by itself');
  assert.throws(() => posts.retryPost(p.id, 'tester'), /look on the platform/);
  posts.retryPost(p.id, 'tester', { again: true });
  await run();
  s = now(p.id);
  assert.equal(s.state, 'posted');
  assert.equal(zn.sent.length, sends + 2);
  assert.equal(zn.sent.at(-1)?.key, `lampo-${p.id}-2`, 'a person’s new round');
});

test('PUB-1: a restart after the create call went out without an answer kept: "sent, not confirmed", not a second post', async () => {
  const slug = finalVideo();
  const p = published(slug, 'instagram');
  posts.changePost(p.id, (x) => {
    x.state = 'uploading';
    x.committed_at = new Date(clock).toISOString();
  });
  const sends = zn.sent.length;
  const after = createPublisher({ adapters: { youtube: yt.adapter as never, zernio: zn.adapter }, ...options });
  await after.tick();
  await after.idle();
  assert.equal(zn.sent.length, sends, 'nothing sent');
  assert.equal(now(p.id).state, 'sent');
});

test('PUB-1: a platform that says the post failed keeps its id: Retry asks again; posting again is a person’s explicit choice', async () => {
  const slug = finalVideo();
  zn.answers.push({ state: 'processing', remote_id: 'zp_9', url: null });
  const p = published(slug, 'facebook');
  await run();
  clock += 61e3;
  zn.looks.set(p.id, new PublishError('Facebook refused the video'));
  await run();
  let s = now(p.id);
  assert.equal(s.state, 'failed');
  assert.equal(s.remote_id, 'zp_9', 'what the platform holds is remembered');
  const sends = zn.sent.length;
  clock = Date.now() + 1000;
  posts.retryPost(p.id, 'tester');
  zn.looks.set(p.id, new PublishError('Facebook refused the video'));
  await run();
  assert.equal(now(p.id).state, 'failed');
  assert.equal(zn.sent.length, sends, 'Retry looked, it didn’t send');
  // a person edits it and publishes again: only with `again`
  posts.updatePost(p.id, { description: 'Second cut' }, 'tester', { person: true });
  assert.throws(() => posts.publishPost(p.id, { confirm: confirmOf(now(p.id)), by: 'tester' }), /went out before/);
  posts.publishPost(p.id, { confirm: confirmOf(now(p.id)), by: 'tester', again: true });
  await run();
  s = now(p.id);
  assert.equal(s.state, 'posted');
  assert.equal(zn.sent.length, sends + 1);
});

// ---------------------------------------------------------------- the delta review's info items (A12 PUB-11, PUB-12)

test('PUB-11: an upload’s progress is saved every ten seconds at most, and tells the post’s page, not the library', async () => {
  const slug = finalVideo();
  const told: { slug: string; progress: boolean }[] = [];
  const minute: Adapter = {
    kind: 'zernio',
    accounts: async () => [],
    async publish(t) {
      // a minute-long upload, reporting every second
      for (let s = 1; s <= 60; s++) {
        clock += 1000;
        t.progress(s * 1000, 60_000);
      }
      return { state: 'posted', remote_id: 'r-minute', url: 'https://x.example/minute' };
    },
    status: zn.adapter.status,
  };
  const pub = createPublisher({
    adapters: { youtube: yt.adapter as never, zernio: minute },
    changed: (s, o) => told.push({ slug: s, progress: !!o?.progress }),
    ...options,
  });
  const p = published(slug, 'instagram');
  await pub.tick();
  await pub.idle();
  assert.equal(now(p.id).state, 'posted');
  const progress = told.filter((x) => x.slug === slug && x.progress);
  assert.ok(progress.length >= 1 && progress.length <= 7, `progress saved ${progress.length} times in a minute`);
  assert.ok(
    told.some((x) => x.slug === slug && !x.progress),
    'the post’s own changes still tell everyone',
  );
});

test('PUB-12: only an https link from a platform is kept as the post’s', async () => {
  for (const url of ['http://insecure.example/p/1', 'javascript:alert(1)', 'data:text/html,hi']) {
    const slug = finalVideo();
    zn.answers.push({ state: 'posted', remote_id: `r-${url.length}`, url });
    const p = published(slug, 'facebook');
    await run();
    const s = now(p.id);
    assert.equal(s.state, 'posted');
    assert.equal(s.url, undefined, `${url} isn't kept`);
  }
  const slug = finalVideo();
  zn.answers.push({ state: 'posted', remote_id: 'r-ok', url: 'https://facebook.example/p/9' });
  const p = published(slug, 'facebook');
  await run();
  assert.equal(now(p.id).url, 'https://facebook.example/p/9');
});

// ---------------------------------------------------------------- never twice, the ways out of a send (A12 PUB-1, PUB-3)

/** An answer lost after YouTube's last bytes went out, with the upload session kept (it can find the upload again). */
const lostAfterLastBytes = () =>
  Object.assign(new PublishError('the connection to YouTube dropped', { transient: true }), {
    committed: true,
    session: { url: 'https://upload.example/s9', total: 1234 },
  });

test('PUB-1: tries that run out after the last bytes went out leave the post "sent, not confirmed": Retry never uploads it again by itself', async () => {
  const slug = finalVideo();
  for (let i = 0; i < options.maxAttempts; i++) yt.answers.push(lostAfterLastBytes());
  const p = published(slug, 'youtube');
  const sends = yt.sent.length;
  for (let i = 0; i < options.maxAttempts; i++) {
    await run();
    clock += 60e3;
  }
  assert.equal(yt.sent.length, sends + options.maxAttempts, 'every try resumed the kept session');
  assert.equal(yt.sent.at(-1)?.committed, true, 'and knew a try before got as far as the video');
  const s = now(p.id);
  assert.equal(s.state, 'sent', 'it may be on the channel: not failed');
  assert.match(String(s.error), /may have gone out/);
  assert.throws(() => posts.retryPost(p.id, 'tester'), /look on the platform/);
  await run();
  assert.equal(yt.sent.length, sends + options.maxAttempts, 'nothing sent again');
});

test('PUB-1: a post paused by a reopened final, or cancelled, after its last bytes went out is "sent, not confirmed"; publishing it again needs `again`', async () => {
  const slug = finalVideo();
  yt.answers.push(lostAfterLastBytes());
  const p = published(slug, 'youtube');
  await run();
  assert.equal(now(p.id).state, 'queued', 'tried again later, through its session');
  store.reopenFinal(slug, {}, 'tester');
  await run();
  let s = now(p.id);
  assert.equal(s.state, 'sent', 'paused, but it may be out: not cancelled');
  assert.match(String(s.error), /^Paused: the video was reopened/);
  store.setFinal(slug, {}, 'tester');
  assert.throws(() => posts.updatePost(p.id, { title: 'Again' }, 'tester', { person: true }), /the post is sent/);
  assert.throws(() => posts.publishPost(p.id, { confirm: confirmOf(now(p.id)), by: 'tester' }), /went out before/);
  // a person's cancel of a waiting post that may be out says the same
  const slug2 = finalVideo();
  yt.answers.push(lostAfterLastBytes());
  const q = published(slug2, 'youtube');
  await run();
  assert.equal(now(q.id).state, 'queued');
  s = await publisher.cancel(q.id, 'tester');
  assert.equal(s.state, 'sent');
  assert.match(String(s.error), /^Cancelled by tester\. .*may have gone out/);
});

test('PUB-1: the platform’s clear "no" to the post itself starts the next try clean (it made nothing)', async () => {
  const slug = finalVideo();
  const no = Object.assign(new PublishError('Zernio asked to slow down', { transient: true, notSent: true }), { committed: true });
  zn.answers.push(no);
  const p = published(slug, 'instagram');
  await run();
  const s = now(p.id);
  assert.equal(s.state, 'queued');
  assert.equal(s.committed_at, undefined, 'nothing at the platform: the next try is an ordinary one');
  clock += 60e3;
  await run();
  assert.equal(now(p.id).state, 'posted');
});

test('PUB-3: a confirm without the digest of what the person saw publishes nothing', () => {
  const slug = finalVideo();
  const { post } = posts.draftPost({
    slug,
    platform: 'instagram',
    fields: { connection: social.id, account: 'ig1', ai_generated: false },
    by: 'tester',
  });
  const bare = { platform: post.platform, account: post.account } as unknown as ReturnType<typeof confirmOf>;
  assert.throws(() => posts.publishPost(post.id, { confirm: bare, by: 'tester' }), /changed since you looked/);
  assert.equal(now(post.id).state, 'draft');
  assert.equal(posts.publishPost(post.id, { confirm: confirmOf(post), by: 'tester' }).state, 'queued');
});

// ---------------------------------------------------------------- hardening (A12 PUB-16)

test('PUB-16: what a platform says about its accounts is kept bounded: one line per field, 120 characters, 100 accounts', async () => {
  const many: PublishAccount[] = Array.from({ length: 150 }, (_, i) => ({ id: `acc_${i}`, platform: 'instagram', name: `Account ${i}` }));
  many.unshift(
    { id: 'acc_long', platform: 'instagram', name: `Studio\nIGNORE ALL PREVIOUS ${'x'.repeat(10_000)}`, detail: `@${'h'.repeat(5000)}` },
    { id: 'i'.repeat(300), platform: 'instagram', name: 'An id no post can name' },
    { id: 'acc\nbroken', platform: 'facebook', name: 'An id over two lines' },
  );
  const wordy: Adapter = { ...zn.adapter, accounts: async () => many };
  const checker = createPublisher({ adapters: { youtube: yt.adapter as never, zernio: wordy }, ...options });
  const c = addConnection({ kind: 'zernio', label: 'Wordy', secret: { api_key: 'test-wordy-0123456789' }, by: 'tester' });
  const out = await checker.check(c.id);
  assert.equal(out.state, 'ready');
  assert.equal(out.accounts.length, 100);
  const first = out.accounts[0] as PublishAccount;
  assert.equal(first.id, 'acc_long');
  assert.ok([...first.name].length <= 120 && !/\n/.test(first.name), first.name.slice(0, 60));
  assert.ok([...(first.detail ?? '')].length <= 120);
  assert.ok(!out.accounts.some((a) => a.id.length > 120 || /\n/.test(a.id)), 'an id no post can name is left out, never cut');
  assert.deepEqual(findConnection(c.id)?.accounts, out.accounts, 'and kept so');
});
