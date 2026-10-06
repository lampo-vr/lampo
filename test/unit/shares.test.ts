// Review links v2 over HTTP: every rule a guest link carries is enforced by the server (view-only, approvals,
// notes own/all, versions, downloads, expiry, passwords + throttling, folder scope), threads and fix checks become
// normal events, and links from before these settings keep working exactly as they did.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, must, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// The team's name, shown to clients next to who shared the link.
process.env.VR_ORG_NAME = 'Northwind Studio';
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const { DATA } = await import('../../lib/paths.ts');

function track(rel: string, folder: string | null): string {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return slug;
}

const spot = track('proj/export/spot.mp4', 'Acme/Reels');
const cut = track('proj/export/cut.mp4', 'Acme/Reels/Cutdowns');
const other = track('proj/export/other.mp4', 'Acme/Other');

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

interface Reply {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function request(method: string, url: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text, headers: res.headers, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
// A visitor from elsewhere: guest routes are the only thing that answers them.
const remote = { 'x-forwarded-for': '203.0.113.9' };
const guest = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(method, url, { body, headers: { ...remote, ...headers } });
const enc = encodeURIComponent;
async function makeLink(target: { slug: string } | { folder: string }, settings: object = {}) {
  const r =
    'slug' in target
      ? await request('POST', `/api/review/${enc(target.slug)}/shares`, { body: settings })
      : await request('POST', '/api/folder-shares', { body: { folder: target.folder, ...settings } });
  assert.equal(r.status, 200, r.text);
  return r.json();
}
const note = (token: string, body: object) => guest('POST', `/api/g/${token}/comments`, { name: 'Mia', frame: 3, text: 'Logo später', ...body });
/** A video's page through a link once its player has something to play (a link's preview copy is made on demand). */
async function playing(token: string, slug: string, v?: number) {
  for (let i = 0; i < 200; i++) {
    const page = await guest('GET', `/api/g/${token}/review/${enc(slug)}${v ? `?v=${v}` : ''}`);
    assert.equal(page.status, 200, page.text);
    if (page.json().media) return page.json();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the preview copy never got made');
}

test('links from before v2 behave as they did: one video, comment + approve, their notes, newest version, no download', async () => {
  const token = 'OldStyleToken_abcdefghijkl';
  const file = path.join(DATA, 'shares.json');
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { shares: {} };
  old.shares[token] = { slug: spot, label: 'Legacy client', created: '2026-09-01T10:00:00+02:00', by: 'tester' };
  fs.writeFileSync(file, JSON.stringify(old));
  const g = (await guest('GET', `/api/g/${token}`)).json();
  assert.equal(g.kind, 'video');
  assert.deepEqual(g.perms, { comment: true, approve: true, notes: 'own', versions: 'latest', download: 'off' });
  assert.equal(g.videos.length, 1);
  assert.equal((await note(token, {})).status, 200);
  const rv = (await guest('GET', `/api/g/${token}/review/${enc(spot)}`)).json();
  assert.equal(rv.notes.length, 1);
  assert.equal(rv.notes[0].mine, true);
  assert.equal(rv.download.preview, null);
  assert.equal((await guest('GET', `/api/g/${token}/download/${enc(spot)}/v1?kind=preview`)).status, 403);
  // The old URLs the first UI used still answer.
  assert.equal((await guest('GET', `/api/g/${token}/waveform`)).status, 200);
  assert.equal((await guest('GET', `/data/g/${token}/${rv.notes[0].marked.split('/').pop()}`)).status, 200);
});

test('a link says who shared it by a name they chose, and for which team, before and after the password', async () => {
  const l = await makeLink({ slug: spot }, { password: 'rushes-2026' });
  const expired = await makeLink({ slug: spot }, { expires: '2020-01-01T00:00:00Z' });
  const g = (await guest('GET', `/api/g/${l.token}`)).json();
  assert.equal(g.locked, true);
  assert.equal(g.org, 'Northwind Studio', 'the team name from org_name / VR_ORG_NAME');
  assert.equal(g.videos.length, 0, 'nothing of the video before the password');
  // The machine's owner starts out named after the OS account: anyone with the URL would read that login name.
  assert.equal(g.reviewer, null, 'no name the owner never chose');
  const unlocked = await guest('POST', `/api/g/${l.token}/unlock`, { password: 'rushes-2026' });
  const cookie = String(unlocked.headers['set-cookie']).split(';')[0];
  assert.equal((await guest('GET', `/api/g/${l.token}/review/${enc(spot)}`, undefined, { cookie })).json().reviewer, null, 'nor behind the password');
  assert.equal((await guest('GET', `/api/g/${expired.token}`)).json().by, null, 'nor on an expired link');
  // Once they choose a name in Profile, their links say it, the ones made before too.
  assert.equal((await request('PATCH', '/api/auth/me', { body: { name: 'Sam Rivera' } })).status, 200);
  try {
    assert.equal((await guest('GET', `/api/g/${l.token}`)).json().reviewer, 'Sam Rivera');
    assert.equal((await guest('GET', `/api/g/${expired.token}`)).json().by, 'Sam Rivera');
    const later = await makeLink({ slug: spot });
    assert.equal((await guest('GET', `/api/g/${later.token}/review/${enc(spot)}`)).json().reviewer, 'Sam Rivera');
  } finally {
    await request('PATCH', '/api/auth/me', { body: { name: 'tester' } });
  }
});

test('clients can mark a note as just an idea: stored as idea, shown as one, never counted as open work', async () => {
  const link = await makeLink({ slug: spot }, { label: 'Ideas' });
  const r = await note(link.token, { text: 'Vielleicht ein wärmerer Look', idea: true });
  assert.equal(r.status, 200, r.text);
  const rv = (await guest('GET', `/api/g/${link.token}/review/${enc(spot)}`)).json();
  const mine = rv.notes.find((n: { id: string }) => n.id === r.json().id);
  assert.equal(mine.idea, true);
  const stored = must(store.loadReview(spot)).comments.find((c) => c.id === r.json().id);
  assert.equal(stored?.severity, 'idea');
  const before = store.counts(must(store.loadReview(spot)));
  assert.ok(before.ideas >= 1, 'counted as an idea');
  assert.equal((await note(link.token, { text: 'Logo zu klein' })).status, 200);
  const plain = (await guest('GET', `/api/g/${link.token}/review/${enc(spot)}`)).json().notes.find((n: { text: string }) => n.text === 'Logo zu klein');
  assert.equal(plain.idea, false, 'a normal client note stays a change request');
  const later = store.counts(must(store.loadReview(spot)));
  assert.equal(later.open, before.open + 1, 'only the change request adds open work');
  assert.equal(later.ideas, before.ideas);
});

test('view-only links: no notes, replies or approvals; approvals can be switched off separately', async () => {
  const view = await makeLink({ slug: spot }, { label: 'Watchers', comment: false, approve: false });
  assert.equal((await note(view.token, {})).status, 403);
  assert.equal((await guest('POST', `/api/g/${view.token}/approval`, { name: 'Mia', status: 'approved' })).status, 403);
  const noApprove = await makeLink({ slug: spot }, { approve: false });
  assert.equal((await note(noApprove.token, {})).status, 200);
  assert.equal((await guest('POST', `/api/g/${noApprove.token}/approval`, { name: 'Mia', status: 'approved' })).status, 403);
});

test("'own' shows a link's own client notes, 'all' every client note; internal notes never", async () => {
  const a = await makeLink({ slug: cut }, { label: 'A' });
  const b = await makeLink({ slug: cut }, { label: 'B' });
  const everyone = await makeLink({ slug: cut }, { label: 'Everyone', notes: 'all' });
  store.addComment(cut, { frame: 2, text: 'internal: grade is off', author: 'tester' });
  assert.equal((await note(a.token, { text: 'from A' })).status, 200);
  assert.equal((await note(b.token, { text: 'from B' })).status, 200);
  const texts = async (token: string) => (await guest('GET', `/api/g/${token}/review/${enc(cut)}`)).json().notes.map((n: { text: string }) => n.text);
  assert.deepEqual(await texts(a.token), ['from A']);
  assert.deepEqual(await texts(b.token), ['from B']);
  assert.deepEqual((await texts(everyone.token)).sort(), ['from A', 'from B']);
  // Screenshots follow the same rule.
  const bNote = (await guest('GET', `/api/g/${b.token}/review/${enc(cut)}`)).json().notes[0];
  const file = bNote.marked.split('/').pop();
  assert.equal((await guest('GET', `/data/g/${a.token}/${enc(cut)}/${file}`)).status, 404);
  assert.equal((await guest('GET', `/data/g/${everyone.token}/${enc(cut)}/${file}`)).status, 200);
});

test("'own' links keep their clients' verdicts apart too: another link's verdict, name and words never show, and its client still decides", async () => {
  const slug = track('proj/export/verdicts.mp4', null);
  const a = await makeLink({ slug }, { label: 'Client' });
  const b = await makeLink({ slug }, { label: 'Agency' });
  const idOf = async (token: string) => (await guest('GET', `/api/g/${token}`)).json().videos[0].slug;
  const [ida, idb] = [await idOf(a.token), await idOf(b.token)];
  const secret = 'legal says the claim at 0:12 is a problem';
  const given = await guest('POST', `/api/g/${a.token}/approval`, { name: 'Mia', slug: ida, v: 1, status: 'changes', note: secret });
  assert.equal(given.status, 200, given.text);

  const page = await guest('GET', `/api/g/${b.token}/review/${idb}`);
  const room = await guest('GET', `/api/g/${b.token}`);
  assert.equal(page.json().approval, null, "B's page: no verdict of B's");
  assert.equal(room.json().videos[0].approval, null, "B's room counts nothing as reviewed by B");
  for (const r of [page, room]) assert.ok(!r.text.includes(secret) && !r.text.includes('Mia'), 'nothing of A’s verdict reaches B');
  assert.equal((await guest('GET', `/api/g/${a.token}/review/${ida}`)).json().approval.note, secret, 'A sees its own');

  const decided = await guest('POST', `/api/g/${b.token}/approval`, { name: 'Bo', slug: idb, v: 1, status: 'approved' });
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json().approval.status, 'approved', 'B decides for itself');
  assert.equal((await guest('GET', `/api/g/${b.token}/review/${idb}`)).json().approval.by, 'guest:Bo');
  assert.equal((await guest('GET', `/api/g/${a.token}/review/${ida}`)).json().approval.status, 'changes', "A's stands for A");

  // "All client notes": one client team sharing a thread sees the clients' latest word, whoever gave it.
  const all = await makeLink({ slug }, { notes: 'all' });
  assert.equal((await guest('GET', `/api/g/${all.token}/review/${await idOf(all.token)}`)).json().approval.by, 'guest:Bo');

  // A verdict from before verdicts named their link can't say whose it is: shown only where one link ever covered it.
  const lone = track('proj/export/verdict-legacy.mp4', null);
  store.setApproval(lone, { status: 'approved', v: 1 }, 'guest:Old', { party: 'client' });
  const first = await makeLink({ slug: lone });
  assert.equal((await guest('GET', `/api/g/${first.token}/review/${await idOf(first.token)}`)).json().approval?.by, 'guest:Old');
  const second = await makeLink({ slug: lone });
  for (const l of [first, second]) assert.equal((await guest('GET', `/api/g/${l.token}/review/${await idOf(l.token)}`)).json().approval, null);
});

test('versions: latest-only links refuse older versions; all-version links list and play them', async () => {
  const file = path.join(dir, 'proj/export/spot.mp4');
  makeVideo(file, { w: 160, h: 90, dur: 1, freq: 880 });
  age(file);
  store.sync(spot);
  const latest = await makeLink({ slug: spot });
  const all = await makeLink({ slug: spot }, { versions: 'all' });
  assert.equal((await guest('GET', `/api/g/${latest.token}/review/${enc(spot)}?v=1`)).status, 403);
  assert.equal((await guest('GET', `/media/g/${latest.token}/${enc(spot)}/v1`)).status, 403);
  const rv = (await guest('GET', `/api/g/${latest.token}/review/${enc(spot)}`)).json();
  assert.equal(rv.v, 2);
  assert.deepEqual(
    rv.versions.map((x: { v: number }) => x.v),
    [2],
  );
  const old = await guest('GET', `/api/g/${all.token}/review/${enc(spot)}?v=1`);
  assert.equal(old.status, 200);
  assert.equal(old.json().v, 1);
  assert.deepEqual(
    old.json().versions.map((x: { v: number }) => x.v),
    [1, 2],
  );
  await playing(all.token, spot, 1);
  assert.equal((await guest('GET', `/media/g/${all.token}/${enc(spot)}/v1`, undefined, { Range: 'bytes=0-99' })).status, 206);
});

test('a client’s verdict names the version on their screen: a render that arrived meanwhile is not approved unseen', async () => {
  // The versions test above re-rendered spot: V2 is the newest. A page opened on V1 still offers the buttons.
  const link = await makeLink({ slug: spot });
  const clientVerdicts = () => (must(store.loadReview(spot)).approvals || []).filter((a) => a.party === 'client').length;
  const before = clientVerdicts();
  const sent = (v?: number) => guest('POST', `/api/g/${link.token}/approval`, { name: 'Mia', slug: spot, status: 'approved', ...(v ? { v } : {}) });
  const stale = await sent(1);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json().latest, 2, 'the page learns which version to look at');
  assert.equal((await sent()).status, 400, 'a verdict without its version');
  assert.equal(clientVerdicts(), before, 'nothing recorded');
  const seen = await sent(2);
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json().approval.v, 2);
});

