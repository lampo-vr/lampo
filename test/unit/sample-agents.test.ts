// The first run's sample is a demo for the person, never work for an agent (sweep 3 ONB-5): agents' listings leave it
// out (`vr ls`, `vr folders`, MCP list_videos, list_folders and the vr://review resources), and asked for directly it
// says so first — a SAMPLE line on top, and no notes to work through (`vr open`, get_open_notes).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ config: { user: 'Sam Rivera' }, vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const { createSample } = await import('../../lib/sample.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');
const { slugify } = await import('../../lib/paths.ts');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

// a real video with an open note beside the sample
const film = makeVideo(path.join(dir, 'Acme', 'export', 'spot.mp4'), { w: 160, h: 90, dur: 1 });
age(film);
store.createOrGetReview(film, { by: 'Sam Rivera' });
store.addComment(slugify(film), { frame: 3, text: 'Logo smaller', severity: 'must', author: 'Sam Rivera' });
const sample = await createSample({ by: 'Sam Rivera', lang: 'en' });
const SAMPLE = /^SAMPLE: /m;

async function mcp<T>(fn: (c: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const server = createReviewServer({ backend: createLocalBackend(), principal: { via: 'local', name: 'Sam Rivera', role: 'owner' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(a);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}
const said = (r: unknown) => ((r as { content: { text?: string }[] }).content ?? []).map((x) => x.text ?? '').join('\n');

test('vr ls and vr folders: the real video, never the sample', () => {
  const ls = vr(['ls'], env);
  assert.equal(ls.code, 0, ls.err);
  assert.match(ls.out, /spot\.mp4/);
  assert.doesNotMatch(ls.out, /Lampo sample/, ls.out);
  const json = JSON.parse(vr(['ls', '--json'], env).out) as { video: string }[];
  assert.deepEqual(
    json.map((x) => path.basename(x.video)),
    ['spot.mp4'],
  );
  const folders = vr(['folders'], env);
  assert.doesNotMatch(folders.out, /\(1 video/, `no folder counts the sample: ${folders.out}`);
});

test('vr open on the sample, asked for by name: a SAMPLE line first, no notes to work through', () => {
  const r = vr(['open', 'Lampo sample'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, SAMPLE, r.out);
  assert.doesNotMatch(r.out, /title covers the car|Fade it out|c_[0-9a-f]{6}/, `no notes: ${r.out}`);
  assert.doesNotMatch(vr(['open', 'spot.mp4'], env).out, SAMPLE, 'a real video carries no such line');
});

test('MCP: list_videos, list_folders and the review resources leave it out; get_open_notes on it says SAMPLE, no notes', async () => {
  await mcp(async (c) => {
    const listed = said(await c.callTool({ name: 'list_videos', arguments: {} }));
    assert.match(listed, /spot\.mp4/);
    assert.doesNotMatch(listed, /Lampo sample/, listed);
    const tree = said(await c.callTool({ name: 'list_folders', arguments: {} }));
    assert.doesNotMatch(tree, /Sample {2}\(1 video/, tree);
    const resources = (await c.listResources()).resources.map((x) => x.name);
    assert.ok(!resources.some((n) => n.includes('Lampo sample')), `resources: ${resources}`);
    const notes = said(await c.callTool({ name: 'get_open_notes', arguments: { video: slugify(sample.video), images: 'none' } }));
    assert.match(notes, SAMPLE, notes);
    assert.doesNotMatch(notes, /title covers the car|Fade it out/, `no notes: ${notes}`);
    const work = said(await c.callTool({ name: 'get_open_notes', arguments: { video: 'spot.mp4', images: 'none' } }));
    assert.match(work, /Logo smaller/);
    assert.doesNotMatch(work, SAMPLE);
  });
});
