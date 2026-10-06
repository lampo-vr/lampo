// A review link is for one video or one folder — that one, not whatever later takes its name. Deleting the video or
// the folder ends its links; a video added again at the same path, or a project made again under the same name, is
// another one; a link whose video or folder went some other way opens nothing and is still listed for its owner to
// revoke; links from before (an older shares.json) are bound to what they were made for at the next start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, isolatedEnv, makeVideo, sleep, vr } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir, env } = isolatedEnv();
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const shares = await import('../../lib/shares.ts');
const { DATA, isoLocal, reviewDir, slugify } = await import('../../lib/paths.ts');

let server: http.Server;
let owner: Request;
let guest: Request;
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'test-token', loadSessions: async () => [] })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  owner = client(port);
  guest = client(port, { 'x-forwarded-for': '203.0.113.7' });
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const enc = encodeURIComponent;
function track(rel: string, folder: string | null, pattern = 'testsrc'): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1, pattern });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugify(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}
async function folderLink(folder: string, label = folder): Promise<string> {
  const r = await owner('POST', '/api/folder-shares', { body: { folder, label } });
  assert.equal(r.status, 200, r.text);
  return r.json().token;
}
async function videoLink(slug: string): Promise<string> {
  const r = await owner('POST', `/api/review/${enc(slug)}/shares`, { body: { label: 'Client' } });
  assert.equal(r.status, 200, r.text);
  return r.json().token;
}
/** What a link's visitor sees: the names of its videos, or the status it answers with. */
async function shows(token: string): Promise<string[] | number> {
  const r = await guest('GET', `/api/g/${token}`);
  return r.status === 200
    ? r
        .json()
        .videos.map((v: { name: string }) => v.name)
        .sort()
    : r.status;
}
/** Waits for the clock's next second: the store's times are whole seconds, and the repair goes by what came first. */
async function nextSecond(): Promise<void> {
  const now = isoLocal();
  while (isoLocal() === now) await sleep(20);
}
const every = async () => (await owner('GET', '/api/shares')).json().shares as { token: string; gone?: boolean; label: string }[];

test('a project link ends with its project: a new project of the same name, for another client, is another project', async () => {
  track('a/acme-teaser.mp4', 'Review');
  const link = await folderLink('Review');
  assert.deepEqual(await shows(link), ['acme-teaser.mp4']);
  assert.equal((await owner('DELETE', `/api/folders?path=${enc('Review')}`)).status, 200);
  assert.equal(await shows(link), 404, 'revoked with its project');

  track('b/globex-launch.mp4', 'Review', 'smptebars');
  assert.equal(await shows(link), 404, 'the next project called Review is not covered');
  assert.deepEqual((await owner('GET', `/api/folder-shares?folder=${enc('Review')}`)).json().shares, [], 'nor listed as its link');
  assert.ok(!(await every()).some((s) => s.token === link), 'a revoked link is not among the links out there');
});

test('a video link ends with its video: the same file added again is another video', async () => {
  const slug = track('c/spot.mp4', null);
  const link = await videoLink(slug);
  assert.deepEqual(await shows(link), ['spot.mp4']);
  const removed = await owner('DELETE', `/api/library/${enc(slug)}`);
  assert.deepEqual(removed.json(), { ok: true, archived: false }, 'no notes: deleted, not archived');
  assert.equal(await shows(link), 404, 'revoked with its video');

  assert.equal(track('c/spot.mp4', null, 'smptehdbars'), slug, 'the same path is the same slug');
  assert.equal(await shows(link), 404, 'the old link stays ended');
  const listed = (await owner('GET', `/api/review/${enc(slug)}/shares`)).json().shares;
  assert.ok(!listed.some((s: { token: string }) => s.token === link), 'and is not the new video’s link');
});

test('an archived video keeps its link: it covers nothing while archived and comes back with the video', async () => {
  const slug = track('c/kept.mp4', null);
  const link = await videoLink(slug);
  store.addComment(slug, { frame: 1, text: 'keep me', author: 'tester' });
  assert.equal((await owner('DELETE', `/api/library/${enc(slug)}`)).json().archived, true);
  assert.deepEqual(await shows(link), [], 'archived: nothing to show, the link stays');
  assert.equal((await owner('POST', `/api/library/${enc(slug)}/restore`)).status, 200);
  assert.deepEqual(await shows(link), ['kept.mp4']);
});

