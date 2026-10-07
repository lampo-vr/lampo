// The data contract against a store the oldest code wrote (test/fixtures/store-v0/, made once with the code of
// 2026-09-28 and never edited). The app starts on a copy of it the way server/index.ts starts, the old shapes read
// right, and what agents parse (vr ls / open / prompt / inbox / watch, MCP get_open_notes, INBOX.md, review.md) is
// compared with committed text in test/unit/snapshots/contract/. VR_UPDATE_SNAPSHOTS=1 rewrites them: read the diff,
// a changed line is a changed contract. The fixture itself is only ever copied.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { settings } from '../../lib/env.ts';
import type { Comment, LibraryResponse, Review, ReviewEvent, ReviewResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, must, sleep, tmpdir, vr, vrAsync } from '../lib/helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/store-v0/', import.meta.url));
const SNAPSHOTS = fileURLToPath(new URL('./snapshots/contract/', import.meta.url));
const UPDATE = settings.LAMPO_UPDATE_SNAPSHOTS === '1';
const TEASER = '__@uploads__Demo__Reels__teaser.mp4';
const CUTDOWN = '__home__alex__work__demo__export__cutdown.mp4';

function files(root: string, rel = ''): string[] {
  return fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? files(root, path.join(rel, d.name)) : [path.join(rel, d.name)]))
    .sort();
}
const digest = (root: string) =>
  Object.fromEntries(
    files(root).map((f) => [
      f,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, f)))
        .digest('hex'),
    ]),
  );
const pristine = digest(FIXTURE);

const fixtureJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(FIXTURE, 'data', rel), 'utf8'));
const fixtureEvents: ReviewEvent[] = fs
  .readFileSync(path.join(FIXTURE, 'data/events.jsonl'), 'utf8')
  .trimEnd()
  .split('\n')
  .map((l) => JSON.parse(l));
// What a client holds: the link as it was made then, its token in clear (the key of shares.json).
const TOKEN = must(Object.keys(fixtureJson('shares.json').shares)[0], 'the old link');

/** A store copied from the fixture: data/ as it is, versions/ where VR_DATA puts them. */
function copyFixture(dir: string): void {
  fs.cpSync(path.join(FIXTURE, 'data'), path.join(dir, 'data'), { recursive: true });
  fs.cpSync(path.join(FIXTURE, 'versions'), path.join(dir, 'data-versions'), { recursive: true });
}

// The fixture was written in Berlin (+02:00); `vr` prints wall-clock times in the reader's zone.
const { dir, env } = isolatedEnv({ config: { user: 'alex' }, vars: { TZ: 'Europe/Berlin' } });
copyFixture(dir);

const store = await import('../../lib/store.ts');
const { secret } = await import('../../lib/auth.ts');
const shares = await import('../../lib/shares.ts');
const { DEFAULT_WORKSPACE, inWorkspace } = await import('../../lib/scope.ts');
const { stageForReview } = await import('../../lib/stageContext.ts');
const { quickHash } = await import('../../lib/probe.ts');
const { makeShots } = await import('../../lib/shots.ts');
const { reviewDir } = await import('../../lib/paths.ts');
const { WATCH_TYPES } = await import('../../lib/eventLine.ts');
const { isAgent } = await import('../../lib/time.ts');

