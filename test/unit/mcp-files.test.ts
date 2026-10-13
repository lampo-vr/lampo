// covers: mcp/tools/files.ts mcp/access.ts lib/fileLines.ts lib/backend/localFiles.ts
// The project files' MCP tools over stdio, as the machine's own agent has them (bin/lampo-mcp on the store here):
// list_files reads what applies where (a summary, a folder's files with their ids); get_file hands out a copy of a file
// of its own on this machine — never the store's bytes to change; add_file saves a file of this machine as a new file or
// the next version (base), and refuses one that would replace a version it didn't name, with who made it and the two
// ways on. Reading the files changes nothing (read-only hints); adding adds a version (never destructive).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { isolatedEnv, ROOT, tmpdir, vr } from '../lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const { TOOL_ACCESS, hintsFor, backendFor, NO_FILES } = await import('../../mcp/access.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
folders.createFolder('Acme/Spring');
const src = tmpdir('vr-mcp-files-src-');
fs.mkdirSync(path.join(src, 'Music'));
fs.writeFileSync(path.join(src, 'Music', 'bed.wav'), 'music bed');
fs.writeFileSync(path.join(src, 'logo.svg'), '<svg/>');
assert.equal(vr(['files', 'push', `${src}/`, '--to', 'Acme/Spring'], env).code, 0);

const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});
async function connect(): Promise<Client> {
  const c = new Client({ name: 'files-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'bin/vr-mcp')],
      env: { ...env, VR_BY: 'agent:sound-edit' } as Record<string, string>,
    }),
  );
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

