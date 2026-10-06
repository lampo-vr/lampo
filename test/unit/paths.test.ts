// Where the store lives, for each install flavour. Each case runs lib/paths.ts in a fresh process with its own env;
// "fresh install" cases use a copy of lib/ in a temp app dir (no data/ next to it) and a temp HOME.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, tmpdir } from '../lib/helpers.ts';

function resolve(appRoot: string, env: Record<string, string>) {
  const code = `import * as p from ${JSON.stringify(path.join(appRoot, 'lib/paths.ts'))};
    console.log(JSON.stringify({ mode: p.STORE_MODE, data: p.DATA, versions: p.VERSIONS, cache: p.CACHE, dev: p.DEV, user: p.USER }));`;
  const clean = { ...process.env };
  for (const k of ['VR_DATA', 'VR_CACHE', 'VR_CONFIG', 'VR_USER', 'VR_HOME']) delete clean[k];
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...clean, ...env }, encoding: 'utf8' }));
}

function freshApp() {
  const app = tmpdir('vr-app-');
  fs.mkdirSync(path.join(app, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'lib/paths.ts'), path.join(app, 'lib/paths.ts'));
  fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
  const home = tmpdir('vr-home-');
  return { app, home };
}

test('this checkout (data/ next to the app) keeps using it', { skip: !fs.existsSync(path.join(ROOT, 'data')) && 'no legacy data/ here' }, () => {
  const r = resolve(ROOT, {});
  assert.equal(r.mode, 'legacy');
  assert.equal(r.data, path.join(ROOT, 'data'));
  assert.equal(r.versions, path.join(ROOT, 'versions'));
  assert.equal(r.cache, path.join(ROOT, 'cache'));
});

test('VR_DATA isolates data and versions', () => {
  const t = tmpdir();
  const r = resolve(ROOT, { VR_DATA: path.join(t, 'store'), VR_CACHE: path.join(t, 'c') });
  assert.equal(r.mode, 'env');
  assert.equal(r.data, path.join(t, 'store'));
  assert.equal(r.versions, `${path.join(t, 'store')}-versions`);
  assert.equal(r.cache, path.join(t, 'c'));
});

test('fresh install lives in ~/.video-review and names the reviewer after the OS account', () => {
  const { app, home } = freshApp();
  const r = resolve(app, { HOME: home });
  assert.equal(r.mode, 'home');
  assert.equal(r.data, path.join(home, '.video-review/data'));
  assert.equal(r.versions, path.join(home, '.video-review/versions'));
  assert.equal(r.cache, path.join(home, '.video-review/cache'));
  assert.equal(r.dev, home, '"Add video" browses from home');
  assert.ok(r.user && r.user !== 'reviewer');
  fs.mkdirSync(path.join(home, 'Development'));
  assert.equal(resolve(app, { HOME: home }).dev, home, 'no guessing from folder names');
  fs.mkdirSync(path.join(home, '.video-review'), { recursive: true });
  fs.writeFileSync(path.join(home, '.video-review/config.json'), JSON.stringify({ browse_root: '~/Development' }));
  assert.equal(resolve(app, { HOME: home }).dev, path.join(home, 'Development'), 'browse_root wins');
});

test('VR_HOME puts the whole install in one place (a container volume), config.json included', () => {
  const { app, home } = freshApp();
  const vol = tmpdir('vr-vol-');
  fs.writeFileSync(path.join(vol, 'config.json'), JSON.stringify({ user: 'Container' }));
  const r = resolve(app, { HOME: home, VR_HOME: vol });
  assert.equal(r.mode, 'home');
  assert.deepEqual(
    [r.data, r.versions, r.cache],
    ['data', 'versions', 'cache'].map((d) => path.join(vol, d)),
  );
  assert.equal(r.user, 'Container');
});

test('config.json in ~/.video-review: data_dir, versions_dir, browse_root, user', () => {
  const { app, home } = freshApp();
  fs.mkdirSync(path.join(home, '.video-review'));
  fs.writeFileSync(
    path.join(home, '.video-review/config.json'),
    JSON.stringify({ data_dir: '~/Reviews/data', versions_dir: '~/Big/versions', browse_root: '~/Projects', user: 'alex' }),
  );
  const r = resolve(app, { HOME: home });
  assert.equal(r.mode, 'config');
  assert.equal(r.data, path.join(home, 'Reviews/data'));
  assert.equal(r.versions, path.join(home, 'Big/versions'));
  assert.equal(r.cache, path.join(home, 'Reviews/cache'));
  assert.equal(r.dev, path.join(home, 'Projects'));
  assert.equal(r.user, 'alex');
  assert.equal(resolve(app, { HOME: home, VR_USER: 'env-user' }).user, 'alex', 'config.json user wins over VR_USER');
});

test('VR_USER applies when config.json has no user', () => {
  const { app, home } = freshApp();
  assert.equal(resolve(app, { HOME: home, VR_USER: 'env-user' }).user, 'env-user');
});
