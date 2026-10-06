// The extension point (server/extension.ts): without a module the app is complete and unlimited; with one (Lampo
// Cloud's billing, here a stand-in loaded from VR_CLOUD_MODULE's file) a workspace's plan can refuse what costs storage
// or a seat — a new upload, video, member or review link — with one 402 sentence, while reviewing, notes and approvals
// keep working; the module hears workspaces made and member counts changed, counts usage through the host, and mounts
// its routes (one public, raw-bodied, like a payment provider's webhook).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import type { Route } from '../../server/extension.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const ext = await import('../../server/extension.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const PUBLIC = 'http://review.test';
const origin = { Origin: PUBLIC };

// The stand-in module: workspace "Locked" is read-only; every other one may do anything. It records what it heard.
const MODULE = path.join(dir, 'cloud-module.ts');
fs.writeFileSync(
  MODULE,
  `const heard = [];
const locked = new Set();
export default async (host, env) => ({
  name: 'stand-in',
  heard, locked,
  contentSecurity: { script: ['https://js.stripe.com', 'https://*.js.stripe.com'], frame: ['https://js.stripe.com', 'https://hooks.stripe.com'], connect: ['https://api.stripe.com'] },
  entitlements: {
    get: async (w) => ({ plan: locked.has(w) ? 'free' : 'team', usage: await host.usage(w) }),
    canUpload: async (w, bytes) => locked.has(w) ? { ok: false, reason: 'read-only', message: 'This workspace is read-only until its invoice is paid.', upgrade: 'team' } : bytes > 5e6 ? { ok: false, reason: 'storage', message: 'This workspace has used its 10 GB.' } : { ok: true },
    canAddMember: async (w) => locked.has(w) ? { ok: false, reason: 'read-only', message: 'No new members while read-only.' } : { ok: true },
    canAddVideo: async (w) => locked.has(w) ? { ok: false, reason: 'read-only', message: 'No new videos while read-only.' } : { ok: true },
    canShare: async (w) => locked.has(w) ? { ok: false, reason: 'read-only', message: 'No new review links while read-only.' } : { ok: true },
  },
  routes: [
    { method: 'GET', path: '/api/billing', role: 'reviewer', handle: async (req) => { const who = host.who(req); return who ? { status: 200, json: { who, env: env.MARK } } : { status: 401, json: { error: 'sign in' } }; } },
    { method: 'POST', path: '/api/billing/webhook', raw: true, public: true, handle: async (req) => ({ status: 200, json: { bytes: req.rawBody.length, origin: host.sameOrigin(req) } }) },
    { method: 'GET', path: '/api/billing/broken', role: 'reviewer', handle: async () => ({ status: 500, json: { error: 'No active Stripe price has the lookup key lampo_solo_month_usd: run the catalog script', code: 'price-missing' } }) },
    { method: 'GET', path: '/api/billing/refused', role: 'reviewer', handle: async () => ({ status: 409, json: { error: 'This workspace has no billing account yet: choose a plan first.', code: 'no-billing-account' } }) },
    { method: 'GET', path: '/api/billing/off', role: 'reviewer', handle: async () => ({ status: 503, public: true, json: { error: 'Paying isn’t set up on this server yet.', code: 'unavailable', extra: 'cus_secret' } }) },
    { method: 'GET', path: '/api/billing/declined', role: 'reviewer', handle: async () => ({ status: 502, public: true, json: { error: 'The payment provider refused: Your card was declined.\\nsecond line', code: 'stripe' } }) },
    { method: 'GET', path: '/api/billing/loud', role: 'reviewer', handle: async () => ({ status: 500, public: true, json: { error: 'No active Stripe price has the lookup key lampo_x: run the catalog script', code: 'price-missing' } }) },
  ],
  workspaces: {
    created: async (e) => { heard.push(['created', e.workspace, e.members, e.email]); },
    membersChanged: async (e) => { heard.push(['members', e.workspace, e.members]); },
  },
});
`,
);

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const host = ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) });
ctx.extension = await ext.loadExtension(host, { ...process.env, VR_CLOUD_MODULE: MODULE, MARK: 'from env' });
const { request } = await startApp({ ctx, headers: { Host: 'review.test' } });

