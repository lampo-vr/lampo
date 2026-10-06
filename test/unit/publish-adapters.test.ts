// The ways to the platforms against fake ones (test/lib/fakePlatforms.ts — no network): YouTube's resumable upload in
// chunks, resumed after a dropped connection within a try and across tries, publishAt held by YouTube, a project kept
// private (unaudited), quota and a revoked sign-in as reasons a person reads; Zernio's presigned upload (no key sent
// there), the post with its platform's fields, one still being published, a refusal; and the guard every request
// goes through (https only, no private address unless the operator named the host, no redirect followed).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Post, PublishAccount } from '../../lib/types.ts';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { createYouTube, CHUNK_UNIT } = await import('../../lib/publish/youtube.ts');
const { createZernio, captionOf } = await import('../../lib/publish/zernio.ts');
const { endpointsFrom, guardedRequest, NetError } = await import('../../lib/publish/net.ts');
const { PublishError } = await import('../../lib/publish/adapter.ts');

const fakes = await startFakePlatforms();
after(() => fakes.close());
const { endpoints, named } = endpointsFrom(fakes.env as NodeJS.ProcessEnv);
const net = { named };
const dir = tmpdir('vr-publish-');
// 2.4 chunks of 256 KiB: three PUTs
const file = path.join(dir, 'final.mp4');
fs.writeFileSync(file, crypto.randomBytes(Math.floor(CHUNK_UNIT * 2.4)));
const bytes = fs.statSync(file).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const post = (over: Partial<Post> = {}): Post => ({
  id: 'po_000000000001',
  slug: 'spot',
  v: 3,
  render: 'abc',
  platform: 'youtube',
  connection: 'pc_000000000001',
  account: 'UC_fake_channel',
  title: 'Spring launch',
  description: 'The spot.',
  tags: ['launch'],
  cover_frame: null,
  visibility: 'public',
  schedule_at: null,
  ai_generated: false,
  youtube: { category: '22', made_for_kids: false },
  state: 'queued',
  created: '',
  by: 'Olivia',
  updated: '',
  history: [],
  ...over,
});

/** A YouTube secret signed in through the fake Google, as the callback route would keep it. */
async function signedIn(yt: ReturnType<typeof createYouTube>) {
  const secret = { client_id: fakes.clientId, client_secret: fakes.clientSecret };
  const verifier = 'v'.repeat(43);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const auth = new URL(yt.authUrl({ clientId: secret.client_id, redirectUri: 'http://app.test/api/publish/oauth/callback', state: 's1', challenge }));
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  const consent = await fetch(auth, { redirect: 'manual' });
  const code = new URL(String(consent.headers.get('location'))).searchParams.get('code') as string;
  return yt.exchange({ secret, code, redirectUri: 'http://app.test/api/publish/oauth/callback', verifier });
}

const target = (p: Post, over: Record<string, unknown> = {}) => {
  const kept: { session: unknown; progress: number[]; committed: number } = { session: undefined, progress: [], committed: 0 };
  const t = {
    post: p,
    file,
    bytes,
    duration: 4,
    cover: null,
    coverMs: null,
    account: { id: 'UC_fake_channel', platform: 'youtube', name: 'Studio Channel' } as PublishAccount,
    key: `lampo-${p.id}-1`,
    session: null,
    keepSession: (s: unknown) => {
      kept.session = s;
    },
    progress: (sent: number) => kept.progress.push(sent),
    committing: () => {
      kept.committed++;
    },
    ...over,
  };
  return { t, kept };
};
const keep = () => {};

test('YouTube: the sign-in keeps a refresh token; the upload goes in 256 KiB chunks, the exact bytes', async () => {
  const yt = createYouTube({ endpoints, net, chunkBytes: CHUNK_UNIT, resumeWaits: [0, 0, 0] });
  const secret = await signedIn(yt);
  assert.match(String(secret.refresh_token), /^rt-/);
  assert.deepEqual(
    (await yt.accounts(secret, keep)).map((a) => a.name),
    ['Studio Channel'],
  );
  const { t, kept } = target(post());
  const out = await yt.publish(t, secret, keep);
  assert.equal(out.state, 'posted');
  assert.match(String(out.url), /watch\?v=vid_/);
  const v = fakes.videos.get(out.remote_id);
  assert.equal(v?.sha256, sha);
  assert.equal(kept.progress.at(-1), bytes);
  assert.ok((kept.session as { url?: string })?.url, 'the session stays for the queue to let go of with the id (A12 PUB-2)');
  assert.equal(kept.committed, 1, 'said once, before the last bytes');
  const puts = fakes.seen.filter((s) => s.method === 'PUT' && s.path.includes('upload_id'));
  assert.equal(puts.length, 3);
  assert.ok(puts.every((s) => /^Bearer at-/.test(String(s.headers.authorization))));
});

