// covers: mcp/tools/files.ts server/routes/mcp.ts server/routes/files.ts
// The project files' MCP tools over HTTP on a hosted server with its media host, with an API token: list_files reads
// what applies; get_file answers a signed URL on the media host — never a path on the server, never the bytes — that
// asks again who it was handed to; add_file answers a one-time URL whose one PUT commits the file as the agent's
// version (bytes the workspace holds already: committed at once, nothing to send), and a file in the way is refused
// before any byte moves, with who made it. A reviewer's token reaches none of it; an OAuth app is asked for the files'
// scopes by name.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const MEDIA = 'media.review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test', VR_MEDIA_ORIGIN: `http://${MEDIA}`, VR_FOOTAGE: 'off' } });
const auth = await import('../../lib/auth.ts');
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { MCP_SCOPES } = await import('../../mcp/access.ts');

const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});
const { port, base } = await startApp();
const PASSWORD = 'a long password';
const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
inWorkspace('w1', () => folders.createFolder('Acme/Spring'));
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const own = () => inWorkspace('w1', () => files.listFiles('Acme/Spring', { deep: true, own: true }).files);

async function connect(user: { id: string }): Promise<Client> {
  const token = auth.createToken(user.id, 'mcp files').token;
  const c = new Client({ name: 'claude-code', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Result;
/** A request to the app as the host a URL names (the media host is this same app). */
function raw(method: string, url: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: u.pathname + u.search,
        headers: { Host: u.host, ...(body ? { 'content-length': String(body.length) } : {}) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('add_file: a one-time URL on the media host whose PUT commits the agent’s file; held bytes commit at once', async () => {
  const c = await connect(max);
  const tools = (await c.listTools()).tools;
  const add = tools.find((t) => t.name === 'add_file');
  assert.ok(add && 'size' in (add.inputSchema.properties ?? {}) && !('file' in (add.inputSchema.properties ?? {})), 'no path on the server is ever named');
  const bytes = crypto.randomBytes(5000);
  const r = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Music/bed.wav', size: bytes.length });
  assert.ok(!r.isError, textOf(r));
  const url = /^(http:\/\/media\.review\.test\/api\/uploads\/direct\/\S+)$/m.exec(textOf(r))?.[1] as string;
  assert.ok(url, textOf(r));
  assert.match(textOf(r), /^curl -fT 'bed\.wav' '/m);
  const put = await raw('PUT', url, bytes);
  assert.equal(put.status, 200, put.body.toString());
  const answer = JSON.parse(put.body.toString()) as { commit: { files: { path: string; state: string; v: number }[] } };
  assert.deepEqual(
    answer.commit.files.map((f) => [f.path, f.state, f.v]),
    [['Music/bed.wav', 'added', 1]],
  );
  const f = own().find((x) => x.path === 'Music/bed.wav');
  assert.deepEqual([f?.by, f?.agent, f?.via], ['Max', 'claude-code', 'mcp'], 'the account’s, its agent’s, by MCP');
  // the same bytes again elsewhere: nothing to send, committed at once
  const held = textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Music/bed copy.wav', size: bytes.length, sha256: sha(bytes) }));
  assert.match(held, /^added: fl_[0-9a-f]{12} Music\/bed copy\.wav V1 in Acme\/Spring$/);
  // in the way: refused before any byte moves, with who
  const taken = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Music/bed.wav', size: 10 });
  assert.ok(taken.isError);
  assert.match(textOf(taken), /Music\/bed\.wav is V1 by agent:claude-code \(Max\) .*add_file with base/);
  // with base: its next version
  assert.match(textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Music/bed.wav', size: 10, base: 1 })), /^PUT the file's 10 bytes/);
});

test('list_files and get_file: a signed URL on the media host, never a path on the server, that the file comes from', async () => {
  const c = await connect(max);
  const s = textOf(await call(c, 'list_files', { folder: 'Acme/Spring' }));
  assert.match(s, /^files for Acme\/Spring · Acme\/Spring r\d+ \(deepest wins\)\nAcme\/Spring {2}Music\/ {2}2 files/);
  const id = /^(fl_[0-9a-f]{12}) Music\/bed\.wav /m.exec(textOf(await call(c, 'list_files', { folder: 'Acme/Spring', path: 'Music' })))?.[1] as string;
  assert.ok(id);
  const got = textOf(await call(c, 'get_file', { id }));
  assert.ok(!got.includes(dir), 'no path on the server');
  const url = /^(http:\/\/media\.review\.test\/media\/f\/\S+)$/m.exec(got)?.[1] as string;
  assert.ok(url, got);
  assert.match(got, /^curl -fLo 'bed\.wav' '/m);
  const res = await raw('GET', url);
  assert.equal(res.status, 200);
  assert.equal(sha(res.body), own().find((x) => x.path === 'Music/bed.wav')?.sha256);
  // by its path, and an older version
  assert.match(textOf(await call(c, 'get_file', { path: 'Music/bed.wav', folder: 'Acme/Spring', v: 1 })), /Music\/bed\.wav V1/);
});

test('a reviewer’s token reaches no files; an app is asked for the files’ scopes by name', async () => {
  const c = await connect(rita);
  for (const [name, args] of [
    ['list_files', { folder: 'Acme/Spring' }],
    ['get_file', { path: 'Music/bed.wav', folder: 'Acme/Spring' }],
    ['add_file', { folder: 'Acme/Spring', path: 'x.wav', size: 1 }],
  ] as const) {
    const r = await call(c, name, args);
    assert.ok(r.isError, name);
    assert.match(textOf(r), /your role \(reviewer\) may not/);
  }
  assert.ok(MCP_SCOPES.includes('files:read') && MCP_SCOPES.includes('files:write'));
});
