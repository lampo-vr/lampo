// A reply's words are its author's alone to change or take back (PATCH / DELETE /api/comments/:id/replies/:n), on a
// hosted server where several people write: not another member's, not the owner's (edit-notes is for notes), not a
// reviewer's — reviewers change their own. An API token acts for its person, as with the person's own notes; an
// agent's replies name no account and stay as written. Only plain words change (a status change, picks, a fix preview
// stay as they happened), a moved thread answers 409 rather than changing another reply, and agents read the reply as
// it is now: `vr open`, MCP get_note ("(edited)"), the `edit` event ("EDITED REPLY") and INBOX.md; a deletion is a
// `delete` event that carries the reply, never one that reads as the note's.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Comment, Reply } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, tmpdir, VR } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { eventLine } = await import('../../lib/eventLine.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
const { request, base } = await startApp({ headers: { Connection: 'close' } });
type Who = 'olivia' | 'max' | 'rita' | 'oliviaToken' | 'maxToken';
const as = {} as Record<Who, Record<string, string>>;
const ids = {} as Record<'olivia' | 'max' | 'rita', string>;
let slug = '';
let note: Comment;
const mcp: Client[] = [];
after(async () => {
  for (const c of mcp) await c.close().catch(() => {});
});

before(async () => {
  const people = [
    ['olivia', 'owner'],
    ['max', 'member'],
    ['rita', 'reviewer'],
  ] as const;
  for (const [name, role] of people) {
    const u = await auth.createUser({ email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), password: `${name}s password 1`, role });
    ids[name] = u.id;
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
  }
  as.oliviaToken = { Authorization: `Bearer ${auth.createToken(ids.olivia, 'agent').token}` };
  as.maxToken = { Authorization: `Bearer ${auth.createToken(ids.max, 'agent').token}` };
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Acme' }, as.oliviaToken);
  assert.equal(up.status, 200, up.text);
  slug = encodeURIComponent(up.json().slug);
  const made = await request('POST', `/api/review/${slug}/comments`, { body: { frame: 4, text: 'Some sfx here, subtle on each change?' }, headers: as.max });
  assert.equal(made.status, 200, made.text);
  note = made.json();
  // 0 Olivia's, 1 Max's, 2 Rita's, 3 an agent's (with Olivia's token), 4 Olivia's fix (a status change)
  for (const [who, body] of [
    ['olivia', { note: 'the sfx can be louder' }],
    ['max', { note: 'agreed, a touch louder' }],
    ['rita', { note: 'and shorter' }],
    ['oliviaToken', { note: 'I will raise it by 3 dB', by: 'agent:cut' }],
    ['olivia', { status: 'fixed', note: 'raised it' }],
  ] as const) {
    const r = await request('PATCH', `/api/comments/${note.id}`, { body, headers: as[who] });
    assert.equal(r.status, 200, r.text);
    note = r.json();
  }
});

const replies = async (): Promise<Reply[]> => (await request('GET', `/api/comments/${note.id}`, { headers: as.olivia })).json().comment.replies;
const edit = (who: Who, n: number, at: string | undefined, text: string) =>
  request('PATCH', `/api/comments/${note.id}/replies/${n}`, { body: { at, text }, headers: as[who] });
const remove = (who: Who, n: number, at: string) =>
  request('DELETE', `/api/comments/${note.id}/replies/${n}?at=${encodeURIComponent(at)}`, { headers: as[who] });
const lastEvent = () => store.readEvents({ limit: 1 }).at(-1);