test('deleting a folder: a subfolder link follows it up, unless it would fall into a folder already there', async () => {
  track('d/solo.mp4', 'Old/Solo');
  track('d/one.mp4', 'Old/Common');
  track('d/two.mp4', 'Common');
  const solo = await folderLink('Old/Solo');
  const merged = await folderLink('Old/Common');
  const common = await folderLink('Common');
  assert.equal((await owner('DELETE', `/api/folders?path=${enc('Old')}`)).status, 200);
  assert.deepEqual(await shows(solo), ['solo.mp4'], 'Solo moved up, its link with it');
  assert.equal(await shows(merged), 404, 'Old/Common fell into Common: its link would have shown Common’s videos');
  assert.deepEqual(await shows(common), ['one.mp4', 'two.mp4'], 'Common’s own link shows what is in Common now');
  // and renaming: the link's folder id moves with the folder
  assert.equal((await owner('PATCH', '/api/folders', { body: { from: 'Solo', to: 'Solo 2026' } })).status, 200);
  assert.deepEqual(await shows(solo), ['solo.mp4']);
});

test('gone some other way (an older app, a hand-edited store): the link opens nothing, and the list of every link finds it to revoke', async () => {
  // a project an older app deleted: its videos moved out, the name taken out of folders.json (and with it the ids)
  const old = track('e/outside.mp4', 'Outside');
  const link = await folderLink('Outside');
  const file = path.join(DATA, 'folders.json');
  folders.moveVideo(old, null, 'tester');
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ folders: f.folders.filter((x: string) => x !== 'Outside') }));
  track('e/inside.mp4', 'Outside', 'smptebars');
  assert.equal(await shows(link), 404, 'the new Outside is another folder');
  assert.equal((await every()).find((s) => s.token === link)?.gone, true, 'listed, as gone');

  // a video whose review was removed by hand, and the file added again
  const slug = track('e/promo.mp4', null);
  const vlink = await videoLink(slug);
  fs.rmSync(reviewDir(slug), { recursive: true });
  track('e/promo.mp4', null, 'smptehdbars');
  assert.deepEqual(await shows(vlink), [], 'covers nothing: the promo added again is another video');
  for (const url of [`/api/g/${vlink}/waveform`, `/media/g/${vlink}/v1`]) assert.equal((await guest('GET', url)).status, 404, `${url}: nothing of it`);
  const listed = await every();
  assert.equal(listed.find((s) => s.token === vlink)?.gone, true);
  assert.ok(!listed.find((s) => s.token === vlink && s.label === 'promo.mp4'), 'never named after the new video');

  for (const t of [link, vlink]) assert.equal((await owner('DELETE', `/api/shares/${t}`)).json().ok, true);
  assert.ok(!(await every()).some((s) => s.token === link || s.token === vlink), 'revoked: no longer out there');
  const visitor = await guest('GET', '/api/shares');
  assert.equal(visitor.status, 401, 'the list is the owner’s, never a visitor’s');
  assert.ok(!visitor.text.includes(link));
});

test('a folders.json that can’t be read is never taken as empty: a folder change fails, and every folder link still works afterwards (VB-1)', async () => {
  track('g/acme-spring.mp4', 'Acme');
  track('g/globex-launch.mp4', 'Globex', 'smptebars');
  const acme = await folderLink('Acme');
  const globex = await folderLink('Globex');
  const file = path.join(DATA, 'folders.json');
  const whole = fs.readFileSync(file, 'utf8');
  const changes: [string, () => unknown][] = [
    ['a new folder', () => folders.createFolder('New project')],
    ['a link on a folder', () => folders.folderIdFor('Globex')],
    ['a rename', () => folders.renameFolder('Acme', 'Acme 2')],
    ['a delete', () => folders.deleteFolder('Globex')],
    ['a video moved into a new folder', () => folders.moveVideo(slugify(path.join(dir, 'g/acme-spring.mp4')), 'Elsewhere')],
  ];
  // damaged (a disk that filled up while it was copied back, a bad restore)
  const damaged = whole.slice(0, Math.floor(whole.length / 2));
  fs.writeFileSync(file, damaged);
  for (const [what, change] of changes) assert.throws(change, /folders\.json is damaged/, what);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'nothing was written');
  // unreadable for a moment (permissions; root reads anything, so only as anyone else)
  fs.writeFileSync(file, whole);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(file, 0o000);
    try {
      for (const [what, change] of changes) assert.throws(change, /EACCES/, what);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), whole, 'the ids are all still there');
  assert.deepEqual(await shows(acme), ['acme-spring.mp4'], 'once it reads again, every folder link works');
  assert.deepEqual(await shows(globex), ['globex-launch.mp4']);
  assert.equal(store.loadReview(slugify(path.join(dir, 'g/acme-spring.mp4')))?.folder, 'Acme', 'and the video stayed where it was');
});

