// Moving a machine's store to a server (docs/moving.md): `vr export` on a synthetic local store (test/lib/bundleSource.ts,
// run as a process of its own), `vr admin import` into this process's hosted store while its server runs. The round trip
// keeps notes, replies, statuses, drawings, ranges, sign-off, history, version bytes and what Insights reads; every
// path-based video id becomes an upload's, everywhere it is named; no path of the machine arrives; people map to
// accounts by id, agents keep their names; history wakes nobody; a second run, a clash, a dry run and hostile bundles
// do what they say; another workspace never sees any of it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import type { BundleManifest } from '../../lib/bundle.ts';
import type { ImportReport } from '../../lib/bundleImport.ts';
import type { Review, ReviewEvent } from '../../lib/types.ts';
import { isolatedEnv, must, ROOT, tmpdir, until, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test' } });

// ------------------------------------------------------------------------------------------------ the machine
const src = tmpdir('vr-test-move-src-');
fs.writeFileSync(path.join(src, 'config.json'), '{}');
const machine: NodeJS.ProcessEnv = {
  ...env,
  VR_DATA: path.join(src, 'data'),
  VR_CACHE: path.join(src, 'cache'),
  VR_CONFIG: path.join(src, 'config.json'),
  XDG_CONFIG_HOME: path.join(src, 'xdg-config'),
  XDG_CACHE_HOME: path.join(src, 'xdg-cache'),
};
delete machine.VR_MODE;
delete machine.VR_PUBLIC_URL;
execFileSync(process.execPath, [path.join(ROOT, 'test/lib/bundleSource.ts'), path.join(src, 'facts.json')], { env: machine, stdio: 'pipe' });
const facts = JSON.parse(fs.readFileSync(path.join(src, 'facts.json'), 'utf8')) as {
  home: string;
  owner: string;
  slugs: { a: string; b: string; c: string; u: string };
  notes: { drawn: string; ranged: string; overall: string; question: string; client: string };
  preview: string;
};
const bundle = path.join(src, 'bundle.tar');
const exported = vr(['export', bundle, '--json'], machine);
assert.equal(exported.code, 0, exported.err);
const manifest = JSON.parse(exported.out) as BundleManifest & { warnings: string[] };
const sourceReview = (slug: string): Review => JSON.parse(fs.readFileSync(path.join(src, 'data', slug, 'review.json'), 'utf8'));
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** The machine's own paths, as they would appear anywhere: a path, or a path-based video id. */
const machineMarks = [src, src.split('/').filter(Boolean).join('__')];

// ------------------------------------------------------------------------------------------------ the server
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const store = await import('../../lib/store.ts');
const { storage } = await import('../../lib/storage/index.ts');
const { inWorkspace, DATA, VERSIONS, CACHE, workspaceRoot } = await import('../../lib/paths.ts');
const { readTar, openTarWriter } = await import('../../lib/tar.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { startApp } = await import('../lib/app.ts');

const PASSWORD = 'a long password';
const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita R.', password: PASSWORD, role: 'member' });
const w2 = ws.createWorkspace({ name: 'Moved in', ownerId: owner.id }).id;
ws.addMember(w2, rita.id, 'member');

// The running server, its feed following every workspace's log: what it hands the live stream, webhooks and push.
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const told: { to: string; e: ReviewEvent }[] = [];
const broadcast = ctx.broadcast;
ctx.broadcast = (type, data) => {
  if (type === 'event') told.push({ to: 'stream', e: data as ReviewEvent });
  return broadcast(type, data);
};
const hook = ctx.webhooks.handle.bind(ctx.webhooks);
ctx.webhooks.handle = (e: ReviewEvent) => {
  told.push({ to: 'webhook', e });
  return hook(e);
};
const push = ctx.push.handle.bind(ctx.push);
ctx.push.handle = (e: ReviewEvent) => {
  told.push({ to: 'push', e });
  return push(e);
};
const app = await startApp({ ctx, feed: 50, headers: { Host: 'review.test', Origin: 'https://review.test' } });
const tokenIn = (w: string) => auth.createToken(owner.id, `in ${w}`, { workspace: w }).token;
const get = async (url: string, w: string) => {
  const r = await app.request('GET', url, { headers: { Authorization: `Bearer ${tokenIn(w)}` } });
  assert.equal(r.status, 200, `${url}: ${r.text}`);
  return r.json();
};

const admin = (args: string[]) => vr(['admin', ...args], env);
const importInto = (w: string, ...more: string[]) => admin(['import', bundle, '--workspace', w, '--owner', 'owner@example.com', '--json', ...more]);
const report = (r: { code: number; out: string; err: string }): ImportReport => {
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
/** Every file under the store's folders, with its size: what a run left behind. */
const listing = (): string[] => {
  const out: string[] = [];
  for (const root of [DATA, VERSIONS, CACHE]) {
    const walk = (d: string) => {
      let names: fs.Dirent[] = [];
      try {
        names = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (!/\/(\.inbox|\.lock|outbox|\.auth)\b/.test(p)) out.push(`${p} ${fs.statSync(p).size}`);
      }
    };
    walk(root);
  }
  return out.sort();
};
const dirOf = (slug: string, w: string): string => path.join(workspaceRoot(w).data, slug);
const linesOf = (file: string): ReviewEvent[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
/** A workspace's imported history: a file of its own beside the live log (store.appendHistory). */
const eventsOf = (w: string): ReviewEvent[] => linesOf(path.join(workspaceRoot(w).data, 'events.imported.jsonl'));

// The new ids: the two renders called clip.mp4 in one folder stay two videos (the second takes `~2/`).
const A = '__@uploads__Client A__Reels__~2__clip.mp4';
const B = '__@uploads__Client A__Reels__clip.mp4';
const C = '__@uploads__loose.mov';
const U = '__@uploads__Client A__teaser.mp4';

test('export: the bundle carries the reviews and the history, and leaves the machine behind', async () => {
  const c = manifest.counts;
  assert.deepEqual([c.reviews, c.versions, c.notes, c.replies, c.drawings, c.folders, c.playbooks, c.views], [4, 5, 7, 5, 3, 3, 1, 1]);
  assert.ok(c.events > 20, `${c.events} events`);
  assert.deepEqual(manifest.owner.names, ['Tester', 'tester'], 'the machine owner and the names it wrote under');
  assert.deepEqual(manifest.people, [], 'no other account');
  // the review link, the draft and the link's download stay here
  assert.equal(manifest.left_out.links, 1);
  assert.equal(manifest.left_out.drafts, 1);
  assert.ok(manifest.left_out.events >= 1);
  // no path of the machine, no path-based id, no key of it anywhere in the archive
  let text = '';
  await readTar(bundle, { entries: 1000, maxSize: () => 1e9 }, async (e, chunks) => {
    for await (const ch of chunks) if (/\.(json|jsonl)$/.test(e.name)) text += ch.toString('utf8');
  });
  for (const m of machineMarks) assert.ok(!text.includes(m), `the bundle names ${m}`);
  assert.ok(!text.includes('sess-123'), "a Claude Code session's id stays");
  assert.ok(!/"share":/.test(text), 'review links travel nowhere, not even as ids');
  assert.ok(text.includes('rendered to clip.mp4'), 'a path in a reply became its file name');
  assert.ok(!fs.existsSync(path.join(src, 'data', A)), 'the machine store holds nothing new');
});

test('export --folder: those folders and what is inside them, the playbooks above, their history only', async () => {
  const part = path.join(src, 'part.tar');
  const r = vr(['export', part, '--folder', 'Client A/Reels', '--folder', 'Client A/Empty', '--json'], machine);
  assert.equal(r.code, 0, r.err);
  const m = JSON.parse(r.out) as BundleManifest;
  assert.equal(m.counts.reviews, 2);
  const files = await entriesOf(part);
  const json = (n: string) => JSON.parse(must(files.find((f) => f.name === n)).data.toString());
  assert.deepEqual(json('folders.json').folders, ['Client A', 'Client A/Empty', 'Client A/Reels']);
  assert.deepEqual(
    files
      .filter((f) => f.name.endsWith('/review.json'))
      .map((f) => JSON.parse(f.data.toString()).video)
      .sort(),
    ['/@uploads/Client A/Reels/clip.mp4', '/@uploads/Client A/Reels/~2/clip.mp4'],
  );
  assert.equal(json('playbooks/p001/playbook.json').scope, 'Client A', "the parent's playbook, which the folder inherits");
  const slugs = new Set(
    must(files.find((f) => f.name === 'events.jsonl'))
      .data.toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).slug),
  );
  assert.deepEqual([...slugs].sort(), [B, A].sort());
  const none = vr(['export', path.join(src, 'none.tar'), '--folder', 'Nope'], machine);
  assert.equal(none.code, 1);
  assert.match(none.err, /there is no folder "Nope"/);
  assert.equal(fs.existsSync(path.join(src, 'none.tar')), false);
});

test('a dry run says what would happen, and writes nothing', () => {
  const before = listing();
  const r = report(importInto(w2, '--dry-run', '--people', 'Rita=rita@example.com'));
  assert.equal(r.dry_run, true);
  assert.deepEqual(
    r.reviews.map((x) => [x.slug, x.action]),
    [U, C, B, A].map((s) => [s, 'import']),
  );
  const said = Object.fromEntries(r.people.map((p) => [p.name, p.to]));
  assert.match(said.tester, /→ Olivia <owner@example.com> \(the owner\)/);
  assert.match(said.Rita, /→ Rita R\. <rita@example.com>/);
  assert.equal(said['agent:cutter'], 'stays an agent');
  assert.match(said['guest:Mia'], /stays a client/);
  assert.equal(r.events.append, manifest.counts.events);
  assert.deepEqual(listing(), before, 'not a file written');
  assert.equal(fs.existsSync(path.join(workspaceRoot(w2).data, 'events.jsonl')), false);
});

// A follower of w2's log as `vr watch` and the stdio MCP server run it, from before the import.
const watched: ReviewEvent[] = [];
const stopWatch = new AbortController();
// a follower left running would keep the file's process alive after a failed check
after(() => stopWatch.abort());
void inWorkspace(w2, () => createLocalBackend().watch((e) => watched.push(e), { signal: stopWatch.signal }));

test('the import, while the server runs: notes, replies, statuses, drawings, ranges, sign-off, history and bytes', async () => {
  const r = report(importInto(w2, '--people', 'Rita=rita@example.com'));
  assert.deepEqual(
    r.reviews.map((x) => x.action),
    ['import', 'import', 'import', 'import'],
  );
  const here = inWorkspace(w2, () => store.listReviews());
  assert.deepEqual(here.map((x) => store.isUpload(x) && x.source?.name).sort(), ['clip.mp4', 'clip.mp4', 'loose.mov', 'teaser.mp4']);
  const got = must(inWorkspace(w2, () => store.loadReview(A)));
  const was = sourceReview(facts.slugs.a);
  assert.equal(got.video, '/@uploads/Client A/Reels/~2/clip.mp4');
  assert.equal(got.folder, 'Client A/Reels');
  assert.equal(got.project, 'Client A/Reels');
  assert.deepEqual(got.source, { kind: 'upload', name: 'clip.mp4' });
  // the notes as they were: ids, frames, ranges, drawings, statuses, replies' words and statuses
  for (const c of was.comments) {
    const n = must(got.comments.find((x) => x.id === c.id));
    assert.deepEqual(
      [n.v, n.frame, n.timecode, n.range, n.drawing, n.status, n.severity, n.kind, n.scope],
      [c.v, c.frame, c.timecode, c.range, c.drawing, c.status, c.severity, c.kind, c.scope],
    );
    assert.deepEqual(
      n.replies.map((x) => [x.status, x.text, x.at]),
      c.replies.map((x) => [x.status, x.text.replace(/\S*\/export\/clip\.mp4/, 'clip.mp4'), x.at]),
    );
    assert.equal(n.created, c.created);
  }
  const drawn = must(got.comments.find((x) => x.id === facts.notes.drawn));
  assert.equal(drawn.drawing.length, 3);
  assert.deepEqual(must(got.comments.find((x) => x.id === facts.notes.ranged)).range, { in: 20, out: 30 });
  // sign-off, as it happened
  assert.deepEqual(
    got.approvals?.map((x) => [x.party, x.status, x.v, x.note]),
    was.approvals?.map((x) => [x.party, x.status, x.v, x.note]),
  );
  assert.deepEqual(got.final?.v, 2);
  assert.deepEqual(
    got.finals?.map((x) => x.action),
    ['final'],
  );
  // the versions: their records, and their bytes in this workspace's storage
  assert.deepEqual(
    got.versions.map((v) => [v.v, v.hash, v.sample, v.frames, v.mtime, v.registered]),
    was.versions.map((v) => [v.v, v.hash, v.sample, v.frames, v.mtime, v.registered]),
  );
  assert.equal(got.versions[1]?.source?.project, 'spot.aep', 'a render source names its project, not where it lies');
  for (const v of got.versions) {
    const here2 = must(inWorkspace(w2, () => store.versionFile(got, v.v)));
    assert.equal(sha(here2), sha(path.join(src, 'data-versions', facts.slugs.a, `v${v.v}.mp4`)), `v${v.v}'s bytes`);
    assert.ok(here2.startsWith(workspaceRoot(w2).versions), "in w2's own versions/");
  }
  // screenshots and the voice clip next to review.json; references and the fix preview through storage
  for (const f of [drawn.shots?.clean, drawn.shots?.marked, `${facts.notes.ranged}.m4a`])
    assert.equal(sha(path.join(dirOf(A, w2), must(f))), sha(path.join(src, 'data', facts.slugs.a, must(f))));
  const refFiles = got.comments.flatMap((c) => (c.refs || []).flatMap(store.refFiles));
  assert.ok(refFiles.length >= 3);
  for (const f of refFiles)
    assert.ok(
      inWorkspace(w2, () => storage().has(store.refKey(A, f))),
      `reference ${f}`,
    );
  const preview = must(got.comments.find((c) => c.id === facts.notes.ranged)?.previews?.[0]);
  assert.ok(inWorkspace(w2, () => storage().has(store.previewKey(A, preview.file))));
  // a moment of another video names that video by its new id; so does the playbook's
  assert.equal(got.comments.find((c) => c.id === facts.notes.ranged)?.refs?.find((x) => x.kind === 'frame')?.video, B);
  const { readPlaybook } = await import('../../lib/playbookFiles.ts');
  const book = must(inWorkspace(w2, () => readPlaybook('Client A')));
  assert.equal(book.refs[0]?.video, B);
  assert.ok(
    inWorkspace(w2, () => storage().has(`playbooks/${book.id}/skills/${book.skills[0]?.id}/preset.json`)),
    "the skill's file",
  );
  // the team's watching, now the owner's account's
  const views = JSON.parse(fs.readFileSync(path.join(dirOf(A, w2), 'views.json'), 'utf8'));
  assert.deepEqual(Object.keys(views.viewers), [owner.id]);
  // the session: its name, never its id or the folder it ran in
  assert.deepEqual(must(inWorkspace(w2, () => store.loadReview(C))).session, {
    name: 'cutter',
    id: null,
    cwd: null,
    assigned: sourceReview(facts.slugs.c).session?.assigned,
    by: 'agent:cutter',
  });
  // the history: every line marked, every id an upload's, screenshots where this server keeps them
  const events = eventsOf(w2);
  assert.equal(events.length, manifest.counts.events);
  assert.ok(events.every((e) => e.imported === manifest.id));
  assert.ok(!linesOf(path.join(workspaceRoot(w2).data, 'events.jsonl')).some((e) => e.imported), 'none of it in the live log');
  assert.ok(events.every((e) => [A, B, C, U].includes(e.slug) && e.video.startsWith('/@uploads/')));
  const shots = events.filter((e) => e.shots?.clean).map((e) => e.shots?.clean as string);
  assert.ok(shots.length && shots.every((f) => f.startsWith(dirOf(A, w2))), 'screenshot paths of this server');
  // what the server answers: the library, a review, Insights
  const lib = await get('/api/library', w2);
  assert.equal(lib.videos.length, 4);
  for (const f of ['Client A', 'Client A/Reels', 'Client A/Empty']) assert.ok(lib.folders.includes(f), f);
  const ins = await get('/api/insights?period=all', w2);
  assert.ok(ins.totals.notes >= 5 && ins.totals.videos === 4, JSON.stringify(ins.totals));
  // the derived files: made by the import's own jobs
  const { cachedPoster } = await import('../../lib/media.ts');
  assert.ok(
    inWorkspace(w2, () => cachedPoster(must(got.versions.at(-1)))),
    'a poster',
  );
});

test('no path of the machine anywhere in the store, in a file or a name', () => {
  const hits: string[] = [];
  for (const root of [workspaceRoot(w2).data, workspaceRoot(w2).versions, workspaceRoot(w2).cache]) {
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (machineMarks.some((m) => n.name.includes(m))) hits.push(p);
        if (n.isDirectory()) walk(p);
        else if (/\.(json|jsonl|md)$/.test(n.name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (machineMarks.some((m) => text.includes(m))) hits.push(p);
        }
      }
    };
    walk(root);
  }
  assert.deepEqual(hits, []);
});

test('people: the owner and their names become the account (by id), --people maps a name, agents and clients keep theirs', () => {
  const got = must(inWorkspace(w2, () => store.loadReview(A)));
  const note = (id: string) => must(got.comments.find((c) => c.id === id));
  // written with the machine owner's account, and only under its name: both the account here
  assert.deepEqual([note(facts.notes.drawn).author, note(facts.notes.drawn).author_id], ['Olivia', owner.id]);
  assert.deepEqual([note(facts.notes.ranged).author, note(facts.notes.ranged).author_id], ['Olivia', owner.id]);
  const verified = must(note(facts.notes.drawn).replies.find((r) => r.status === 'verified'));
  assert.deepEqual([verified.by, verified.by_id], ['Olivia', owner.id]);
  assert.equal(got.added_by_id, owner.id);
  assert.ok(got.approvals?.filter((x) => x.party === 'team').every((x) => x.by === 'Olivia'));
  // a name mapped by --people
  assert.deepEqual([note(facts.notes.overall).author, note(facts.notes.overall).author_id], ['Rita R.', rita.id]);
  // agents keep their names (and no account), replies too; a client keeps theirs, without the link it came through
  assert.deepEqual([note(facts.notes.question).author, note(facts.notes.question).author_id], ['agent:cutter', undefined]);
  assert.ok(note(facts.notes.drawn).replies.some((r) => r.by === 'agent:cutter' && !r.by_id));
  assert.deepEqual([note(facts.notes.client).author, note(facts.notes.client).author_id, note(facts.notes.client).share], ['guest:Mia', undefined, undefined]);
  assert.ok(got.approvals?.some((x) => x.by === 'guest:Mia' && x.party === 'client' && !('share' in x)));
});

test('history reaches no live follower, webhook, push or mailbox; a new note does', async () => {
  const token = tokenIn(w2);
  const made = await app.request('POST', `/api/review/${encodeURIComponent(B)}/comments`, {
    body: { frame: 1, text: 'a new note after the move' },
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(made.status, 200, made.text);
  await until(() => told.some((t) => t.to === 'webhook' && t.e.text === 'a new note after the move'), 'the new note reaches the feed');
  await until(() => watched.some((e) => e.text === 'a new note after the move'), 'and `vr watch`');
  assert.ok(
    told.every((t) => t.e.text === 'a new note after the move'),
    `only the new note: ${told.map((t) => `${t.to} ${t.e.type} ${t.e.text}`).join(' | ')}`,
  );
  assert.deepEqual(
    watched.map((e) => e.text),
    ['a new note after the move'],
  );
  stopWatch.abort();
  const outbox = path.join(CACHE, 'outbox');
  assert.deepEqual(fs.existsSync(outbox) ? fs.readdirSync(outbox) : [], [], 'no mail');
});

test('a second run brings nothing new', () => {
  const before = listing();
  const events = eventsOf(w2).length;
  const r = report(importInto(w2));
  assert.ok(r.reviews.every((x) => x.action === 'skip' && /already/.test(x.why ?? '')));
  assert.equal(r.events.append, 0);
  assert.equal(eventsOf(w2).length, events);
  assert.deepEqual(r.playbooks, [{ scope: 'Client A', action: 'skip', why: 'this workspace has a playbook there already' }]);
  // nothing but the taste files (written again from the same notes) changed
  assert.deepEqual(
    listing().filter((l) => !l.includes('/taste/')),
    before.filter((l) => !l.includes('/taste/')),
  );
});

test('workspace isolation: what came into w2 shows nowhere in w1', async () => {
  assert.deepEqual(
    inWorkspace('w1', () => store.listReviews()),
    [],
  );
  assert.equal((await get('/api/library', 'w1')).videos.length, 0);
  assert.deepEqual(eventsOf('w1'), []);
  assert.equal(fs.existsSync(path.join(VERSIONS, A)), false);
});

test('into w1 next to its own video of the same id: that one is skipped and kept; a note id it holds is renamed', async () => {
  // w1 has a teaser of its own in the same folder (other bytes), with a note whose id the bundle uses too
  const own = path.join(dir, 'own-teaser.mp4');
  const { makeVideo } = await import('../lib/helpers.ts');
  makeVideo(own, { w: 160, h: 90, dur: 1, freq: 990 });
  const up = await inWorkspace('w1', () => store.ingestUpload(own, { name: 'teaser.mp4', folder: 'Client A', by: 'Olivia', byId: owner.id }));
  inWorkspace('w1', () => store.addComment(U, { id: facts.notes.drawn, frame: 1, text: 'ours', author: 'Olivia' }));
  const before = fs.readFileSync(path.join(DATA, U, 'review.json'), 'utf8');
  const bytes = sha(must(inWorkspace('w1', () => store.versionFile(up.review, 1))));

  const r = report(importInto('w1'));
  const teaser = must(r.reviews.find((x) => x.slug === U));
  assert.deepEqual([teaser.action, teaser.why], ['skip', 'this workspace has another video with this id']);
  assert.equal(fs.readFileSync(path.join(DATA, U, 'review.json'), 'utf8'), before, 'its review untouched');
  assert.equal(sha(must(inWorkspace('w1', () => store.versionFile(up.review, 1)))), bytes, 'its bytes untouched');
  const a = must(r.reviews.find((x) => x.slug === A));
  const renamed = must(a.renamed[facts.notes.drawn]);
  const got = must(inWorkspace('w1', () => store.loadReview(A)));
  const note = must(got.comments.find((c) => c.id === renamed));
  assert.equal(note.text, 'Logo comes in too early');
  assert.equal(note.shots?.clean, `${renamed}_clean.png`);
  assert.ok(fs.existsSync(path.join(DATA, A, `${renamed}_clean.png`)) && !fs.existsSync(path.join(DATA, A, `${facts.notes.drawn}_clean.png`)));
  assert.ok(eventsOf('w1').some((e) => e.slug === A && e.id === renamed) && !eventsOf('w1').some((e) => e.slug === A && e.id === facts.notes.drawn));
  // without --people, a name with no account here stays a name
  assert.deepEqual(
    [got.comments.find((c) => c.id === facts.notes.overall)?.author, got.comments.find((c) => c.id === facts.notes.overall)?.author_id],
    ['Rita', undefined],
  );
  assert.equal(inWorkspace('w1', () => store.findComment(facts.notes.drawn))?.slug, U, "w1's own note keeps its id");
});

test('imported history is no news to an agent: wait_for_feedback, INBOX.md and `vr inbox` skip it, whatever its time', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createReviewServer } = await import('../../mcp/core.ts');
  // w1 holds the bundle's history now (the test above), made minutes ago on the "machine": an agent waiting since an
  // hour ago must hear none of it (sweep 2 SW-1), only what a person does here
  const imported = new Set(
    eventsOf('w1')
      .filter((e) => e.imported === manifest.id)
      .map((e) => e.slug),
  );
  assert.ok(imported.size >= 3, 'w1 has the history');
  // in w1: a store with several workspaces names the one work is for
  await inWorkspace('w1', async () => {
    const server = createReviewServer({ backend: createLocalBackend(), principal: { via: 'local', name: 'Olivia', id: owner.id, role: 'owner' } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: 'agent', version: '1' });
    await c.connect(a);
    const wait = async (args: Record<string, unknown>) => {
      const r = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 0, images: 'none', ...args } })) as {
        structuredContent?: { events: { slug?: string; text?: string }[]; cursor: string };
        content: { text?: string }[];
      };
      assert.ok(r.structuredContent, r.content.map((x) => x.text).join('\n'));
      return r.structuredContent;
    };
    try {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const old = await wait({ since });
      assert.deepEqual(
        old.events.filter((e) => imported.has(e.slug ?? '')).map((e) => e.text),
        [],
        'no imported note is new feedback',
      );
      const fresh = await wait({});
      assert.ok(Date.parse(fresh.cursor.split('#')[0] ?? '') <= Date.now() + 1000, `a fresh cursor is now, never later: ${JSON.stringify(fresh)}`);
    } finally {
      await c.close();
      await server.close();
    }
  });
  assert.ok(!inWorkspace('w1', () => store.inboxEvents()).some((e) => e.imported), 'INBOX.md and vr://inbox list none of it');
  const listed = JSON.parse(vr(['inbox', '--json', '--limit', '500'], env).out) as ReviewEvent[];
  assert.ok(!listed.some((e) => e.imported), '`vr inbox` lists none of it');
});

