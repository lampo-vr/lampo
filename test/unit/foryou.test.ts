// "For you": what waits for a person across videos — agent questions (gone once answered), fixes to verify, client
// notes and approvals, agents' replies to your notes, renders without fixes — grouped, dismissible where it makes
// sense, per person, and by role on a server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { ForYouResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { forYou, dismiss } = await import('../../lib/foryou.ts');
const { badge } = await import('../../server/context.ts');
const { DEFAULT_PREFS } = await import('../../lib/push/index.ts');

const a = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { dur: 1 });
const b = makeVideo(path.join(dir, 'Acme/export/teaser.mp4'), { dur: 1 });
age(a);
age(b);
store.createOrGetReview(a, { by: 'tester' });
store.createOrGetReview(b, { by: 'tester' });
const A = slugOf(a);
const B = slugOf(b);

const owner = { key: 'owner', name: 'tester', role: 'owner' as const };
const kinds = (r: ForYouResponse) => r.items.map((i) => i.kind);

const question = store.addComment(A, { frame: 3, text: 'Soll das Logo hier schon stehen?', author: 'agent:promo-edit' });
const toFix = store.addComment(A, { frame: 5, text: 'Logo zu früh', author: 'tester' });
store.updateComment(toFix.id, { status: 'fixed', note: 'Logo kommt jetzt bei 0:10', by: 'agent:promo-edit' });
const client = store.addComment(A, { frame: 7, text: 'Bitte heller', author: 'guest:Mia' });
const mine = store.addComment(A, { frame: 9, text: 'Musik leiser', author: 'tester' });
store.updateComment(mine.id, { note: 'Mache ich im nächsten Render', by: 'agent:promo-edit' });
store.addComment(B, { frame: 4, text: 'Übergang zu hart', author: 'tester' });
makeVideo(b, { dur: 1, freq: 880 });
age(b);
store.sync(B);
// A re-render that hands nothing over (no open notes carried) is not inbox-worthy.
const bumper = makeVideo(path.join(dir, 'Acme/export/bumper.mp4'), { dur: 1 });
age(bumper);
store.createOrGetReview(bumper, { by: 'tester' });
store.setApproval(slugOf(bumper), { status: 'approved' }, 'tester');
makeVideo(bumper, { dur: 1, freq: 660 });
age(bumper);
store.sync(slugOf(bumper));
store.setApproval(slugOf(bumper), { status: 'approved' }, 'tester'); // v2 approved too: it needs nothing from anyone
store.setApproval(B, { status: 'approved' }, 'guest:Mia');

test('everything waiting for you, grouped: questions, fixes, clients, approvals, answers, new renders', () => {
  const r = forYou(owner);
  assert.deepEqual(kinds(r), ['question', 'verify', 'client', 'approval', 'answer', 'version']);
  assert.equal(r.counts.total, 6);
  const q = r.items[0];
  assert.equal(q.key, `q:${question.id}`);
  assert.equal(q.video, 'spot.mp4');
  assert.equal(q.by, 'agent:promo-edit');
  assert.equal(q.dismissible, false, 'a question leaves when it is answered');
  const fix = r.items[1];
  assert.equal(fix.note, 'Logo kommt jetzt bei 0:10', 'what the agent changed');
  assert.equal(fix.dismissible, false);
  assert.equal(r.items[2].by, 'Mia');
  const answer = r.items.find((i) => i.kind === 'answer');
  assert.equal(answer?.text, 'Mache ich im nächsten Render');
  assert.equal(answer?.question, 'Musik leiser');
  const version = r.items.find((i) => i.kind === 'version');
  assert.match(version?.poster || '', /^\/api\/poster\/.+\.jpg\?v=\d+$/, 'a new render shows its poster, not a placeholder');
  assert.ok(version?.text && !/registered|comment\(s\)/.test(version.text), `readable, not the log line: ${version?.text}`);
  assert.equal(version?.slug, B);
  assert.equal(version?.v, 2);
  assert.match(version?.text || '', /1 open note carried over from V1/);
  assert.ok(!r.items.some((i) => i.slug === slugOf(bumper)), 'a render with nothing carried over is not listed');
});

