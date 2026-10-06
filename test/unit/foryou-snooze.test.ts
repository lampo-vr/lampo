// "Later" in the inbox: an item put aside leaves the list and the bell's number until its time, or until its video
// moves (a render, a note, a reply, a verdict), whichever comes first; per person, kept next to the dismissals in
// data/for-you.json without touching them; it changes nothing on the note or the video.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ForYouResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { forYou, dismiss, snooze, unsnooze } = await import('../../lib/foryou.ts');

const a = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { dur: 1 });
const b = makeVideo(path.join(dir, 'Acme/export/teaser.mp4'), { dur: 1 });
age(a);
age(b);
store.createOrGetReview(a, { by: 'tester' });
store.createOrGetReview(b, { by: 'tester' });
const A = slugOf(a);
const B = slugOf(b);

const owner = { key: 'owner', name: 'tester', role: 'owner' as const };
const sam = { key: 'u_sam', name: 'Sam', role: 'member' as const };
const keysOf = (r: ForYouResponse) => r.items.map((i) => i.key);
const FILE = path.join(dir, 'data', 'for-you.json');
const HOUR = 3600_000;
const inHours = (h: number, from = Date.now()) => new Date(from + h * HOUR).toISOString();

const q1 = store.addComment(A, { frame: 3, text: 'Logo here already?', author: 'agent:promo-edit' });
const q2 = store.addComment(B, { frame: 4, text: 'Which music?', author: 'agent:promo-edit' });
const client = store.addComment(B, { frame: 6, text: 'Brighter please', author: 'guest:Mia' });

// The app for the API tests at the end, started before the first test: tests declared above a top-level await run while it waits.
const { base } = await startApp({ token: 't', loadSessions: async () => [] });

test('put aside: out of the list and the bell’s number, sent apart as `later` with when it comes back', () => {
  const before = forYou(owner);
  assert.ok(keysOf(before).includes(`q:${q1.id}`));
  const until = inHours(20);
  assert.equal(snooze(owner, [`q:${q1.id}`], until), 1);
  const r = forYou(owner);
  assert.ok(!keysOf(r).includes(`q:${q1.id}`), 'off the list');
  assert.equal(r.counts.total, before.counts.total - 1, 'not counted in "waiting"');
  assert.equal(r.counts.question, before.counts.question - 1);
  assert.equal(r.counts.later, 1);
  assert.deepEqual(
    r.later?.map((i) => [i.key, i.snoozed]),
    [[`q:${q1.id}`, until]],
  );
  assert.equal(r.wake, until, 'the client knows when to look again');
  // nothing changed on the note
  const note = store.loadReview(A)?.comments.find((c) => c.id === q1.id);
  assert.equal(note?.status, 'open');
  assert.equal(note?.replies?.length ?? 0, 0);
});

test('per person: someone else still sees it', () => {
  assert.ok(keysOf(forYou(sam, { server: true })).includes(`q:${q1.id}`));
});

test('comes back when its time is up', () => {
  const r = forYou(owner, { now: Date.now() + 21 * HOUR });
  assert.ok(keysOf(r).includes(`q:${q1.id}`));
  assert.equal(r.counts.later, 0);
  assert.equal(r.later, undefined, 'nothing aside: no `later` in the answer (the old shape)');
  assert.equal(r.wake, undefined);
});

test('comes back as soon as its video moves: a note, a reply, a render', () => {
  snooze(owner, [`client:${client.id}`, `q:${q2.id}`], inHours(20));
  assert.ok(!keysOf(forYou(owner)).includes(`q:${q2.id}`));
  // the other video moving changes nothing here
  store.addComment(A, { frame: 8, text: 'Elsewhere', author: 'tester' });
  assert.ok(!keysOf(forYou(owner)).some((k) => k === `q:${q2.id}` || k === `client:${client.id}`));
  assert.ok(keysOf(forYou(owner)).includes(`q:${q1.id}`), 'while A moved: its question (put aside in the first test) is back');
  // a reply on B brings both of B's items back
  store.updateComment(client.id, { note: 'On it', by: 'agent:promo-edit' });
  const r = forYou(owner);
  assert.ok(keysOf(r).includes(`q:${q2.id}`));
  assert.equal(r.counts.later, 0);
});

