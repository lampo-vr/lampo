// MCP tools write what the HTTP API writes, so they take the same caps and the same plan gate (A12 AGENT-6): a note,
// reply, fix note, reason, tag, status, render source, caption or playbook suggestion too long for the API is refused
// over /mcp too — before, a reviewer's token could put a 1 MB note into review.json and every agent's next read — and
// a team file sent inline (a reference, a fix preview), or an upload URL for one, asks the plan's upload gate as
// `POST /api/comments/:id/refs|previews` do: a read-only workspace refuses it with the plan's sentence. The schemas are
// shared (lib/inputs.ts); the tool list doesn't announce the caps.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const ext = await import('../../server/extension.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

// A plan module that makes a workspace read-only on demand (the stand-in of server/extension.ts's tests).
const MODULE = path.join(dir, 'plan-module.ts');
fs.writeFileSync(
  MODULE,
  `const locked = new Set();
export default async () => ({
  name: 'stand-in',
  locked,
  entitlements: {
    get: async () => null,
    canUpload: async (w) => locked.has(w) ? { ok: false, reason: 'read-only', message: 'This workspace is read-only until its invoice is paid.' } : { ok: true },
    canAddMember: async () => ({ ok: true }),
    canAddVideo: async () => ({ ok: true }),
    canShare: async () => ({ ok: true }),
  },
  routes: [],
  workspaces: {},
});
`,
);
const lockOf = async (): Promise<Set<string>> => (await ((await import(MODULE)) as { default: () => Promise<{ locked: Set<string> }> }).default()).locked;

const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 1 });
age(video);
const slug = slugify(store.createOrGetReview(video, { by: 'setup' }).review.video);
const s = encodeURIComponent(slug);
const png = path.join(dir, 'look.png');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', png]);
const pngData = fs.readFileSync(png).toString('base64');

let server: http.Server;
let request: Request;
let bearer: Record<string, string>;
let mcp: Client;
let noteId = '';
before(async () => {
  const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
  ctx.extension = await ext.loadExtension(ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) }), {
    ...process.env,
    VR_CLOUD_MODULE: MODULE,
  });
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  const owner = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` };
  noteId = store.addComment(slug, { frame: 3, text: 'Logo später', author: 'Olivia', author_id: owner.id }).id;
  mcp = new Client({ name: 'limits', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...bearer, Host: 'review.test' } } }),
  );
});
after(async () => {
  await mcp?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
});

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
/** A tool call's outcome: refused (an invalid-arguments error or an error result) with its text, or done. */
async function call(name: string, args: Record<string, unknown>): Promise<{ refused: boolean; text: string }> {
  try {
    const r = (await mcp.callTool({ name, arguments: args })) as Result;
    const text = r.content.map((c) => c.text || '').join('\n');
    return { refused: !!r.isError, text };
  } catch (e) {
    return { refused: true, text: (e as Error).message };
  }
}
const long = (n: number) => 'x'.repeat(n);
const notes = () => store.loadReview(slug)?.comments ?? [];
const stored = (text: string) => JSON.stringify(store.loadReview(slug)).includes(text);

test('too long for the HTTP API is too long over MCP: notes, replies, fix notes, reasons, tags, status, source, captions, suggestions', async () => {
  const note = long(30_000);
  const cases: [string, Record<string, unknown>][] = [
    ['add_note', { video: slug, frame: 2, text: note }],
    ['add_note', { video: slug, frame: 2, text: 'tagged', tags: [long(100)] }],
    ['reply', { id: noteId, note }],
    ['mark_fixed', { id: noteId, note }],
    ['wont_fix', { id: noteId, reason: note }],
    ['set_status', { video: slug, text: long(300) }],
    ['set_render_source', { video: slug, app: long(300) }],
    ['attach_reference', { id: noteId, url: 'https://example.com/look', caption: long(400) }],
    ['attach_reference', { id: noteId, url: `https://example.com/${long(2500)}` }],
    ['attach_preview', { id: noteId, data: pngData, note }],
    ['propose_playbook_change', { section: 'rules', content: '- Always end on the logo', reason: long(2000) }],
  ];
  for (const [name, args] of cases) {
    const r = await call(name, args);
    assert.ok(r.refused, `${name} ${JSON.stringify(args).slice(0, 80)}… was taken: ${r.text.slice(0, 200)}`);
  }
  assert.equal(stored(note), false, 'nothing that long reached review.json');
  assert.equal(stored(long(100)), false);
  // the HTTP API refuses the same
  const http = [
    await request('POST', `/api/review/${s}/comments`, { body: { frame: 2, text: note }, headers: bearer }),
    await request('POST', `/api/review/${s}/comments`, { body: { frame: 2, text: 'tagged', tags: [long(100)] }, headers: bearer }),
    await request('PATCH', `/api/comments/${noteId}`, { body: { note }, headers: bearer }),
    await request('PUT', `/api/review/${s}/agent-status`, { body: { text: long(300) }, headers: bearer }),
    await request('PUT', `/api/review/${s}/versions/1/source`, { body: { app: long(300) }, headers: bearer }),
  ];
  assert.deepEqual(
    http.map((r) => r.status),
    [400, 400, 400, 400, 400],
  );
  // within the caps, the same calls work
  const ok = await call('add_note', { video: slug, frame: 2, text: long(5000), tags: ['timing'] });
  assert.equal(ok.refused, false, ok.text);
  assert.equal((await call('set_status', { video: slug, text: 'rendering v2' })).refused, false);
  assert.ok(notes().some((c) => c.text === long(5000)));
});

