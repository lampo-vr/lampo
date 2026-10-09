// Agents' runs on a hosted server, held to their bounds and to whose they are: what one member's token can open (open
// runs per video and per account; the agent's own activity still shows live), what a runs file may hold (its bytes:
// steps only for the newest ended runs, open runs not heard from dropped first), whose a run is (its agent's account,
// by id: a name that ends like another's never takes or joins it, and "·" can't be in an account's name), what a
// reviewer reads of one (where it stands, never its steps or a tool's last words), a person's requests in their own
// export, and one ping per agent and video when its work fails again and again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import type { LibraryResponse, Run, RunDetail, RunsResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const lib = await import('../../lib/runs.ts');
const { slugify } = await import('../../lib/paths.ts');
const { words, ownedAgentName } = await import('../../lib/activityText.ts');
const { accountExport } = await import('../../lib/accountExport.ts');

const { ctx, request } = await startApp({ headers: { Connection: 'close' }, feed: 50 });
// what the runs hand to push (server/context.ts notify → ctx.push.run)
const notices: { kind: string; slug: string; agent: string }[] = [];
const pushRun = ctx.push.run.bind(ctx.push);
ctx.push.run = (n) => {
  notices.push(n);
  pushRun(n);
};

const as: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
const videos: string[] = [];
const enc = (s: string) => encodeURIComponent(s);
const AGENT = 'cloud-cut · Mia';

before(async () => {
  for (const [key, name, role] of [
    ['mia', 'Mia', 'member'],
    ['eve', 'Eve', 'member'],
    ['rafa', 'Rafa', 'reviewer'],
  ] as const) {
    const u = await auth.createUser({ email: `${key}@example.com`, name, password: `${key}s password 1`, role });
    ids[key] = u.id;
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${key}@example.com`, password: `${key}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[key] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    as[`${key}Token`] = { Authorization: `Bearer ${auth.createToken(u.id, 'agent').token}` };
  }
  for (const name of ['spot', 'flood', 'flood-2', 'budget', 'retries', 'begun']) {
    const file = makeVideo(path.join(dir, `renders/${name}.mp4`), { w: 160, h: 90, fps: 25, dur: 1 });
    videos.push(slugify((await store.ingestUpload(file, { name: `${name}.mp4`, folder: 'Acme', by: 'Mia', keep: true })).review.video));
  }
});
const [spot, flood, flood2, budget, retries, begun] = [0, 1, 2, 3, 4, 5].map((i) => () => videos[i] as string);

const post = (who: Record<string, string>, entries: object[]) => request('POST', '/api/agents/activity', { body: { entries }, headers: who });
const runs = async (slug: string, who = as.mia) => ((await request('GET', `/api/runs?slug=${enc(slug)}`, { headers: who })).json() as RunsResponse).runs;

test('one member’s agents open only so many runs: per video, and per account across videos; their activity still shows', async () => {
  const keep = { ...lib.RUN_LIMITS };
  Object.assign(lib.RUN_LIMITS, { openPerVideo: 5, openPerAccount: 8 });
  try {
    const names = (prefix: string) => Array.from({ length: 20 }, (_, i) => ({ agent: `${prefix}${i}`, kind: 'status', text: 'Working on it', video: flood() }));
    assert.equal((await post(as.eveToken, names('a'))).status, 200);
    const open = (await runs(flood())).filter((r) => r.ended === null);
    assert.equal(open.length, 5, 'no more open runs on a video than it may hold');
    // the rest still shows live, as every agent's activity does
    const live = (await request('GET', `/api/agent-activity?slug=${enc(flood())}`, { headers: as.mia })).json().agents as { agent: string }[];
    assert.ok(
      live.some((a) => a.agent === 'a19 · Eve'),
      'the activity is there all the same',
    );
    const more = Array.from({ length: 20 }, (_, i) => ({ agent: `b${i}`, kind: 'status', text: 'Working on it', video: flood2() }));
    assert.equal((await post(as.eveToken, more)).status, 200);
    assert.equal((await runs(flood2())).filter((r) => r.ended === null).length, 3, 'the account holds 8 open runs at most');
    // a person's Send is never refused for it
    store.assignSession(flood(), { name: AGENT, sessionId: 'mcp-0123456789ab', agent: 'claude-code' }, 'Mia');
    const d = await request('POST', `/api/review/${enc(flood())}/drafts`, { body: { frame: 3, text: 'Logo too late', severity: 'must' }, headers: as.mia });
    assert.equal(d.status, 200, d.text);
    assert.equal((await request('POST', `/api/review/${enc(flood())}/drafts/send`, { body: {}, headers: as.mia })).status, 200);
    assert.ok((await runs(flood())).some((r) => r.ended === null && r.agent.name === AGENT && r.state === 'queued'));
  } finally {
    Object.assign(lib.RUN_LIMITS, keep);
  }
});