test('links from an older shares.json work as they did, and are bound to their video or folder at the next start', async () => {
  const live = track('f/live.mp4', 'Clients/Live');
  const gone = track('f/gone.mp4', null);
  const file = path.join(DATA, 'shares.json');
  // The shape of a store from before: tokens in clear as keys, no ids, nothing about what a link was made for. The
  // links were made after their videos were added (a link can't be older than its video).
  const made = isoLocal();
  const older = {
    LegacyLinkToLiveVideo_abc: { slug: live, label: 'Live video', created: made, by: 'tester' },
    LegacyLinkToGoneVideo_abc: { slug: gone, label: 'Gone video', created: made, by: 'tester' },
    LegacyLinkToLiveFolder_ab: { folder: 'Clients/Live', label: 'Live folder', created: made, by: 'tester' },
    LegacyLinkToGoneFolder_ab: { folder: 'Clients/Gone', label: 'Gone folder', created: made, by: 'tester' },
  };
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ shares: { ...now.shares, ...older } }, null, 2));
  store.removeVideo(gone, 'tester');

  // loads unchanged: the links open as before
  assert.deepEqual(await shows('LegacyLinkToLiveVideo_abc'), ['live.mp4']);
  assert.deepEqual(await shows('LegacyLinkToLiveFolder_ab'), ['live.mp4']);
  assert.deepEqual(await shows('LegacyLinkToGoneFolder_ab'), []);

  // the start-up (server/index.ts): tokens stored hashed, then every link bound to what it was made for, once
  shares.migrateShareTokens();
  assert.deepEqual(folders.bindShareLinks(), { bound: 2, ended: 2 });
  assert.deepEqual(folders.bindShareLinks(), { bound: 0, ended: 0 }, 'once');
  assert.deepEqual(await shows('LegacyLinkToLiveVideo_abc'), ['live.mp4']);
  assert.deepEqual(await shows('LegacyLinkToLiveFolder_ab'), ['live.mp4']);
  assert.equal(await shows('LegacyLinkToGoneVideo_abc'), 404, 'its video was gone: ended');
  assert.equal(await shows('LegacyLinkToGoneFolder_ab'), 404, 'its folder never existed any more: ended');

  // bound: the video added again, the folder made again, neither is covered
  const raw = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).shares) as { label: string; video_added?: string; folder_id?: string }[];
  assert.equal(raw.find((s) => s.label === 'Live video')?.video_added, store.loadReview(live)?.added);
  assert.match(String(raw.find((s) => s.label === 'Live folder')?.folder_id), /^f_[a-f0-9]{12}$/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(DATA, 'folders.json'), 'utf8')).ids['Clients/Live']);
  assert.equal((await owner('DELETE', `/api/folders?path=${enc('Clients/Live')}`)).status, 200);
  track('f/other.mp4', 'Clients/Live', 'smptebars');
  assert.equal(await shows('LegacyLinkToLiveFolder_ab'), 404);
});

