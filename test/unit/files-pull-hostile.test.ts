// `lampo files pull` against a server that isn't honest (taken over, or not what the agent thinks): whatever names it
// sends — `../`, absolute, a drive letter, a NUL, the record's own folder, two names that meet on a disk that ignores
// case, a hidden name nobody asked for — nothing lands outside the folder pulled to, nothing is written through a
// symbolic link there, and bytes that aren't what the server said (too many, another sha256) are never kept. The token
// goes only to the server's own download route: never to a signed URL elsewhere, nor along a redirect. A pull that
// broke off goes on with the bytes it has (a Range); one that doesn't fit on the disk fetches nothing.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv, tmpdir, VR } from '../lib/helpers.ts';

const { env } = isolatedEnv();

interface Served {
  path: string;
  bytes: Buffer;
  /** What the listing claims, when it lies. */
  size?: number;
  sha256?: string;
  /** Served from the other host's signed URL (else the server's own route), or redirected there from it. */
  how?: 'signed' | 'own' | 'redirect';
}
let served: Served[] = [];
/** What each host saw: [path, Authorization header, Range header]. */
const seen: { app: [string, string | undefined, string | undefined][]; other: [string, string | undefined, string | undefined][] } = { app: [], other: [] };

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const idOf = (i: number) => `fl_${String(i).padStart(12, '0')}`;
const infoOf = (s: Served, i: number) => ({
  id: idOf(i),
  area: 'Acme',
  path: s.path,
  v: 1,
  size: s.size ?? s.bytes.length,
  sha256: s.sha256 ?? sha(s.bytes),
  type: 'application/octet-stream',
  kind: 'other',
  by: 'Mallory',
  via: 'browser',
  at: '2026-10-13T12:00:00+02:00',
  added_by: 'Mallory',
  versions: 1,
});

/** Bytes, with a Range when asked (as the media host and the app answer). */
function sendBytes(req: http.IncomingMessage, res: http.ServerResponse, bytes: Buffer) {
  const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
  if (m) {
    const from = Number(m[1]);
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${bytes.length - 1}/${bytes.length}`, 'Content-Length': bytes.length - from });
    return res.end(bytes.subarray(from));
  }
  res.writeHead(200, { 'Content-Length': bytes.length });
  res.end(bytes);
}

let app: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';
before(async () => {
  other = http.createServer((req, res) => {
    seen.other.push([req.url ?? '', req.headers.authorization, req.headers.range]);
    const i = Number(/^\/blob\/fl_(\d+)$/.exec(req.url ?? '')?.[1] ?? -1);
    const s = served[i];
    if (!s) return void res.writeHead(404).end();
    sendBytes(req, res, s.bytes);
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  app = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    seen.app.push([u.pathname, req.headers.authorization, req.headers.range]);
    const json = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/api/files') return json({ folder: 'Acme', areas: [], path: '', dirs: [], files: served.map(infoOf), total: served.length });
    if (u.pathname === '/api/files/urls') {
      let body = '';
      req.on('data', (d) => {
        body += d;
      });
      req.on('end', () => {
        const { ids } = JSON.parse(body) as { ids: string[] };
        json({
          urls: ids.map((id) => {
            const i = Number(id.slice(3));
            const s = served[i] as Served;
            // the own route under a public address this machine doesn't reach: lampo goes to the server it knows
            const url = s.how === 'signed' ? `${otherBase}/blob/${id}` : `http://public.example/api/files/${id}/download?v=1`;
            return { ...infoOf(s, i), url, expires: '2026-10-13T13:00:00Z' };
          }),
          missing: [],
        });
      });
      return;
    }
    const own = /^\/api\/files\/fl_(\d+)\/download$/.exec(u.pathname);
    if (own) {
      if (req.headers.authorization !== 'Bearer vr_secret_token') return void res.writeHead(401).end();
      const s = served[Number(own[1])] as Served;
      if (s.how === 'redirect') return void res.writeHead(302, { Location: `${otherBase}/blob/${idOf(Number(own[1]))}` }).end();
      return sendBytes(req, res, s.bytes);
    }
    res.statusCode = 404;
    json({ error: 'not found' });
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => {
  app.close();
  other.close();
});

const remote = () => ({ ...env, VR_SERVER: base, VR_TOKEN: 'vr_secret_token' });
/** `lampo` against the stand-in server, which answers from this process: run without blocking it. */
const lampo = (args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) =>
    execFile(process.execPath, [VR, ...args], { env: remote(), cwd, encoding: 'utf8', timeout: 60_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, out, err }),
    ),
  );
