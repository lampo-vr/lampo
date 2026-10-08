// MCP over Streamable HTTP (/mcp) in local mode with real SDK clients: a 2026-07-28 client (SDK v2) and a
// 2025-11-25 client (SDK v1). Live feedback both ways — wait_for_feedback and subscriptions/listen — and the review
// card (MCP App). The app runs in-process on a random port with an isolated store.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { productionTimeouts, startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { APP_URI } = await import('../../mcp/app.ts');
const { imageSize } = await import('../../bench/tokens/count.ts');

const video = makeVideo(path.join(dir, 'proj/export/http.mp4'), { w: 320, h: 180, dur: 1 });
age(video);

let slug = '';
const clients: { close(): Promise<void> }[] = [];
// Registered before the app starts, so the clients close before it stops (`after` hooks run in the order they're made).
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});
const { base } = await startApp({ token: 'test-token', loadSessions: async () => [], feed: 50 });

before(async () => {
  const added = await api<{ video: { slug: string } }>('POST', '/api/library', { path: video });
  slug = added.video.slug;
});

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}
const note = (text: string, frame = 5, drawing?: object[]) =>
  api<{ id: string }>('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { frame, text, ...(drawing ? { drawing } : {}) });

async function modern(): Promise<Client> {
  const c = new Client({ name: 'http-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  return c;
}

type Result = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

test('a 2026-07-28 client lists the tools and reads the library', async () => {
  const c = await modern();
  assert.equal(c.getNegotiatedProtocolVersion(), '2026-07-28');
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const t of ['list_videos', 'get_open_notes', 'wait_for_feedback', 'show_review', 'mark_fixed', 'track_video']) assert.ok(names.includes(t), t);
  const listed = (await c.callTool({ name: 'list_videos', arguments: {} })) as Result;
  assert.match(textOf(listed), /http\.mp4/);
});

test('the machine itself still names files: add_note on a render not under review yet puts it under review where it is', async () => {
  const c = await modern();
  const fresh = makeVideo(path.join(dir, 'proj/export/fresh.mp4'), { w: 160, h: 90, dur: 1 });
  age(fresh);
  const added = (await c.callTool({ name: 'add_note', arguments: { video: fresh, frame: 2, text: 'Is the logo final?' } })) as Result;
  assert.ok(!added.isError, textOf(added));
  assert.match(textOf(added), /c_[0-9a-f]{6} pinned at/);
  const listed = (await c.callTool({ name: 'list_videos', arguments: {} })) as Result;
  assert.ok(textOf(listed).includes(fresh), 'tracked by its path on this machine');
});

test('/mcp?tools=lean offers the review loop only', async () => {
  const c = new Client({ name: 'lean-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?tools=lean`)));
  clients.push(c);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const t of ['get_open_notes', 'get_note', 'mark_fixed', 'wait_for_feedback', 'get_playbook']) assert.ok(names.includes(t), t);
  for (const t of ['show_review', 'review_frame', 'set_status', 'attach_preview', 'move_video']) assert.ok(!names.includes(t), t);
});

test('wait_for_feedback times out cleanly with a cursor, then wakes up on a new note', async () => {
  const c = await modern();
  let t = Date.now();
  const idle = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 1 } })) as Result;
  assert.ok(Date.now() - t >= 900 && Date.now() - t < 4000, `waited ${Date.now() - t} ms`);
  assert.match(textOf(idle), /No new feedback in 1 s\.\ncursor: /);
  // after the lines agents parse: what is going on (notes come together on Send), and to call again now
  assert.match(textOf(idle), /\ncursor: \S+\nThe person's notes arrive together when they press Send: call wait_for_feedback again now with this cursor\.$/);

  t = Date.now();
  const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { video: 'http.mp4', timeout_s: 20 } }) as Promise<Result>;
  await new Promise((r) => setTimeout(r, 300));
  const made = await note('Logo zu früh', 5, [{ type: 'box', x: 10, y: 10, w: 40, h: 30 }]);
  const got = await waiting;
  assert.ok(Date.now() - t < 5000, `woke after ${Date.now() - t} ms`);
  assert.match(textOf(got), new RegExp(`1 new:\\n\\[[\\d:]+\\] NEW SHOULD \\[[^\\]]*\\] ${made.id} .* — "Logo zu früh"`));
  assert.ok(
    got.content.some((x) => x.type === 'image' && x.mimeType === 'image/jpeg'),
    'the marked frame of a note with a drawing comes along',
  );
  // The line without file paths; the video once; the full event (paths included) in structuredContent.
  assert.doesNotMatch(textOf(got), /marked: |range frames: /);
  assert.match(textOf(got), /\nvideo: .*http\.mp4\n/);
  assert.equal(((got.structuredContent?.events as { id: string }[]) || [])[0]?.id, made.id);
  const cursor = /cursor: (\S+)/.exec(textOf(got))?.[1];
  assert.ok(cursor);

  // A note without a drawing: no picture, a pointer to get_note.
  const plain = c.callTool({ name: 'wait_for_feedback', arguments: { video: 'http.mp4', since: cursor, timeout_s: 20 } }) as Promise<Result>;
  await new Promise((r) => setTimeout(r, 300));
  await note('Zu dunkel', 8);
  const words = await plain;
  assert.ok(!words.content.some((x) => x.type === 'image'), 'no picture without a drawing');
  assert.match(textOf(words), /get_note <id> shows its frame/);
  const next = /cursor: (\S+)/.exec(textOf(words))?.[1];

  const again = (await c.callTool({ name: 'wait_for_feedback', arguments: { since: next, timeout_s: 1 } })) as Result;
  assert.match(textOf(again), /No new feedback/, 'the cursor never hands out the same note twice');
});

