// covers: server/http.ts mcp/toolkit.ts lib/store.ts lib/folders.ts lib/folderIds.ts lib/names.ts server/context.ts server/routes/sessions.ts server/routes/library.ts server/routes/phone.ts lib/foryou.ts lib/search.ts
// On a hosted server, every way a name comes in keeps it well-formed: an upload's folder (a ticket's JSON can carry a
// lone surrogate, a long tus folder can be cut through an emoji), folders made, renamed and moved into, and every JSON
// body (a link's label, a display name, a note) and MCP tool call. A store an older version filled with such a name
// still answers: its inbox, INBOX.md, For you and search, where one name made every URL throw for the whole workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, must } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const APP = 'review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: `http://${APP}` } });
const { port, request } = await startApp({ headers: { Host: APP } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { allFolders } = await import('../../lib/folders.ts');
const { foldersFile } = await import('../../lib/folderIds.ts');
const { dataDir, versionsDir } = await import('../../lib/paths.ts');

const olivia = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const token = auth.createToken(olivia.id, 'agent').token;
const asOwner = { Authorization: `Bearer ${token}` };
const cookie = { Cookie: `vr_session=${auth.signSession(olivia)}`, Origin: `http://${APP}` };
const clip = makeVideo(path.join(dir, 'in/c.mp4'), { w: 160, h: 90, dur: 0.3 });

const encodes = (s: string | null | undefined, what: string) => {
  assert.ok(typeof s === 'string' && s.isWellFormed(), `${what}: ${JSON.stringify(s)}`);
  assert.doesNotThrow(() => encodeURIComponent(s as string), what);
};
/** What review.json keeps, as it is on the disk (a lone surrogate is written as its JSON escape): none in it. */
const keptWellFormed = (slug: string) => {
  const text = fs.readFileSync(path.join(dataDir(), slug, 'review.json'), 'utf8');
  assert.doesNotMatch(text, /\\ud[89a-f]/i, `${slug}'s review.json`);
};
/** An emoji astride a limit of `n` characters (UTF-16 units: the emoji is two). */
const astride = (n: number) => `${'a'.repeat(n - 1)}😀`;

async function ticketUpload(body: Record<string, unknown>) {
  const t = await request('POST', '/api/uploads/tickets', { body, headers: asOwner });
  assert.equal(t.status, 200, t.text);
  const put = await fetch(`http://127.0.0.1:${port}${new URL(t.json().url).pathname}`, { method: 'PUT', body: fs.readFileSync(clip), headers: { Host: APP } });
  const text = await put.text();
  assert.equal(put.status, 200, text);
  return JSON.parse(text) as { slug: string };
}

let slug = '';

test('an upload’s folder with a lone surrogate, or a long one cut at an emoji, gives a slug every URL can be built from', async () => {
  for (const [i, b] of ['\ud800', '\udfff', '\udc00\ud800'].entries()) {
    const up = await ticketUpload({ filename: `f${i}.mp4`, folder: `Acme${b}` });
    encodes(up.slug, `ticket folder Acme${JSON.stringify(b)}`);
    keptWellFormed(up.slug);
    slug ||= up.slug;
  }
  const tus = await tusUpload(request, clip, { filename: 'cut.mp4', folder: astride(60) }, asOwner);
  assert.equal(tus.status, 200, tus.text);
  encodes(tus.json().slug, 'a tus folder with an emoji at character 60');
  assert.equal(store.loadReview(tus.json().slug)?.folder, astride(60), 'the emoji kept whole');
});

test('folders made, renamed and moved into keep no lone surrogate, nor half an emoji', async () => {
  for (const b of ['\ud800', '\udfff']) {
    const r = await request('POST', '/api/folders', { body: { path: `F${b}` }, headers: asOwner });
    assert.equal(r.status, 200, r.text);
    encodes(r.json().folder, `POST /api/folders F${JSON.stringify(b)}`);
  }
  const cut = await request('POST', '/api/folders', { body: { path: `${astride(60)}tail` }, headers: asOwner });
  assert.equal(cut.json().folder, astride(60));
  assert.equal((await request('POST', '/api/folders', { body: { path: 'Plain' }, headers: asOwner })).status, 200);
  const renamed = await request('PATCH', '/api/folders', { body: { from: 'Plain', to: 'Renamed\ud800' }, headers: asOwner });
  assert.equal(renamed.status, 200, renamed.text);
  encodes(renamed.json().folder, 'a folder renamed');
  const moved = await request('PUT', `/api/review/${encodeURIComponent(slug)}/folder`, { body: { folder: 'Moved\udfff' }, headers: asOwner });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(store.loadReview(slug)?.folder, 'Moved\ufffd');
  keptWellFormed(slug);
  for (const f of JSON.parse(fs.readFileSync(foldersFile(), 'utf8')).folders as string[]) encodes(f, 'folders.json');
});

test('every JSON body comes in well-formed: a link’s label, a display name, a note; an MCP tool’s arguments too', async () => {
  const up = await tusUpload(request, clip, { filename: 'plain.mp4', folder: 'Brand' }, asOwner);
  assert.equal(up.status, 200, up.text);
  const slug: string = up.json().slug;
  const link = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: { label: 'Client\ud800' }, headers: cookie });
  assert.equal(link.status, 200, link.text);
  assert.equal(link.json().label, 'Client�');
  const me = await request('PATCH', '/api/auth/me', { body: { name: 'Olivia\udfff' }, headers: cookie });
  assert.equal(me.status, 200, me.text);
  encodes(auth.getUser(olivia.id)?.name, 'a display name');
  const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 1, text: 'note\ud800', v: 1 }, headers: asOwner });
  assert.equal(note.status, 200, note.text);
  assert.equal(must(store.loadReview(slug)).comments.at(-1)?.text, 'note�');

  const c = new Client({ name: 'well-formed test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { ...asOwner, Host: APP } } }));
  try {
    const r = await c.callTool({ name: 'add_note', arguments: { video: slug, frame: 2, text: 'from an agent\udc00', kind: 'info' } });
    assert.ok(!r.isError, JSON.stringify(r.content));
  } finally {
    await c.close();
  }
  assert.equal(must(store.loadReview(slug)).comments.at(-1)?.text, 'from an agent�');
});

