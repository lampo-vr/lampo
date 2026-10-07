// What a first production start needs to be safe (docs/go-live.md): a hosted server refuses settings it can't run
// safely with — an address that isn't an origin, plain http across a network, an https address without the TLS proxy
// named, unsigned CDN addresses, a damaged key, a store it can't write — each in one plain line, never a stack trace;
// uploads are bounded; nothing it serves is for search engines; forwarding headers from a peer nobody named are said
// in the log; and scripts/smoke.ts tells a healthy instance from a broken one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { productionTimeouts, startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, ROOT, tmpdir, vr } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test', VR_TRUST_PROXY: 'loopback' } });
const { loadConfig, startupProblems } = await import('../../lib/config.ts');
const { checkKey, secret } = await import('../../lib/auth.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp, staticUi, untrustedProxyWarning } = await import('../../server/app.ts');
const { createShare } = await import('../../lib/shares.ts');

const problems = (env: Record<string, string>) => startupProblems(loadConfig({ VR_MODE: 'server', ...env }), env);

test('the public URL: an origin, over https across a network, with the TLS proxy named', () => {
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'uniquelocal' }), []);
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'https://review.example.com/', VR_TRUST_PROXY: 'loopback' }), [], 'a trailing slash is fine');
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'http://localhost:4747' }), [], 'plain http on this machine (docker quick start)');
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'http://127.0.0.1:4747' }), []);

  const [scheme] = problems({ VR_PUBLIC_URL: 'review.example.com' });
  assert.match(scheme ?? '', /with its scheme, like https:\/\/review\.example\.com \(got "review\.example\.com"\)/);
  const [sub] = problems({ VR_PUBLIC_URL: 'https://example.com/review', VR_TRUST_PROXY: 'loopback' });
  assert.match(sub ?? '', /only the scheme and host.*not under a path/);

  const [clear] = problems({ VR_PUBLIC_URL: 'http://review.example.com' });
  assert.match(clear ?? '', /plain http on a host other than this machine.*VR_ALLOW_HTTP=1/);
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'http://review.example.com', VR_ALLOW_HTTP: '1' }), [], 'a closed test network, on purpose');

  const [proxy] = problems({ VR_PUBLIC_URL: 'https://review.example.com' });
  assert.match(proxy ?? '', /VR_TRUST_PROXY.*loopback.*uniquelocal.*lock everyone out/);
  assert.deepEqual(problems({ VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'false' }), [], 'saying so explicitly is a choice');
});

test('ports, storage kinds and a CDN without signed addresses', () => {
  const ok = { VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'loopback' };
  assert.match(problems({ ...ok, VR_PORT: 'abc' })[0] ?? '', /VR_PORT must be a port number/);
  assert.match(problems({ ...ok, VR_STORAGE: 'bunnny' })[0] ?? '', /VR_STORAGE must be local, bunny or s3 \(got "bunnny"\)/);
  const bunny = { ...ok, VR_STORAGE: 'bunny', VR_BUNNY_ZONE: 'z', VR_BUNNY_ACCESS_KEY: 'k', VR_BUNNY_REGION: 'de' };
  assert.deepEqual(problems(bunny), [], 'streams through the server without a CDN');
  assert.match(problems({ ...bunny, VR_BUNNY_CDN_URL: 'https://z.b-cdn.net' })[0] ?? '', /without VR_BUNNY_TOKEN_KEY.*anyone who has or guesses one/);
  assert.deepEqual(problems({ ...bunny, VR_BUNNY_CDN_URL: 'https://z.b-cdn.net', VR_BUNNY_TOKEN_KEY: 't' }), []);
  assert.deepEqual(startupProblems(loadConfig({}), {}), [], 'the machine needs none of it');
});