test('without a module: nothing is limited, mounted or heard', async () => {
  assert.equal(await ext.loadExtension(ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false }), {}), ext.NO_EXTENSION);
  assert.equal(ext.NO_EXTENSION.name, null);
  await ext.NO_EXTENSION.check('w1', 'upload', 1e15);
  await ext.NO_EXTENSION.check('w1', 'share');
  assert.deepEqual(ext.NO_EXTENSION.routes, []);
  assert.equal(await ext.NO_EXTENSION.entitlements('w1'), null);
  // a fresh context has none
  assert.equal(createContext({ cfg: loadConfig(), token: 'x' }).extension, ext.NO_EXTENSION);
});

let owner = '';
let locked = '';
let open = '';
before(async () => {
  const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' }, headers: origin });
  owner = String([login.headers['set-cookie']].flat()[0]).split(';')[0];
  locked = ws.createWorkspace({ name: 'Locked', ownerId: olivia.id }).id;
  open = ws.createWorkspace({ name: 'Open', ownerId: olivia.id }).id;
});

const inWs = async (id: string) => {
  const r = await request('POST', '/api/workspaces/switch', { body: { id }, headers: { Cookie: owner, ...origin } });
  assert.equal(r.status, 200, r.text);
  return String([r.headers['set-cookie']].flat()[0]).split(';')[0];
};

test('the module hears workspaces made and member counts changed, and counts usage through the host', async () => {
  // the stand-in's own state lives in the instance the app loaded: reach it through what it heard
  const billing = await request('GET', '/api/billing', { headers: { Cookie: owner } });
  assert.equal(billing.status, 200, billing.text);
  assert.equal(billing.json().env, 'from env');
  assert.equal(billing.json().who.account, auth.findUserByEmail('olivia@example.com')?.id);
  assert.equal(billing.json().who.role, 'owner');
  // a module route is mounted under the guard: signed out it never runs
  assert.equal((await request('GET', '/api/billing')).status, 401);
  // a public, raw one: a payment provider signs exact bytes
  const hook = await request('POST', '/api/billing/webhook', { body: Buffer.from('{"id":"evt_1"}'), headers: { 'content-type': 'application/json' } });
  assert.equal(hook.status, 200, hook.text);
  assert.equal(hook.json().bytes, 14);
  const usage = ext.usageOf(open);
  assert.deepEqual(usage, { bytes: 0, members: 1, activeVideos: 0, room: { videos: 0, bytes: 0 } });
});

test('a read-only workspace: no new uploads, videos, members or review links — with the module’s sentence', async () => {
  const lockedCookie = await inWs(locked);
  assert.equal(ctx.extension.name, 'stand-in');
  // the plan of "Locked" goes read-only (in the stand-in, a set its decisions read)
  (await lockOf()).add(locked);
  const clip = makeVideo(path.join(dir, 'clip.mp4'), { dur: 0.5 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'clip.mp4', folder: 'Reels' }, { Cookie: lockedCookie, ...origin });
  assert.equal(up.status, 402, up.text);
  assert.match(up.text, /read-only until its invoice is paid/);
  const ticket = await request('POST', '/api/uploads/tickets', { body: { filename: 'x.mp4', folder: 'Reels' }, headers: { Cookie: lockedCookie, ...origin } });
  assert.equal(ticket.status, 200, 'a ticket is only a URL; its upload is checked');
  const put = await request('PUT', new URL(ticket.json().url, PUBLIC).pathname, {
    body: fs.readFileSync(clip),
    headers: { 'content-length': String(fs.statSync(clip).size) },
  });
  assert.equal(put.status, 402, put.text);
  const invite = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: lockedCookie, ...origin } });
  assert.equal(invite.status, 402);
  assert.equal(invite.json().error, 'No new members while read-only.');
  assert.equal(invite.json().reason, 'read-only');
  const user = await request('POST', '/api/admin/users', {
    body: { email: 'x@example.com', name: 'X', password: 'a long password', role: 'member' },
    headers: { Cookie: lockedCookie, ...origin },
  });
  assert.equal(user.status, 402);
  // what is already there keeps working: a video put in place before the lock, its notes, approvals and links
  const slug = inWorkspace(locked, () => {
    const video = makeVideo(path.join(dir, 'kept.mp4'), { dur: 0.5 });
    age(video);
    return slugify(store.createOrGetReview(video, { by: 'setup' }).review.video);
  });
  const share = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: {}, headers: { Cookie: lockedCookie, ...origin } });
  assert.equal(share.status, 402);
  assert.equal(share.json().error, 'No new review links while read-only.');
  const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, {
    body: { v: 1, frame: 3, text: 'still reviewable', severity: 'should' },
    headers: { Cookie: lockedCookie, ...origin },
  });
  assert.equal(note.status, 200, note.text);
  const approve = await request('PUT', `/api/review/${encodeURIComponent(slug)}/approval`, {
    body: { status: 'approved', v: 1 },
    headers: { Cookie: lockedCookie, ...origin },
  });
  assert.equal(approve.status, 200, approve.text);
  // the other workspace is not affected at all — but its storage limit is the plan's sentence too
  const openCookie = await inWs(open);
  const ok = await tusUpload(request, clip, { filename: 'clip.mp4', folder: 'Reels' }, { Cookie: openCookie, ...origin });
  assert.equal(ok.status, 200, ok.text);
  const big = await request('POST', '/api/uploads', {
    headers: {
      Cookie: openCookie,
      ...origin,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(6e6),
      'Upload-Metadata': `filename ${Buffer.from('big.mp4').toString('base64')}`,
    },
  });
  assert.equal(big.status, 402);
  assert.match(big.text, /used its 10 GB/);
});

