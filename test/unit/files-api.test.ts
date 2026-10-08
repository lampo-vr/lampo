// covers: server/routes/files.ts lib/files.ts lib/fileAreas.ts lib/fileText.ts server/routes/uploads.ts server/uploadTickets.ts
// Project files on a hosted server with its media host: a push names its files (paths kept as uploaded, sha256, the
// version it was based on), gets a one-time ticket per file whose bytes the workspace doesn't hold, and each PUT (or tus
// with the ticket) lands its file. The same bytes are kept once per workspace. Every write is a version; a push that
// would replace a version it didn't see is refused (409, who changed it) or kept beside it as a copy. Files attach where
// playbooks do — the House, a project, a folder — and a folder sees its own and everything above, deepest first. The
// trash and replaced versions are kept 30 days and don't count; live files count once. Reviewers see no files (404),
// another workspace's ids are nobody's, downloads come from the media host as inert attachments by a URL that asks
// again who it was handed to. Folders inside an area are entries of their own; a project's folder renamed carries its
// files, deleted trashes them whole.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, must } from '../lib/helpers.ts';

const APP = 'review.test';
const MEDIA = 'media.review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}`, VR_MEDIA_ORIGIN: `http://${MEDIA}`, VR_FOOTAGE: 'off', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const { AGENT_PLAN_WORDS } = await import('../../lib/planWords.ts');
const folders = await import('../../lib/folders.ts');
const files = await import('../../lib/files.ts');
const fileAreas = await import('../../lib/fileAreas.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const { refusal, usageOf } = await import('../../server/extension.ts');
const { openMedia } = await import('../../lib/storage/mediaHost.ts');

const { port, ctx } = await startApp();

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  json: () => any;
}
function raw(
  method: string,
  url: string,
  { host = APP, headers = {}, body }: { host?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  return new Promise<Raw>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = { Host: host, ...(data ? { 'content-length': String(data.length) } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, body: b, text: b.toString('utf8'), json: () => JSON.parse(b.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const api = (method: string, url: string, who: Record<string, string>, body?: unknown) =>
  raw(method, url, {
    headers: { ...who, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const enc = encodeURIComponent;

const PASSWORD = 'a long password';
const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: PASSWORD, role: 'reviewer' });
const bea = await auth.createUser({ email: 'bea@example.com', name: 'Bea', password: PASSWORD, role: 'reviewer' });
const other = workspaces.createWorkspace({ name: 'Other studio', ownerId: bea.id });
const token = (u: { id: string }, workspace = 'w1') => ({ Authorization: `Bearer ${auth.createToken(u.id, 'agent', { workspace }).token}` });
const asOlivia = token(olivia);
const asMax = token(max);
const asRita = token(rita);
const asBea = token(bea, other.id);
inWorkspace('w1', () => folders.createFolder('Acme/Spring'));

/** Bytes that read as a PNG to the server (its magic number), and as other things. */
const png = (n: number) => Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), crypto.randomBytes(n)]);
const blob = (n: number) => crypto.randomBytes(n);

interface Pushed {
  answer: Raw;
  puts: Raw[];
}
/** A push: names the files, sends each one's bytes the answer asks for (one PUT to its ticket on the media host). */
async function push(who: Record<string, string>, folder: string, list: { path: string; data: Buffer; base?: number }[], extra: object = {}): Promise<Pushed> {
  const answer = await api('POST', '/api/files/uploads', who, {
    folder,
    files: list.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data), ...(f.base !== undefined ? { base: f.base } : {}) })),
    ...extra,
  });
  const puts: Raw[] = [];
  if (answer.status !== 200) return { answer, puts };
  for (const [i, slot] of (answer.json().uploads as { url?: string; stored?: true }[]).entries()) {
    if (!slot.url) continue;
    const u = new URL(slot.url);
    assert.equal(u.host, MEDIA, 'the bytes go to the media host');
    puts.push(await raw('PUT', u.pathname, { host: MEDIA, body: must(list[i]).data }));
  }
  return { answer, puts };
}
/** Every file that applies in a folder, as the API lists it. */
const listed = async (folder: string, who = asOlivia, extra = '') => {
  const r = await api('GET', `/api/files?folder=${enc(folder)}&deep=1${extra}`, who);
  assert.equal(r.status, 200, r.text);
  return r.json();
};
const fileAt = async (folder: string, p: string, who = asOlivia) =>
  (await listed(folder, who)).files.find((f: { path: string; area: string }) => f.path === p && f.area === folder);
/** How many blobs the workspace's store keeps on this disk. */
const blobsOnDisk = (ws = 'w1'): number => {
  const dir = inWorkspace(ws, () => path.join(fileAreas.filesDir(), 'sha256'));
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : n++;
  };
  walk(dir);
  return n;
};

