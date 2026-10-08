// What every MCP tool says about itself, as the chat apps' directories check it: a title and all three hints as plain
// booleans (ChatGPT requires each one explicit; Claude asks before every destructive tool and lets read-only ones run),
// names of at most 64 characters. Reading tools are read-only; a write is destructive only when it overwrites or moves
// what is there. Listed the way clients see them: the stdio server on the machine (track_video) and a hosted /mcp
// (request_upload) — between them every tool there is. And what a chat client is told names no command to run: its
// tool descriptions and instructions carry no shell command, other app or "not in your chat".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as StdioClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedEnv, ROOT } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_REMOTE: '0' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const { TOOL_ACCESS, OVERWRITES } = await import('../../mcp/core.ts');

interface Listed {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
}

let server: http.Server;
let port = 0;
let bearer: Record<string, string> = {};
const clients: { close(): Promise<void> }[] = [];

before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  const owner = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` };
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A hosted /mcp as a client of this name sees it: its tools and the server's instructions. */
async function hosted(name: string): Promise<{ tools: Listed[]; instructions: string }> {
  const c = new Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...bearer, Host: 'review.test' } } }));
  clients.push(c);
  return { tools: (await c.listTools()).tools as Listed[], instructions: c.getInstructions() || '' };
}

/** The stdio server on the machine, as an agent there starts it. */
async function machine(): Promise<Listed[]> {
  const c = new StdioClient({ name: 'annotations', version: '1.0.0' });
  const vars = { ...env, VR_MODE: 'local' } as Record<string, string>;
  delete vars.VR_PUBLIC_URL;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/lampo-mcp')], env: vars, stderr: 'ignore' }));
  clients.push(c);
  return (await c.listTools()).tools as Listed[];
}

test('every tool: a title, all three hints as booleans, a short name; read-only reads, destructive only what overwrites', async () => {
  const lists = { stdio: await machine(), http: (await hosted('annotations')).tools };
  const seen = new Set<string>();
  for (const [where, tools] of Object.entries(lists)) {
    assert.ok(tools.length > 20, `${where}: ${tools.length} tools`);
    for (const t of tools) {
      seen.add(t.name);
      const at = `${where} ${t.name}`;
      assert.ok(t.name.length <= 64 && /^[a-z][a-z_]*$/.test(t.name), `${at}: a short snake_case name`);
      assert.ok(typeof t.title === 'string' && t.title.trim().length > 2, `${at}: a title`);
      assert.ok(t.description?.trim(), `${at}: a description`);
      const a = t.annotations ?? {};
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'])
        assert.equal(typeof a[hint], 'boolean', `${at}: ${hint} is ${JSON.stringify(a[hint])}`);
      const reads = TOOL_ACCESS[t.name] === 'view';
      assert.equal(a.readOnlyHint, reads, `${at}: readOnlyHint follows TOOL_ACCESS (${TOOL_ACCESS[t.name]})`);
      assert.equal(a.destructiveHint, OVERWRITES.has(t.name), `${at}: destructive only when it overwrites`);
      assert.ok(!(a.readOnlyHint && a.destructiveHint), `${at}: a read is never destructive`);
      assert.equal(a.openWorldHint, false, `${at}: nothing beyond the workspace`);
    }
  }
  // between the machine and a hosted server, every tool there is was looked at (track_video, request_upload, the card's)
  assert.deepEqual([...seen].sort(), Object.keys(TOOL_ACCESS).sort());
  assert.deepEqual([...OVERWRITES].sort(), ['draft_post', 'move_video', 'set_render_source']);
});

test('a chat client is told no command to run, no other app, and nothing about its own chat; a coding agent keeps its commands', async () => {
  const chat = await hosted('Claude');
  const text = (l: { tools: Listed[]; instructions: string }) => [l.instructions, ...l.tools.map((t) => `${t.name}: ${t.description}`)].join('\n');
  const said = text(chat);
  for (const banned of [/\bcurl\b/, /After Effects/, /Premiere/, /Claude Code/, /\blampo (render|watch|push|playbook)\b/, /never in your chat/, /follow it/])
    assert.doesNotMatch(said, banned, `a chat client reads ${banned}`);
  assert.match(chat.instructions, /request_upload: one PUT/, 'its way up is MCP only');
  const upload = chat.tools.find((t) => t.name === 'request_upload');
  assert.match(upload?.description || '', /one PUT of the file/);
  // a coding agent with a shell is still shown the command (the formats it reads are unchanged)
  const coding = await hosted('claude-code');
  assert.match(coding.tools.find((t) => t.name === 'request_upload')?.description || '', /curl -fT render\.mp4/);
  assert.match(coding.instructions, /lampo render --to/);
  // the playbook's own lines name the tool alone for a chat client, the command beside it for a coding agent
  const pb = await import('../../lib/playbooks.ts');
  pb.writeText('', 'rules', '- End on the logo', { by: 'Olivia' });
  pb.putSkill('', { name: 'grade', description: 'The house grade', body: 'Use the LUT.' }, { by: 'Olivia' });
  const read = async (name: string) => {
    const c = new Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...bearer, Host: 'review.test' } } }),
    );
    clients.push(c);
    const r = (await c.callTool({ name: 'get_playbook', arguments: {} })) as { content: { text?: string }[] };
    return r.content.map((x) => x.text || '').join('\n');
  };
  const forChat = await read('ChatGPT');
  assert.match(forChat, /propose_playbook_change/);
  assert.match(forChat, /get_skill/);
  assert.doesNotMatch(forChat, /`lampo /, forChat);
  assert.match(await read('codex-mcp-client'), /`lampo playbook propose`/, 'a coding agent keeps the command');
  // what footage search says when it is off keeps its meaning without the command
  const { withoutCommands } = await import('../../mcp/tools/footage.ts');
  assert.equal(
    withoutCommands('footage search is off for this workspace: an owner or admin turns it on (lampo footage on)'),
    'footage search is off for this workspace: an owner or admin turns it on',
  );
  assert.equal(withoutCommands('footage search is off for this workspace (lampo footage on turns it on)'), 'footage search is off for this workspace');
  assert.doesNotMatch(withoutCommands('its setting (footage.json) can’t be read — lampo footage on or off writes it again'), /lampo/);
});
