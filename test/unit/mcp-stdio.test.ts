// MCP over stdio (bin/vr-mcp) hears what changes in the store the way /mcp does (server/routes/mcp.ts): a 2025-11-25
// client (SDK v1) that subscribed to a resource gets notifications/resources/updated for it, and only for it, and
// list_changed when a video arrives; a 2026-07-28 client (SDK v2) gets them on its subscriptions/listen. The notes are
// written by someone else (here: this process, like the app or `vr`), so only the store's event log carries them. When
// the client goes away, the server stops following the log and exits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { age, isolatedEnv, makeVideo, ROOT, sleep } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { oldReviewUri, reviewUri } = await import('../../mcp/format.ts');

function track(rel: string): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  return slugify(file);
}
const one = track('proj/export/one.mp4');
const two = track('proj/export/two.mp4');

const MCP = path.join(ROOT, 'bin/vr-mcp');
const childEnv = { ...env, VR_REMOTE: '0' } as Record<string, string>;
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c().catch(() => {});
});

async function until(what: string, fn: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('a 2025 client: resources/subscribe, then updates for what it subscribed to (and only that), list_changed for a new video', async () => {
  const c = new LegacyClient({ name: 'stdio-legacy', version: '1.0.0' });
  await c.connect(new LegacyStdio({ command: process.execPath, args: [MCP], env: childEnv, stderr: 'inherit' }));
  closers.push(() => c.close());
  const caps = c.getServerCapabilities();
  assert.equal(caps?.resources?.subscribe, true);
  const updates: string[] = [];
  let listChanged = 0;
  c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params.uri);
  });
  c.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    listChanged++;
  });
  await c.subscribeResource({ uri: 'vr://inbox' });
  await c.subscribeResource({ uri: reviewUri(one) });

  store.addComment(one, { frame: 3, text: 'Musik leiser', author: 'Mia' });
  await until('the inbox and the review', () => updates.includes('vr://inbox') && updates.includes(reviewUri(one)));

  // A note on a video nobody subscribed to: the inbox changed, that video's review.md is nobody's business.
  updates.length = 0;
  store.addComment(two, { frame: 4, text: 'Logo kleiner', author: 'Mia' });
  await until('the inbox', () => updates.includes('vr://inbox'));
  await sleep(300);
  assert.deepEqual(updates, ['vr://inbox']);

  // Unsubscribed: the inbox falls silent, the review still speaks (sent after the inbox, so its arrival settles it).
  await c.unsubscribeResource({ uri: 'vr://inbox' });
  updates.length = 0;
  store.addComment(one, { frame: 5, text: 'Schnitt früher', author: 'Mia' });
  await until('the review', () => updates.includes(reviewUri(one)));
  assert.deepEqual(updates, [reviewUri(one)]);

  const before = listChanged;
  track('proj/export/three.mp4');
  await until('list_changed', () => listChanged > before);
});

test('a 2026-07-28 client: subscriptions/listen gets the same notifications over stdio', async () => {
  const c = new Client({ name: 'stdio-modern', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: childEnv, stderr: 'inherit' }));
  closers.push(() => c.close());
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (n) => {
    updates.push(n.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox', reviewUri(one)] });
  assert.deepEqual(sub.honoredFilter.resourceSubscriptions?.sort(), ['vr://inbox', reviewUri(one)].sort());
  store.addComment(one, { frame: 6, text: 'Farbe wärmer', author: 'Mia' });
  await until('the inbox and the review', () => updates.includes('vr://inbox') && updates.includes(reviewUri(one)));
  await sub.close();
});

test('the resources are lampo://; the vr:// addresses from before still read the same and are heard by who asks for them', async () => {
  const c = new LegacyClient({ name: 'stdio-addresses', version: '1.0.0' });
  await c.connect(new LegacyStdio({ command: process.execPath, args: [MCP], env: childEnv, stderr: 'inherit' }));
  closers.push(() => c.close());
  const listed = (await c.listResources()).resources.map((r) => r.uri);
  assert.ok(listed.includes('lampo://inbox') && listed.includes(reviewUri(one)), listed.join(' '));
  assert.ok(reviewUri(one).startsWith('lampo://review/'));
  assert.deepEqual(
    listed.filter((u) => u.startsWith('vr://')),
    [],
    'the older addresses are not listed twice',
  );
  const textOf = async (uri: string) => (await c.readResource({ uri })).contents.map((x) => ('text' in x ? x.text : '')).join('\n');
  assert.equal(await textOf('vr://inbox'), await textOf('lampo://inbox'));
  assert.match(await textOf(oldReviewUri(one)), /one\.mp4/);
  assert.equal(await textOf(oldReviewUri(one)), await textOf(reviewUri(one)));

  const updates: string[] = [];
  c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params.uri);
  });
  await c.subscribeResource({ uri: 'lampo://inbox' });
  store.addComment(two, { frame: 7, text: 'Titel länger stehen lassen', author: 'Mia' });
  await until('the inbox', () => updates.includes('lampo://inbox'));
  await sleep(300);
  assert.deepEqual(updates, ['lampo://inbox'], 'one notification, under the address it subscribed to');
});

test('the server stops following the store when its client goes away (stdin closes, the process exits)', async () => {
  const child = spawn(process.execPath, [MCP], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const lines: string[] = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'resources/subscribe', params: { uri: 'vr://inbox' } });
  await until('the subscription', () => lines.some((l) => JSON.parse(l).id === 2));
  child.stdin.end();
  const code = await Promise.race([exited, sleep(5000).then(() => 'still running')]);
  if (code === 'still running') child.kill();
  assert.equal(code, 0);
});
