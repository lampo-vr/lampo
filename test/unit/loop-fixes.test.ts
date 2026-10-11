// A fix belongs to the version that carries it (lib/handover.ts, lib/store.ts registerVersion / updateComment): the
// review loop's scenarios on a hosted server, as an agent over MCP (named claude-ai, as the chat app is) puts versions
// up through one-time upload URLs and marks its fixes. Only what the agent marks fixed, in a version that exists, is a
// fix for the person to check; a new version turns no open note, question or note outside a part into one; a fix
// marked before its version rides with the next one; the upload says to mark what it fixed before it says to wait.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Comment, Review, StageInfo } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { cutFrames, fixBox, isolatedEnv, makeShotsVideo, makeVideo, must, sleep } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { endsWaitNow } = await import('../../lib/handoff.ts');
// what the player asks the person to check (check mode's queue, "N fixes to check")
const { waitsForCheck } = await import('../../web/src/player/fixCheck.ts');
const { planSaid } = await import('../../web/src/sessions/runWords.ts');

const { base } = await startApp();
let bearer: Record<string, string> = {};
let agent: Client;

before(async () => {
  const u = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  bearer = { Authorization: `Bearer ${auth.createToken(u.id, 'loop test').token}` };
  agent = new Client({ name: 'claude-ai', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer } }));
});
after(async () => {
  await agent.close().catch(() => {});
});

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const said = (r: Result) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await agent.callTool({ name, arguments: args })) as Result;
  assert.ok(!r.isError, said(r));
  return said(r);
}
async function refused(name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await agent.callTool({ name, arguments: args })) as Result;
  assert.ok(r.isError, `refused: ${said(r)}`);
  return said(r);
}

interface Upload {
  slug: string;
  v: number;
  cursor?: string;
  next?: string;
}
/** A version the agent puts up as it does from a chat app: request_upload, then one PUT of the file. */
async function upload(file: string, filename: string, video?: string): Promise<Upload> {
  const asked = await call('request_upload', { filename, ...(video ? { video } : { folder: 'Loop' }) });
  const url = must(/https?:\/\/\S+\/api\/uploads\/direct\/vrup_[\w-]+/.exec(asked)?.[0], asked).replace(PUBLIC, base);
  const bytes = fs.readFileSync(file);
  const r = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const json = (await r.json()) as Upload;
  assert.equal(r.status, 200, JSON.stringify(json));
  return json;
}
const clip = (name: string, freq: number) => makeVideo(path.join(dir, 'renders', name), { w: 160, h: 90, dur: 6, freq });
/** The person's notes, as Mia writes them in the player. */
const mia = (slug: string, frame: number, text: string, severity: Comment['severity'] = 'must') =>
  store.addComment(slug, { frame, text, severity, author: 'Mia Lang' });
const review = (slug: string) => must(store.loadReview(slug), slug) as Review;
const note = (slug: string, id: string) => must(review(slug).comments.find((c) => c.id === id));
/** "N fixes to check": the notes check mode walks. */
const toCheck = (slug: string) =>
  review(slug)
    .comments.filter(waitsForCheck)
    .map((c) => c.id);
async function stage(slug: string): Promise<StageInfo> {
  const r = await fetch(`${base}/api/review/${encodeURIComponent(slug)}`, { headers: bearer });
  assert.equal(r.status, 200);
  return ((await r.json()) as { summary: { stage: StageInfo } }).summary.stage;
}

test('(a) the clean loop: the upload says to mark what the version fixed, and the last mark says to wait', async () => {
  const v1 = await upload(clip('a.mp4', 300), 'loop-a.mp4');
  const s = v1.slug;
  assert.ok(v1.next && endsWaitNow(v1.next), 'V1 with nothing open: wait now');
  const [n1, n2, n3] = [mia(s, 20, 'Title too small'), mia(s, 60, 'Logo comes in too late', 'should'), mia(s, 100, 'Hold the end card longer', 'nice')];
  const v2 = await upload(clip('a2.mp4', 400), 'loop-a.mp4', 'loop-a.mp4');
  assert.equal(v2.v, 2);
  // no "wait now" before the fixes are marked: a hasty agent would wait and never say what it changed
  assert.equal(v2.next, '3 notes still open on this video: mark what this version fixed (mark_fixed).');
  assert.equal(v2.cursor, undefined);
  assert.deepEqual(toCheck(s), [], 'nothing to check before the agent says what it fixed');
  assert.equal(await call('mark_fixed', { id: n1.id, note: 'Title 20 % larger' }), `${n1.id}: fixed in v2\n2 notes still open on this video.`);
  assert.equal(await call('mark_fixed', { id: n2.id, note: 'Logo 6 frames earlier' }), `${n2.id}: fixed in v2\n1 note still open on this video.`);
  const last = await call('mark_fixed', { id: n3.id, note: 'End card held 1 s longer' });
  assert.ok(last.startsWith(`${n3.id}: fixed in v2\n`) && endsWaitNow(last), last);
  assert.deepEqual(toCheck(s).sort(), [n1.id, n2.id, n3.id].sort());
});