test('the caps are checked, not announced: the tool list carries no 20,000-character bounds', async () => {
  const { tools } = await mcp.listTools();
  const listed = JSON.stringify(tools);
  assert.doesNotMatch(listed, /"maxLength":(20000|300|2000|200|255|400|600)\b/);
  assert.doesNotMatch(listed, /"quiet"/);
  // what a model needs to see stays: a question's choices are 2 to 4 short answers
  const addNote = tools.find((t) => t.name === 'add_note');
  assert.match(JSON.stringify(addNote?.inputSchema), /"minItems":2,"maxItems":4/);
});

test('a read-only workspace: a reference or fix preview sent over MCP, or an upload URL for one, gets the plan’s sentence', async () => {
  const locked = await lockOf();
  locked.add('w1');
  try {
    const before = JSON.stringify(notes().find((c) => c.id === noteId));
    const cases: [string, Record<string, unknown>][] = [
      ['attach_reference', { id: noteId, data: pngData, caption: 'like this' }],
      ['attach_reference', { id: noteId, caption: 'an upload URL for it' }],
      ['reply', { id: noteId, note: 'like this', references: [{ data: pngData }] }],
      ['attach_preview', { id: noteId, data: pngData }],
      ['attach_preview', { id: noteId }],
    ];
    for (const [name, args] of cases) {
      const r = await call(name, args);
      assert.ok(r.refused, `${name} was taken in a read-only workspace: ${r.text.slice(0, 200)}`);
      assert.match(r.text, /read-only until its invoice is paid/, `${name}: the plan's sentence`);
    }
    assert.equal(JSON.stringify(notes().find((c) => c.id === noteId)), before, 'nothing was added to the note');
    // as over HTTP
    const viaHttp = await request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'image', data: pngData }, headers: bearer });
    assert.equal(viaHttp.status, 402, viaHttp.text);
    // links and moments cost no storage: still fine
    assert.equal((await call('attach_reference', { id: noteId, url: 'https://example.com/look' })).refused, false);
  } finally {
    locked.delete('w1');
  }
  const open = await call('attach_reference', { id: noteId, data: pngData, caption: 'like this' });
  assert.equal(open.refused, false, `once the plan allows it again: ${open.text}`);
});

// The same gate for an option's file sent inline over MCP (ask_options), as `POST /api/asks` asks it for the whole
// request; an upload URL's file is asked when it arrives. Words, links and moments of renders cost no storage.
test('a read-only workspace: an option’s file sent inline over MCP gets the plan’s sentence, like POST /api/asks', async () => {
  const locked = await lockOf();
  const asked = (text: string) => notes().some((c) => c.text === text);
  locked.add('w1');
  try {
    const r = await call('ask_options', { video: slug, text: 'Inline file?', groups: [{ id: 'look', items: [{ id: 'a', data: pngData }, { id: 'b' }] }] });
    assert.ok(r.refused, `taken in a read-only workspace: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /read-only until its invoice is paid/, "the plan's sentence");
    assert.ok(!asked('Inline file?'), 'no question made');
    // as over HTTP
    const viaHttp = await request('POST', '/api/asks', {
      body: { video: slug, text: 'Over HTTP?', options: [{ id: 'look', items: [{ id: 'a', ref: { kind: 'file', data: pngData } }, { id: 'b' }] }] },
      headers: bearer,
    });
    assert.equal(viaHttp.status, 402, viaHttp.text);
    assert.match(viaHttp.json().error, /read-only until its invoice is paid/);
    // words and links cost no storage: still fine over MCP
    const words = await call('ask_options', {
      video: slug,
      text: 'Words only?',
      groups: [{ id: 'look', items: [{ id: 'a', url: 'https://example.com/a' }, { id: 'b' }] }],
    });
    assert.equal(words.refused, false, words.text);
  } finally {
    locked.delete('w1');
  }
  const open = await call('ask_options', { video: slug, text: 'Inline again?', groups: [{ id: 'look', items: [{ id: 'a', data: pngData }, { id: 'b' }] }] });
  assert.equal(open.refused, false, `once the plan allows it again: ${open.text}`);
});

test('PUB-13: draft_post takes the API’s caps (quietly); a body past the route’s limit is a 413', async () => {
  const film = makeVideo(path.join(dir, 'uploads/final-spot.mp4'), { w: 320, h: 180, dur: 4 });
  age(film);
  const finalSlug = slugify(store.createOrGetReview(film, { by: 'setup' }).review.video);
  store.setApproval(finalSlug, { status: 'approved' }, 'Olivia');
  store.setFinal(finalSlug, {}, 'Olivia');
  for (const args of [
    { video: finalSlug, platform: 'instagram', text: long(90_000) },
    { video: finalSlug, platform: 'youtube', title: long(3000) },
    { video: finalSlug, platform: 'facebook', tags: [long(300)] },
    { video: finalSlug, platform: 'facebook', tags: Array.from({ length: 150 }, (_, i) => `t${i}`) },
  ]) {
    const r = await call('draft_post', args);
    assert.ok(r.refused, `draft_post ${JSON.stringify(args).slice(0, 80)}… was taken: ${r.text.slice(0, 200)}`);
  }
  const { listPosts } = await import('../../lib/publish/posts.ts');
  assert.equal(listPosts().length, 0, 'nothing that long became a post');
  const ok = await call('draft_post', { video: finalSlug, platform: 'instagram', text: 'Spring is here' });
  assert.equal(ok.refused, false, ok.text);
  // the route's body limit answers as itself
  const big = await request('POST', `/api/review/${encodeURIComponent(finalSlug)}/posts`, {
    body: { platform: 'instagram', description: long(300_000) },
    headers: bearer,
  });
  assert.equal(big.status, 413, big.text);
});