test('a store with a name an older version kept with a lone surrogate: its inbox, INBOX.md, For you and search answer', async () => {
  // A video uploaded into "Old", with a note — then its files as an older version left them for "Old\ud800": review.json
  // and events.jsonl keep the lone surrogate (JSON escapes it), the directories on the disk are written with U+FFFD.
  const up = await tusUpload(request, clip, { filename: 'old.mp4', folder: 'Old' }, asOwner);
  const good: string = up.json().slug;
  const note = await request('POST', `/api/review/${encodeURIComponent(good)}/comments`, { body: { frame: 1, text: 'too dark here', v: 1 }, headers: asOwner });
  assert.equal(note.status, 200, note.text);
  const bad = good.replace('__Old__', '__Old\ud800__');
  const review = JSON.parse(fs.readFileSync(path.join(dataDir(), good, 'review.json'), 'utf8'));
  fs.renameSync(path.join(dataDir(), good), path.join(dataDir(), bad));
  fs.writeFileSync(
    path.join(dataDir(), bad, 'review.json'),
    JSON.stringify({ ...review, video: review.video.replace('/Old/', '/Old\ud800/'), folder: 'Old\ud800' }, null, 2),
  );
  fs.renameSync(path.join(versionsDir(), good), path.join(versionsDir(), bad));
  const events = fs.readFileSync(store.eventsFile(), 'utf8');
  fs.writeFileSync(store.eventsFile(), events.replaceAll('__Old__', '__Old\\ud800__').replaceAll('/Old/', '/Old\\ud800/').replaceAll('"Old"', '"Old\\ud800"'));
  const folders = JSON.parse(fs.readFileSync(foldersFile(), 'utf8'));
  fs.writeFileSync(foldersFile(), JSON.stringify({ ...folders, folders: folders.folders.map((f: string) => (f === 'Old' ? 'Old\ud800' : f)) }));
  assert.match(fs.readFileSync(store.eventsFile(), 'utf8'), /__Old\\ud800__/, 'events.jsonl holds the lone surrogate');
  assert.match(fs.readFileSync(path.join(dataDir(), bad, 'review.json'), 'utf8'), /Old\\ud800/, 'so does review.json');

  const answers: string[] = [];
  const slugs: string[] = [];
  for (const [url, headers] of [
    ['/api/inbox', asOwner],
    ['/api/inbox?all=1', asOwner],
    ['/api/inbox.md', asOwner],
    ['/api/for-you', cookie],
    ['/api/search?q=old', asOwner],
    ['/api/library', asOwner],
  ] as const) {
    const r = await request('GET', url, { headers });
    answers.push(`${url} ${r.status}`);
    if (r.text.startsWith('{'))
      JSON.parse(r.text, (k, v) => {
        if (k === 'slug' && typeof v === 'string') slugs.push(v);
        return v;
      });
  }
  assert.deepEqual(
    answers,
    answers.map((a) => a.replace(/\d+$/, '200')),
    'every one answers',
  );
  // every slug handed out can go into a URL, in the browser too
  for (const s of slugs) encodes(s, 'a slug handed out');
  const inbox = (await request('GET', '/api/inbox', { headers: asOwner })).json().events as { slug: string; text?: string }[];
  const told = inbox.find((e) => e.text === 'too dark here');
  assert.equal(told?.slug, good.replace('__Old__', '__Old�__'), 'the note, under its video’s well-formed id');
  assert.ok(
    allFolders().every((f) => f.isWellFormed()),
    'folders read well-formed',
  );
  // and the video opens under that id
  assert.equal((await request('GET', `/api/review/${encodeURIComponent(must(told).slug)}`, { headers: asOwner })).status, 200);
});