test('(b) a version in between: only the note it fixed is to check; the others stay plain open work', async () => {
  const s = (await upload(clip('b.mp4', 310), 'loop-b.mp4')).slug;
  const [n1, n2, n3] = [mia(s, 20, 'Title too small'), mia(s, 60, 'Logo comes in too late', 'should'), mia(s, 100, 'Hold the end card longer', 'nice')];
  await upload(clip('b2.mp4', 410), 'loop-b.mp4', 'loop-b.mp4');
  await call('mark_fixed', { id: n1.id, note: 'Title 20 % larger' });
  assert.deepEqual(toCheck(s), [n1.id], 'one fix to check, not three');
  for (const id of [n2.id, n3.id]) {
    const c = note(s, id);
    assert.deepEqual([c.status, c.check_again, c.carried_to], ['open', undefined, undefined], `${id}: open, nobody fixed it`);
  }
  // the stage and the panel say the same: work going on, and the one fix there is to check
  const st = await stage(s);
  assert.equal(st.detail, '2 notes open on V2 · 1 fix to check in V2');
  // the agent reads its open work as work, and the fix it handed over apart from it
  const open = await call('get_open_notes', { video: 'loop-b.mp4', images: 'none' });
  assert.doesNotMatch(open, /CHECK AGAIN/);
  assert.match(open, new RegExp(`Fixed, waiting for the person's check \\(no work item\\): ${n1.id} \\(v2\\)`));
  // V3 has the other two: each note says the version its own fix is in, and so does the plan's line under its row
  await upload(clip('b3.mp4', 510), 'loop-b.mp4', 'loop-b.mp4');
  await call('mark_fixed', { id: n2.id, note: 'Logo 6 frames earlier' });
  await call('mark_fixed', { id: n3.id, note: 'End card held longer' });
  assert.deepEqual(
    [n1.id, n2.id, n3.id].map((id) => note(s, id).fixed_in_v),
    [2, 3, 3],
  );
  const plan = { id: n2.id, state: 'fixed' as const, v: 2, at: '2026-10-11T10:00:00Z' };
  assert.equal(
    planSaid(plan, 'claude-ai', 3, note(s, n2.id).fixed_in_v)?.words,
    'fixed in V3 · check it',
    'the note’s own record, not the run’s first version',
  );
});

test('(c1) marked fixed before the version: it rides with the next one; a version that does not exist is refused', async () => {
  const s = (await upload(clip('c.mp4', 320), 'loop-c.mp4')).slug;
  const [n1, n2, n3] = [mia(s, 20, 'Title too small'), mia(s, 60, 'Logo comes in too late', 'should'), mia(s, 100, 'Hold the end card longer', 'nice')];
  assert.equal(
    await call('mark_fixed', { id: n1.id, note: 'Title 20 % larger' }),
    `${n1.id}: fixed · rides with your next version\n2 notes still open on this video.`,
  );
  assert.match(await refused('mark_fixed', { id: n2.id, note: 'Logo earlier', v: 2 }), /bad version: there is no v2/);
  assert.deepEqual(toCheck(s), [], 'nothing to check on V1: the fix is in no version yet');
  assert.deepEqual([note(s, n1.id).status, note(s, n1.id).fix_pending], ['open', true]);
  const early = await stage(s);
  assert.deepEqual([early.open, early.to_verify, early.waiting], [2, 0, 1]);
  assert.equal(early.detail, '2 notes open on V1 · 1 fix coming in V2');
  const open = await call('get_open_notes', { video: 'loop-c.mp4', images: 'none' });
  assert.match(open, new RegExp(`Fixed, riding with your next version \\(put it up; no work item\\): ${n1.id}`));
  // V2 takes it along; the two still unmarked are the agent's to mark before it waits
  const v2 = await upload(clip('c2.mp4', 420), 'loop-c.mp4', 'loop-c.mp4');
  assert.equal(v2.next, '2 notes still open on this video: mark what this version fixed (mark_fixed).');
  const c = note(s, n1.id);
  assert.deepEqual([c.status, c.fixed_in_v, c.fix_pending, c.replies.at(-1)?.fixed_in_v], ['fixed', 2, undefined, 2]);
  assert.deepEqual(toCheck(s), [n1.id]);
  assert.equal(note(s, n3.id).check_again, undefined);
});

test('(c2) a version with no fix marked: nothing to check, and its upload says to mark what it fixed', async () => {
  const s = (await upload(clip('c2a.mp4', 330), 'loop-c2.mp4')).slug;
  for (const [f, t] of [
    [20, 'Title too small'],
    [60, 'Logo late'],
    [100, 'End card short'],
  ] as const)
    mia(s, f, t);
  const v2 = await upload(clip('c2b.mp4', 430), 'loop-c2.mp4', 'loop-c2.mp4');
  assert.equal(v2.next, '3 notes still open on this video: mark what this version fixed (mark_fixed).');
  assert.deepEqual(toCheck(s), [], 'a Looks right here would close a note nobody fixed');
  assert.ok(review(s).comments.every((c) => c.status === 'open' && !c.check_again));
});

