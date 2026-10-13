// covers: mcp/tools/files.ts server/routes/mcp.ts server/routes/files.ts
// The project files' MCP tools over HTTP on a hosted server with its media host, with an API token: list_files reads
// what applies; get_file answers a signed URL on the media host — never a path on the server, never the bytes — that
// asks again who it was handed to; add_file answers a one-time URL whose one PUT commits the file as the agent's
// version (bytes the workspace holds already: committed at once, nothing to send), and a file in the way is refused
// before any byte moves, with who made it. A reviewer's token reaches none of it, a member made a reviewer can't use a
// URL asked for before, an OAuth app is asked for the files' scopes by name and an app allowed in before them gets none
// of it. A suspended workspace reads its files as over the API, and writes nothing. The lines to run take any name.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const MEDIA = 'media.review.test';
const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_MEDIA_ORIGIN: `http://${MEDIA}`, VR_FOOTAGE: 'off' } });
const auth = await import('../../lib/auth.ts');
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const workspaces = await import('../../lib/workspaces.ts');
const oauth = await import('../../lib/oauth/store.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { MCP_SCOPES } = await import('../../mcp/access.ts');
const { SUSPENDED_ERROR } = await import('../../server/permissions.ts');

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

async function connect(user: { id: string }, workspace?: string): Promise<Client> {
  const token = auth.createToken(user.id, 'mcp files', workspace ? { workspace } : {}).token;
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
  assert.match(textOf(r), /^curl -fT bed\.wav http:\/\/media\.review\.test\/api\/uploads\/direct\//m);
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
  assert.match(got, /^curl -fLo bed\.wav http:\/\/media\.review\.test\/media\/f\//m);
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

/** An app allowed into w1 through OAuth with `scopes` (as the consent screen grants them): its access token. */
function grant(user: { id: string }, scopes: string[]): string {
  const client_id = `cid-${crypto.randomBytes(4).toString('hex')}`;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id, kind: 'dcr', name: 'Some App', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: scopes as never,
    resource: `${PUBLIC}/mcp`,
  });
  return oauth.redeemCode({
    code: oauth.createCode(asked, auth.getUser(user.id) as never, 'w1'),
    client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  }).access_token;
}
/** One tools/call to /mcp as `bearer`, stateless, with `headers` on top (what a client says the call is). */
async function rawCall(bearer: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const www = r.headers.get('www-authenticate') ?? '';
  if (r.status !== 200) return { status: r.status, www, isError: true, text };
  const msg = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { result?: Result };
  return { status: 200, www, isError: !!msg.result?.isError, text: msg.result ? textOf(msg.result) : text };
}

test('an app allowed in before the files’ scopes reaches none of the files, whatever its client says the call is', async () => {
  // the default ask before the project files were asked for by name
  const old = grant(max, ['review:read', 'review:comment', 'review:act', 'post:draft']);
  for (const [name, args] of [
    ['list_files', { folder: 'Acme/Spring' }],
    ['get_file', { path: 'Music/bed.wav', folder: 'Acme/Spring' }],
    ['add_file', { folder: 'Acme/Spring', path: 'old-app.wav', size: 4 }],
  ] as const) {
    const r = await rawCall(old, name, args);
    assert.equal(r.status, 403, `${name}: ${r.text}`);
    assert.match(r.www, /error="insufficient_scope", scope="files:(read|write)"/, name);
    // told it is another tool: refused by the tool itself
    const spoofed = await rawCall(old, name, args, { 'mcp-method': 'tools/call', 'mcp-name': 'list_videos' });
    assert.ok(spoofed.isError, `${name} as list_videos: ${spoofed.text}`);
    assert.match(spoofed.text, /may not/, name);
    assert.doesNotMatch(spoofed.text, /bed\.wav|PUT the file/, name);
  }
  assert.match((await rawCall(old, 'list_files', { folder: 'Acme/Spring' })).www, /scope="files:read"/);
  // reading only: no adding
  const reader = grant(max, ['review:read', 'files:read']);
  assert.match((await rawCall(reader, 'list_files', { folder: 'Acme/Spring' })).text, /files for Acme\/Spring/, 'files:read reads');
  const add = await rawCall(reader, 'add_file', { folder: 'Acme/Spring', path: 'reader.wav', size: 4 });
  assert.equal(add.status, 403, add.text);
  assert.match(add.www, /error="insufficient_scope", scope="files:write"/);
  const spoofed = await rawCall(
    reader,
    'add_file',
    { folder: 'Acme/Spring', path: 'reader.wav', size: 4 },
    { 'mcp-method': 'tools/call', 'mcp-name': 'list_files' },
  );
  assert.ok(spoofed.isError && /may not add file/.test(spoofed.text), spoofed.text);
  assert.ok(!own().some((f) => f.path === 'old-app.wav' || f.path === 'reader.wav'));
});

test('a member made a reviewer after asking can’t use the upload URL: refused at the PUT, nothing kept', async () => {
  const c = await connect(max);
  const bytes = crypto.randomBytes(300);
  const r = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'demoted.wav', size: bytes.length });
  const url = /^(http:\/\/media\.review\.test\/api\/uploads\/direct\/\S+)$/m.exec(textOf(r))?.[1] as string;
  assert.ok(url, textOf(r));
  // the same through the API's push
  const token = auth.createToken(max.id, 'push').token;
  const asked = await fetch(`${base}/api/files/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ folder: 'Acme/Spring', files: [{ path: 'demoted-api.wav', size: bytes.length }] }),
  });
  assert.equal(asked.status, 200);
  const apiUrl = ((await asked.json()) as { uploads: { url: string }[] }).uploads[0]?.url as string;
  await workspaces.setMemberRole('w1', max.id, 'reviewer');
  try {
    for (const u of [url, apiUrl]) {
      const put = await raw('PUT', u, bytes);
      assert.equal(put.status, 403, put.body.toString());
      assert.match(put.body.toString(), /may no longer upload here/);
    }
    assert.ok(!own().some((f) => f.path.startsWith('demoted')), 'nothing was kept');
  } finally {
    await workspaces.setMemberRole('w1', max.id, 'member');
  }
});

test('a suspended workspace: its files read over MCP as over the API, and nothing is added', async () => {
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'member' });
  const B = workspaces.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  inWorkspace(B, () => folders.createFolder('Spot'));
  const c = await connect(bob, B);
  const bytes = crypto.randomBytes(200);
  const asked = textOf(await call(c, 'add_file', { folder: 'Spot', path: 'mix.wav', size: bytes.length }));
  const put = await raw('PUT', /^(http:\S+)$/m.exec(asked)?.[1] as string, bytes);
  assert.equal(put.status, 200, put.body.toString());
  workspaces.suspendWorkspace(B, { by: 'operator', reason: 'a check' });
  try {
    const token = auth.createToken(bob.id, 'reads', { workspace: B }).token;
    assert.equal((await fetch(`${base}/api/files?folder=Spot`, { headers: { authorization: `Bearer ${token}` } })).status, 200, 'the API reads on');
    const s = await connect(bob, B);
    const listed = await call(s, 'list_files', { folder: 'Spot', query: 'mix' });
    assert.ok(!listed.isError, textOf(listed));
    assert.match(textOf(listed), /^fl_[0-9a-f]{12} mix\.wav /m);
    const got = await call(s, 'get_file', { path: 'mix.wav', folder: 'Spot' });
    assert.ok(!got.isError, textOf(got));
    const url = /^(http:\/\/media\.review\.test\/media\/f\/\S+)$/m.exec(textOf(got))?.[1] as string;
    assert.equal(sha((await raw('GET', url)).body), sha(bytes), 'and downloads');
    const add = await call(s, 'add_file', { folder: 'Spot', path: 'more.wav', size: 4 });
    assert.ok(add.isError);
    assert.equal(textOf(add), `Error: ${SUSPENDED_ERROR}`);
  } finally {
    workspaces.suspendWorkspace(B, null);
  }
});

test('an empty file goes up and comes back as one: its URL takes the PUT of no bytes', async () => {
  const c = await connect(max);
  const r = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Notes/empty.txt', size: 0 });
  assert.ok(!r.isError, textOf(r));
  const url = /^(http:\/\/media\.review\.test\/api\/uploads\/direct\/\S+)$/m.exec(textOf(r))?.[1] as string;
  assert.ok(url, textOf(r));
  // no bytes for a URL asked for some are still no upload (and that URL stays good for its bytes)
  const four = textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Notes/four.txt', size: 4 }));
  const fourUrl = /^(http:\/\/media\.review\.test\/api\/uploads\/direct\/\S+)$/m.exec(four)?.[1] as string;
  assert.equal((await raw('PUT', fourUrl, Buffer.alloc(0))).status, 411);
  assert.equal((await raw('PUT', fourUrl, Buffer.from('four'))).status, 200);
  const put = await raw('PUT', url, Buffer.alloc(0));
  assert.equal(put.status, 200, put.body.toString());
  const f = own().find((x) => x.path === 'Notes/empty.txt');
  assert.deepEqual([f?.size, f?.v], [0, 1]);
  const got = textOf(await call(c, 'get_file', { path: 'Notes/empty.txt', folder: 'Acme/Spring' }));
  const res = await raw('GET', /^(http:\/\/media\.review\.test\/media\/f\/\S+)$/m.exec(got)?.[1] as string);
  assert.deepEqual([res.status, res.body.length], [200, 0]);
});

/** The words a shell makes of a line: `curl` there is a function that prints each one, NUL-separated. */
const curlWords = (line: string) =>
  execFileSync('/bin/sh', ['-c', `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n${line}`], { encoding: 'utf8' })
    .split('\0')
    .slice(0, -1);

test('the lines an agent is told to run take any name: an apostrophe stays in its word, a name like an option is refused', async () => {
  const c = await connect(max);
  const name = `Director's (final) cut!*.txt`;
  const bytes = Buffer.from('a cut\n');
  const r = await call(c, 'add_file', { folder: 'Acme/Spring', path: `Docs/${name}`, size: bytes.length });
  const [, putName, putUrl] = curlWords(/^curl -fT .*$/m.exec(textOf(r))?.[0] as string);
  assert.equal(putName, name);
  assert.equal((await raw('PUT', putUrl as string, bytes)).status, 200);
  const got = textOf(await call(c, 'get_file', { path: `Docs/${name}`, folder: 'Acme/Spring' }));
  const line = /^curl -fLo .*$/m.exec(got)?.[0] as string;
  const [flags, outName, url] = curlWords(line);
  assert.deepEqual([flags, outName], ['-fLo', name], line);
  assert.equal(url, /^(http:\/\/media\.review\.test\/media\/f\/\S+)$/m.exec(got)?.[1], 'the URL whole, one word');
  assert.match(url as string, /\/Director%27s%20%28final%29%20cut%21%2A\.txt$/);
  assert.equal(sha((await raw('GET', url as string)).body), sha(bytes));
  // a new name that starts with "-": refused before any byte moves, with why
  const dash = await call(c, 'add_file', { folder: 'Acme/Spring', path: '--to=elsewhere.wav', size: 4 });
  assert.ok(dash.isError);
  assert.match(textOf(dash), /--to=elsewhere\.wav: a new name can’t start with "-"/);
});