test('answering a question or verifying a fix takes it off the list', () => {
  store.updateComment(question.id, { status: 'verified', note: 'Ja, genau da', by: 'tester' });
  store.updateComment(toFix.id, { status: 'verified', by: 'tester' });
  assert.deepEqual(kinds(forYou(owner)), ['client', 'approval', 'answer', 'version']);
});

test('"Got it" hides an item for that person only', () => {
  dismiss('owner', [`client:${client.id}`]);
  assert.ok(!kinds(forYou(owner)).includes('client'));
  assert.ok(kinds(forYou({ key: 'someone-else', name: 'Sam', role: 'member' }, { server: true })).includes('client'));
});

test('on a server: answers are for the note’s author; a role that may not act sees no work items', () => {
  const again = store.addComment(A, { frame: 11, text: 'Noch eine Frage', author: 'agent:promo-edit' });
  const rita = forYou({ key: 'u_rita', name: 'Rita', role: 'reviewer' }, { server: true });
  assert.ok(kinds(rita).includes('question'), 'reviewers may answer (comment)');
  assert.ok(!kinds(rita).includes('answer'), 'the reply was to someone else’s note');
  const tester = forYou({ key: 'u_t', name: 'tester', role: 'member' }, { server: true });
  assert.ok(kinds(tester).includes('answer'));
  store.updateComment(again.id, { status: 'verified', note: 'ok', by: 'tester' });
});

test('archived videos drop out', () => {
  store.removeVideo(A);
  assert.ok(forYou(owner).items.every((i) => i.slug !== A));
});

// ---------------------------------------------------------------- the API

const { port } = await startApp({ token: 't', loadSessions: async () => [] });