test('a run that was killed halfway is carried on by the next run of the same bundle; what another one left is taken back', () => {
  const w5 = ws.createWorkspace({ name: 'Interrupted', ownerId: owner.id }).id;
  // what killed runs leave: A's folder marked by this bundle, half a version; B's and a third id's marked by another
  // bundle, with half a render nothing lists (sweep 2 SW-7: it stayed until that bundle ran again, if ever)
  inWorkspace(w5, () => store.markImporting(A, manifest.id));
  fs.mkdirSync(path.join(workspaceRoot(w5).versions, A), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot(w5).versions, A, 'v1.mp4'), 'half a file');
  const other = '__@uploads__Elsewhere__gone.mp4';
  for (const s of [B, other]) {
    inWorkspace(w5, () => store.markImporting(s, 'b_0000000000000000'));
    fs.mkdirSync(path.join(workspaceRoot(w5).versions, s), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot(w5).versions, s, 'v1.mp4'), 'half of another bundle’s file');
  }
  const dry = report(importInto(w5, '--dry-run'));
  assert.ok(
    dry.warnings.some((w) => /2 video ids held what an unfinished import left \(b_0000000000000000\): the import takes it back/.test(w)),
    dry.warnings.join('\n'),
  );
  assert.ok(fs.existsSync(path.join(workspaceRoot(w5).versions, other)), 'a dry run takes nothing back');
  const r = report(importInto(w5));
  assert.deepEqual(
    r.reviews.map((x) => [x.slug, x.action]),
    [
      [U, 'import'],
      [C, 'import'],
      [B, 'import'],
      [A, 'resume'],
    ],
  );
  assert.ok(
    r.warnings.some((w) => /2 video ids held what an unfinished import left \(b_0000000000000000\): taken back/.test(w)),
    r.warnings.join('\n'),
  );
  assert.ok(!fs.existsSync(path.join(workspaceRoot(w5).versions, other)) && !fs.existsSync(path.join(workspaceRoot(w5).data, other)), 'its leftovers are gone');
  assert.equal(sha(path.join(workspaceRoot(w5).versions, B, 'v1.mp4')), sha(path.join(src, 'data-versions', facts.slugs.b, 'v1.mp4')), 'B came in whole');
  const got = must(inWorkspace(w5, () => store.loadReview(A)));
  assert.equal(sha(path.join(workspaceRoot(w5).versions, A, 'v1.mp4')), sha(path.join(src, 'data-versions', facts.slugs.a, 'v1.mp4')), 'the whole file now');
  assert.equal(got.comments.length, 5);
  assert.equal(
    inWorkspace(w5, () => store.importingFrom(A)),
    null,
    'no mark left on a finished review',
  );
  assert.deepEqual(
    inWorkspace(w5, () => store.unfinishedImports()),
    [],
    'nothing unfinished is left',
  );
});