test('(d) a note written on V1 while V2 renders stays open work on V2, never a fix to check', async () => {
  const s = (await upload(clip('d.mp4', 340), 'loop-d.mp4')).slug;
  const n1 = mia(s, 20, 'Title too small');
  await call('get_open_notes', { video: 'loop-d.mp4', images: 'none' });
  const n2 = mia(s, 70, 'Music too loud here', 'should');
  await upload(clip('d2.mp4', 440), 'loop-d.mp4', 'loop-d.mp4');
  assert.equal(await call('mark_fixed', { id: n1.id, note: 'Title larger' }), `${n1.id}: fixed in v2\n1 note still open on this video.`);
  // and one written on V1 once V2 is up (the person still looking at V1)
  const late = await fetch(`${base}/api/review/${encodeURIComponent(s)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer },
    body: JSON.stringify({ v: 1, frame: 90, text: 'Cut sooner' }),
  });
  assert.equal(late.status, 200, await late.clone().text());
  const n3 = (await late.json()) as Comment;
  assert.equal(n3.v, 1);
  assert.deepEqual(toCheck(s), [n1.id]);
  for (const id of [n2.id, n3.id]) assert.deepEqual([note(s, id).status, note(s, id).check_again], ['open', undefined], id);
});

test('(e) a question that outlives a version is never a fix to check', async () => {
  const s = (await upload(clip('e.mp4', 350), 'loop-e.mp4')).slug;
  const n1 = mia(s, 20, 'Too dark in the first second');
  const asked = await call('add_note', { video: 'loop-e.mp4', frame: 100, text: 'Website or App badge on the end card?', choices: ['Website', 'App badge'] });
  const q = must(/(c_[0-9a-f]{6})/.exec(asked)?.[1], asked);
  await upload(clip('e2.mp4', 450), 'loop-e.mp4', 'loop-e.mp4');
  await call('mark_fixed', { id: n1.id, note: 'Brightened' });
  assert.deepEqual(toCheck(s), [n1.id], 'the question asks, it fixes nothing');
  assert.deepEqual([note(s, q).kind, note(s, q).status, note(s, q).check_again], ['question', 'open', undefined]);
});

test('(h) a part touches only the notes inside its stretch', async () => {
  const whole = makeShotsVideo(path.join(dir, 'renders/h.mp4'));
  const fixed = makeShotsVideo(path.join(dir, 'renders/h-fixed.mp4'), { extra: fixBox(40, 79) });
  const s = (await upload(whole, 'loop-h.mp4')).slug;
  // the shots are found in the background: the stretch a part may cover comes from them
  let shots = await fetch(`${base}/api/review/${encodeURIComponent(s)}/part?v=1&in=50`, { headers: bearer });
  for (let i = 0; i < 300 && ((await shots.clone().json()) as { pending?: boolean }).pending; i++) {
    await sleep(100);
    shots = await fetch(`${base}/api/review/${encodeURIComponent(s)}/part?v=1&in=50`, { headers: bearer });
  }
  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/api/review/${encodeURIComponent(s)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ severity: 'must', ...body }),
    }).then((r) => r.json() as Promise<Comment>);
  const n1 = await post({ frame: 50, text: 'Logo missing', part: { in: 45, out: 60 } });
  assert.deepEqual(n1.part && [n1.part.in, n1.part.out], [40, 79]);
  const n2 = await post({ frame: 100, text: 'End card too short' });
  const n3 = await post({ frame: 110, text: 'End card logo too small' });
  // both marked before the part is up; only the one inside its stretch can be in it
  await call('mark_fixed', { id: n1.id, note: 'Logo back in' });
  await call('mark_fixed', { id: n3.id, note: 'Logo larger' });
  const part = cutFrames(fixed, 28, 92, path.join(dir, 'renders/h-part.mp4'));
  const asked = await call('request_upload', { filename: 'loop-h.mp4', video: 'loop-h.mp4', part_at: 40, handles: 12 });
  const url = must(/https?:\/\/\S+\/api\/uploads\/direct\/vrup_[\w-]+/.exec(asked)?.[0], asked).replace(PUBLIC, base);
  const bytes = fs.readFileSync(part);
  const put = await fetch(url, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const up = (await put.json()) as Upload & { part?: { of: number; at: number; frames: number } };
  assert.equal(put.status, 200, JSON.stringify(up));
  assert.deepEqual(up.part && [up.v, up.part.of, up.part.at, up.part.frames], [2, 1, 40, 40]);
  assert.deepEqual(toCheck(s), [n1.id], 'only the note inside the part is to check on it');
  assert.deepEqual([note(s, n1.id).status, note(s, n1.id).fixed_in_v], ['fixed', 2]);
  assert.deepEqual([note(s, n2.id).status, note(s, n2.id).check_again], ['open', undefined], 'outside the part: untouched');
  assert.deepEqual([note(s, n3.id).status, note(s, n3.id).fix_pending], ['open', true], 'outside the part: still riding with the next version');
  // the full V3 takes the rest along
  await upload(fixed, 'loop-h.mp4', 'loop-h.mp4');
  assert.deepEqual([note(s, n3.id).status, note(s, n3.id).fixed_in_v], ['fixed', 3]);
});