test('the three tools: offered, reading ones read-only, adding never destructive, each with its files action', async () => {
  const c = await connect();
  const tools = (await c.listTools()).tools;
  for (const name of ['list_files', 'get_file', 'add_file'])
    assert.ok(
      tools.some((t) => t.name === name),
      name,
    );
  assert.deepEqual([TOOL_ACCESS.list_files, TOOL_ACCESS.get_file, TOOL_ACCESS.add_file], ['files', 'files', 'files-write']);
  assert.equal(hintsFor('list_files').readOnlyHint, true);
  assert.equal(hintsFor('get_file').readOnlyHint, true);
  assert.deepEqual(hintsFor('add_file'), { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  const add = tools.find((t) => t.name === 'add_file');
  assert.ok(add && 'file' in (add.inputSchema.properties ?? {}), 'on this machine add_file takes a file here');
  assert.ok(!('size' in (add.inputSchema.properties ?? {})));
});

test('list_files: the summary, then a folder’s files with their ids', async () => {
  const c = await connect();
  const s = textOf(await call(c, 'list_files', { folder: 'Acme/Spring' }));
  assert.match(
    s,
    /^files for Acme\/Spring · Acme\/Spring r1 \(deepest wins\)\nAcme\/Spring {2}Music\/ {2}1 file {2}9 B {2}audio\nAcme\/Spring {2}logo\.svg {2}6 B {2}graphic\n/,
  );
  assert.match(s, /lampo files pull --to='<dir>' --only='<glob>' -- Acme\/Spring$/m, 'a shell agent is told how to fetch many');
  const dir = textOf(await call(c, 'list_files', { folder: 'Acme/Spring', path: 'Music' }));
  assert.match(dir, /^Acme\/Spring Music\/ · 1 file\nfl_[0-9a-f]{12} Music\/bed\.wav 9 B audio V1 by agent:vr \(tester\) · \S+$/);
  assert.match(textOf(await call(c, 'list_files', { folder: 'Acme/Spring', query: 'logo' })), /logo\.svg/);
  assert.match(textOf(await call(c, 'list_files', { folder: 'House' })), /^no files for House yet: add_file, or lampo files push --to=House -- '<folder>'$/);
  const missing = await call(c, 'list_files', { folder: 'Nowhere' });
  assert.ok(missing.isError);
  assert.match(textOf(missing), /there is no folder "Nowhere"/);
});

test('get_file: a copy of its own on this machine, by id or by path; changing it changes nothing in Lampo', async () => {
  const c = await connect();
  const id = /fl_[0-9a-f]{12}/.exec(textOf(await call(c, 'list_files', { folder: 'Acme/Spring', path: 'Music' })))?.[0] as string;
  const got = textOf(await call(c, 'get_file', { id }));
  const copy = /a copy on this machine: (.+)$/m.exec(got)?.[1] as string;
  assert.ok(copy, got);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'music bed');
  assert.equal(path.basename(copy), 'bed.wav');
  const store = path.join(env.VR_DATA as string, 'files');
  assert.ok(!copy.startsWith(store), 'never the store’s own bytes');
  fs.writeFileSync(copy, 'changed by the agent');
  const again = /a copy on this machine: (.+)$/m.exec(textOf(await call(c, 'get_file', { path: 'Music/bed.wav', folder: 'Acme/Spring' })))?.[1] as string;
  assert.equal(fs.readFileSync(again, 'utf8'), 'music bed', 'Lampo’s bytes as they are, whatever was done to a copy');
  const none = await call(c, 'get_file', { path: 'Music/nothing.wav', folder: 'Acme/Spring' });
  assert.ok(none.isError);
  assert.match(textOf(none), /no file Music\/nothing\.wav in Acme\/Spring: list_files shows what is there/);
});

test('add_file: a file of this machine as a new file, the next version with base; one in the way is refused with who', async () => {
  const c = await connect();
  const take = path.join(tmpdir('vr-mcp-files-take-'), 'take.wav');
  fs.writeFileSync(take, 'voice take 1');
  const added = textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Voice/take.wav', file: take }));
  assert.match(added, /^added: fl_[0-9a-f]{12} Voice\/take\.wav V1 in Acme\/Spring$/);
  const entry = files.listFiles('Acme/Spring', { deep: true, own: true }).files.find((f) => f.path === 'Voice/take.wav');
  assert.deepEqual([entry?.agent, entry?.via], ['sound-edit', 'mcp'], 'the agent’s, by its MCP tool');
  fs.writeFileSync(take, 'voice take 2');
  const refused = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Voice/take.wav', file: take });
  assert.ok(refused.isError);
  assert.match(
    textOf(refused),
    /Voice\/take\.wav is V1 by agent:sound-edit \(tester\) \(\S+\): add_file with base \(the version there now\) makes yours its next version, or copy: true keeps both/,
  );
  assert.match(
    textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Voice/take.wav', file: take, base: 1 })),
    /^new version: fl_\S+ Voice\/take\.wav V2 in Acme\/Spring$/,
  );
  fs.writeFileSync(take, 'voice take 3');
  assert.match(
    textOf(await call(c, 'add_file', { folder: 'Acme/Spring', path: 'Voice/take.wav', file: take, copy: true })),
    /yours is kept beside it as Voice\/take \(sound-edit\)\.wav V1/,
  );
  const gone = await call(c, 'add_file', { folder: 'Acme/Spring', path: 'x.wav', file: path.join(path.dirname(take), 'nothing.wav') });
  assert.ok(gone.isError);
});

test('anyone but the machine never reaches the store’s bytes as paths, nor makes it read a file of its disk', async () => {
  const fenced = backendFor({ via: 'token', name: 'Max', role: 'member' }, createLocalBackend());
  const id = files.listFiles('Acme/Spring', { deep: true, own: true }).files[0]?.id as string;
  await assert.rejects(fenced.fileSources([id]), (e: Error) => e.message === NO_FILES);
  await assert.rejects(
    fenced.pushFiles('Acme/Spring', [{ file: '/etc/hosts', path: 'hosts', size: 1, sha256: 'a'.repeat(64), base: null }], { conflict: 'refuse', by: 'Max' }),
    (e: Error) => e.message === NO_FILES,
  );
  // what it may read: the listing, which names no path on this disk
  assert.ok(!JSON.stringify(await fenced.listFiles('Acme/Spring', { deep: true })).includes(env.VR_DATA as string));
});