test('YouTube: a connection dropped mid-chunk resumes where YouTube got to, in the same try', async () => {
  const yt = createYouTube({ endpoints, net, chunkBytes: CHUNK_UNIT, resumeWaits: [0, 0, 0] });
  const secret = await signedIn(yt);
  fakes.seen.length = 0;
  fakes.knobs.dropAfter = 1000; // the connection goes 1000 bytes into a chunk
  const { t } = target(post({ id: 'po_000000000002' }));
  const out = await yt.publish(t, secret, keep);
  assert.equal(fakes.videos.get(out.remote_id)?.sha256, sha, 'nothing lost, nothing twice');
  assert.ok(
    fakes.seen.some((s) => s.method === 'PUT' && String(s.headers['content-range']).startsWith('bytes */')),
    'it asked how far the upload got',
  );
});

test('YouTube: a try that fails keeps its session; the next one resumes it instead of starting again', async () => {
  const yt = createYouTube({ endpoints, net, chunkBytes: CHUNK_UNIT, resumeWaits: [] });
  const secret = await signedIn(yt);
  // the connection goes as the first chunk's last byte arrives: YouTube kept 256 KiB of it
  fakes.knobs.dropAfter = CHUNK_UNIT;
  const first = target(post({ id: 'po_000000000003' }));
  await assert.rejects(yt.publish(first.t, secret, keep), (e: InstanceType<typeof PublishError>) => e.transient && /dropped/.test(e.message));
  const session = first.kept.session as { url: string; total: number };
  assert.ok(session?.url, 'the session was kept for the next try');
  const second = target(post({ id: 'po_000000000003' }), { session });
  fakes.seen.length = 0;
  const out = await yt.publish(second.t, secret, keep);
  const ranges = fakes.seen.filter((s) => s.method === 'PUT').map((s) => String(s.headers['content-range']));
  assert.equal(ranges[0], `bytes */${bytes}`, 'it asks where the kept session stands');
  assert.equal(ranges[1], `bytes ${CHUNK_UNIT}-${2 * CHUNK_UNIT - 1}/${bytes}`, 'and goes on from there');
  assert.equal(fakes.videos.get(out.remote_id)?.sha256, sha);
  assert.equal(fakes.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/upload/youtube/v3/videos')).length, 0, 'no second insert');
});

test('YouTube: a schedule is held by YouTube (private + publishAt), then public; an unaudited project keeps it private', async () => {
  const yt = createYouTube({ endpoints, net, chunkBytes: CHUNK_UNIT * 4 });
  const secret = await signedIn(yt);
  const at = new Date(Date.now() + 3600e3).toISOString();
  const { t } = target(post({ id: 'po_000000000004', schedule_at: at }));
  const out = await yt.publish(t, secret, keep);
  assert.equal(out.state, 'scheduled');
  const v = fakes.videos.get(out.remote_id);
  assert.deepEqual(v?.meta.status, { privacyStatus: 'private', publishAt: at, selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
  // an hour later YouTube made it public
  (v as { status: { publishAt?: string } }).status.publishAt = new Date(Date.now() - 1000).toISOString();
  const later = createYouTube({ endpoints, net, now: () => Date.now() + 3601e3 });
  const now = await later.status(post({ id: 'po_000000000004', schedule_at: at, remote_id: out.remote_id }), secret, keep);
  assert.equal(now.state, 'posted');
  assert.ok(!now.locked);
  fakes.knobs.lockPrivate = true;
  try {
    const locked = await yt.publish(target(post({ id: 'po_000000000005', schedule_at: at })).t, secret, keep);
    assert.equal(locked.state, 'posted', 'a locked upload is no schedule: nothing goes public at its time');
    assert.equal(locked.locked, true);
    const plain = await yt.publish(target(post({ id: 'po_000000000006' })).t, secret, keep);
    assert.equal(plain.locked, true, 'asked public, kept private');
    const priv = await yt.publish(target(post({ id: 'po_000000000007', visibility: 'private' })).t, secret, keep);
    assert.ok(!priv.locked, 'asked private: nothing was kept from anyone');
  } finally {
    fakes.knobs.lockPrivate = false;
  }
});

test('YouTube: quota, a revoked sign-in and an upload address on another host are reasons, not crashes', async () => {
  const yt = createYouTube({ endpoints, net });
  const secret = await signedIn(yt);
  fakes.knobs.quota = true;
  await assert.rejects(
    yt.publish(target(post({ id: 'po_000000000008' })).t, secret, keep),
    (e: InstanceType<typeof PublishError>) => e.transient && (e.retryAfterMs ?? 0) >= 3600e3 && /daily quota/.test(e.message),
  );
  fakes.knobs.foreignSession = 'https://uploads.attacker.example';
  await assert.rejects(yt.publish(target(post({ id: 'po_000000000009' })).t, secret, keep), /isn’t its own: nothing was sent/);
  fakes.knobs.revoked = true;
  try {
    await assert.rejects(
      yt.publish(target(post({ id: 'po_000000000010' })).t, { ...secret, access_token: undefined }, keep),
      (e: InstanceType<typeof PublishError>) => e.auth && !e.transient && /connect it again/.test(e.message),
    );
  } finally {
    fakes.knobs.revoked = false;
  }
});

test('Zernio: its Instagram and Facebook accounts; the file to presigned storage without the key, then the post', async () => {
  const z = createZernio({ endpoints, net });
  const secret = { api_key: fakes.apiKey };
  const accounts = await z.accounts(secret, keep);
  assert.deepEqual(accounts, [
    { id: 'acc_ig_1', platform: 'instagram', name: 'Studio Reels', detail: '@studio.reels' },
    { id: 'acc_fb_1', platform: 'facebook', name: 'Studio Page' },
  ]);
  fakes.seen.length = 0;
  const p = post({
    id: 'po_000000000011',
    platform: 'instagram',
    account: 'acc_ig_1',
    description: 'New #launch',
    tags: ['launch', 'spring'],
    instagram: { kind: 'reel', share_to_feed: false },
  });
  const out = await z.publish({ ...target(p).t, account: accounts[0] as PublishAccount, coverMs: 1020, key: 'lampo-po_000000000011-1' }, secret, keep);
  assert.equal(out.state, 'posted');
  assert.match(String(out.url), /instagram\.example/);
  const sent = fakes.posts.get(out.remote_id);
  assert.equal(sent?.media?.sha256, sha, 'the exact bytes reached the provider');
  assert.equal(sent?.body.content, captionOf(p));
  assert.equal(captionOf(p), 'New #launch\n\n#spring', 'a tag the caption carries already isn’t added twice');
  assert.equal(sent?.body.publishNow, true);
  assert.deepEqual(((sent?.body.platforms ?? []) as { platformSpecificData: unknown }[])[0]?.platformSpecificData, {
    contentType: 'reels',
    shareToFeed: false,
    thumbOffset: 1020,
  });
  const put = fakes.seen.find((s) => s.method === 'PUT');
  assert.ok(put && !put.headers.authorization, 'no key to the storage');
  assert.equal(fakes.seen.find((s) => s.path === '/zernio/v1/posts')?.headers['idempotency-key'], 'lampo-po_000000000011-1');
  // the same key again (a lost answer) is the same post
  const again = await z.publish({ ...target(p).t, account: accounts[0] as PublishAccount, key: 'lampo-po_000000000011-1' }, secret, keep);
  assert.equal(again.remote_id, out.remote_id);
});

test('Zernio: a post still being published is looked at again; a refusal is the platform’s reason; a bad key is said', async () => {
  const z = createZernio({ endpoints, net });
  const secret = { api_key: fakes.apiKey };
  const fb = { id: 'acc_fb_1', platform: 'facebook', name: 'Studio Page' } as PublishAccount;
  fakes.knobs.postSlow = true;
  const p = post({ id: 'po_000000000012', platform: 'facebook', account: 'acc_fb_1', youtube: undefined });
  const out = await z.publish({ ...target(p).t, account: fb, key: 'k-12' }, secret, keep);
  assert.equal(out.state, 'processing');
  const now = await z.status({ ...p, remote_id: out.remote_id }, secret, keep);
  assert.equal(now.state, 'posted');
  assert.deepEqual(((fakes.posts.get(out.remote_id)?.body.platforms ?? []) as { platformSpecificData: unknown }[])[0]?.platformSpecificData, {
    contentType: 'reel',
    title: 'Spring launch',
  });
  fakes.knobs.postFails = 'video aspect ratio is not supported';
  await assert.rejects(
    z.publish({ ...target(p).t, account: fb, key: 'k-13' }, secret, keep),
    (e: Error) => e.message === 'Video aspect ratio is not supported.',
  );
  await assert.rejects(z.accounts({ api_key: 'sk_nope' }, keep), (e: InstanceType<typeof PublishError>) => e.auth && /refused the API key/.test(e.message));
});

test('the guard: https only and public addresses, unless the operator named the host; no redirect is followed', async () => {
  // the fakes are named (VR_PUBLISH_ENDPOINTS): plain http on loopback is allowed for them
  const named302 = await guardedRequest(`${fakes.url}/google/auth?redirect_uri=http%3A%2F%2Fx.test%2Fcb&state=s`, {}, net);
  assert.equal(named302.status, 302, 'a redirect is answered, not followed');
  await assert.rejects(guardedRequest(`${fakes.url}/zernio/v1/accounts`, {}, {}), (e: InstanceType<typeof NetError>) => /only https/.test(e.message));
  await assert.rejects(guardedRequest('https://127.0.0.1:9/x', {}, {}), /private address/);
  await assert.rejects(
    guardedRequest('https://storage.example/x', {}, { resolve: async () => [{ address: '10.0.0.7', family: 4 }] }),
    /private address/,
    'a name that resolves inside the network is refused',
  );
  await assert.rejects(guardedRequest('https://user:pw@example.com/x', {}, {}), /user name or password/);
  assert.throws(() => endpointsFrom({ VR_PUBLISH_ENDPOINTS: 'nope' } as NodeJS.ProcessEnv), /not JSON/);
  assert.equal(endpointsFrom({} as NodeJS.ProcessEnv).endpoints.youtube, 'https://www.googleapis.com/youtube/v3');
});

test('PUB-4: an answer that drips a byte at a time ends at the request’s deadline, not after it', async () => {
  const http = await import('node:http');
  const slow = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let n = 0;
    const t = setInterval(() => {
      res.write(' ');
      if (++n >= 16) {
        clearInterval(t);
        res.end('{}');
      }
    }, 250);
    res.on('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(slow.address() as import('node:net').AddressInfo).port}`;
  const t0 = Date.now();
  await assert.rejects(
    guardedRequest(`http://${host}/x`, { timeoutMs: 1000 }, { named: new Set([host]) }),
    (e: InstanceType<typeof NetError>) => e.transient && /too long/.test(e.message),
  );
  const took = Date.now() - t0;
  assert.ok(took < 2500, `it gave up after ${took} ms, the answer would have taken 4 s`);
  slow.closeAllConnections();
  slow.close();
});

test('PUB-1: a kept YouTube session that is gone after its last bytes went out is no reason to upload again', async () => {
  const yt = createYouTube({ endpoints, net, chunkBytes: CHUNK_UNIT });
  const secret = await signedIn(yt);
  const gone = { url: `${endpoints.youtubeUpload}/videos?uploadType=resumable&upload_id=forgotten`, total: bytes };
  const inserts = () => fakes.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/upload/youtube/v3/videos')).length;
  fakes.seen.length = 0;
  const after = target(post({ id: 'po_000000000021' }), { session: gone, committed: true });
  await assert.rejects(yt.publish(after.t, secret, keep), (e: InstanceType<typeof PublishError>) => !e.transient && /may have finished/.test(e.message));
  assert.equal(inserts(), 0, 'no second video');
  assert.equal(after.kept.session, null, 'the session is let go');
  // a session gone before the last bytes: nothing was made, so the upload starts again
  const before = target(post({ id: 'po_000000000022' }), { session: gone });
  const out = await yt.publish(before.t, secret, keep);
  assert.equal(inserts(), 1);
  assert.equal(fakes.videos.get(out.remote_id)?.sha256, sha);
});
