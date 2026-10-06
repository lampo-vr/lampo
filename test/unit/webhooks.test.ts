// Webhooks against a local receiver: signatures, the three formats, retries (and when not to), timeouts, which
// events a hook wants, hooks managed in Settings, and the whole path from a client's note to a Slack-style message.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, sleep } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const hooks = await import('../../lib/webhooks.ts');
const { loadConfig } = await import('../../lib/config.ts');
const store = await import('../../lib/store.ts');

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: string;
}
// A receiver that answers with the next status from `plan` (then 200), or not at all for 'hang'.
function receiver() {
  const hits: Hit[] = [];
  const plan: (number | 'hang')[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      const next = plan.shift() ?? 200;
      if (next === 'hang') return;
      res.writeHead(next).end();
    });
  });
  return {
    hits,
    plan,
    start: () => new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`))),
    stop: () => {
      srv.closeAllConnections();
      srv.close();
    },
  };
}

const rx = receiver();
let url = '';
before(async () => {
  url = await rx.start();
});
after(() => rx.stop());

const event = (over: Partial<ReviewEvent> = {}): ReviewEvent => ({
  at: '2026-09-28T10:00:00+02:00',
  type: 'comment',
  by: 'guest:Mia',
  video: '/work/Acme/spot.mp4',
  slug: '__work__Acme__spot.mp4',
  session: null,
  id: 'c_0a1b2c',
  v: 2,
  frame: 90,
  timecode: '00:03:00',
  text: 'Logo <später> & kleiner',
  ...over,
});
const quiet = { log: () => {}, retryDelays: [5, 5, 5] };

test('json deliveries are signed so receivers can check them, with the event and a link to the note', async () => {
  rx.hits.length = 0;
  const w = hooks.createWebhooks({ config: [{ url, secret: 's3cret', format: 'json' }], baseUrl: 'https://review.example.com', ...quiet });
  w.handle(event());
  await w.idle();
  assert.equal(rx.hits.length, 1);
  const { headers, body } = rx.hits[0];
  assert.equal(headers['x-vr-event'], 'comment');
  assert.ok(hooks.verifySignature('s3cret', body, String(headers['x-vr-signature'])));
  assert.ok(!hooks.verifySignature('wrong', body, String(headers['x-vr-signature'])));
  const json = JSON.parse(body);
  assert.equal(json.url, 'https://review.example.com/#/v/__work__Acme__spot.mp4?c=c_0a1b2c');
  assert.match(json.text, /^Mia \(client\) left a note on spot\.mp4 v2 at 00:03:00/);
  assert.equal(json.event.by, 'guest:Mia');
});

test('slack and discord get a readable line; slack markup is escaped, discord mentions are off', async () => {
  rx.hits.length = 0;
  const w = hooks.createWebhooks({
    config: [
      { url, format: 'slack' },
      { url, format: 'discord' },
    ],
    baseUrl: 'http://localhost:4747',
    ...quiet,
  });
  w.handle(event());
  await w.idle();
  const [slack, discord] = rx.hits.map((h) => JSON.parse(h.body)).sort((a) => (a.text ? -1 : 1));
  assert.match(slack.text, /“Logo &lt;später&gt; &amp; kleiner” <http:\/\/localhost:4747\/#\/v\/.+\|Open>$/);
  assert.match(discord.content, /“Logo <später> & kleiner”\nhttp:\/\/localhost:4747/);
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  assert.equal(rx.hits[0].headers['x-vr-signature'], undefined, 'no secret, no signature');
});

test('retries: server errors and 429 are retried with backoff, other refusals are not', async () => {
  rx.hits.length = 0;
  rx.plan.push(500, 503);
  const w = hooks.createWebhooks({ config: [{ url }], baseUrl: 'http://x', ...quiet });
  w.handle(event());
  await w.idle();
  assert.equal(rx.hits.length, 3);
  assert.deepEqual((w.list()[0].last && { ok: w.list()[0].last?.ok, attempts: w.list()[0].last?.attempts }) || null, { ok: true, attempts: 3 });
  assert.equal(new Set(rx.hits.map((h) => h.headers['x-vr-delivery'])).size, 1, 'one delivery id across its attempts');
  rx.hits.length = 0;
  rx.plan.push(400);
  w.handle(event());
  await w.idle();
  assert.equal(rx.hits.length, 1, 'a 400 is not retried');
  assert.equal(w.list()[0].last?.error, 'HTTP 400');
});

test('a receiver that never answers times out, and the failure is remembered, not thrown', async () => {
  rx.hits.length = 0;
  rx.plan.push('hang', 'hang', 'hang', 'hang');
  const logged: string[] = [];
  const w = hooks.createWebhooks({ config: [{ url }], baseUrl: 'http://x', retryDelays: [1, 1, 1], timeoutMs: 150, log: (m) => logged.push(m) });
  w.handle(event());
  await w.idle();
  const last = w.list()[0].last;
  assert.equal(last?.ok, false);
  assert.equal(last?.error, 'timed out');
  assert.equal(last?.attempts, 4);
  assert.equal(logged.length, 1);
});

test("which events a hook wants: 'client' (default), 'all', or event types", () => {
  const client = event();
  const team = event({ by: 'alex' });
  const version = event({ type: 'version', by: 'system' });
  assert.equal(hooks.wants({ url }, client), true);
  assert.equal(hooks.wants({ url }, team), false);
  assert.equal(hooks.wants({ url, events: ['all'] }, version), true);
  assert.equal(hooks.wants({ url, events: ['version'] }, version), true);
  assert.equal(hooks.wants({ url, events: ['version'] }, client), false);
  assert.equal(hooks.wants({ url }, event({ type: 'approval', text: 'APPROVED v2' })), true);
  // A client downloading a whole review room: client activity, told in one line, linked to the folder.
  const download = event({
    type: 'download',
    video: 'Acme/Reels',
    slug: '',
    folder: 'Acme/Reels',
    text: 'downloaded all 6 videos of Acme/Reels (3.4 GB, originals)',
  });
  assert.equal(hooks.wants({ url }, download), true);
  assert.equal(hooks.describe(download), 'Mia (client) downloaded all 6 videos of Acme/Reels (3.4 GB, originals)');
  assert.throws(() => hooks.checkHook({ url: 'ftp://x' }), /http/);
  assert.throws(() => hooks.checkHook({ url, format: 'teams' as 'json' }), /format/);
  assert.equal(hooks.envHook({ VR_WEBHOOK_URL: url, VR_WEBHOOK_FORMAT: 'slack', VR_WEBHOOK_EVENTS: 'client,approval' })?.format, 'slack');
});

test('Settings: hooks can be added, changed (secret kept unless replaced), tested and removed; config hooks are read-only', async () => {
  const video = makeVideo(path.join(dir, 'src/export/hook.mp4'), { w: 160, h: 90, dur: 1 });
  age(video);
  store.createOrGetReview(video, { by: 'tester' });
  const slug = path.resolve(video).split('/').join('__');
  const { ctx, base, close } = await startApp({
    cfg: { ...loadConfig(), webhooks: [{ url, format: 'json' }] },
    token: 't',
    loadSessions: async () => [],
    feed: 25,
  });
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    const made = await call('POST', '/api/admin/webhooks', { url, format: 'slack', label: 'Team channel', secret: 'kept-secret-value' });
    assert.equal(made.status, 200);
    assert.equal(made.json.secret, true);
    assert.equal(made.json.source, 'settings');
    const list = (await call('GET', '/api/admin/webhooks')).json.webhooks;
    assert.deepEqual(
      list.map((h: { source: string }) => h.source),
      ['config', 'settings'],
    );
    assert.ok(!JSON.stringify(list).includes('kept-secret-value'), 'secrets never go back out');
    assert.equal((await call('PATCH', `/api/admin/webhooks/${made.json.id}`, { label: 'Renamed', secret: '' })).json.secret, true);
    assert.equal((await call('PATCH', '/api/admin/webhooks/cfg_0', { label: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/admin/webhooks', { url: 'not a url' })).status, 400);
    rx.hits.length = 0;
    const tested = await call('POST', `/api/admin/webhooks/${made.json.id}/test`);
    assert.equal(tested.json.ok, true);
    assert.match(JSON.parse(rx.hits[0].body).text, /Test client \(client\) left a note/);

    // A client's note, written by anyone (here the store directly), reaches both hooks through the event feed.
    rx.hits.length = 0;
    store.addComment(slug, { frame: 5, text: 'Bitte heller', author: 'guest:Ada' });
    for (let i = 0; i < 80 && rx.hits.length < 2; i++) await sleep(25);
    await ctx.webhooks.idle();
    assert.equal(rx.hits.length, 2);
    const slack = rx.hits.map((h) => JSON.parse(h.body)).find((b) => b.text);
    assert.match(slack.text, /Ada \(client\) left a note on hook\.mp4 v1 at 00:00:05: “Bitte heller”/);
    // The team's own notes don't ping the channel.
    rx.hits.length = 0;
    store.addComment(slug, { frame: 6, text: 'internal', author: 'tester' });
    await sleep(150);
    await ctx.webhooks.idle();
    assert.equal(rx.hits.length, 0);

    assert.equal((await call('DELETE', `/api/admin/webhooks/${made.json.id}`)).status, 200);
    assert.equal((await call('DELETE', '/api/admin/webhooks/cfg_0')).status, 404);
  } finally {
    await close();
  }
});
