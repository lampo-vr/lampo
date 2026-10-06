// The extension point's newcomer and mail seams (server/extension.ts): a module that answers sign-ups places the person
// through the app's own placement (`host.placeSignup`, idempotent, telling whether the workspace is their own sign-up's)
// and does what its plans give a newcomer; it emails a workspace's people through the app's mailer, in their language,
// in the app's layout and footer, linking only to a screen of the app; and it says it provides billing (/api/info).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open', VR_TRUST_PROXY: 'loopback' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const ext = await import('../../server/extension.ts');
const { onSignup: appOnSignup } = await import('../../server/signup.ts');
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

// The stand-in: on a sign-up it places the person and remembers what it heard (the account is still held then: its
// address counts as confirmed only once the seam has run, so a message is for later — as below).
const MODULE = path.join(dir, 'newcomer-module.ts');
fs.writeFileSync(
  MODULE,
  `export const heard = [];
export default async (host) => ({
  name: 'newcomer',
  billing: true,
  entitlements: {
    get: async () => ({}),
    canUpload: async () => ({ ok: true }),
    canAddMember: async () => ({ ok: true }),
    canAddVideo: async () => ({ ok: true }),
    canShare: async () => ({ ok: true }),
  },
  routes: [],
  workspaces: {},
  async onSignup(e) {
    const placed = await host.placeSignup(e.account, { reset: e.reset });
    heard.push({ ...e, ...placed });
  },
  stopped: 0,
  stop() { this.stopped++; },
});
`,
);
const { heard } = (await import(MODULE)) as { heard: Record<string, unknown>[] };

const logs: { event: string; fields?: Record<string, unknown> }[] = [];
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const host = ext.hostContext({
  publicUrl: PUBLIC,
  who: ext.callerOf,
  sameOrigin: ext.sameOriginOf(PUBLIC),
  log: (event, fields) => logs.push({ event, fields }),
  mail: (m) => ctx.accountMail.workspaceNotice(m),
});
const loaded = await ext.loadExtension(host, { ...process.env, VR_CLOUD_MODULE: MODULE });
ext.installExtension(ctx, loaded);
const { request } = await startApp({ ctx, headers: { Connection: 'close', Host: 'review.test' } });
after(() => ctx.mail.stop());

