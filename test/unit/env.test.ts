// Settings are named LAMPO_*, and the VR_* spelling from before the command was `lampo` is still read (lib/env.ts): a
// production env file in the old spelling makes the same server as one in the new, LAMPO_ wins where both are set, a
// name born LAMPO_ has no older spelling, every reader goes through lib/env.ts, and the image's defaults stay in the
// old spelling so that either spelling given at run time wins over them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, ROOT } from '../lib/helpers.ts';

isolatedEnv();
const { bothSpellings, LAMPO_NAMES, LAMPO_ONLY, oldSpelling, RENAMED, RENAMED_DEV, setting, settingsIn, spelledAs } = await import('../../lib/env.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { envHook } = await import('../../lib/webhooks.ts');
const { endpointsFrom } = await import('../../lib/publish/net.ts');

/** The same settings in the other spelling. */
const respelled = (env: Record<string, string>, to: 'LAMPO_' | 'VR_') =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k.replace(/^(VR|LAMPO)_/, to), v]));

// What a hosted server's env file says (placeholder addresses; the relay's password is made here, not written down).
const PRODUCTION: Record<string, string> = {
  VR_MODE: 'server',
  VR_PORT: '4380',
  VR_PUBLIC_URL: 'https://review.example.com',
  VR_MEDIA_ORIGIN: 'https://media.review.example.com',
  VR_TRUST_PROXY: '10.147.47.0/24',
  VR_SOURCE_URL: 'https://example.org/you/lampo',
  VR_SIGNUP: 'invite',
  VR_WORKSPACE_CREATE: 'owners',
  VR_ORG_NAME: 'Northwind Studio',
  VR_TERMS_URL: 'https://review.example.com/terms',
  VR_PRIVACY_URL: 'https://review.example.com/privacy',
  VR_IMPRINT_URL: 'https://review.example.com/imprint',
  VR_SMTP_URL: `smtps://relay:${['not', 'a', 'secret'].join('-')}@smtp.example.com:465`,
  VR_MAIL_FROM: 'Lampo <notify@example.com>',
  VR_MAIL_PER_HOUR: '20',
  VR_UPLOAD_MAX: '20GB',
  VR_MIN_FREE: '500GB',
  VR_STORAGE: 's3',
  VR_S3_ENDPOINT: 'https://s3.example.com',
  VR_S3_REGION: 'eu-central',
  VR_S3_BUCKET: 'renders',
  VR_S3_ACCESS_KEY_ID: 'placeholder-id',
  VR_S3_SECRET_ACCESS_KEY: ['placeholder', 'key'].join('-'),
  VR_STT: 'local',
  VR_STT_MODEL: 'parakeet-v3',
  VR_STT_LANGUAGES: 'de,en',
  VR_STT_THREADS: '4',
  VR_PUSH_SUBJECT: 'mailto:hello@example.com',
};

test('LAMPO_ first, VR_ while it is unset; empty counts only on its own', () => {
  assert.equal(setting('LAMPO_PORT', {}), undefined);
  assert.equal(setting('LAMPO_PORT', { VR_PORT: '4380' }), '4380', 'the older spelling');
  assert.equal(setting('LAMPO_PORT', { LAMPO_PORT: '5000', VR_PORT: '4380' }), '5000', 'the new spelling wins');
  assert.equal(setting('LAMPO_PORT', { LAMPO_PORT: '', VR_PORT: '4380' }), '4380', 'an empty new one leaves the old one');
  assert.equal(setting('LAMPO_STT_LANGUAGES', { LAMPO_STT_LANGUAGES: '' }), '', 'empty on its own stays empty');
  assert.equal(setting('LAMPO_STT_LANGUAGES', { VR_STT_LANGUAGES: '' }), '');
  const s = settingsIn({ VR_DATA: '/tmp/store', LAMPO_CACHE: '/tmp/cache', VR_CACHE: '/tmp/other' });
  assert.equal(s.LAMPO_DATA, '/tmp/store');
  assert.equal(s.LAMPO_CACHE, '/tmp/cache');
  assert.equal(s.LAMPO_USER, undefined);
});

