// What an object store says when it refuses (S3 or Bunny answering 403: the storage key with the project's and the
// client's folder names, the bucket's name, its error XML) is the server's business: on a hosted server a review-link
// visitor, an agent with a token (HTTP and MCP) and a person in the browser get a sentence with a ref, and a 500 — the
// store's 403 is this server's fault, not theirs (audit A12 verification: VC-3). The machine's owner at the machine
// reads such an error as it is (the unit test at the end: the audience rule itself).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';
import { mockS3 } from '../lib/mockStores.ts';

// The bucket, behind a stand-in that refuses reads or writes when told to, as a store with a revoked key would.
const s3 = await mockS3();
const refuse = { get: false, put: false, complete: false };
const BUCKET_SAYS =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message><BucketName>northwind-prod-renders</BucketName></Error>';
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    if ((refuse.get && req.method === 'GET') || (refuse.put && (req.method === 'PUT' || req.method === 'POST'))) {
      res.writeHead(403).end(BUCKET_SAYS);
      return;
    }
    // S3's documented late failure: completing a multipart upload answers 200 with an error document
    if (refuse.complete && req.method === 'POST' && /[?&]uploadId=/.test(req.url || '')) {
      res.writeHead(200).end(BUCKET_SAYS.replace('AccessDenied', 'InternalError'));
      return;
    }
    const u = new URL(s3.url);
    const p = http.request({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode || 500, r.headers);
      r.pipe(res);
    });
    p.end(Buffer.concat(chunks));
  });
});
await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_STT: 'off',
    VR_STORAGE: 's3',
    VR_S3_ENDPOINT: `http://127.0.0.1:${(front.address() as AddressInfo).port}`,
    VR_S3_BUCKET: 'bucket',
    VR_S3_ACCESS_KEY_ID: 'AKTEST',
    VR_S3_SECRET_ACCESS_KEY: 'shh',
    VR_S3_REGION: 'auto',
  },
});
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const { CACHE } = await import('../../lib/paths.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;
let server: http.Server;
let port = 0;
let request: Request;
let olivia: Record<string, string> = {};
let agent: Record<string, string> = {};
let slug = '';
let link = '';
const logged: unknown[][] = [];
const consoleError = console.error;

before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: PASSWORD }, headers: origin });
  olivia = { Cookie: String([login.headers['set-cookie']].flat()[0]).split(';')[0], ...origin };
  agent = { Authorization: `Bearer ${(await request('POST', '/api/auth/tokens', { body: { name: 'agent' }, headers: olivia })).json().token}` };
  const clip = makeVideo(path.join(dir, 'up', 'intro.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'intro.mp4', folder: 'Northwind/Spring' }, agent);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  link = (await request('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Client' }, headers: olivia })).json().token;
  console.error = (...a: unknown[]) => logged.push(a);
});
after(async () => {
  console.error = consoleError;
  server.closeAllConnections();
  server.close();
  front.close();
  await s3.close();
});