const OUTBOX = path.join(dir, 'cache', 'outbox');
const origin = { Origin: PUBLIC };
const cookiesOf = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');
let n = 0;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  request('POST', url, { body, headers: { ...origin, 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}`, ...headers } });
const outbox = async () => {
  await ctx.mail.flush();
  return readOutbox(OUTBOX);
};

async function signUp(email: string, name: string, lang: 'en' | 'de'): Promise<User> {
  const made = await post('/api/auth/signup', { name, email, password: 'a long enough password', lang });
  assert.equal(made.status, 200, made.text);
  const mail = (await outbox()).filter((m) => m.to === email && m.kind === 'verify')[0];
  const token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1];
  assert.ok(token, `a confirm link went to ${email}`);
  const done = await post('/api/auth/verify', { token }, { Cookie: cookiesOf(made) });
  assert.equal(done.status, 200, done.text);
  return auth.findUserByEmail(email) as User;
}

before(async () => {
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
  ctx.setup.token = null;
});

test('a module that answers sign-ups takes the app’s place; one without keeps the app’s own', () => {
  assert.equal(loaded.billing, true);
  assert.equal(typeof loaded.onSignup, 'function');
  assert.equal(ctx.onSignup, loaded.onSignup);
  const plain = { extension: ext.NO_EXTENSION, onSignup: appOnSignup };
  ext.installExtension(plain, ext.NO_EXTENSION);
  assert.equal(plain.onSignup, appOnSignup, 'no module, no change');
  assert.equal(ext.NO_EXTENSION.onSignup, null);
  assert.equal(ext.NO_EXTENSION.billing, false);
});

test('/api/info says a billing provider runs (and nothing when none does)', async () => {
  assert.equal((await request('GET', '/api/info')).json().billing, true);
  const bare = await startApp({ headers: { Host: 'review.test' } });
  assert.equal(bare.ctx.extension.billing, false);
  assert.equal((await bare.request('GET', '/api/info')).json().billing, undefined);
  await bare.close();
});

test('a sign-up is placed through the app’s placement: a workspace of their own, made once, told as their own', async () => {
  const pia = await signUp('pia@example.com', 'Pia', 'en');
  const first = heard.find((h) => h.account === pia.id);
  assert.ok(first, 'the module heard the sign-up');
  assert.equal(first.email, 'pia@example.com');
  assert.equal(first.reset, false);
  assert.equal(first.created, true);
  assert.equal(first.own, true);
  const home = ws.homeWorkspace(pia.id);
  assert.equal(first.workspace, home);
  assert.equal(ws.roleIn(home as string, pia.id), 'owner');
  assert.equal(ws.signupWorkspaceOf(pia.id), home);
  // a second click on the same link: placed already, still their own, nothing made twice
  const again = await host.placeSignup(pia.id);
  assert.deepEqual(again, { workspace: home, created: false, own: true });
  assert.equal(ws.listWorkspaces().filter((w) => w.by === pia.id).length, 1);
  // the team that was here first is not anyone's own sign-up
  assert.equal(ws.signupWorkspaceOf((auth.findUserByEmail('olivia@example.com') as User).id), null);
});

const trialWords = {
  en: { subject: 'Your trial\nends soon', title: 'Three days left', body: ['Your trial runs until the 17th.'], button: 'See plans', note: 'No card needed.' },
  de: { subject: 'Deine Testphase endet bald', title: 'Noch drei Tage', body: ['Deine Testphase läuft bis zum 17.'], button: 'Pläne ansehen' },
};
const remind = (u: User) => host.mail({ workspace: ws.homeWorkspace(u.id) as string, text: trialWords, link: '#/settings/billing' });

test('the module’s message goes through the app’s mailer: their language, our layout and footer, a link into the app', async () => {
  const pia = auth.findUserByEmail('pia@example.com') as User;
  assert.equal(await remind(pia), 1);
  const toPia = (await outbox()).filter((m) => m.to === 'pia@example.com' && m.kind === 'notice');
  assert.equal(toPia.length, 1);
  const m = toPia[0];
  assert.equal(m.subject, 'Your trial ends soon', 'one line, whatever the module wrote');
  assert.match(m.text, /Three days left/);
  assert.match(m.text, /See plans:\nhttp:\/\/review\.test\/#\/settings\/billing/);
  assert.match(m.text, /No card needed\./);
  assert.match(m.text, /You get this because you have a workspace on review\.test\./, 'a sign-up’s workspace is named after its owner: not quoted');
  assert.match(m.html, /cid:lampo-icon/, 'the app’s layout');

  // the language is the account's own choice (as for every notice the app sends)
  const jonas = await signUp('jonas@example.com', 'Jonas', 'de');
  await auth.updateUser(jonas.id, { prefs: { lang: 'de' } });
  assert.equal(await remind(jonas), 1);
  const de = (await outbox()).filter((x) => x.to === 'jonas@example.com' && x.kind === 'notice');
  assert.equal(de.length, 1);
  assert.equal(de[0].lang, 'de');
  assert.equal(de[0].subject, 'Deine Testphase endet bald');
  assert.match(de[0].text, /Pläne ansehen:\nhttp:\/\/review\.test\/#\/settings\/billing/);
  assert.match(de[0].text, /Du bekommst diese E-Mail, weil du einen Workspace auf review\.test hast\./);
});

test('who gets it: the roles asked for (owners and admins by default), never a suspended member', async () => {
  const pia = auth.findUserByEmail('pia@example.com') as User;
  const home = ws.homeWorkspace(pia.id) as string;
  ws.renameWorkspace(home, 'Pia’s Studio');
  const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long enough password', role: 'reviewer' });
  ws.addMember(home, max.id, 'member');
  const ada = await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: 'a long enough password', role: 'reviewer' });
  ws.addMember(home, ada.id, 'admin');
  const before = (await outbox()).length;
  const words = { en: { subject: 'Plan news', title: 'Plan news', body: ['Something changed.'] } };
  assert.equal(await host.mail({ workspace: home, text: words }), 2, 'Pia (owner) and Ada (admin)');
  assert.equal(await host.mail({ workspace: home, roles: ['member'], text: words }), 1, 'Max only');
  const sent = (await outbox()).slice(before);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ada@example.com', 'max@example.com', 'pia@example.com']);
  assert.match(sent[0].text, /You get this because you work in the workspace “Pia’s Studio” on review\.test\./, 'named now: quoted');
  assert.ok(
    sent.every((m) => !/http:\/\/review\.test\/#/.test(m.text)),
    'no link asked for, none written',
  );
  // a suspended admin hears nothing (an address nobody confirmed neither: the rule of every notice, accountMail.ts)
  ws.suspendMember(home, ada.id, true);
  assert.equal(await host.mail({ workspace: home, text: words }), 1, 'Pia alone');
});

test('a module’s mistake sends nothing: an unknown workspace, no English words, a link that leaves the app', async () => {
  const pia = auth.findUserByEmail('pia@example.com') as User;
  const home = ws.homeWorkspace(pia.id) as string;
  const words = { en: { subject: 's', title: 't', body: ['b'] } };
  const before = (await outbox()).length;
  assert.equal(await host.mail({ workspace: 'w_nosuchthing', text: words }), 0);
  assert.equal(await host.mail({ workspace: home, text: { de: words.en } as never }), 0);
  for (const link of ['https://elsewhere.example/#/x', 'javascript:alert(1)', '#/settings"><script>', '//elsewhere.example'])
    assert.equal(await host.mail({ workspace: home, text: words, link }), 0, link);
  assert.equal((await outbox()).length, before);
  assert.ok(logs.filter((l) => l.event === 'extension.mail.refused').length >= 6);
  // and a host made without a mailer sends nothing at all
  const quiet = ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false, log: () => {} });
  assert.equal(await quiet.mail({ workspace: home, text: words }), 0);
});

test('stopping the extension stops the module’s timers too', async () => {
  const mod = (await import(MODULE)).default as (h: unknown) => Promise<{ stopped: number; stop(): void }>;
  const m = await mod(host);
  const e = ext.createExtension(m as never, host);
  e.stop();
  assert.equal(m.stopped, 1);
});

test('a refusal carries the provider’s sentence in other languages too (the page shows its own language’s)', () => {
  const e = ext.refusal({
    ok: false,
    reason: 'members',
    message: 'Free is for one person.',
    messages: { de: 'Free ist für eine Person.', 'x-evil': 'dropped', fr: 3 as unknown as string },
    upgrade: 'team',
  });
  assert.equal(e.status, 402);
  assert.equal(e.message, 'Free is for one person.');
  assert.deepEqual(e.details, { reason: 'members', upgrade: 'team', messages: { de: 'Free ist für eine Person.' } });
  assert.deepEqual(ext.refusal({ ok: false, reason: 'storage', message: 'Full.' }).details, { reason: 'storage' });
});