test('an upload refused for room: a person’s browser reads the refusal’s reason and numbers, an agent the sentence alone', async () => {
  const openCookie = await inWs(open);
  const tus = (headers: Record<string, string>) =>
    request('POST', '/api/uploads', {
      headers: {
        ...headers,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(6e6),
        'Upload-Metadata': `filename ${Buffer.from('big.mp4').toString('base64')}`,
      },
    });
  // a person's browser: the sentence with what the limit's sheet needs beside it (as JSON, like every other 402)
  const big = await tus({ Cookie: openCookie, ...origin });
  assert.equal(big.status, 402);
  const said = JSON.parse(big.text);
  assert.equal(said.error, 'This workspace has used its 10 GB.');
  assert.equal(said.reason, 'storage');
  // an agent (an API token) and `vr` read the plan's sentence as before, nothing else
  const olivia = auth.findUserByEmail('olivia@example.com');
  assert.ok(olivia);
  const { token } = auth.createToken(olivia.id, 'agent', { workspace: open });
  const agent = await tus({ Authorization: `Bearer ${token}` });
  assert.equal(agent.status, 402);
  assert.equal(agent.text.trim(), 'This workspace has used its 10 GB.');
});

/** The stand-in's `locked` set, from the very instance the app loaded (modules are cached by URL). */
async function lockOf(): Promise<Set<string>> {
  const factory = ((await import(MODULE)) as { default: (h: unknown, e: unknown) => Promise<{ locked: Set<string> }> }).default;
  // the factory closes over module-level state: a second call shares the same `locked` set
  return (await factory(null, {})).locked;
}

test('hooks: a workspace made, members joining and leaving reach the module (never blocking the app)', async () => {
  const factory = ((await import(MODULE)) as { default: (h: unknown, e: unknown) => Promise<{ heard: unknown[][] }> }).default;
  const { heard } = await factory(null, {});
  assert.deepEqual(heard.slice(0, 2), [
    ['created', locked, 1, 'olivia@example.com'],
    ['created', open, 1, 'olivia@example.com'],
  ]);
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  ws.addMember(open, rita.id, 'member');
  ws.removeMember(open, rita.id);
  assert.deepEqual(heard.slice(-2), [
    ['members', open, 2],
    ['members', open, 1],
  ]);
});

// A module route with the method and path of one the app answers itself: the app's handler would answer it, yet the
// guard's `public` and the role table's `own` would take the module's word for it — the app's library, open to anyone
// (sweep 2 SW-6). Such a module is refused when the app starts, in one sentence.
test('a module that names a route the app answers itself is refused at start, whatever the spelling of its pattern', () => {
  const allow = async () => ({ ok: true as const });
  const moduleWith = (route: { method: 'GET' | 'POST'; path: string; public?: boolean; role?: 'reviewer' }) =>
    ext.createExtension(
      {
        name: 'colliding',
        entitlements: { get: async () => null, canUpload: allow, canAddMember: allow, canAddVideo: allow, canShare: allow },
        routes: [{ ...route, handle: async () => ({ status: 200, json: { module: true } }) }],
        workspaces: {},
      },
      host,
    );
  for (const route of [
    { method: 'GET', path: '/api/library', public: true },
    { method: 'POST', path: '/api/review/some-video/comments' },
    { method: 'GET', path: '/healthz' },
    { method: 'POST', path: '/api/uploads/anything' },
  ] as const) {
    const c = createContext({ cfg: loadConfig(), token: 'unused' });
    c.extension = moduleWith(route);
    try {
      assert.throws(
        () => createApp(c),
        (e: Error) => e instanceof ext.ModuleRouteError && e.message.includes(`${route.method} ${route.path}`) && /the app’s own/.test(e.message),
        `${route.method} ${route.path}`,
      );
    } finally {
      c.extension.stop();
    }
  }
  // a route of its own mounts as before
  const c = createContext({ cfg: loadConfig(), token: 'unused' });
  c.extension = moduleWith({ method: 'GET', path: '/api/billing/usage', role: 'reviewer' });
  try {
    assert.doesNotThrow(() => createApp(c));
  } finally {
    c.extension.stop();
  }
});