test('publishing’s endpoints that can’t be read stop the start with one line, on the machine too', () => {
  const ok = { VR_PUBLIC_URL: 'https://review.example.com', VR_TRUST_PROXY: 'loopback' };
  for (const [given, says] of [
    ['nope', /^VR_PUBLISH_ENDPOINTS is not JSON/],
    ['["https://example.com"]', /^VR_PUBLISH_ENDPOINTS must be a JSON object/],
    ['{"youtube":"not a url"}', /^VR_PUBLISH_ENDPOINTS: youtube must be an http\(s\) URL/],
    ['{"zernio":"ftp://example.com/api"}', /^VR_PUBLISH_ENDPOINTS: zernio must be an http\(s\) URL/],
  ] as const) {
    const [line, ...more] = problems({ ...ok, VR_PUBLISH_ENDPOINTS: given });
    assert.match(line ?? '', says, given);
    assert.ok(!(line ?? '').includes('\n') && !more.length, `one line: ${line}`);
    assert.match(startupProblems(loadConfig({}), { VR_PUBLISH_ENDPOINTS: given })[0] ?? '', says, `the machine: ${given}`);
  }
  assert.deepEqual(problems({ ...ok, VR_PUBLISH_ENDPOINTS: '{"youtube":"http://127.0.0.1:9000/youtube/v3"}' }), [], 'a test’s fake platform');
});

test('a key file that is cut short is refused, never used to sign', () => {
  assert.throws(
    () => checkKey(Buffer.alloc(0), 'data/secret.key', 'x'),
    /data\/secret\.key is damaged \(0 bytes, a key needs 32\): restore it from your backup/,
  );
  assert.equal(checkKey(Buffer.alloc(32, 1), 'f', 'x').length, 32);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'secret.key'), '');
  // what a new key costs is said, publishing's sealed keys and unfinished uploads too (A12 PUB-16)
  assert.throws(() => secret(), /secret\.key is damaged.*every publishing connection is added again, and an unfinished upload starts over/);
  fs.rmSync(path.join(dir, 'data', 'secret.key'));
  assert.equal(secret().length, 32, 'a missing key is simply made');
});

/** Starts the real process with one bad setting: it must stop with plain `video-review:` lines. */
function start(env: Record<string, string>, prepare?: (store: string) => void) {
  const store = tmpdir('vr-start-');
  prepare?.(store);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server/index.ts')], {
    env: {
      PATH: process.env.PATH,
      HOME: store,
      VR_MODE: 'server',
      VR_DATA: path.join(store, 'data'),
      VR_CACHE: path.join(store, 'cache'),
      VR_CONFIG: path.join(store, 'none.json'),
      VR_PORT: '1',
      VR_STT: 'off',
      VR_PUBLIC_URL: 'https://review.test',
      VR_TRUST_PROXY: 'loopback',
      ...env,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: r.status, err: r.stderr };
}

test('the process stops at once on a bad setting, saying what to do in one line, without a stack trace', () => {
  const cases: [Record<string, string>, RegExp, ((store: string) => void)?][] = [
    [{ VR_PUBLIC_URL: 'review.test' }, /VR_PUBLIC_URL must be the address people open/],
    [{ VR_TRUST_PROXY: 'caddy' }, /VR_TRUST_PROXY: "caddy" is not an address/],
    [{ VR_UPLOAD_MAX: 'lots' }, /not a size: lots/],
    [{ VR_STORAGE: 'bunny' }, /storage "bunny" needs bunny\.zone/],
    [
      {},
      /secret\.key is damaged/,
      (store) => {
        fs.mkdirSync(path.join(store, 'data'));
        fs.writeFileSync(path.join(store, 'data', 'secret.key'), 'x');
      },
    ],
    [
      {},
      /can't write to .*data \(EACCES\).*chown -R 1000:1000/,
      (store) => {
        fs.mkdirSync(path.join(store, 'data'));
        fs.chmodSync(path.join(store, 'data'), 0o500);
      },
    ],
  ];
  // root writes anywhere: the read-only folder case only means something for an ordinary user (as in the container).
  if (process.getuid?.() === 0) cases.pop();
  for (const [env, want, prepare] of cases) {
    const { status, err } = start(env, prepare);
    assert.equal(status, 1, `${JSON.stringify(env)} exits 1: ${err}`);
    assert.match(err, want);
    assert.match(err, /^video-review: /, 'starts with the app name');
    assert.doesNotMatch(err, /^\s+at /m, `no stack trace: ${err}`);
  }
});

const dist = tmpdir('vr-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>shell</title>');
const { request } = await startApp({ ui: staticUi(dist), headers: { Host: 'review.test' } });

