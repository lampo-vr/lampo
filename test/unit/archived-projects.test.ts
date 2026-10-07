// Archived projects (lib/archived.ts) on a hosted server. Owners and admins archive a project and restore it, in the app
// (people only). While it is archived nothing new goes into it — notes, replies, statuses, drafts, stage changes,
// versions and uploads, moves into it, review links, questions, agent status — each refused with one sentence (423,
// `archived`), over HTTP and to agents (MCP, `vr`) alike, before anything is begun (no screenshot left behind,
// nothing tracked); owners and admins still take a video out. Its review links play watch only and get their rights
// back once it is restored; embeds keep playing. The lists leave it out unless asked: search keeps its matches apart,
// the inbox, Insights' "now" lists and the status page drop it, `list_videos`, `list_folders`, `vr ls` and
// `vr folders` show it with their `archived` flag.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, must, tmpdir, VR } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { slugify, dataDir, reviewDir, reviewFile } = await import('../../lib/paths.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');
const { archivedIn, archivedWithHeld } = await import('../../lib/archived.ts');
type User = import('../../lib/auth.ts').User;

// Fresh connections: refusals answer before reading the body, which can end a kept-alive socket mid-test.
const { ctx, request, base } = await startApp({ headers: { Connection: 'close' } });

const SENTENCE = 'the project "ACME" is archived: it is read-only until a person restores it';
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;
const sessionOf = (u: User) => ({ Cookie: `vr_session=${auth.signSession(u)}`, ...origin });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const as: Record<'owner' | 'admin' | 'member' | 'reviewer' | 'ownerToken' | 'memberToken', Record<string, string>> = {
  owner: {},
  admin: {},
  member: {},
  reviewer: {},
  ownerToken: {},
  memberToken: {},
};
let member: User;

const clip = (rel: string) => {
  const f = makeVideo(path.join(dir, 'renders', rel), { dur: 0.4, w: 64, h: 36, audio: false });
  age(f);
  return f;
};
const filed = (rel: string, folder: string | null) => {
  const f = clip(rel);
  store.createOrGetReview(f, { by: 'tester' });
  const slug = slugify(f);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
};
const spot = filed('acme/spot.mp4', 'ACME/Reels');
const teaser = filed('acme/teaser.mp4', 'ACME');
const film = filed('globex/film.mp4', 'Globex');
// an uploaded video in it too: what takes its next version as an upload (made in before())
let promo = '';
const open = store.addComment(spot, { frame: 3, text: 'Logo too late', author: 'Rita' });
const fixed = store.addComment(spot, { frame: 5, text: 'Price is wrong', author: 'Rita' });
store.updateComment(fixed.id, { status: 'fixed', note: 'Price fixed', by: 'agent:cut' });
const links: { video: string; folder: string; embed: string } = { video: '', folder: '', embed: '' };

const archive = (who = as.admin, p = 'ACME') => request('POST', '/api/folders/archive', { body: { path: p }, headers: who });
const restore = (who = as.admin, p = 'ACME') => request('POST', '/api/folders/restore', { body: { path: p }, headers: who });
const json = (r: { status: number; text: string; json: () => unknown }, status = 200) => {
  assert.equal(r.status, status, r.text);
  // biome-ignore lint/suspicious/noExplicitAny: answers are checked field by field
  return r.json() as any;
};
/** Refused for the archived project: 423, the sentence, and which project. */
const refused = (r: { status: number; text: string; json: () => unknown }, what: string) => {
  assert.equal(r.status, 423, `${what}: ${r.status} ${r.text}`);
  assert.deepEqual(r.json(), { archived: 'ACME', error: SENTENCE }, what);
};
const foldersFile = () => JSON.parse(fs.readFileSync(path.join(dataDir(), 'folders.json'), 'utf8'));

