// On a person's own machine, paths on its disk are for the machine itself (`via: 'local'`) only. A phone with the LAN
// link, an agent with a token over `/mcp` and the live stream read screenshot URLs in the inbox (`/api/inbox`,
// `/api/inbox.md`, `vr://inbox`) and in `wait_for_feedback`'s events — never where the store keeps them (audit A12
// verification: VA2-7 and the LAN's inbox).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_STT: 'off', VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake', VR_OCR: 'off' } });

const store = await import('../../lib/store.ts');
const auth = await import('../../lib/auth.ts');
const { slugify, DATA, VERSIONS } = await import('../../lib/paths.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

const video = makeVideo(path.join(dir, 'proj', 'export', 'spot.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(video);
const enc = encodeURIComponent;

const LAN = 'lan-token-paths-1';
let machine: http.Server;
let port = 0;
let atMachine: Request;
let phone: Request;
let token = '';
before(async () => {
  machine = http.createServer(createApp(createContext({ cfg: loadConfig(), lan: true, token: LAN, loadSessions: async () => [] })));
  await new Promise<void>((r) => machine.listen(0, '127.0.0.1', r));
  port = (machine.address() as AddressInfo).port;
  atMachine = client(port);
  phone = client(port, { 'x-forwarded-for': '192.168.1.23', cookie: `vr_t=${LAN}` });
  // a note with a drawing from the owner at the machine: its screenshots are files in the store
  const made = await atMachine('POST', `/api/review/${enc(slug)}/comments`, {
    body: { frame: 3, text: 'Logo kleiner', drawing: [{ type: 'box', x: 10, y: 10, w: 40, h: 30 }] },
  });
  assert.equal(made.status, 200, made.text);
  const owner = auth.localOwner();
  assert.ok(owner);
  token = auth.createToken(owner.id, 'agent').token;
});
after(() => {
  machine.closeAllConnections();
  machine.close();
});

// Where the store keeps a note's screenshots (the render itself was linked from its own folder on the machine: its
// path is the video's name here, as in the library).
const names = (text: string) => text.includes(DATA);

test('the inbox over HTTP: the machine itself reads the files, the LAN reads URLs', async () => {
  assert.equal((await phone('GET', '/api/auth/status')).json().via, 'lan', 'the phone is the owner through the LAN link');
  const here = await atMachine('GET', '/api/inbox');
  assert.ok(names(here.text), 'the machine itself reads where the screenshots are');
  const there = await phone('GET', '/api/inbox');
  assert.equal(there.status, 200, there.text);
  assert.ok(!names(there.text), `the LAN: ${there.text.slice(0, 300)}`);
  const marked = there.json().events.find((e: { shots?: { marked?: string } }) => e.shots?.marked)?.shots.marked as string;
  assert.match(marked, /^\/data\//, 'a URL the phone can open');

  const md = await phone('GET', '/api/inbox.md');
  assert.equal(md.status, 200);
  assert.ok(!names(md.text), `INBOX.md for the LAN: ${md.text.slice(0, 300)}`);
});

test('“Copy for an agent” (the prompt): the machine itself reads the files, the LAN and a token are pointed at vr', async () => {
  const url = `/api/review/${enc(slug)}/prompt`;
  const here = await atMachine('GET', url);
  assert.ok(names(here.text), 'the machine itself reads where review.json and the screenshots are');
  for (const [what, ask] of [
    ['the LAN', phone],
    ['a token', client(port, { Authorization: `Bearer ${token}` })],
  ] as const) {
    const r = await ask('GET', url);
    assert.equal(r.status, 200, `${what}: ${r.text}`);
    assert.ok(!names(r.text), `${what}: ${r.text.slice(0, 400)}`);
    assert.match(r.text, /lampo show c_[0-9a-f]{6}/, `${what}: the frames through vr`);
  }
});

test('an agent with a token over /mcp: vr://inbox and wait_for_feedback carry URLs, not paths', async () => {
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const inbox = (await c.readResource({ uri: 'vr://inbox' })).contents.map((x) => ('text' in x ? x.text : '')).join('\n');
    assert.ok(inbox.includes('Logo kleiner'), 'the note is in it');
    assert.ok(!names(inbox), `vr://inbox: ${inbox.slice(0, 300)}`);
    const r = (await c.callTool({ name: 'wait_for_feedback', arguments: { since: '2000-01-01T00:00:00Z', timeout_s: 0, images: 'none' } })) as {
      structuredContent?: { events: { shots?: { marked?: string | null } }[] };
    };
    const events = r.structuredContent?.events ?? [];
    assert.ok(events.length, 'the note’s event');
    assert.ok(!names(JSON.stringify(events)), `wait_for_feedback's events: ${JSON.stringify(events).slice(0, 300)}`);
    assert.ok(
      events.some((e) => e.shots?.marked?.startsWith('/data/')),
      'screenshots as URLs',
    );
  } finally {
    await c.close();
  }
});

test('the setup’s health check: the machine itself reads where the store is, the LAN reads the kind (ONB-1)', async () => {
  const here = await atMachine('GET', '/api/server/health');
  assert.equal(here.status, 200, here.text);
  assert.equal(here.json().storage.where, DATA, 'the machine itself: the data folder');
  const there = await phone('GET', '/api/server/health');
  assert.equal(there.status, 200, there.text);
  assert.ok(!names(there.text), `the LAN: ${there.text}`);
  const s = there.json().storage;
  assert.deepEqual([s.kind, s.writable, s.where, typeof s.free_bytes], ['local', true, null, 'number'], JSON.stringify(s));
});

test('footage search: the machine itself gets the render’s file, the LAN and a token never a path', async () => {
  const { indexNow, targets } = await import('../../lib/footage/indexer.ts');
  const { createEmbedder, resetEmbedder } = await import('../../lib/footage/embedder.ts');
  const e = createEmbedder({ kind: 'fake' });
  resetEmbedder(e);
  try {
    assert.equal(await indexNow(targets(), { e }), 1);
    const url = '/api/footage/find?q=a+test+pattern';
    const here = (await atMachine('GET', url)).json();
    assert.ok(here.shots[0]?.file?.startsWith(VERSIONS) || here.shots[0]?.file === video, JSON.stringify(here.shots[0]));
    for (const [what, ask] of [
      ['the LAN', phone],
      ['a token', client(port, { Authorization: `Bearer ${token}` })],
    ] as const) {
      const r = await ask('GET', url);
      assert.equal(r.status, 200, `${what}: ${r.text}`);
      assert.ok(r.json().shots.length, what);
      assert.ok(!r.text.includes('"file"') && !names(r.text) && !r.text.includes(VERSIONS), `${what}: ${r.text.slice(0, 400)}`);
    }
    const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const r = (await c.callTool({ name: 'find_footage', arguments: { query: 'a test pattern' } })) as { content: { text?: string }[] };
      const text = r.content.map((x) => x.text ?? '').join('\n');
      assert.match(text, /^1 of 1 shots/);
      assert.ok(!names(text) && !text.includes(VERSIONS) && !text.includes(dir), text);
    } finally {
      await c.close();
    }
  } finally {
    resetEmbedder();
  }
});