/** `fn` on a fixed clock: what it writes carries this time instead of now. */
function at<T>(iso: string, fn: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

// The start, as server/index.ts does it on a person's machine: the keys, review-link tokens in clear moved to their
// hashed form, a linked render whose file is gone marked missing (the watcher's first sync; on a fixed clock, so
// review.md's "updated" line is the same every run), then the app.
secret();
shares.shareSecret();
const migrated = inWorkspace(DEFAULT_WORKSPACE, shares.migrateShareTokens);
const firstSync = at('2026-10-02T09:00:00+02:00', () => store.sync(CUTDOWN));
const app = await startApp({ loadSessions: async () => [] });
const remote = { 'x-forwarded-for': '203.0.113.9' };

function golden(name: string, text: string): void {
  // The throwaway store's folder is the only part of these outputs that differs between runs.
  const got = text.split(dir).join('<store>');
  const file = path.join(SNAPSHOTS, name);
  if (UPDATE || !fs.existsSync(file)) {
    if (!UPDATE && process.env.CI) throw new Error(`missing snapshot ${file}`);
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    fs.writeFileSync(file, got);
    return;
  }
  assert.equal(got, fs.readFileSync(file, 'utf8'), `${name} differs from its snapshot: agents parse this (VR_UPDATE_SNAPSHOTS=1 rewrites it)`);
}

function vrOut(args: string[]): string {
  const r = vr(args, env);
  assert.equal(r.code, 0, `vr ${args.join(' ')}: ${r.err}`);
  return r.out;
}

async function until(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(50)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

test('the app starts on the old store: reviews, notes, sign-off, versions and folders read as they were written', async () => {
  assert.equal(firstSync?.review.missing, true, "the linked render's file is gone: marked missing, nothing fails");
  const lib: LibraryResponse = (await app.request('GET', '/api/library')).json();
  const bySlug = Object.fromEntries(lib.videos.map((v) => [v.slug, v]));
  assert.deepEqual(Object.keys(bySlug).sort(), [TEASER, CUTDOWN].sort());
  assert.deepEqual(lib.folders, ['Demo', 'Demo/Cutdowns', 'Demo/Reels']);
  // The single `approval` of the old format is the verdict history's one entry: the client approved V2 of the
  // upload, the team asked for changes on the linked render.
  assert.equal(bySlug[TEASER]?.stage.stage, 'client_approved');
  assert.equal(bySlug[TEASER]?.stage.detail, 'Client approved V2 (Mia) · 3 notes still open');
  assert.equal(bySlug[CUTDOWN]?.stage.stage, 'changes');
  assert.equal(bySlug[CUTDOWN]?.missing, true);

  for (const slug of [TEASER, CUTDOWN]) {
    const old: Review = fixtureJson(`${slug}/review.json`);
    const r = await app.request('GET', `/api/review/${encodeURIComponent(slug)}`);
    assert.equal(r.status, 200, r.text);
    const got: ReviewResponse = r.json();
    const note = (c: Comment) => {
      const { id, v, frame, timecode, t, range, text, tags, severity, status, author, created, replies, drawing, voice, fixed_in_v } = c;
      return { id, v, frame, timecode, t, range, text, tags, severity, status, author, created, replies, drawing, voice, fixed_in_v };
    };
    assert.deepEqual(got.review.comments.map(note), old.comments.map(note), `${slug}: notes keep their ids, frames, text and threads`);
    assert.deepEqual(got.review.approval, old.approval, 'the legacy field stays as written');
    const a = must(old.approval);
    assert.deepEqual(got.approvals, [{ party: a.by.startsWith('guest:') ? 'client' : 'team', status: a.status, v: a.v, by: a.by, at: a.at, note: a.note }]);
    // Every version's bytes are where they were registered: the same hash, served from the store.
    for (const ver of old.versions) {
      const file = must(store.versionFile(got.review, ver.v), `${slug} v${ver.v}`);
      assert.equal(file, path.join(dir, 'data-versions', slug, `v${ver.v}.mp4`));
      assert.equal(quickHash(file), ver.hash);
      const media = must(got.media[ver.v], `media of v${ver.v}`);
      assert.equal(media.error, null);
      const head = await app.request('GET', must(media.url, 'a media url'), { headers: { range: 'bytes=0-15' } });
      assert.equal(head.status, 206, `v${ver.v} plays`);
      assert.equal(head.text, fs.readFileSync(file).subarray(0, 16).toString('utf8'));
    }
  }
  assert.equal(store.readEvents({ limit: 1000 }).length, fixtureEvents.length, 'every old event reads');
  // A store from before accounts: its owner is made at the first start, named like the notes, without the first run.
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'data/users.json'), 'utf8')).users;
  assert.deepEqual(
    users.map((u: { name: string; role: string; local?: boolean; prefs?: { onboarding?: unknown } }) => [u.name, u.role, u.local, u.prefs?.onboarding]),
    [['alex', 'owner', true, undefined]],
  );
  const teaser = fs.readFileSync(path.join(dir, 'data', TEASER, 'review.json'), 'utf8');
  assert.equal(teaser, fs.readFileSync(path.join(FIXTURE, 'data', TEASER, 'review.json'), 'utf8'), 'reading an old review never rewrites it');
});

test('the old review link still opens after its token moved to the hashed form', async () => {
  assert.equal(migrated, true, 'shares.json held its token in clear: rewritten at start');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'data/shares.json'), 'utf8')).shares;
  assert.deepEqual(Object.keys(file), [shares.tokenKey(TOKEN)], 'the token itself is no longer in the file');
  const entry = file[shares.tokenKey(TOKEN)];
  const old = fixtureJson('shares.json').shares[TOKEN];
  assert.deepEqual({ slug: entry.slug, label: entry.label, created: entry.created, by: entry.by }, old);
  assert.equal(entry.id, `s_${crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 10)}`, 'the id old client notes are found by');
  assert.match(entry.sealed, /^[\w-]+\.[\w-]+\.[\w-]+$/);

  const link = await app.request('GET', `/api/g/${TOKEN}`, { headers: remote });
  assert.equal(link.status, 200, link.text);
  assert.equal(link.json().label, 'Client review');
  assert.equal(link.json().kind, 'video');
  const [video] = link.json().videos;
  assert.equal(video.name, 'teaser.mp4');
  // Notes and verdicts from before links had ids are this link's: the only link that ever covered the video.
  assert.equal(video.approval?.status, 'approved');
  const review = await app.request('GET', `/api/g/${TOKEN}/review/${video.slug}`, { headers: remote });
  assert.equal(review.status, 200, review.text);
  const notes = review.json().notes;
  assert.deepEqual(
    notes.map((n: { id: string; author: string; text: string }) => [n.id, n.author, n.text]),
    [['c_260bfe', 'Mia', 'Can the music start a little later?']],
  );
  assert.equal((await app.request('GET', notes[0].marked, { headers: remote })).status, 200, "the client's own frame, from the old store");
  const poster = await app.request('GET', video.poster, { headers: remote });
  assert.equal(poster.status, 200, 'a poster made from the old version bytes');
  assert.match(String(poster.headers['content-type']), /^image\//);
});