// BILL-10 (sweep 3): a signed-in module route that says nothing about who may call it would rest on the module's own
// check alone; it is refused at start instead, with the one sentence the operator needs.
test('a module route that doesn’t say who may call it stops the server at start', async () => {
  const { createApp } = await import('../../server/app.ts');
  const allow = async () => ({ ok: true as const });
  for (const route of [
    { method: 'POST', path: '/api/billing/plan' },
    { method: 'GET', path: '/api/billing/usage', role: 'superuser' },
  ] as const) {
    const c = createContext({ cfg: loadConfig(), token: 'unused' });
    c.extension = ext.createExtension(
      {
        name: 'undeclared',
        entitlements: { get: async () => null, canUpload: allow, canAddMember: allow, canAddVideo: allow, canShare: allow },
        routes: [{ ...(route as Omit<Route, 'handle'>), handle: async () => ({ status: 200, json: {} }) }],
        workspaces: {},
      },
      ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false }),
    );
    try {
      assert.throws(
        () => createApp(c),
        (e: Error) => e instanceof ext.ModuleRouteError && e.message.includes(`${route.method} ${route.path}`) && /give the route a role/.test(e.message),
        JSON.stringify(route),
      );
    } finally {
      c.extension.stop();
    }
  }
});

test('every router is mounted at the root: one under a path is refused, its routes would hide from the module check and the route walk', async () => {
  // Express keeps a router's routes without the path it is mounted under, so `app.use('/x', router)` would list
  // '/y' for what answers '/x/y': a module route there would slip past the check above, and the walk would ask
  // the wrong path (sweep 2 SW-6).
  const express = (await import('express')).default;
  const { registeredRoutes } = await import('../lib/routes.ts');
  const app = createApp(createContext({ cfg: loadConfig(), token: 'unused' }));
  type Layer = { name: string; slash?: boolean; handle?: { stack?: unknown[] } };
  const routers = (app as unknown as { router: { stack: Layer[] } }).router.stack.filter((l) => l.handle?.stack);
  assert.ok(routers.length > 20, `${routers.length} routers`);
  assert.deepEqual(
    routers.filter((l) => l.slash !== true).map((l) => l.name),
    [],
    'every router of the app at the root',
  );
  const other = express();
  other.use(
    '/api/billing',
    express.Router().post('/plan', () => {}),
  );
  assert.throws(() => registeredRoutes(other), /a router mounted under a path/);
  const fine = express();
  fine.use(express.Router().post('/api/billing/plan', () => {}));
  assert.deepEqual(registeredRoutes(fine), [['POST', '/api/billing/plan']]);
});

test('a payment form’s sources: on the hosted app’s own pages, never on a review link’s', async () => {
  for (const url of ['/api/info', '/healthz', '/api/auth/status']) {
    const csp = String((await request('GET', url)).headers['content-security-policy']);
    assert.match(csp, /script-src 'self' 'sha256-[^']+' https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com;/, url);
    assert.match(csp, /frame-src 'self' https:\/\/js\.stripe\.com https:\/\/hooks\.stripe\.com;/, `3-D Secure runs in Stripe’s frame: ${url}`);
    assert.match(csp, /connect-src 'self'[^;]* https:\/\/api\.stripe\.com;/, url);
    assert.match(csp, /frame-ancestors 'none'/, 'nobody frames us all the same');
  }
  for (const url of ['/g/sometoken', '/api/g/sometoken/review']) {
    const csp = String((await request('GET', url)).headers['content-security-policy']);
    assert.ok(!csp.includes('stripe'), `a review link’s visitors never pay: ${url}`);
    assert.ok(!csp.includes('frame-src'), url);
  }
});

