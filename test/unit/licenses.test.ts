// third-party-licenses.txt: every package a build bundles, and every runtime dependency of the server, is listed with
// its licence and the licence text the package ships.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { artworkNotices, bundledNotices, describePackage, packageRoot, productionPackages, renderNotices, vendoredNotices } from '../../scripts/licenses.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function fakePackage(nm: string, name: string, license: string | undefined, text: string | null): string {
  const dir = path.join(nm, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.2.3', ...(license ? { license } : {}), repository: `git+https://example.org/${name}.git` }),
  );
  if (text) fs.writeFileSync(path.join(dir, 'LICENSE.md'), `${text}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), '');
  return dir;
}

test('module ids map to their package, scoped or nested', () => {
  assert.equal(packageRoot('/app/node_modules/react/index.js'), '/app/node_modules/react');
  assert.equal(packageRoot('/app/node_modules/@radix-ui/react-dialog/dist/index.mjs?commonjs-es-import'), '/app/node_modules/@radix-ui/react-dialog');
  assert.equal(packageRoot('\0/app/node_modules/a/node_modules/b/lib/x.js'), '/app/node_modules/a/node_modules/b');
  assert.equal(packageRoot('/app/web/src/main.tsx'), null, 'our own sources are not third-party');
  assert.equal(packageRoot('/app/node_modules/@scope'), null);
});

test('a bundle lists each package once, with its licence text or at least its SPDX id', () => {
  const nm = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-lic-')), 'node_modules');
  const a = fakePackage(nm, 'alpha', 'MIT', 'MIT License\n\nCopyright (c) Alpha');
  const b = fakePackage(nm, '@scope/beta', 'ISC', null);
  const notices = bundledNotices([path.join(a, 'index.js'), path.join(a, 'index.js?x'), path.join(b, 'index.js'), '/app/web/src/main.tsx']);
  assert.deepEqual(notices.map((n) => [n.name, n.license, n.homepage]).sort(), [
    ['@scope/beta', 'ISC', 'https://example.org/@scope/beta'],
    ['alpha', 'MIT', 'https://example.org/alpha'],
  ]);
  const out = renderNotices({ version: '9.9.9', bundled: notices });
  assert.match(out, /Third-party software in video-review 9\.9\.9/);
  assert.match(out, /## Bundled into this web app \(2\)/);
  assert.match(out, /alpha 1\.2\.3 — MIT\nhttps:\/\/example\.org\/alpha\n\nMIT License\n\nCopyright \(c\) Alpha/);
  assert.match(out, /@scope\/beta 1\.2\.3 — ISC[\s\S]*no licence file in the package; it declares ISC/);
});

test('every runtime dependency of the server declares a licence (the Docker image ships them)', () => {
  const { installed, elsewhere } = productionPackages(ROOT);
  assert.ok(installed.length > 50, `found ${installed.length}`);
  const unknown = [...installed.map(describePackage), ...elsewhere].filter((p) => p.license === 'UNKNOWN').map((p) => p.name);
  assert.deepEqual(unknown, []);
  const names = installed.map((d) => describePackage(d).name);
  for (const dep of ['express', 'zod', '@resvg/resvg-js']) assert.ok(names.includes(dep), dep);
  assert.ok(!names.includes('vite') && !names.includes('react'), 'build-time packages are not runtime dependencies');
});

test('code copied into the app travels with its licence: CookieConsent, the cookie settings (vendored, A13 CLOUD-1)', () => {
  const out = renderNotices({ version: '9.9.9', bundled: [], vendored: vendoredNotices(ROOT) });
  assert.match(out, /## Copied into this web app \(1\)/);
  assert.match(out, /CookieConsent [^\n]* 3\.1\.0 — MIT[\s\S]*Copyright \(c\) 2020-2025 Orest Bida[\s\S]*Permission is hereby granted/);
});

test('the artwork drawn into the app travels with its licences: the logo’s Norican lettering, the agent marks', () => {
  const out = renderNotices({ version: '9.9.9', bundled: [], artwork: artworkNotices(ROOT) });
  assert.match(out, /## Artwork drawn into this web app \(3\)/);
  assert.match(out, /Norican \(the Lampo logo’s lettering, as outlines\) 2011 — OFL-1\.1[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(out, /Simple Icons [^\n]* — CC0-1\.0[\s\S]*trademarks of their owners/);
  assert.match(out, /Copilot mark [^\n]* — MIT[\s\S]*Permission is hereby granted/);
});