test('vr on the old store: ls, open, prompt and inbox as agents read them', () => {
  golden('vr-ls.txt', vrOut(['ls']));
  golden('vr-open-teaser.txt', vrOut(['open', 'teaser.mp4']));
  golden('vr-open-teaser-all.txt', vrOut(['open', 'teaser.mp4', '--all']));
  golden('vr-open-cutdown.txt', vrOut(['open', 'cutdown.mp4']));
  golden('vr-prompt-teaser.txt', vrOut(['prompt', 'teaser.mp4']));
  golden('vr-prompt-cutdown.txt', vrOut(['prompt', 'cutdown.mp4']));
  golden('vr-inbox.txt', vrOut(['inbox']));
  // Read on load: the linked render's review.md, rewritten by the start's sync (missing file).
  golden('review-cutdown.md', fs.readFileSync(path.join(dir, 'data', CUTDOWN, 'review.md'), 'utf8'));
});

test('MCP get_open_notes on the old store', async () => {
  const c = new Client({ name: 'contract-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`)));
  try {
    for (const [name, video] of [
      ['mcp-get_open_notes-teaser.txt', 'teaser.mp4'],
      ['mcp-get_open_notes-cutdown.txt', 'cutdown.mp4'],
    ]) {
      const r = (await c.callTool({ name: 'get_open_notes', arguments: { video, images: 'none' } })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = r.content
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('\n');
      assert.ok(!r.isError, text);
      // "as of" is the moment of reading (the next call's `since`): the one part of the answer that is now.
      golden(name, text.replace(/^as of \S+$/m, 'as of <now>'));
    }
    // The default sends the marked frame of a drawn note: the old note's picture from the old store.
    const drawn = (await c.callTool({ name: 'get_open_notes', arguments: { video: 'teaser.mp4', all: true } })) as { content: { type: string }[] };
    assert.ok(
      drawn.content.some((x) => x.type === 'image'),
      'the marked frame of c_1d55b9',
    );
  } finally {
    await c.close();
  }
});

test('vr watch reads lines in the old format as a writer appends them', async () => {
  // A store of its own: the old writer's lines are appended to its log.
  const own = tmpdir();
  copyFixture(own);
  const watchEnv = { ...env, VR_DATA: path.join(own, 'data'), VR_CACHE: path.join(own, 'cache') };
  const log = path.join(own, 'data/events.jsonl');
  const block = fs.readFileSync(log);
  const expected = fixtureEvents.filter((e) => !isAgent(e.by) && WATCH_TYPES.includes(e.type)).length;
  const w = vrAsync(['watch', '--everyone'], watchEnv);
  let out = '';
  let err = '';
  w.stdout.on('data', (d) => {
    out += d;
  });
  w.stderr.on('data', (d) => {
    err += d;
  });
  const lines = () => out.split('\n').filter(Boolean);
  try {
    await until('the watch to start', () => err.includes('Ctrl-C to stop'));
    // The watch starts at the log's end, measured just after its banner: a block that lands before that is not new to
    // it, so the block goes in again until one shows (every block prints the same lines).
    for (let round = 0; lines().length < expected; round++) {
      assert.ok(round < 20, `vr watch printed ${lines().length} of ${expected} lines:\n${out}${err}`);
      fs.appendFileSync(log, block);
      await until('a block of lines', () => lines().length >= expected, 3000).catch(() => {});
    }
  } finally {
    w.kill();
  }
  golden('vr-watch.txt', `${lines().slice(0, expected).join('\n')}\n`);
});

test('one new note on the old store: INBOX.md and review.md as agents read them', async () => {
  const review = must(store.loadReview(TEASER));
  const ver = must(review.versions.at(-1));
  const id = 'c_c0ffee';
  // Frames grabbed from the old version's bytes, as the app does for every note.
  const shots = await makeShots({
    file: must(store.versionFile(review, ver.v)),
    frame: 16,
    meta: { ...review.meta, ...ver },
    drawing: [],
    dir: reviewDir(TEASER),
    id,
  });
  at('2026-10-02T09:30:00+02:00', () =>
    store.addComment(TEASER, {
      id,
      v: ver.v,
      frame: 16,
      text: 'Let the logo fade out two frames earlier',
      tags: ['logo'],
      severity: 'should',
      author: 'alex',
      shots,
    }),
  );
  golden('INBOX.md', fs.readFileSync(path.join(dir, 'data/INBOX.md'), 'utf8'));
  golden('review-teaser.md', fs.readFileSync(path.join(dir, 'data', TEASER, 'review.md'), 'utf8'));
  const after = must(store.loadReview(TEASER));
  assert.deepEqual(after.approval, fixtureJson(`${TEASER}/review.json`).approval, 'a note leaves the old sign-off as it was');
  assert.equal(stageForReview(after).stage, 'client_approved');
});

test('the fixture is byte for byte as committed: tests only ever work on a copy', () => {
  assert.deepEqual(digest(FIXTURE), pristine);
});