before(async () => {
  promo = slugify((await store.ingestUpload(clip('promo.mp4'), { name: 'promo.mp4', folder: 'ACME', by: 'tester', keep: true })).review.video);
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
  const a = await auth.createUser({ email: 'ada@example.com', name: 'Ada', password: 'adas password 1', role: 'admin' });
  member = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'ritas password', role: 'reviewer' });
  ctx.setup.token = null;
  as.owner = sessionOf(o);
  as.admin = sessionOf(a);
  as.member = sessionOf(member);
  as.reviewer = sessionOf(r);
  as.ownerToken = bearer(auth.createToken(o.id, 'owner script').token);
  as.memberToken = bearer(auth.createToken(member.id, 'agent').token);
  // links made while the project is open: a video's (it takes notes and verdicts, downloads previews), its folder's, an embed
  links.video = json(
    await request('POST', `/api/review/${enc(spot)}/shares`, { body: { comment: true, approve: true, download: 'preview' }, headers: as.owner }),
  ).token;
  links.folder = json(await request('POST', '/api/folder-shares', { body: { folder: 'ACME', comment: true, approve: true }, headers: as.owner })).token;
  links.embed = json(await request('POST', `/api/review/${enc(teaser)}/shares`, { body: { embed: true }, headers: as.owner })).token;
});

test('only owners and admins archive and restore a project, in the app; a folder isn’t a project', async () => {
  assert.equal((await archive(as.member)).status, 403, 'a member may not');
  assert.equal((await archive(as.reviewer)).status, 403, 'a reviewer may not');
  const token = await archive(as.ownerToken);
  assert.equal(token.status, 403, 'an API token may not, an owner’s neither');
  assert.equal(token.json().person, true);
  assert.equal((await archive(as.admin, 'ACME/Reels')).status, 400, 'a folder in a project');
  assert.equal((await archive(as.admin, 'Nope')).status, 404);

  const done = json(await archive(as.admin));
  assert.equal(done.project, 'ACME');
  assert.equal(done.archived.by, 'Ada');
  assert.deepEqual(Object.keys(done.archived_projects), ['ACME']);
  assert.equal(json(await archive(as.owner)).archived.at, done.archived.at, 'archived again: as it was archived first');
  const file = foldersFile();
  assert.equal(file.archived.ACME.by, 'Ada');
  assert.ok(file.archived.ACME.by_id, 'with the account');
  assert.ok(file.folders.includes('ACME/Reels'), 'everything in it kept');

  const lib = json(await request('GET', '/api/library', { headers: as.member }));
  assert.deepEqual(lib.archived_projects, { ACME: { at: done.archived.at, by: 'Ada' } });
  const bySlug = new Map(lib.videos.map((v: { slug: string }) => [v.slug, v]));
  assert.equal(must(bySlug.get(spot) as { project_archived?: string }).project_archived, done.archived.at);
  assert.equal(must(bySlug.get(teaser) as { project_archived?: string }).project_archived, done.archived.at);
  assert.equal((bySlug.get(film) as { project_archived?: string }).project_archived, undefined);

  assert.equal((await restore(as.member)).status, 403);
  assert.equal((await restore(as.reviewer)).status, 403);
  assert.equal((await restore(as.ownerToken)).status, 403);
  assert.equal(json(await restore(as.owner)).restored, true);
  assert.equal(foldersFile().archived, undefined, 'nothing archived any more');
  const back = json(await request('GET', '/api/library', { headers: as.member }));
  assert.equal(back.archived_projects, undefined);
  assert.ok(back.videos.every((v: { project_archived?: string }) => !v.project_archived));
});