test('a link from before whose video was removed and added again before the upgrade ends at the start: it never binds to the newcomer (VB-3)', async () => {
  // An older store: the app before links knew their video, where the spot a link was made for was removed and the file
  // added again (the orphan state GUEST-1 describes). Its review is from before review ids, and so is shares.json.
  const slug = track('h/spot.mp4', null, 'smptehdbars');
  const reviewFile = path.join(reviewDir(slug), 'review.json');
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  delete review.id;
  fs.writeFileSync(reviewFile, JSON.stringify(review, null, 2));
  const dayBefore = isoLocal(new Date(Date.parse(review.added) - 86_400_000));
  const file = path.join(DATA, 'shares.json');
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  const older = {
    // made for the spot that was there before: a day older than the video at its name now
    OldLinkForTheFirstSpot_xy: { slug, label: 'Spot, first cut', created: dayBefore, by: 'tester' },
    // made for the spot that is there now
    NewLinkForTheSecondSpot_x: { slug, label: 'Spot, second cut', created: isoLocal(), by: 'tester' },
  };
  fs.writeFileSync(file, JSON.stringify({ shares: { ...now.shares, ...older } }, null, 2));
  shares.migrateShareTokens();

  assert.deepEqual(folders.bindShareLinks(), { bound: 1, ended: 1 });
  assert.equal(await shows('OldLinkForTheFirstSpot_xy'), 404, 'older than the video at its name: ended, never the newcomer');
  assert.deepEqual(await shows('NewLinkForTheSecondSpot_x'), ['spot.mp4'], 'made for it: bound');
  const raw = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).shares) as { label: string; revoked?: string; video_added?: string; video_id?: string }[];
  assert.ok(raw.find((s) => s.label === 'Spot, first cut')?.revoked, 'revoked, so it stays out of every list');
  const bound = raw.find((s) => s.label === 'Spot, second cut');
  assert.equal(bound?.video_added, review.added, 'bound by `added` alone (a review from before ids)');
  assert.equal(bound?.video_id, undefined);
});

test('while folders.json is damaged the library, search and downloads show the videos’ folders, a folder link says to come back, and vr admin repair-folders rebuilds it with its ids (VB-1)', async () => {
  track('k/kilo-spring.mp4', 'Kilo');
  track('k/lima-launch.mp4', 'Lima', 'smptebars');
  folders.createFolder('Mike (empty)');
  await nextSecond(); // the videos were there before the links (what the repair takes as a link's own folder)
  const kilo = await folderLink('Kilo');
  const lima = await folderLink('Lima');
  const file = path.join(DATA, 'folders.json');
  const whole = fs.readFileSync(file, 'utf8');
  const linksBefore = (await every()).map((s) => [s.label, !!s.gone]);
  assert.ok(
    linksBefore.some(([, gone]) => gone),
    'a link that ended some other way is among them (the earlier tests)',
  );
  // Cut short inside its ids: Kilo's is still in the text, Lima's only on its link.
  const damaged = whole.slice(0, whole.indexOf('"Lima": "f_'));
  fs.writeFileSync(file, damaged);

  const logged: string[] = [];
  const { error } = console;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    for (let i = 0; i < 2; i++) {
      const lib = await owner('GET', '/api/library');
      assert.equal(lib.status, 200, lib.text);
      assert.ok(lib.json().folders.includes('Kilo') && lib.json().folders.includes('Lima'), 'the videos’ folders');
      assert.ok(!lib.json().folders.includes('Mike (empty)'), 'empty folders wait for the file');
      assert.deepEqual(lib.json().degraded, ['folders']);
    }
    assert.deepEqual((await owner('GET', '/api/folders')).json().degraded, ['folders']);
    const found = await owner('GET', '/api/search?q=kilo');
    assert.equal(found.status, 200);
    assert.ok(found.json().folders.some((x: { folder: string }) => x.folder === 'Kilo'));
    assert.equal((await owner('GET', `/api/folders/download/info?folder=${enc('Kilo')}`)).status, 200, 'the folder downloads');
  } finally {
    console.error = error;
  }
  assert.equal(logged.filter((l) => /^folders: .*folders\.json is damaged/.test(l)).length, 1, `said once:\n${logged.join('\n')}`);
  // A client's folder link can't be checked meanwhile: "come back", never "not valid any more".
  const visit = await guest('GET', `/api/g/${kilo}`);
  assert.equal(visit.status, 503);
  assert.equal(visit.json().error, 'that isn’t available right now: try again later');
  // Changes still refuse, and the file stays as it was.
  assert.equal((await owner('POST', '/api/folders', { body: { path: 'November' } })).status, 503);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);

  // The repair: a dry run says what it would write, and writes nothing.
  const dry = vr(['admin', 'repair-folders'], env);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /folders\.json is damaged \(/);
  assert.match(dry.out, /^rebuilt: \d+ folders, \d+ review-link ids \(\d+ from the damaged file, 1 from review links\)$/m);
  assert.match(dry.out, /nothing written \(a dry run\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  const plan = JSON.parse(vr(['admin', 'repair-folders', '--json'], env).out);
  assert.equal(plan.state, 'damaged');
  assert.equal(plan.ids.find((i: { folder: string }) => i.folder === 'Kilo')?.from, 'file');
  assert.equal(plan.ids.find((i: { folder: string }) => i.folder === 'Lima')?.from, 'link');
  assert.ok(plan.folders.includes('Mike (empty)'));
  // --write: the rebuilt file, the damaged one kept beside it, every folder link working again.
  const wrote = vr(['admin', 'repair-folders', '--write'], env);
  assert.equal(wrote.code, 0, wrote.err);
  const kept = /kept as (.+)$/m.exec(wrote.out)?.[1] ?? '';
  assert.equal(fs.readFileSync(kept, 'utf8'), damaged);
  assert.deepEqual(await shows(kilo), ['kilo-spring.mp4']);
  assert.deepEqual(await shows(lima), ['lima-launch.mp4']);
  assert.deepEqual(
    (await every()).map((s) => [s.label, !!s.gone]),
    linksBefore,
    'every link works as before the damage: none lost, and none that had ended taken back onto a folder of its name',
  );
  const lib = (await owner('GET', '/api/library')).json();
  assert.equal(lib.degraded, undefined);
  assert.ok(lib.folders.includes('Mike (empty)'));
  assert.match(vr(['admin', 'repair-folders'], env).out, /reads fine: nothing to repair/);
});

