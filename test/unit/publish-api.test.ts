// Publishing on a hosted server, against fake platforms (test/lib/fakePlatforms.ts — no network): a final video,
// drafts by an agent and a member, connections only a person adds (YouTube through the Google sign-in, Instagram and
// Facebook through the posting API's key), the gate (final, the answers, the confirm), the queue sending the exact
// final file, a failure as a sentence in the inbox, retry, and secrets that never leave: not in an answer, an event,
// a file in clear or the log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { settings } from '../../lib/env.ts';
import type { ForYouItem, PostView, PublishConnectionInfo } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { startFakePlatforms } from '../lib/fakePlatforms.ts';
import { isolatedEnv, makeVideo, tmpdir, VR } from '../lib/helpers.ts';
import { cookieFrom, type Request, tusUpload } from '../lib/http.ts';

const fakes = await startFakePlatforms();
const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, ...fakes.env } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

// everything the process says, to check no secret is ever logged
const said: string[] = [];
for (const k of ['log', 'error', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    said.push(a.map(String).join(' '));
    if (settings.LAMPO_TEST_VERBOSE) orig(...a);
  };
}

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 144, h: 256, fps: 25, dur: 4 });
// the app as the server process starts it (production keep-alive; it stops itself after the tests)
const { request, port } = await startApp({ ctx, headers: { Connection: 'close', Host: 'review.test' } });
const as: Record<'olivia' | 'max' | 'rita' | 'agent' | 'maxToken', Record<string, string>> = { olivia: {}, max: {}, rita: {}, agent: {}, maxToken: {} };
let slug = '';

before(async () => {
  for (const [name, role] of [
    ['olivia', 'owner'],
    ['max', 'member'],
    ['rita', 'reviewer'],
  ] as const) {
    const u = await auth.createUser({ email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), password: `${name}s password 1`, role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    if (name === 'olivia') as.agent = { Authorization: `Bearer ${auth.createToken(u.id, 'agent').token}` };
    if (name === 'max') as.maxToken = { Authorization: `Bearer ${auth.createToken(u.id, 'max agent').token}` };
  }
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Brand' }, as.agent);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(async () => {
  await ctx.publisher.stop();
  await fakes.close();
});

const posts = async (who = as.olivia): Promise<PostView[]> =>
  (await request('GET', `/api/review/${encodeURIComponent(slug)}/posts`, { headers: who })).json().posts;
const one = async (id: string): Promise<PostView> => (await posts()).find((p) => p.id === id) as PostView;
/** What the person confirms: the platform and account the post names now, and the digest of what they saw (PUB-3). */
const confirmOf = async (id: string, over: Record<string, unknown> = {}) => {
  const p = await one(id);
  return { confirm: { platform: p.platform, account: p.account, digest: p.digest, ...over } };
};
const run = async () => {
  await ctx.publisher.tick();
  await ctx.publisher.idle();
};

test('posts are drafted for a final video only: before Final the answer says why and what is next', async () => {
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, { body: { platform: 'yt' }, headers: as.agent });
  assert.equal(r.status, 409, r.text);
  assert.match(r.json().error, /isn't final/);
  assert.ok(r.json().next, 'the stage’s next step rides along');
  const appr = await request('PUT', `/api/review/${encodeURIComponent(slug)}/approval`, { body: { status: 'approved', v: 1 }, headers: as.olivia });
  assert.equal(appr.status, 200, appr.text);
  const fin = await request('PUT', `/api/review/${encodeURIComponent(slug)}/final`, { body: { v: 1 }, headers: as.olivia });
  assert.equal(fin.status, 200, fin.text);
});

let yt = '';
test('an agent drafts the YouTube post: made once, then changed; what is missing is said, not defaulted', async () => {
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, {
    body: { platform: 'yt', title: 'Spring launch', description: 'The new spot.', tags: ['launch', '#spring'], by: 'agent:writer' },
    headers: as.agent,
  });
  assert.equal(r.status, 201, r.text);
  const p = r.json() as PostView;
  yt = p.id;
  assert.equal(p.state, 'draft');
  assert.equal(p.by, 'agent:writer');
  assert.deepEqual(p.tags, ['launch', 'spring']);
  assert.equal(p.ai_generated, null, 'the AI answer is never defaulted');
  assert.equal(p.youtube?.made_for_kids, null, 'made for kids is never defaulted');
  const codes = p.problems.map((x) => x.code);
  for (const c of ['ai_missing', 'kids_missing', 'connection_missing']) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.ok(
    p.problems.every((x) => x.level === 'warn'),
    'a draft without them is fine: they block only publishing',
  );
  const again = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, {
    body: { platform: 'youtube', title: 'Spring launch 2' },
    headers: as.agent,
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json().id, yt, 'one post per platform per final version');
  assert.equal(again.json().description, 'The new spot.', 'fields left out stay as drafted');
});

