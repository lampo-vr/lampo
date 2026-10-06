// What people wrote or uploaded is theirs by account, not by display name: a rename keeps a note, a reference and an
// upload theirs, and a new account that reuses a deleted person's name gets none of it. Records from before account
// ids (and local `vr` writes) are still matched by name.
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ForYouResponse } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, must } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { badge } = await import('../../server/context.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { DEFAULT_PREFS } = await import('../../lib/push/index.ts');

const { ctx, base, request } = await startApp({ headers: { Connection: 'close' } });

const origin = { Origin: PUBLIC };
type Headers = Record<string, string>;
/** An account and an API token for it. */
async function person(name: string, role: 'owner' | 'member' | 'reviewer'): Promise<{ id: string; as: Headers }> {
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const user = await auth.createUser({ email, name, password: `${name} password 123`, role });
  const token = (await request('POST', '/api/auth/token', { body: { email, password: `${name} password 123` }, headers: origin })).json().token as string;
  return { id: user.id, as: { Authorization: `Bearer ${token}` } };
}
let clip = 0;
async function upload(as: Headers): Promise<string> {
  const file = makeVideo(path.join(dir, `in/clip${++clip}.mp4`), { w: 64, h: 36, dur: 0.5, freq: 300 + clip * 50 });
  const r = await tusUpload(request, file, { filename: `clip${clip}.mp4` }, as);
  assert.equal(r.status, 200, r.text);
  return r.json().slug;
}
const note = async (slug: string, as: Headers, text: string) => {
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 3, text }, headers: as });
  assert.equal(r.status, 200, r.text);
  return r.json() as { id: string; author: string; author_id?: string };
};
const edit = (id: string, as: Headers) => request('PATCH', `/api/comments/${id}`, { body: { text: 'changed' }, headers: as });

let slug = '';
before(async () => {
  const olivia = await person('Olivia', 'owner');
  ctx.setup.token = null;
  slug = await upload(olivia.as);
});

test('the server records who wrote a note, added a reference or uploaded a video by account', async () => {
  const rita = await person('Rita', 'reviewer');
  const c = await note(slug, rita.as, 'too fast');
  assert.equal(c.author, 'Rita');
  assert.equal(c.author_id, rita.id);
  const ref = await request('POST', `/api/comments/${c.id}/refs`, { body: { kind: 'link', url: 'https://example.com/look' }, headers: rita.as });
  assert.equal(ref.status, 200, ref.text);
  assert.equal(ref.json().ref.by_id, rita.id);
  const max = await person('Max', 'member');
  const mine = await upload(max.as);
  assert.equal(must(store.loadReview(mine)).added_by_id, max.id);
});

test('renamed: my notes, references and uploads stay mine', async () => {
  const rosa = await person('Rosa', 'reviewer');
  const c = await note(slug, rosa.as, 'logo early');
  const ref = (await request('POST', `/api/comments/${c.id}/refs`, { body: { kind: 'link', url: 'https://example.com/a' }, headers: rosa.as })).json().ref;
  await auth.updateUser(rosa.id, { name: 'Rosa Quinn' });
  assert.equal((await edit(c.id, rosa.as)).status, 200, 'still her note');
  const cap = await request('PATCH', `/api/comments/${c.id}/refs/${ref.id}`, { body: { caption: 'this look' }, headers: rosa.as });
  assert.equal(cap.status, 200, cap.text);
  assert.equal((await request('DELETE', `/api/comments/${c.id}`, { headers: rosa.as })).status, 200);

  const mia = await person('Mia', 'member');
  const hers = await upload(mia.as);
  await note(hers, mia.as, 'keeps it archived rather than removed');
  await auth.updateUser(mia.id, { name: 'Mia Park' });
  const removed = await request('DELETE', `/api/library/${encodeURIComponent(hers)}`, { headers: mia.as });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await request('POST', `/api/library/${encodeURIComponent(hers)}/restore`, { headers: mia.as })).status, 200);
});

test('a new account with a deleted person’s name gets nothing of theirs', async () => {
  const ren = await person('Ren', 'reviewer');
  const c = await note(slug, ren.as, 'colour shift');
  const ref = (await request('POST', `/api/comments/${c.id}/refs`, { body: { kind: 'link', url: 'https://example.com/b' }, headers: ren.as })).json().ref;
  const noa = await person('Noa', 'member');
  const hers = await upload(noa.as);
  auth.deleteUser(ren.id);
  auth.deleteUser(noa.id);

  const ren2 = await person('Ren', 'reviewer');
  assert.equal((await edit(c.id, ren2.as)).status, 403);
  assert.equal((await request('DELETE', `/api/comments/${c.id}`, { headers: ren2.as })).status, 403);
  assert.equal((await request('PATCH', `/api/comments/${c.id}/refs/${ref.id}`, { body: { caption: 'mine now' }, headers: ren2.as })).status, 403);
  assert.equal((await request('DELETE', `/api/comments/${c.id}/refs/${ref.id}`, { headers: ren2.as })).status, 403);
  const noa2 = await person('Noa', 'member');
  assert.equal((await request('DELETE', `/api/library/${encodeURIComponent(hers)}`, { headers: noa2.as })).status, 403);
});

test('records from before account ids are matched by name, as before', async () => {
  const kai = await person('Kai', 'reviewer');
  const old = store.addComment(slug, { frame: 4, text: 'written by an older version', author: 'Kai' });
  assert.equal(old.author_id, undefined);
  assert.equal((await edit(old.id, kai.as)).status, 200);
  const other = await person('Lee', 'reviewer');
  assert.equal((await edit(old.id, other.as)).status, 403);
});

test('over MCP too: a person writing as themselves is recorded by account', async () => {
  const rae = await person('Rae', 'reviewer');
  const mcp = new Client({ name: 'chat-app', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const url = new URL(`${base}/mcp`);
  await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: rae.as } }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await mcp.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
      return { error: !!r.isError, text: r.content.map((x) => x.text || '').join('\n') };
    };
    const added = await call('add_note', { video: slug, frame: 2, text: 'from a chat app' });
    assert.ok(!added.error, added.text);
    const id = must(/c_[0-9a-f]{6}/.exec(added.text))[0];
    const c = must(store.findComment(id)).comment;
    assert.equal(c.author, 'Rae');
    assert.equal(c.author_id, rae.id);
    await auth.updateUser(rae.id, { name: 'Rae Stone' });
    const ref = await call('attach_reference', { id, url: 'https://example.com/c' });
    assert.ok(!ref.error, `still her note after a rename: ${ref.text}`);
    assert.equal(must(store.findComment(id)).comment.refs?.[0]?.by_id, rae.id);
  } finally {
    await mcp.close();
  }
});

test('the app badge counts an agent’s answer to my note, as my inbox does', async () => {
  const nora = await person('Nora', 'member');
  const c = await note(slug, nora.as, 'the logo comes in late');
  assert.equal(c.author_id, nora.id);
  store.updateComment(c.id, { note: 'Moving it to 0:10 in the next render', by: 'agent:promo-edit' });
  const inbox = (await request('GET', '/api/for-you', { headers: nora.as })).json() as ForYouResponse;
  assert.ok(
    inbox.items.some((i) => i.kind === 'answer' && i.id === c.id),
    'in the inbox',
  );
  const phone = {
    endpoint: 'https://push.example/nora',
    keys: { p256dh: 'k', auth: 'a' },
    user: nora.id,
    name: 'Phone',
    created: new Date().toISOString(),
    last_ok: null,
    prefs: DEFAULT_PREFS,
  };
  assert.equal(badge(true, 'unused')(phone), inbox.counts.total);
});
