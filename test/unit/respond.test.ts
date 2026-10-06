// What makes answers cheap on a real network (server/respond.ts): JSON with an ETag and a 304 for a tab that already has
// it, brotli or gzip for big answers (never for the ones that carry secrets), Server-Timing, and the built UI sent
// pre-compressed with hashed files cached for good.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import express from 'express';
import { fastJson } from '../../server/respond.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { staticUi } = await import('../../server/app.ts');
const store = await import('../../lib/store.ts');
const { DATA } = await import('../../lib/paths.ts');

// A built UI of its own: a page, a hashed script with its pre-compressed copies, a file the build didn't compress.
const dist = tmpdir('vr-dist-');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
const script = `console.log(${JSON.stringify('x'.repeat(4000))});\n`;
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>'.padEnd(2000, ' '));
fs.writeFileSync(path.join(dist, 'index.html.br'), zlib.brotliCompressSync(fs.readFileSync(path.join(dist, 'index.html'))));
fs.writeFileSync(path.join(dist, 'assets/app-Ab12Cd.js'), script);
fs.writeFileSync(path.join(dist, 'assets/app-Ab12Cd.js.br'), zlib.brotliCompressSync(script));
fs.writeFileSync(path.join(dist, 'assets/app-Ab12Cd.js.gz'), zlib.gzipSync(script));
fs.writeFileSync(path.join(dist, 'assets/font-Zz99.woff2'), Buffer.alloc(3000, 1));

// Enough videos in the library that its answer is worth compressing (review.json files written directly).
fs.mkdirSync(DATA, { recursive: true });
for (let i = 0; i < 30; i++) {
  const video = path.join(dist, `v${i}.mp4`);
  const slug = video.split('/').join('__');
  fs.mkdirSync(path.join(DATA, slug), { recursive: true });
  const review = { video, project: dist, fps: 25, width: 320, height: 180, duration: 1, frames: 25, versions: [], comments: [], session: null, folder: null };
  fs.writeFileSync(path.join(DATA, slug, 'review.json'), JSON.stringify({ ...review, added: '2026-01-01T00:00:00+00:00', added_by: 'Sam' }));
}
assert.ok(store.listReviews().length >= 30);

const { port } = await startApp({ token: 't', loadSessions: async () => [], ui: staticUi(dist) });

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
const get = (p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
const decode = (r: Raw) =>
  r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.body) : r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;

test('JSON: an ETag, and a 304 without a body for a client that has it', async () => {
  const first = await get('/api/library');
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.match(String(etag), /^W\/".+"$/);
  assert.equal(first.headers['cache-control'], 'private, no-cache', 'kept, but asked again every time');
  const again = await get('/api/library', { 'If-None-Match': String(etag) });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, etag);
  // Something changed: a new ETag, the new body.
  const rv = store.listReviews()[0];
  store.mutate(rv.video.split('/').join('__'), (r) => {
    r.folder = 'Moved';
  });
  const changed = await get('/api/library', { 'If-None-Match': String(etag) });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, etag);
});

