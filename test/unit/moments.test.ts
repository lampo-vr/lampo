// The conversion moments (server/routes/moments.ts, lib/moments.ts) and where the funnel's steps are counted
// (server/funnel.ts): "Not now" is kept with the account, so a moment put away in one browser stays away in every other
// and comes back with Undo, per workspace; the first fix a person checks on a video of their own waits for them as the
// loop's moment, the first review link opened waits for whoever made it (by the link's name, never the visitor's), each
// once per workspace and gone once shown; tokens never write any of it. With no billing module nothing is counted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const ws = await import('../../lib/workspaces.ts');
const funnel = await import('../../lib/funnel.ts');
const { NO_EXTENSION } = await import('../../server/extension.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const DAY = 86_400_000;

async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), ...origin };
}
const steps = () => (fs.existsSync(funnel.FUNNEL_FILE) ? JSON.parse(fs.readFileSync(funnel.FUNNEL_FILE, 'utf8')).workspaces.w1?.steps : undefined) ?? {};

const mia = await auth.createUser({ email: 'mia@example.com', name: 'Mia', password: PASSWORD, role: 'owner' });
await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const laptop = await signIn('mia@example.com');
const phone = await signIn('mia@example.com');
const maxs = await signIn('max@example.com');
const token = { Authorization: `Bearer ${auth.createToken(mia.id, 'agent').token}` };

test('without a billing module nothing waits and nothing is counted (a self-hosted server)', async () => {
  const clip = makeVideo(path.join(dir, 'in/early.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'early.mp4' }, token);
  assert.equal(up.status, 200, up.text);
  assert.equal(fs.existsSync(funnel.FUNNEL_FILE), false, fs.existsSync(funnel.FUNNEL_FILE) ? fs.readFileSync(funnel.FUNNEL_FILE, 'utf8') : 'no file');
  const r = await request('GET', '/api/moments', { headers: laptop });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json(), { hidden: {}, pending: [] });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('"Not now" holds on every device: put away on the laptop, away on the phone; Undo brings it back', async () => {
  // Lampo Cloud from here on: a module that bills (its routes don't matter here)
  ctx.extension = { ...NO_EXTENSION, name: 'test-billing', billing: true };
  const until = new Date(Date.now() + 14 * DAY).toISOString();
  const put = await request('PUT', '/api/moments/loop', { body: { until }, headers: laptop });
  assert.equal(put.status, 200, put.text);
  const seen = await request('GET', '/api/moments', { headers: phone });
  assert.equal(seen.status, 200, seen.text);
  assert.deepEqual(seen.json().hidden, { loop: until }, 'the other session reads it from the account');
  assert.deepEqual((await request('GET', '/api/moments', { headers: maxs })).json().hidden, {}, 'only Mia’s');
  // Undo
  assert.equal((await request('PUT', '/api/moments/loop', { body: { until: null }, headers: phone })).status, 200);
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().hidden, {});
  assert.equal(auth.getUser(mia.id)?.prefs?.moments, undefined, 'nothing left in the account once nothing is put away');
});

test('put away per workspace: the same person in another workspace sees it', async () => {
  const until = new Date(Date.now() + 14 * DAY).toISOString();
  assert.equal((await request('PUT', '/api/moments/banner', { body: { until }, headers: laptop })).status, 200);
  const other = ws.createWorkspace({ name: 'Mia Freelance', ownerId: mia.id });
  const sw = await request('POST', '/api/workspaces/switch', { body: { id: other.id }, headers: phone });
  assert.equal(sw.status, 200, sw.text);
  const there = { Cookie: cookieFrom(sw) || phone.Cookie, ...origin };
  assert.deepEqual((await request('GET', '/api/moments', { headers: there })).json().hidden, {}, 'nothing put away there');
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().hidden, { banner: until }, 'still away here');
  const prefs = auth.getUser(mia.id)?.prefs?.moments ?? {};
  assert.deepEqual(Object.keys(prefs), ['w1'], 'kept under the workspace it was put away in');
});

test('only sensible dates, only known moments, people only', async () => {
  const past = new Date(Date.now() - DAY).toISOString();
  const far = new Date(Date.now() + 120 * DAY).toISOString();
  for (const until of [past, far, 'tomorrow', 3])
    assert.equal((await request('PUT', '/api/moments/loop', { body: { until }, headers: laptop })).status, 400, String(until));
  assert.equal((await request('PUT', '/api/moments/anything', { body: { until: null }, headers: laptop })).status, 400);
  const byToken = await request('PUT', '/api/moments/loop', { body: { until: null }, headers: token });
  assert.equal(byToken.status, 403, byToken.text);
  assert.equal(byToken.json().person, true);
  assert.equal((await request('POST', '/api/moments/event', { body: { e: 'shown', id: 'loop' }, headers: token })).status, 403);
  assert.equal((await request('POST', '/api/moments/loop/seen', { headers: token })).status, 403);
  assert.equal((await request('GET', '/api/moments')).status, 401, 'signed out');
});

let slug = '';
test('a link on the sample, and a visitor opening it, are no first link and no moment', async () => {
  const made = await request('POST', '/api/onboarding/sample', { body: {}, headers: laptop });
  assert.equal(made.status, 200, made.text);
  const sample = ws.inWorkspace('w1', () => store.listReviews().find((r) => r.onboarding_sample));
  assert.ok(sample?.folder, 'the sample, in its project');
  const video = (await request('POST', `/api/review/${encodeURIComponent(made.json().slug)}/shares`, { body: { label: 'Try it' }, headers: laptop })).json();
  const folder = (await request('POST', '/api/folder-shares', { body: { folder: sample.folder, label: 'Its project' }, headers: laptop })).json();
  for (const link of [video, folder]) {
    assert.ok(link.token, JSON.stringify(link));
    assert.equal((await request('POST', `/api/g/${link.token}/visit`, { body: { name: 'Sam' }, headers: origin })).status, 200);
  }
  assert.equal(steps().link_first, undefined, 'no first link');
  assert.equal(steps().link_opened_first, undefined, 'no first link opened');
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().pending, [], 'nothing waits for its maker');
  // the sample goes again: the tests below start where a workspace without one does
  assert.equal((await request('DELETE', '/api/onboarding/sample', { headers: laptop })).status, 200);
});