test('who may do what: reviewers read, members draft, only owners and admins publish — and never with a token', async () => {
  assert.equal((await request('GET', '/api/posts', { headers: as.rita })).status, 200);
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, { body: { platform: 'ig' }, headers: as.rita })).status, 403);
  assert.equal((await request('PATCH', `/api/posts/${yt}`, { body: { title: 'x' }, headers: as.rita })).status, 403);
  assert.equal((await request('PATCH', `/api/posts/${yt}`, { body: { title: 'Spring launch' }, headers: as.max })).status, 200, 'a member drafts');
  const confirm = { confirm: { platform: 'youtube', account: null } };
  assert.equal((await request('POST', `/api/posts/${yt}/publish`, { body: confirm, headers: as.max })).status, 403, 'a member can’t publish');
  assert.equal((await request('POST', `/api/posts/${yt}/publish`, { body: confirm, headers: as.rita })).status, 403);
  const token = await request('POST', `/api/posts/${yt}/publish`, { body: confirm, headers: as.agent });
  assert.equal(token.status, 403, 'an owner’s API token can’t publish');
  assert.match(token.json().error, /only a person/);
  for (const [m, u, body] of [
    ['POST', '/api/publish/connections', { kind: 'zernio', api_key: fakes.apiKey }],
    ['POST', `/api/posts/${yt}/retry`, {}],
    ['POST', `/api/posts/${yt}/cancel`, {}],
  ] as const) {
    const r = await request(m, u, { body, headers: as.agent });
    assert.equal(r.status, 403, `${m} ${u} with a token`);
  }
  assert.equal((await request('POST', '/api/publish/connections', { body: { kind: 'zernio', api_key: fakes.apiKey }, headers: as.max })).status, 403);
  assert.equal((await request('GET', '/api/publish/connections', { headers: as.rita })).status, 403, 'a reviewer doesn’t see the connections');
  assert.equal((await request('GET', '/api/publish/connections', { headers: as.max })).status, 200, 'a member picks one for a draft');
});