test('repair-folders never gives an ended link the folder that took its name: with every id lost it takes back only what the store shows is the link’s own folder, of two links on one name only the newer, and the rest is a person’s call (VE1r2-2)', async () => {
  const file = path.join(DATA, 'folders.json');
  const repair = (...args: string[]) => vr(['admin', 'repair-folders', ...args], env);
  const lose = (text: string) => fs.writeFileSync(file, text.slice(0, text.indexOf('"ids"'))); // every id lost
  // The old client's project and its link. Then it ends outside the app (a hand edit, an older version): its video
  // moved out, its name and id taken out of the file — the link opens nothing.
  const oldCut = track('n/old-cut.mp4', 'Northwind', 'rgbtestsrc');
  await nextSecond();
  const old = await folderLink('Northwind', 'Old client');
  store.mutate(oldCut, (r) => {
    r.folder = null;
  });
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  f.folders = f.folders.filter((x: string) => x !== 'Northwind');
  delete f.ids.Northwind;
  fs.writeFileSync(file, JSON.stringify(f, null, 2));
  assert.equal(await shows(old), 404);
  // A new project of that name, for another client; a project whose link is in use; one shared before its video came.
  await nextSecond();
  track('n/new-cut.mp4', 'Northwind', 'smptebars');
  track('n/zeta-cut.mp4', 'Zeta', 'testsrc2');
  folders.createFolder('Upfront');
  await nextSecond();
  const zeta = await folderLink('Zeta');
  const upfront = await folderLink('Upfront');
  await nextSecond();
  track('n/upfront-cut.mp4', 'Upfront', 'yuvtestsrc');
  assert.deepEqual(await shows(upfront), ['upfront-cut.mp4']);
  const whole = fs.readFileSync(file, 'utf8');

  // R5: every id lost. The dry run says what each link would be.
  lose(whole);
  const plan = JSON.parse(repair('--json').out) as { links: { id: string; label: string; state?: string }[] };
  const of = (label: string) => plan.links.find((l) => l.label === label);
  assert.equal(of('Old client')?.state, 'unsure', 'nothing says the Northwind there now is the one it was made on');
  assert.equal(of('Zeta')?.state, 'taken back', 'its video was in Zeta before the link was made');
  assert.equal(of('Upfront')?.state, 'unsure', 'its video came after the link: a person’s call');
  const r5 = repair('--write');
  assert.equal(r5.code, 0, r5.err);
  assert.match(r5.out, /^ {2}not given back: "Old client" on Northwind \(s_[0-9a-f]+\): .*--take-back s_[0-9a-f]+$/m);
  assert.match(r5.out, /^ {2}given back: "Zeta" on Zeta \(s_[0-9a-f]+\)$/m);
  assert.equal(await shows(old), 404, 'the ended link stays ended: the new client’s project isn’t shown to the old one');
  assert.deepEqual(await shows(zeta), ['zeta-cut.mp4']);
  assert.equal(await shows(upfront), 404);

  // A person decides for Upfront: --take-back with its id (an unknown id is refused, and nothing is written).
  lose(whole);
  const damaged = fs.readFileSync(file, 'utf8');
  const unknown = repair('--write', '--take-back', 's_0000000000');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no folder review link s_0000000000/);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  const taken = repair('--write', '--take-back', of('Upfront')?.id as string);
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, /^ {2}given back: "Upfront" on Upfront \(s_[0-9a-f]+\): by --take-back$/m);
  assert.deepEqual(await shows(upfront), ['upfront-cut.mp4']);
  assert.deepEqual(await shows(zeta), ['zeta-cut.mp4']);
  assert.equal(await shows(old), 404);

  // R5b: the new client gets a link of its own (a new id: the old one had ended); every id lost again.
  fs.writeFileSync(file, whole);
  const fresh = await folderLink('Northwind', 'New client');
  assert.deepEqual(await shows(fresh), ['new-cut.mp4']);
  const whole2 = fs.readFileSync(file, 'utf8');
  const freshId = JSON.parse(whole2).ids.Northwind;
  lose(whole2);
  const r5b = repair('--write');
  assert.equal(r5b.code, 0, r5b.err);
  assert.match(r5b.out, /^ {2}stays ended: "Old client" on Northwind \(s_[0-9a-f]+\): a later link was made on a folder of that name/m);
  assert.equal(await shows(old), 404, 'the old link stays ended');
  assert.deepEqual(await shows(fresh), ['new-cut.mp4'], 'the live link works');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ids.Northwind, freshId);
  // With the newer id still in the damaged text: the same.
  fs.writeFileSync(file, `${whole2.slice(0, whole2.indexOf('"ids"'))}"ids": { "Northwind": "${freshId}",`);
  assert.equal(repair('--write').code, 0);
  assert.deepEqual(await shows(fresh), ['new-cut.mp4']);
  assert.equal(await shows(old), 404);
});

