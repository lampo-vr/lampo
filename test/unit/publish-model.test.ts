// What a post may say, per platform (lib/publish/platforms.ts, pure): the platforms' limits as blocks and warnings, the
// answers a person gives (never defaulted), what only blocks when a person publishes, the YouTube lock on an unaudited
// project and the machine that must be awake; the fields as kept (lib/publish/posts.ts cleanFields), the copy, the
// caption with hashtags, and the permission table's new actions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { postProblems, publishable, copyText, platformOf, hashtagsIn, problemsLine, PLATFORM_LIMITS } = await import('../../lib/publish/platforms.ts');
const { cleanFields, PostError, postLine } = await import('../../lib/publish/posts.ts');
const { captionOf } = await import('../../lib/publish/zernio.ts');
const { can, ROLE_ACTIONS } = await import('../../lib/permissions.ts');
const { SCOPES, scopeAllows } = await import('../../lib/scopes.ts');
type PostFacts = import('../../lib/publish/platforms.ts').PostFacts;

const vertical = { duration: 20, width: 1080, height: 1920, frames: 500 };
const wide = { duration: 20, width: 1920, height: 1080, frames: 500 };
const yt = (over: Partial<PostFacts> = {}): PostFacts => ({
  platform: 'youtube',
  title: 'Spring launch',
  description: 'The new spot.',
  tags: ['launch'],
  visibility: 'public',
  cover_frame: null,
  schedule_at: null,
  ai_generated: false,
  youtube: { made_for_kids: false, category: '22' },
  connection: 'pc_1',
  account: 'UC1',
  ...over,
});
const ytConn = {
  state: 'ready' as const,
  platforms: ['youtube' as const],
  accounts: [{ id: 'UC1', platform: 'youtube' as const, name: 'Channel' }],
  audited: true,
  holds_schedule: true,
};
const zConn = {
  state: 'ready' as const,
  platforms: ['instagram' as const, 'facebook' as const],
  accounts: [
    { id: 'ig1', platform: 'instagram' as const, name: 'IG' },
    { id: 'fb1', platform: 'facebook' as const, name: 'Page' },
  ],
  holds_schedule: false,
};
const codes = (p: ReturnType<typeof postProblems>) => p.map((x) => `${x.level}:${x.code}`);

test('a clean YouTube post has nothing to say; the platforms are known by name or short code', () => {
  assert.deepEqual(postProblems(yt(), wide, { connection: ytConn, publishing: true }), []);
  assert.equal(platformOf('yt'), 'youtube');
  assert.equal(platformOf(' IG '), 'instagram');
  assert.equal(platformOf('fb'), 'facebook');
  assert.equal(platformOf('tiktok'), null, 'not yet');
});

test('YouTube’s limits: a title of 100 characters, no angle brackets, a description of 5000 bytes, tags of 500 together', () => {
  assert.deepEqual(codes(postProblems(yt({ title: 'x'.repeat(101) }), wide, { connection: ytConn })), ['block:title_long']);
  assert.deepEqual(codes(postProblems(yt({ title: 'x'.repeat(100) }), wide, { connection: ytConn })), []);
  assert.deepEqual(codes(postProblems(yt({ title: 'a < b' }), wide, { connection: ytConn })), ['block:title_angle']);
  // 5000 bytes, not characters: ü is two
  assert.deepEqual(codes(postProblems(yt({ description: 'ü'.repeat(2501) }), wide, { connection: ytConn })), ['block:description_long']);
  assert.deepEqual(codes(postProblems(yt({ description: 'ü'.repeat(2500) }), wide, { connection: ytConn })), []);
  // 51 tags of 9 characters and the commas between them: 509
  const tags = Array.from({ length: 51 }, (_, i) => `tag${String(i).padStart(6, '0')}`);
  assert.deepEqual(codes(postProblems(yt({ tags }), wide, { connection: ytConn })), ['block:tags_long']);
  assert.deepEqual(codes(postProblems(yt({ title: '' }), wide, { connection: ytConn })), ['warn:title_missing']);
  assert.deepEqual(codes(postProblems(yt({ title: '' }), wide, { connection: ytConn, publishing: true })), ['block:title_missing']);
  assert.deepEqual(
    codes(postProblems(yt(), { ...wide, duration: 20 * 60 }, { connection: ytConn })),
    ['warn:youtube_verified'],
    'over 15 min: a verified account',
  );
  assert.deepEqual(codes(postProblems(yt(), { ...wide, duration: 13 * 3600 }, { connection: ytConn })), ['block:video_long']);
});