let ytConn: PublishConnectionInfo;
test('YouTube: the person’s own Google client, the sign-in through Google, the channel; no secret ever comes back', async () => {
  const add = await request('POST', '/api/publish/connections', {
    body: { kind: 'youtube', label: 'Brand channel', client_id: fakes.clientId, client_secret: fakes.clientSecret },
    headers: as.olivia,
  });
  assert.equal(add.status, 200, add.text);
  ytConn = add.json();
  assert.equal(ytConn.state, 'needs_auth');
  assert.equal(ytConn.redirect_uri, `${PUBLIC}/api/publish/oauth/callback`);
  assert.equal(ytConn.audited, false);
  assert.ok(!add.text.includes(fakes.clientSecret) && !add.text.includes(fakes.clientId), 'neither the client id nor the secret comes back');
  const go = await request('POST', `/api/publish/connections/${ytConn.id}/authorize`, { headers: as.olivia });
  assert.equal(go.status, 200, go.text);
  const google = new URL(go.json().url);
  assert.equal(google.origin + google.pathname, fakes.endpoints.googleAuth);
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.match(String(google.searchParams.get('scope')), /youtube\.upload/);
  // the browser goes to Google and comes back with a code
  const consent = await fetch(google, { redirect: 'manual' });
  const back = new URL(String(consent.headers.get('location')));
  // someone else's session can't land the code
  const stolen = await request('GET', `${back.pathname}${back.search}`, { headers: as.max });
  assert.equal(stolen.status, 403, 'a member can’t finish a sign-in');
  const done = await request('GET', `${back.pathname}${back.search}`, { headers: as.olivia });
  assert.equal(done.status, 303, done.text);
  assert.match(String(done.headers.location), new RegExp(`#/settings/publishing\\?connected=${ytConn.id}`));
  const replay = await request('GET', `${back.pathname}${back.search}`, { headers: as.olivia });
  assert.match(String(replay.headers.location), /publish_error=expired/, 'a state is good once');
  const list = await request('GET', '/api/publish/connections', { headers: as.olivia });
  const c = (list.json().connections as PublishConnectionInfo[]).find((x) => x.id === ytConn.id) as PublishConnectionInfo;
  assert.equal(c.state, 'ready');
  assert.deepEqual(
    c.accounts.map((a) => a.name),
    ['Studio Channel'],
  );
  for (const s of [fakes.clientSecret, 'rt-', 'at-']) assert.ok(!list.text.includes(s), `no ${s} in the list`);
});

test('the gate: the answers, the connection and the confirm must all be there; then YouTube gets the exact final file', async () => {
  const pick = await request('PATCH', `/api/posts/${yt}`, { body: { connection: ytConn.id }, headers: as.olivia });
  assert.equal(pick.json().account, 'UC_fake_channel', 'the connection’s channel is taken');
  const early = await request('POST', `/api/posts/${yt}/publish`, { body: await confirmOf(yt), headers: as.olivia });
  assert.equal(early.status, 409);
  assert.match(early.json().error, /AI-generated/);
  assert.match(early.json().error, /made for kids/);
  await request('PATCH', `/api/posts/${yt}`, {
    body: { ai_generated: false, youtube: { made_for_kids: false, category: '1' }, cover_frame: 10 },
    headers: as.olivia,
  });
  const wrong = await request('POST', `/api/posts/${yt}/publish`, { body: await confirmOf(yt, { account: 'UC_other' }), headers: as.olivia });
  assert.equal(wrong.status, 409, 'a confirm for another account is no confirm');
  const ok = await request('POST', `/api/posts/${yt}/publish`, { body: await confirmOf(yt), headers: as.olivia });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().state, 'queued');
  assert.equal(ok.json().published_by, 'Olivia');
  await run();
  const p = await one(yt);
  assert.equal(p.state, 'posted', JSON.stringify(p.history));
  assert.match(String(p.url), /youtube\.com\/watch\?v=vid_/);
  assert.equal(p.file?.kind, 'final', 'YouTube takes the final as it is');
  const video = fakes.videos.get(String(p.remote_id));
  assert.ok(video);
  const review = store.loadReview(slug);
  const final = review?.versions.find((v) => v.v === 1);
  const file = (await store.ensureVersionFile(review as never, 1)) as string;
  assert.equal(video.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'the exact final bytes');
  assert.equal(video.bytes, final?.size);
  assert.equal(video.meta.snippet?.title, 'Spring launch');
  assert.equal(video.meta.snippet?.categoryId, '1');
  assert.deepEqual(video.meta.status, { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
  assert.ok((video.thumbnail ?? 0) > 1000, 'the cover frame went up as the thumbnail');
  // the stage carries it; the event says it
  const lib = await request('GET', `/api/library?slug=${encodeURIComponent(slug)}`, { headers: as.rita });
  const stage = lib.json().videos[0].stage;
  assert.equal(stage.stage, 'final', 'publishing doesn’t change the stage');
  assert.deepEqual(
    stage.published.posts.map((x: { platform: string; state: string }) => `${x.platform}:${x.state}`),
    ['youtube:posted'],
  );
  const evs = store.readEvents({ limit: 50 }).filter((e) => e.type === 'post');
  assert.deepEqual(
    evs.map((e) => e.post?.state),
    ['draft', 'queued', 'posted'],
  );
  assert.match(String(evs.at(-1)?.text), /YouTube V1 posted \(Studio Channel\) https:/);
});

test('a post that went out stays as it is: one per platform per final version, not drafted again or deleted', async () => {
  const again = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, { body: { platform: 'youtube' }, headers: as.olivia });
  assert.equal(again.status, 409);
  assert.match(again.json().error, /posted already: it is out/);
  assert.equal((await request('DELETE', `/api/posts/${yt}`, { headers: as.olivia })).status, 409);
  assert.equal((await request('PATCH', `/api/posts/${yt}`, { body: { title: 'x' }, headers: as.olivia })).status, 409);
});

