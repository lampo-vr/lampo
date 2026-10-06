// Drafts on the machine: a note saved as a draft reaches nobody until it is sent — not the agent (events.jsonl,
// INBOX.md, review.md, review.json, `vr`, MCP over HTTP, wait_for_feedback), not push or webhooks, not a review link,
// not the counts, the stage, the inbox, Insights, search or the playbook's suggestions. Sending makes ordinary notes in
// one batch: a waiting agent gets them in one answer, and with `start` the video's agent is started once.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Comment, ReviewEvent } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, sleep, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();

// The `claude` the app starts for a batch with `start`: a stand-in that writes down how it was called.
const stub = path.join(dir, 'bin', 'claude');
fs.mkdirSync(path.dirname(stub), { recursive: true });
fs.writeFileSync(
  stub,
  '#!/bin/sh\nd="$(dirname "$0")"\n[ "$1" = agents ] && { echo "[]"; exit 0; }\nprintf \'%s\\n\' "$@" > "$d/last.argv"\necho x >> "$d/calls"\n',
  {
    mode: 0o755,
  },
);
process.env.VR_CLAUDE_BIN = stub;
const calls = () =>
  fs.existsSync(path.join(dir, 'bin', 'calls'))
    ? fs
        .readFileSync(path.join(dir, 'bin', 'calls'), 'utf8')
        .trim()
        .split('\n').length
    : 0;

const store = await import('../../lib/store.ts');
const { slugify, reviewDir, DATA } = await import('../../lib/paths.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');

const project = path.join(dir, 'proj');
const video = makeVideo(path.join(project, 'export/spot.mp4'), { w: 320, h: 180, dur: 2 });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(path.resolve(video));
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
store.assignSession(slug, { name: 'spot-edit', sessionId: SESSION, cwd: project, agent: 'claude-code' }, 'tester');

// What push and webhooks are handed: every event the feed reads, as it reads them.
const handed: ReviewEvent[] = [];
const ctx = createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] });
for (const hook of [ctx.webhooks, ctx.push]) {
  const original = hook.handle.bind(hook);
  hook.handle = (e) => {
    handed.push(e);
    original(e);
  };
}