const brand = blob(4000);
const logo = png(3000);

test('a push to the House and to a project: a ticket per file, one PUT each, paths kept, the same bytes kept once', async () => {
  const before = blobsOnDisk();
  const house = await push(asOlivia, '', [
    { path: 'Fonts/Brand.otf', data: brand },
    { path: 'Logos/logo.png', data: logo },
  ]);
  assert.equal(house.answer.status, 200, house.answer.text);
  assert.equal(house.answer.json().folder, '');
  assert.match(house.answer.json().tus, /^http:\/\/review\.test\/api\/uploads$/);
  for (const put of house.puts) {
    assert.equal(put.status, 200, put.text);
    const out = put.json();
    assert.equal(out.commit.files[0].state, 'added');
  }
  const logoFile = await fileAt('', 'Logos/logo.png');
  assert.equal(logoFile.type, 'image/png', 'the type comes from the bytes');
  assert.equal(logoFile.kind, 'image');
  assert.equal(logoFile.by, 'Olivia');
  assert.equal(logoFile.sha256, sha(logo));
  assert.equal((await fileAt('', 'Fonts/Brand.otf')).kind, 'font', 'unknown bytes: the name says what it is');
  assert.equal(blobsOnDisk() - before, 2);

  // the same logo in a project: nothing to send, committed by name
  const acme = await push(asMax, 'Acme', [{ path: 'Brand/logo copy.png', data: logo }]);
  assert.equal(acme.answer.status, 200, acme.answer.text);
  assert.deepEqual(acme.answer.json().uploads, [{ path: 'Brand/logo copy.png', stored: true }]);
  const commit = await api('POST', '/api/files/commit', asMax, {
    folder: 'Acme',
    add: [{ path: 'Brand/logo copy.png', sha256: sha(logo), size: logo.length }],
  });
  assert.equal(commit.status, 200, commit.text);
  assert.equal(commit.json().files[0].state, 'added');
  assert.equal(blobsOnDisk() - before, 2, 'the same bytes are kept once per workspace');
  // which bytes the workspace lacks: asked by hash
  const missing = await api('POST', '/api/files/missing', asMax, { hashes: [sha(logo), sha(Buffer.from('nothing here'))] });
  assert.deepEqual(missing.json().missing, [sha(Buffer.from('nothing here'))]);
  // usage counts the logo once, though it is in two places
  const usage = (await api('GET', '/api/files/usage', asOlivia)).json();
  assert.equal(usage.files, 3);
  assert.equal(usage.bytes, brand.length + logo.length);
  assert.equal(usageOf('w1').files.bytes, brand.length + logo.length);
  assert.ok(usageOf('w1').bytes >= brand.length + logo.length, 'renders and files share the plan’s bytes');
});

test('a folder sees its own files and everything above, deepest first; the same path deeper wins', async () => {
  const ours = blob(1500);
  const p = await push(asOlivia, 'Acme', [{ path: 'Fonts/Brand.otf', data: ours }]);
  assert.equal(must(p.puts[0]).status, 200, must(p.puts[0]).text);
  const l = await listed('Acme/Spring');
  assert.deepEqual(
    l.areas.map((a: { area: string }) => a.area),
    ['Acme/Spring', 'Acme', ''],
  );
  const fonts = l.files.filter((f: { path: string }) => f.path === 'Fonts/Brand.otf');
  assert.equal(fonts.length, 1, 'one Fonts/Brand.otf: the deeper one');
  assert.equal(fonts[0].area, 'Acme');
  assert.equal(fonts[0].sha256, sha(ours));
  assert.ok(
    l.files.some((f: { path: string; area: string }) => f.path === 'Logos/logo.png' && f.area === ''),
    'the House’s files apply below',
  );
  // the folder's own only
  assert.equal((await listed('Acme/Spring', asOlivia, '&own=1')).files.length, 0);
  // the tree in short
  const s = (await api('GET', '/api/files/summary?folder=Acme', asOlivia)).json();
  assert.deepEqual(
    s.areas.map((a: { area: string }) => a.area),
    ['Acme', ''],
  );
  assert.deepEqual(
    s.areas[0].tops.map((t: { path: string; files: number }) => [t.path, t.files]),
    [
      ['Brand/', 1],
      ['Fonts/', 1],
    ],
  );
  // one directory at a time: its folders and its own files
  const top = (await api('GET', '/api/files?folder=Acme', asOlivia)).json();
  assert.deepEqual(top.files, [], 'nothing at the top of Acme itself');
  assert.ok(top.dirs.some((d: { path: string; id?: string }) => d.path === 'Brand' && d.id?.startsWith('fd_')));
});