test('a runs file keeps to its bytes: steps only on the newest ended runs, open runs not heard from go first, the one at work stays', () => {
  const keep = { ...lib.RUN_LIMITS };
  Object.assign(lib.RUN_LIMITS, { fileBytes: 150_000, stepRuns: 3 });
  try {
    const now = Date.now();
    const big = (i: number) => ({
      text: `Running ${'x'.repeat(150)} ${i}`,
      key: 'Running {command}',
      vars: { command: `${'y'.repeat(70)}${i}` },
      at: new Date(now).toISOString(),
      type: 'action' as const,
    });
    const make = (state: 'done' | 'lost' | 'working', i: number) => {
      const r = lib.newRun(
        { slug: budget(), agent: lib.runAgent(`agent-${state}-${i}`), opened_by: { who: 'Mia', how: 'send' }, state: 'working' },
        now - (100 - i) * 60_000,
      );
      r.steps = Array.from({ length: 200 }, (_, n) => big(n));
      if (state === 'done') lib.endRun(r, 'done', now - (100 - i) * 60_000);
      if (state === 'lost') r.state = 'lost';
      return r;
    };
    const ended = Array.from({ length: 30 }, (_, i) => make('done', i));
    const lost = [make('lost', 40), make('lost', 41)];
    const working = make('working', 50);
    lib.changeRuns(budget(), (list) => list.push(...ended, ...lost, working));
    lib.flushRuns(budget());
    const size = fs.statSync(lib.runsFile(budget())).size;
    assert.ok(size <= lib.RUN_LIMITS.fileBytes, `${size} bytes`);
    const kept = lib.readRuns(budget());
    assert.ok(
      kept.some((r) => r.id === working.id && r.steps.length > 0),
      'the run at work stays, with steps',
    );
    assert.ok(!kept.some((r) => lost.some((x) => x.id === r.id)), 'runs nobody hears from go before any ended one');
    assert.ok(kept.filter((r) => r.ended !== null && r.steps.length).length <= 3, 'steps only on the newest ended runs');
    assert.ok(kept.filter((r) => r.ended !== null).length >= 20, 'the ended ones keep their heads');
  } finally {
    Object.assign(lib.RUN_LIMITS, keep);
  }
});

