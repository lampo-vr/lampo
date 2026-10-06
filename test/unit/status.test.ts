// The status workflow end to end in local mode, through the real API (in-process app), the store, `vr` and MCP:
// to_review → changes → check_fixes → team_approved → with_client → client_approved → final, a render after final,
// reopening, carrying an approval over only when the new render is identical, and stores from before the history.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Review } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, must, slugOf, VR, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { reviewFile } = await import('../../lib/paths.ts');

const film = makeVideo(path.join(dir, 'proj/export/film.mp4'), { w: 320, h: 180, dur: 1 });
age(film);
store.createOrGetReview(film, { by: 'alex' });
const slug = slugOf(film);
const enc = encodeURIComponent;

const { base } = await startApp({ token: 'test-token', loadSessions: async () => [] });
let mcp: Client;
before(async () => {
  mcp = new Client({ name: 'status-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});
after(async () => {
  await mcp.close().catch(() => {});
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
// Opening a video registers a new render on disk (the running app's watcher does the same); the overview doesn't.
const open = (s: string) => api('GET', `/api/review/${enc(s)}`);
const stageNow = async (s = slug) => {
  await open(s);
  const r = await api('GET', '/api/status');
  assert.equal(r.status, 200);
  return must(
    r.json.videos.find((v: { slug: string }) => v.slug === s),
    'video in the overview',
  ).stage;
};
const rerender = (file: string, freq: number) => {
  makeVideo(file, { w: 320, h: 180, dur: 1, freq });
  age(file);
};
type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: ToolResult) =>
  r.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');

let noteId = '';

test('a fresh render is to review; a note makes it changes; a fix makes it check_fixes; verifying clears it', async () => {
  assert.equal((await stageNow()).stage, 'to_review');
  const added = await api('POST', `/api/review/${enc(slug)}/comments`, { frame: 5, text: 'Logo später', severity: 'should' });
  assert.equal(added.status, 200);
  noteId = added.json.id;
  const changes = await stageNow();
  assert.equal(changes.stage, 'changes');
  assert.equal(changes.open, 1);
  assert.equal((await api('PATCH', `/api/comments/${noteId}`, { status: 'fixed', note: 'moved to 1:10' })).status, 200);
  assert.equal((await stageNow()).stage, 'check_fixes');
  assert.equal((await api('PATCH', `/api/comments/${noteId}`, { status: 'verified' })).status, 200);
  assert.equal((await stageNow()).stage, 'to_review');
});

test('team approval, a review link, the client approves: history per party, event texts name the party', async () => {
  const ok = await api('PUT', `/api/review/${enc(slug)}/approval`, { status: 'approved', note: 'passt' });
  assert.equal(ok.status, 200);
  assert.equal((await stageNow()).stage, 'team_approved');
  const link = await api('POST', `/api/review/${enc(slug)}/shares`, { label: 'Client' });
  assert.equal(link.status, 200);
  // Shared is not seen: the link alone doesn't put it with the client.
  const shared = await stageNow();
  assert.equal(shared.stage, 'team_approved');
  assert.equal(shared.linked, true);
  assert.deepEqual([shared.share.label, shared.share.opened, shared.next.kind], ['Client', false, 'wait_client']);
  assert.match(shared.detail, /shared via "Client" · not opened yet/);
  // The team checking its own link (the owner's machine) doesn't count as the client.
  const preview = await api('GET', `/api/g/${link.json.token}/review/${enc(slug)}`);
  assert.equal(preview.status, 200);
  await api('POST', `/api/g/${link.json.token}/visit`, {});
  assert.equal((await stageNow()).stage, 'team_approved', 'the owner previewing is not the client');
  // A visitor gives a name and opens the video: the client has it in front of them.
  await api('POST', `/api/g/${link.json.token}/visit`, { name: 'Mia' }, { 'x-forwarded-for': '203.0.113.9' });
  // The guest page shows the client's own verdict: a team approval must not hide the client's buttons.
  const g = await api('GET', `/api/g/${link.json.token}/review/${enc(slug)}`, undefined, { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(g.status, 200);
  assert.equal(g.json.approval, null);
  const withClient = await stageNow();
  assert.equal(withClient.stage, 'with_client');
  assert.deepEqual([withClient.share.opened, withClient.share.seen_v, withClient.share.by, withClient.share.opens], [true, 1, 'Mia', 1]);
  assert.match(withClient.detail, /^Approved V1 · opened by Mia just now/);
  const info = (await api('GET', `/api/review/${enc(slug)}/shares`)).json.shares[0];
  assert.equal(info.stats.opens, 1, 'one visit: the owner previewing did not count');
  const approved = await api(
    'POST',
    `/api/g/${link.json.token}/approval`,
    { name: 'Mia', status: 'approved', slug, v: 1 },
    { 'x-forwarded-for': '203.0.113.9' },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const s = await stageNow();
  assert.equal(s.stage, 'client_approved');
  assert.equal(s.client.by, 'guest:Mia');
  const review = (await api('GET', `/api/review/${enc(slug)}`)).json;
  assert.deepEqual(
    review.approvals.map((e: { party: string; status: string }) => `${e.party}:${e.status}`),
    ['team:approved', 'client:approved'],
  );
  assert.match(review.approvals[1].share, /^s_/, 'the client verdict names its link');
  const texts = store
    .readEvents()
    .filter((e) => e.type === 'approval')
    .map((e) => e.text);
  assert.ok(texts.includes('APPROVED v1 (team): passt'), texts.join(' | '));
  assert.ok(texts.includes('APPROVED v1 (client: Mia)'), texts.join(' | '));
});

test('final: the stage, the lock for agents (vr and MCP), review.md; a new render does not move it', async () => {
  const f = await api('PUT', `/api/review/${enc(slug)}/final`, { note: 'geliefert' });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal(f.json.stage.stage, 'final');
  const late = await api('POST', `/api/review/${enc(slug)}/comments`, { frame: 7, text: 'Noch eine Kleinigkeit' });
  assert.equal((await stageNow()).stage, 'final', 'a late note does not reopen it');

  const fix = vr(['fix', late.json.id, '--note', 'done'], env);
  assert.equal(fix.code, 1);
  assert.match(fix.err, /film\.mp4 is final \(v1, by .+\): nothing to fix until the reviewer reopens it/);
  assert.match(vr(['ls'], env).out, /film\.mp4 .*stage:final/);
  assert.match(vr(['open', 'film.mp4'], env).out, /stage: FINAL — Final V1 · marked by .+ \(fix nothing until it is reopened\)/);
  // stderr of a successful run (the vr helper only keeps it on failures)
  const added = spawnSync(process.execPath, [VR, 'add', 'film.mp4', '--frame', '3', '--text', 'Frage', '--by', 'agent:test'], { env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stderr, /film\.mp4 is final .*waits until someone reopens it/);

  const fixed = (await mcp.callTool({ name: 'mark_fixed', arguments: { id: late.json.id, note: 'done' } })) as ToolResult;
  assert.ok(fixed.isError && /is final/.test(textOf(fixed)), textOf(fixed));
  const listed = (await mcp.callTool({ name: 'list_videos', arguments: {} })) as ToolResult;
  assert.match(textOf(listed), /stage final \(Final V1 · marked by .+\)/);

  const md = fs.readFileSync(path.join(path.dirname(reviewFile(slug)), 'review.md'), 'utf8');
  assert.match(md, /- stage: FINAL — Final V1/);
  assert.match(md, /## Sign-off/);
  assert.match(md, /v1 · client · APPROVED by guest:Mia/);
  assert.match(md, /v1 · FINAL by .+ — geliefert/);

  rerender(film, 660);
  const s = await stageNow();
  assert.equal(s.stage, 'final');
  assert.equal(s.final_superseded, 2);
  assert.equal(s.detail, 'Final V1 · V2 arrived since');
});

test('reopening; final with open notes needs a confirmation', async () => {
  assert.equal((await api('DELETE', `/api/review/${enc(slug)}/final`, { note: 'V2 prüfen' })).status, 200);
  const reopened = await stageNow();
  assert.equal(reopened.stage, 'changes', 'the late notes are open work again');
  const blocked = await api('PUT', `/api/review/${enc(slug)}/final`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.needs_confirm, true);
  assert.equal(blocked.json.open, reopened.open);
  const forced = await api('PUT', `/api/review/${enc(slug)}/final`, { confirm: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.stage.stage, 'final');
  const finals = must(store.loadReview(slug)).finals?.map((x) => `${x.action}:v${x.v}`);
  assert.deepEqual(finals, ['final:v1', 'reopen:v1', 'final:v2']);
  assert.equal((await api('DELETE', `/api/review/${enc(slug)}/final`)).status, 200);
  assert.equal((await api('DELETE', `/api/review/${enc(slug)}/final`)).status, 409, 'not final any more');
});

test('carrying an approval over: only to an identical render', async () => {
  const src = makeVideo(path.join(dir, 'proj/export/teaser.mp4'), { w: 320, h: 180, dur: 1, pattern: 'testsrc2' });
  age(src);
  store.createOrGetReview(src, { by: 'alex' });
  const t = slugOf(src);
  assert.equal((await api('POST', `/api/review/${enc(t)}/approval/carry`, {})).status, 409, 'nothing approved yet');
  assert.equal((await api('PUT', `/api/review/${enc(t)}/approval`, { status: 'approved' })).status, 200);
  // Same picture and sound, new bytes: a re-encode.
  const tmp = path.join(dir, 'reencode.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-i', src, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', tmp]);
  fs.renameSync(tmp, src);
  age(src);
  const stale = await stageNow(t);
  assert.equal(stale.stage, 'to_review');
  assert.equal(stale.approval_stale.v, 1);
  const carried = await api('POST', `/api/review/${enc(t)}/approval/carry`, {});
  assert.equal(carried.status, 200, JSON.stringify(carried.json));
  assert.equal(carried.json.stage.stage, 'team_approved');
  const entry = must(store.loadReview(t)).approvals?.at(-1);
  assert.equal(entry?.carried_from, 1);
  assert.equal(entry?.v, 2);
  // A render that really changed keeps its approval where it was.
  makeVideo(src, { w: 320, h: 180, dur: 1, pattern: 'smptebars' });
  age(src);
  await stageNow(t);
  const refused = await api('POST', `/api/review/${enc(t)}/approval/carry`, { from: 2 });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /v3 is not identical to v2/);
  // Same picture, quieter sound: not identical either, and the refusal counts the sound change.
  assert.equal((await api('PUT', `/api/review/${enc(t)}/approval`, { status: 'approved' })).status, 200);
  execFileSync(FFMPEG, ['-v', 'error', '-i', src, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-af', 'volume=0.1', '-c:a', 'aac', '-y', tmp]);
  fs.renameSync(tmp, src);
  age(src);
  await stageNow(t);
  const quieter = await api('POST', `/api/review/${enc(t)}/approval/carry`, {});
  assert.equal(quieter.status, 409);
  assert.match(quieter.json.error, /v4 is not identical to v3 \([1-9]\d* changes?\)/);
});

test('a store from before the history: read as one entry, kept as the first entry on the next write', async () => {
  const file = makeVideo(path.join(dir, 'proj/export/legacy.mp4'), { dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'alex' });
  const l = slugOf(file);
  const json = JSON.parse(fs.readFileSync(reviewFile(l), 'utf8'));
  json.approval = { status: 'approved', v: 1, by: 'alex', at: '2026-09-01T10:00:00+02:00', note: null };
  delete json.approvals;
  fs.writeFileSync(reviewFile(l), JSON.stringify(json));
  assert.equal((await stageNow(l)).stage, 'team_approved');
  assert.equal(JSON.parse(fs.readFileSync(reviewFile(l), 'utf8')).approvals, undefined, 'reading does not rewrite the file');
  store.setApproval(l, { status: 'changes', note: 'Ton' }, 'guest:Ana');
  const after = must(store.loadReview(l));
  assert.deepEqual(
    after.approvals?.map((e) => `${e.party}:${e.status}:${e.by}`),
    ['team:approved:alex', 'client:changes:guest:Ana'],
  );
  assert.deepEqual(
    after.approval,
    { status: 'changes', v: 1, by: 'guest:Ana', at: after.approvals?.[1]?.at, note: 'Ton' },
    'the legacy field stays the newest verdict',
  );
  store.setApproval(l, null, 'guest:Ana');
  assert.equal(must(store.loadReview(l)).approval?.by, 'alex', 'withdrawing falls back to the standing team approval');
});

test('the share signal: per-video views, a new render not seen yet, older stats, folder links', async () => {
  const { shareSignal } = await import('../../lib/stageContext.ts');
  const video = path.join(dir, 'proj/export/spot.mp4');
  const other = path.join(dir, 'proj/export/teaser.mp4');
  const ver = (v: number, registered: string) => ({ v, registered }) as Review['versions'][number];
  const r = { video, folder: 'Acme', versions: [ver(1, '2026-09-28T10:00:00+02:00'), ver(2, '2026-09-28T12:00:00+02:00')] } as Review;
  const base = { created: '2026-09-28T09:00:00+02:00', by: 'alex' };
  const stats = (o: object = {}) => ({ opens: 0, last_opened: null, reviewers: [], ...o });
  const seen = (seen_v: number, by: string | null = null) => ({ views: 2, last_viewed: '2026-09-28T13:00:00+02:00', seen_v, by });

  assert.equal(shareSignal(r, []), null, 'no link, no signal');
  const videoLink = { ...base, slug: slugOf(video), label: 'Spot', stats: stats({ videos: { [slugOf(video)]: seen(1, 'Mia') } }) };
  const s1 = shareSignal(r, [videoLink]);
  assert.deepEqual([s1?.opened, s1?.seen_v, s1?.by, s1?.kind], [false, 1, 'Mia', 'video'], 'they saw V1, V2 is new');
  assert.equal(shareSignal(r, [{ ...videoLink, stats: stats({ videos: { [slugOf(video)]: seen(2) } }) }])?.opened, true);
  // Stats from before per-video views counted the team's own previews too: they never say "opened".
  const legacy = shareSignal(r, [{ ...videoLink, stats: stats({ opens: 4, last_opened: '2026-09-28T12:30:00+02:00' }) }]);
  assert.deepEqual([legacy?.opened, legacy?.opens, legacy?.last_opened, legacy?.seen_v], [false, 0, null, null]);
  // A folder link that counts per video: views of another video say nothing about this one.
  const folderLink = {
    ...base,
    folder: 'Acme',
    label: 'Acme room',
    stats: stats({ opens: 9, last_opened: '2026-09-28T13:00:00+02:00', videos: { [slugOf(other)]: seen(1) } }),
  };
  const f = shareSignal(r, [folderLink]);
  assert.deepEqual([f?.opened, f?.opens, f?.kind], [false, 0, 'folder']);
  // Several links: the one that saw the newest render wins.
  assert.equal(shareSignal(r, [folderLink, { ...videoLink, stats: stats({ videos: { [slugOf(video)]: seen(2) } }) }])?.label, 'Spot');
});
