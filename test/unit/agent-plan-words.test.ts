// A plan's limit, by who reads it. A person in the app reads the billing module's own sentence with its limit sheet
// (the plan that would fit, the way there). An agent — an MCP tool's answer, a request with an API token, an upload URL
// handed to one — reads a plain sentence by the refusal's reason: no plan's name, price, link or step up (the chat apps'
// directories refuse tool answers that sell or promote), with the reason and the numbers kept for whatever reads them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const ext = await import('../../server/extension.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { AGENT_PLAN_WORDS, agentPlanWords } = await import('../../lib/planWords.ts');

// The module's words as a person reads them: the plan, the price, the step up — never an agent's to read.
const PITCH = 'Your Free plan holds 2 GB. Go Solo for no limit: €9 a month.';
const SALES = /Solo|Free plan|€|upgrade|checkout|https?:/i;
const full = {
  ok: false as const,
  reason: 'storage' as const,
  message: PITCH,
  messages: { de: 'Dein Free-Plan fasst 2 GB. Mit Solo ohne Grenze: 9 € im Monat.' },
  upgrade: 'solo',
  needed: 5_000_000,
  room: { videos: 2, bytes: 4_000_000 },
  fits: 'solo',
};
const allow = async () => ({ ok: true as const });
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
ctx.extension = ext.createExtension(
  {
    name: 'stand-in',
    entitlements: { get: async () => null, canUpload: async () => full, canAddMember: allow, canAddVideo: allow, canShare: allow },
    routes: [],
    workspaces: {},
  },
  ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false }),
);
const { request, base } = await startApp({ ctx, headers: { Connection: 'close', Host: 'review.test' } });

const owner = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const login = await request('POST', '/api/auth/login', { body: { email: 'o@example.com', password: 'a long password' }, headers: { Origin: PUBLIC } });
const person = { Cookie: cookieFrom(login), Origin: PUBLIC };
const agent = { Authorization: `Bearer ${auth.createToken(owner.id, 'agent').token}` };

const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 1 });
age(video);
const slug = slugify(store.createOrGetReview(video, { by: 'setup' }).review.video);
const noteId = store.addComment(slug, { frame: 3, text: 'Logo later', author: 'Olivia', author_id: owner.id }).id;
const png = path.join(dir, 'look.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', png]);
const pngData = fs.readFileSync(png).toString('base64');

const mcp = new Client({ name: 'plan-words', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { ...agent, Host: 'review.test' } } }));
after(() => mcp.close().catch(() => {}));

const reference = (headers: Record<string, string>) => request('POST', `/api/comments/${noteId}/refs`, { body: { kind: 'image', data: pngData }, headers });
type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const toolText = async (name: string, args: Record<string, unknown>) => {
  const r = (await mcp.callTool({ name, arguments: args })) as Result;
  return { refused: !!r.isError, text: r.content.map((c) => c.text || '').join('\n') };
};

test('a person in the app reads the plan’s own sentence and its limit sheet', async () => {
  const r = await reference(person);
  assert.equal(r.status, 402, r.text);
  const said = r.json();
  assert.equal(said.error, PITCH);
  assert.equal(said.reason, 'storage');
  assert.equal(said.upgrade, 'solo');
  assert.equal(said.fits, 'solo');
  assert.ok(said.messages?.de, 'the sentence in other languages');
  assert.deepEqual(said.room, { videos: 2, bytes: 4_000_000 });
  // a person's own upload URL, used without a sign-in: still the person's words
  const ticket = await request('POST', '/api/uploads/tickets', { body: { filename: 'next.mp4', folder: 'Reels' }, headers: person });
  assert.equal(ticket.status, 200, ticket.text);
  const put = await request('PUT', new URL(ticket.json().url).pathname, {
    body: fs.readFileSync(video),
    headers: { 'content-length': String(fs.statSync(video).size) },
  });
  assert.equal(put.status, 402, put.text);
  assert.equal(put.json().error, PITCH);
});

test('an API token reads a plain sentence: the reason and the numbers, never a plan, a price or a step up', async () => {
  const r = await reference(agent);
  assert.equal(r.status, 402, r.text);
  const said = r.json();
  assert.equal(said.error, AGENT_PLAN_WORDS.storage);
  assert.equal(said.reason, 'storage');
  assert.equal(said.needed, 5_000_000);
  assert.deepEqual(said.room, { videos: 2, bytes: 4_000_000 });
  for (const field of ['upgrade', 'fits', 'messages']) assert.equal(said[field], undefined, field);
  assert.doesNotMatch(r.text, SALES);
  // an upload (tus, as `lampo push` sends it): the sentence alone, as before — now an agent's
  const up = await tusUpload(request, video, { filename: 'spot.mp4' }, agent);
  assert.equal(up.status, 402, up.text);
  assert.equal(up.text.trim(), AGENT_PLAN_WORDS.storage);
  // an upload URL an API token asked for: whoever sends the PUT, an agent's words
  const ticket = await request('POST', '/api/uploads/tickets', { body: { filename: 'next.mp4', folder: 'Reels' }, headers: agent });
  const put = await request('PUT', new URL(ticket.json().url).pathname, {
    body: fs.readFileSync(video),
    headers: { 'content-length': String(fs.statSync(video).size) },
  });
  assert.equal(put.status, 402, put.text);
  assert.equal(put.json().error, AGENT_PLAN_WORDS.storage);
  assert.doesNotMatch(put.text, SALES);
});

test('an MCP tool’s answer, and the upload URL a tool hands out, read the plain sentence too', async () => {
  for (const [name, args] of [
    ['attach_reference', { id: noteId, data: pngData, caption: 'like this' }],
    ['attach_preview', { id: noteId, data: pngData }],
    ['ask_options', { video: slug, text: 'Which look?', groups: [{ id: 'look', items: [{ id: 'a', data: pngData }, { id: 'b' }] }] }],
  ] as const) {
    const r = await toolText(name, args);
    assert.ok(r.refused, `${name} was taken: ${r.text}`);
    assert.match(r.text, new RegExp(AGENT_PLAN_WORDS.storage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
    assert.doesNotMatch(r.text, SALES, name);
  }
  const issued = await toolText('request_upload', { filename: 'spot.mp4', folder: 'Reels' });
  assert.equal(issued.refused, false, issued.text);
  const url = /\/api\/uploads\/direct\/\S+/.exec(issued.text)?.[0] as string;
  const put = await request('PUT', url, { body: fs.readFileSync(video), headers: { 'content-length': String(fs.statSync(video).size) } });
  assert.equal(put.status, 402, put.text);
  assert.equal(put.json().error, AGENT_PLAN_WORDS.storage);
  assert.equal(put.json().reason, 'storage');
  assert.doesNotMatch(put.text, SALES);
});

test('every reason has its plain sentence, and a reason a module adds later gets a plain one too', () => {
  for (const reason of ['storage', 'members', 'videos', 'read-only', 'payment']) {
    const words = agentPlanWords(reason);
    assert.equal(words, AGENT_PLAN_WORDS[reason as keyof typeof AGENT_PLAN_WORDS]);
    assert.match(words, /a person/, `${reason}: a person decides`);
    assert.doesNotMatch(words, SALES, reason);
  }
  assert.match(AGENT_PLAN_WORDS.payment, /billing in Lampo/);
  assert.match(agentPlanWords('seats'), /^The workspace's plan doesn't allow this now: a person can change the plan in Lampo\.$/);
});