let zc: PublishConnectionInfo;
let ig = '';
test('Instagram and Facebook through the posting API: a bad key is said as such, a good one brings its accounts', async () => {
  const bad = await request('POST', '/api/publish/connections', { body: { kind: 'zernio', label: 'Social', api_key: 'sk_wrong_key_123' }, headers: as.olivia });
  assert.equal(bad.status, 200, bad.text);
  assert.equal(bad.json().state, 'error');
  assert.match(bad.json().error, /refused the API key/);
  await request('DELETE', `/api/publish/connections/${bad.json().id}`, { headers: as.olivia });
  const good = await request('POST', '/api/publish/connections', { body: { kind: 'zernio', label: 'Social', api_key: fakes.apiKey }, headers: as.olivia });
  zc = good.json();
  assert.equal(zc.state, 'ready', good.text);
  assert.deepEqual(zc.platforms.sort(), ['facebook', 'instagram']);
  assert.ok(!good.text.includes(fakes.apiKey));
  assert.equal(zc.holds_schedule, false, 'Lampo sends these at their time');
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, {
    body: { platform: 'instagram', description: 'New spot #launch', tags: ['spring'], ai_generated: true, connection: zc.id, cover_frame: 12 },
    headers: as.max,
  });
  assert.equal(r.status, 201, r.text);
  ig = r.json().id;
  assert.equal(r.json().account, 'acc_ig_1');
  assert.ok(
    r.json().problems.some((x: { code: string }) => x.code === 'ai_caption'),
    'no AI label through the API yet: say it in the caption',
  );
});

test('PUB-3: what goes out is what the person saw: an edit after they looked is a 409, and the history says who edited', async () => {
  const seen = await one(ig);
  assert.match(String(seen.digest), /^[0-9a-f]{16}$/, 'every post carries the digest of what goes out');
  // the person looks; an agent with a member's token changes the caption right after
  const edit = await request('PATCH', `/api/posts/${ig}`, { body: { description: 'Something else entirely #spam' }, headers: as.maxToken });
  assert.equal(edit.status, 200, edit.text);
  const late = await request('POST', `/api/posts/${ig}/publish`, {
    body: { confirm: { platform: 'instagram', account: seen.account, digest: seen.digest } },
    headers: as.olivia,
  });
  assert.equal(late.status, 409, late.text);
  assert.match(late.json().error, /changed since you looked/);
  assert.equal((await one(ig)).state, 'draft', 'nothing was queued');
  const bare = await request('POST', `/api/posts/${ig}/publish`, { body: { confirm: { platform: 'instagram', account: seen.account } }, headers: as.olivia });
  assert.equal(bare.status, 400, 'a confirm without the digest is no confirm');
  const after = await one(ig);
  assert.notEqual(after.digest, seen.digest);
  const edits = after.history.filter((h) => h.state === 'draft' && /description/.test(String(h.note)));
  assert.ok(
    edits.some((h) => h.by !== 'Olivia'),
    `the agent's edit is in the history with who made it: ${JSON.stringify(after.history)}`,
  );
  // Olivia puts her words back (her own edit, in the history too)
  assert.equal((await request('PATCH', `/api/posts/${ig}`, { body: { description: 'New spot #launch' }, headers: as.olivia })).status, 200);
  assert.ok((await one(ig)).history.some((h) => h.by === 'Olivia' && /description/.test(String(h.note))));
});