test('nothing new in an archived project: every kind of write is refused with one sentence, reading goes on', async () => {
  await restore();
  json(await archive());
  const before = fs.readFileSync(reviewFile(spot), 'utf8');
  const v = `/api/review/${enc(spot)}`;
  refused(await request('POST', `${v}/comments`, { body: { frame: 1, text: 'One more' }, headers: as.memberToken }), 'a note');
  refused(await request('PATCH', `/api/comments/${open.id}`, { body: { note: 'On it' }, headers: as.memberToken }), 'a reply');
  refused(await request('PATCH', `/api/comments/${open.id}`, { body: { status: 'fixed', fixed_in_v: 1 }, headers: as.memberToken }), 'marked fixed');
  refused(await request('PATCH', `/api/comments/${fixed.id}`, { body: { status: 'verified' }, headers: as.reviewer }), 'a fix checked');
  refused(await request('PATCH', `/api/comments/${open.id}`, { body: { text: 'Logo much too late' }, headers: as.owner }), 'a note edited');
  refused(await request('DELETE', `/api/comments/${open.id}`, { headers: as.owner }), 'a note deleted');
  refused(await request('POST', `${v}/drafts`, { body: { frame: 1, text: 'Later' }, headers: as.member }), 'a draft');
  refused(await request('PUT', `${v}/approval`, { body: { status: 'approved' }, headers: as.reviewer }), 'approved');
  refused(await request('PUT', `${v}/approval`, { body: { status: 'changes' }, headers: as.member }), 'changes requested');
  refused(await request('PUT', `${v}/final`, { body: {}, headers: as.member }), 'marked final');
  refused(await request('POST', `${v}/sync`, { headers: as.memberToken }), 'a new version from disk');
  refused(await request('POST', `${v}/request`, { body: { text: 'Pre-review it' }, headers: as.memberToken }), 'a request to its agent');
  refused(await request('PUT', `${v}/agent-status`, { body: { text: 'rendering v2' }, headers: as.memberToken }), 'an agent’s status');
  refused(await request('PUT', `${v}/session`, { body: { name: 'cut' }, headers: as.member }), 'an agent assigned');
  refused(await request('POST', `${v}/shares`, { body: {}, headers: as.owner }), 'a review link on a video');
  refused(await request('POST', '/api/folder-shares', { body: { folder: 'ACME/Reels' }, headers: as.owner }), 'a review link on a folder');
  const ask = { folder: 'ACME', text: 'Which music?', options: [{ id: 'm', items: [{ id: 'a' }, { id: 'b' }] }] };
  refused(await request('POST', '/api/asks', { body: ask, headers: as.memberToken }), 'a question before a render');
  // uploads: a new video into it, the next version of one in it — before a byte is taken
  const upload = clip('incoming.mp4');
  const intoFolder = await tusUpload(request, upload, { filename: 'new.mp4', folder: 'ACME/Reels' }, as.memberToken);
  assert.equal(intoFolder.status, 423, intoFolder.text);
  assert.equal(intoFolder.text, SENTENCE);
  refused(await request('POST', '/api/uploads/tickets', { body: { filename: 'new.mp4', folder: 'ACME' }, headers: as.memberToken }), 'an upload URL');
  refused(await request('POST', '/api/uploads/tickets', { body: { filename: 'promo.mp4', slug: promo }, headers: as.memberToken }), 'a next version’s URL');
  const nextVersion = await tusUpload(request, upload, { filename: 'promo.mp4', slug: promo }, as.memberToken);
  assert.equal(nextVersion.status, 423, nextVersion.text);
  assert.equal(must(store.loadReview(promo)).versions.length, 1, 'no V2');
  // moves into it, folders in it
  refused(await request('PUT', `/api/review/${enc(film)}/folder`, { body: { folder: 'ACME' }, headers: as.owner }), 'a video moved in');
  refused(await request('POST', '/api/folders', { body: { path: 'ACME/New' }, headers: as.member }), 'a folder made in it');
  refused(await request('PATCH', '/api/folders', { body: { from: 'Globex', to: 'ACME/Globex' }, headers: as.member }), 'a folder moved in');
  refused(await request('PATCH', '/api/folders', { body: { from: 'ACME/Reels', to: 'ACME/Cuts' }, headers: as.member }), 'a folder in it renamed');
  refused(await request('PATCH', '/api/folders', { body: { from: 'ACME', to: 'Acme Inc' }, headers: as.owner }), 'the project renamed');
  refused(await request('DELETE', '/api/folders?path=ACME%2FReels', { headers: as.member }), 'a folder in it deleted');
  // nothing of it was written
  assert.equal(fs.readFileSync(reviewFile(spot), 'utf8'), before, 'review.json as it was');
  assert.ok(!folders.allFolders().some((f) => f === 'ACME/New' || f === 'ACME/Globex' || f === 'ACME/Cuts'));
  assert.equal(must(store.loadReview(film)).folder, 'Globex');
  // reading goes on: the review, its download, watching
  assert.equal((await request('GET', v, { headers: as.reviewer })).status, 200);
  assert.equal((await request('GET', `${v}/download/info`, { headers: as.member })).status, 200);
  assert.equal((await request('POST', `${v}/watch`, { body: { v: 1, seen: '0'.repeat(25), secs: 1 }, headers: as.reviewer })).status, 204);
  json(await restore());
  const note = json(await request('POST', `${v}/comments`, { body: { frame: 1, text: 'One more' }, headers: as.memberToken }));
  assert.equal(note.text, 'One more', 'restored: open to work again');
  store.deleteComment(note.id);
});

