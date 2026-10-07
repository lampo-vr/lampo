// Agents' runs on a hosted server, end to end: a member's Send opens the run of the video's agent (queued), its first
// call begins it, the read API (GET /api/runs?slug=, GET /api/runs/:id), the library's card line and the SSE `run`
// show it; who may open one (a reviewer's notes go out, and open nothing) and who may stop it (a person with the agents
// right, never an API token); and nobody reaches it without an account (a review link has no way to it).
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import type { LibraryResponse, Run, RunDetail, RunsResponse, VideoSummary } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');
const { slugify } = await import('../../lib/paths.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
const { ctx, request } = await startApp({ headers: { Connection: 'close' }, feed: 50 });
const heard: { type: string; data: { slug?: string | null; id?: string } }[] = [];
ctx.hub.listen((type, data) => heard.push({ type, data: data as { slug?: string; id?: string } }));

const as: Record<'alice' | 'mia' | 'rafa' | 'miaToken' | 'rafaToken', Record<string, string>> = { alice: {}, mia: {}, rafa: {}, miaToken: {}, rafaToken: {} };
let slug = '';
let link = '';
const AGENT = 'cloud-cut · Mia';
const enc = () => encodeURIComponent(slug);

before(async () => {
  for (const [name, role] of [
    ['alice', 'owner'],
    ['mia', 'member'],
    ['rafa', 'reviewer'],
  ] as const) {
    const u = await auth.createUser({ email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), password: `${name}s password 1`, role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    if (name === 'mia') as.miaToken = { Authorization: `Bearer ${auth.createToken(u.id, 'agent').token}` };
    if (name === 'rafa') as.rafaToken = { Authorization: `Bearer ${auth.createToken(u.id, 'phone').token}` };
  }
  const up = await store.ingestUpload(spot, { name: 'spot.mp4', folder: 'Acme', by: 'Alice', keep: true });
  slug = slugify(up.review.video);
  // Mia's agent, as the MCP endpoint lists a connected client of hers
  store.assignSession(slug, { name: AGENT, sessionId: 'mcp-0123456789ab', agent: 'claude-code' }, 'Alice');
  link = shares.createShare(slug, { label: 'Client', by: 'Alice' }).token;
});

const draft = async (who: Record<string, string>, text: string) => {
  const r = await request('POST', `/api/review/${enc()}/drafts`, { body: { frame: 3, text, severity: 'must' }, headers: who });
  assert.equal(r.status, 200, r.text);
  return r.json().id as string;
};
const send = async (who: Record<string, string>) => {
  const r = await request('POST', `/api/review/${enc()}/drafts/send`, { body: {}, headers: who });
  assert.equal(r.status, 200, r.text);
  return (r.json().notes as { id: string }[]).map((n) => n.id);
};
const runs = async (who: Record<string, string> = as.mia) => {
  const r = await request('GET', `/api/runs?slug=${enc()}`, { headers: who });
  assert.equal(r.status, 200, r.text);
  return (r.json() as RunsResponse).runs;
};
const runEvents = () => store.readEvents({ limit: 5000 }).filter((e) => e.type === 'run');

let first: Run;

test('a member’s Send opens the run of the video’s agent: queued, its plan the notes sent; the read API shows it', async () => {
  const ids = [await draft(as.mia, 'Logo too late'), await draft(as.mia, 'Caption too low')];
  const sent = await send(as.mia);
  assert.deepEqual(sent.sort(), ids.sort());
  const list = await runs();
  assert.equal(list.length, 1);
  first = list[0] as Run;
  assert.match(first.id, /^run_[0-9a-f]{12}$/);
  assert.equal(first.state, 'queued');
  assert.equal(first.slug, slug);
  assert.equal(first.agent.name, AGENT);
  assert.deepEqual(first.opened_by, { who: 'Mia', id: auth.findUserByEmail('mia@example.com')?.id, how: 'send' });
  assert.deepEqual(first.plan.map((p) => [p.id, p.state]).sort(), ids.map((id) => [id, 'todo']).sort());
  assert.equal(first.delivery, 'listening');
  assert.equal(first.ended, null);
  assert.equal(first.worked_s, 0);
  assert.equal(Object.hasOwn(first, 'steps') || Object.hasOwn(first, 'clock'), false, 'the head only');
  const one = await request('GET', `/api/runs/${first.id}`, { headers: as.mia });
  assert.equal(one.status, 200, one.text);
  const detail = one.json() as RunDetail;
  assert.equal(detail.run.id, first.id);
  assert.deepEqual(detail.steps, []);
  const opened = runEvents().find((e) => e.run === first.id && e.phase === 'opened');
  assert.equal(opened?.by, 'Mia');
  assert.equal(opened?.text, 'send');
  await until(() => heard.some((h) => h.type === 'run' && h.data.id === first.id && h.data.slug === slug), 'the SSE run event');
});

test('the library’s card line: the open run in brief, also in the one-video form the UI asks on `run`', async () => {
  for (const url of ['/api/library', `/api/library?slug=${enc()}`]) {
    const lib = (await request('GET', url, { headers: as.mia })).json() as LibraryResponse;
    const v = lib.videos.find((x) => x.slug === slug) as VideoSummary;
    assert.equal(v.run?.id, first.id, url);
    assert.equal(v.run?.state, 'queued');
    assert.equal(v.run?.planned, 2);
    assert.equal(v.run?.answered, 0);
    assert.equal(v.run?.agent.name, AGENT);
  }
});

test('the agent’s first call begins it: working, its words now and a kept step; a `started` event and an SSE `run`', async () => {
  heard.length = 0;
  const entries = [
    { at: new Date().toISOString(), agent: 'cloud-cut', kind: 'read', text: 'Reading the open notes', key: 'Reading the open notes', video: slug },
  ];
  const r = await request('POST', '/api/agents/activity', { body: { entries }, headers: as.miaToken });
  assert.equal(r.status, 200, r.text);
  const run = await until(async () => {
    const x = (await runs())[0];
    return x?.state === 'working' ? x : null;
  }, 'the run to begin');
  assert.equal(run.now?.text, 'Reading the open notes');
  assert.equal(run.now?.type, 'action');
  const detail = (await request('GET', `/api/runs/${run.id}`, { headers: as.mia })).json() as RunDetail;
  assert.deepEqual(
    detail.steps.map((s) => [s.type, s.text]),
    [['action', 'Reading the open notes']],
  );
  assert.ok(runEvents().some((e) => e.run === run.id && e.phase === 'started'));
  await until(() => heard.some((h) => h.type === 'run' && h.data.id === run.id), 'the SSE run event');
  assert.ok(!heard.some((h) => h.type === 'review'), 'a step never makes every open player refetch');
});

test('whoever may read the video reads its runs (a reviewer without the agent’s session); nobody without an account', async () => {
  for (const who of [as.alice, as.rafa, as.rafaToken, as.miaToken]) assert.equal((await runs(who))[0]?.id, first.id);
  assert.equal((await runs(as.mia))[0]?.agent.session_id, 'mcp-0123456789ab', 'who works with agents sees which session');
  assert.equal((await runs(as.rafa))[0]?.agent.session_id, undefined, 'a reviewer doesn’t');
  const card = (await request('GET', `/api/library?slug=${enc()}`, { headers: as.rafa })).json() as LibraryResponse;
  assert.equal(card.videos[0]?.run?.agent.session_id, undefined, 'nor on the card');
  for (const url of [`/api/runs?slug=${enc()}`, `/api/runs/${first.id}`]) {
    assert.equal((await request('GET', url)).status, 401, url);
    assert.equal((await request('GET', `${url}${url.includes('?') ? '&' : '?'}t=${link}`)).status, 401, `${url} with a link token`);
    assert.equal((await request('GET', url, { headers: { Cookie: `vr_session=${link}` } })).status, 401, `${url} with a link token as a cookie`);
  }
  assert.equal((await request('GET', '/api/runs/run_000000000000', { headers: as.mia })).status, 404);
  assert.equal((await request('GET', '/api/runs/nope', { headers: as.mia })).status, 404);
  assert.equal((await request('GET', '/api/runs?slug=nope', { headers: as.mia })).status, 404);
  assert.equal((await request('GET', '/api/runs', { headers: as.mia })).status, 400);
  // the raw log is the machine's (a hosted server never has one)
  assert.equal((await request('GET', `/api/runs/${first.id}/log`, { headers: as.mia })).status, 403);
});

test('a reviewer’s Send goes out and opens nothing; Ask and stop are the agents right’s, never an API token’s', async () => {
  const note = await draft(as.rafa, 'Too dark here');
  assert.deepEqual(await send(as.rafa), [note]);
  const list = await runs();
  assert.equal(list.length, 1, 'no run of the reviewer’s');
  assert.ok(!list[0]?.plan.some((p) => p.id === note), 'nor a note added to the open one');
  assert.equal((await request('POST', `/api/review/${enc()}/request`, { body: { text: 'go' }, headers: as.rafa })).status, 403);
  for (const who of [as.rafa, as.rafaToken, as.miaToken])
    for (const what of ['stop', 'retry', 'nudge'])
      assert.equal((await request('POST', `/api/runs/${first.id}/${what}`, { body: {}, headers: who })).status, 403, what);
  assert.equal((await runs())[0]?.state, 'working', 'still going');
});

test('a second Send adds to the open run (added while it works); Stop ends it at once', async () => {
  const later = await draft(as.mia, 'Music too loud');
  await send(as.mia);
  const run = (await runs())[0] as Run;
  assert.equal(run.id, first.id, 'one open run per agent and video');
  assert.deepEqual(run.plan.find((p) => p.id === later)?.added, true);
  const stopped = await request('POST', `/api/runs/${first.id}/stop`, { body: {}, headers: as.mia });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json().run.state, 'stopped');
  assert.ok(stopped.json().run.ended);
  const ended = runEvents().find((e) => e.run === first.id && e.phase === 'ended');
  assert.equal(ended?.by, 'Mia');
  assert.equal(ended?.text, 'stopped');
  // the card shows the last ended in the past day
  const lib = (await request('GET', `/api/library?slug=${enc()}`, { headers: as.mia })).json() as LibraryResponse;
  assert.equal(lib.videos[0]?.run?.state, 'stopped');
});

test('Ask opens the next run with the person’s words; Try again follows a run that ended', async () => {
  const asked = await request('POST', `/api/review/${enc()}/request`, { body: { text: 'Make the\nlogo bigger' }, headers: as.mia });
  assert.equal(asked.status, 200, asked.text);
  const [run] = await runs();
  assert.notEqual(run?.id, first.id);
  assert.equal(run?.opened_by.how, 'request');
  assert.equal(run?.request, 'Make the ↵ logo bigger', 'one line');
  assert.equal((await request('POST', `/api/runs/${first.id}/retry`, { body: {}, headers: as.mia })).status, 409, 'that agent is at it already');
  await request('POST', `/api/runs/${run?.id}/stop`, { body: {}, headers: as.mia });
  const retry = await request('POST', `/api/runs/${first.id}/retry`, { body: {}, headers: as.mia });
  assert.equal(retry.status, 200, retry.text);
  const next = retry.json().run as Run;
  assert.equal(next.follows, first.id);
  assert.equal(next.opened_by.how, 'retry');
  assert.equal(next.state, 'queued');
  assert.ok(next.plan.length >= 2, 'the notes still open');
  assert.ok(
    store.readEvents({ limit: 100 }).some((e) => e.type === 'request' && /Try again/.test(e.text ?? '')),
    'a listening agent hears it',
  );
});

test('a run id an agent posts is a hint: never another account’s run, never another workspace’s', async () => {
  const ws = await import('../../lib/workspaces.ts');
  // the run Try again opened for Mia's agent: queued, nobody at it yet
  const run = (await runs()).find((x) => x.ended === null && x.agent.name === AGENT) as Run;
  assert.equal(run.state, 'queued');
  const mal = await auth.createUser({ email: 'mal@example.com', name: 'Mallory', password: 'mallorys password 1', role: 'member' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: 'bobs password 1', role: 'member' });
  const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  ws.removeMember('w1', bob.id);
  const tokens = {
    // another member of the workspace, posting as Mia's agent's name and naming her run
    mallory: { Authorization: `Bearer ${auth.createToken(mal.id, 'agent').token}` },
    // a member of another workspace only: its token works there
    bob: { Authorization: `Bearer ${auth.createToken(bob.id, 'agent', { workspace: B }).token}` },
  };
  for (const [who, headers] of Object.entries(tokens)) {
    const entries = [
      { at: new Date().toISOString(), agent: 'cloud-cut', kind: 'fix', text: 'Fixed everything', key: 'Fixed a note', video: slug, run: run.id },
      { at: new Date().toISOString(), agent: 'cloud-cut · Mia', kind: 'read', text: 'Reading the open notes', key: 'Reading the open notes', run: run.id },
    ];
    const r = await request('POST', '/api/agents/activity', { body: { entries }, headers });
    assert.equal(r.status, 200, `${who}: ${r.text}`);
  }
  const after = (await runs()).find((x) => x.id === run.id) as Run;
  assert.equal(after.now, null, 'nothing joined Mia’s run');
  assert.equal(after.state, 'queued');
  assert.equal(after.agent.name, AGENT, 'nor did another account take it');
  // Mallory's write opened her own agent's run (under her name), beside Mia's
  assert.ok((await runs()).some((x) => x.agent.name === 'cloud-cut · Mallory' && x.opened_by.how === 'agent'));
  assert.ok(!(await runs()).some((x) => x.agent.name.endsWith('· Bob')), 'nothing of B’s in this workspace');
});

test('the agent’s upload with its person’s token: its progress joins the run, and the version it makes names it', async () => {
  const run = (await runs()).find((x) => x.ended === null && x.agent.name === AGENT) as Run;
  const entries = [
    { at: new Date().toISOString(), agent: 'cloud-cut', kind: 'read', text: 'Reading the open notes', key: 'Reading the open notes', video: slug },
  ];
  assert.equal((await request('POST', '/api/agents/activity', { body: { entries }, headers: as.miaToken })).status, 200);
  await until(async () => (await runs()).find((x) => x.id === run.id)?.state === 'working', 'the run to begin');
  const v2 = makeVideo(path.join(dir, 'renders/spot-v2.mp4'), { w: 160, h: 90, fps: 25, dur: 1, pattern: 'rgbtestsrc' });
  const up = await tusUpload(request, v2, { filename: 'spot.mp4', slug }, as.miaToken);
  assert.equal(up.status, 200, up.text);
  // (a second workspace exists now: the test reads the first one's store by name)
  const { inWorkspace } = await import('../../lib/scope.ts');
  assert.equal(
    inWorkspace('w1', () => store.loadReview(slug)?.versions.at(-1)?.run),
    run.id,
    'V2 names the run',
  );
  const after = await until(async () => {
    const x = (await runs()).find((r) => r.id === run.id);
    return x?.result?.v === 2 ? x : null;
  }, 'the version as its result');
  assert.equal(after.progress, null, 'its upload is done');
  assert.ok(!(await runs()).some((x) => x.agent.name === 'Mia'), 'an upload under the account’s name opened no run of its own');
});
