// A folder path made now is at most 12 levels and 400 characters (A12 OPT-3): one request naming thousands of levels
// once held the shared process for minutes while it made every ancestor. Every way a folder comes in — REST, MCP,
// `vr`, upload metadata, questions with options — refuses more, at once and as the caller's mistake (400). A store that
// holds a deeper folder from before still lists, opens, renames and deletes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { age, isolatedEnv, makeVideo, must, vr } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir, env } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const folders = await import('../../lib/folders.ts');
const store = await import('../../lib/store.ts');
const { slugify, dataDir } = await import('../../lib/paths.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');
const { listAsks } = await import('../../lib/asks.ts');

/** `n` levels of short names: "L0/L1/…". */
const levels = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join('/');
/** Six names of 60 and one of `last`: 7 levels, 400 characters with a last name of 34, 401 with one of 35. */
const long = (last: number) => [...Array(6).fill('x'.repeat(60)), 'y'.repeat(last)].join('/');
/** The request that held a process for minutes: 6000 levels in 12 KB. */
const DEEP = Array(6000).fill('a').join('/');
const enc = encodeURIComponent;

const clip = (name: string) => {
  const f = makeVideo(path.join(dir, `renders/${name}`), { dur: 0.4, w: 64, h: 36, audio: false });
  age(f);
  return f;
};
const film = clip('film.mp4');
const slug = slugify(store.createOrGetReview(film, { by: 'tester' }).review.video);

let server: http.Server;
let request: Request;
before(async () => {
  const ctx = createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] });
  server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // A fresh connection per request: a kept-alive one the server closes after the slow `vr` checks would reset.
  request = client((server.address() as AddressInfo).port, { Connection: 'close' });
  // The first request pays for warming up the app, not for what is measured below.
  await request('GET', '/api/folders');
});
after(() => server.close());

/** A request and how long it took. */
const timed = async (...args: Parameters<Request>) => {
  const t = performance.now();
  const r = await request(...args);
  return { r, ms: performance.now() - t };
};

test('normFolder: 12 levels and 400 characters, refused past either (a 400, never cut to fit)', () => {
  assert.equal(folders.normFolder(levels(12)), levels(12));
  const refused = (p: string, why: RegExp) =>
    assert.throws(
      () => folders.normFolder(p),
      (e: Error & { status?: number }) => e.status === 400 && why.test(e.message),
    );
  refused(levels(13), /12 levels/);
  refused(DEEP, /12 levels/);
  assert.equal(long(34).length, 400);
  assert.equal(folders.normFolder(long(34)), long(34));
  refused(long(35), /400 characters/);
  // What counts is the cleaned path: empty levels and spaces don't add up, a name is still cut at 60 as before.
  assert.equal(folders.normFolder(`${levels(12)}//  / `), levels(12));
  assert.equal(must(folders.normFolder('x'.repeat(80))).length, 60);
  // Naming a folder that may exist from before is not making one: no limits there.
  assert.equal(folders.folderName(levels(13)), levels(13));
});

test('uploads: a folder in tus or ticket metadata is held to the same limits', () => {
  assert.equal(store.uploadFolder(levels(12)), levels(12));
  assert.throws(
    () => store.uploadFolder(levels(13)),
    (e: Error & { status?: number }) => e.status === 400 && /12 levels/.test(e.message),
  );
  assert.equal(store.uploadFolder(long(34)), long(34));
  assert.throws(() => store.uploadFolder(long(35)), /400 characters/);
});

test('REST: 12 levels are made, 13 refused, 401 characters refused — and nothing half-made', async () => {
  assert.equal((await request('POST', '/api/folders', { body: { path: levels(12) } })).status, 200);
  assert.ok(folders.allFolders().includes(levels(12)));
  const thirteen = await request('POST', '/api/folders', { body: { path: `T/${levels(12)}` } });
  assert.equal(thirteen.status, 400, thirteen.text);
  assert.match(thirteen.json().error, /12 levels/);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'c'.repeat(401) } })).status, 400);
  assert.ok(!folders.allFolders().some((f) => f.startsWith('T')), 'no ancestor of the refused path was made');

  // Every other way a folder is named for a write.
  const deep = `M/${levels(12)}`;
  const answers = {
    rename: await request('PATCH', '/api/folders', { body: { from: levels(12), to: deep } }),
    move: await request('PUT', `/api/review/${enc(slug)}/folder`, { body: { folder: deep } }),
    ask: await request('POST', '/api/asks', { body: { folder: deep, text: 'Which?', options: [{ id: 'g', items: [{ id: 'a' }, { id: 'b' }] }] } }),
    ticket: await request('POST', '/api/uploads/tickets', { body: { filename: 'spot.mp4', folder: deep } }),
    long: await request('PUT', `/api/review/${enc(slug)}/folder`, { body: { folder: 'c'.repeat(401) } }),
  };
  for (const [what, r] of Object.entries(answers)) assert.equal(r.status, 400, `${what}: ${r.text}`);
  assert.equal(must(store.loadReview(slug)).folder, null, 'the video stays where it was');
  assert.ok(!folders.allFolders().some((f) => f.startsWith('M')), 'nothing of the refused paths was made');
  assert.equal(listAsks().length, 0, 'no question asked');
});

