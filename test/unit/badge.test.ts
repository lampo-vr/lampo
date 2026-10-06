// "Powered by Lampo" on review links (A13 CLOUD-7): on by default on every plan, a paid workspace's owners and admins may
// hide it (Settings → Review links). The review link's answer carries `badge`: shown unless the link's workspace is on a
// plan that may hide it (the billing provider's `canHideBadge`) and its admins did — a plan that lapses shows it again
// without anyone touching the setting. Without a billing provider nobody may hide it. People only, admins only, per
// workspace: another workspace's choice never reaches this one's links.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { NO_EXTENSION } = await import('../../server/extension.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };

async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), ...origin };
}

const mia = await auth.createUser({ email: 'mia@example.com', name: 'Mia', password: PASSWORD, role: 'owner' });
await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const owner = await signIn('mia@example.com');
const member = await signIn('max@example.com');
const token = { Authorization: `Bearer ${auth.createToken(mia.id, 'agent').token}` };

// the billing provider's answer per workspace (what Lampo Cloud says: a paid plan may hide it)
const paid = new Set<string>();
const billing = () => {
  ctx.extension = { ...NO_EXTENSION, name: 'test-billing', billing: true, badgeOptional: async (w: string) => paid.has(w) };
};

const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
age(clip);
const up = await tusUpload(request, clip, { filename: 'spot.mp4' }, token);
assert.equal(up.status, 200, up.text);
const slug = up.json().slug as string;
const share = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Client' }, headers: owner });
assert.equal(share.status, 200, share.text);
const linkToken = share.json().token as string;
const visitor = { 'x-forwarded-for': '203.0.113.7' };
const badgeOnLink = async () => (await request('GET', `/api/g/${linkToken}`, { headers: visitor })).json().badge;

test('without a billing provider the badge shows on every link and nobody may hide it', async () => {
  assert.equal(await badgeOnLink(), true);
  const got = await request('GET', '/api/workspaces/current/badge', { headers: owner });
  assert.equal(got.status, 200, got.text);
  assert.deepEqual(got.json(), { shown: true, hidden: false, may: false });
  const hide = await request('PUT', '/api/workspaces/current/badge', { body: { hidden: true }, headers: owner });
  assert.equal(hide.status, 402, hide.text);
  assert.equal(ws.badgeHidden('w1'), false, 'nothing kept');
  assert.equal(await badgeOnLink(), true);
});

test('on Free or in a trial it stays: hiding it is a paid plan’s', async () => {
  billing();
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: true }, headers: owner })).status, 402);
  assert.deepEqual((await request('GET', '/api/workspaces/current/badge', { headers: owner })).json(), { shown: true, hidden: false, may: false });
  assert.equal(await badgeOnLink(), true);
});

test('a paid workspace’s admin hides it: its links say badge: false', async () => {
  paid.add('w1');
  assert.deepEqual((await request('GET', '/api/workspaces/current/badge', { headers: owner })).json(), { shown: true, hidden: false, may: true });
  const hide = await request('PUT', '/api/workspaces/current/badge', { body: { hidden: true }, headers: owner });
  assert.equal(hide.status, 200, hide.text);
  assert.deepEqual(hide.json(), { shown: false, hidden: true, may: true });
  assert.equal(await badgeOnLink(), false);
  // a member reads whether it shows (the link-opened moment says so), only admins change it, never a token
  assert.deepEqual((await request('GET', '/api/workspaces/current/badge', { headers: member })).json(), { shown: false, hidden: true, may: true });
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: false }, headers: member })).status, 403);
  const byToken = await request('PUT', '/api/workspaces/current/badge', { body: { hidden: false }, headers: token });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: 'yes' }, headers: owner })).status, 400);
  assert.equal((await request('GET', `/api/workspaces/current/badge`)).status, 401, 'signed out');
});

test('the plan lapses: the links show it again, the choice is kept for when it may hide it once more', async () => {
  paid.delete('w1');
  assert.equal(await badgeOnLink(), true);
  assert.deepEqual((await request('GET', '/api/workspaces/current/badge', { headers: owner })).json(), { shown: true, hidden: true, may: false });
  paid.add('w1');
  assert.equal(await badgeOnLink(), false);
  // showing it again is always allowed, paid or not
  paid.delete('w1');
  const show = await request('PUT', '/api/workspaces/current/badge', { body: { hidden: false }, headers: owner });
  assert.equal(show.status, 200, show.text);
  assert.deepEqual(show.json(), { shown: true, hidden: false, may: false });
});