test('the first video, link and fix: the funnel’s steps, once per workspace', async () => {
  const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'spot.mp4' }, token);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  assert.ok(steps().video_first, 'the first video of its own');
  const link = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Harbor Coffee · Hannah' }, headers: laptop });
  assert.equal(link.status, 200, link.text);
  assert.ok(steps().link_first);
  const text = fs.readFileSync(funnel.FUNNEL_FILE, 'utf8');
  for (const who of ['mia', 'Mia', 'Hannah', slug]) assert.ok(!text.includes(who), `the funnel names nobody and nothing: ${who}`);
});

test('the first fix Max checks on a video of their own waits for Max as the loop, once; seen, it never waits again', async () => {
  const n = ws.inWorkspace('w1', () => store.addComment(slug, { frame: 3, text: 'Logo later', author: 'Mia' }));
  ws.inWorkspace('w1', () => store.updateComment(n.id, { status: 'fixed', note: 'moved', by: 'agent:spot' }));
  const check = await request('PATCH', `/api/comments/${n.id}`, { body: { status: 'verified' }, headers: maxs });
  assert.equal(check.status, 200, check.text);
  assert.ok(steps().fix_checked_first, 'the funnel’s step');
  const max1 = (await request('GET', '/api/moments', { headers: maxs })).json();
  assert.equal(max1.pending.length, 1, JSON.stringify(max1));
  assert.deepEqual({ ...max1.pending[0], at: 'x' }, { id: 'loop', at: 'x', slug });
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().pending, [], 'not Mia’s');
  assert.deepEqual((await request('POST', '/api/moments/loop/seen', { headers: laptop })).json(), { ok: false }, 'only its own person marks it');
  assert.deepEqual((await request('POST', '/api/moments/loop/seen', { headers: maxs })).json(), { ok: true });
  assert.deepEqual((await request('GET', '/api/moments', { headers: maxs })).json().pending, []);
  // a second fix checked: the workspace had its loop
  const m = ws.inWorkspace('w1', () => store.addComment(slug, { frame: 4, text: 'Brighter', author: 'Mia' }));
  ws.inWorkspace('w1', () => store.updateComment(m.id, { status: 'fixed', note: 'done', by: 'agent:spot' }));
  assert.equal((await request('PATCH', `/api/comments/${m.id}`, { body: { status: 'verified' }, headers: laptop })).status, 200);
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().pending, []);
  assert.equal((await request('POST', '/api/moments/nope/seen', { headers: maxs })).status, 400);
});

test('the first link opened waits for whoever made it, named by the link alone; the team’s own preview doesn’t count', async () => {
  const link = (await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Coast · Jo' }, headers: laptop })).json();
  // Mia previewing her own link: no visit
  assert.equal((await request('POST', `/api/g/${link.token}/visit`, { body: {}, headers: laptop })).status, 200);
  assert.equal(steps().link_opened_first, undefined, 'the team’s preview is no opening');
  assert.deepEqual((await request('GET', '/api/moments', { headers: laptop })).json().pending, []);
  const visit = await request('POST', `/api/g/${link.token}/visit`, { body: { name: 'Jo Visitor' }, headers: origin });
  assert.equal(visit.status, 200, visit.text);
  assert.ok(steps().link_opened_first);
  const p = (await request('GET', '/api/moments', { headers: laptop })).json().pending;
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.deepEqual({ ...p[0], at: 'x' }, { id: 'link_open', at: 'x', link: 'Coast · Jo', slug });
  assert.ok(!JSON.stringify(p).includes('Jo Visitor'), 'never the visitor’s name');
  assert.deepEqual((await request('GET', '/api/moments', { headers: maxs })).json().pending, [], 'only for its maker');
});

test('what a moment did is counted per week, never who; a place is one of our short words', async () => {
  for (const b of [
    { e: 'shown', id: 'trial_popover', where: 'sidebar' },
    { e: 'used', id: 'trial_popover', where: 'sidebar' },
    { e: 'dismissed', id: 'banner' },
  ])
    assert.equal((await request('POST', '/api/moments/event', { body: b, headers: laptop })).status, 200);
  for (const b of [
    { e: 'shown', id: 'trial_popover', where: 'Mia’s sidebar' },
    { e: 'shown', id: 'x' },
    { e: 'shown', id: 'loop', who: 'mia' },
  ])
    assert.equal((await request('POST', '/api/moments/event', { body: b, headers: laptop })).status, 400, JSON.stringify(b));
  const week = Object.values(JSON.parse(fs.readFileSync(funnel.FUNNEL_FILE, 'utf8')).moments)[0] as Record<string, number>;
  assert.deepEqual(week, { 'trial_popover|sidebar|shown': 1, 'trial_popover|sidebar|used': 1, 'banner||dismissed': 1 });
});