const { base } = await startApp({ ctx, feed: 50 });
let mcp: Client;
before(async () => {
  mcp = new Client({ name: 'drafts-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});
after(async () => {
  await mcp.close().catch(() => {});
});

const e = encodeURIComponent;
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}
async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await call(method, url, body);
  assert.ok(r.status < 300, `${method} ${url}: ${r.status} ${r.text}`);
  return JSON.parse(r.text) as T;
}
type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const tool = async (name: string, args: Record<string, unknown> = {}) => (await mcp.callTool({ name, arguments: args })) as Result;
const textOf = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
const readIf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const BOX = [{ type: 'box', x: 20, y: 20, w: 80, h: 50 }];

let drafts: Comment[] = [];

test('saved as drafts: two notes, and nothing anyone else reads — agent, push, webhooks, a review link — knows of them', async () => {
  const eventsBefore = readIf(store.EVENTS_FILE);
  // An agent already waiting for feedback on the video: drafts don't wake it.
  const waiting = tool('wait_for_feedback', { video: 'spot.mp4', timeout_s: 3 });
  await sleep(300);
  const a = await api<Comment>('POST', `/api/review/${e(slug)}/drafts`, { v: 1, frame: 12, text: 'draftmark-alpha logo lands early', drawing: BOX });
  const b = await api<Comment>('POST', `/api/review/${e(slug)}/drafts`, {
    v: 1,
    scope: 'video',
    text: 'draftmark-beta music too loud',
    refs: [{ kind: 'link', url: 'https://example.com/look' }],
  });
  assert.equal(a.draft, true);
  assert.match(a.id, /^c_[0-9a-f]{6}$/);
  assert.ok(a.shots && fs.existsSync(path.join(reviewDir(slug), 'drafts', a.shots.marked)), 'its screenshots wait in the drafts folder');
  assert.ok(!fs.existsSync(path.join(reviewDir(slug), `${a.id}_marked.png`)), 'not beside the review');
  assert.equal(b.scope, 'video');
  assert.equal(b.refs?.[0]?.kind, 'link');
  drafts = (await api<{ drafts: Comment[] }>('GET', `/api/review/${e(slug)}/drafts`)).drafts;
  assert.deepEqual(
    drafts.map((d) => d.id),
    [a.id, b.id],
    'in the order they were saved',
  );
  assert.match(textOf(await waiting), /No new feedback in 3 s/, 'a waiting agent hears nothing');

  // The files agents read, and the event log everything else (push, webhooks, vr watch, the inbox) follows.
  assert.equal(readIf(store.EVENTS_FILE), eventsBefore, 'not a single event');
  for (const f of [path.join(reviewDir(slug), 'review.json'), path.join(reviewDir(slug), 'review.md'), store.INBOX_FILE])
    assert.doesNotMatch(readIf(f), /draftmark/, path.basename(f));

  // Every answer of the app: the review, the library, the inbox, Insights, search, taste, the playbook.
  const reads = [
    `/api/review/${e(slug)}`,
    '/api/reviews',
    '/api/library',
    '/api/status',
    '/api/for-you',
    '/api/inbox?all=1',
    '/api/inbox.md',
    `/api/review/${e(slug)}/md`,
    `/api/review/${e(slug)}/prompt`,
    '/api/insights?period=30d',
    `/api/taste?video=${e(slug)}`,
    '/api/playbook',
    `/api/comments/${a.id}`,
  ];
  for (const url of reads) assert.doesNotMatch((await call('GET', url)).text, /draftmark/, url);
  assert.deepEqual(JSON.parse((await call('GET', '/api/search?q=draftmark')).text).notes, [], 'search finds no note');
  assert.equal((await call('GET', `/api/comments/${a.id}`)).status, 404, 'a draft is no note by its id');
  const lib = await api<{ videos: { slug: string; counts: { open: number; total: number }; stage: { stage: string } }[] }>('GET', '/api/library');
  const row = lib.videos.find((v) => v.slug === slug);
  assert.equal(row?.counts.open, 0, 'no open notes yet');
  assert.equal(row?.stage.stage, 'to_review', 'the stage stays where it was');

  // The agent's own tools (MCP over HTTP, the local `vr`).
  for (const [name, args] of [
    ['get_open_notes', { video: 'spot.mp4' }],
    ['list_videos', {}],
  ] as const)
    assert.doesNotMatch(textOf(await tool(name, args)), /draftmark/, name);
  const note = await tool('get_note', { id: a.id });
  assert.ok(note.isError, 'get_note does not know a draft');
  const inbox = await mcp.readResource({ uri: 'vr://inbox' });
  assert.doesNotMatch(JSON.stringify(inbox), /draftmark/);
  for (const args of [['open', 'spot.mp4'], ['inbox'], ['prompt', 'spot.mp4'], ['ls', '--json'], ['open', 'spot.mp4', '--brief']]) {
    const r = vr(args, env);
    assert.doesNotMatch(r.out + r.err, /draftmark/, `vr ${args.join(' ')}`);
  }
  assert.notEqual(vr(['show', a.id], env).code, 0, 'vr show does not know a draft');

  // A review link of the video.
  const share = await api<{ token: string }>('POST', `/api/review/${e(slug)}/shares`, {});
  const outside = { 'x-forwarded-for': '203.0.113.7' };
  const room = await call('GET', `/api/g/${share.token}`, undefined, outside);
  const id = JSON.parse(room.text).videos[0].slug;
  for (const url of [`/api/g/${share.token}`, `/api/g/${share.token}/review/${id}`])
    assert.doesNotMatch((await call('GET', url, undefined, outside)).text, /draftmark/, url);

  await sleep(300);
  assert.ok(!handed.some((x) => JSON.stringify(x).includes('draftmark')), 'push and webhooks were handed nothing');
});

test('editing in place and deleting stay as quiet: the draft changes, no event, its files go with it', async () => {
  const eventsBefore = readIf(store.EVENTS_FILE);
  const extra = await api<Comment>('POST', `/api/review/${e(slug)}/drafts`, { v: 1, frame: 30, text: 'draftmark-gamma', drawing: BOX });
  const edited = await api<Comment>('PATCH', `/api/review/${e(slug)}/drafts/${extra.id}`, {
    text: 'draftmark-gamma, darker',
    severity: 'must',
    tags: ['color'],
  });
  assert.equal(edited.text, 'draftmark-gamma, darker');
  assert.equal(edited.severity, 'must');
  assert.deepEqual(edited.tags, ['color']);
  const marked = path.join(reviewDir(slug), 'drafts', extra.shots?.marked || '');
  assert.equal((await call('GET', `/api/review/${e(slug)}/drafts/${extra.id}/${extra.shots?.marked}`)).status, 200, 'its author sees its frame');
  await api('DELETE', `/api/review/${e(slug)}/drafts/${extra.id}`);
  assert.ok(!fs.existsSync(marked), 'its screenshots went with it');
  assert.equal((await call('PATCH', `/api/review/${e(slug)}/drafts/${extra.id}`, { text: 'x' })).status, 404);
  assert.equal(readIf(store.EVENTS_FILE), eventsBefore, 'still no event');
});

test('Send all: one batch — the waiting agent gets both notes in one answer, and from then on everyone sees them', async () => {
  // a cursor taken first: however slow the machine, the wait can't start after the send and miss it
  const since = /cursor: (\S+)/.exec(textOf(await tool('wait_for_feedback', { video: 'spot.mp4', timeout_s: 0 })))?.[1];
  const waiting = tool('wait_for_feedback', { video: 'spot.mp4', since, timeout_s: 20 });
  const sent = await api<{ notes: Comment[] }>('POST', `/api/review/${e(slug)}/drafts/send`, {});
  assert.deepEqual(
    sent.notes.map((c) => c.id),
    drafts.map((d) => d.id),
    'the same ids, in the order they were saved',
  );
  assert.ok(sent.notes.every((c) => !c.draft && c.status === 'open'));
  const got = textOf(await waiting);
  assert.match(got, /^2 new:\n/, got);
  for (const d of drafts) assert.match(got, new RegExp(`NEW .* ${d.id} `));
  assert.ok(got.indexOf('draftmark-alpha') < got.indexOf('draftmark-beta'), 'in order');

  assert.deepEqual((await api<{ drafts: Comment[] }>('GET', `/api/review/${e(slug)}/drafts`)).drafts, [], 'nothing left to send');
  const [first] = sent.notes;
  assert.ok(first.shots && fs.existsSync(path.join(reviewDir(slug), first.shots.marked)), 'its screenshots moved beside the review');
  assert.ok(!fs.existsSync(path.join(reviewDir(slug), 'drafts', first.shots.marked)), 'and left the drafts folder');
  assert.equal(sent.notes[1].refs?.[0]?.url, 'https://example.com/look', 'references come along');
  const review = store.loadReview(slug);
  assert.deepEqual(
    review?.comments.map((c) => c.id),
    drafts.map((d) => d.id),
  );
  const comments = store
    .readEvents()
    .filter((x) => x.type === 'comment')
    .map((x) => x.id);
  assert.deepEqual(comments.slice(-2), [drafts[0].id, drafts[1].id], 'two comment events, in order');
  assert.match(readIf(store.INBOX_FILE), /draftmark-alpha/, 'INBOX.md has them now');
  await sleep(300);
  assert.deepEqual(
    [...new Set(handed.filter((x) => x.type === 'comment').map((x) => x.id))],
    drafts.map((d) => d.id),
    'push and webhooks get the two notes',
  );
  const lib = await api<{ videos: { slug: string; counts: { open: number }; stage: { stage: string } }[] }>('GET', '/api/library');
  assert.equal(lib.videos.find((v) => v.slug === slug)?.counts.open, 2, 'both count as open notes now');
  const unsent = await api<{ videos: Record<string, number> }>('GET', '/api/drafts');
  assert.deepEqual(unsent.videos, {}, 'nothing waits to be sent');
});

test('with start, the video’s agent is started once for the whole batch', async () => {
  for (const text of ['draftmark-delta one', 'draftmark-delta two', 'draftmark-delta three'])
    await api('POST', `/api/review/${e(slug)}/drafts`, { v: 1, frame: 3, text });
  assert.deepEqual(await api<{ videos: Record<string, number> }>('GET', '/api/drafts'), { videos: { [slug]: 3 } }, 'the library says 3 not sent');
  const before = calls();
  const sent = await api<{ notes: Comment[]; run: { id: string } | null }>('POST', `/api/review/${e(slug)}/drafts/send`, { start: true });
  assert.equal(sent.notes.length, 3);
  assert.ok(sent.run?.id, 'a run was started');
  for (let i = 0; i < 100 && calls() === before; i++) await sleep(50);
  await sleep(300);
  assert.equal(calls() - before, 1, 'once, not once per note');
  const argv = fs.readFileSync(path.join(dir, 'bin', 'last.argv'), 'utf8');
  assert.match(argv, /3 new notes: c_[0-9a-f]{6}, c_[0-9a-f]{6}, c_[0-9a-f]{6}/);
});

test('a draft written on V1 is sent onto V1 and carried to V2 when V2 arrived meanwhile', async () => {
  const d = await api<Comment>('POST', `/api/review/${e(slug)}/drafts`, { v: 1, frame: 10, text: 'draftmark-epsilon' });
  assert.equal(d.check_again, undefined);
  makeVideo(video, { w: 320, h: 180, dur: 2, pattern: 'smptebars' });
  age(video);
  await api('POST', `/api/review/${e(slug)}/sync`);
  assert.equal(store.loadReview(slug)?.versions.length, 2);
  const [c] = (await api<{ notes: Comment[] }>('POST', `/api/review/${e(slug)}/drafts/send`, {})).notes;
  assert.equal(c.v, 1);
  assert.equal(c.check_again, true);
  assert.equal(c.carried_to, 2);
});

test('one send is one write to the event log, however many notes it holds', async () => {
  const drafts = await import('../../lib/drafts.ts');
  const { ensureLocalOwner } = await import('../../lib/auth.ts');
  const owner = ensureLocalOwner('tester').id;
  for (const text of ['draftmark-eta one', 'draftmark-eta two', 'draftmark-eta three'])
    drafts.addDraft(slug, owner, { v: 2, frame: 6, text, author: 'tester' });
  const writes: string[] = [];
  const append = fs.appendFileSync;
  fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, o?: fs.WriteFileOptions) => {
    if (file === store.EVENTS_FILE) writes.push(String(data));
    return append(file, data, o);
  }) as typeof fs.appendFileSync;
  try {
    assert.equal(drafts.sendDrafts(slug, owner).length, 3);
  } finally {
    fs.appendFileSync = append;
  }
  assert.equal(writes.length, 1, 'one append');
  assert.equal(writes[0].trim().split('\n').length, 3, 'with the three comment events');
});

