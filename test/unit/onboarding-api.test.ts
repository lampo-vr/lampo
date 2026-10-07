// The first run on a hosted server, end to end on a real socket: a new account starts with it (one from before never
// does), its steps tick from what the person really did — a video, a note, an agent's call, a review link, an invite —
// and stay ticked, it is put away and brought back, and the sample is made from synthetic footage through the storage
// adapter, never logs an event, never counts as the person's video, and is removed for good in one click.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const store = await import('../../lib/store.ts');
const auth = await import('../../lib/auth.ts');
const { forYou, viewerFor } = await import('../../lib/foryou.ts');
const { setupVariant } = await import('../../lib/onboarding.ts');

const { ctx, request } = await startApp();

const origin = { Origin: PUBLIC };
let owner = '';
const as = (cookie: string) => ({ headers: { Cookie: cookie, ...origin } });
const steps = async (cookie: string) => {
  const r = await request('GET', '/api/onboarding', as(cookie));
  assert.equal(r.status, 200, r.text);
  return r.json();
};
const done = (body: { steps: { id: string; done: boolean }[] }) => body.steps.filter((s) => s.done).map((s) => s.id);
let sampleSlug = '';

test('a new owner starts with the first run: five steps, none done, a sample to make, the setup due', async () => {
  const ok = await request('POST', '/api/auth/setup', {
    body: { email: 'sam@example.com', name: 'Sam Rivera', password: 'correct horse battery', token: ctx.setup.token },
    headers: origin,
  });
  assert.equal(ok.status, 200, ok.text);
  owner = cookieFrom(ok);
  assert.match(ok.json().user.prefs.onboarding.since, /^\d{4}-/);
  assert.equal(ok.json().user.prefs.onboarding.setup_due, true, 'the setup shows on the first visit');
  const s = await steps(owner);
  assert.deepEqual(
    s.steps.map((x: { id: string }) => x.id),
    ['sample', 'video', 'agent', 'invite', 'share'],
    'a self-hosted server’s owner: the first video before agents and invites',
  );
  assert.deepEqual(done(s), []);
  assert.deepEqual([s.sample, s.video, s.can_sample, s.plan, s.invited_by], [null, null, true, null, null]);
});