test('uploads are bounded: over VR_UPLOAD_MAX, or of an unknown size, they are refused before a byte is stored', async () => {
  const auth = await import('../../lib/auth.ts');
  const u = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  const headers = { Authorization: `Bearer ${auth.createToken(u.id, 't').token}`, 'Tus-Resumable': '1.0.0', 'Upload-Metadata': 'filename YS5tcDQ=' };
  const max = loadConfig().upload_max_bytes;
  const big = await request('POST', '/api/uploads', { headers: { ...headers, 'Upload-Length': String(max + 1) } });
  assert.equal(big.status, 413, big.text);
  const unknown = await request('POST', '/api/uploads', { headers: { ...headers, 'Upload-Defer-Length': '1' } });
  assert.equal(unknown.status, 400, unknown.text);
  assert.match(unknown.text, /size must be known/);
});

/** A request whose body comes `piece` bytes every `every` ms over a socket of its own: the answer's status (0: closed
 * without one), its text, and how long it took. */
function trickle(
  port: number,
  head: { method: string; url: string; headers?: Record<string, string> },
  body: Buffer,
  { piece, every }: { piece: number; every: number },
): Promise<{ status: number; text: string; ms: number; sent: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const s = net.connect(port, '127.0.0.1');
    let got = '';
    let sent = 0;
    const lines = Object.entries({ Host: 'review.test', Connection: 'close', 'Content-Length': String(body.length), ...head.headers });
    const drip = setInterval(() => {
      if (sent >= body.length || s.destroyed) return clearInterval(drip);
      s.write(body.subarray(sent, sent + piece));
      sent += piece;
    }, every);
    s.on('connect', () => s.write(`${head.method} ${head.url} HTTP/1.1\r\n${lines.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
    s.on('data', (d) => {
      got += d;
    });
    s.on('error', () => {});
    s.on('close', () => {
      clearInterval(drip);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0), text: got, ms: Date.now() - start, sent: Math.min(sent, body.length) });
    });
  });
}

test('only an upload’s body may stream for hours (a whole render in one PUT); any other body has Node’s 5 minutes', async () => {
  // Node's own requestTimeout (5 minutes) cut a one-time upload URL's PUT of a render that takes longer to send (sweep 2
  // MH-4), and 6 hours for every request let a JSON body trickled in byte by byte hold a connection for that long: a
  // render's body (tus, a one-time URL's PUT) has the long time, every other one Node's own. The process sets them, with
  // the keep-alive and header timeouts, and every test server mirrors it.
  const { SERVER_TIMEOUTS, serverTimeouts, uploadBody } = await import('../../server/listen.ts');
  // Scaled down: a body has 300 ms, an upload's 60 s.
  const auth = await import('../../lib/auth.ts');
  const u = await auth.createUser({ email: 'slow@example.com', name: 'Slow', password: 'a long password', role: 'member' });
  const bearer = { Authorization: `Bearer ${auth.createToken(u.id, 't').token}` };
  const short = await startApp({ timeouts: { ...SERVER_TIMEOUTS, request: 300, upload: 60_000 }, headers: { Host: 'review.test' } });
  // a JSON body that trickles (one byte every 200 ms: 8 s in all) is cut at the body's time, 408 and closed …
  const json = Buffer.from(JSON.stringify({ filename: 'slow.mp4', folder: 'Slow' }));
  const cut = await trickle(short.port, { method: 'POST', url: '/api/uploads/tickets', headers: { ...bearer, 'Content-Type': 'application/json' } }, json, {
    piece: 1,
    every: 200,
  });
  assert.equal(cut.status, 408, cut.text);
  assert.ok(cut.sent < json.length, `cut before the body was in (${cut.sent} of ${json.length} bytes, ${cut.ms} ms)`);
  // … while a render that takes several times as long into its one-time URL arrives
  const issued = await short.request('POST', '/api/uploads/tickets', { body: { filename: 'slow.mp4', folder: 'Slow' }, headers: bearer });
  assert.equal(issued.status, 200, issued.text);
  const clip = fs.readFileSync(makeVideo(path.join(dir, 'in/slow.mp4'), { w: 160, h: 90, dur: 1 }));
  const put = await trickle(short.port, { method: 'PUT', url: new URL(issued.json().url).pathname }, clip, { piece: Math.ceil(clip.length / 8), every: 200 });
  assert.equal(put.status, 200, put.text);
  assert.ok(put.ms > 1000, `it took ${put.ms} ms, past the body's 300`);
  // an upload refused before its body is in keeps no kept-alive connection for the rest of it beyond a body's time
  const gone = await trickle(short.port, { method: 'PUT', url: `/api/uploads/direct/vrup_${'x'.repeat(32)}`, headers: { Connection: 'keep-alive' } }, clip, {
    piece: Math.ceil(clip.length / 8),
    every: 200,
  });
  assert.equal(gone.status, 404, gone.text);
  assert.ok(gone.sent < clip.length, `the connection ended before the body was in (${gone.sent} of ${clip.length} bytes, ${gone.ms} ms)`);

  // The process's own: Node's default for a body, hours for an upload's, headers within a minute.
  assert.equal(SERVER_TIMEOUTS.request, 300_000, 'Node’s own default for a body');
  assert.ok(SERVER_TIMEOUTS.upload >= 3600_000, `an upload may take ${SERVER_TIMEOUTS.upload / 1000} s`);
  assert.ok(SERVER_TIMEOUTS.request > SERVER_TIMEOUTS.headers, 'a slow body is not a slow header');
  const srv = serverTimeouts(http.createServer());
  // Node's own check holds every body to the longest; each request's own deadline comes first
  assert.deepEqual(
    [srv.keepAliveTimeout, srv.headersTimeout, srv.requestTimeout],
    [SERVER_TIMEOUTS.keepAlive, SERVER_TIMEOUTS.headers, SERVER_TIMEOUTS.upload],
  );
  assert.match(fs.readFileSync(path.join(ROOT, 'server/index.ts'), 'utf8'), /\bserverTimeouts\(http\)/, 'the process sets them on its server');
  const mirror = productionTimeouts(http.createServer());
  assert.deepEqual([mirror.keepAliveTimeout, mirror.headersTimeout, mirror.requestTimeout], [srv.keepAliveTimeout, srv.headersTimeout, srv.requestTimeout]);
  // a render's body: tus (a new upload with its first bytes, each piece after) and a one-time URL's PUT; nothing else
  const tus = `/api/uploads/${'0a'.repeat(16)}`;
  const ticket = `/api/uploads/direct/vrup_${'x'.repeat(32)}`;
  for (const [method, url] of [
    ['POST', '/api/uploads'],
    ['PATCH', tus],
    ['PATCH', `${tus}?x=1`],
    ['PUT', ticket],
  ] as const)
    assert.ok(uploadBody(method, url), `${method} ${url}`);
  for (const [method, url] of [
    ['POST', '/api/uploads/tickets'],
    ['PATCH', '/api/uploads/tickets'],
    ['PUT', tus],
    ['POST', ticket],
    ['PUT', `${ticket}/`],
    ['PUT', '/API/uploads/direct/x'],
    ['POST', '/api/library'],
    ['POST', '/mcp'],
  ] as const)
    assert.ok(!uploadBody(method, url), `${method} ${url}`);
});

test('the log never holds a review link’s token or an upload ticket, even when their request fails', async () => {
  const { createErrorHandler, fail, loggedPath } = await import('../../server/http.ts');
  assert.equal(loggedPath('/g/Abc123secret'), '/g/…');
  assert.equal(loggedPath('/api/g/Abc123secret/unlock'), '/api/g/…/unlock');
  assert.equal(loggedPath('/media/g/Abc123secret/v2'), '/media/g/…/v2');
  assert.equal(loggedPath('/api/uploads/direct/t_secret'), '/api/uploads/direct/…');
  assert.equal(loggedPath('/api/review/x/comments'), '/api/review/x/comments');
  const lines: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    const res = { headersSent: false, setHeader() {}, status: () => ({ json() {} }) };
    const handle = createErrorHandler({ hosted: true });
    // A throttled link password (429 is logged on a hosted server) and a failure (5xx, logged with its stack).
    handle(
      Object.assign(fail(429, 'too many tries'), { retryAfter: 60 }),
      { method: 'POST', path: '/api/g/Abc123secret/unlock' } as never,
      res as never,
      () => {},
    );
    handle(new Error('boom'), { method: 'GET', path: '/media/g/Abc123secret/v1' } as never, res as never, () => {});
  } finally {
    console.error = log;
  }
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(!l.includes('Abc123secret'), l);
});