/** `vr` against this server with Olivia's token, as an agent of hers runs it (async: the server shares this process). */
function vr(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const home = tmpdir('vr-agent-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    VR_DATA: path.join(home, 'no-local-store'),
    VR_CACHE: path.join(home, 'no-local-cache'),
    VR_SERVER: base,
    VR_TOKEN: String(as.oliviaToken.Authorization).slice('Bearer '.length),
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

test('its author changes a reply’s words; agents read them as they are now', async () => {
  const before = await replies();
  assert.equal(before[0].by_id, ids.olivia, 'a signed-in person’s reply names their account');
  assert.equal(before[3].by_id, undefined, 'an agent’s reply names none');
  const r = await edit('olivia', 0, before[0].at, '  the swoosh can be a bit louder ');
  assert.equal(r.status, 200, r.text);
  const now = r.json().replies[0] as Reply;
  assert.equal(now.text, 'the swoosh can be a bit louder');
  assert.equal(now.at, before[0].at, 'it keeps when it was written');
  assert.ok(now.edited, 'and says it was edited');
  assert.equal(r.json().status, 'fixed', 'the note’s status is untouched');
  // the event agents wait for: the reply as it reads now, on its note; whose account it was stays out of it
  const e = lastEvent();
  assert.ok(e);
  assert.equal(e.type, 'edit');
  assert.equal(e.reply?.text, 'the swoosh can be a bit louder');
  assert.equal(e.reply?.by_id, undefined, 'no account id in the feed');
  assert.ok(store.readEvents({ limit: 100 }).every((x) => x.reply?.by_id === undefined));
  assert.match(eventLine(e), /\] EDITED REPLY c_[0-9a-f]{6} .* by Olivia — now: "the swoosh can be a bit louder" · on: "Some sfx here/);
  assert.match((await request('GET', '/api/inbox.md', { headers: as.olivia })).text, /EDITED REPLY[\s\S]*- reply now: the swoosh can be a bit louder/);
  // MCP get_note and `vr open` with a token: the words as they are, marked as changed
  const c = new Client({ name: 'reply-edit-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: as.oliviaToken } }));
  mcp.push(c);
  const got = (await c.callTool({ name: 'get_note', arguments: { id: note.id } })) as { content: { type: string; text?: string }[] };
  const text = got.content.map((x) => x.text || '').join('\n');
  assert.match(text, /↳ Olivia: the swoosh can be a bit louder \(edited\)/);
  assert.doesNotMatch(text, /the sfx can be louder/);
  const show = await vr(['show', note.id]);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /↳ Olivia: the swoosh can be a bit louder \(edited\)/);
  // the same words again change nothing
  const events = store.readEvents({ limit: 5000 }).length;
  assert.equal((await edit('olivia', 0, before[0].at, 'the swoosh can be a bit louder')).status, 200);
  assert.equal(store.readEvents({ limit: 5000 }).length, events, 'no event for no change');
});

test('nobody else changes or deletes it: not another member, not the owner, not a reviewer', async () => {
  const [o, m] = await replies();
  for (const who of ['max', 'rita'] as const) {
    const r = await edit(who, 0, o.at, 'mine now');
    assert.equal(r.status, 403, `${who}: ${r.text}`);
    assert.match(r.json().error, /only its author/);
    assert.equal((await remove(who, 0, o.at)).status, 403, who);
  }
  // the owner may edit anyone's notes, never anyone's reply
  assert.equal((await edit('olivia', 1, m.at, 'Olivia’s words in Max’s mouth')).status, 403);
  assert.equal((await remove('olivia', 1, m.at)).status, 403);
  const after = await replies();
  assert.equal(after[0].text, 'the swoosh can be a bit louder');
  assert.equal(after[1].text, 'agreed, a touch louder');
  // a reviewer changes their own
  const rita = after[2];
  const r = await edit('rita', 2, rita.at, 'and a bit shorter');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json().replies[2].text, 'and a bit shorter');
});

test('an API token acts for its person, as with their notes; an agent’s replies stay as written', async () => {
  const list = await replies();
  const own = await edit('oliviaToken', 0, list[0].at, 'the swoosh a bit louder, please');
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json().replies[0].text, 'the swoosh a bit louder, please');
  assert.equal((await edit('oliviaToken', 1, list[1].at, 'x')).status, 403, 'not Max’s with Olivia’s token');
  assert.equal((await edit('maxToken', 0, list[0].at, 'x')).status, 403, 'not Olivia’s with Max’s token');
  // the agent wrote it with Olivia's token, but as itself: it names no account, and no person's name matches it
  assert.ok(list[3].by.startsWith('agent:'));
  for (const who of ['oliviaToken', 'olivia'] as const) {
    assert.equal((await edit(who, 3, list[3].at, 'x')).status, 403, who);
    assert.equal((await remove(who, 3, list[3].at)).status, 403, who);
  }
  assert.equal((await replies())[3].text, 'I will raise it by 3 dB');
});

test('only plain words change; a moved thread answers 409, a bad request 400, a missing reply 404', async () => {
  const list = await replies();
  const fix = list[4];
  assert.equal(fix.status, 'fixed');
  const r = await edit('olivia', 4, fix.at, 'raised it a lot');
  assert.equal(r.status, 409, r.text);
  assert.match(r.json().error, /status change stays/);
  assert.equal((await remove('olivia', 4, fix.at)).status, 409);
  assert.equal((await edit('olivia', 0, '2020-01-01T00:00:00+00:00', 'x')).status, 409, 'not the reply written then');
  assert.equal((await edit('olivia', 99, list[0].at, 'x')).status, 404);
  assert.equal((await edit('olivia', 0, list[0].at, '   ')).status, 400, 'no words: delete it instead');
  assert.equal((await edit('olivia', 0, undefined, 'x')).status, 400, 'which one: at');
  assert.equal((await request('PATCH', `/api/comments/${note.id}/replies/x`, { body: { at: list[0].at, text: 'x' }, headers: as.olivia })).status, 400);
  assert.equal(
    (await request('PATCH', `/api/comments/${note.id}/replies/0`, { body: { at: list[0].at, text: 'x'.repeat(20_001) }, headers: as.olivia })).status,
    400,
  );
  assert.equal((await request('PATCH', '/api/comments/c_000000/replies/0', { body: { at: list[0].at, text: 'x' }, headers: as.olivia })).status, 404);
  assert.equal((await request('DELETE', `/api/comments/${note.id}/replies/0`, { headers: as.olivia })).status, 400, 'a delete names its time too');
  assert.equal((await replies())[0].text, 'the swoosh a bit louder, please');
});

test('its author takes it back: a delete event that carries the reply; the note and the others stay, a stale request moves nothing', async () => {
  const list = await replies();
  const r = await remove('olivia', 0, list[0].at);
  assert.equal(r.status, 200, r.text);
  const left = r.json().replies as Reply[];
  assert.equal(left.length, list.length - 1);
  assert.equal(left[0].text, 'agreed, a touch louder', 'Max’s reply moved up');
  const e = lastEvent();
  assert.ok(e);
  assert.equal(e.type, 'delete');
  assert.equal(e.id, note.id);
  assert.match(eventLine(e), /\] DELETED REPLY c_[0-9a-f]{6} .* by Olivia — their reply of \d\d:\d\d:\d\d · on: "Some sfx here/);
  assert.equal((await request('GET', `/api/comments/${note.id}`, { headers: as.olivia })).status, 200, 'the note stays');
  // the same delete again, from a tab that still shows it at 0: the reply there now is Max's, and stays (409 when it was
  // written at another second, 403 when in the same one: never deleted)
  const again = await remove('olivia', 0, list[0].at);
  assert.ok([403, 409].includes(again.status), again.text);
  assert.equal((await replies())[0].text, 'agreed, a touch louder');
  // a reply that brought a reference keeps it company: its words change, the reply isn't deleted under it
  const said = await request('POST', `/api/comments/${note.id}/refs`, {
    body: { kind: 'link', url: 'https://example.com/whoosh', note: 'like this one' },
    headers: as.rita,
  });
  assert.equal(said.status, 200, said.text);
  const withRef = (await replies()).at(-1) as Reply;
  assert.equal(withRef.by_id, ids.rita);
  const n = (await replies()).length - 1;
  assert.equal((await remove('rita', n, withRef.at)).status, 409);
  assert.equal((await edit('rita', n, withRef.at, 'like this one, shorter')).status, 200);
});