// What only the operator may read: the key (with the folders), the bucket, the store's own words.
const SECRETS = ['Northwind', 'Spring', 'versions/', 'northwind-prod-renders', 'AccessDenied', '<Error>', 'HTTP 403', 'S3 '];
function plain(what: string, text: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what} names ${JSON.stringify(s)}: ${text.slice(0, 300)}`);
  const ref = /\(ref ([0-9a-f]{8})\)/.exec(text)?.[1];
  assert.ok(ref, `${what}: a sentence with a ref to the log line: ${text.slice(0, 300)}`);
  assert.ok(
    logged.some((line) => line.join(' ').includes(ref) && line.join(' ').includes('northwind-prod-renders')),
    `${what}: the whole error is in the log under its ref`,
  );
}

test('a bucket that refuses reads: a visitor, a token, an agent over MCP and a browser get a 500 sentence', async () => {
  // The working copies on this disk go (a cache pruned, a new container), and the bucket refuses reads from now on.
  const walk = (d: string): string[] =>
    fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [];
  for (const f of walk(CACHE).filter((f) => f.endsWith('.mp4'))) fs.rmSync(f);
  refuse.get = true;
  try {
    const guest = client(port, { Host: 'review.test', ...origin, 'x-forwarded-for': '203.0.113.9' });
    const room = (await guest('GET', `/api/g/${link}`)).json();
    const visitor = await guest('POST', `/api/g/${link}/comments`, { body: { name: 'Mia', slug: room.videos[0].slug, frame: 3, text: 'heller' } });
    assert.equal(visitor.status, 500, `a review-link visitor: ${visitor.text}`);
    plain('a review-link visitor', visitor.text);

    for (const [what, headers] of [
      ['an API token', agent],
      ['a person in the browser', olivia],
    ] as const) {
      const r = await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 3, text: 'z' }, headers });
      assert.equal(r.status, 500, `${what}: ${r.text}`);
      plain(what, r.text);
    }

    const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...agent, Host: 'review.test' } } }),
    );
    try {
      const r = (await c.callTool({ name: 'get_frame', arguments: { video: slug, frame: 3 } })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true);
      plain('an agent’s get_frame', r.content[0]?.text ?? '');
    } finally {
      await c.close();
    }
  } finally {
    refuse.get = false;
  }
});

test('a bucket that refuses writes: an agent’s upload fails with a sentence, not the bucket’s answer', async () => {
  refuse.put = true;
  try {
    const clip = makeVideo(path.join(dir, 'up', 'outro.mp4'), { dur: 1 });
    age(clip);
    const up = await tusUpload(request, clip, { filename: 'outro.mp4', folder: 'Northwind/Spring' }, agent);
    assert.ok(up.status >= 400, `${up.status} ${up.text}`);
    plain('an agent’s upload', up.text);
  } finally {
    refuse.put = false;
  }
});

// Audit A12, options (OPTM-1): the file of an option an agent offers (lib/askOptions.ts makeAsk) failed with "voice/a: <the store's
// error>" — a new error without its cause, so inline asks and ask_options handed tokens the bucket's XML as a 422.
test('a bucket that refuses an option’s file: an inline ask and ask_options get a sentence and a 5xx; only the machine’s own agent reads the store', async () => {
  const tone = path.join(dir, 'tone.wav');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-y', tone]);
  const data = fs.readFileSync(tone).toString('base64');
  const ask = { folder: 'Northwind/Spring', text: 'Which voice?' };
  const items = [
    { id: 'a', ref: { kind: 'file', data } },
    { id: 'b', label: 'B' },
  ];
  const groups = [
    {
      id: 'voice',
      items: [
        { id: 'a', data },
        { id: 'b', label: 'B' },
      ],
    },
  ];
  const { createLocalBackend } = await import('../../lib/backend/local.ts');
  const { createReviewServer } = await import('../../mcp/core.ts');
  // The MCP server the machine runs for its own agent (stdio) and for a token, in this process.
  const inProcess = async (via: 'local' | 'token') => {
    const mcp = createReviewServer({ backend: createLocalBackend(), principal: { via, name: 'Olivia', id: 'u_000000000001', role: 'owner' } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    const c = new Client({ name: 'agent', version: '1' });
    await c.connect(a);
    try {
      const r = (await c.callTool({ name: 'ask_options', arguments: { ...ask, groups } })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true, `via ${via}: ${JSON.stringify(r.content)}`);
      return r.content[0]?.text ?? '';
    } finally {
      await c.close();
      await mcp.close();
    }
  };
  refuse.put = true;
  try {
    for (const [what, headers] of [
      ['an API token', agent],
      ['a person in the browser', olivia],
    ] as const) {
      const r = await request('POST', '/api/asks', { body: { ...ask, options: [{ id: 'voice', items }] }, headers });
      assert.equal(r.status, 500, `${what}: the store’s fault, not the file’s: ${r.text}`);
      plain(`${what}’s inline ask`, r.text);
    }
    const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...agent, Host: 'review.test' } } }),
    );
    try {
      const r = (await c.callTool({ name: 'ask_options', arguments: { ...ask, groups } })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true);
      plain('an agent’s ask_options over HTTP', r.content[0]?.text ?? '');
    } finally {
      await c.close();
    }
    plain('a token’s ask_options', await inProcess('token'));
    const own = await inProcess('local');
    assert.match(own, /voice\/a: .*northwind-prod-renders/, `the machine’s own agent reads which item and what the store said: ${own}`);
  } finally {
    refuse.put = false;
  }
  // Nothing half-made stays: no question on the folder.
  assert.deepEqual((await request('GET', '/api/asks', { headers: olivia })).json().asks, []);
});

test('a multipart upload the bucket fails late (a 200 with an error document): a sentence and a 5xx, not the bucket’s XML', async () => {
  const { createRemoteStorage, rootStorage, setStorage } = await import('../../lib/storage/index.ts');
  const { createS3Store } = await import('../../lib/storage/s3.ts');
  const before = rootStorage();
  // parts of 1 KB, so a small render goes up as a multipart upload
  setStorage(createRemoteStorage(createS3Store(loadConfig().storage.s3, { partSize: 1024 })));
  refuse.complete = true;
  try {
    const clip = makeVideo(path.join(dir, 'up', 'late.mp4'), { dur: 1 });
    age(clip);
    const up = await tusUpload(request, clip, { filename: 'late.mp4', folder: 'Northwind/Spring' }, agent);
    assert.ok(up.status >= 500, `the server's fault, not the file's: ${up.status} ${up.text}`);
    plain('an agent’s multipart upload', up.text);
  } finally {
    refuse.complete = false;
    setStorage(before);
  }
});

test('the rule itself: an object store’s refusal is internal, read as it is only by the owner at the machine', async () => {
  const { publicMessage, isInternal, statusOf } = await import('../../lib/publicError.ts');
  const { HttpStatusError } = await import('../../lib/storage/http.ts');
  const e = new HttpStatusError(403, `S3 download versions/__@uploads__Northwind__Spring__intro.mp4/v1.mp4: HTTP 403 ${BUCKET_SAYS}`);
  assert.ok(isInternal(e));
  assert.equal(statusOf(e), 500, 'the store’s 403 is this server’s fault');
  assert.equal(publicMessage(e, 'owner', { status: 500 }), e.message, 'the owner at the machine reads it');
  assert.match(publicMessage(e, 'other', { status: 500 }), /^something went wrong on the server \(ref [0-9a-f]{8}\)$/);
  assert.equal(statusOf(Object.assign(new Error('x'), { status: 409 })), 409, 'a status of our own stays');
  assert.equal(statusOf(Object.assign(new Error('x'), { stderr: 'moov atom not found' }), 422), 422, 'a tool’s failure keeps the route’s status');
});
