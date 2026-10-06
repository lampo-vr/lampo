// The data contract end to end, in a throwaway store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Comment, Shape } from '../../lib/types.ts';
import { age, isolatedEnv, makeVideo, must, vrAsync } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const paths = await import('../../lib/paths.ts');
const { makeShots } = await import('../../lib/shots.ts');
const { quickHash } = await import('../../lib/probe.ts');

const video = makeVideo(path.join(dir, 'proj/export/clip.mp4'), { dur: 1 });
age(video);
const slug = paths.slugify(video);
const rdir = () => paths.reviewDir(slug);
let human: Comment;
let agentQ: Comment;
const load = () => must(store.loadReview(slug), 'review');

test('the store is isolated from the real one', () => {
  assert.equal(paths.STORE_MODE, 'env');
  assert.equal(paths.DATA, path.join(dir, 'data'));
  assert.equal(paths.VERSIONS, `${path.join(dir, 'data')}-versions`);
  assert.equal(paths.CACHE, path.join(dir, 'cache'));
});

test('createOrGetReview registers v1 with probe data and a snapshot', () => {
  const { review, created } = store.createOrGetReview(video, { by: 'tester' });
  assert.equal(created, true);
  assert.equal(review.video, video);
  assert.equal(review.fps, 30);
  assert.equal(review.width, 160);
  assert.equal(review.height, 90);
  assert.equal(review.frames, 30);
  assert.equal(review.versions.length, 1);
  assert.equal(review.folder, null);
  const snap = store.snapshotPath(slug, 1, '.mp4');
  assert.ok(fs.existsSync(snap));
  assert.equal(quickHash(snap), review.versions[0].hash);
  assert.equal(store.createOrGetReview(video).created, false);
});