test('owners and admins take a video out of an archived project; nobody puts one in, and members take none out', async () => {
  await restore();
  json(await archive());
  const move = (slug: string, folder: string | null, who: Record<string, string>) =>
    request('PUT', `/api/review/${enc(slug)}/folder`, { body: { folder }, headers: who });
  refused(await move(teaser, null, as.member), 'a member takes one out');
  refused(await move(teaser, 'ACME/Reels', as.owner), 'moved within it');
  json(await move(teaser, 'Globex', as.admin));
  assert.equal(must(store.loadReview(teaser)).folder, 'Globex', 'out, where it can be worked on');
  refused(await move(teaser, 'ACME', as.owner), 'and not back in');
  json(await restore());
  json(await move(teaser, 'ACME', as.member));
});

/**
 * An MCP client on the local backend: what an agent on the server reaches over /mcp (`token`), refused by the store
 * itself; `local`: the server machine's own (stdio), which names files on its disk.
 */
async function mcp(role: string, via: 'token' | 'local' = 'token') {
  const server = createReviewServer({ backend: createLocalBackend(), principal: { via, name: 'Max', id: member.id, role } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'agent', version: '1' });
  await c.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { error: !!r.isError, text: r.content.map((x) => x.text ?? '').join('\n') };
  };
  return { call, close: () => c.close().then(() => server.close()) };
}

