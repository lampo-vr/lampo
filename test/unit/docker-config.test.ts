// The container's hardening lives in two text files; this keeps it from quietly going away (the image isn't built in
// tests). What each line is for: docs/docker.md → "The image".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the image runs unprivileged, checks readiness, and keeps temp files on the volume', () => {
  const docker = read('Dockerfile');
  const final = docker.slice(docker.lastIndexOf('\nFROM '));
  assert.match(final, /^USER node$/m, 'not root');
  assert.match(final, /HEALTHCHECK[\s\S]*\/readyz/, 'ready, not just alive');
  assert.match(final, /TMPDIR=\/data\/tmp/, 'temp files on the volume (the root file system can be read-only)');
  assert.match(final, /prune --omit=dev|--from=build \/app\/node_modules/, 'production dependencies only');
  assert.doesNotMatch(final, /COPY (--from=build )?\/app\/(test|docs|bench)\b/, 'no tests, docs or benchmarks');
  const ignore = read('.dockerignore').split('\n');
  for (const p of ['data', 'versions', 'cache', '.env', '.env.*', 'test', 'bench']) assert.ok(ignore.includes(p), `.dockerignore keeps ${p} out`);
});

// AGPL-3.0 §13 and plain bookkeeping: the image says where its source is, under which licence, and which commit it was
// built from (OCI labels, A12-D5). A fork builds with its own SOURCE_URL; CI passes the commit.
test('the image carries OCI labels: its source, its licence, the commit it was built from', () => {
  const docker = read('Dockerfile');
  const final = docker.slice(docker.lastIndexOf('\nFROM '));
  const pkg = JSON.parse(read('package.json'));
  const repo = String(pkg.repository.url)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  const label = (k: string) => new RegExp(`org\\.opencontainers\\.image\\.${k}="([^"]*)"`).exec(final)?.[1];
  assert.equal(label('licenses'), pkg.license, 'the licence package.json names');
  assert.equal(label('source'), `\${SOURCE_URL}`);
  assert.ok(final.split('\n').includes(`ARG SOURCE_URL=${repo}`), `SOURCE_URL defaults to the repository (${repo})`);
  assert.equal(label('revision'), `\${REVISION}`);
  assert.match(final, /^ARG REVISION=\S+$/m);
  assert.ok(label('title'), 'a title');
  assert.match(read('.github/workflows/ci.yml'), /docker build[^\n]*--build-arg REVISION=\$\{\{ github\.sha \}\}/, 'CI builds with its commit');
});

// What .gitignore keeps private (local working files, the private cloud module, a site/ folder, agent
// worktrees) must not reach a build context either: build stages and exported build caches would hold it (audit A12,
// OSS-12). The published image copies only what it needs, but the build stage copies everything not ignored here.
test('nothing .gitignore keeps private goes into the image’s build context', () => {
  const lines = read('.gitignore').split('\n');
  const from = lines.indexOf('# private working notes');
  const to = lines.findIndex((l, i) => i > from && l.startsWith('# secrets'));
  assert.ok(from >= 0 && to > from, 'the private block of .gitignore');
  const ignore = new Set(read('.dockerignore').split('\n'));
  const privates = lines
    .slice(from, to)
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => l.replace(/^\//, '').replace(/\/\*?\/?$/, ''));
  assert.ok(privates.includes('cloud') && privates.includes('*.local.md'), privates.join(' '));
  for (const p of privates) assert.ok(ignore.has(p) || ignore.has(`**/${p}`), `.dockerignore keeps ${p} out`);
});

test('compose drops capabilities, forbids new privileges, runs read-only with a small /tmp, bounds processes', () => {
  const compose = read('docker-compose.yml');
  const app = compose.slice(compose.indexOf('  app:'), compose.indexOf('  caddy:'));
  assert.match(app, /cap_drop:\s*\n\s*- ALL/);
  assert.match(app, /no-new-privileges:true/);
  assert.match(app, /read_only: true/);
  assert.match(app, /tmpfs:\s*\n\s*- \/tmp:size=\d+m/);
  assert.match(app, /pids_limit: \d+/);
  assert.match(app, /mem_limit: \d+g/);
  assert.match(app, /\/readyz/);
});

test('container logs are rotated, for the app and the proxy alike', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /x-logging: &logging\s*\n\s*driver: json-file\s*\n\s*options:\s*\n\s*max-size: "\d+m"\s*\n\s*max-file: "\d+"/);
  for (const service of ['  app:', '  caddy:']) {
    const start = compose.indexOf(service);
    const next = compose.slice(start + service.length).search(/\n {2}\w[\w-]*:\n|\nvolumes:/);
    assert.match(compose.slice(start, start + service.length + next), /logging: \*logging/, `${service.trim()} rotates its log`);
  }
});

// Footage search's runtime (onnxruntime-node) ships every platform's binaries, and its install script fetches ~500 MB
// of CUDA providers on Linux x64: the build skips the fetch (and so does CI), the image keeps its own platform only.
test('the image skips onnxruntime’s GPU download and keeps one platform’s binary', () => {
  const docker = read('Dockerfile');
  const build = docker.slice(0, docker.lastIndexOf('\nFROM '));
  assert.match(build, /^ENV ONNXRUNTIME_NODE_INSTALL=skip$/m);
  assert.ok(build.indexOf('ONNXRUNTIME_NODE_INSTALL=skip') < build.indexOf('npm ci'), 'before npm ci');
  assert.match(build, /rm -rf "\$ort\/darwin" "\$ort\/win32"/);
  assert.match(build, /find "\$ort\/linux" -mindepth 1 -maxdepth 1 ! -name "\$\(node -p process\.arch\)"/);
  assert.match(read('.github/workflows/ci.yml'), /^env:\n {2}ONNXRUNTIME_NODE_INSTALL: skip$/m);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.optionalDependencies['onnxruntime-node'], 'optional: the app runs without it (footage search off)');
});

// Caddy reads only what the compose file hands its service: every {$LAMPO_…} in either Caddyfile is mapped there, the
// older VR_ spelling of an .env from before the rename as the fallback (or the CDN config would serve no media host).
test('every setting a Caddyfile reads reaches the proxy, in either spelling', () => {
  const compose = read('docker-compose.yml');
  const caddy = compose.slice(compose.indexOf('  caddy:'), compose.indexOf('\nvolumes:'));
  const names = new Set([...`${read('deploy/Caddyfile')}\n${read('deploy/Caddyfile.cdn')}`.matchAll(/\{\$(\w+)\}/g)].map((m) => m[1]));
  assert.ok(names.has('LAMPO_DOMAIN') && names.has('LAMPO_MEDIA_DOMAIN'), [...names].join(' '));
  for (const name of names) {
    assert.match(name, /^LAMPO_/, `${name}: a Caddyfile says LAMPO_`);
    const old = name.replace(/^LAMPO_/, 'VR_');
    assert.match(caddy, new RegExp(`^ {6}${name}: \\$\\{${name}:-\\$\\{${old}:[-?]`, 'm'), `${name} reaches the caddy service, ${old} as the fallback`);
  }
});