test('subscriptions/listen: a new note is a resources/updated notification for lampo://inbox, under that address only', async () => {
  const c = await modern();
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (n) => {
    updates.push(n.params.uri);
  });
  const review = `lampo://review/${encodeURIComponent(slug)}`;
  const sub = await c.listen({ resourceSubscriptions: ['lampo://inbox', review] });
  await note('Titel kürzer', 14);
  const deadline = Date.now() + 5000;
  while (updates.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(updates.sort(), ['lampo://inbox', review].sort(), 'not again under the older vr:// addresses');
  await sub.close();
});

test('subscriptions/listen: a client set up with the older vr://inbox still hears a new note', async () => {
  const c = await modern();
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (n) => {
    updates.push(n.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox', `vr://review/${encodeURIComponent(slug)}`] });
  assert.deepEqual(sub.honoredFilter.resourceSubscriptions?.sort(), ['vr://inbox', `vr://review/${encodeURIComponent(slug)}`].sort());
  await note('Musik leiser', 12);
  const deadline = Date.now() + 5000;
  while (updates.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(updates.includes('vr://inbox'), JSON.stringify(updates));
  assert.ok(updates.includes(`vr://review/${encodeURIComponent(slug)}`), JSON.stringify(updates));
  await sub.close();
});

test('VA2-6: the machine’s own agents listen however many there are (they are its owner, from the machine itself)', async () => {
  const subs = [];
  for (let i = 0; i < 6; i++) subs.push(await (await modern()).listen({ resourceSubscriptions: ['vr://inbox'] }));
  assert.equal(subs.length, 6);
  for (const sub of subs) await sub.close();
});

test('A12-D13: each device with the LAN link is a connection of its own (by its address), not one for all of them', async () => {
  // The same app with the LAN link on, reachable on both loopback addresses: two devices of the owner's.
  const { loadConfig } = await import('../../lib/config.ts');
  const { createContext } = await import('../../server/context.ts');
  const { createApp } = await import('../../server/app.ts');
  const lanCtx = createContext({ cfg: loadConfig(), lan: true, token: 'lan-token', loadSessions: async () => [] });
  const lan = productionTimeouts(http.createServer(createApp(lanCtx)));
  await new Promise<void>((r) => lan.listen(0, '::', r));
  const port = (lan.address() as AddressInfo).port;
  try {
    const device = async (host: string) => {
      const c = new Client({ name: 'lan-device', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`), { requestInit: { headers: { Cookie: 'vr_t=lan-token' } } }));
      clients.push(c);
      return c;
    };
    const [phone, tablet] = [await device('127.0.0.1'), await device('[::1]')];
    const subs = [];
    for (let i = 0; i < 4; i++) subs.push(await phone.listen({ resourceSubscriptions: ['vr://inbox'] }));
    await assert.rejects(phone.listen({ resourceSubscriptions: ['vr://inbox'] }), /this connection/, 'a device’s own four');
    for (let i = 0; i < 4; i++) subs.push(await tablet.listen({ resourceSubscriptions: ['vr://inbox'] }));
    assert.equal(subs.length, 8, 'the other device has its own');
    for (const sub of subs) await sub.close();
  } finally {
    lan.closeAllConnections();
    lan.close();
  }
});

test('show_review: the card data (no picture: the card loads its own), a downscaled frame for the model, and the ui:// resource', async () => {
  const c = await modern();
  const r = (await c.callTool({ name: 'show_review', arguments: { video: 'http.mp4' } })) as Result;
  assert.ok(!r.isError, textOf(r));
  const card = r.structuredContent as { name: string; notes: { id: string }[]; still: { image: string; kind: string; note: string }; playerUrl: string };
  assert.equal(card.name, 'http.mp4');
  assert.ok(card.notes.length >= 2);
  assert.equal(card.still.kind, 'marked');
  // what the model reads stays small: ChatGPT's model reads structuredContent as it is, Claude keeps an answer inline up
  // to about 150,000 characters
  assert.equal(card.still.image, '', 'no picture in the card data');
  assert.ok(JSON.stringify(r).length < 100_000, `${JSON.stringify(r).length} characters`);
  assert.match(card.playerUrl, new RegExp(`^${base}/#/v/`));
  const image = r.content.find((x) => x.type === 'image');
  assert.ok(image?.data, 'a frame for hosts without apps');
  assert.ok((imageSize(image.data)?.w ?? 0) <= 640, 'downscaled for the model');
  const tool = (await c.listTools()).tools.find((t) => t.name === 'show_review');
  assert.equal((tool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, APP_URI);
  const res = await c.readResource({ uri: APP_URI });
  const html = res.contents[0] as { mimeType?: string; text?: string; _meta?: Record<string, unknown> };
  assert.equal(html.mimeType, 'text/html;profile=mcp-app');
  assert.match(html.text || '', /<!doctype html>/i);
  // the card loads nothing from anywhere, and says so; ChatGPT names its origin after this server's
  const meta = html._meta as { ui: { csp: Record<string, string[]>; domain?: string; prefersBorder: boolean } } & Record<string, unknown>;
  assert.deepEqual(meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.equal(meta.ui.domain, undefined, 'Claude takes ui.domain only in its own form: left to the host');
  assert.equal(meta['openai/widgetDomain'], new URL(base).origin);
  assert.match(String(meta['openai/widgetDescription']), /^One video's review/);
  // the frame the card asks for: the marked one of the note, sharp enough for the card
  const first = (await c.callTool({ name: 'review_frame', arguments: { video: 'http.mp4', note: card.still.note } })) as Result;
  const still = first.structuredContent as { kind: string; image: string };
  assert.equal(still.kind, 'marked');
  assert.match(still.image, /^data:image\/jpeg;base64,/);
  const step = (await c.callTool({ name: 'review_frame', arguments: { video: 'http.mp4', frame: 7 } })) as Result;
  assert.equal((step.structuredContent as { frame: number; kind: string }).frame, 7);
  assert.equal((step.structuredContent as { frame: number; kind: string }).kind, 'clean');
});

test('a 2025-11-25 client (SDK v1) is served statelessly from the same endpoint', async () => {
  const c = new LegacyClient({ name: 'legacy-test', version: '1.0.0' });
  await c.connect(new LegacyTransport(new URL(`${base}/mcp`)));
  clients.push(c);
  assert.equal(c.getServerVersion()?.name, 'lampo', 'the server names itself lampo over HTTP too');
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('wait_for_feedback') && names.includes('get_open_notes'));
  const r = (await c.callTool({ name: 'get_open_notes', arguments: { video: 'http.mp4', include_images: false } })) as Result;
  assert.match(textOf(r), /Logo zu früh/);
  const w = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 0 } })) as Result;
  assert.match(textOf(w), /No new feedback/);
});

test('the guard still applies: foreign origins and hosts are refused', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const post = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/mcp`);
      const req = http.request(
        { host: u.hostname, port: u.port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', ...headers } },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(init));
    });
  assert.equal(await post({ Origin: 'http://evil.example' }), 403);
  assert.equal(await post({ Host: 'evil.example' }), 421);
});