test('every write is a version: a push that didn’t see the newest is refused before any byte, or kept beside it', async () => {
  const v2 = blob(2000);
  // no base on a path that is taken: refused up front, nothing to send
  const blind = await push(asMax, '', [{ path: 'Fonts/Brand.otf', data: v2 }]);
  assert.equal(blind.answer.status, 409, blind.answer.text);
  const c = blind.answer.json().conflicts[0];
  assert.equal(c.path, 'Fonts/Brand.otf');
  assert.equal(c.v, 1);
  assert.equal(c.by, 'Olivia');
  assert.equal(c.base, null);
  assert.match(blind.answer.json().error, /Fonts\/Brand\.otf is there already/);
  // based on V1: V2
  const ok = await push(asMax, '', [{ path: 'Fonts/Brand.otf', data: v2, base: 1 }], { agent: 'promo-edit', agent_kind: 'claude-code' });
  assert.equal(must(ok.puts[0]).status, 200, must(ok.puts[0]).text);
  assert.deepEqual((({ state, v }) => ({ state, v }))(must(ok.puts[0]).json().commit.files[0]), { state: 'version', v: 2 });
  const now = await fileAt('', 'Fonts/Brand.otf');
  assert.equal(now.v, 2);
  assert.equal(now.agent, 'promo-edit', 'attributed to the agent');
  assert.equal(now.agent_kind, 'claude-code');
  assert.equal(now.by, 'Max', 'with its person’s account');
  // a ticket handed out on V2, the file moving on to V3 meanwhile: the PUT is refused with who changed it
  const v3 = blob(2100);
  const stale = await api('POST', '/api/files/uploads', asOlivia, {
    folder: '',
    files: [{ path: 'Fonts/Brand.otf', size: v3.length, sha256: sha(v3), base: 2 }],
  });
  assert.equal(stale.status, 200, stale.text);
  const raced = await push(asMax, '', [{ path: 'Fonts/Brand.otf', data: blob(1900), base: 2 }]);
  assert.equal(raced.answer.status, 200, raced.answer.text);
  assert.equal(must(raced.puts[0]).status, 200);
  const late = await raw('PUT', new URL(stale.json().uploads[0].url).pathname, { host: MEDIA, body: v3 });
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json().conflicts[0].v, 3);
  assert.equal(late.json().conflicts[0].base, 2);
  assert.equal(late.json().conflicts[0].by, 'Max');
  // the refused bytes stay (nothing to send again): committed as a copy beside it
  const again = await api('POST', '/api/files/uploads', asOlivia, {
    files: [{ path: 'Fonts/Brand.otf', size: v3.length, sha256: sha(v3), base: 2 }],
    conflict: 'copy',
  });
  assert.deepEqual(again.json().uploads, [{ path: 'Fonts/Brand.otf', stored: true }]);
  const copy = await api('POST', '/api/files/commit', asOlivia, {
    add: [{ path: 'Fonts/Brand.otf', sha256: sha(v3), size: v3.length, base: 2 }],
    conflict: 'copy',
    agent: 'Alex agent',
  });
  assert.equal(copy.status, 200, copy.text);
  const landed = copy.json().files[0];
  assert.equal(landed.state, 'copy');
  assert.equal(landed.path, 'Fonts/Brand (Alex agent).otf');
  assert.equal(landed.asked, 'Fonts/Brand.otf');
  // the same bytes again: nothing changes
  const same = await api('POST', '/api/files/commit', asOlivia, {
    folder: '',
    add: [{ path: 'Fonts/Brand (Alex agent).otf', sha256: sha(v3), size: v3.length }],
  });
  assert.equal(same.json().files[0].state, 'same');
  // the history, newest first, and an older version back as the newest
  const id = (await fileAt('', 'Fonts/Brand.otf')).id;
  const h = (await api('GET', `/api/files/${id}/history`, asMax)).json();
  assert.deepEqual(
    h.versions.map((x: { v: number }) => x.v),
    [3, 2, 1],
  );
  assert.ok(h.versions[1].kept_until, 'a replaced version is kept for a while');
  assert.deepEqual(
    h.changes.map((x: { op: string }) => x.op),
    ['version', 'version', 'add'],
  );
  const back = await api('POST', `/api/files/${id}/restore`, asMax, { v: 1 });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json().v, 4);
  assert.equal(back.json().sha256, sha(brand));
});