test('JSON: brotli when accepted, else gzip, else as is — same bytes after decoding', async () => {
  const plain = await get('/api/library');
  assert.equal(plain.headers['content-encoding'], undefined, 'no Accept-Encoding: not compressed');
  const br = await get('/api/library', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(String(br.headers.vary), /Accept-Encoding/);
  assert.ok(br.body.length < plain.body.length / 3, `compressed ${br.body.length} of ${plain.body.length}`);
  assert.equal(Number(br.headers['content-length']), br.body.length);
  const gz = await get('/api/library', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const noBr = await get('/api/library', { 'Accept-Encoding': 'br;q=0, gzip' });
  assert.equal(noBr.headers['content-encoding'], 'gzip', 'q=0 is a no');
  assert.deepEqual(JSON.parse(decode(br).toString()), JSON.parse(plain.body.toString()));
  assert.deepEqual(JSON.parse(decode(gz).toString()), JSON.parse(plain.body.toString()));
  // The ETag names the content, whatever the encoding: a 304 works across them.
  assert.equal(br.headers.etag, plain.headers.etag);
  assert.equal((await get('/api/library', { 'Accept-Encoding': 'br', 'If-None-Match': String(plain.headers.etag) })).status, 304);
});

test('JSON: small answers and answers that can carry secrets are never compressed', async () => {
  const info = await get('/api/auth/status', { 'Accept-Encoding': 'br' });
  assert.equal(info.status, 200);
  assert.equal(info.headers['content-encoding'], undefined, 'small');
  // Tokens, invites, sessions, review links: a size that moves with attacker-chosen input next to a secret leaks it.
  const app = express();
  app.use(fastJson());
  const big = { list: Array.from({ length: 200 }, (_, i) => ({ token: `secret-${i}`, label: 'x'.repeat(20) })) };
  for (const p of ['/api/auth/tokens', '/api/admin/invites', '/api/review/a/shares', '/api/folder-shares', '/api/shares/t', '/oauth/token', '/api/library'])
    app.get(p, (_req, res) => {
      res.json(big);
    });
  const other = http.createServer(app);
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = (other.address() as AddressInfo).port;
  try {
    for (const p of ['/api/auth/tokens', '/api/admin/invites', '/api/review/a/shares', '/api/folder-shares', '/api/shares/t', '/oauth/token']) {
      const r = await fetch(`http://127.0.0.1:${otherPort}${p}`, { headers: { 'Accept-Encoding': 'br, gzip' } });
      assert.equal(r.headers.get('content-encoding'), null, p);
      // and no CDN in front compresses them either (Cloudflare compresses JSON by itself unless told no-transform)
      assert.equal(r.headers.get('cache-control'), 'private, no-cache, no-transform', p);
    }
    const lib = await fetch(`http://127.0.0.1:${otherPort}/api/library`, { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(lib.headers.get('content-encoding'), 'br', 'the same answer elsewhere is compressed');
    assert.equal(lib.headers.get('cache-control'), 'private, no-cache');
  } finally {
    other.close();
  }
});

test('JSON: Server-Timing says where the time went; errors and writes carry no ETag', async () => {
  const r = await get('/api/library', { 'Accept-Encoding': 'br' });
  assert.match(String(r.headers['server-timing']), /^app;dur=[\d.]+, json;dur=[\d.]+, zip;dur=[\d.]+$/);
  const missing = await get('/api/review/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.etag, undefined);
  assert.match(String(missing.headers['server-timing']), /app;dur=/);
  const head = await get('/api/library', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.ok(Number(head.headers['content-length']) > 1000, 'HEAD says how long the body would be');
});

test('built UI: hashed files immutable and pre-compressed, the page always revalidated', async () => {
  const br = await get('/assets/app-Ab12Cd.js', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(String(br.headers['content-type']), /javascript/);
  assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), script);
  const gz = await get('/assets/app-Ab12Cd.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString(), script);
  const plain = await get('/assets/app-Ab12Cd.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), script);
  assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
  const font = await get('/assets/font-Zz99.woff2', { 'Accept-Encoding': 'br' });
  assert.equal(font.headers['content-encoding'], undefined, 'fonts are compressed already');
  assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
  const page = await get('/some/route', { 'Accept-Encoding': 'br' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-encoding'], 'br');
  assert.equal(page.headers['cache-control'], 'no-cache, no-transform', 'nothing in front may rewrite the page (its CSP pins a script hash)');
  assert.match(zlib.brotliDecompressSync(page.body).toString(), /<title>t<\/title>/);
});

test('the live stream asks anything in front to pass it on untouched (no-transform), like the page', async () => {
  const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      resolve(res.headers);
      req.destroy();
    });
    req.on('error', reject);
  });
  assert.equal(headers['content-type'], 'text/event-stream');
  assert.equal(headers['cache-control'], 'no-cache, no-transform');
  assert.equal((await get('/some/route')).headers['cache-control'], 'no-cache, no-transform', 'the page uncompressed too');
});