test('a new version brings it back', () => {
  snooze(owner, [`q:${q2.id}`], inHours(20));
  assert.ok(!keysOf(forYou(owner)).includes(`q:${q2.id}`));
  makeVideo(b, { dur: 1, freq: 880 });
  age(b);
  store.sync(B);
  assert.ok(keysOf(forYou(owner)).includes(`q:${q2.id}`));
});

test('bring back at once; keys not on the list are ignored', () => {
  assert.equal(snooze(owner, [`q:${q1.id}`, 'q:nope'], inHours(20)), 1);
  assert.equal(forYou(owner).counts.later, 1);
  unsnooze(owner, [`q:${q1.id}`]);
  assert.equal(forYou(owner).counts.later, 0);
  assert.ok(keysOf(forYou(owner)).includes(`q:${q1.id}`));
});

test('kept in data/for-you.json beside the dismissals, which stay as they were', () => {
  dismiss('owner', ['some:item']);
  snooze(owner, [`q:${q1.id}`], inHours(20));
  const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(all.owner['some:item'], 'the dismissals keep their shape');
  assert.equal(all['@snoozed'].owner[`q:${q1.id}`].until, forYou(owner).wake);
  assert.equal(typeof all['@snoozed'].owner[`q:${q1.id}`].since, 'number');
  // dismissing more leaves the snoozes alone, and the other way round
  dismiss('owner', ['other:item']);
  assert.equal(forYou(owner).counts.later, 1);
  snooze(owner, [`q:${q2.id}`], inHours(20));
  assert.ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).owner['other:item']);
  // a viewer can never be called "@snoozed": it's not a list of dismissals
  assert.equal(forYou({ key: '@snoozed', name: 'x', role: 'owner' }).counts.later, 0);
  unsnooze(owner, [`q:${q1.id}`, `q:${q2.id}`]);
});

test('what came back (its time, its video moved) is forgotten when the next one is written', () => {
  snooze(owner, [`q:${q1.id}`], new Date(Date.now() + 50).toISOString());
  snooze(owner, [`q:${q2.id}`], inHours(20), { now: Date.now() + 1000 });
  const mine = JSON.parse(fs.readFileSync(FILE, 'utf8'))['@snoozed'].owner;
  assert.deepEqual(Object.keys(mine), [`q:${q2.id}`]);
  unsnooze(owner, [`q:${q2.id}`]);
});

// ---------------------------------------------------------------- the API

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('API: POST /api/for-you/snooze and /unsnooze answer with the list; the badge follows', async () => {
  const key = `q:${q1.id}`;
  const r = (await (await post('/api/for-you/snooze', { keys: [key], until: inHours(10) })).json()) as ForYouResponse;
  assert.ok(!keysOf(r).includes(key));
  assert.equal(r.counts.later, 1);
  assert.equal(r.later?.[0].key, key);
  const listed = (await (await fetch(`${base}/api/for-you?limit=50`)).json()) as ForYouResponse;
  assert.equal(listed.counts.later, 1, 'the plain GET says it too');
  const back = (await (await post('/api/for-you/unsnooze', { keys: [key] })).json()) as ForYouResponse;
  assert.ok(keysOf(back).includes(key));
  assert.equal(back.counts.later, 0);
});

test('API: "until" must be ahead and within 30 days', async () => {
  const key = `q:${q1.id}`;
  for (const until of [new Date(Date.now() - 1000).toISOString(), inHours(31 * 24), 'tomorrow']) {
    const res = await post('/api/for-you/snooze', { keys: [key], until });
    assert.equal(res.status, 400, until);
  }
  assert.equal((await post('/api/for-you/snooze', { keys: [], until: inHours(1) })).status, 400);
});
