// The first run's sample is in the library from the start on a hosted server (server/firstSample.ts): the setup page's
// owner finds it in the server's first workspace, someone who signs up on their own finds it in the workspace their
// confirmation made — once, made by them, in their language — and an instance that turned it off
// (VR_ONBOARDING_SAMPLE=off) makes none. None of it is logged.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import type { Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({
  vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open', VR_TRUST_PROXY: 'loopback', VR_ONBOARDING_SAMPLE: 'on' },
});
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const scope = await import('../../lib/scope.ts');
const store = await import('../../lib/store.ts');
const { findSample } = await import('../../lib/sample.ts');
const { slugify } = await import('../../lib/paths.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');

const { ctx, request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });
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
const sampleIn = (w: string) => scope.inWorkspace(w, () => findSample());

/** Signs `email` up and opens its confirm link in the browser that signed up: the person is in, placed. */
async function signUpAndConfirm(email: string, name: string, lang = 'en'): Promise<User> {
  const made = await post('/api/auth/signup', { name, email, password: 'a long enough password', lang });
  assert.equal(made.status, 200, made.text);
  await ctx.mail.flush();
  const mail = readOutbox(OUTBOX).filter((m) => m.to === email && m.kind === 'verify')[0];
  const token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1];
  assert.ok(token, `a confirm link went to ${email}`);
  const done = await post('/api/auth/verify', { token, lang }, { Cookie: cookiesOf(made) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().released, true);
  return auth.findUserByEmail(email) as User;
}

test('the setup page’s owner finds the sample in the server’s first workspace, made by them', async () => {
  const token = ctx.setup.token;
  assert.ok(token, 'a fresh server prints its setup token');
  const r = await post('/api/auth/setup', { token, name: 'Mia Lang', email: 'mia@example.com', password: 'mias long password' });
  assert.equal(r.status, 200, r.text);
  await ctx.inflight.settled();
  const sample = sampleIn('w1');
  assert.ok(sample, 'the sample is in the library');
  assert.equal(sample.onboarding_sample?.by, 'Mia Lang');
  assert.equal(sample.onboarding_sample?.by_id, (auth.findUserByEmail('mia@example.com') as User).id);
  assert.equal(sample.versions.length, 2);
  assert.equal(
    scope.inWorkspace('w1', () => store.readEvents({ limit: 50 }).filter((e) => e.slug === slugify(sample.video)).length),
    0,
    'nothing logged',
  );
});

test('someone who signs up on their own finds it in their own workspace, in their language, and only there', async () => {
  const pia = await signUpAndConfirm('pia@example.com', 'Pia', 'de');
  const own = ws.signupWorkspaceOf(pia.id);
  assert.ok(own && own !== 'w1');
  await ctx.inflight.settled();
  const sample = sampleIn(own);
  assert.ok(sample, 'the sample is in their library');
  assert.equal(sample.onboarding_sample?.by_id, pia.id);
  assert.equal(sample.video.split('/').pop(), 'Lampo-Beispiel.mp4', 'in the language they signed up in');
  assert.equal(
    scope.inWorkspace('w1', () => store.listReviews().filter((r) => r.onboarding_sample).length),
    1,
    'the first workspace still has its one',
  );
});

test('an instance that turned it off makes none: the sample waits to be asked for', async () => {
  ctx.cfg.onboarding_sample = false;
  try {
    const olaf = await signUpAndConfirm('olaf@example.com', 'Olaf');
    const own = ws.signupWorkspaceOf(olaf.id);
    assert.ok(own);
    await ctx.inflight.settled();
    assert.equal(sampleIn(own), undefined);
  } finally {
    ctx.cfg.onboarding_sample = true;
  }
});
