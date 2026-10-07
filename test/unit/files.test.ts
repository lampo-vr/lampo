// covers: lib/files.ts lib/fileAreas.ts lib/fileText.ts server/routes/files.ts
// Project files on a person's own machine (no VR_MODE, no media host): the owner at the machine pushes and downloads,
// the app streams the bytes itself as inert attachments (ranges, HEAD reads nothing, an aborted download closes its
// file). The rules every way in shares: what a path inside an area may be, junk, kinds, a copy's name. The purge never
// sweeps bytes an upload has claimed or that are younger than a day; a catalog that can't be read refuses, never reads
// as empty.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const text = await import('../../lib/fileText.ts');
const files = await import('../../lib/files.ts');
const fileAreas = await import('../../lib/fileAreas.ts');
const { inWorkspace } = await import('../../lib/scope.ts');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
/** As the owner of this machine (loopback, no proxy headers). */
function call(method: string, url: string, { body, headers = {} }: { body?: Buffer | object; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const h = {
      ...(data ? { 'content-length': String(data.length) } : {}),
      ...(data && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, body: b, json: () => JSON.parse(b.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Pushes one file to the House (or `folder`) through its one-time URL; the file's info. */
async function put(p: string, data: Buffer, folder = '') {
  const ask = await call('POST', '/api/files/uploads', { body: { folder, files: [{ path: p, size: data.length, sha256: sha(data) }] } });
  assert.equal(ask.status, 200, ask.body.toString());
  const slot = ask.json().uploads[0];
  if (slot.url) {
    const r = await call('PUT', new URL(slot.url).pathname, { body: data });
    assert.equal(r.status, 200, r.body.toString());
  }
  const l = await call('GET', `/api/files?folder=${encodeURIComponent(folder)}&deep=1`);
  return l.json().files.find((f: { path: string }) => f.path === p);
}

test('a path inside an area is kept as uploaded or refused, never rewritten — but for Unicode’s one form', () => {
  assert.equal(text.cleanFilePath('Footage/Day 1/A001C003.mov'), 'Footage/Day 1/A001C003.mov');
  assert.equal(text.cleanFilePath('Café/menu.pdf'), 'Café/menu.pdf', 'NFC: a Mac’s names read the same everywhere');
  assert.equal(text.cleanFilePath('odd\ud800.txt'), 'odd�.txt', 'a lone surrogate is made whole, as on the disk');
  for (const bad of [
    '',
    '/abs.txt',
    '../up.txt',
    'a/../b.txt',
    'a/./b.txt',
    'a\\b.txt',
    'nul\u0000.txt',
    'line\nbreak.txt',
    'sep .txt',
    'bidi‮.txt',
    'a//b.txt',
    'trailing/',
    ' space.txt',
    'space.txt ',
    'dir /a.txt',
    `${'x'.repeat(256)}.txt`,
    Array.from({ length: 33 }, () => 'd').join('/'),
    `${'é'.repeat(600)}`,
    '.DS_Store',
    'shots/._A001.mov',
    'repo/.git/config',
    '__MACOSX/a.png',
    'Thumbs.db',
  ])
    assert.throws(() => text.cleanFilePath(bad), text.FilePathError, JSON.stringify(bad));
  assert.equal(text.filePathProblem('ok.txt'), null);
  assert.ok(text.isJunkPath('a/node_modules/b.js'));
  assert.ok(!text.isJunkPath('.gitignore'));
});

test('kinds: a project file by its extension, else what the bytes say, else the name', () => {
  assert.equal(text.kindOf('spot.aep', 'application/octet-stream'), 'project');
  assert.equal(text.kindOf('spot.psd', 'image/vnd.adobe.photoshop'), 'project');
  assert.equal(text.kindOf('A001.MOV', 'video/quicktime'), 'footage');
  assert.equal(text.kindOf('take.bin', 'audio/wav'), 'audio');
  assert.equal(text.kindOf('mark.svg', 'image/svg+xml'), 'graphic');
  assert.equal(text.kindOf('Brand.otf', 'application/octet-stream'), 'font');
  assert.equal(text.kindOf('script.srt', 'text/plain'), 'document');
  assert.equal(text.kindOf('mystery', 'application/octet-stream'), 'other');
  assert.ok(text.inlineType('image/png') && text.inlineType('video/mp4') && text.inlineType('text/plain'));
  assert.ok(!text.inlineType('image/svg+xml') && !text.inlineType('text/html') && !text.inlineType('application/octet-stream'));
});

test('a copy’s name beside the file it would have replaced: whose it is, numbered when taken', () => {
  const taken = new Set(['spot (alex).aep']);
  assert.equal(
    text.copyPath('Project/spot.aep', 'Alex', (k) => taken.has(k)),
    'Project/spot (Alex).aep',
  );
  assert.equal(
    text.copyPath('spot.aep', 'Alex', (k) => taken.has(k)),
    'spot (Alex 2).aep',
  );
  assert.equal(
    text.copyPath('Makefile', 'a/b\nc', () => false),
    'Makefile (a b c)',
  );
});

test('on the machine: the owner pushes, and the app streams the bytes as an inert attachment with ranges', async () => {
  const data = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(20_000)]);
  const f = await put('Docs/brief.pdf', data);
  assert.equal(f.type, 'application/pdf');
  assert.equal(f.kind, 'document');
  assert.equal(f.via, 'browser');
  const r = await call('GET', `/api/files/${f.id}/download`);
  assert.equal(r.status, 200);
  assert.equal(sha(r.body), sha(data));
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(String(r.headers['content-security-policy']), /sandbox/);
  assert.match(String(r.headers['content-disposition']), /^attachment; filename="brief\.pdf"/);
  const part = await call('GET', `/api/files/${f.id}/download`, { headers: { Range: 'bytes=100-' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, data.length - 100);
  const head = await call('HEAD', `/api/files/${f.id}/download`);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(data.length));
  const inline = await call('GET', `/api/files/${f.id}/download?inline=1`);
  assert.equal(inline.headers['content-type'], 'application/pdf');
  assert.match(String(inline.headers['content-disposition']), /^inline/);
  // only `v` and `inline`: a path is never a way to name what is served
  assert.equal((await call('GET', `/api/files/${f.id}/download?path=/etc/passwd`)).status, 400);
  assert.equal((await call('GET', '/api/files/fl_000000000000/download')).status, 404);
  // download URLs without a media host: the app's own path, for whoever is signed in
  const urls = await call('POST', '/api/files/urls', { body: { ids: [f.id] } });
  assert.match(urls.json().urls[0].url, new RegExp(`/api/files/${f.id}/download\\?v=1$`));
});

test('a download broken off closes its file: aborted streams leave no file open behind them', async () => {
  const big = crypto.randomBytes(8 * 1024 * 1024);
  const f = await put('Footage/big.bin', big);
  const blob = inWorkspace('w1', () => path.join(fileAreas.filesDir(), 'sha256', f.sha256.slice(0, 2), f.sha256));
  assert.ok(fs.existsSync(blob), 'kept in data/, never the cache');
  assert.ok(blob.startsWith(path.join(dir, 'data')), blob);
  const fdDir = fs.existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
  const named = fdDir === '/proc/self/fd';
  const count = () =>
    named
      ? fs.readdirSync(fdDir).filter((fd) => {
          try {
            return fs.readlinkSync(path.join(fdDir, fd)) === fs.realpathSync(blob);
          } catch {
            return false;
          }
        }).length
      : fs.readdirSync(fdDir).length;
  const before = count();
  const abort = (headers: Record<string, string>) =>
    new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/files/${f.id}/download`, headers, agent: false }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      req.end();
    });
  for (let i = 0; i < 20; i++) await abort(i % 2 ? { Range: 'bytes=1000-' } : {});
  let after = count();
  for (let i = 0; i < 50 && after > before; i++) {
    await new Promise((r) => setTimeout(r, 50));
    after = count();
  }
  assert.ok(after <= before, `open ${named ? 'copies of the blob' : 'descriptors'}: ${before} before, ${after} after 20 aborted downloads`);
});

test('the purge: bytes nothing names go after a day, never sooner, never while an upload holds them', async () => {
  const loose = crypto.randomBytes(1000);
  // stored, never committed (a push that ends before its commit): kept for its grace
  const ask = await call('POST', '/api/files/uploads', { body: { files: [{ path: 'loose.bin', size: loose.length, sha256: sha(loose) }], commit: false } });
  const r = await call('PUT', new URL(ask.json().uploads[0].url).pathname, { body: loose });
  assert.equal(r.status, 200, r.body.toString());
  assert.equal(r.json().commit, undefined, 'stored only');
  assert.deepEqual(
    inWorkspace('w1', () => files.missingBlobs([sha(loose)])),
    [],
  );
  const soon = await inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 3600_000 }));
  assert.equal(soon.blobs, 0, 'within the day: kept');
  // a commit within the day makes it a file: never swept
  const c = await call('POST', '/api/files/commit', { body: { add: [{ path: 'loose.bin', sha256: sha(loose), size: loose.length }] } });
  assert.equal(c.status, 200);
  const later = await inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 2 * 86_400_000 }));
  assert.equal(later.blobs, 0, 'named by a file: kept');
  // an orphan past its day goes; an upload's claim (bytes on their way) is respected
  const orphan = crypto.randomBytes(500);
  const ask2 = await call('POST', '/api/files/uploads', { body: { files: [{ path: 'o.bin', size: orphan.length, sha256: sha(orphan) }], commit: false } });
  await call('PUT', new URL(ask2.json().uploads[0].url).pathname, { body: orphan });
  const gone = await inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 2 * 86_400_000 }));
  assert.equal(gone.blobs, 1);
  assert.deepEqual(
    inWorkspace('w1', () => files.missingBlobs([sha(orphan)])),
    [sha(orphan)],
  );
});

test('a catalog that can’t be read is never empty: reads and writes refuse, nothing is written over it', async () => {
  const f = await put('Keep/me.txt', Buffer.from('keep me\n'));
  assert.ok(f);
  const file = inWorkspace('w1', () => fileAreas.areaFile(fileAreas.HOUSE_AREA));
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, '{"id": "fa_house", "files": [');
  try {
    const list = await call('GET', '/api/files');
    assert.equal(list.status, 503, list.body.toString());
    const data = Buffer.from('new\n');
    const w = await call('POST', '/api/files/commit', { body: { add: [{ path: 'x.txt', sha256: sha(data), size: data.length }] } });
    assert.ok(w.status >= 400, `${w.status}`);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"id": "fa_house", "files": [', 'never written over');
    await assert.rejects(
      inWorkspace('w1', () => files.purgeFiles({ now: Date.now() + 90 * 86_400_000 })),
      fileAreas.FilesUnreadableError,
    );
  } finally {
    fs.writeFileSync(file, good);
  }
  assert.equal((await call('GET', '/api/files')).status, 200);
  assert.equal((await call('GET', `/api/files/${f.id}/download`)).status, 200, 'its bytes were never swept');
});