test('a moment added through a newest-only link is of the newest version: older ones stay out of reach', async () => {
  const latest = await makeLink({ slug: spot });
  const old = { kind: 'frame', video: spot, v: 1, frame: 3 };
  assert.equal((await note(latest.token, { slug: spot, refs: [old] })).status, 403, 'not with a new note');
  const id = (await note(latest.token, { slug: spot })).json().id;
  const refs = (token: string, ref: object) => guest('POST', `/api/g/${token}/comments/${id}/refs`, { name: 'Mia', ...ref });
  assert.equal((await refs(latest.token, old)).status, 403, 'nor added to one');
  assert.equal((await refs(latest.token, { ...old, v: 2 })).status, 200, 'the newest is fine');
  const all = await makeLink({ slug: spot }, { versions: 'all' });
  assert.equal((await note(all.token, { slug: spot, refs: [old] })).status, 200, 'a link that shows every version may');
});

test('downloads: preview or original, only as far as the link allows', async () => {
  const preview = await makeLink({ slug: spot }, { download: 'preview' });
  const original = await makeLink({ slug: spot }, { download: 'original' });
  const rv = await playing(preview.token, spot);
  assert.ok(rv.download.preview);
  assert.equal(rv.download.original, null);
  const p = await guest('GET', rv.download.preview);
  assert.equal(p.status, 200);
  assert.match(String(p.headers['content-disposition']), /attachment; filename="spot-v2-preview\.mp4"/);
  assert.equal((await guest('GET', `/api/g/${preview.token}/download/${enc(spot)}/v2?kind=original`)).status, 403);
  const o = await guest('GET', `/api/g/${original.token}/download/${enc(spot)}/v2?kind=original`);
  assert.equal(o.status, 200);
  assert.match(String(o.headers['content-disposition']), /filename="spot-v2\.mp4"/);
  // Names in any script: an ASCII stand-in for old clients, the real name for the rest (it answered 500 before).
  const named = track('proj/export/Ролик-工作.mp4', 'Acme/Other');
  const link = await makeLink({ slug: named }, { download: 'original' });
  const got = await guest('GET', `/api/g/${link.token}/download/${enc(named)}/v1?kind=original`);
  assert.equal(got.status, 200, got.text);
  const cd = String(got.headers['content-disposition']);
  assert.match(cd, /filename="[\x20-\x7e]+"/, cd);
  assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent('Ролик-工作-v1.mp4')}`), cd);
});

test('expiry: an expired link says so everywhere; clearing the date brings it back', async () => {
  const l = await makeLink({ slug: spot }, { expires: '2020-01-01T00:00:00Z' });
  assert.equal((await guest('GET', `/api/g/${l.token}`)).status, 410);
  const gone = (await guest('GET', `/api/g/${l.token}`)).json();
  assert.match(gone.error, /expired/);
  // The page says whom to ask for a new one (when they chose a name to go by), and since when it's over.
  assert.ok('by' in gone, 'who shared it, or null');
  assert.equal(gone.expired, '2020-01-01T00:00:00Z');
  assert.equal((await guest('GET', `/media/g/${l.token}/${enc(spot)}/v2`)).status, 410);
  assert.equal((await note(l.token, {})).status, 410);
  const fixed = await request('PATCH', `/api/shares/${l.token}`, { body: { expires: null } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json().expired, false);
  assert.equal((await guest('GET', `/api/g/${l.token}`)).status, 200);
});

test('passwords: locked until unlocked, guesses throttled, a new password locks everyone out again', async () => {
  const l = await makeLink({ slug: spot }, { password: 'rushes-2026' });
  assert.equal(l.password, true);
  const locked = (await guest('GET', `/api/g/${l.token}`)).json();
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.videos, []);
  assert.equal((await guest('GET', `/api/g/${l.token}/review/${enc(spot)}`)).status, 401);
  assert.equal((await guest('GET', `/media/g/${l.token}/${enc(spot)}/v2`)).status, 401);
  assert.equal((await guest('POST', `/api/g/${l.token}/unlock`, { password: 'nope' })).status, 403);
  const ok = await guest('POST', `/api/g/${l.token}/unlock`, { password: 'rushes-2026' });
  assert.equal(ok.status, 200);
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
  assert.equal((await guest('GET', `/api/g/${l.token}/review/${enc(spot)}`, undefined, { cookie })).status, 200);
  assert.equal((await guest('GET', `/api/g/${l.token}/review/${enc(spot)}`, undefined, { cookie: `${cookie}x` })).status, 401);
  // A changed password invalidates what browsers unlocked before.
  await request('PATCH', `/api/shares/${l.token}`, { body: { password: 'new-secret-1' } });
  assert.equal((await guest('GET', `/api/g/${l.token}/review/${enc(spot)}`, undefined, { cookie })).status, 401);
  // Five wrong guesses from one visitor, then a pause with Retry-After.
  const ip = { 'x-forwarded-for': '198.51.100.7' };
  for (let i = 0; i < 3; i++) assert.equal((await request('POST', `/api/g/${l.token}/unlock`, { body: { password: `x${i}` }, headers: ip })).status, 403);
  const throttled = await request('POST', `/api/g/${l.token}/unlock`, { body: { password: 'new-secret-1' }, headers: ip });
  // The earlier tries came from the same socket address (tests run on loopback), so the limit is already reached.
  assert.ok(throttled.status === 429 || throttled.status === 200, throttled.text);
  let last = throttled;
  for (let i = 0; i < 6 && last.status !== 429; i++) last = await request('POST', `/api/g/${l.token}/unlock`, { body: { password: 'wrong' }, headers: ip });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
});

test('folder links: a room with the folder and its subfolders, and nothing outside it', async () => {
  const room = await makeLink({ folder: 'Acme/Reels' }, { label: 'Reels team' });
  assert.equal(room.kind, 'folder');
  const g = (await guest('GET', `/api/g/${room.token}`)).json();
  assert.equal(g.kind, 'folder');
  assert.deepEqual(g.videos.map((v: { name: string }) => v.name).sort(), ['cut.mp4', 'spot.mp4']);
  assert.equal((await guest('GET', `/api/g/${room.token}/review/${enc(cut)}`)).status, 200);
  for (const url of [
    `/api/g/${room.token}/review/${enc(other)}`,
    `/media/g/${room.token}/${enc(other)}/v1`,
    `/api/g/${room.token}/poster/${enc(other)}`,
    `/api/g/${room.token}/review/..%2F..%2Fetc`,
    `/api/g/${room.token}/review/${enc('../shares.json')}`,
  ])
    assert.equal((await guest('GET', url)).status, 404, url);
  assert.equal((await note(room.token, { slug: other })).status, 404, 'no notes on videos outside the folder');
  // Filing a video into the folder puts it in the room on the next request.
  folders.moveVideo(other, 'Acme/Reels', 'tester');
  assert.equal((await guest('GET', `/api/g/${room.token}/review/${enc(other)}`)).status, 200);
  folders.moveVideo(other, 'Acme/Other', 'tester');
  // A folder link can't be made for a folder that doesn't exist.
  assert.equal((await request('POST', '/api/folder-shares', { body: { folder: 'Nope/Nothing' } })).status, 404);
  // The owner sees folder links on the videos they cover.
  const onCut = (await request('GET', `/api/review/${enc(cut)}/shares`)).json().shares;
  assert.ok(onCut.some((s: { token: string }) => s.token === room.token));
});

test('folder links follow their folder when it is renamed or deleted, and never cover more than before', async () => {
  track('proj/export/moving.mp4', 'Studio/Client');
  track('proj/export/nested.mp4', 'Studio/Client/Cuts');
  track('proj/export/neighbour.mp4', 'Studio/Neighbour');
  const whole = await makeLink({ folder: 'Studio/Client' });
  const cuts = await makeLink({ folder: 'Studio/Client/Cuts' });
  const names = async (token: string) => ((await guest('GET', `/api/g/${token}`)).json().videos || []).map((v: { name: string }) => v.name).sort();
  assert.deepEqual(await names(whole.token), ['moving.mp4', 'nested.mp4']);

  const renamed = await request('PATCH', '/api/folders', { body: { from: 'Studio/Client', to: 'Studio/Client 2026' } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual(await names(whole.token), ['moving.mp4', 'nested.mp4'], 'the link moved with its folder');
  assert.deepEqual(await names(cuts.token), ['nested.mp4'], 'and a link on a subfolder too');

  // Deleting a folder lifts what's in it one level: a subfolder's link follows it; the deleted folder's own link
  // isn't widened to the parent (which holds the neighbour's videos) — it covers nothing any more.
  assert.equal((await request('DELETE', `/api/folders?path=${enc('Studio/Client 2026')}`)).status, 200);
  assert.deepEqual(await names(cuts.token), ['nested.mp4'], 'the subfolder link followed Cuts up');
  const left = await names(whole.token);
  assert.ok(!left.includes('neighbour.mp4'), `never widened: ${left}`);
});

test('threads: guests reply, see the team and the editor; agent questions stay internal', async () => {
  const l = await makeLink({ slug: other });
  assert.equal((await note(l.token, { text: 'Musik zu laut' })).status, 200);
  const id = (await guest('GET', `/api/g/${l.token}/review/${enc(other)}`)).json().notes[0].id;
  assert.equal((await guest('POST', `/api/g/${l.token}/comments/${id}/replies`, { name: 'Mia', text: 'ab 0:03' })).status, 200);
  store.updateComment(id, { note: 'Klar, mache ich', by: 'tester' });
  store.updateComment(id, { note: 'Which track do you mean?', by: 'agent:edit' });
  const rv = (await guest('GET', `/api/g/${l.token}/review/${enc(other)}`)).json();
  assert.deepEqual(
    rv.notes[0].replies.map((r: { by: string; text: string }) => `${r.by}: ${r.text}`),
    ['Mia: ab 0:03', 'tester: Klar, mache ich'],
  );
  const ev = store.readEvents({ limit: 50 }).find((e) => e.type === 'reply' && e.by === 'guest:Mia');
  assert.ok(ev, 'a guest reply is an event like any other');
  // Replies only on notes the link shows.
  const internal = store.addComment(other, { frame: 1, text: 'internal', author: 'tester' });
  assert.equal((await guest('POST', `/api/g/${l.token}/comments/${internal.id}/replies`, { name: 'Mia', text: 'hi' })).status, 404);
  assert.equal((await guest('POST', `/api/g/${l.token}/comments/not-an-id/replies`, { name: 'Mia', text: 'hi' })).status, 400);
});

test('fix checks: a fixed note can be confirmed or reopened by the client, nothing else', async () => {
  const l = await makeLink({ slug: other });
  assert.equal((await note(l.token, { text: 'Farbe kippt' })).status, 200);
  const notes = (await guest('GET', `/api/g/${l.token}/review/${enc(other)}`)).json().notes;
  const id = notes.find((n: { text: string }) => n.text === 'Farbe kippt').id;
  assert.equal((await guest('POST', `/api/g/${l.token}/comments/${id}/check`, { name: 'Mia', verdict: 'confirm' })).status, 409);
  store.updateComment(id, { status: 'fixed', note: 'regraded', by: 'agent:edit' });
  const confirm = await guest('POST', `/api/g/${l.token}/comments/${id}/check`, { name: 'Mia', verdict: 'confirm', text: 'passt' });
  assert.equal(confirm.json().status, 'verified');
  assert.equal(must(store.findComment(id)).comment.status, 'verified');
  store.updateComment(id, { status: 'fixed', by: 'agent:edit' });
  assert.equal((await guest('POST', `/api/g/${l.token}/comments/${id}/check`, { name: 'Mia', verdict: 'reopen', text: 'doch nicht' })).json().status, 'open');
  const shown = (await guest('GET', `/api/g/${l.token}/review/${enc(other)}`)).json().notes.find((n: { id: string }) => n.id === id);
  assert.equal(shown.status, 'open');
  assert.ok(
    shown.replies.some((r: { by: string; status?: string }) => r.by === 'editor' && r.status === 'fixed'),
    'the editor is "editor"',
  );
});

test('owner side: settings are editable, stats count visits once and remember names, revoking ends it', async () => {
  const l = await makeLink({ slug: other }, { label: 'Stats' });
  for (let i = 0; i < 3; i++) await guest('POST', `/api/g/${l.token}/visit`, {});
  await guest('POST', `/api/g/${l.token}/visit`, { name: 'Jonas' });
  await note(l.token, { name: 'Ada' });
  const info = (await request('GET', `/api/review/${enc(other)}/shares`)).json().shares.find((s: { token: string }) => s.token === l.token);
  assert.equal(info.stats.opens, 1);
  assert.deepEqual(info.stats.reviewers, ['Jonas', 'Ada']);
  assert.equal(info.stats.notes, 1);
  const edited = (await request('PATCH', `/api/shares/${l.token}`, { body: { label: 'Renamed', download: 'preview', notes: 'all' } })).json();
  assert.equal(edited.label, 'Renamed');
  assert.equal(edited.download, 'preview');
  assert.equal((await request('PATCH', `/api/shares/${l.token}`, { body: { download: 'everything' } })).status, 400);
  assert.equal((await request('DELETE', `/api/shares/${l.token}`)).json().ok, true);
  assert.equal((await guest('GET', `/api/g/${l.token}`)).status, 404);
  assert.equal((await request('PATCH', `/api/shares/${l.token}`, { body: { label: 'x' } })).status, 404);
});

test('guest writes must come from the guest page, not from another site', async () => {
  const l = await makeLink({ slug: other });
  assert.equal((await note(l.token, { name: 'Eve' })).status, 200, 'from the page itself (no Origin, or ours) it works');
  const foreign = await request('POST', `/api/g/${l.token}/comments`, {
    body: { name: 'Eve', frame: 1, text: 'spam' },
    headers: { ...remote, origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
  const crossSite = await request('POST', `/api/g/${l.token}/approval`, {
    body: { name: 'Eve', status: 'approved' },
    headers: { ...remote, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

// Last: it uses up this address's visits and the link's verdicts for the minute.
test('verdicts and visits from a link are bounded: a script can’t flood the history, the webhooks or the visitor list', async () => {
  const link = await makeLink({ slug: cut });
  const verdicts = () => (must(store.loadReview(cut)).approvals || []).filter((a) => a.party === 'client').length;
  const before = verdicts();
  const codes: number[] = [];
  for (let i = 0; i < 25; i++) codes.push((await guest('POST', `/api/g/${link.token}/approval`, { name: 'Mia', slug: cut, v: 1, status: 'approved' })).status);
  assert.equal(verdicts(), before + 1, 'the same verdict again is not a new one');
  assert.ok(codes.includes(429), `verdicts are rate-limited: ${codes.join(',')}`);

  const visits: number[] = [];
  for (let i = 0; i < 70; i++) visits.push((await guest('POST', `/api/g/${link.token}/visit`, { visitor: `made-up-${i}` })).status);
  assert.ok(visits.includes(429), `visits are rate-limited: ${visits.join(',')}`);
  const crossSite = await request('POST', `/api/g/${link.token}/visit`, { body: {}, headers: { ...remote, Origin: 'https://elsewhere.example' } });
  assert.equal(crossSite.status, 403, 'a visit comes from the guest page, like every other guest write');
});