test('whose a run is goes by account: a name that ends like Mia’s never takes, joins or hears hers; “·” is no name', async () => {
  await assert.rejects(auth.createUser({ email: 'em@example.com', name: 'Eve · Mia', password: 'evems password', role: 'member' }), /cannot contain "·"/);
  // an account named so before (kept as it is) reads as its own, never as Mia's
  assert.equal(ownedAgentName('cloud-cut', 'Eve · Mia'), 'cloud-cut · Eve - Mia');
  // Mia's agent checks in (its account known by the connection), the video is assigned to it, Mia sends notes
  assert.equal(
    (await request('POST', '/api/agents/heartbeat', { body: { session_id: 'mia-cut-1', name: AGENT, kind: 'claude-code' }, headers: as.miaToken })).status,
    200,
  );
  store.assignSession(spot(), { name: AGENT, sessionId: 'mia-cut-1', agent: 'claude-code' }, 'Mia');
  const d = await request('POST', `/api/review/${enc(spot())}/drafts`, { body: { frame: 3, text: 'Caption low', severity: 'must' }, headers: as.mia });
  assert.equal(d.status, 200, d.text);
  assert.equal((await request('POST', `/api/review/${enc(spot())}/drafts/send`, { body: {}, headers: as.mia })).status, 200);
  const queued = (await runs(spot())).find((r) => r.ended === null && r.agent.name === AGENT) as Run;
  assert.equal(queued.state, 'queued');
  // another account's agent under the very same name (what an account named "· Mia" would post): nothing moves
  const eve = { account: ids.eve as string };
  ctx.activity.record({ at: new Date().toISOString(), agent: AGENT, kind: 'read', ...words('Reading the open notes'), target: null, video: spot() }, eve);
  ctx.activity.record(
    { at: new Date().toISOString(), agent: 'cloud-cut · Eve', kind: 'read', ...words('Reading the open notes'), target: null, video: spot() },
    eve,
  );
  let now = (await runs(spot())).find((r) => r.id === queued.id) as Run;
  assert.equal(now.state, 'queued', 'neither took it');
  assert.equal(now.agent.name, AGENT);
  // Mia's own agent begins it
  ctx.activity.record(
    { at: new Date().toISOString(), agent: AGENT, kind: 'read', ...words('Reading the open notes'), target: null, video: spot() },
    { account: ids.mia as string },
  );
  now = (await runs(spot())).find((r) => r.id === queued.id) as Run;
  assert.equal(now.state, 'working');
  // Mia stops it: her agent hears it, the other account's never does
  assert.equal((await request('POST', `/api/runs/${queued.id}/stop`, { body: {}, headers: as.mia })).status, 200);
  const heardByEve = ctx.activity.record(
    { at: new Date().toISOString(), agent: AGENT, kind: 'tool', ...words('Moved the video'), target: null, video: spot() },
    eve,
  );
  assert.equal(heardByEve, null, 'the stop line is Mia’s agent’s alone');
  const heardByMia = ctx.activity.record(
    { at: new Date().toISOString(), agent: AGENT, kind: 'tool', ...words('Moved the video'), target: null, video: spot() },
    { account: ids.mia as string },
  );
  assert.match(heardByMia ?? '', /^The person stopped this work/);
});

test('a reviewer reads where a run stands, never its steps, its commands or a tool’s last words', async () => {
  const quote = 'render.sh: line 3: /home/someone/acme-private/bin/ff: No such file or directory';
  await post(as.miaToken, [
    {
      agent: 'renderer',
      kind: 'status',
      text: 'Running node scripts/export-q4.js',
      key: 'Running {command}',
      vars: { command: 'node scripts/export-q4.js' },
      video: spot(),
    },
    {
      agent: 'renderer',
      kind: 'error',
      text: `The render failed (exit 127) “${quote}”`,
      key: 'The render failed (exit {code})',
      vars: { code: 127 },
      quote,
      video: spot(),
    },
  ]);
  const run = await until(async () => (await runs(spot())).find((r) => r.agent.name === 'renderer · Mia' && r.state === 'failed'), 'the failed run');
  // who works with agents reads all of it
  const full = (await request('GET', `/api/runs/${run.id}`, { headers: as.mia })).json() as RunDetail;
  assert.ok(full.steps.length >= 2);
  assert.match(full.run.error?.quote ?? '', /No such file/);
  // a reviewer: the state and what kind of failure, nothing of the project
  const seen = (await request('GET', `/api/runs/${run.id}`, { headers: as.rafa })).json() as RunDetail;
  assert.deepEqual(seen.steps, []);
  assert.equal(seen.run.state, 'failed');
  assert.equal(seen.run.error?.key, 'The render failed (exit {code})');
  assert.equal(seen.run.error?.vars?.code, 127);
  assert.equal(seen.run.error?.quote, undefined);
  assert.doesNotMatch(JSON.stringify(seen), /acme-private|export-q4|No such file/);
  const listed = await runs(spot(), as.rafa);
  assert.doesNotMatch(JSON.stringify(listed), /acme-private|export-q4|No such file/);
  const card = ((await request('GET', `/api/library?slug=${enc(spot())}`, { headers: as.rafa })).json() as LibraryResponse).videos[0]?.run;
  assert.doesNotMatch(JSON.stringify(card), /acme-private|export-q4|No such file/);
});