test('a rename never carries a subtree past the limits (moving trees under trees would build any depth)', async () => {
  const tree = `Tree/${levels(11)}`;
  assert.equal((await request('POST', '/api/folders', { body: { path: tree } })).status, 200);
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Host/A' } })).status, 200);
  const nested = await request('PATCH', '/api/folders', { body: { from: 'Tree', to: 'Host/A/Tree' } });
  assert.equal(nested.status, 400, nested.text);
  assert.match(nested.json().error, /12 levels/);
  assert.ok(folders.allFolders().includes(tree) && !folders.allFolders().some((f) => f.startsWith('Host/A/Tree')), 'nothing moved');
  const longer = await request('PATCH', '/api/folders', { body: { from: 'Tree', to: 'z'.repeat(60) } });
  assert.equal(longer.status, 200, 'the same depth under a longer name, still within 400 characters');
  const deleted = await request('DELETE', `/api/folders?path=${enc('z'.repeat(60))}`);
  assert.equal(deleted.status, 200);
});

test('a store with a deeper folder from before: it lists, opens, renames and deletes', async () => {
  const old = `Old/${levels(14)}`;
  const gone = `Gone/${levels(14)}`;
  const file = path.join(dataDir(), 'folders.json');
  const was = JSON.parse(fs.readFileSync(file, 'utf8')) as { folders: string[] };
  fs.writeFileSync(file, JSON.stringify({ folders: [...was.folders, old, gone] }));
  const kept = clip('kept.mp4');
  const keptSlug = slugify(store.createOrGetReview(kept, { by: 'tester' }).review.video);
  store.mutate(keptSlug, (r) => {
    r.folder = old;
  });

  const listed = await request('GET', '/api/folders');
  assert.equal(listed.status, 200);
  assert.ok(listed.json().folders.includes(old), 'listed');
  const library = await request('GET', '/api/library');
  assert.equal(library.status, 200);
  assert.equal(library.json().videos.find((v: { slug: string }) => v.slug === keptSlug)?.folder, old, 'its video listed in it');
  assert.equal((await request('GET', `/api/review/${enc(keptSlug)}`)).status, 200, 'its video opens');
  assert.equal((await request('GET', `/api/folders/download/info?folder=${enc(old)}`)).status, 200, 'it downloads');

  // Its top renamed: the tree keeps its depth (no deeper than it was), so the rename goes through.
  const top = await request('PATCH', '/api/folders', { body: { from: 'Old', to: 'Older' } });
  assert.equal(top.status, 200, top.text);
  const older = `Older${old.slice('Old'.length)}`;
  assert.equal(must(store.loadReview(keptSlug)).folder, older);
  const renamed = await request('PATCH', '/api/folders', { body: { from: older, to: 'Kept' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(must(store.loadReview(keptSlug)).folder, 'Kept', 'its video moved with it');
  assert.equal((await request('DELETE', `/api/folders?path=${enc(gone)}`)).status, 200, 'deleted');
  assert.ok(!folders.allFolders().includes(gone));
});

/** An MCP client on the local backend as `via`, with every right. */
async function mcp(via: 'token' | 'local') {
  const server = createReviewServer({ backend: createLocalBackend(), principal: { via, name: 'Olivia', id: 'u_000000000001', role: 'owner' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = performance.now();
    const r = (await c.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { error: !!r.isError, text: r.content.map((x) => x.text ?? '').join('\n'), ms: performance.now() - t };
  };
  const close = async () => {
    await c.close();
    await server.close();
  };
  return { call, close };
}

const two = [
  {
    id: 'g',
    items: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  },
];

test('MCP: move_video, ask_options and track_video refuse 13 levels, and make nothing', async () => {
  const token = await mcp('token');
  const local = await mcp('local');
  try {
    const deep = `N/${levels(12)}`;
    const answers = {
      move: await token.call('move_video', { video: slug, folder: deep }),
      ask: await token.call('ask_options', { folder: deep, text: 'Which?', groups: two }),
      track: await local.call('track_video', { path: clip('tracked.mp4'), folder: deep }),
    };
    for (const [what, r] of Object.entries(answers)) {
      assert.ok(r.error, `${what}: ${r.text}`);
      assert.match(r.text, /12 levels/, what);
    }
    assert.ok(!folders.allFolders().some((f) => f.startsWith('N')), 'no folder made');
    assert.equal(store.loadReview(slugify(path.join(dir, 'renders/tracked.mp4'))), null, 'the refused track tracks nothing');
  } finally {
    await token.close();
    await local.close();
  }
});

test('lampo: move, track and push refuse 13 levels before doing anything', () => {
  const deep = `V/${levels(12)}`;
  const pushed = clip('pushed.mp4');
  const tracked = clip('tracked-vr.mp4');
  for (const args of [
    ['move', slug, deep],
    ['track', tracked, '--folder', deep],
    ['push', pushed, '--folder', deep],
  ]) {
    const r = vr(args, env);
    assert.equal(r.code, 1, `vr ${args[0]}: ${r.out}${r.err}`);
    assert.match(r.err, /12 levels/, `vr ${args[0]}`);
  }
  assert.equal(store.loadReview(slugify(tracked)), null, 'nothing tracked');
  assert.ok(!store.listReviews().some((r) => r.source?.name === 'pushed.mp4'), 'nothing uploaded');
  assert.ok(!folders.allFolders().some((f) => f.startsWith('V')), 'no folder made');
});

test('createFolder at depth 12 stays fast in a store of 5,000 folders', () => {
  const file = path.join(dataDir(), 'folders.json');
  const many = Array.from({ length: 5000 }, (_, i) => `Big ${i % 50}/Part ${i}`);
  const ids = Object.fromEntries(many.slice(0, 2000).map((f, i) => [f, `f_${i.toString(16).padStart(12, '0')}`]));
  fs.writeFileSync(file, JSON.stringify({ folders: [...folders.loadFolders(), ...many], ids }));
  const name = Array.from({ length: 12 }, (_, i) => `Level ${i} of a deep tree`).join('/');
  const t = performance.now();
  assert.equal(folders.createFolder(name), name);
  const ms = performance.now() - t;
  assert.ok(ms < 1000, `createFolder took ${ms.toFixed(0)} ms`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { folders: string[]; ids: Record<string, string> };
  assert.equal(Object.keys(saved.ids).length, 2000, 'every id kept');
  assert.ok(saved.folders.includes(name) && saved.folders.includes('Level 0 of a deep tree'), 'the folder and its ancestors');
  assert.deepEqual(saved.folders, [...saved.folders].sort(new Intl.Collator('de').compare), 'kept in order');
});

// Last: before the fix each of these held this very process for minutes. The budgets catch that, not a busy runner's
// scheduling (a shared CI machine took 146–197 ms against a 100 ms budget).
test('6000 levels: a 400 in under 500 ms over REST, and a fast refusal over MCP', async () => {
  const { r, ms } = await timed('POST', '/api/folders', { body: { path: DEEP } });
  assert.equal(r.status, 400, r.text);
  assert.ok(ms < 500, `POST /api/folders took ${ms.toFixed(0)} ms`);
  const moved = await timed('PUT', `/api/review/${enc(slug)}/folder`, { body: { folder: DEEP } });
  assert.equal(moved.r.status, 400);
  assert.ok(moved.ms < 500, `PUT …/folder took ${moved.ms.toFixed(0)} ms`);

  const token = await mcp('token');
  const local = await mcp('local');
  try {
    for (const [c, name, args] of [
      [token, 'move_video', { video: slug, folder: DEEP }],
      [token, 'ask_options', { folder: DEEP, text: 'Which?', groups: two }],
      [local, 'track_video', { path: film, folder: DEEP }],
    ] as const) {
      const x = await c.call(name, args);
      assert.ok(x.error, `${name}: ${x.text}`);
      assert.ok(x.ms < 1000, `${name} took ${x.ms.toFixed(0)} ms`);
    }
  } finally {
    await token.close();
    await local.close();
  }
  assert.ok(!folders.allFolders().some((f) => f.startsWith('a')), 'nothing made');
  assert.equal(must(store.loadReview(slug)).folder, null);
});

test('the inputs cap a folder at the store limit, quietly', async () => {
  const { INPUT_LIMITS } = await import('../../lib/inputs.ts');
  assert.equal(INPUT_LIMITS.folder, store.FOLDER_LIMITS.length, 'lib/inputs.ts and lib/store.ts agree on a folder path');
});