test('a post Instagram refuses fails with its reason as a sentence, waits in the inbox of who may publish, and goes on retry', async () => {
  fakes.knobs.postFails = 'the video is too short for a Reel';
  const ok = await request('POST', `/api/posts/${ig}/publish`, { body: await confirmOf(ig), headers: as.olivia });
  assert.equal(ok.status, 200, ok.text);
  await run();
  const p = await one(ig);
  assert.equal(p.state, 'failed');
  assert.equal(p.error, 'The video is too short for a Reel.');
  const sent = [...fakes.posts.values()].at(-1);
  assert.ok(sent?.media, 'the file went to the provider’s storage first');
  assert.equal(sent?.body.content, 'New spot #launch\n\n#spring', 'tags join the caption as hashtags');
  const platforms = sent?.body.platforms as { platformSpecificData: Record<string, unknown> }[];
  assert.equal(platforms[0]?.platformSpecificData.contentType, 'reels');
  assert.equal(platforms[0]?.platformSpecificData.thumbOffset, 500, 'the cover frame as a thumb offset (frame 12 at 25 fps)');
  const put = fakes.seen.find((s) => s.method === 'PUT' && s.path.startsWith('/zernio-storage/'));
  assert.ok(put && !put.headers.authorization, 'the presigned upload gets no key');
  const inbox = (await request('GET', '/api/for-you', { headers: as.olivia })).json().items as ForYouItem[];
  const item = inbox.find((i) => i.kind === 'post');
  assert.ok(item, JSON.stringify(inbox.map((i) => i.kind)));
  assert.equal(item.post?.error, 'The video is too short for a Reel.');
  assert.equal(item.dismissible, false, 'work, not news');
  const maxInbox = (await request('GET', '/api/for-you', { headers: as.max })).json().items as ForYouItem[];
  assert.ok(!maxInbox.some((i) => i.kind === 'post'), 'only for who may publish');
  // Zernio holds the failed post: Retry asks Zernio again, it doesn't post a second one (A12 PUB-1)
  const made = fakes.posts.size;
  assert.equal((await request('POST', `/api/posts/${ig}/retry`, { headers: as.olivia })).status, 200);
  await run();
  assert.equal((await one(ig)).state, 'failed', 'Zernio still says it failed');
  assert.equal(fakes.posts.size, made, 'nothing posted again');
  // posting it again is the person's explicit choice
  fakes.knobs.postSlow = true;
  const again = await request('POST', `/api/posts/${ig}/retry`, { body: { again: true }, headers: as.olivia });
  assert.equal(again.status, 200, again.text);
  await run();
  assert.equal(fakes.posts.size, made + 1);
  assert.equal((await one(ig)).state, 'uploading', 'sent: the platform is still at it');
  // looked at again a minute later
  const later = ctx.publisher;
  const post = await one(ig);
  assert.ok(post.next_try);
  // move the clock: the queue's next look
  const { changePost } = await import('../../lib/publish/posts.ts');
  changePost(ig, (x) => {
    x.next_try = new Date(Date.now() - 1000).toISOString();
  });
  await later.tick();
  await later.idle();
  const out = await one(ig);
  assert.equal(out.state, 'posted');
  assert.match(String(out.url), /instagram\.example\/p\//);
  const after = (await request('GET', '/api/for-you', { headers: as.olivia })).json().items as ForYouItem[];
  assert.ok(!after.some((i) => i.kind === 'post'), 'it leaves the inbox once it went out');
});

test('the kit: an encode, the cover, the copy and a ZIP of them, for anyone who may draft', async () => {
  // a workspace whose job queue is full gets no kit queued past the cap (A12 PUB-4: kit encodes are no owed work)
  const { QUEUE_LIMITS } = await import('../../lib/jobs.ts');
  const cap = QUEUE_LIMITS.perWorkspace;
  QUEUE_LIMITS.perWorkspace = 0;
  try {
    const full = await request('POST', `/api/posts/${yt}/kit`, { headers: as.max });
    assert.equal(full.status, 503, full.text);
    assert.match(full.json().error, /jobs waiting/);
  } finally {
    QUEUE_LIMITS.perWorkspace = cap;
  }
  const start = await request('POST', `/api/posts/${yt}/kit`, { headers: as.max });
  assert.equal(start.status, 202, start.text);
  // one heavy job at a time: the upload's Auto-check may run first
  for (let i = 0; i < 1200; i++) {
    const k = (await request('GET', `/api/posts/${yt}/kit`, { headers: as.max })).json();
    if (k.state === 'ready') break;
    assert.notEqual(k.state, 'failed', JSON.stringify(k));
    await new Promise((r) => setTimeout(r, 100));
  }
  const kit = (await request('GET', `/api/posts/${yt}/kit`, { headers: as.max })).json();
  assert.deepEqual(kit.files.map((f: { kind: string }) => f.kind).sort(), ['copy', 'cover', 'video', 'zip']);
  const copy = await request('GET', `/api/posts/${yt}/kit/spot-youtube-copy.txt`, { headers: as.max });
  assert.equal(copy.status, 200);
  assert.match(String(copy.headers['content-disposition']), /attachment/);
  assert.equal(copy.text, 'Spring launch\n\nThe new spot.\n\nTags: launch, spring\n');
  const zip = await request('GET', `/api/posts/${yt}/kit/kit.zip`, { headers: as.max });
  assert.equal(zip.status, 200);
  assert.equal(Number(zip.headers['content-length']), kit.files.find((f: { name: string }) => f.name === 'kit.zip').bytes);
  assert.equal((await request('GET', `/api/posts/${yt}/kit/..%2Fkit.json`, { headers: as.max })).status, 404);
  assert.equal((await request('GET', `/api/posts/${yt}/kit`, { headers: as.rita })).status, 403, 'a reviewer doesn’t take the kit');
});

test('reopening the final pauses what waits; a schedule Lampo sends never goes out for a version that isn’t final', async () => {
  const fb = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, {
    body: { platform: 'facebook', connection: zc.id, ai_generated: false, schedule_at: new Date(Date.now() + 3600e3).toISOString() },
    headers: as.olivia,
  });
  assert.equal(fb.status, 201, fb.text);
  assert.ok(
    fb.json().problems.every((x: { code: string }) => x.code !== 'schedule_awake'),
    'a hosted server is always awake',
  );
  const pub = await request('POST', `/api/posts/${fb.json().id}/publish`, { body: await confirmOf(fb.json().id), headers: as.olivia });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json().state, 'queued');
  await run();
  assert.equal((await one(fb.json().id)).state, 'queued', 'it waits for its time');
  const reopen = await request('DELETE', `/api/review/${encodeURIComponent(slug)}/final`, { headers: as.olivia });
  assert.equal(reopen.status, 200, reopen.text);
  await run();
  const p = await one(fb.json().id);
  assert.equal(p.state, 'cancelled');
  assert.match(String(p.error), /^Paused: the video was reopened/);
  const draft = await request('POST', `/api/review/${encodeURIComponent(slug)}/posts`, { body: { platform: 'instagram' }, headers: as.agent });
  assert.equal(draft.status, 409, 'not final: no drafts');
});