test('the sample: two versions of the brand film, a fix to check, an idea, the agent’s question — and no event', async () => {
  const events = () => (fs.existsSync(store.EVENTS_FILE) ? fs.readFileSync(store.EVENTS_FILE, 'utf8') : '');
  const before = events();
  const r = await request('POST', '/api/onboarding/sample', { body: { lang: 'en' }, ...as(owner) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json().created, true);
  assert.equal(r.json().name, 'Lampo sample.mp4');
  sampleSlug = r.json().slug;
  const review = store.loadReview(sampleSlug);
  assert.ok(review);
  assert.equal(review.onboarding_sample?.by, 'Sam Rivera', 'marked from its first write, by who asked');
  assert.equal(review.folder, 'Sample');
  assert.deepEqual(
    review.versions.map((v) => [v.v, v.frames, v.width, v.height]),
    [
      [1, 121, 960, 412],
      [2, 121, 960, 412],
    ],
  );
  // through the storage adapter, like any upload
  for (const v of [1, 2]) assert.ok(store.versionAvailable(review, v), `V${v} stored`);
  const [logo, idea, question] = review.comments;
  assert.deepEqual([logo?.severity, logo?.status, logo?.fixed_in_v, logo?.author], ['must', 'fixed', 2, 'Alex']);
  assert.ok(logo?.shots?.marked, 'a screenshot with its drawing');
  assert.equal(logo?.drawing.length, 1);
  assert.deepEqual([idea?.severity, idea?.status, idea?.check_again], ['idea', 'open', false], 'answered, nothing to look at again');
  assert.equal(idea?.replies.at(-1)?.by, 'agent:Sample agent');
  assert.deepEqual([question?.kind, question?.v, question?.author, question?.choices?.length], ['question', 2, 'agent:Sample agent', 2]);
  assert.equal(store.stageFor(review).stage, 'check_fixes', 'one fix to check: the loop, from the person’s side');
  assert.equal(events(), before, 'nothing in events.jsonl: no agent feed, INBOX.md, webhook or push hears of it');
  // the inbox teaches it: the agent's question and the fix to check
  const kinds = forYou(viewerFor(auth.listUsers()[0], 'x'), { server: true })
    .items.filter((i) => i.slug === sampleSlug)
    .map((i) => i.kind)
    .sort();
  assert.deepEqual(kinds, ['question', 'verify']);
  // the library marks it; asking again hands back the same one
  const lib = (await request('GET', '/api/library', as(owner))).json();
  assert.equal(lib.videos.find((v: { slug: string }) => v.slug === sampleSlug)?.sample, true);
  const again = await request('POST', '/api/onboarding/sample', { body: {}, ...as(owner) });
  assert.deepEqual([again.json().slug, again.json().created], [sampleSlug, false]);
  assert.equal((await request('GET', '/api/library', as(owner))).json().videos.length, 1);
});

test('the sample is no video of the person’s: the video step stays open, the steps open the sample meanwhile', async () => {
  const s = await steps(owner);
  assert.deepEqual(done(s), []);
  const review = store.loadReview(sampleSlug);
  const fix = review?.comments.find((c) => c.status === 'fixed');
  const question = review?.comments.find((c) => c.kind === 'question');
  assert.ok(fix && question);
  assert.deepEqual(s.sample, { slug: sampleSlug, name: 'Lampo sample.mp4', check: fix.id, question: question.id }, 'what Open the sample opens');
  assert.equal(s.video.slug, sampleSlug, '“Share a review link” opens the sample while there is nothing else');
  // Insights and the taste leave it out
  const ins = (await request('GET', '/api/insights?period=30d', as(owner))).json();
  assert.ok(!JSON.stringify(ins).includes(sampleSlug), 'not in Insights');
});

test('a note on the sample is no step of an owner’s; answering its agent’s question ticks “Try the sample”, and the tick is kept', async () => {
  const r = await request('POST', `/api/review/${encodeURIComponent(sampleSlug)}/comments`, {
    body: { frame: 40, text: 'Let the opening settle a beat longer', severity: 'nice' },
    ...as(owner),
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(done(await steps(owner)), []);
  const question = store.loadReview(sampleSlug)?.comments.find((c) => c.kind === 'question');
  assert.ok(question?.choices?.length);
  const answer = await request('PATCH', `/api/comments/${question.id}`, { body: { note: question.choices[0] }, ...as(owner) });
  assert.equal(answer.status, 200, answer.text);
  const s = await steps(owner);
  assert.deepEqual(done(s), ['sample']);
  assert.match(s.onboarding.done.sample, /^\d{4}-/, 'recorded on the account');
  const status = (await request('GET', '/api/auth/status', as(owner))).json();
  assert.ok(status.user.prefs.onboarding.done.sample, 'every device sees it from the account');
});

let realSlug = '';
test('a real upload ticks “Add your first video”, and the steps go to it from now on', async () => {
  const file = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  const up = await tusUpload(request, file, { filename: 'spot.mp4', folder: 'Acme' }, as(owner).headers);
  assert.ok(up.status === 200 || up.status === 204, up.text);
  realSlug = (await request('GET', '/api/library', as(owner))).json().videos.find((v: { sample?: true }) => !v.sample).slug;
  const s = await steps(owner);
  assert.deepEqual(done(s), ['sample', 'video']);
  assert.equal(s.video.slug, realSlug);
});

test('a review link, an invite and an agent’s call tick the rest; then it is finished', async () => {
  assert.equal((await request('POST', `/api/review/${encodeURIComponent(realSlug)}/shares`, { body: { label: 'Client' }, ...as(owner) })).status, 200);
  assert.deepEqual(done(await steps(owner)), ['sample', 'video', 'share']);
  const inv = await request('POST', '/api/admin/invites', { body: { role: 'reviewer' }, ...as(owner) });
  assert.equal(inv.status, 200, inv.text);
  assert.deepEqual(done(await steps(owner)), ['sample', 'video', 'invite', 'share']);
  // an agent talks to Lampo with the person's token (vr, an MCP client)
  const tok = (await request('POST', '/api/auth/tokens', { body: { name: 'claude' }, ...as(owner) })).json().token;
  assert.equal((await request('GET', '/api/library', { headers: { Authorization: `Bearer ${tok}` } })).status, 200);
  const s = await steps(owner);
  assert.deepEqual(done(s), ['sample', 'video', 'agent', 'invite', 'share']);
  assert.match(s.onboarding.complete, /^\d{4}-/);
});

test('a step done once stays done when what did it is gone', async () => {
  const del = await request('DELETE', `/api/library/${encodeURIComponent(realSlug)}`, as(owner));
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(done(await steps(owner)), ['sample', 'video', 'agent', 'invite', 'share']);
});

test('put away and brought back; only the account’s own, never through the profile', async () => {
  const hide = await request('PUT', '/api/onboarding', { body: { hidden: true }, ...as(owner) });
  assert.equal(hide.status, 200, hide.text);
  assert.match(hide.json().onboarding.hidden, /^\d{4}-/);
  assert.equal((await request('PUT', '/api/onboarding', { body: { hidden: 'yes' }, ...as(owner) })).status, 400);
  assert.equal((await request('PUT', '/api/onboarding', { body: { hidden: false, done: {} }, ...as(owner) })).status, 400, 'no steps from outside');
  assert.equal((await request('PUT', '/api/onboarding', { body: {}, ...as(owner) })).status, 400, 'something to change');
  const back = await request('PUT', '/api/onboarding', { body: { hidden: false }, ...as(owner) });
  assert.equal(back.json().onboarding.hidden, undefined);
  // hidden for good (the card and the sidebar's row), on its own field: the card's × is another choice
  const gone = await request('PUT', '/api/onboarding', { body: { dismissed: true }, ...as(owner) });
  assert.equal(gone.status, 200, gone.text);
  assert.match(gone.json().onboarding.dismissed, /^\d{4}-/);
  assert.equal(gone.json().onboarding.hidden, undefined, 'the card’s own choice is left as it was');
  const again = await request('PUT', '/api/onboarding', { body: { dismissed: true }, ...as(owner) });
  assert.equal(again.json().onboarding.dismissed, gone.json().onboarding.dismissed, 'the first time is kept');
  assert.equal((await request('PUT', '/api/onboarding', { body: { dismissed: 1 }, ...as(owner) })).status, 400);
  const backAll = await request('PUT', '/api/onboarding', { body: { dismissed: false, hidden: false }, ...as(owner) });
  assert.equal(backAll.json().onboarding.dismissed, undefined);
  // a step can't be ticked from the outside: prefs are strict and have no way to write it
  assert.equal((await request('PATCH', '/api/auth/me', { body: { prefs: { onboarding: { since: 'x', done: { video: 'x' } } } }, ...as(owner) })).status, 400);
});

test('an invited reviewer starts with a first run of their own: the sample, a note, an approval — and no sample to make', async () => {
  const { users } = (await request('GET', '/api/admin/users', as(owner))).json();
  assert.equal(users.length, 1);
  const made = await request('POST', '/api/admin/invites', { body: { role: 'reviewer', email: 'mia@example.com' }, ...as(owner) });
  const token = /inv_[A-Za-z0-9_-]{32}/.exec(made.json().url)?.[0];
  assert.ok(token, made.json().url);
  const acc = await request('POST', '/api/auth/invite/accept', {
    body: { token, name: 'Mia', email: 'mia@example.com', password: 'another fine password' },
    headers: origin,
  });
  assert.equal(acc.status, 200, acc.text);
  const mia = cookieFrom(acc);
  const s = await steps(mia);
  assert.deepEqual(
    s.steps.map((x: { id: string }) => x.id),
    ['sample', 'note', 'approve'],
  );
  assert.equal(s.can_sample, false);
  assert.deepEqual(s.invited_by, { name: 'Sam Rivera', role: 'owner' }, 'who invited them, for their Welcome');
  assert.equal((await request('POST', '/api/onboarding/sample', { body: {}, ...as(mia) })).status, 403, 'a reviewer adds no video');
  assert.equal((await request('DELETE', '/api/onboarding/sample', as(mia))).status, 403);
  // checking the sample's fix closes its loop: "Try the sample"
  const fix = store.loadReview(sampleSlug)?.comments.find((c) => c.status === 'fixed');
  assert.ok(fix);
  const v = await request('PATCH', `/api/comments/${fix.id}`, { body: { status: 'verified' }, ...as(mia) });
  assert.equal(v.status, 200, v.text);
  assert.deepEqual(done(await steps(mia)), ['sample']);
  assert.equal((await steps(mia)).sample.check, null, 'nothing waits for a check any more');
});

test('an account from before the first run never has one, and can’t be given one by asking', async () => {
  auth.setOnboarding(false);
  const old = await auth.createUser({ email: 'old@example.com', name: 'Olga', password: 'a long password here', role: 'member' });
  auth.setOnboarding(true);
  assert.equal(old.prefs, undefined);
  const login = await request('POST', '/api/auth/login', { body: { email: 'old@example.com', password: 'a long password here' }, headers: origin });
  const olga = cookieFrom(login);
  const s = await steps(olga);
  assert.deepEqual([s.onboarding, s.steps], [null, []]);
  assert.equal((await request('PUT', '/api/onboarding', { body: { hidden: false }, ...as(olga) })).status, 404);
  assert.equal(auth.getUser(old.id)?.prefs, undefined, 'looking wrote nothing');
});

test('removing the sample: one click, everything gone (renders, notes, screenshots), the store as before', async () => {
  const review = store.loadReview(sampleSlug);
  assert.ok(review);
  const r = await request('DELETE', '/api/onboarding/sample', as(owner));
  assert.deepEqual(r.json(), { ok: true, removed: sampleSlug });
  assert.equal(store.loadReview(sampleSlug), null);
  assert.ok(!fs.existsSync(path.join(dir, 'data', sampleSlug)), 'review, notes and screenshots');
  assert.ok(!fs.existsSync(path.join(dir, 'data-versions', sampleSlug)) && !store.versionAvailable(review, 1), 'its renders');
  assert.ok(!(await request('GET', '/api/library', as(owner))).json().videos.some((v: { slug: string }) => v.slug === sampleSlug));
  assert.deepEqual((await request('DELETE', '/api/onboarding/sample', as(owner))).json(), { ok: true, removed: null }, 'nothing left to remove');
  // made again on asking, in German this time
  const de = await request('POST', '/api/onboarding/sample', { body: { lang: 'de' }, ...as(owner) });
  assert.equal(de.json().name, 'Lampo-Beispiel.mp4');
  assert.equal(store.loadReview(de.json().slug)?.folder, 'Beispiel');
  assert.equal((await request('POST', '/api/onboarding/sample', { body: { lang: 'fr' }, ...as(owner) })).status, 400);
});

test('the routes are in the permission table: hiding is your own, the sample needs `upload`', async () => {
  const { ruleFor } = await import('../../server/permissions.ts');
  assert.deepEqual(ruleFor('PUT', '/api/onboarding'), { rule: 'self', listed: true });
  assert.deepEqual(ruleFor('POST', '/api/onboarding/sample'), { rule: 'upload', listed: true });
  assert.deepEqual(ruleFor('DELETE', '/api/onboarding/sample'), { rule: 'upload', listed: true });
  assert.equal(ruleFor('GET', '/api/onboarding').rule, 'view');
});

test('an admin invited into the server’s first workspace gets an invited teammate’s setup, never the server’s', async () => {
  // the server's setup (name it, check it, invite the team) is its owner's: an invited admin saw it on a live server
  const made = await request('POST', '/api/admin/invites', { body: { role: 'admin', email: 'lea@example.com' }, ...as(owner) });
  const token = /inv_[A-Za-z0-9_-]{32}/.exec(made.json().url)?.[0];
  assert.ok(token, made.json().url);
  const acc = await request('POST', '/api/auth/invite/accept', {
    body: { token, name: 'Lea', email: 'lea@example.com', password: 'another fine password' },
    headers: origin,
  });
  assert.equal(acc.status, 200, acc.text);
  const variant = async (cookie: string) => {
    const st = (await request('GET', '/api/auth/status', as(cookie))).json();
    return setupVariant({
      role: st.user.role,
      machine: st.via === 'local',
      signupWorkspace: !!st.workspace?.signup,
      firstWorkspace: !st.workspace || st.workspace.id === 'w1',
      invited: !!st.workspace?.invited,
      operator: !!st.operator,
    });
  };
  assert.equal(await variant(cookieFrom(acc)), 'invited');
  assert.equal(await variant(owner), 'server', 'the owner who set the server up still gets its setup');
});