test('while folders.json is damaged the owner still lists every review link, and stages keep theirs (VE1r2-5)', async () => {
  const slug = track('o/oscar-cut.mp4', 'Oscar', 'smptehdbars');
  const folder = await folderLink('Oscar');
  const video = await videoLink(slug);
  // A client opens the video through its link: its stage says so.
  const id = (await guest('GET', `/api/g/${video}`)).json().videos[0].slug;
  const view = () => guest('GET', `/api/g/${video}/review/${enc(id)}`);
  assert.equal((await view()).status, 200);
  const shareOf = async () =>
    ((await owner('GET', '/api/library')).json().videos as { slug: string; stage?: { share?: { opened?: boolean } | null } }[]).find((v) => v.slug === slug)
      ?.stage?.share;
  assert.equal((await shareOf())?.opened, true);
  const labels = (r: { json(): { shares: { label: string }[] } }) => r.json().shares.map((s) => s.label);

  const file = path.join(DATA, 'folders.json');
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  const logged: string[] = [];
  const { error } = console;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    const all = await owner('GET', '/api/shares');
    assert.equal(all.status, 200, all.text);
    assert.ok(labels(all).includes('Oscar') && labels(all).includes('Client'), 'both links, the folder link among them');
    const own = await owner('GET', `/api/review/${enc(slug)}/shares`);
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(labels(own).sort(), ['Client', 'Oscar']);
    const inFolder = await owner('GET', `/api/folder-shares?folder=${enc('Oscar')}`);
    assert.equal(inFolder.status, 200, inFolder.text);
    assert.deepEqual(labels(inFolder), ['Oscar']);
    // Another view changes the links' version: the stages read the links again, and keep them.
    assert.equal((await view()).status, 200, 'the video link opens: it needs no folder');
    assert.equal((await shareOf())?.opened, true, 'the stage keeps its link');
    assert.equal(logged.filter((l) => /^review links:/.test(l)).length, 0, `no "shares.json can't be read" for a damaged folders.json:\n${logged.join('\n')}`);
    // What opens a folder link still waits for the file: its client is asked to come back.
    assert.equal((await guest('GET', `/api/g/${folder}`)).status, 503);
  } finally {
    console.error = error;
    fs.writeFileSync(file, whole);
  }
  assert.deepEqual(await shows(folder), ['oscar-cut.mp4']);
});