test('a failure’s words are redacted on the server too, whatever sent them', async () => {
  const secret = ['sk', 'abcdef0123456789abcdefXYZ'].join('_live_'.slice(0, 1));
  const quote = `upload refused: OPENAI_KEY=${secret} · curl -u admin:hunter2 https://x`;
  await post(as.miaToken, [
    {
      agent: 'leaky',
      kind: 'error',
      text: `The render failed (exit 1) “${quote}”`,
      key: 'The render failed (exit {code})',
      vars: { code: 1 },
      quote,
      video: spot(),
    },
  ]);
  const run = await until(async () => (await runs(spot())).find((r) => r.agent.name === 'leaky · Mia' && r.state === 'failed'), 'the failed run');
  const full = JSON.stringify((await request('GET', `/api/runs/${run.id}`, { headers: as.mia })).json());
  assert.doesNotMatch(full, /abcdef0123456789|hunter2/);
  assert.match(full, /\[redacted\]/);
});

test('a failure that comes again and again pings once per agent and video for a while', async () => {
  notices.length = 0;
  for (let i = 0; i < 3; i++)
    await post(as.miaToken, [
      {
        agent: 'flaky',
        kind: 'error',
        text: `The render failed (exit 1) “boom ${i}”`,
        key: 'The render failed (exit {code})',
        vars: { code: 1 },
        quote: `boom ${i}`,
        video: spot(),
      },
    ]);
  await until(async () => (await runs(spot())).filter((r) => r.agent.name === 'flaky · Mia' && r.state === 'failed').length === 3, 'three failed runs');
  assert.equal(notices.filter((n) => n.kind === 'failed' && n.agent === 'flaky · Mia').length, 1);
});

test('what a person asked of agents is in their own export, and nobody else’s', async () => {
  store.assignSession(budget(), { name: AGENT, sessionId: 'mia-cut-1', agent: 'claude-code' }, 'Mia');
  assert.equal((await request('POST', `/api/review/${enc(budget())}/request`, { body: { text: 'Make the logo bigger' }, headers: as.mia })).status, 200);
  assert.equal((await request('POST', `/api/review/${enc(budget())}/request`, { body: { text: 'And warmer' }, headers: as.mia })).status, 200);
  const file = (await accountExport(ids.mia as string)).find((f) => f.name === 'workspaces/w1/agent-requests.json');
  assert.ok(file && 'data' in file, 'the file is there');
  const asked = JSON.parse(file.data.toString()) as { text: string; agent: string; video: { name: string } }[];
  assert.deepEqual(
    asked.map((a) => a.text),
    ['Make the logo bigger', 'And warmer'],
  );
  assert.equal(asked[0]?.video.name, 'budget.mp4');
  const eves = (await accountExport(ids.eve as string)).find((f) => f.name === 'workspaces/w1/agent-requests.json');
  assert.deepEqual(JSON.parse(eves && 'data' in eves ? eves.data.toString() : '[]'), []);
});