test('a picture on a draft: inline or through a one-time upload URL, served to its author, kept when it is sent', async () => {
  const png = path.join(dir, 'ref.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', '-y', png]);
  const d = await api<Comment>('POST', `/api/review/${e(slug)}/drafts`, { v: 2, frame: 8, text: 'draftmark-theta like this' });
  const inline = await api<{ ref: { id: string; still: string } }>('POST', `/api/review/${e(slug)}/drafts/${d.id}/refs`, {
    kind: 'image',
    data: fs.readFileSync(png).toString('base64'),
  });
  const { upload } = await api<{ upload: { url: string } }>('POST', `/api/review/${e(slug)}/drafts/${d.id}/refs`, { kind: 'file', caption: 'two' });
  const put = await fetch(new URL(new URL(upload.url, base).pathname, base), { method: 'PUT', body: fs.readFileSync(png) });
  assert.equal(put.status, 200, await put.text());
  const [kept] = (await api<{ drafts: Comment[] }>('GET', `/api/review/${e(slug)}/drafts`)).drafts.filter((x) => x.id === d.id);
  assert.equal(kept.refs?.length, 2, 'both on the draft');
  assert.equal((await call('GET', `/api/refs/${e(slug)}/${inline.ref.still}`)).status, 200, 'its author sees the picture');
  assert.ok(!store.readEvents().some((x) => x.type === 'ref' && x.id === d.id), 'no ref event for a draft');
  const [sent] = (await api<{ notes: Comment[] }>('POST', `/api/review/${e(slug)}/drafts/send`, {})).notes;
  assert.equal(sent.refs?.length, 2);
  assert.equal((await call('GET', `/api/refs/${e(slug)}/${inline.ref.still}`)).status, 200, 'and the note keeps it');
});

test('a draft whose id another note took meanwhile is sent under a new one, with its files', async () => {
  const drafts = await import('../../lib/drafts.ts');
  const { ensureLocalOwner } = await import('../../lib/auth.ts');
  const owner = ensureLocalOwner('tester').id;
  const taken = store.loadReview(slug)?.comments[0].id as string;
  fs.mkdirSync(drafts.draftsDir(slug), { recursive: true });
  fs.writeFileSync(path.join(drafts.draftsDir(slug), `${taken}.m4a`), 'audio');
  drafts.addDraft(slug, owner, { id: taken, v: 2, frame: 4, text: 'draftmark-zeta', author: 'tester', voice: { file: `${taken}.m4a`, transcript: null } });
  const [c] = drafts.sendDrafts(slug, owner);
  assert.notEqual(c.id, taken);
  assert.equal(c.voice?.file, `${c.id}.m4a`);
  assert.ok(fs.existsSync(path.join(reviewDir(slug), `${c.id}.m4a`)));
  assert.equal(store.loadReview(slug)?.comments.filter((x) => x.id === taken).length, 1, 'the other note is untouched');
  assert.ok(fs.existsSync(path.join(DATA, slug, 'review.json')));
});
