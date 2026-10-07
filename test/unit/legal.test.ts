// The operator's legal pages (A13 CLOUD-1, lib/legal.ts): open sign-up refuses to start without the terms and the privacy
// policy, every legal link must be a web page, /api/info names them for the sign-in's foot, Settings → About and the
// checkout, and a review link's answer names the imprint and the privacy policy for its foot (a visitor reads them too).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const LEGAL = {
  VR_IMPRINT_URL: 'https://example.com/imprint',
  VR_TERMS_URL: 'https://example.com/terms',
  VR_PRIVACY_URL: 'https://example.com/privacy',
  VR_WITHDRAWAL_URL: 'https://example.com/withdrawal',
  VR_CANCEL_URL: 'https://example.com/cancel',
};
const { dir } = isolatedEnv({ vars: LEGAL });
const { loadConfig, startupProblems } = await import('../../lib/config.ts');
const { mailProblems } = await import('../../lib/mail/config.ts');
const { legalConfig, legalProblems } = await import('../../lib/legal.ts');
const store = await import('../../lib/store.ts');

const video = makeVideo(`${dir}/renders/spot.mp4`, { w: 160, h: 90, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugOf(video);
const { request } = await startApp({ token: 'test-token', loadSessions: async () => [] });

const hosted = (vars: Record<string, string>) => {
  const env = { ...LEGAL, VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'loopback', ...vars };
  return startupProblems(loadConfig(env), env, { signupSeam: true });
};

test('open sign-up refuses to start without the terms and the privacy policy: one line naming what is missing', () => {
  const none = { VR_SIGNUP: 'open', VR_TERMS_URL: '', VR_PRIVACY_URL: '' };
  const both = hosted(none).filter((p) => p.startsWith('LAMPO_SIGNUP=open'));
  assert.equal(both.length, 1, both.join('\n'));
  assert.match(both[0] as string, /^LAMPO_SIGNUP=open needs LAMPO_TERMS_URL and LAMPO_PRIVACY_URL: /);
  assert.ok(!(both[0] as string).includes('\n'), 'one line');
  assert.match(hosted({ ...none, VR_TERMS_URL: LEGAL.VR_TERMS_URL }).join('\n'), /^LAMPO_SIGNUP=open needs LAMPO_PRIVACY_URL: /m);
  assert.deepEqual(hosted({ VR_SIGNUP: 'open' }), [], 'with both it starts');
  assert.deepEqual(hosted({ VR_SIGNUP: 'invite', VR_TERMS_URL: '', VR_PRIVACY_URL: '' }), [], 'invite-only sign-up needs neither');
  // the same check in mailProblems, which `vr admin` and the process share
  const mail = loadConfig({ VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.example.com', ...none });
  assert.ok(mailProblems(mail, { signupSeam: true }).some((p) => /^LAMPO_SIGNUP=open needs LAMPO_TERMS_URL and LAMPO_PRIVACY_URL/.test(p)));
});

test('every legal link is a web page: environment over config.json, anything but http(s) refuses to start', () => {
  assert.deepEqual(
    legalConfig({ imprint_url: 'https://file.example/imprint', cancel_url: ' https://file.example/cancel ' }, { VR_IMPRINT_URL: LEGAL.VR_IMPRINT_URL }),
    {
      imprint_url: LEGAL.VR_IMPRINT_URL,
      withdrawal_url: null,
      cancel_url: 'https://file.example/cancel',
    },
  );
  assert.deepEqual(legalProblems({ imprint_url: 'javascript:alert(1)', withdrawal_url: 'mailto:x@y.z', cancel_url: 'https://ok.example/c' }), [
    'LAMPO_IMPRINT_URL must be an http(s) URL.',
    'LAMPO_WITHDRAWAL_URL must be an http(s) URL.',
  ]);
  assert.ok(hosted({ VR_CANCEL_URL: 'data:text/html,hi' }).includes('LAMPO_CANCEL_URL must be an http(s) URL.'), 'the older spelling is read too');
  assert.ok(hosted({ LAMPO_CANCEL_URL: 'data:text/html,hi' }).includes('LAMPO_CANCEL_URL must be an http(s) URL.'));
});

test('/api/info names every legal link, to the owner and to a visitor from elsewhere', async () => {
  for (const headers of [{}, { 'x-forwarded-for': '203.0.113.7' }] as Record<string, string>[]) {
    const info = (await request('GET', '/api/info', { headers })).json();
    assert.equal(info.imprint_url, LEGAL.VR_IMPRINT_URL);
    assert.equal(info.terms_url, LEGAL.VR_TERMS_URL);
    assert.equal(info.privacy_url, LEGAL.VR_PRIVACY_URL);
    assert.equal(info.withdrawal_url, LEGAL.VR_WITHDRAWAL_URL);
    assert.equal(info.cancel_url, LEGAL.VR_CANCEL_URL);
  }
});

test('a review link’s answer names the imprint and the privacy policy for its foot, password or not', async () => {
  for (const password of [undefined, 'a long password']) {
    const made = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, {
      body: { label: 'Spot', ...(password ? { password } : {}) },
    });
    assert.equal(made.status, 200, made.text);
    const link = (await request('GET', `/api/g/${made.json().token}`, { headers: { 'x-forwarded-for': '203.0.113.7' } })).json();
    assert.equal(link.locked, !!password);
    assert.equal(link.imprint_url, LEGAL.VR_IMPRINT_URL);
    assert.equal(link.privacy_url, LEGAL.VR_PRIVACY_URL);
  }
});
