// The review card's frames (MCP `show_review` and `review_frame`, mcp/app.ts) are new frames like any other: over a
// hosted server's /mcp they count toward the account's limit with `get_frame` and `GET /api/review/:slug/frame`, and
// past it they are refused in the same words; a frame made before still comes.
import assert from 'node:assert/strict';
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

type Result = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: { image?: string } };
const refusal = /too many new frames asked for by one account/;

test('the card’s frames count toward the account’s new frames: past the limit refused like get_frame, made ones still come', async () => {
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  ctx.setup.token = null;
  const video = makeVideo(path.join(dir, 'uploads/spot.mp4'), { w: 320, h: 180, dur: 4 });
  age(video);
  const slug = slugify(store.createOrGetReview(video, { by: 'setup' }).review.video);
  const { token } = auth.createToken(owner.id, 'agent');
  ctx.frameGrabs = new RateLimit(3, 3600_000);
  const c = new Client({ name: 'card-frames', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: { video: 'spot.mp4', ...args } })) as Result;
  const said = (r: Result) => r.content?.find((x) => x.type === 'text')?.text ?? '';
  try {
    // three new frames: two for the card, one for the model's look at the review
    for (const f of [1, 2]) {
      const r = await call('review_frame', { frame: f });
      assert.ok(!r.isError, said(r));
      assert.match(String(r.structuredContent?.image), /^data:image\//);
    }
    const shown = await call('show_review', { frame: 3 });
    assert.ok(!shown.isError, said(shown));
    assert.ok(shown.content?.some((x) => x.type === 'image'));
    // the account's limit is reached: every way to a new frame is refused alike
    const card = await call('review_frame', { frame: 4 });
    assert.ok(card.isError, 'review_frame grabbed past the limit');
    assert.match(said(card), refusal);
    const look = await call('show_review', { frame: 5 });
    assert.ok(look.isError, 'show_review grabbed past the limit');
    assert.match(said(look), refusal);
    const own = await call('get_frame', { frame: 6 });
    assert.ok(own.isError);
    assert.match(said(own), refusal);
    const http = await request('GET', `/api/review/${encodeURIComponent(slug)}/frame?frame=7`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(http.status, 429);
    // a frame made before is no new one
    const again = await call('review_frame', { frame: 1 });
    assert.ok(!again.isError, said(again));
  } finally {
    await c.close().catch(() => {});
  }
});