test('secrets stay sealed: not in the store in clear, not in any answer or event, not in the log', async () => {
  const raw = fs.readFileSync(path.join(dir, 'data/publish/connections.json'), 'utf8');
  const events = fs.readFileSync(path.join(dir, 'data/events.jsonl'), 'utf8');
  const postsFile = fs.readFileSync(path.join(dir, 'data/publish/posts.json'), 'utf8');
  const answers = [
    (await request('GET', '/api/publish/connections', { headers: as.olivia })).text,
    (await request('GET', '/api/posts', { headers: as.olivia })).text,
  ].join('\n');
  const tokens = fakes.seen.flatMap((s) => (s.headers.authorization ? [String(s.headers.authorization).replace(/^Bearer /, '')] : []));
  const refresh = [...new Set(fakes.seen.flatMap((s) => (s.path === '/google/token' ? [new URLSearchParams(s.body).get('refresh_token') ?? ''] : [])))].filter(
    Boolean,
  );
  const secrets = [fakes.clientSecret, fakes.apiKey, ...tokens, ...refresh];
  assert.ok(secrets.length >= 4);
  for (const s of secrets) {
    assert.ok(!raw.includes(s), 'connections.json holds no secret in clear');
    assert.ok(!events.includes(s), 'no secret in events');
    assert.ok(!postsFile.includes(s), 'no secret in posts.json');
    assert.ok(!answers.includes(s), 'no secret in an answer');
    assert.ok(!said.join('\n').includes(s), 'no secret in the log');
  }
  assert.equal(fs.statSync(path.join(dir, 'data/publish/connections.json')).mode & 0o077, 0, 'the file is the server’s alone');
  // a sealed secret moved to another record doesn't open
  const { unseal } = await import('../../lib/publish/seal.ts');
  const stored = JSON.parse(raw).connections as { id: string; sealed: string }[];
  assert.ok(unseal(stored[0]?.id as string, stored[0]?.sealed));
  assert.equal(unseal(stored[1]?.id as string, stored[0]?.sealed), null);
  // removing YouTube revokes its sign-in at Google
  const del = await request('DELETE', `/api/publish/connections/${ytConn.id}`, { headers: as.olivia });
  assert.equal(del.status, 200);
  assert.ok(fakes.seen.some((s) => s.path === '/google/revoke'));
});

