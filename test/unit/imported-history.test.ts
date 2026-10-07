// covers: lib/store.ts lib/bundleImport.ts lib/foryou.ts
// Another store's history, brought in by `vr admin import` (docs/moving.md), never crowds out what happens here: the
// live log's readers take its last 2,000 or 5,000 events within 4 MB, and a big import used to fill that window, so a
// note made just before it never reached a waiting agent, INBOX.md or `vr inbox` (sweep 2 SW-1r). The imported history
// now has a file of its own, and a store an earlier version imported into (that history inside events.jsonl) reads the
// same: its readers pass those lines by before they count. What reads history (For you, a re-run of the import,
// `vr export`) still reads all of it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';
import { isolatedEnv, makeVideo, tmpdir, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test', VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { importBundle } = await import('../../lib/bundleImport.ts');
const { openTarWriter } = await import('../../lib/tar.ts');
const { dataDir, slugify } = await import('../../lib/paths.ts');
const { forYou } = await import('../../lib/foryou.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { startApp } = await import('../lib/app.ts');

const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const token = auth.createToken(owner.id, 'agent').token;

const work = tmpdir('vr-test-imported-history-');
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const live = path.join(dataDir(), 'events.jsonl');
const linesOf = (file: string): ReviewEvent[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// The video people work on here.
const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { w: 160, h: 90, dur: 1 });
const slug = slugify((await store.ingestUpload(clip, { name: 'spot.mp4', folder: 'Live', by: 'Olivia', byId: owner.id, keep: true })).review.video);
const app = await startApp({ headers: { Host: 'review.test' } });

// A moved video's history: a long one, each note a long text (2,100 events, about 5 MB: past the 2,000 a waiting agent
// reads and past the 4 MB every reader's tail holds), then a client's approval, the newest of it (For you lists it).
const MOVED = '/@uploads/Moved/old.mp4';
const BIG = 2100;
const historyOf = (n: number, video: string): Record<string, unknown>[] => [
  ...Array.from({ length: n }, (_, i) => ({
    at: iso(Date.now() - 3600_000 + i),
    type: 'comment',
    by: 'Olivia',
    video,
    slug: slugify(video),
    session: null,
    id: `c_${(i + 0x100000).toString(16)}`,
    v: 1,
    frame: 10,
    timecode: '00:00:00:10',
    text: `an old note ${i} ${'x'.repeat(2000)}`,
    severity: 'should',
    tags: [],
  })),
  {
    at: iso(Date.now() - 60_000),
    type: 'approval',
    by: 'guest:Mia',
    video,
    slug: slugify(video),
    session: null,
    v: 1,
    party: 'client',
    text: 'APPROVED v1 (client Mia)',
  },
];

/** A bundle as `vr export` lays one out: one video without its bytes, and `events` as its history. */
async function bundleWith(name: string, video: string, events: Record<string, unknown>[]): Promise<{ file: string; id: string }> {
  const review = {
    id: `r_${crypto.randomBytes(6).toString('hex')}`,
    video,
    source: { kind: 'upload', name: path.basename(video) },
    project: 'Moved',
    fps: 25,
    width: 320,
    height: 180,
    duration: 2,
    frames: 50,
    versions: [{ v: 1, hash: 'a'.repeat(40), mtime: iso(), size: 1000, frames: 50, fps: 25, width: 320, height: 180, duration: 2, registered: iso() }],
    comments: [],
    session: null,
    folder: 'Moved',
    added: iso(Date.now() - 30 * 86400_000),
    added_by: 'Olivia',
  };
  const entries = [
    { name: 'reviews/r0001/review.json', data: Buffer.from(JSON.stringify(review)) },
    { name: 'folders.json', data: Buffer.from(JSON.stringify({ folders: [] })) },
    { name: 'events.jsonl', data: Buffer.from(events.map((e) => `${JSON.stringify(e)}\n`).join('')) },
  ];
  const zero = { versions: 0, version_bytes: 0, notes: 0, replies: 0, drawings: 0, approvals: 0, files: 0, events: 0, folders: 0, playbooks: 0, views: 0 };
  const manifest = {
    format: 'lampo-bundle',
    version: 1,
    id: `b_${crypto.randomBytes(8).toString('hex')}`,
    created: iso(),
    app: { version: '0.1.0' },
    owner: { names: ['Olivia'] },
    people: [],
    counts: { reviews: 1, ...zero },
    files: entries.map((e) => ({ path: e.name, size: e.data.length, sha256: sha(e.data) })),
    taste: [],
    left_out: { missing_versions: [], samples: 0, drafts: 0, recordings: 0, links: 0, asks: 0, events: 0, missing_files: 0 },
  };
  const file = path.join(work, name);
  const tar = await openTarWriter(file);
  await tar.buffer('manifest.json', Buffer.from(JSON.stringify(manifest)));
  for (const e of entries) await tar.buffer(e.name, e.data);
  await tar.close();
  return { file, id: manifest.id };
}

/** wait_for_feedback since `since`, as an agent on this machine calls it: the notes' texts it hands out. */
async function waited(since: string): Promise<string[]> {
  const server = createReviewServer({ backend: createLocalBackend(), principal: { via: 'local', name: 'Olivia', id: owner.id, role: 'owner' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(a);
  try {
    const r = (await c.callTool({ name: 'wait_for_feedback', arguments: { since, timeout_s: 0, images: 'none' } })) as {
      structuredContent?: { events: { text?: string }[] };
      content: { text?: string }[];
    };
    assert.ok(r.structuredContent, r.content.map((x) => x.text).join('\n'));
    return r.structuredContent.events.map((e) => e.text ?? '');
  } finally {
    await c.close();
    await server.close();
  }
}

/** Every reader of the live log reaches `note`: a waiting agent, INBOX.md (and vr://inbox), `vr inbox`, GET /api/inbox. */
async function everyReaderHas(note: { id: string; text: string }, since: string): Promise<void> {
  store.writeInbox();
  const listed = vr(['inbox', '--json', '--limit', '50'], env);
  assert.equal(listed.code, 0, listed.err);
  // what a `vr` or an MCP server elsewhere reads (remote `vr inbox`, wait_for_feedback over HTTP)
  const remote = await app.request('GET', '/api/inbox?all=1&limit=5000', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(remote.status, 200, remote.text);
  const has = (evs: ReviewEvent[]) => evs.some((e) => e.id === note.id);
  assert.deepEqual(
    {
      wait_for_feedback: (await waited(since)).includes(note.text),
      'INBOX.md, vr://inbox': has(store.inboxEvents()),
      'INBOX.md written again': fs.readFileSync(store.inboxPath(), 'utf8').includes(note.id),
      'vr inbox': has(JSON.parse(listed.out)),
      'GET /api/inbox': has(remote.json().events),
    },
    { wait_for_feedback: true, 'INBOX.md, vr://inbox': true, 'INBOX.md written again': true, 'vr inbox': true, 'GET /api/inbox': true },
  );
}

test('a note made just before a 2,100-event import still reaches a waiting agent, INBOX.md and `vr inbox`', async () => {
  const since = iso(Date.now() - 1000);
  const note = store.addComment(slug, { frame: 3, text: 'REAL NOTE before the move', author: 'Olivia' });
  const logBefore = fs.readFileSync(live);
  const moved = await bundleWith('big.tar', MOVED, historyOf(BIG, MOVED));
  const r = await importBundle({ file: moved.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  assert.equal(r.events.append, BIG + 1);

  await everyReaderHas(note, since);
  assert.ok(!(await waited(since)).some((t) => t.startsWith('an old note')), 'and nothing of the history is news');

  // the history has a file of its own; the live log is as it was
  const imported = linesOf(path.join(dataDir(), 'events.imported.jsonl'));
  assert.equal(imported.length, BIG + 1);
  assert.ok(imported.every((e) => e.imported === moved.id && e.slug === slugify(MOVED)));
  assert.deepEqual(fs.readFileSync(live), logBefore, 'events.jsonl got none of it');

  // what reads history still reads it: For you lists the client's approval …
  const items = forYou({ key: owner.id, id: owner.id, name: 'Olivia', role: 'owner' }, { server: true }).items;
  assert.ok(
    items.some((i) => i.kind === 'approval' && i.slug === slugify(MOVED)),
    JSON.stringify(items.map((i) => i.kind)),
  );
  // … a run of the bundle that stopped and is carried on finds its history there, and a second run adds none …
  assert.ok(store.historyFrom(moved.id).has(slugify(MOVED)));
  const again = await importBundle({ file: moved.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  assert.deepEqual(again.events, { append: 0, there: 0 });
  assert.equal(linesOf(path.join(dataDir(), 'events.imported.jsonl')).length, BIG + 1);
  // … and an export of this store carries it on, with what happened here
  const out = vr(['export', path.join(work, 'again.tar'), '--json'], env);
  assert.equal(out.code, 0, out.err);
  assert.ok(JSON.parse(out.out).counts.events > BIG + 1, `the export holds ${JSON.parse(out.out).counts.events} events`);
});

test('a store an earlier version imported into (the history inside events.jsonl) reads the same, and is never rewritten', async () => {
  const since = iso(Date.now() - 1000);
  const note = store.addComment(slug, { frame: 5, text: 'REAL NOTE before an older import', author: 'Olivia' });
  // what appendHistory wrote before the history had its own file: every line in the live log, marked
  const OLD = 'b_0123456789abcdef';
  const video = '/@uploads/Moved/older.mp4';
  const older = await bundleWith('older.tar', video, []); // the review comes in, its history goes in by hand below
  await importBundle({ file: older.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  fs.appendFileSync(
    live,
    historyOf(BIG, video)
      .map((e) => `${JSON.stringify({ ...e, imported: OLD })}\n`)
      .join(''),
  );
  const logBefore = fs.readFileSync(live);

  await everyReaderHas(note, since);
  assert.ok(!(await waited(since)).some((t) => t.startsWith('an old note')), 'and nothing of that history is news');
  assert.deepEqual(fs.readFileSync(live), logBefore, 'events.jsonl is read, never rewritten');

  // history readers still read those lines: For you, and an import of that run carried on later
  const items = forYou({ key: owner.id, id: owner.id, name: 'Olivia', role: 'owner' }, { server: true }).items;
  assert.ok(items.some((i) => i.kind === 'approval' && i.slug === slugify(video)));
  assert.ok(store.historyFrom(OLD).has(slugify(video)));
});

test('a run killed after a video went in, before its history did: the next run writes that history, once', async () => {
  const video = '/@uploads/Moved/killed.mp4';
  const history = historyOf(5, video);
  const b = await bundleWith('killed.tar', video, history);
  const first = await importBundle({ file: b.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  assert.equal(first.events.append, history.length);
  // what a kill between the video's commit and the history's write leaves: the video, none of its history
  const file = path.join(dataDir(), 'events.imported.jsonl');
  const kept = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l && !l.includes(b.id));
  fs.writeFileSync(file, kept.map((l) => `${l}\n`).join(''));
  assert.equal(store.historyFrom(b.id).has(slugify(video)), false);
  const again = await importBundle({ file: b.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  assert.equal(again.reviews[0]?.action, 'skip', 'the video is not brought in twice');
  assert.equal(again.events.append, history.length, 'its history is');
  assert.equal(linesOf(file).filter((e) => e.imported === b.id).length, history.length);
  const third = await importBundle({ file: b.file, workspace: 'w1', owner: 'owner@example.com', derive: false });
  assert.equal(third.events.append, 0, 'and never twice');
});