test('a module’s sources are https origins or the server doesn’t start: no keyword, scheme, path or bare wildcard', () => {
  assert.equal(ext.contentSourcesOf(undefined), null);
  assert.equal(ext.contentSourcesOf({ script: [] }), null);
  assert.deepEqual(ext.contentSourcesOf({ script: ['https://js.stripe.com'], img: ['https://*.stripe.com'] }), {
    script: ['https://js.stripe.com'],
    img: ['https://*.stripe.com'],
  });
  for (const bad of [
    { script: ["'unsafe-inline'"] },
    { script: ["'unsafe-eval'"] },
    { script: ['*'] },
    { script: ['https://*'] },
    { script: ['http://js.stripe.com'] },
    { script: ['data:'] },
    { script: ['https://js.stripe.com/v3/'] },
    { script: ['https://js.stripe.com; script-src *'] },
    { connect: ['https://api.stripe.com https://evil.test'] },
    { style: ['https://fonts.example'] },
    { 'frame-ancestors': ['https://evil.test'] },
    { script: 'https://js.stripe.com' },
    'https://js.stripe.com',
  ])
    assert.throws(() => ext.contentSourcesOf(bad), /cloud module/, JSON.stringify(bad));
  const host = ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false });
  const base = { name: 'x', entitlements: {} as never, routes: [], workspaces: {} };
  assert.throws(() => ext.createExtension({ ...base, contentSecurity: { script: ['*'] } }, host), /only https origins/);
  assert.equal(ext.NO_EXTENSION.contentSecurity, null);
});

// BILL-9 (sweep 3): a wildcard over shared hosting (anyone can serve a script from some.github.io) or an address
// instead of a host name widens the policy past the provider. Only a few providers' own bases take a `*.`.
test('a wildcard only over a payment provider’s own base domain, never over shared hosting; no IP addresses', () => {
  for (const bad of [
    'https://*.github.io',
    'https://*.workers.dev',
    'https://*.amazonaws.com',
    'https://*.co.uk',
    'https://*.com',
    'https://*.evil.test',
    'https://1.2.3.4',
    'https://1.2.3.4:443',
    'https://[::1]',
    'https://[2001:db8::1]',
    'https://a-.b-',
  ])
    assert.throws(() => ext.contentSourcesOf({ script: [bad] }), /cloud module/, bad);
  assert.deepEqual(
    ext.contentSourcesOf({ script: ['https://js.stripe.com', 'https://*.js.stripe.com'], frame: ['https://hooks.stripe.com'], img: ['https://*.stripe.com'] }),
    {
      script: ['https://js.stripe.com', 'https://*.js.stripe.com'],
      frame: ['https://hooks.stripe.com'],
      img: ['https://*.stripe.com'],
    },
  );
  // a plain host name of anyone's stays allowed: it names one site, not everyone's
  assert.deepEqual(ext.contentSourcesOf({ connect: ['https://api.example-pay.com'] }), { connect: ['https://api.example-pay.com'] });
});