test('the trash: kept, restored, a taken path restored beside it, and gone for good after 30 days', async () => {
  const draft = blob(800);
  const p = await push(asMax, 'Acme', [{ path: 'Notes/draft.txt', data: draft }]);
  assert.equal(must(p.puts[0]).status, 200);
  const f = await fileAt('Acme', 'Notes/draft.txt');
  const del = await api('DELETE', `/api/files/${f.id}`, asMax);
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json().trashed_by, 'Max');
  assert.ok(del.json().purge_at);
  assert.equal(await fileAt('Acme', 'Notes/draft.txt'), undefined, 'out of the listing');
  const trash = (await api('GET', '/api/files/trash?folder=Acme', asOlivia)).json();
  assert.deepEqual(
    trash.files.map((t: { path: string }) => t.path),
    ['Notes/draft.txt'],
  );
  // the folder it was in stays, empty
  assert.ok((await api('GET', '/api/files?folder=Acme&path=Notes', asOlivia)).status === 200);
  // restored; then trashed again with its path taken meanwhile: it comes back beside the new one
  assert.equal((await api('POST', `/api/files/${f.id}/restore`, asMax, {})).json().path, 'Notes/draft.txt');
  assert.equal((await api('DELETE', `/api/files/${f.id}`, asMax)).status, 200);
  await push(asMax, 'Acme', [{ path: 'Notes/draft.txt', data: blob(700) }]);
  const again = await api('POST', `/api/files/${f.id}/restore`, asMax, {});
  assert.equal(again.json().path, 'Notes/draft (restored).txt');
  // 31 days on: the trash and the versions replaced then are purged, and bytes nothing names go too
  assert.equal((await api('DELETE', `/api/files/${f.id}`, asMax)).status, 200);
  const blobs = blobsOnDisk();
  const later = Date.now() + 31 * 86_400_000;
  const out = await inWorkspace('w1', () => files.purgeFiles({ now: later }));
  assert.ok(out.trash >= 1, JSON.stringify(out));
  assert.ok(out.versions >= 2, JSON.stringify(out));
  assert.ok(out.blobs >= 1, JSON.stringify(out));
  assert.equal(blobsOnDisk(), blobs - out.blobs);
  assert.equal((await api('GET', `/api/files/${f.id}`, asOlivia)).status, 404);
  assert.equal((await api('GET', '/api/files/trash?folder=Acme', asOlivia)).json().files.length, 0);
  // every live file's bytes are still there
  for (const x of (await listed('Acme/Spring')).files) {
    const r = await api('GET', `/api/files/${x.id}/download`, asOlivia);
    assert.equal(r.status, 302, `${x.path}: ${r.status}`);
  }
});

test('quota: live files count once, the trash and replaced versions don’t, the safety net held to its cap', async () => {
  const big = blob(5000);
  await push(asOlivia, 'Acme/Spring', [{ path: 'Footage/a.mov', data: big }]);
  const a = await fileAt('Acme/Spring', 'Footage/a.mov');
  const before = (await api('GET', '/api/files/usage', asOlivia)).json();
  assert.equal((await api('DELETE', `/api/files/${a.id}`, asOlivia)).status, 200);
  const after = (await api('GET', '/api/files/usage', asOlivia)).json();
  assert.equal(after.bytes, before.bytes - big.length, 'trashing gives the space back at once');
  assert.equal(after.kept, before.kept + big.length, 'kept, not counted');
  // the safety net past its cap: nothing that went in within the day goes early…
  const soon = await inWorkspace('w1', () => files.purgeFiles({ cap: 0 }));
  assert.equal(soon.trash, 0, JSON.stringify(soon));
  // …a day on, the oldest goes first, early
  const out = await inWorkspace('w1', () => files.purgeFiles({ cap: 0, now: Date.now() + 25 * 3600e3 }));
  assert.ok(out.trash >= 1 || out.versions >= 1, JSON.stringify(out));
  assert.equal((await api('GET', '/api/files/usage', asOlivia)).json().kept, 0);
});

test('a push the plan has no room for is refused before any byte, with the limit sheet’s numbers', async () => {
  const real = ctx.extension;
  ctx.extension = {
    ...real,
    async check(_w: string, gate: string, bytes = 0) {
      if (gate === 'upload' && bytes > 1000)
        throw refusal({
          ok: false,
          reason: 'storage',
          message: 'This workspace has no room for that',
          needed: bytes,
          room: { videos: 0, bytes: 0 },
          fits: 'team',
        });
    },
  };
  try {
    const r = await push(asOlivia, '', [{ path: 'Footage/huge.mov', data: blob(5000) }]);
    assert.equal(r.answer.status, 402, r.answer.text);
    assert.equal(r.answer.json().reason, 'storage');
    assert.equal(r.answer.json().needed, 5000);
    // an API token (an agent, `lampo files push`) reads a plain sentence and the numbers, never the plan that would fit
    assert.equal(r.answer.json().fits, undefined);
    assert.equal(r.answer.json().error, AGENT_PLAN_WORDS.storage);
    assert.equal(r.puts.length, 0);
  } finally {
    ctx.extension = real;
  }
});