test('the answers a person gives are never defaulted: missing, they warn on a draft and block publishing', () => {
  const p = yt({ ai_generated: null, youtube: { made_for_kids: null } });
  assert.deepEqual(codes(postProblems(p, wide, { connection: ytConn })), ['warn:ai_missing', 'warn:kids_missing']);
  const at = postProblems(p, wide, { connection: ytConn, publishing: true });
  assert.deepEqual(codes(at), ['block:ai_missing', 'block:kids_missing']);
  assert.equal(publishable(at), false);
  assert.match(problemsLine(at), /^to fix: say whether it contains realistic AI-generated/);
});

test('YouTube on an unaudited project: a schedule or a public post stays private, said before it is sent', () => {
  const unaudited = { ...ytConn, audited: false };
  assert.deepEqual(codes(postProblems(yt(), wide, { connection: unaudited })), ['warn:youtube_locked']);
  assert.deepEqual(codes(postProblems(yt({ visibility: 'private' }), wide, { connection: unaudited })), [], 'asked private: nothing to warn about');
  const at = new Date(Date.now() + 3600e3).toISOString();
  const scheduled = postProblems(yt({ schedule_at: at }), wide, { connection: unaudited });
  assert.deepEqual(codes(scheduled), ['warn:youtube_locked']);
  assert.match(scheduled[0]?.message ?? '', /a schedule won't go public/);
  // a schedule must be public on YouTube: it makes the video public at its time
  assert.deepEqual(codes(postProblems(yt({ schedule_at: at, visibility: 'unlisted' }), wide, { connection: ytConn })), ['block:schedule_public']);
  assert.deepEqual(codes(postProblems(yt({ schedule_at: new Date(Date.now() - 3600e3).toISOString() }), wide, { connection: ytConn })), ['warn:schedule_past']);
  assert.deepEqual(codes(postProblems(yt({ schedule_at: new Date(Date.now() + 400 * 86400e3).toISOString() }), wide, { connection: ytConn })), [
    'block:schedule_far',
  ]);
});

test('Instagram: a caption of 2200, 30 hashtags, 3 s to 15 min, public only, a Reel wants 9:16; no AI label through the API yet', () => {
  const ig = (over: Partial<PostFacts> = {}): PostFacts => ({
    ...yt({ platform: 'instagram', youtube: undefined, account: 'ig1', connection: 'pc_2', title: '' }),
    ...over,
  });
  assert.deepEqual(codes(postProblems(ig(), vertical, { connection: zConn })), [], 'no title wanted');
  assert.deepEqual(codes(postProblems(ig({ description: 'x'.repeat(2201) }), vertical, { connection: zConn })), ['block:description_long']);
  const many = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.deepEqual(codes(postProblems(ig({ description: many, tags: [] }), vertical, { connection: zConn })), ['block:hashtags_many']);
  assert.deepEqual(codes(postProblems(ig(), { ...vertical, duration: 2 }, { connection: zConn })), ['block:video_short']);
  assert.deepEqual(codes(postProblems(ig(), { ...vertical, duration: 16 * 60 }, { connection: zConn })), ['block:video_long']);
  assert.deepEqual(codes(postProblems(ig({ visibility: 'unlisted' }), vertical, { connection: zConn })), ['block:visibility_unknown']);
  assert.deepEqual(codes(postProblems(ig(), wide, { connection: zConn })), ['warn:aspect']);
  assert.deepEqual(codes(postProblems(ig({ instagram: { kind: 'feed' } }), wide, { connection: zConn })), [], 'the feed takes any shape');
  assert.deepEqual(codes(postProblems(ig({ ai_generated: true }), vertical, { connection: zConn })), ['warn:ai_caption']);
  assert.deepEqual(
    codes(postProblems(ig({ account: 'fb1' }), vertical, { connection: zConn })),
    ['warn:account_missing'],
    'a Facebook Page is no Instagram account',
  );
});

test('Facebook: a Reel up to 90 s, a video beyond; the Page is its account; Lampo sends a schedule, so the machine must be awake', () => {
  const fb = (over: Partial<PostFacts> = {}): PostFacts => ({
    ...yt({ platform: 'facebook', youtube: undefined, account: 'fb1', connection: 'pc_2' }),
    ...over,
  });
  assert.deepEqual(codes(postProblems(fb(), { ...vertical, duration: 120 }, { connection: zConn })), ['warn:facebook_not_reel']);
  assert.deepEqual(codes(postProblems(fb({ account: null }), vertical, { connection: zConn, publishing: true })), ['block:account_missing']);
  assert.match(postProblems(fb({ account: null }), vertical, { connection: zConn })[0]?.message ?? '', /choose the Facebook Page/);
  const at = new Date(Date.now() + 3600e3).toISOString();
  assert.deepEqual(codes(postProblems(fb({ schedule_at: at }), vertical, { connection: zConn })), ['warn:schedule_awake']);
  assert.deepEqual(codes(postProblems(fb({ schedule_at: at }), vertical, { connection: zConn, hosted: true })), [], 'a hosted server is always awake');
  assert.deepEqual(codes(postProblems(fb({ schedule_at: at }), vertical, { connection: { ...zConn, state: 'error' } })), [
    'warn:connection_not_ready',
    'warn:schedule_awake',
  ]);
  assert.deepEqual(codes(postProblems(fb({ connection: null }), vertical, { connection: null, publishing: true })), ['block:connection_missing']);
  assert.deepEqual(codes(postProblems(fb(), vertical, { connection: ytConn })), ['block:connection_platform']);
  assert.equal(PLATFORM_LIMITS.facebook.softMaxDuration, 90);
});

test('a cover frame must be in the video; the fields as kept are bounded and clean', () => {
  assert.deepEqual(codes(postProblems(yt({ cover_frame: 500 }), wide, { connection: ytConn })), ['block:cover_outside']);
  assert.deepEqual(codes(postProblems(yt({ cover_frame: 499 }), wide, { connection: ytConn })), []);
  const f = cleanFields('youtube', {
    title: '  Spring   launch \n',
    tags: ['#launch', 'launch', ' two  words ', '', 'x'.repeat(200)],
    schedule_at: '2026-10-09T14:00:00+02:00',
    cover_frame: 12.7,
    youtube: { category: '1', made_for_kids: false },
    instagram: { kind: 'feed' },
  });
  assert.equal(f.title, 'Spring launch');
  assert.deepEqual(f.tags, ['launch', 'two words', 'x'.repeat(120)]);
  assert.equal(f.schedule_at, '2026-10-09T12:00:00.000Z');
  assert.equal(f.cover_frame, 12);
  assert.deepEqual(f.youtube, { category: '1', made_for_kids: false });
  assert.equal(f.instagram, undefined, 'another platform’s fields are dropped');
  assert.throws(
    () => cleanFields('youtube', { schedule_at: 'tomorrow' }),
    (e: InstanceType<typeof PostError>) => e.status === 400 && /is no time/.test(e.message),
  );
  assert.throws(() => cleanFields('youtube', { youtube: { category: '99' } }), /99 is no YouTube category/);
});

test('the copy as text, the caption with hashtags, the line agents read', () => {
  assert.equal(copyText({ platform: 'youtube', title: 'Spring', description: 'The spot.', tags: ['a', 'b c'] }), 'Spring\n\nThe spot.\n\nTags: a, b c\n');
  assert.equal(copyText({ platform: 'instagram', title: '', description: 'The spot.', tags: ['a', 'b c'] }), 'The spot.\n\n#a #bc\n');
  assert.deepEqual(hashtagsIn('New #spot, #Launch_2026 and a#nottag'), ['#spot', '#Launch_2026']);
  assert.equal(captionOf({ description: 'New #Spot', tags: ['spot', 'launch'] }), 'New #Spot\n\n#launch');
  assert.equal(
    postLine({ platform: 'youtube', state: 'posted', url: 'https://y.example/1', schedule_at: null, v: 3, locked: true }, 'Channel'),
    'YouTube V3 posted (Channel) https://y.example/1 (kept private by YouTube: make it public in YouTube Studio)',
  );
  assert.equal(
    postLine({ platform: 'instagram', state: 'failed', url: null, schedule_at: null, v: 2, error: 'Too short.' }),
    'Instagram V2 failed: Too short.',
  );
});

test('post events: a push when a post went out, is scheduled or failed (never for a draft); a webhook line', async () => {
  const { bucketOf, message, DEFAULT_PREFS } = await import('../../lib/push/index.ts');
  const { describe } = await import('../../lib/webhooks.ts');
  const ev = (state: string, extra: Record<string, unknown> = {}) =>
    ({
      at: '2026-10-03T10:00:00+02:00',
      type: 'post',
      by: 'system',
      video: '/renders/spot.mp4',
      slug: 'spot',
      session: null,
      v: 3,
      text: `Instagram V3 ${state}`,
      post: { id: 'po_000000000001', platform: 'instagram', state, ...extra },
    }) as never;
  assert.equal(bucketOf(ev('draft')), null);
  assert.equal(bucketOf(ev('queued')), null);
  for (const s of ['posted', 'scheduled', 'failed']) assert.equal(bucketOf(ev(s)), 'post');
  const failed = message('post' as never, [ev('failed', { error: 'The video is too short.' })]);
  assert.deepEqual(
    { title: failed.title, body: failed.body, url: failed.url, category: failed.category },
    { title: 'spot.mp4: the Instagram post failed', body: 'The video is too short.', url: '#/v/spot?publish=po_000000000001', category: 'posts' },
  );
  assert.equal(message('post' as never, [ev('posted', { url: 'https://instagram.example/p/1' })]).title, 'spot.mp4 is on Instagram');
  assert.equal(DEFAULT_PREFS.posts, true, 'on unless a device turns it off (older subscriptions too)');
  assert.equal(describe(ev('posted')), 'spot.mp4: Instagram V3 posted');
});

test('who may: members and up draft, only owners and admins publish; no scope grants publishing', () => {
  assert.equal(can('member', 'post'), true);
  assert.equal(can('member', 'publish'), false);
  assert.equal(can('reviewer', 'post'), false);
  assert.equal(can('admin', 'publish'), true);
  assert.equal(can('owner', 'publish'), true);
  assert.ok(ROLE_ACTIONS.reviewer.has('view'));
  assert.ok(scopeAllows(['post:draft'], 'post'));
  for (const s of Object.values(SCOPES)) assert.ok(!(s.actions as readonly string[]).includes('publish'), 'no scope publishes');
});

test('PUB-14: a sealed secret opens only in its workspace, for its record', async () => {
  const { seal, unseal } = await import('../../lib/publish/seal.ts');
  const { inWorkspace } = await import('../../lib/scope.ts');
  const key = { api_key: 'sk_live_0123456789abcdef' };
  const sealed = inWorkspace('w1', () => seal('pc_000000000001', key));
  assert.deepEqual(
    inWorkspace('w1', () => unseal('pc_000000000001', sealed)),
    key,
    'it opens where it was sealed',
  );
  assert.equal(
    inWorkspace('w_0123456789ab', () => unseal('pc_000000000001', sealed)),
    null,
    'another workspace, the same record id: it doesn’t open',
  );
  assert.equal(
    inWorkspace('w1', () => unseal('pc_000000000002', sealed)),
    null,
    'another record of the same workspace: it doesn’t open',
  );
  assert.equal(
    inWorkspace('w1', () => unseal('pc_000000000001', `${sealed}x`)),
    null,
    'a changed byte doesn’t open',
  );
});