// BILL-6 (sweep 3): a module's own 5xx went to the browser as it was (a lookup key, the operator's script) with no ref
// and nothing in the log. It answers like any of the app's own: one sentence and a ref, the module's text in the log.
test('a module’s 5xx answers with the app’s sentence and a ref, its own text only in the log; a 4xx goes out as it is', async () => {
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
  let r: Awaited<ReturnType<typeof request>>;
  try {
    r = await request('GET', '/api/billing/broken', { headers: { Cookie: owner } });
  } finally {
    console.error = error;
  }
  assert.equal(r.status, 500, r.text);
  assert.ok(!/lookup key|catalog script|price-missing/.test(r.text), `nothing internal reaches the browser: ${r.text}`);
  const ref = /\(ref ([0-9a-f]{8})\)/.exec(r.json().error)?.[1];
  assert.ok(ref, `a ref to find it by: ${r.text}`);
  assert.ok(
    logged.some((l) => l.includes(ref) && l.includes('lookup key lampo_solo_month_usd')),
    `the module's text is in the log under the ref: ${logged.join(' | ')}`,
  );
  const refused = await request('GET', '/api/billing/refused', { headers: { Cookie: owner } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json(), { error: 'This workspace has no billing account yet: choose a plan first.', code: 'no-billing-account' });
});

// After BILL-6 the module's two sentences meant for people (paying isn't set up; the payment provider refused, with its
// reason when it gives one for people) read as "something went wrong (ref …)". A module may vouch for a 502 or 503 with
// `public: true`: its sentence and code go out (one line, capped), nothing else; any other 5xx stays the app's sentence.
test('a module’s public 502/503 says its sentence; nothing else of its answer goes out, and a public 500 stays the app’s', async () => {
  const off = await request('GET', '/api/billing/off', { headers: { Cookie: owner } });
  assert.equal(off.status, 503, off.text);
  assert.deepEqual(off.json(), { error: 'Paying isn’t set up on this server yet.', code: 'unavailable' }, 'only error and code');
  const declined = await request('GET', '/api/billing/declined', { headers: { Cookie: owner } });
  assert.equal(declined.status, 502);
  assert.equal(declined.json().error, 'The payment provider refused: Your card was declined. second line', 'one line');
  const error = console.error;
  console.error = () => {};
  try {
    const loud = await request('GET', '/api/billing/loud', { headers: { Cookie: owner } });
    assert.equal(loud.status, 500);
    assert.ok(!/lookup key|catalog/.test(loud.text), `a 500 is never public: ${loud.text}`);
    assert.match(loud.json().error, /\(ref [0-9a-f]{8}\)/);
  } finally {
    console.error = error;
  }
});

test('usage counts the room a workspace could make: its final or archived videos and their bytes, never the sample', () => {
  const olivia = auth.findUserByEmail('olivia@example.com');
  assert.ok(olivia);
  const roomy = ws.createWorkspace({ name: 'Roomy', ownerId: olivia.id }).id;
  const sizes = inWorkspace(roomy, () => {
    const made = ['done.mp4', 'busy.mp4'].map((name) => {
      const file = makeVideo(path.join(dir, name), { dur: 0.5 });
      age(file);
      return store.createOrGetReview(file, { by: 'setup' }).review;
    });
    store.setFinal(slugify(made[0].video), { v: 1 });
    return made.map((r) => r.versions[0].size);
  });
  const u = ext.usageOf(roomy);
  assert.equal(u.activeVideos, 1);
  assert.equal(u.bytes, sizes[0] + sizes[1]);
  assert.deepEqual(u.room, { videos: 1, bytes: sizes[0] });
});

test('a 402 for the limit sheet: what was asked for, the room and the smallest step — the sentence as before, junk left out', async () => {
  const refuse = (extra: Record<string, unknown>) => async () => ({
    ok: false as const,
    reason: 'storage' as const,
    message: 'This workspace has 10 GB and 9 GB are used.',
    upgrade: 'solo',
    ...extra,
  });
  const sheet = ext.createExtension(
    {
      name: 'sheet',
      entitlements: {
        get: async () => null,
        canUpload: refuse({ needed: 1.8e9, room: { videos: 3, bytes: 4.2e9 }, fits: 'solo' }),
        canAddMember: async () => ({ ok: false as const, reason: 'members' as const, message: 'Free is for one person.', upgrade: 'solo', fits: 'team' }),
        canAddVideo: refuse({ needed: -1, room: { videos: 'three', bytes: 1 }, fits: 'Team<script>' }),
        canShare: async () => ({ ok: true as const }),
      },
      routes: [],
      workspaces: {},
    },
    host,
  );
  const thrown = async (p: Promise<void>) => {
    try {
      await p;
    } catch (e) {
      return e as { status: number; message: string; details?: Record<string, unknown> };
    }
    throw new Error('not refused');
  };
  const up = await thrown(sheet.check('w', 'upload', 1.8e9));
  assert.equal(up.status, 402);
  assert.equal(up.message, 'This workspace has 10 GB and 9 GB are used.');
  assert.deepEqual(up.details, { reason: 'storage', upgrade: 'solo', needed: 1.8e9, room: { videos: 3, bytes: 4.2e9 }, fits: 'solo' });
  const junk = await thrown(sheet.check('w', 'video'));
  assert.deepEqual(junk.details, { reason: 'storage', upgrade: 'solo' }, 'nothing but the plain shapes reaches the page');
  // an invite names its address: the refusal says it back to whoever asked; the sentence agents read is unchanged
  const before = ctx.extension;
  ctx.extension = sheet;
  try {
    const openCookie = await inWs(open);
    const invite = await request('POST', '/api/admin/invites', {
      body: { email: 'ben@example.com', role: 'member' },
      headers: { Cookie: openCookie, ...origin },
    });
    assert.equal(invite.status, 402, invite.text);
    assert.deepEqual(invite.json(), { reason: 'members', upgrade: 'solo', needed: 'ben@example.com', fits: 'team', error: 'Free is for one person.' });
    const link = await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: { Cookie: openCookie, ...origin } });
    assert.equal(link.json().needed, undefined, 'a link invite names nobody');
  } finally {
    ctx.extension = before;
  }
});
