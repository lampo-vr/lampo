// covers: lib/shots.ts lib/rateLimit.ts server/routes/media.ts lib/backend/local.ts mcp/app.ts mcp/tools/read.ts
// An account's new frames are counted before each grab starts, not once it has landed: a burst of requests sent
// together at an account with one frame left gets exactly one new frame, on every way to one (the HTTP frame route,
// MCP `get_frame`, the review card's `review_frame`), and a grab that fails gives its frame back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { RateLimit } = await import('../../lib/rateLimit.ts');
const { ctx, base, request } = await startApp({ headers: { Host: 'review.test' } });
after(() => ctx.mail.stop());

const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
ctx.setup.token = null;
const video = makeVideo(path.join(dir, 'uploads/burst.mp4'), { w: 320, h: 180, dur: 4 });
age(video);
const review = store.createOrGetReview(video, { by: 'setup' }).review;
const slug = slugify(review.video);
const { token } = auth.createToken(owner.id, 'agent');
const bearer = { Authorization: `Bearer ${token}` };
const BURST = 20;
/** Frames nobody asked for yet: each test takes its own. */
let next = 0;
const fresh = (n: number) => Array.from({ length: n }, () => next++);

type Result = { isError?: boolean; content?: { type: string; text?: string }[] };
const refusal = /too many new frames asked for by one account/;

async function mcp<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<Result>) => Promise<T>): Promise<T> {
  const c = new Client({ name: 'frame-burst', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer } }));
  try {
    return await fn(async (name, args) => (await c.callTool({ name, arguments: { video: 'burst.mp4', ...args } })) as Result);
  } finally {
    await c.close().catch(() => {});
  }
}
const said = (r: Result) => r.content?.find((x) => x.type === 'text')?.text ?? '';

test('a burst over HTTP at an account with one new frame left: one frame, the rest 429', { timeout: 300_000 }, async () => {
  ctx.frameGrabs = new RateLimit(1, 3600_000);
  const codes = await Promise.all(fresh(BURST).map(async (f) => (await request('GET', `/api/review/${slug}/frame?frame=${f}`, { headers: bearer })).status));
  assert.deepEqual([codes.filter((c) => c === 200).length, codes.filter((c) => c === 429).length], [1, BURST - 1], `answers: ${codes.join(' ')}`);
});

test('a burst through MCP, get_frame and the review card alike: one new frame', { timeout: 300_000 }, async () => {
  const came: Record<string, number> = {};
  for (const tool of ['get_frame', 'review_frame']) {
    ctx.frameGrabs = new RateLimit(1, 3600_000);
    const results = await mcp((call) => Promise.all(fresh(BURST).map((frame) => call(tool, { frame }))));
    came[tool] = results.filter((r) => !r.isError).length;
    for (const r of results.filter((x) => x.isError)) assert.match(said(r), refusal, tool);
  }
  assert.deepEqual(came, { get_frame: 1, review_frame: 1 }, `new frames that came of ${BURST} asked for together`);
});

test('a grab that fails gives its frame back', { timeout: 300_000 }, async () => {
  ctx.frameGrabs = new RateLimit(1, 3600_000);
  // the version's bytes gone for a moment (its copy and the file it came from): the grab fails
  const ver = review.versions.at(-1);
  const files = [...new Set([store.versionFile(review, ver?.v ?? 1), video])].filter((f): f is string => !!f && fs.existsSync(f));
  for (const f of files) fs.renameSync(f, `${f}.away`);
  try {
    assert.equal(await store.ensureVersionFile(review, ver?.v ?? 1), null);
    const [gone] = fresh(1);
    const r = await request('GET', `/api/review/${slug}/frame?frame=${gone}`, { headers: bearer });
    assert.ok(r.status >= 400 && r.status !== 429, `the grab failed (${r.status})`);
  } finally {
    for (const f of files) fs.renameSync(`${f}.away`, f);
  }
  const [frame] = fresh(1);
  assert.equal((await request('GET', `/api/review/${slug}/frame?frame=${frame}`, { headers: bearer })).status, 200, 'its frame was given back');
  const [past] = fresh(1);
  assert.equal((await request('GET', `/api/review/${slug}/frame?frame=${past}`, { headers: bearer })).status, 429, 'and that one was the last');
});