test('a name born LAMPO_ has no older spelling, and no name means two things', () => {
  assert.equal(oldSpelling('LAMPO_DATA'), 'VR_DATA');
  assert.equal(oldSpelling('LAMPO_OPERATOR'), null);
  assert.equal(oldSpelling('LAMPO_RUN'), null);
  assert.equal(setting('LAMPO_OPERATOR', { VR_OPERATOR: 'someone@example.com' }), undefined, 'VR_OPERATOR never meant anything');
  assert.equal(setting('LAMPO_OPERATOR', { LAMPO_OPERATOR: 'someone@example.com' }), 'someone@example.com');
  const all = [...RENAMED, ...RENAMED_DEV];
  assert.equal(new Set(all).size, all.length, 'each name once');
  for (const name of LAMPO_ONLY) assert.ok(!all.includes(name.slice('LAMPO_'.length) as never), `${name} is not also a renamed VR_ setting`);
  assert.deepEqual(
    LAMPO_NAMES.filter((n) => !n.startsWith('LAMPO_')),
    [],
  );
});

test('a production env file in either spelling makes the same server; LAMPO_ wins where both are set', () => {
  const old = loadConfig(PRODUCTION);
  const now = loadConfig(respelled(PRODUCTION, 'LAMPO_'));
  assert.deepEqual(now, old);
  // and not because both came out empty
  assert.equal(old.mode, 'server');
  assert.equal(old.port, 4380);
  assert.equal(old.public_url, 'https://review.example.com');
  assert.equal(old.media_origin, 'https://media.review.example.com');
  assert.equal(old.trust_proxy, '10.147.47.0/24');
  assert.equal(old.source_url, 'https://example.org/you/lampo');
  assert.equal(old.signup, 'invite');
  assert.equal(old.org_name, 'Northwind Studio');
  assert.equal(old.imprint_url, 'https://review.example.com/imprint');
  assert.equal(old.mail.from, 'Lampo <notify@example.com>');
  assert.equal(old.mail.per_hour, 20);
  assert.equal(old.upload_max_bytes, 20e9);
  assert.equal(old.min_free_bytes, 500e9);
  assert.equal(old.storage.kind, 's3');
  assert.equal(old.storage.s3?.bucket, 'renders');
  assert.deepEqual(old.stt.languages, ['de', 'en']);
  assert.equal(old.stt.threads, 4);

  // half in each spelling: still the same server
  const keys = Object.keys(PRODUCTION);
  const mixed = Object.fromEntries(keys.map((k, i) => [i % 2 ? k : k.replace(/^VR_/, 'LAMPO_'), PRODUCTION[k] as string]));
  assert.deepEqual(loadConfig(mixed), old);

  const both = loadConfig({ ...PRODUCTION, LAMPO_PORT: '5000', LAMPO_SIGNUP: 'off', LAMPO_STT_LANGUAGES: 'fr' });
  assert.equal(both.port, 5000);
  assert.equal(both.signup, 'off');
  assert.deepEqual(both.stt.languages, ['fr']);
});

test('a webhook and the publishing endpoints in either spelling', () => {
  const hook = { VR_WEBHOOK_URL: 'https://hooks.example.com/lampo', VR_WEBHOOK_FORMAT: 'slack', VR_WEBHOOK_EVENTS: 'comment,approved' };
  assert.ok(envHook(hook));
  assert.deepEqual(envHook(respelled(hook, 'LAMPO_')), envHook(hook));
  const endpoints = { VR_PUBLISH_ENDPOINTS: JSON.stringify({ youtube: 'http://127.0.0.1:9/youtube/v3' }) };
  assert.equal(endpointsFrom(endpoints).endpoints.youtube, 'http://127.0.0.1:9/youtube/v3');
  assert.deepEqual(endpointsFrom(respelled(endpoints, 'LAMPO_')), endpointsFrom(endpoints));
});