test('runs people sent that nobody picked up are bounded per video: the one waiting longest makes room', async () => {
  const keep = { ...lib.RUN_LIMITS };
  Object.assign(lib.RUN_LIMITS, { queuedPerVideo: 3 });
  try {
    // six agents worked on the video and stopped; Mia tries each again: six runs sent that no agent has picked up
    await post(
      as.miaToken,
      Array.from({ length: 6 }, (_, i) => ({ agent: `q${i}`, kind: 'status', text: 'Working on it', video: retries() })),
    );
    // tried again in order, q0 first (the list comes newest first)
    const done = (await runs(retries())).filter((r) => r.ended === null).sort((a, b) => a.agent.name.localeCompare(b.agent.name));
    assert.equal(done.length, 6);
    for (const r of done) assert.equal((await request('POST', `/api/runs/${r.id}/stop`, { body: {}, headers: as.mia })).status, 200);
    for (const r of done) assert.equal((await request('POST', `/api/runs/${r.id}/retry`, { body: {}, headers: as.mia })).status, 200, r.agent.name);
    const waiting = (await runs(retries())).filter((r) => r.ended === null && r.state === 'queued');
    assert.equal(waiting.length, 3, 'no more than the video holds');
    assert.deepEqual(waiting.map((r) => r.agent.name).sort(), ['q3 · Mia', 'q4 · Mia', 'q5 · Mia'], 'the newest stay');
  } finally {
    Object.assign(lib.RUN_LIMITS, keep);
  }
});

test('a run a person sent counts once its agent begins it: past the video’s or the account’s bounds it waits', async () => {
  // a member of her own, so her account holds nothing yet
  const noor = await auth.createUser({ email: 'noor@example.com', name: 'Noor', password: 'noors password 1', role: 'member' });
  const token = { Authorization: `Bearer ${auth.createToken(noor.id, 'agent').token}` };
  const status = (names: string[]) =>
    post(
      token,
      names.map((agent) => ({ agent, kind: 'status', text: 'Working on it', video: begun() })),
    );
  const state = async () => Object.fromEntries((await runs(begun())).filter((r) => r.ended === null).map((r) => [r.agent.name, r.state]));
  const keep = { ...lib.RUN_LIMITS };
  try {
    // four of Noor's agents worked on the video and were stopped; Mia sends each its work again: four waiting
    assert.equal((await status(['n0', 'n1', 'n2', 'n3'])).status, 200);
    const first = (await runs(begun())).filter((r) => r.ended === null).sort((a, b) => a.agent.name.localeCompare(b.agent.name));
    assert.equal(first.length, 4);
    for (const r of first) assert.equal((await request('POST', `/api/runs/${r.id}/stop`, { body: {}, headers: as.mia })).status, 200);
    for (const r of first) assert.equal((await request('POST', `/api/runs/${r.id}/retry`, { body: {}, headers: as.mia })).status, 200, r.agent.name);
    const waiting = { 'n0 · Noor': 'queued', 'n1 · Noor': 'queued', 'n2 · Noor': 'queued', 'n3 · Noor': 'queued' };
    assert.deepEqual(await state(), waiting);
    // the video holds two at work: the first two agents heard begin theirs, the others' stay waiting
    Object.assign(lib.RUN_LIMITS, { openPerVideo: 2 });
    for (const n of ['n0', 'n1', 'n2', 'n3']) assert.equal((await status([n])).status, 200);
    const two = { 'n0 · Noor': 'working', 'n1 · Noor': 'working', 'n2 · Noor': 'queued', 'n3 · Noor': 'queued' };
    assert.deepEqual(await state(), two);
    // room on the video, none for the account (three other open runs of hers): still waiting
    Object.assign(lib.RUN_LIMITS, { openPerVideo: keep.openPerVideo, openPerAccount: 3 });
    for (const n of ['n2', 'n3']) assert.equal((await status([n])).status, 200);
    assert.deepEqual(await state(), two);
    // room again: the next word from each begins its run
    Object.assign(lib.RUN_LIMITS, keep);
    for (const n of ['n2', 'n3']) assert.equal((await status([n])).status, 200);
    assert.deepEqual(await state(), { 'n0 · Noor': 'working', 'n1 · Noor': 'working', 'n2 · Noor': 'working', 'n3 · Noor': 'working' });
  } finally {
    Object.assign(lib.RUN_LIMITS, keep);
  }
});