test('rights: reviewers don’t see files (404), members trash only what they added, owners anything', async () => {
  for (const [m, u, b] of [
    ['GET', '/api/files', undefined],
    ['GET', '/api/files/summary', undefined],
    ['GET', '/api/files/usage', undefined],
    ['POST', '/api/files/uploads', { files: [{ path: 'x.txt', size: 1 }] }],
    ['POST', '/api/files/missing', { hashes: [] }],
  ] as const) {
    const r = await api(m, u, asRita, b);
    assert.equal(r.status, 404, `a reviewer ${m} ${u}: ${r.status}`);
  }
  const theirs = await fileAt('', 'Logos/logo.png');
  assert.equal((await api('GET', `/api/files/${theirs.id}`, asRita)).status, 404);
  assert.equal((await api('GET', `/api/files/${theirs.id}/download`, asRita)).status, 404);
  // Max (a member) may not trash Olivia's logo; Olivia may
  const no = await api('DELETE', `/api/files/${theirs.id}`, asMax);
  assert.equal(no.status, 403, no.text);
  const mine = await push(asMax, '', [{ path: 'Max/own.txt', data: Buffer.from('max’s own words\n') }]);
  const own = await fileAt('', 'Max/own.txt');
  assert.equal(must(mine.puts[0]).status, 200);
  assert.equal(own.type, 'text/plain');
  assert.equal((await api('DELETE', `/api/files/${own.id}`, asMax)).status, 200);
  // anyone with files-write moves and renames
  const moved = await api('PATCH', `/api/files/${theirs.id}`, asMax, { path: 'Logos/main.png' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json().path, 'Logos/main.png');
  assert.equal((await api('PATCH', `/api/files/${theirs.id}`, asMax, { path: 'Logos/logo.png' })).status, 200);
});

test('another workspace’s files are nobody’s: 404 for its ids, its bytes never deduped across', async () => {
  const theirs = await fileAt('', 'Logos/logo.png');
  for (const [m, u, b] of [
    ['GET', `/api/files/${theirs.id}`, undefined],
    ['GET', `/api/files/${theirs.id}/history`, undefined],
    ['GET', `/api/files/${theirs.id}/download`, undefined],
    ['PATCH', `/api/files/${theirs.id}`, { path: 'x.png' }],
    ['DELETE', `/api/files/${theirs.id}`, undefined],
    ['POST', `/api/files/${theirs.id}/restore`, {}],
  ] as const) {
    const r = await api(m, u, asBea, b);
    assert.equal(r.status, 404, `${m} ${u} from another workspace: ${r.status} ${r.text}`);
  }
  const urls = await api('POST', '/api/files/urls', asBea, { ids: [theirs.id] });
  assert.deepEqual(urls.json(), { urls: [], missing: [theirs.id] });
  assert.deepEqual((await listed('', asBea)).files, [], 'its own House holds nothing');
  // the same bytes in the other workspace: asked for, never "already there"
  const r = await push(asBea, '', [{ path: 'logo.png', data: logo }]);
  assert.equal(r.answer.status, 200, r.answer.text);
  assert.ok(r.answer.json().uploads[0].url, 'the bytes are sent: dedupe is per workspace');
  assert.equal(must(r.puts[0]).status, 200, must(r.puts[0]).text);
  assert.equal(blobsOnDisk(other.id), 1);
});

test('paths are names inside the area: climbing, absolute, NUL, junk and empty names refused; a lone surrogate made whole', async () => {
  for (const bad of [
    '../x.txt',
    'a/../b.txt',
    '/etc/passwd',
    'a\\b.txt',
    'a\u0000b.txt',
    'a//b.txt',
    'a/',
    ' a.txt',
    '.DS_Store',
    '__MACOSX/a.txt',
    'a‮b.txt',
    'a\nb.txt',
  ]) {
    const r = await api('POST', '/api/files/uploads', asOlivia, { files: [{ path: bad, size: 1 }] });
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.status} ${r.text}`);
  }
  const long = await api('POST', '/api/files/uploads', asOlivia, { files: [{ path: `${'a'.repeat(256)}.txt`, size: 1 }] });
  assert.equal(long.status, 400);
  // JSON can carry a lone surrogate: it becomes U+FFFD, as on the disk, and the file lands under that name
  const data = Buffer.from('half a letter\n');
  const r = await raw('POST', '/api/files/uploads', {
    headers: { ...asOlivia, 'content-type': 'application/json' },
    body: `{"files":[{"path":"odd\\ud800.txt","size":${data.length},"sha256":"${sha(data)}"}]}`,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json().uploads[0].path, 'odd�.txt');
  // a name that differs only in case from a file there is the same place on a Mac
  const twin = await push(asOlivia, '', [{ path: 'logos/LOGO.png', data: png(100) }]);
  assert.equal(twin.answer.status, 409, 'logos/LOGO.png and Logos/logo.png are one file on a Mac: a conflict, not a second file');
  assert.equal(twin.answer.json().conflicts[0].path, 'Logos/logo.png');
});

test('downloads: a short-lived URL on the media host, an inert attachment that asks again who it was for', async () => {
  const f = await fileAt('', 'Logos/logo.png');
  const r = await api('GET', `/api/files/${f.id}/download`, asOlivia);
  assert.equal(r.status, 302, r.text);
  const url = new URL(String(r.headers.location));
  assert.equal(url.host, MEDIA);
  assert.match(url.pathname, /^\/media\/f\/[\w-]+\/logo\.png$/);
  const claims = openMedia(url.pathname.split('/')[3] as string);
  assert.ok(claims && claims.e - Date.now() / 1000 <= 6 * 60, 'minutes, not hours');
  const got = await raw('GET', url.pathname, { host: MEDIA });
  assert.equal(got.status, 200);
  assert.equal(sha(got.body), sha(logo));
  assert.equal(got.headers['content-type'], 'application/octet-stream');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.match(String(got.headers['content-security-policy']), /sandbox/);
  assert.match(String(got.headers['content-disposition']), /^attachment; filename="logo\.png"/);
  // a range: the rest of a download that broke off
  const part = await raw('GET', url.pathname, { host: MEDIA, headers: { Range: 'bytes=1000-' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, logo.length - 1000);
  // HEAD: the headers only
  const head = await raw('HEAD', url.pathname, { host: MEDIA });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(logo.length));
  // never on the app's own host
  assert.ok([401, 404].includes((await raw('GET', url.pathname)).status));
  // a preview: a picture as itself, inline, from the app host as posters are (the page's img-src is the app's own;
  // the media host keeps video off the app host's front) — an SVG never
  const picture = await raw('GET', `/api/files/${f.id}/download?inline=1`, { headers: asOlivia });
  assert.equal(picture.status, 200, 'not sent to the media host');
  assert.equal(picture.headers.location, undefined);
  assert.equal(picture.headers['content-type'], 'image/png');
  assert.match(String(picture.headers['content-disposition']), /^inline/);
  assert.equal(picture.headers['x-content-type-options'], 'nosniff');
  assert.match(String(picture.headers['content-security-policy']), /sandbox/);
  assert.equal(sha(picture.body), sha(logo));
  // a text preview's first 32 KB, from the media host: the page asks with a Range, so the browser asks first
  await push(asOlivia, '', [{ path: 'Brief/notes.txt', data: Buffer.from('Spring is here\n') }]);
  const notes = await fileAt('', 'Brief/notes.txt');
  const inline = await api('GET', `/api/files/${notes.id}/download?inline=1`, asOlivia);
  const shown = await raw('GET', new URL(String(inline.headers.location)).pathname, { host: MEDIA, headers: { Origin: `http://${APP}` } });
  assert.equal(shown.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(String(shown.headers['content-disposition']), /^inline/);
  assert.equal(shown.headers['access-control-allow-origin'], `http://${APP}`);
  const pre = await raw('OPTIONS', new URL(String(inline.headers.location)).pathname, {
    host: MEDIA,
    headers: { Origin: `http://${APP}`, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
  });
  assert.equal(pre.status, 204, pre.text);
  assert.equal(pre.headers['access-control-allow-origin'], `http://${APP}`);
  assert.match(String(pre.headers['access-control-allow-headers']), /Range/i);
  assert.match(String(shown.headers['content-security-policy']), /sandbox/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await push(asOlivia, '', [{ path: 'Logos/mark.svg', data: svg }]);
  const mark = await fileAt('', 'Logos/mark.svg');
  assert.equal(mark.type, 'image/svg+xml');
  assert.equal(mark.kind, 'graphic');
  const svgUrl = (await api('GET', `/api/files/${mark.id}/download?inline=1`, asOlivia)).headers.location;
  const svgGot = await raw('GET', new URL(String(svgUrl)).pathname, { host: MEDIA });
  assert.equal(svgGot.headers['content-type'], 'application/octet-stream', 'an SVG only ever downloads');
  assert.match(String(svgGot.headers['content-disposition']), /^attachment/);
  // signed URLs for a pull: hours for the person, an hour for a token; whoever it was for is asked again
  const max2 = auth.createToken(max.id, 'pull', { workspace: 'w1' });
  const urls = await api('POST', '/api/files/urls', { Authorization: `Bearer ${max2.token}` }, { ids: [f.id, 'fl_000000000000'] });
  assert.equal(urls.status, 200, urls.text);
  assert.deepEqual(urls.json().missing, ['fl_000000000000']);
  const pull = new URL(urls.json().urls[0].url);
  assert.equal((await raw('GET', pull.pathname, { host: MEDIA })).status, 200);
  auth.revokeToken(max2.info.id);
  assert.equal((await raw('GET', pull.pathname, { host: MEDIA })).status, 403, 'a revoked token’s URL stops');
});

test('tus with a ticket: the upload resumes, its last PATCH answers the file; a ticket works once and for its account', async () => {
  const data = blob(300_000);
  const ask = await api('POST', '/api/files/uploads', asMax, { folder: 'Acme', files: [{ path: 'Audio/take.wav', size: data.length }] });
  assert.equal(ask.status, 200, ask.text);
  const ticket = ask.json().uploads[0].ticket as string;
  const meta = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
      .join(',');
  const tus = { 'Tus-Resumable': '1.0.0' };
  // another account can't start it
  const theirs = await raw('POST', '/api/uploads', {
    headers: { ...asOlivia, ...tus, 'Upload-Length': String(data.length), 'Upload-Metadata': meta({ ticket, filename: 'take.wav' }) },
  });
  assert.equal(theirs.status, 404, theirs.text);
  const made = await raw('POST', '/api/uploads', {
    headers: { ...asMax, ...tus, 'Upload-Length': String(data.length), 'Upload-Metadata': meta({ ticket, filename: 'take.wav' }) },
  });
  assert.equal(made.status, 201, made.text);
  const at = String(made.headers.location);
  // spent: a second upload with it is refused
  const twice = await raw('POST', '/api/uploads', {
    headers: { ...asMax, ...tus, 'Upload-Length': String(data.length), 'Upload-Metadata': meta({ ticket, filename: 'take.wav' }) },
  });
  assert.equal(twice.status, 410, twice.text);
  const half = 100_000;
  const first = await raw('PATCH', at, {
    body: data.subarray(0, half),
    headers: { ...asMax, ...tus, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
  });
  assert.equal(first.status, 204, first.text);
  // nobody else reaches it; its account resumes where it stopped
  assert.equal((await raw('HEAD', at, { headers: { ...asOlivia, ...tus } })).status, 404);
  const head = await raw('HEAD', at, { headers: { ...asMax, ...tus } });
  assert.equal(head.headers['upload-offset'], String(half));
  const rest = await raw('PATCH', at, {
    body: data.subarray(half),
    headers: { ...asMax, ...tus, 'Upload-Offset': String(half), 'Content-Type': 'application/offset+octet-stream' },
  });
  assert.equal(rest.status, 200, rest.text);
  const out = rest.json();
  assert.equal(out.stored.sha256, sha(data), 'hashed on arrival');
  assert.equal(out.commit.files[0].path, 'Audio/take.wav');
  assert.equal((await fileAt('Acme', 'Audio/take.wav')).size, data.length);
  // a client can't name where its bytes go through the metadata
  const forged = await raw('POST', '/api/uploads', {
    headers: {
      ...asMax,
      ...tus,
      'Upload-Length': '4',
      'Upload-Metadata': meta({ filename: 'x.mp4', vr_file: JSON.stringify({ area: 'fa_house', path: 'evil.txt' }) }),
    },
  });
  if (forged.status === 201) {
    const p = await raw('PATCH', String(forged.headers.location), {
      body: Buffer.from('abcd'),
      headers: { ...asMax, ...tus, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
    });
    assert.notEqual(p.status, 200, 'not a project file');
  }
  assert.equal(await fileAt('', 'evil.txt'), undefined);
});

test('folders inside an area: made empty, renamed with their files, trashed and restored whole', async () => {
  const made = await api('POST', '/api/files/dirs', asMax, { folder: 'Acme', path: 'Deliveries/Final' });
  assert.equal(made.status, 200, made.text);
  assert.match(made.json().id, /^fd_[0-9a-f]{12}$/);
  assert.equal(made.json().files, 0);
  const top = (await api('GET', '/api/files?folder=Acme', asMax)).json();
  assert.ok(
    top.dirs.some((d: { path: string; files: number }) => d.path === 'Deliveries' && d.files === 0),
    'an empty folder lists',
  );
  await push(asMax, 'Acme', [{ path: 'Deliveries/Final/cut.mov', data: blob(900) }]);
  const deliveries = (await api('GET', '/api/files?folder=Acme', asMax)).json().dirs.find((d: { path: string }) => d.path === 'Deliveries');
  const renamed = await api('PATCH', `/api/files/${deliveries.id}`, asMax, { path: 'Handover' });
  assert.equal(renamed.status, 200, renamed.text);
  assert.ok(await fileAt('Acme', 'Handover/Final/cut.mov'), 'its files moved with it');
  const gone = await api('DELETE', `/api/files/${deliveries.id}`, asMax);
  assert.equal(gone.status, 200, gone.text);
  assert.equal(gone.json().files, 1);
  assert.equal(await fileAt('Acme', 'Handover/Final/cut.mov'), undefined);
  const trash = (await api('GET', '/api/files/trash?folder=Acme', asMax)).json();
  assert.deepEqual(
    trash.dirs.map((d: { path: string }) => d.path),
    ['Handover'],
  );
  const back = await api('POST', `/api/files/${deliveries.id}/restore`, asMax, {});
  assert.equal(back.status, 200, back.text);
  assert.ok(await fileAt('Acme', 'Handover/Final/cut.mov'), 'restored with its files');
});

test('a project renamed carries its files; a folder deleted trashes its files whole into the one above', async () => {
  await push(asOlivia, 'Acme/Spring', [{ path: 'Music/bed.wav', data: blob(600) }]);
  const pr = await raw('PATCH', '/api/folders', {
    headers: { ...asOlivia, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Acme', to: 'Acme Co' }),
  });
  assert.equal(pr.status, 200, pr.text);
  assert.ok(await fileAt('Acme Co/Spring', 'Music/bed.wav'), 'a subfolder’s files follow its project');
  assert.ok(await fileAt('Acme Co', 'Brand/logo copy.png'), 'and the project’s own');
  assert.equal((await api('GET', '/api/files?folder=Acme', asOlivia)).status, 404, 'the old name is gone');
  const del = await raw('DELETE', `/api/folders?path=${enc('Acme Co/Spring')}`, { headers: asOlivia });
  assert.ok(del.status === 200 || del.status === 204, del.text);
  const trash = (await api('GET', `/api/files/trash?folder=${enc('Acme Co')}`, asOlivia)).json();
  assert.ok(
    trash.files.some((t: { path: string; why?: string }) => t.path === 'Spring/Music/bed.wav' && t.why === 'folder'),
    JSON.stringify(trash.files.map((t: { path: string }) => t.path)),
  );
  const group = trash.dirs.find((d: { path: string }) => d.path === 'Spring');
  assert.ok(group, 'the deleted folder is one entry in the trash');
  const back = await api('POST', `/api/files/${group.id}/restore`, asOlivia, {});
  assert.equal(back.status, 200, back.text);
  assert.ok(await fileAt('Acme Co', 'Spring/Music/bed.wav'));
});

test('live updates: an area’s change reaches the streams that may read files, never a reviewer’s', async () => {
  const listen = (who: Record<string, string>) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: APP, ...who }, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        text += d;
      });
    });
    req.on('error', () => {});
    req.end();
    return { text: () => text, stop: () => req.destroy() };
  };
  const team = listen(asOlivia);
  const reviewer = listen(asRita);
  try {
    // both streams are open once they have their first line
    for (let i = 0; i < 100 && !(team.text() && reviewer.text()); i++) await new Promise((r) => setTimeout(r, 20));
    await push(asMax, '', [{ path: 'Live/news.txt', data: Buffer.from('heard live\n') }]);
    for (let i = 0; i < 100 && !team.text().includes('event: files'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(team.text(), /event: files\ndata: \{"area":"","rev":\d+\}/);
    assert.doesNotMatch(reviewer.text(), /event: files/, 'a reviewer’s stream hears nothing of files');
  } finally {
    team.stop();
    reviewer.stop();
  }
});

test('a workspace deleted takes its files: catalogs and bytes', async () => {
  const before = blobsOnDisk(other.id);
  assert.ok(before >= 1);
  const plan = (await import('../../lib/deletion.ts')).planWorkspaceDeletion(other.id);
  assert.ok((plan.files?.count ?? 0) >= 1, JSON.stringify(plan));
  await (await import('../../lib/deletion.ts')).deleteWorkspace(other.id, 'cli');
  assert.equal(blobsOnDisk(other.id), 0);
  assert.equal(fs.existsSync(inWorkspace('w1', () => fileAreas.filesDir())), true, 'the other workspaces’ files stay');
});