test('the Cloud module reads its settings by either name, whichever the operator wrote', () => {
  const env = bothSpellings({ LAMPO_SIGNUP: 'open', VR_TERMS_URL: 'https://review.example.com/terms', LAMPO_TRIAL_DAYS: '14', HOME: '/home/x' });
  assert.equal(env.VR_SIGNUP, 'open');
  assert.equal(env.LAMPO_SIGNUP, 'open');
  assert.equal(env.LAMPO_TERMS_URL, 'https://review.example.com/terms');
  assert.equal(env.LAMPO_TRIAL_DAYS, '14', 'its own settings pass through');
  assert.equal(env.HOME, '/home/x');
  assert.ok(!('VR_PRIVACY_URL' in env) && !('LAMPO_PRIVACY_URL' in env), 'nothing made up');
});

test('a message names a setting the way the operator wrote it; one to set by its new name', async () => {
  assert.equal(spelledAs('LAMPO_TRUST_PROXY', { VR_TRUST_PROXY: 'loopback' }), 'VR_TRUST_PROXY', 'an env file from before');
  assert.equal(spelledAs('LAMPO_TRUST_PROXY', { LAMPO_TRUST_PROXY: 'loopback', VR_TRUST_PROXY: 'x' }), 'LAMPO_TRUST_PROXY');
  assert.equal(spelledAs('LAMPO_TRUST_PROXY', {}), 'LAMPO_TRUST_PROXY', 'not set: the name to set');
  assert.equal(spelledAs('LAMPO_OPERATOR', { VR_OPERATOR: 'x' }), 'LAMPO_OPERATOR');
  // the warning a deploy check looks for: `which (VR|LAMPO)_TRUST_PROXY`
  const { untrustedProxyWarning } = await import('../../server/app.ts');
  for (const [env, name] of [
    [{ VR_TRUST_PROXY: 'loopback' }, 'VR_TRUST_PROXY'],
    [{ LAMPO_TRUST_PROXY: 'loopback' }, 'LAMPO_TRUST_PROXY'],
    [{}, 'LAMPO_TRUST_PROXY'],
  ] as const) {
    const said: string[] = [];
    const mw = untrustedProxyWarning(
      () => false,
      'loopback',
      (l: string) => said.push(l),
      env,
    );
    mw({ headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '172.18.0.5' } } as never, {} as never, () => {});
    assert.match(said[0] ?? '', new RegExp(`which ${name} \\(loopback\\) doesn't name`), JSON.stringify(env));
    assert.match(said[0] ?? '', /which (VR|LAMPO)_TRUST_PROXY/);
  }
});

/** Lines of source without their comments (a comment may name a variable it explains). */
const code = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

test('every setting is read through lib/env.ts: no reader knows both spellings', () => {
  const dirs = ['lib', 'server', 'mcp', 'scripts', 'bin'];
  const files = dirs.flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true, encoding: 'utf8' }).map((f) => path.join(d, f)));
  files.push('web/vite.config.ts');
  const read = /\b(?:process\.)?env(?:\.|\[['"`])(?:VR|LAMPO)_[A-Z0-9_]/;
  const found: string[] = [];
  for (const f of files.filter((f) => /\.(ts|mjs|js)$/.test(f) || f.startsWith('bin/'))) {
    if (f === 'lib/env.ts' || fs.statSync(path.join(ROOT, f)).isDirectory()) continue;
    for (const l of code(path.join(ROOT, f))) if (read.test(l)) found.push(`${f}: ${l.trim()}`);
  }
  // bin/launch.js must load on any Node, so it can't import lib/env.ts: its one setting, both spellings in one line.
  assert.deepEqual(found, ['bin/launch.js: process.env.LAMPO_NODE || process.env.VR_NODE,']);
});

test('the image’s defaults stay in the old spelling: a VR_ or a LAMPO_ given at run time wins over them', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const env = /^ENV ([\s\S]*?)(?:\n(?!\s))/m.exec(docker.slice(docker.indexOf('ENV NODE_ENV')))?.[1] ?? '';
  assert.match(env, /VR_MODE=server/);
  assert.doesNotMatch(env, /LAMPO_/, 'an image default named LAMPO_ would beat the VR_ setting of an existing env file');
  const health = docker.split('\n').find((l) => l.includes('/readyz') && l.includes('CMD')) ?? '';
  assert.match(health, /process\.env\.LAMPO_PORT \|\| process\.env\.VR_PORT \|\| 4747/, 'the health check asks the port either spelling set');
});