test('a module that fails shows the badge; another workspace’s choice never reaches this one’s links', async () => {
  paid.add('w1');
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: true }, headers: owner })).status, 200);
  const other = ws.createWorkspace({ name: 'Mia Freelance', ownerId: mia.id });
  paid.add(other.id);
  const sw = await request('POST', '/api/workspaces/switch', { body: { id: other.id }, headers: await signIn('mia@example.com') });
  assert.equal(sw.status, 200, sw.text);
  const there = { Cookie: cookieFrom(sw), ...origin };
  assert.deepEqual((await request('GET', '/api/workspaces/current/badge', { headers: there })).json(), { shown: true, hidden: false, may: true });
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: false }, headers: there })).status, 200);
  assert.equal(await badgeOnLink(), false, 'w1’s link keeps w1’s choice');
  // whatever goes wrong in billing, a visitor's page opens, with the badge
  ctx.extension = {
    ...ctx.extension,
    badgeOptional: async () => {
      throw new Error('billing is down');
    },
  };
  const r = await request('GET', `/api/g/${linkToken}`, { headers: visitor });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json().badge, true);
});

test('the real wrapper: a module whose canHideBadge throws or says anything but true lets nobody hide it', async () => {
  const { createExtension, hostContext } = await import('../../server/extension.ts');
  const logs: string[] = [];
  const host = hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false, log: (e) => logs.push(e) });
  const base = { name: 'm', routes: [], workspaces: {} };
  const entitlements = (canHideBadge?: () => Promise<unknown>) =>
    ({
      get: async () => ({}),
      canUpload: async () => ({ ok: true }),
      canAddMember: async () => ({ ok: true }),
      canAddVideo: async () => ({ ok: true }),
      canShare: async () => ({ ok: true }),
      ...(canHideBadge ? { canHideBadge } : {}),
    }) as never;
  assert.equal(await createExtension({ ...base, entitlements: entitlements() }, host).badgeOptional('w1'), false, 'a module without the question');
  assert.equal(await createExtension({ ...base, entitlements: entitlements(async () => 'yes') }, host).badgeOptional('w1'), false, 'only true counts');
  const failing = createExtension(
    {
      ...base,
      entitlements: entitlements(async () => {
        throw new Error('down');
      }),
    },
    host,
  );
  assert.equal(await failing.badgeOptional('w1'), false);
  assert.ok(logs.includes('extension.badge.failed'));
  assert.equal(await createExtension({ ...base, entitlements: entitlements(async () => true) }, host).badgeOptional('w1'), true);
});

// An Embed link's player shows the Lampo mark in its corner by the same rule, and its oEmbed names Lampo as the
// provider only while the mark shows. oEmbed answers for this server's own address only.
test('an embed shows the mark, and its oEmbed names Lampo, by the same rule', async () => {
  billing();
  paid.add('w1');
  assert.equal((await request('PUT', '/api/workspaces/current/badge', { body: { hidden: true }, headers: owner })).status, 200);
  const made = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Website', embed: true }, headers: owner });
  assert.equal(made.status, 200, made.text);
  const embed = made.json().token as string;
  const player = async () => (await request('GET', `/api/g/${embed}/embed`, { headers: visitor })).json().badge;
  const oembed = (url = `${PUBLIC}/e/${embed}`) => request('GET', `/oembed?url=${encodeURIComponent(url)}`, { headers: visitor });
  assert.equal(await player(), false, 'hidden on a paid plan');
  const quiet = (await oembed()).json();
  assert.equal(quiet.provider_name, undefined);
  assert.equal(quiet.provider_url, undefined);
  paid.delete('w1');
  assert.equal(await player(), true, 'the plan lapsed: the mark is back');
  assert.equal((await oembed()).json().provider_name, 'Lampo');
  assert.equal((await oembed(`https://elsewhere.test/e/${embed}`)).status, 404, 'another server’s address');
});