test('addComment writes exact-frame screenshots and all derived files', async () => {
  const review = load();
  const ver = review.versions[0];
  const id = store.reservedCommentId();
  assert.match(id, /^c_[0-9a-f]{6}$/);
  const drawing: Shape[] = [{ type: 'box', x: 20, y: 10, w: 60, h: 40 }];
  const shots = await makeShots({ file: must(store.versionFile(review, 1)), frame: 10, meta: { ...review.meta, ...ver }, drawing, dir: rdir(), id });
  human = store.addComment(slug, {
    id,
    frame: 10,
    range: { in: 12, out: 8 },
    text: 'kurzer freeze hier',
    tags: ['freeze'],
    severity: 'must',
    drawing,
    author: 'tester',
    shots,
  });
  assert.equal(human.timecode, '00:00:10');
  assert.equal(human.t, 0.333);
  assert.deepEqual(human.range, { in: 8, out: 12 }, 'range is normalised');
  assert.equal(human.status, 'open');
  const clean = fs.readFileSync(path.join(rdir(), `${id}_clean.png`));
  const marked = fs.readFileSync(path.join(rdir(), `${id}_marked.png`));
  assert.notDeepEqual(clean, marked, 'marked has the drawing burned in');

  const id2 = store.reservedCommentId();
  const shots2 = await makeShots({ file: must(store.versionFile(review, 1)), frame: 29, meta: { ...review.meta, ...ver }, drawing: [], dir: rdir(), id: id2 });
  agentQ = store.addComment(slug, { id: id2, frame: 99, text: 'Soll das so?', author: 'agent:test', shots: shots2 });
  assert.equal(agentQ.frame, 29, 'frame is clamped to the last frame');
  assert.deepEqual(fs.readFileSync(path.join(rdir(), `${id2}_clean.png`)), fs.readFileSync(path.join(rdir(), `${id2}_marked.png`)));

  assert.equal(agentQ.kind, 'question', "an agent's note is a question unless it says otherwise");
  assert.equal(human.kind, undefined, "a person's feedback is stored as before kinds existed");

  const md = fs.readFileSync(path.join(rdir(), 'review.md'), 'utf8');
  assert.match(md, /## Open \(1\)/, 'only feedback is work');
  assert.match(md, /## Questions and notes from agents, waiting for .* \(1\)[\s\S]*QUESTION · – · 00:00:29[\s\S]*asked by agent:test/);
  assert.match(md, /kurzer freeze hier/);
  assert.match(md, /box x20 y10 w60 h40 \(video px\)/);
  assert.ok(md.includes(path.join(rdir(), `${id}_marked.png`)), 'absolute screenshot paths');

  const inbox = fs.readFileSync(store.INBOX_FILE, 'utf8');
  assert.match(inbox, /NEW MUST · freeze · c_/);
  assert.ok(!inbox.includes('Soll das so?'), 'agent comments stay out of the human inbox');

  const types = store.readEvents().map((e) => e.type);
  assert.deepEqual(types, ['added', 'comment', 'comment']);
});

test('a render still being written is left alone, a settled one becomes v2 and carries open comments', () => {
  makeVideo(video, { dur: 1.2, pattern: 'testsrc2', freq: 660 });
  const pending = must(store.sync(slug));
  assert.equal(pending.pending, true);
  assert.equal(load().versions.length, 1);

  age(video);
  const res = must(store.sync(slug));
  assert.equal(res.version?.v, 2);
  assert.equal(res.carried, 2);
  const review = load();
  assert.equal(review.frames, 36);
  for (const c of review.comments) {
    assert.equal(c.check_again, true);
    assert.equal(c.carried_to, 2);
  }
  // v1 keeps its own bytes although the file on disk was overwritten
  assert.equal(quickHash(must(store.versionFile(review, 1))), review.versions[0].hash);
  assert.equal(quickHash(must(store.versionFile(review, 2))), quickHash(video));
  assert.equal(store.readEvents().at(-1)?.type, 'version');
});

test('status loop: fixed by agent → verified by human; wontfix; reopen', () => {
  const fixed = store.updateComment(human.id, { status: 'fixed', note: 'Doppelten Frame entfernt', by: 'agent:test' });
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.fixed_in_v, 2);
  assert.equal(fixed.check_again, false);
  assert.deepEqual(
    { ...fixed.replies.at(-1), at: undefined },
    { by: 'agent:test', text: 'Doppelten Frame entfernt', status: 'fixed', fixed_in_v: 2, at: undefined },
  );

  const verified = store.updateComment(human.id, { status: 'verified', by: 'tester' });
  assert.equal(verified.status, 'verified');

  const wont = store.updateComment(agentQ.id, { status: 'wontfix', note: 'gewollt', by: 'tester' });
  assert.equal(wont.status, 'wontfix');
  const reopened = store.updateComment(agentQ.id, { status: 'open', note: 'doch nicht', by: 'tester' });
  assert.equal(reopened.status, 'open');

  const replied = store.updateComment(agentQ.id, { note: 'nur eine Antwort', by: 'agent:test' });
  assert.equal(replied.status, 'open');
  assert.equal(replied.replies.at(-1)?.text, 'nur eine Antwort');

  const n = store.counts(load());
  assert.equal(n.open, 0, "an agent's open question is not work");
  assert.equal(n.questions, 1);
  assert.equal(n.verified, 1);

  const answered = store.updateComment(agentQ.id, { status: 'verified', note: 'Ja, gewollt.', by: 'tester' });
  assert.equal(answered.status, 'verified');
  assert.equal(store.counts(load()).questions, 0);

  const inbox = fs.readFileSync(store.INBOX_FILE, 'utf8');
  assert.match(inbox, /VERIFIED · c_/);
  assert.match(inbox, /REOPENED · c_/);
  assert.match(inbox, /ANSWERED · c_[\s\S]*note: Ja, gewollt\./, 'closing a question with a reply reads as an answer');
  assert.ok(!/· FIXED ·/.test(inbox), "the agent's own fix is not in the human inbox");
});

test('findComment, resolveVideo and deleteComment', () => {
  assert.equal(store.findComment(human.id)?.slug, slug);
  assert.equal(store.resolveVideo('clip.mp4').slug, slug);
  assert.equal(store.resolveVideo(slug).video, video);
  assert.throws(() => store.resolveVideo('does-not-exist.mp4'));
  // A file not under review: only a caller about to track it (mustExist: false) learns it is there; to anyone else a path
  // is an unknown name, the same whether or not a file exists.
  const other = makeVideo(path.join(dir, 'proj/export/untracked.mp4'), { dur: 1 });
  assert.deepEqual(store.resolveVideo(other, { mustExist: false }), { video: other, slug: paths.slugify(other), fresh: true });
  const refusal = (p: string) => {
    try {
      store.resolveVideo(p);
      return 'resolved';
    } catch (e) {
      return (e as Error).message.split(p).join('<path>');
    }
  };
  assert.equal(refusal(other), refusal(path.join(dir, 'nothing-here.mp4')));
  assert.equal(refusal(other), 'no reviewed video matches "<path>"');
  store.deleteComment(human.id, 'tester');
  assert.equal(store.findComment(human.id), null);
  assert.ok(!fs.existsSync(path.join(rdir(), `${human.id}_clean.png`)), 'screenshots go with the comment');
});

test('concurrent writers never corrupt review.json and leave no temp files', async () => {
  const run = (from: number) =>
    new Promise<void>((resolve, reject) => {
      const p = vrAsync(['add', video, '--frame', String(from), '--text', `parallel ${from}`, '--by', 'tester'], env);
      let err = '';
      p.stderr.on('data', (d) => {
        err += d;
      });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
  const review = load();
  const parallel = review.comments.filter((c) => c.text.startsWith('parallel '));
  assert.equal(parallel.length, 8);
  assert.equal(new Set(review.comments.map((c) => c.id)).size, review.comments.length, 'ids stay unique');
  const leftovers = fs.readdirSync(rdir()).filter((f) => f.endsWith('.tmp') || f.includes('.tmp.') || f === '.lock');
  assert.deepEqual(leftovers, []);
});

test('removeVideo archives a review that has comments', () => {
  const r = store.removeVideo(slug, 'tester');
  assert.ok(r?.archived);
  assert.ok(fs.existsSync(path.join(rdir(), 'review.json')));
  store.unarchive(slug);
  assert.equal(load().archived, undefined);
});

test('a note written straight into the store has no screenshot names to 404 on', () => {
  const file = path.join(dir, 'noshots/export/plain.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = path.resolve(file).split('/').join('__');
  const c = store.addComment(slug, { frame: 3, text: 'no frames grabbed', author: 'tester' });
  assert.equal(c.shots, null);
  assert.ok(!store.renderReviewMd(must(store.loadReview(slug))).includes('_marked.png'));
});

test('a lock left by a process that died is taken over at once', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const d = path.join(dir, 'locks/a');
  fs.mkdirSync(path.join(d, '.lock'), { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(path.join(d, '.lock', 'owner'), `${dead}@${os.hostname()}`);
  const t = Date.now();
  assert.equal(
    store.withLock(d, () => fs.readFileSync(path.join(d, '.lock', 'owner'), 'utf8')),
    `${process.pid}@${os.hostname()}`,
    'the new owner is recorded',
  );
  // A lock held by a live writer is waited for 5 s and then refused (503); taken over well before that = seen as dead.
  assert.ok(Date.now() - t < 4000, 'no wait for a dead owner');
  assert.equal(fs.existsSync(path.join(d, '.lock')), false, 'released');
});