/** `vr` logged in to this server with the member's token (the remote backend: the API's refusals). */
function vr(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const home = tmpdir('vr-agent-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VR_SERVER: base,
    VR_TOKEN: auth.createToken(member.id, 'vr').token,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    VR_DATA: path.join(home, 'none'),
    VR_CACHE: path.join(home, 'none-cache'),
  };
  delete env.VR_MODE;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [VR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

test('agents get the same sentence (MCP, vr), and their lists leave an archived project out unless asked', async () => {
  await restore();
  json(await archive());
  const agent = await mcp('member');
  try {
    for (const [name, args] of [
      ['add_note', { video: spot, frame: 2, text: 'Is the logo late?' }],
      ['reply', { id: open.id, note: 'Looking' }],
      ['mark_fixed', { id: open.id, note: 'Logo comes in on frame 3' }],
      ['move_video', { video: film, folder: 'ACME' }],
      ['set_status', { video: spot, text: 'rendering v2' }],
    ] as const) {
      const r = await agent.call(name, args);
      assert.ok(r.error, `${name}: ${r.text}`);
      assert.equal(r.text, `Error: ${SENTENCE}`, name);
    }
    const listed = (await agent.call('list_videos', {})).text;
    assert.ok(listed.includes('film.mp4') && !listed.includes('spot.mp4') && !listed.includes('teaser.mp4'), listed);
    const all = (await agent.call('list_videos', { archived: true })).text.split('\n');
    const at = all.findIndex((l) => l.endsWith('spot.mp4'));
    assert.ok(at >= 0, all.join('\n'));
    assert.match(all[at + 1] as string, / · archived$/, 'marked, at the end of its line');
    assert.doesNotMatch(all[all.findIndex((l) => l.endsWith('film.mp4')) + 1] as string, /archived/);
    const tree = (await agent.call('list_folders', {})).text;
    assert.ok(!tree.includes('ACME') && tree.includes('Globex'), tree);
    const full = (await agent.call('list_folders', { archived: true })).text;
    assert.match(full, /^ACME {2}\(3 videos, 1 open\) {2}\[ACME\] {2}archived$/m, full);
  } finally {
    await agent.close();
  }
  // the owner's agent takes a video out (move_video), as the owner does in the app
  const owners = await mcp('owner');
  try {
    const out = await owners.call('move_video', { video: teaser, folder: '' });
    assert.ok(!out.error, out.text);
    assert.equal(must(store.loadReview(teaser)).folder, null);
  } finally {
    await owners.close();
  }

  const ls = await vr(['ls']);
  assert.equal(ls.code, 0, ls.err);
  assert.ok(ls.out.includes('film.mp4') && ls.out.includes('teaser.mp4') && !ls.out.includes('spot.mp4'), ls.out);
  const lsAll = await vr(['ls', '--archived']);
  assert.match(lsAll.out, /spot\.mp4 {2}\[ACME\/Reels\] \(archived\) {2}stage:/, lsAll.out);
  const tree = await vr(['folders']);
  assert.ok(!tree.out.includes('ACME') && tree.out.includes('Globex'), tree.out);
  assert.match((await vr(['folders', '--archived'])).out, /^ACME {2}\(2 videos, 1 open\) \(archived\)$/m, 'its videos (one taken out)');
  const fix = await vr(['fix', open.id, '--note', 'Logo on frame 3']);
  assert.equal(fix.code, 1, fix.out);
  assert.ok(fix.err.includes(SENTENCE), fix.err);
  const add = await vr(['add', spot, '--frame', '2', '--text', 'Late?']);
  assert.equal(add.code, 1, add.out);
  assert.ok(add.err.includes(SENTENCE), add.err);
  json(await restore());
  assert.ok((await vr(['ls'])).out.includes('spot.mp4'), 'restored: listed again');
  folders.moveVideo(teaser, 'ACME', 'tester');
});

test('a review link plays watch only while its project is archived, and gets its rights back once restored', async () => {
  await restore();
  const guest = { ...origin, Host: 'review.test' };
  const page = (token: string) => request('GET', `/api/g/${token}`, { headers: guest });
  const opened = json(await page(links.video));
  assert.deepEqual([opened.perms.comment, opened.perms.approve, opened.perms.download], [true, true, 'preview']);
  const id = opened.videos[0].slug as string;
  const note = (token: string, slug: string) =>
    request('POST', `/api/g/${token}/comments`, { body: { name: 'Mia', slug, v: 1, frame: 2, text: 'Brighter please' }, headers: guest });

  json(await archive());
  const shut = json(await page(links.video));
  assert.deepEqual([shut.perms.comment, shut.perms.approve, shut.perms.download], [false, false, 'preview'], 'watch, and download what it offers');
  assert.equal(shut.videos.length, 1, 'its video still there');
  const review = json(await request('GET', `/api/g/${links.video}/review/${id}`, { headers: guest }));
  assert.ok(review.media || review.preparing, 'it plays');
  assert.ok(review.download.preview, 'its download stays');
  assert.equal(review.notes.length, 0, 'no visitor wrote any');
  const no = await note(links.video, id);
  assert.equal(no.status, 403, no.text);
  assert.equal(no.json().error, 'This link is for watching only.');
  const verdict = await request('POST', `/api/g/${links.video}/approval`, { body: { name: 'Mia', slug: id, v: 1, status: 'approved' }, headers: guest });
  assert.equal(verdict.status, 403, verdict.text);
  const folderShut = json(await page(links.folder));
  assert.deepEqual([folderShut.perms.comment, folderShut.perms.approve], [false, false], 'a folder link the same');
  assert.equal(folderShut.videos.length, 3);
  const embed = json(await request('GET', `/api/g/${links.embed}/embed`, { headers: guest }));
  assert.equal(embed.title, 'teaser.mp4', 'an embed keeps playing');
  assert.equal(must(store.loadReview(spot)).comments.length, 2, 'nothing came in');

  json(await restore());
  const back = json(await page(links.video));
  assert.deepEqual([back.perms.comment, back.perms.approve, back.perms.download], [true, true, 'preview'], 'its rights back');
  const landed = await note(links.video, id);
  assert.equal(landed.status, 200, landed.text);
  assert.ok(json(await page(links.folder)).perms.comment);
});

test('the lists leave an archived project out: search keeps it apart, the inbox, Insights and the status page drop it', async () => {
  await restore();
  const forYou = async () => json(await request('GET', '/api/for-you', { headers: as.owner })).items.map((i: { slug: string }) => i.slug);
  const stuck = async () => json(await request('GET', '/api/insights', { headers: as.owner })).board.flow.stuck.map((s: { slug: string }) => s.slug);
  const status = async () => json(await request('GET', '/api/status', { headers: as.owner })).videos.map((v: { slug: string }) => v.slug);
  assert.ok((await forYou()).includes(spot), 'the inbox lists it while it is open');
  assert.ok((await stuck()).includes(spot), 'Insights lists it as waiting');
  assert.ok((await status()).includes(spot));

  json(await archive());
  const recent = json(await request('GET', '/api/search', { headers: as.owner }));
  assert.deepEqual(
    recent.videos.map((v: { slug: string }) => v.slug),
    [film],
    'no query: the recently changed leave it out',
  );
  assert.equal(recent.archived, undefined);
  const named = json(await request('GET', '/api/search?q=spot', { headers: as.owner }));
  assert.deepEqual(named.videos, [], 'not among the videos');
  assert.deepEqual(named.notes, []);
  assert.deepEqual(
    named.archived.videos.map((v: { slug: string }) => v.slug),
    [spot],
    'in a group of its own',
  );
  const project = json(await request('GET', '/api/search?q=acme', { headers: as.owner }));
  assert.ok(!project.folders.some((f: { folder: string }) => f.folder.startsWith('ACME')));
  assert.deepEqual(
    project.archived.folders.map((f: { folder: string; videos: number }) => [f.folder, f.videos]),
    [
      ['ACME', 3],
      ['ACME/Reels', 1],
    ],
  );
  assert.ok(!(await forYou()).some((s: string) => s === spot || s === teaser), 'the inbox drops its work');
  assert.ok(!(await stuck()).includes(spot), 'Insights: nothing of it waits now');
  assert.deepEqual(await status(), [film]);

  json(await restore());
  assert.ok((await forYou()).includes(spot), 'restored: back in the inbox');
  assert.ok((await status()).includes(spot));
  assert.equal(json(await request('GET', '/api/search?q=spot', { headers: as.owner })).videos[0]?.slug, spot);
});

/** The screenshot files in a video's folder (`c_<id>_clean.png`, `_marked.png`, `_range.jpg`). */
const shotsOf = (slug: string) =>
  fs
    .readdirSync(reviewDir(slug))
    .filter((f) => /^c_.*\.(png|jpg)$/.test(f))
    .sort();
/** A note as `vr add` (and MCP's add_note) hands it to the backend. */
const noteAt = (frame: number, text: string) => ({ v: 1, frame, range: null, text, tags: [], severity: 'should' as const, drawing: [], author: 'tester' });

test('a note or reference refused in an archived project leaves nothing behind: no screenshot, no frame grabbed', async () => {
  await restore();
  json(await archive());
  const had = shotsOf(spot);
  const notes = must(store.loadReview(spot)).comments.length;
  const agent = await mcp('member');
  try {
    for (const args of [
      { video: spot, frame: 2, text: 'Is the logo late?' },
      { video: spot, frame: 1, to_frame: 6, text: 'This whole stretch' },
    ]) {
      const r = await agent.call('add_note', args);
      assert.equal(r.text, `Error: ${SENTENCE}`, JSON.stringify(args));
    }
    // refused before its frame is grabbed: the archive answers, not the frame past the end
    const ref = await agent.call('attach_reference', { id: open.id, video: spot, frame: 9999, caption: 'like this' });
    assert.equal(ref.text, `Error: ${SENTENCE}`);
  } finally {
    await agent.close();
  }
  // `vr add` on the machine: the same backend
  await assert.rejects(createLocalBackend().addNote(spot, noteAt(2, 'Late?')), { message: SENTENCE });
  assert.deepEqual(shotsOf(spot), had, 'no screenshot left in the video’s folder');
  assert.equal(must(store.loadReview(spot)).comments.length, notes, 'no note either');
  json(await restore());
});

test('a note refused once its screenshots are made (archived meanwhile) takes them with it', async () => {
  await restore();
  const had = shotsOf(spot);
  const adding = createLocalBackend().addNote(spot, noteAt(2, 'Late?'));
  // archived while the screenshots are being made: the store refuses the note as it writes
  folders.archiveProject('ACME', { name: 'Ada' });
  await assert.rejects(adding, { message: SENTENCE });
  assert.deepEqual(shotsOf(spot), had);
  folders.restoreProject('ACME');
});

test('a render is never tracked into an archived project: refused before it is added', async () => {
  await restore();
  json(await archive());
  const late = clip('acme/late.mp4');
  await assert.rejects(createLocalBackend().track(late, { by: 'tester', folder: 'ACME/Reels' }), { message: SENTENCE });
  assert.equal(store.loadReview(slugify(late)), null, 'nothing tracked');
  // track_video, the server machine's own agent
  const machine = await mcp('owner', 'local');
  try {
    const r = await machine.call('track_video', { path: late, folder: 'ACME' });
    assert.equal(r.text, `Error: ${SENTENCE}`);
  } finally {
    await machine.close();
  }
  assert.equal(store.loadReview(slugify(late)), null, 'nothing tracked');
  json(await restore());
});

test('a project called constructor, __proto__ or toString is archived and restored like any other', async () => {
  await restore();
  const guest = { ...origin, Host: 'review.test' };
  for (const [i, name] of ['constructor', '__proto__', 'toString'].entries()) {
    json(await request('POST', '/api/folders', { body: { path: name }, headers: as.member }));
    const slug = filed(`names/clip-${i}.mp4`, name);
    const link = json(await request('POST', '/api/folder-shares', { body: { folder: name, comment: true }, headers: as.owner })).token;
    const page = () => request('GET', `/api/g/${link}`, { headers: guest });
    assert.equal(json(await page()).videos.length, 1, `${name}: its review link shows its video`);
    assert.equal(json(await restore(as.admin, name)).restored, false, `${name}: not archived, nothing to restore`);

    const done = json(await archive(as.admin, name));
    assert.equal(done.archived.by, 'Ada', name);
    assert.ok(Object.hasOwn(done.archived_projects ?? {}, name), `${name} is archived`);
    assert.ok(Object.hasOwn(foldersFile().archived ?? {}, name), `${name}: kept in folders.json`);
    const note = await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 1, text: 'In?' }, headers: as.memberToken });
    assert.equal(note.status, 423, `${name}: ${note.text}`);
    assert.deepEqual(note.json(), { archived: name, error: `the project "${name}" is archived: it is read-only until a person restores it` });
    const shut = json(await page());
    assert.deepEqual([shut.videos.length, shut.perms.comment], [1, false], `${name}: its link plays, watch only`);

    assert.equal(json(await restore(as.admin, name)).restored, true, name);
    assert.ok(!Object.hasOwn(foldersFile().archived ?? {}, name), `${name}: restored`);
    json(await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 1, text: 'In again' }, headers: as.memberToken }));
    assert.equal(json(await page()).perms.comment, true, `${name}: its link takes notes again`);
  }
  // the app's own view while an archive or a restore waits behind its Undo (web/src/library/archiving.ts) holds them too
  for (const name of ['constructor', '__proto__', 'toString']) {
    const record = { at: '2026-10-07T10:00:00+02:00', by: 'Ada' };
    const shown = archivedWithHeld({}, new Map([[name, record]]));
    assert.equal(archivedIn(`${name}/Cuts`, shown), name, `${name}: shown archived at once`);
    assert.deepEqual(shown[name], record);
    const back = archivedWithHeld({ [name]: record }, new Map([[name, null]]));
    assert.equal(archivedIn(name, back), null, `${name}: shown restored at once`);
  }
});

