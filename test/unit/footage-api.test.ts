// covers: server/routes/footage.ts lib/footage/indexer.ts lib/footage/search.ts mcp/tools/footage.ts lib/backend/remote.ts
// Footage search on a hosted server with two workspaces: off until an owner or admin turns it on, then each
// workspace's uploads are indexed in the background through the job queue, and every way in — the API, `vr` logged in
// to the server, find_footage over /mcp — finds only that workspace's shots, never names a file on the server, and
// can't reach the other's shots by id.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { encodeOnce, isolatedEnv, tmpdir, until, VR } from '../lib/helpers.ts';
import { tusUpload } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake', VR_OCR: 'off' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const paths = await import('../../lib/paths.ts');
const { resetEmbedder } = await import('../../lib/footage/embedder.ts');
const { port, base, request } = await startApp();
after(() => resetEmbedder());

const alice = await auth.createUser({ email: 'a@example.com', name: 'Alice', password: 'a long password', role: 'owner' });
const mike = await auth.createUser({ email: 'm@example.com', name: 'Mike', password: 'a long password', role: 'member' });
const rita = await auth.createUser({ email: 'r@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
const bob = await auth.createUser({ email: 'b@example.com', name: 'Bob', password: 'a long password', role: 'owner' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
ws.removeMember('w1', bob.id);
const bearer = (id: string, workspace: string) => ({ Authorization: `Bearer ${auth.createToken(id, 't', { workspace }).token}` });
const asAlice = bearer(alice.id, 'w1');
const asMike = bearer(mike.id, 'w1');
const asRita = bearer(rita.id, 'w1');
const asBob = bearer(bob.id, B);

// A: one red shot. B: three shots (blue, green, yellow).
const colours = (file: string, list: string[]) =>
  encodeOnce(file, [
    '-v',
    'error',
    '-filter_complex',
    `${list.map((c, i) => `color=c=${c}:s=320x180:r=25:d=2,drawgrid=w=40:h=40:t=2:c=white[s${i}]`).join(';')};${list.map((_, i) => `[s${i}]`).join('')}concat=n=${list.length}:v=1:a=0,format=yuv420p[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
  ]);
const up = async (file: string, headers: Record<string, string>) => {
  const r = await tusUpload(request, file, { filename: path.basename(file), folder: 'Footage' }, headers);
  assert.equal(r.status, 200, r.text);
};
await up(colours(path.join(dir, 'a/alpha-red.mp4'), ['red']), asAlice);
await up(colours(path.join(dir, 'b/bravo-colours.mp4'), ['blue', 'green', 'yellow']), asBob);

const get = async (url: string, headers: Record<string, string>) => {
  const r = await request('GET', url, { headers });
  assert.equal(r.status, 200, `${url}: ${r.text}`);
  return r.json();
};
const indexed = (headers: Record<string, string>) =>
  until(async () => {
    const s = await get('/api/footage/status', headers);
    return s.on && s.videos && s.indexed === s.videos ? s : null;
  }, 'the workspace indexed');

test('off on a hosted server until an owner or admin turns it on; a member may not', async () => {
  const s = await get('/api/footage/status', asAlice);
  assert.equal(s.on, false);
  assert.match(s.note, /an owner or admin turns it on/);
  assert.equal((await get('/api/footage/find?q=red', asAlice)).shots.length, 0);
  const put = (headers: Record<string, string>) => request('PUT', '/api/footage/settings', { headers, body: { on: true } });
  assert.equal((await put(asMike)).status, 403, 'a member');
  assert.equal((await put(asRita)).status, 403, 'a reviewer');
  const ok = await put(asAlice);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await put(asBob)).status, 200);
  assert.deepEqual([(await indexed(asAlice)).shots, (await indexed(asBob)).shots], [1, 3]);
});

test('each workspace finds its own shots only, and no answer names a file on the server', async () => {
  for (const [who, headers, mine, theirs] of [
    ['alice', asAlice, 'alpha-red.mp4', 'bravo'],
    ['rita (reviewer)', asRita, 'alpha-red.mp4', 'bravo'],
    ['bob', asBob, 'bravo-colours.mp4', 'alpha'],
  ] as const) {
    for (const q of ['red', 'blue', 'green', '']) {
      const r = await request('GET', `/api/footage/find?q=${encodeURIComponent(q)}&limit=50`, { headers });
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.text.includes(theirs), `${who} asked "${q}": ${r.text.slice(0, 300)}`);
      assert.ok(!r.text.includes(paths.DATA) && !r.text.includes(paths.CACHE) && !r.text.includes('"file"'), `${who}: no path on the server`);
      assert.ok(r.json().shots.every((s: { name: string }) => s.name === mine));
    }
  }
  assert.equal((await get('/api/footage/find?q=blue', asBob)).shots[0].in, 0, 'B’s blue shot first');
});

test('a contact sheet by id reaches the caller’s own workspace only', async () => {
  const ids = async (headers: Record<string, string>) => (await get('/api/footage/find?q=&limit=50', headers)).shots.map((s: { id: string }) => s.id);
  // each index numbers its shots from a random start: B's ids name nothing in A (and an old id nothing in a new index)
  const inA = await ids(asAlice);
  const onlyB = (await ids(asBob)).find((id: string) => !inA.includes(id));
  assert.ok(onlyB, JSON.stringify(inA));
  assert.ok(Number(onlyB.slice(1)) > 100000, onlyB);
  const mine = await request('GET', `/api/footage/sheet?ids=${onlyB}`, { headers: asBob });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers['content-type'], 'image/jpeg');
  const theirs = await request('GET', `/api/footage/sheet?ids=${onlyB}`, { headers: asAlice });
  assert.equal(theirs.status, 404, theirs.text);
  assert.equal((await request('GET', '/api/footage/sheet?ids=../x', { headers: asAlice })).status, 400);
});

test('`vr` logged in to the server and find_footage over /mcp answer the same, without paths', async () => {
  const token = auth.createToken(alice.id, 'agent', { workspace: 'w1' }).token;
  const home = tmpdir('vr-agent-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VR_SERVER: base,
    VR_TOKEN: token,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    VR_DATA: path.join(home, 'none'),
    VR_CACHE: path.join(home, 'none-cache'),
  };
  delete env.VR_MODE;
  const vr = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
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
  const json = await vr(['footage', 'find', 'red', '--json']);
  assert.equal(json.code, 0, json.err);
  const a = JSON.parse(json.out);
  assert.equal(a.shots[0].name, 'alpha-red.mp4');
  assert.equal(a.shots[0].file, undefined);
  const list = await vr(['footage', 'find', 'red', '--sheet']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^1 of 1 shots · "red"\ns\d+ Footage\/alpha-red\.mp4 00:00:00–00:01:24 2\.0s 16:9 static · /);
  assert.match(list.out, /\nsheet .+\.jpg\n$/, 'the sheet downloaded to this machine');
  assert.equal((await vr(['footage', 'index'])).code, 1, 'the server indexes on its own');

  const c = new Client({ name: 'footage-test', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const r = (await c.callTool({ name: 'find_footage', arguments: { query: 'red', sheet: true } })) as {
      content: { type: string; text?: string; mimeType?: string }[];
      isError?: boolean;
    };
    assert.ok(!r.isError, JSON.stringify(r.content));
    const text = r.content.find((x) => x.type === 'text')?.text ?? '';
    assert.match(text, /^1 of 1 shots · "red"\ns\d+ Footage\/alpha-red\.mp4 /);
    assert.ok(!text.includes('bravo') && !text.includes(paths.DATA) && !text.includes(paths.CACHE), text);
    assert.equal(r.content.find((x) => x.type === 'image')?.mimeType, 'image/jpeg', 'one contact sheet');
  } finally {
    await c.close();
  }
});

test('turned off, a workspace answers that it is off; the other workspace is untouched', async () => {
  assert.equal((await request('PUT', '/api/footage/settings', { headers: asAlice, body: { on: false } })).status, 200);
  const a = await get('/api/footage/find?q=red', asAlice);
  assert.deepEqual([a.shots.length, a.index.on], [0, false]);
  assert.equal((await get('/api/footage/find?q=blue', asBob)).shots.length, 3);
});