// ------------------------------------------------------------------------------------------------ hostile bundles

/** The bundle's entries (manifest first), each as bytes. */
async function entriesOf(file: string): Promise<{ name: string; data: Buffer }[]> {
  const out: { name: string; data: Buffer }[] = [];
  await readTar(file, { entries: 10_000, maxSize: () => 1e9 }, async (e, chunks) => {
    const parts: Buffer[] = [];
    for await (const c of chunks) parts.push(c);
    out.push({ name: e.name, data: Buffer.concat(parts) });
  });
  return out;
}
/** A copy of the bundle with `change` applied to its files and a manifest that matches them again. */
async function rebuilt(name: string, change: (n: string, data: Buffer) => Buffer): Promise<string> {
  const all = await entriesOf(bundle);
  const files = all.filter((e) => e.name !== 'manifest.json').map((e) => ({ name: e.name, data: change(e.name, e.data) }));
  const m = JSON.parse(must(all[0]).data.toString('utf8')) as BundleManifest;
  m.files = files.map((f) => ({ path: f.name, size: f.data.length, sha256: crypto.createHash('sha256').update(f.data).digest('hex') }));
  const out = path.join(src, name);
  const tar = await openTarWriter(out);
  await tar.buffer('manifest.json', Buffer.from(JSON.stringify(m)));
  for (const f of files) await tar.buffer(f.name, f.data);
  await tar.close();
  return out;
}
/** A tar written block by block, for what our writer refuses to make: any name, any type. */
function rawTar(file: string, entries: { name: string; data?: Buffer; type?: string; link?: string; size?: number }[]): string {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const data = e.data ?? Buffer.alloc(0);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(`${(e.size ?? data.length).toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(e.type ?? '0', 156, 'ascii');
    if (e.link) h.write(e.link, 157, 100, 'utf8');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(file, Buffer.concat(blocks));
  return file;
}
/** The bundle's own manifest, listing `files` instead of its own. */
const manifestFor = (files: { path: string; data: Buffer }[]) => {
  const { file: _f, bytes: _b, warnings: _w, ...m } = manifest as BundleManifest & { file?: string; bytes?: number; warnings?: string[] };
  return Buffer.from(
    JSON.stringify({
      ...m,
      files: files.map((f) => ({ path: f.path, size: f.data.length, sha256: crypto.createHash('sha256').update(f.data).digest('hex') })),
    }),
  );
};

test('hostile bundles are refused before anything is written', async () => {
  const w3 = ws.createWorkspace({ name: 'Hostile', ownerId: owner.id }).id;
  const refused = async (file: string, why: RegExp) => {
    const before = listing();
    const r = admin(['import', file, '--workspace', w3, '--owner', 'owner@example.com']);
    assert.equal(r.code, 1, `refused: ${r.out}`);
    assert.match(r.err, why);
    assert.deepEqual(listing(), before, `${path.basename(file)} wrote nothing`);
    assert.deepEqual(
      inWorkspace(w3, () => store.listReviews()),
      [],
    );
  };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  // a name that climbs out, an absolute one, a link, a folder
  await refused(
    rawTar(path.join(src, 'up.tar'), [
      { name: 'manifest.json', data: manifestFor([]) },
      { name: '../../escape.png', data: png },
    ]),
    /a name a bundle never holds/,
  );
  await refused(rawTar(path.join(src, 'abs.tar'), [{ name: '/etc/escape.png', data: png }]), /a name a bundle never holds/);
  await refused(
    rawTar(path.join(src, 'link.tar'), [
      { name: 'manifest.json', data: manifestFor([]) },
      { name: 'reviews/r0001/files/c_aaaaaa_clean.png', type: '2', link: '/etc/passwd' },
    ]),
    /a link in the archive/,
  );
  await refused(
    rawTar(path.join(src, 'dir.tar'), [
      { name: 'manifest.json', data: manifestFor([]) },
      { name: 'reviews', type: '5' },
    ]),
    /a folder in the archive/,
  );
  // a file larger than its kind may be (said by the header, before a byte of it is read)
  await refused(
    rawTar(path.join(src, 'big.tar'), [
      { name: 'manifest.json', data: manifestFor([]) },
      { name: 'reviews/r0001/files/c_aaaaaa_clean.png', size: 2 ** 31 },
    ]),
    /more than such a file may be/,
  );
  // one byte of a version changed after the manifest was written
  const flipped = path.join(src, 'flipped.tar');
  const raw = fs.readFileSync(bundle);
  const at = raw.indexOf(Buffer.from('mdat')) + 100;
  raw[at] = (raw[at] as number) ^ 0xff;
  fs.writeFileSync(flipped, raw);
  await refused(flipped, /doesn't match its checksum/);
  // a field the format doesn't have
  await refused(
    await rebuilt('unknown.tar', (n, d) => (n.endsWith('/review.json') ? Buffer.from(JSON.stringify({ ...JSON.parse(d.toString()), evil: true })) : d)),
    /review\.json: \(top\): Unrecognized key/i,
  );
  // times after the bundle was made, or after now (sweep 2 SW-1): an event, a record, the manifest itself
  await refused(
    await rebuilt('future-event.tar', (n, d) =>
      n === 'events.jsonl' ? Buffer.from(d.toString().replace(/"at":"[^"]+"/, '"at":"2099-01-01T00:00:00.000Z"')) : d,
    ),
    /events\.jsonl line 1: at: a time later than the bundle was made/,
  );
  await refused(
    await rebuilt('future-record.tar', (n, d) =>
      n.endsWith('/review.json') ? Buffer.from(JSON.stringify({ ...JSON.parse(d.toString()), added: '2099-01-01T00:00:00.000Z' })) : d,
    ),
    /review\.json: added: a time later than the bundle was made/,
  );
  const ahead = path.join(src, 'future-manifest.tar');
  {
    const all = await entriesOf(bundle);
    const m = JSON.parse(must(all[0]).data.toString('utf8')) as BundleManifest;
    m.created = '2099-01-01T00:00:00.000Z';
    const tar = await openTarWriter(ahead);
    await tar.buffer('manifest.json', Buffer.from(JSON.stringify(m)));
    for (const f of all.slice(1)) await tar.buffer(f.name, f.data);
    await tar.close();
  }
  await refused(ahead, /manifest\.json: created: a time later than the bundle was made/);
  // a video that is a path of some machine, not an upload
  await refused(
    await rebuilt('path.tar', (n, d) =>
      n.endsWith('/review.json') ? Buffer.from(JSON.stringify({ ...JSON.parse(d.toString()), video: '/etc/passwd.mp4' })) : d,
    ),
    /is not an upload's/,
  );
  // a file its review doesn't name
  await refused(
    rawTar(path.join(src, 'stray.tar'), [
      { name: 'manifest.json', data: manifestFor([{ path: 'reviews/r0009/files/c_aaaaaa_clean.png', data: png }]) },
      { name: 'reviews/r0009/files/c_aaaaaa_clean.png', data: png },
    ]),
    /the manifest counts 4 videos|a file of a review the bundle doesn't hold/,
  );
  // bytes that are not the version the review describes (v1 and v2 swapped): checked while placing, then taken back
  const all = await entriesOf(bundle);
  const keyOfA = must(all.find((e) => e.name.endsWith('/review.json') && JSON.parse(e.data.toString()).video.endsWith('/~2/clip.mp4'))).name.split('/')[1];
  const v1 = must(all.find((e) => e.name === `reviews/${keyOfA}/versions/v1.mp4`));
  const v2 = must(all.find((e) => e.name === `reviews/${keyOfA}/versions/v2.mp4`));
  await refused(
    await rebuilt('swapped.tar', (n, d) => (n === v1.name ? v2.data : n === v2.name ? v1.data : d)),
    /its bytes are not the version its review describes/,
  );
  assert.equal(fs.existsSync(path.join(workspaceRoot(w3).versions, A)), false, 'what was placed was taken back');
});

test('the help names both commands', () => {
  const help = vr(['help'], machine).out;
  assert.ok(help.includes('lampo export <out.tar>') && help.includes('lampo admin import <tar> --workspace'));
});