test('a project archived in one workspace is that workspace’s: the other’s project of the same name stays open', async () => {
  await restore();
  const ws = await import('../../lib/workspaces.ts');
  const { inWorkspace } = await import('../../lib/scope.ts');
  const bob = await auth.createUser({ email: 'bob@other.example', name: 'Bob', password: 'bobs password 1', role: 'reviewer' });
  const bravo = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
  const asBob = { Cookie: `vr_session=${auth.signSession(bob, 1, bravo)}`, ...origin };
  const theirs = inWorkspace(bravo, () => filed('bravo/spot.mp4', 'ACME/Reels'));
  json(await archive(asBob));
  assert.deepEqual(Object.keys(json(await request('GET', '/api/library', { headers: asBob })).archived_projects), ['ACME']);
  assert.equal(json(await request('GET', '/api/library', { headers: as.member })).archived_projects, undefined, 'ours stays open');
  const note = json(await request('POST', `/api/review/${enc(spot)}/comments`, { body: { frame: 1, text: 'Still ours' }, headers: as.memberToken }));
  inWorkspace('w1', () => store.deleteComment(note.id));
  refused(await request('POST', `/api/review/${enc(theirs)}/comments`, { body: { frame: 1, text: 'Theirs' }, headers: asBob }), 'theirs is archived');
  json(await archive());
  json(await restore(asBob));
  refused(await request('POST', `/api/review/${enc(spot)}/comments`, { body: { frame: 1, text: 'Ours now' }, headers: as.memberToken }), 'ours archived');
  assert.equal(json(await request('GET', '/api/library', { headers: asBob })).archived_projects, undefined, 'theirs restored');
  json(await restore());
});