test('API: GET /api/for-you and dismissing through it', async () => {
  const base = `http://127.0.0.1:${port}`;
  const r = (await (await fetch(`${base}/api/for-you`)).json()) as ForYouResponse;
  assert.deepEqual(kinds(r), kinds(forYou(owner)));
  const version = r.items.find((i) => i.kind === 'version');
  assert.ok(version);
  const later = (await (
    await fetch(`${base}/api/for-you/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [version.key] }),
    })
  ).json()) as ForYouResponse;
  assert.ok(!kinds(later).includes('version'));
  const bad = await fetch(`${base}/api/for-you/dismiss`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: [] }),
  });
  assert.equal(bad.status, 400);
});

test('renders nobody has reviewed yet: "To review", instead of the plain new-render item; approving settles it', () => {
  const c = makeVideo(path.join(dir, 'Acme/export/cutdown.mp4'), { dur: 1 });
  age(c);
  store.createOrGetReview(c, { by: 'tester' });
  const C = slugOf(c);
  const fresh = forYou(owner).items.find((i) => i.slug === C);
  assert.equal(fresh?.kind, 'review');
  assert.equal(fresh?.text, 'V1 to review');
  assert.equal(fresh?.dismissible, false, 'work, not news: it leaves with a verdict');
  store.setApproval(C, { status: 'approved' }, 'tester');
  assert.ok(!forYou(owner).items.some((i) => i.slug === C), 'approved: nothing waits');
  makeVideo(c, { dur: 1, freq: 660 });
  age(c);
  store.sync(C);
  assert.deepEqual(
    forYou(owner)
      .items.filter((i) => i.slug === C)
      .map((i) => `${i.kind}:${i.text}`),
    ['review:V1 approved · V2 new'],
    'one item, not also "v2 is in"',
  );
  const reviewer = { key: 'rita', name: 'Rita', role: 'reviewer' as const };
  assert.ok(
    forYou(reviewer, { server: true }).items.some((i) => i.kind === 'review' && i.slug === C),
    'reviewers approve too',
  );
});

test('a long list: ?limit=n sends the newest n of each kind, the counts stay whole', async () => {
  for (let i = 0; i < 4; i++) store.addComment(B, { frame: i, text: `Client note ${i}`, author: 'guest:Mia' });
  const all = forYou(owner);
  const clients = all.items.filter((i) => i.kind === 'client');
  assert.ok(clients.length >= 4);
  const some = forYou(owner, { limit: 2 });
  assert.equal(some.truncated, true);
  assert.deepEqual(some.counts, all.counts, 'counts are for everything');
  assert.deepEqual(
    some.items.filter((i) => i.kind === 'client').map((i) => i.key),
    clients.slice(0, 2).map((i) => i.key),
    'the newest two',
  );
  for (const k of new Set(all.items.map((i) => i.kind)))
    assert.equal(some.items.filter((i) => i.kind === k).length, Math.min(2, all.counts[k]), `${k}: at most two, and every kind is there`);
  assert.equal(forYou(owner, { limit: 1000 }).truncated, undefined, 'nothing left out: no flag');
  const r = (await (await fetch(`http://127.0.0.1:${port}/api/for-you?limit=2`)).json()) as ForYouResponse;
  assert.deepEqual(
    r.items.map((i) => i.key),
    some.items.map((i) => i.key),
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/for-you?limit=-1`)).status, 400);
});

test('stalled videos: last and quieter (not in the bell’s number), one reason each, never a video already listed', () => {
  // promo: handed to an agent, and both its fixes came back and are open again
  const p = makeVideo(path.join(dir, 'Globex/out/promo.mp4'), { dur: 1 });
  age(p);
  store.createOrGetReview(p, { by: 'tester' });
  const P = slugOf(p);
  store.assignSession(P, { name: 'promo-edit', sessionId: null, cwd: null, agent: null }, 'tester');
  store.setApproval(P, { status: 'changes' }, 'tester');
  for (const frame of [3, 7]) {
    const c = store.addComment(P, { frame, text: 'Hold the end card longer', author: 'tester' });
    store.updateComment(c.id, { status: 'fixed', note: 'held', by: 'agent:promo-edit' });
    store.updateComment(c.id, { status: 'open', note: 'still short', by: 'tester' });
  }
  const r = forYou(owner);
  const stalled = r.items.filter((i) => i.kind === 'stalled');
  assert.deepEqual(
    stalled.map((i) => ({ slug: i.slug, waitingOn: i.waitingOn, reason: i.reason, count: i.count, agent: i.agent, dismissible: i.dismissible })),
    [{ slug: P, waitingOn: 'agents', reason: 'reopened', count: 2, agent: 'promo-edit', dismissible: true }],
  );
  assert.equal(r.items.at(-1)?.kind, 'stalled', 'after everything that waits for you');
  assert.equal(r.counts.stalled, 1);
  assert.equal(r.counts.total, r.items.length - 1, 'the bell counts what waits for you, not what stalled');
  assert.ok(!stalled.some((i) => i.slug === A), 'spot is listed already, with its fix to check');

  // "Got it" hides it until the video moves; stalled again after that, it is back
  dismiss('owner', [(stalled[0] as { key: string }).key]);
  assert.equal(forYou(owner).counts.stalled, 0);
  store.addComment(P, { frame: 9, text: 'And the logo is still small', author: 'tester' });
  const back = forYou(owner).items.filter((i) => i.kind === 'stalled');
  assert.equal(back.length, 1);
  assert.notEqual(back[0]?.key, stalled[0]?.key, 'a new key once something happened');

  // quiet for days, nobody on it: waiting on you; a reviewer sees stalled videos too (nudging is the UI's to allow)
  const q = makeVideo(path.join(dir, 'Globex/out/quiet.mp4'), { dur: 1 });
  age(q);
  store.createOrGetReview(q, { by: 'tester' });
  const Q = slugOf(q);
  store.addComment(Q, { frame: 2, text: 'Colour too cold', author: 'tester' });
  store.setApproval(Q, { status: 'changes' }, 'tester');
  const later = forYou(owner, { now: Date.now() + 3 * 86_400_000 }).items.find((i) => i.kind === 'stalled' && i.slug === Q);
  assert.deepEqual(later && { waitingOn: later.waitingOn, reason: later.reason }, { waitingOn: 'you', reason: 'waiting' });
  assert.ok(!forYou(owner).items.some((i) => i.kind === 'stalled' && i.slug === Q), 'not before it has been quiet long enough');
  const reviewer = { key: 'rita', name: 'Rita', role: 'reviewer' as const };
  assert.ok(forYou(reviewer, { server: true }).items.some((i) => i.kind === 'stalled' && i.slug === P));

  // a render waiting for your review is To review — however long it waits, never relabelled as stalled, and a
  // dismissal (an old "Got it", or one sent through the API) doesn't hide it
  const t = makeVideo(path.join(dir, 'Globex/out/teaser.mp4'), { dur: 1 });
  age(t);
  store.createOrGetReview(t, { by: 'tester' });
  const T = slugOf(t);
  const days = { now: Date.now() + 3 * 86_400_000 };
  const toReview = forYou(owner, days).items.find((i) => i.slug === T && i.kind === 'review');
  assert.ok(toReview, 'listed to review');
  dismiss('owner', [toReview.key]);
  assert.deepEqual(
    forYou(owner, days)
      .items.filter((i) => i.slug === T)
      .map((i) => i.kind),
    ['review'],
    'still to review, and not also stalled',
  );
});

test('the inbox agrees with the board’s "Needs you": a new video, every new version, fixes to check — gone once acted on', () => {
  const listed = (slug: string, viewer: { key: string; name: string; role: 'owner' | 'reviewer' } = owner, server = false) =>
    forYou(viewer, { server })
      .items.filter((i) => i.slug === slug)
      .map((i) => `${i.kind}:${i.v ?? ''}`);
  // a new video: its V1, in the list and in the bell's number
  const f = makeVideo(path.join(dir, 'Initech/renders/opener.mp4'), { dur: 1 });
  age(f);
  store.createOrGetReview(f, { by: 'agent:opener-cut' });
  const F = slugOf(f);
  assert.deepEqual(listed(F), ['review:1']);
  const before = forYou(owner).counts;
  assert.ok(before.review >= 1 && before.total >= before.review, 'counted in the bell');
  // on a server too, for a reviewer (who may give the verdict)
  assert.deepEqual(listed(F, { key: 'rita', name: 'Rita', role: 'reviewer' as const }, true), ['review:1']);
  // a note that asks for changes: the video is being fixed, nothing waits for you
  const n = store.addComment(F, { frame: 2, text: 'Title too small', author: 'tester', severity: 'must' });
  assert.deepEqual(listed(F), []);
  // a new version that fixes it: the fix to check
  makeVideo(f, { dur: 1, freq: 550 });
  age(f);
  store.sync(F);
  store.updateComment(n.id, { status: 'fixed', note: 'Title 20 % larger', by: 'agent:opener-cut', fixed_in_v: 2 });
  assert.deepEqual(listed(F), ['verify:2']);
  // checked: V2 itself is to review now
  store.updateComment(n.id, { status: 'verified', by: 'tester' });
  assert.deepEqual(listed(F), ['review:2']);
  // approved: gone; a V3 without any notes: to review again
  store.setApproval(F, { status: 'approved', v: 2 }, 'tester');
  assert.deepEqual(listed(F), []);
  makeVideo(f, { dur: 1, freq: 770 });
  age(f);
  store.sync(F);
  assert.deepEqual(listed(F), ['review:3']);
  // a change request on V3: gone
  store.setApproval(F, { status: 'changes', v: 3 }, 'tester');
  assert.deepEqual(listed(F), []);
});

test('the app badge on the machine counts what its inbox shows: what was put away there stays off it', () => {
  const mac = {
    endpoint: 'https://push.example/mac',
    keys: { p256dh: 'k', auth: 'a' },
    user: null,
    name: 'Mac',
    created: new Date().toISOString(),
    last_ok: null,
    prefs: DEFAULT_PREFS,
  };
  assert.equal(badge(false, 'tester')(mac), forYou(owner, { server: true }).counts.total);
});