test('an invite made on the server with `vr admin invite` names who runs the server, not the OS account', () => {
  // In the container the OS account is "node" and VR_USER is "admin"; here a name of the operator's choosing.
  const r = vr(['admin', 'invite', '--role', 'member', '--json'], { ...process.env, VR_USER: 'Studio Admin' });
  assert.equal(r.code, 0, r.err);
  const { invite, url } = JSON.parse(r.out);
  assert.equal(invite.by, 'Studio Admin');
  assert.match(url, /^https:\/\/review\.test\/#\/invite\/inv_/);
});

test('nothing is for search engines: every answer says noindex, robots.txt lets them see it', async () => {
  const link = createShare({ folder: 'Acme' }, { by: 'Vera' });
  for (const url of ['/', '/?setup', '/api/auth/status', '/api/library', '/api/info', `/g/${link.token}`, '/nope']) {
    const r = await request('GET', url);
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow', `${url} (${r.status})`);
  }
  const robots = await request('GET', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(String(robots.headers['content-type']), /^text\/plain/);
  assert.match(robots.text, /^User-agent: \*\nDisallow:\n$/m, 'crawling allowed, so the noindex is seen');
});

test('forwarding headers from a peer VR_TRUST_PROXY doesn’t name are said once in the log', () => {
  const lines: string[] = [];
  const mw = untrustedProxyWarning(
    (addr) => addr === '127.0.0.1',
    'loopback',
    (m) => lines.push(m),
  );
  const call = (peer: string, headers: Record<string, string>) =>
    mw({ headers, socket: { remoteAddress: peer } } as unknown as Parameters<typeof mw>[0], {} as Parameters<typeof mw>[1], () => {});
  call('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' });
  call('172.18.0.5', {});
  assert.equal(lines.length, 0, 'the named proxy, or no forwarding headers: nothing to say');
  call('172.18.0.5', { 'x-forwarded-for': '203.0.113.9' });
  call('172.18.0.5', { forwarded: 'for=203.0.113.9' });
  assert.equal(lines.length, 1, 'once');
  assert.match(lines[0] ?? '', /from 172\.18\.0\.5, which VR_TRUST_PROXY \(loopback\) doesn't name/);
});

test('scripts/smoke.ts passes a healthy instance and names what is wrong with one that isn’t', async () => {
  const { smoke, getter } = await import('../../scripts/smoke.ts');
  const dist = tmpdir('vr-smoke-dist-');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/app-1.js"></script><link rel="icon" href="/icons/x.svg">');
  fs.writeFileSync(path.join(dist, 'assets/app-1.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'assets/app-1.js.br'), zlib.brotliCompressSync('console.log(1)'));
  // Its own address is only known once it listens: the app is attached after.
  const srv = productionTimeouts(http.createServer());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const cfg = { ...loadConfig(), public_url: base, source_url: 'https://example.org/lampo' };
  srv.on('request', createApp(createContext({ cfg, token: 'unused' }), { ui: staticUi(dist) }));
  try {
    const checks = await smoke(base, getter());
    const bad = checks.filter((c) => c.level === 'fail');
    assert.deepEqual(bad, [], JSON.stringify(bad));
    assert.ok(checks.some((c) => c.name === 'not for search engines' && c.level === 'ok'));
    assert.ok(
      checks.some((c) => c.level === 'warn' && /https address/.test(c.detail)),
      'plain http: OAuth apps can’t sign in',
    );

    // The same answers, but the page loads a font from elsewhere and the server isn't the one it says it is.
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="https://fonts.example.net/css"><script src="/assets/app-1.js"></script>',
    );
    const other = await smoke(base.replace('127.0.0.1', 'localhost'), getter({ connect: '127.0.0.1' }));
    const failed = other.filter((c) => c.level === 'fail').map((c) => `${c.name}: ${c.detail}`);
    assert.ok(
      failed.some((f) => /nothing from other hosts: the page loads from fonts\.example\.net/.test(f)),
      failed.join('\n'),
    );
    assert.ok(
      failed.some((f) => /its public URL is this one/.test(f)),
      failed.join('\n'),
    );
  } finally {
    srv.close();
  }
});