test('vr post against the hosted server: an agent with its person’s token drafts and reads; nothing it can call publishes', async () => {
  ok(await request('PUT', `/api/review/${encodeURIComponent(slug)}/final`, { body: { v: 1 }, headers: as.olivia }));
  const home = tmpdir('vr-agent-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    VR_DATA: path.join(home, 'no-local-store'),
    VR_CACHE: path.join(home, 'no-local-cache'),
    VR_SERVER: `http://127.0.0.1:${port}`,
    VR_TOKEN: String(as.agent.Authorization).slice('Bearer '.length),
    VR_BY: 'agent:writer',
  };
  delete env.VR_MODE;
  const vr = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [VR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => {
        out += d;
      });
      p.stderr.on('data', (d) => {
        err += d;
      });
      p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    });
  // the paused Facebook post is the person's to bring back (A12 PUB-6): the agent's draft is refused, a person's isn't
  const drafted = await vr(['post', 'draft', 'spot.mp4', '--platform', 'fb', '--text', 'Spring is here', '--ai', 'no']);
  assert.notEqual(drafted.code, 0);
  assert.match(drafted.err, /a person changes it in the app/);
  const fb = (await posts()).find((x) => x.platform === 'facebook') as PostView;
  const back = await request('PATCH', `/api/posts/${fb.id}`, { body: { description: 'Spring is here' }, headers: as.olivia });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json().state, 'draft', 'a draft again');
  const listed = await vr(['post', 'spot.mp4']);
  // (its connection was removed above: the post keeps its link, without the channel's name)
  assert.match(listed.out, /YouTube V1 posted https:\/\/www\.youtube\.com\/watch\?v=vid_/);
  assert.match(listed.out, /Instagram V1 posted/);
  assert.match(listed.out, /Facebook V1 drafted \(Studio Page\) · ready for a person to publish/);
  const posted = await vr(['post', 'draft', 'spot.mp4', '--platform', 'ig']);
  assert.notEqual(posted.code, 0);
  assert.match(posted.err, /posted already: it is out/);
});

function ok(r: Awaited<ReturnType<Request>>) {
  assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${r.text.slice(0, 200)}`);
  return r;
}