/** Every file under `root`, relative, the record of pulls left out. */
const filesIn = (root: string): string[] =>
  (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => !f.startsWith('.lampo') && fs.lstatSync(path.join(root, f)).isFile()).sort();

test('hostile names: nothing outside the folder, nothing the record holds, two names that meet: one; hidden only when named', async () => {
  const work = tmpdir('vr-pull-evil-');
  const ok = Buffer.from('honest bytes');
  served = [
    { path: 'ok.txt', bytes: ok },
    { path: '../escape.txt', bytes: Buffer.from('x') },
    { path: 'Music/../../escape2.txt', bytes: Buffer.from('x') },
    { path: '/tmp/abs.txt', bytes: Buffer.from('x') },
    { path: 'C:/Windows/evil.dll', bytes: Buffer.from('x') },
    { path: 'nul\0byte.txt', bytes: Buffer.from('x') },
    { path: '.lampo/files.json', bytes: Buffer.from('{"v":1}') },
    { path: 'Fonts/Brand.otf', bytes: Buffer.from('deeper') },
    { path: 'fonts/brand.otf', bytes: Buffer.from('above') },
    { path: 'Fonts', bytes: Buffer.from('a file where a folder is') },
    { path: '.env', bytes: Buffer.from('EVIL=1') },
    { path: '.claude/settings.json', bytes: Buffer.from('{"permissions":{"allow":["Bash"]}}') },
  ];
  const r = await lampo(['files', 'pull', 'Acme', '--to', 'public/'], work);
  assert.equal(r.code, 1, 'refusals make the exit 1');
  const root = path.join(work, 'public');
  assert.deepEqual(filesIn(root), ['Fonts/Brand.otf', 'ok.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'Fonts/Brand.otf'), 'utf8'), 'deeper', 'the first of two names that meet (the deepest area’s)');
  assert.deepEqual(fs.readdirSync(work), ['public'], 'nothing beside the folder');
  assert.ok(!fs.existsSync(path.join(path.dirname(work), 'escape.txt')));
  for (const p of ['../escape.txt', 'Music/../../escape2.txt', '/tmp/abs.txt', 'C:/Windows/evil.dll', '.lampo/files.json', 'fonts/brand.otf'])
    assert.ok(r.out.includes(`left out: ${p}`), `${p} said: ${r.out}`);
  assert.match(r.out, /left out: 2 hidden \(\.env, \.claude\/settings\.json\): name one exactly to pull it/);
  // the record is the pull's own, never what the server sent for it
  const record = JSON.parse(fs.readFileSync(path.join(root, '.lampo/files.json'), 'utf8')) as { files: Record<string, unknown> };
  assert.deepEqual(Object.keys(record.files).sort(), ['Fonts/Brand.otf', 'ok.txt']);
  // a hidden name named exactly comes; a glob never takes one
  const glob = await lampo(['files', 'pull', 'Acme', '*', '--to', 'public/'], work);
  assert.ok(!fs.existsSync(path.join(root, '.env')), glob.out);
  const named = await lampo(['files', 'pull', 'Acme', '--only', '.env', '--to', 'public/'], work);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'EVIL=1', named.out);
  // a status looks at what a pull wrote itself, a hidden one too
  const st = await lampo(['files', 'status', '--to', 'public/'], work);
  assert.match(st.out, /^public\/ · pulled from Acme · 3 unchanged$/m, st.out + st.err);
});

test('a symbolic link in the folder pulled to is never written through, wherever it points', async () => {
  const work = tmpdir('vr-pull-link-');
  const outside = tmpdir('vr-pull-link-out-');
  fs.writeFileSync(path.join(outside, 'bed.wav'), 'mine');
  fs.mkdirSync(path.join(work, 'public'));
  fs.symlinkSync(outside, path.join(work, 'public', 'Music'));
  fs.symlinkSync(path.join(outside, 'bed.wav'), path.join(work, 'public', 'logo.svg'));
  served = [
    { path: 'Music/bed.wav', bytes: Buffer.from('theirs') },
    { path: 'Music/new.wav', bytes: Buffer.from('theirs') },
    { path: 'logo.svg', bytes: Buffer.from('<svg/>') },
  ];
  // a dry run says so, and makes nothing
  const dry = await lampo(['files', 'pull', 'Acme', '--to', 'public/', '--dry-run'], work);
  assert.match(dry.out, /left out: Music\/new\.wav — Music is a symbolic link here/);
  assert.deepEqual(fs.readdirSync(path.join(work, 'public')).sort(), ['Music', 'logo.svg']);
  const r = await lampo(['files', 'pull', 'Acme', '--to', 'public/', '--force'], work);
  assert.equal(r.code, 1);
  assert.deepEqual(fs.readdirSync(outside), ['bed.wav'], 'nothing landed where the links point');
  assert.equal(fs.readFileSync(path.join(outside, 'bed.wav'), 'utf8'), 'mine', 'not even with --force');
  assert.match(r.out, /left out: Music\/bed\.wav — Music is a symbolic link here/);
  assert.match(r.out, /left out: logo\.svg — a symbolic link is there/);
});

test('the token goes only to the server’s own route: never to a signed URL elsewhere, never along a redirect', async () => {
  const work = tmpdir('vr-pull-token-');
  served = [
    { path: 'signed.bin', bytes: crypto.randomBytes(3000), how: 'signed' },
    { path: 'own.bin', bytes: crypto.randomBytes(3000), how: 'own' },
    { path: 'moved.bin', bytes: crypto.randomBytes(3000), how: 'redirect' },
  ];
  seen.app.length = 0;
  seen.other.length = 0;
  const r = await lampo(['files', 'pull', 'Acme', '--to', 'out'], work);
  assert.equal(r.code, 0, r.out + r.err);
  for (const s of served) assert.ok(fs.readFileSync(path.join(work, 'out', s.path)).equals(s.bytes), s.path);
  assert.ok(seen.other.length >= 2, 'the signed and the redirected bytes came from the other host');
  assert.ok(
    seen.other.every(([, auth]) => auth === undefined),
    `no token elsewhere: ${JSON.stringify(seen.other)}`,
  );
  assert.ok(
    seen.app.some(([p, auth]) => p.endsWith('/download') && auth === 'Bearer vr_secret_token'),
    'the own route, with the token, where this machine reaches it',
  );
});

test('bytes that aren’t the file are never kept: more than its size, or another sha256', async () => {
  const work = tmpdir('vr-pull-lies-');
  served = [
    { path: 'long.bin', bytes: crypto.randomBytes(4000), size: 1000 },
    { path: 'other.bin', bytes: Buffer.from('not what was said'), sha256: 'f'.repeat(64) },
    { path: 'fine.bin', bytes: Buffer.from('fine') },
  ];
  const r = await lampo(['files', 'pull', 'Acme', '--to', 'out'], work);
  assert.equal(r.code, 1);
  assert.deepEqual(filesIn(path.join(work, 'out')), ['fine.bin']);
  assert.ok(
    fs.readdirSync(path.join(work, 'out')).every((f) => !f.endsWith('.part')),
    'no part kept of bytes that can’t be the file',
  );
  assert.match(r.out, /failed: long\.bin — more bytes came than the file has/);
  assert.match(r.out, /failed: other\.bin — the bytes that came are not the file’s/);
});

test('a pull that broke off goes on where it stopped (a Range), and one that doesn’t fit fetches nothing', async () => {
  const work = tmpdir('vr-pull-resume-');
  const bytes = crypto.randomBytes(64 * 1024);
  served = [{ path: 'Footage/A001.mov', bytes, how: 'signed' }];
  fs.mkdirSync(path.join(work, 'out', 'Footage'), { recursive: true });
  fs.writeFileSync(path.join(work, 'out', 'Footage', `.lampo-${sha(bytes).slice(0, 16)}.part`), bytes.subarray(0, 40_000));
  seen.other.length = 0;
  const r = await lampo(['files', 'pull', 'Acme', '--to', 'out'], work);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(fs.readFileSync(path.join(work, 'out', 'Footage', 'A001.mov')).equals(bytes));
  assert.deepEqual(
    seen.other.map(([, , range]) => range),
    ['bytes=40000-'],
  );
  assert.deepEqual(fs.readdirSync(path.join(work, 'out', 'Footage')), ['A001.mov']);
  // a file the disk has no room for: said, nothing fetched
  served = [{ path: 'huge.mov', bytes: Buffer.from('x'), size: 9e15 }];
  const full = await lampo(['files', 'pull', 'Acme', '--to', 'big'], work);
  assert.equal(full.code, 1);
  assert.match(full.err, /needs 9000 TB, .* free in big: pull only what this needs/);
  assert.deepEqual(fs.readdirSync(path.join(work, 'big')), []);
});
