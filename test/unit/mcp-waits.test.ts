// wait_for_feedback on a hosted server holds connections: how many a caller and a workspace may hold (WAIT_LIMITS in
// server/routes/mcp.ts), what the one over the cap is told, and that waits wake on the event itself rather than each
// polling the log (they share one read of it: lib/store.ts readEvents).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, isolatedEnv, makeVideo, sleep } from '../lib/helpers.ts';
import { client, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { startServerFeed } = await import('../../server/feed.ts');
const { LISTEN_LIMITS, WAIT_LIMITS } = await import('../../server/routes/mcp.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const app = createApp(ctx);
const feed = startServerFeed(ctx, 50);
let server: http.Server;
let port = 0;
let request: Request;
const tokens: Record<string, string> = {};
let slug = '';

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  for (const [name, role] of [
    ['olivia', 'owner'],
    ['rita', 'reviewer'],
  ] as const) {
    const u = await auth.createUser({ email: `${name}@example.com`, name, password: 'a long password', role });
    tokens[name] = auth.createToken(u.id, 'agent').token;
  }
  const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Spots' }, { Authorization: `Bearer ${tokens.olivia}` });
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(() => {
  feed.stop();
  server.closeAllConnections();
  server.close();
});

/** A tools/call over /mcp with a token; resolves with the tool's text when the answer is complete. */
function call(token: string, name: string, args: object): Promise<{ text: string; isError: boolean; ms: number }> {
  const t = Date.now();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        agent: false,
        headers: {
          Host: 'review.test',
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let raw = '';
        let settled = false;
        res.setEncoding('utf8');
        res.on('data', (d) => {
          raw += d;
        });
        // A stream the server cut (its caller lost the right to it) closes without a complete answer: what came is all.
        const done = () => {
          if (settled) return;
          settled = true;
          try {
            const msg = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
              result?: { content?: { text?: string }[]; isError?: boolean };
            };
            resolve({ text: (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!msg.result?.isError, ms: Date.now() - t });
          } catch {
            resolve({ text: raw, isError: true, ms: Date.now() - t });
          }
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('error', (e) => (String(e).includes('socket hang up') ? resolve({ text: '', isError: true, ms: Date.now() - t }) : reject(e)));
    req.end(body);
  });
}
const wait = (who: string, timeout_s: number) => call(tokens[who] as string, 'wait_for_feedback', { timeout_s });

test('a caller holds at most WAIT_LIMITS.perCaller waits: the next is answered at once, in words; others still wait', async () => {
  const open = Array.from({ length: WAIT_LIMITS.perCaller }, () => wait('olivia', 3));
  await sleep(400);
  const over = await wait('olivia', 3);
  assert.equal(over.isError, true);
  assert.match(over.text, /already waiting: this connection \(its API token or app\) has 4 waits open/);
  assert.ok(over.ms < 1500, `answered at once (${over.ms} ms)`);
  // Someone else in the workspace still waits.
  const rita = wait('rita', 1);
  const done = await Promise.all(open);
  assert.ok(
    done.every((d) => !d.isError && /No new feedback in 3 s/.test(d.text)),
    done.map((d) => d.text).join('\n'),
  );
  assert.match((await rita).text, /No new feedback in 1 s/);
  // The places are free again.
  assert.equal((await wait('olivia', 0)).isError, false);
});

test('a workspace holds at most WAIT_LIMITS.perWorkspace waits', async () => {
  const was = WAIT_LIMITS.perWorkspace;
  WAIT_LIMITS.perWorkspace = 3;
  try {
    const open = [wait('olivia', 2), wait('olivia', 2), wait('rita', 2)];
    await sleep(400);
    const over = await wait('rita', 2);
    assert.equal(over.isError, true);
    assert.match(over.text, /this workspace has 3 waits open/);
    await Promise.all(open);
    assert.equal((await wait('rita', 0)).isError, false);
  } finally {
    WAIT_LIMITS.perWorkspace = was;
  }
});

test('waits wake on the event itself (no polling), all of them, sharing one read of the log', async () => {
  const open = Array.from({ length: 4 }, () => wait('olivia', 30));
  await sleep(400);
  const t = Date.now();
  store.addComment(slug, { frame: 3, text: 'Logo later', author: 'Mia' });
  const done = await Promise.all(open);
  for (const d of done) assert.match(d.text, /Logo later/);
  assert.ok(Date.now() - t < 5000, `woken by the note, not a poll (${Date.now() - t} ms)`);
  // The log's tail is read once while it is unchanged: every reader shares it.
  const a = store.readEvents({ limit: 2000 });
  assert.equal(store.readEvents({ limit: 2000 }), a, 'the same parse, shared');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]), 'and nobody can change it for the others');
  store.addComment(slug, { frame: 4, text: 'Music softer', author: 'Mia' });
  assert.notEqual(store.readEvents({ limit: 2000 }), a, 'a new event is a new read');
});

// ---------------------------------------------------------------- WS-1, AGENT-7: access ends, the stream ends

const clients: { close(): Promise<void> }[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});
async function connect(token: string) {
  const c = new Client({ name: 'listen-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, Host: 'review.test' } },
    }),
  );
  clients.push(c);
  return c;
}
async function member(name: string) {
  const u = await auth.createUser({ email: `${name}@example.com`, name, password: 'a long password', role: 'member' });
  return { user: u, token: auth.createToken(u.id, 'agent').token };
}

test('WS-1: a wait in flight hands nothing over once its token is revoked', async () => {
  const max = await member('max');
  const waiting = call(max.token, 'wait_for_feedback', { timeout_s: 20 });
  await sleep(400);
  auth.revokeToken(auth.listTokens(max.user.id)[0]?.id as string, max.user.id);
  store.addComment(slug, { frame: 5, text: 'CONFIDENTIAL: use take 4', author: 'Mia' });
  const got = await waiting;
  assert.ok(!got.text.includes('CONFIDENTIAL'), got.text);
  assert.ok(got.ms < 5000, `ended at once, not at its timeout (${got.ms} ms)`);
});

test('WS-1: a listen stream ends when its account is disabled; nothing more reaches it', async () => {
  const mila = await member('mila');
  const c = await connect(mila.token);
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (n) => {
    updates.push(n.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox'] });
  store.addComment(slug, { frame: 6, text: 'still a member', author: 'Mia' });
  for (let i = 0; i < 100 && !updates.length; i++) await sleep(50);
  assert.deepEqual(updates, ['vr://inbox'], 'heard while a member');
  updates.length = 0;
  await auth.updateUser(mila.user.id, { disabled: true });
  store.addComment(slug, { frame: 7, text: 'after she left', author: 'Mia' });
  const how = await Promise.race([sub.closed, sleep(5000).then(() => 'still open')]);
  assert.notEqual(how, 'still open', 'the stream was cut');
  await sleep(300);
  assert.deepEqual(updates, [], 'and heard nothing after');
});

test('VA2-2: events going past an open OAuth listen re-read nothing; ending its access still cuts it at once', async () => {
  const crypto = await import('node:crypto');
  const fs = (await import('node:fs')).default;
  const oauth = await import('../../lib/oauth/store.ts');
  const { RECHECK_MIN_MS } = await import('../../server/routes/mcp.ts');
  const nora = await member('nora');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const app = { client_id: 'nora-app', kind: 'dcr' as const, name: 'Nora app', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' as const };
  const asked = oauth.createRequest({
    client: app,
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const { access_token } = oauth.redeemCode({
    code: oauth.createCode(asked, nora.user),
    client_id: app.client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  });
  const c = await connect(access_token);
  const updates: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', (n) => {
    updates.push(n.params.uri);
  });
  const sub = await c.listen({ resourceSubscriptions: ['vr://inbox'] });
  // A busy workspace: 40 events. Each one used to re-read and parse every app connection on the server (grants.json),
  // for every open stream.
  let reads = 0;
  const read = fs.readFileSync;
  fs.readFileSync = ((...a: Parameters<typeof read>) => {
    if (String(a[0]).endsWith('grants.json')) reads++;
    return read(...a);
  }) as typeof read;
  try {
    for (let i = 0; i < 40; i++) store.addComment(slug, { frame: 8, text: `busy ${i}`, author: 'Mia' });
    for (let i = 0; i < 100 && !updates.length; i++) await sleep(50);
    await sleep(500);
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(updates.length > 0, 'the events were heard');
  assert.ok(reads <= 1, `grants.json read ${reads} times for 40 events`);
  // Disconnecting the app ends the stream before the next event, without waiting for the stream's next turn.
  oauth.revokeAppsOf(nora.user.id, 'disconnected');
  updates.length = 0;
  store.addComment(slug, { frame: 9, text: 'after the app was disconnected', author: 'Mia' });
  const how = await Promise.race([sub.closed, sleep(RECHECK_MIN_MS - 1000).then(() => 'still open')]);
  assert.notEqual(how, 'still open', 'the stream was cut');
  await sleep(300);
  assert.deepEqual(updates, [], 'and heard nothing after');
});

/** users.json changed the way `vr admin` in another process changes it: written in place, no accessEnded() here. */
async function elsewhere(change: (f: { tokens: { id: string; expires?: string }[] }) => void) {
  const fs = (await import('node:fs')).default;
  const f = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8'));
  change(f);
  const tmp = `${auth.USERS_FILE}.elsewhere`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, auth.USERS_FILE);
}

test('A12-D10: access ended in another process reaches an open wait before the next note does', async () => {
  const ola = await member('ola');
  const id = auth.listTokens(ola.user.id)[0]?.id;
  const waiting = call(ola.token, 'wait_for_feedback', { timeout_s: 20 });
  await sleep(400);
  // `vr admin` elsewhere revokes the token (or resets the password, removes the member…): this process isn't told.
  await elsewhere((f) => {
    f.tokens = f.tokens.filter((t) => t.id !== id);
  });
  store.addComment(slug, { frame: 11, text: 'SECRET after the revoke elsewhere', author: 'Mia' });
  const got = await waiting;
  assert.ok(!got.text.includes('SECRET'), got.text);
  assert.ok(got.ms < 5000, `cut at the note, not at its timeout (${got.ms} ms)`);
});

test('A12-D10: a token that expires while its wait is open hands nothing over after it expired', async () => {
  const eva = await member('eva');
  const id = auth.listTokens(eva.user.id)[0]?.id;
  await elsewhere((f) => {
    const t = f.tokens.find((x) => x.id === id);
    if (t) t.expires = new Date(Date.now() + 1500).toISOString();
  });
  const waiting = call(eva.token, 'wait_for_feedback', { timeout_s: 20 });
  // Past its expiry, inside the 5 s an answer is remembered.
  await sleep(2200);
  store.addComment(slug, { frame: 12, text: 'SECRET after it expired', author: 'Mia' });
  const got = await waiting;
  assert.ok(!got.text.includes('SECRET'), got.text);
  assert.ok(got.ms < 6000, `cut at the note (${got.ms} ms)`);
});

test('A12-D13: an open stream asking again whether its token still gets in is no use of the token (users.json stays)', async () => {
  const fs = (await import('node:fs')).default;
  const key = () => {
    const st = fs.statSync(auth.USERS_FILE);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  };
  const was = auth.TOKEN_TOUCH.everyMs;
  // Every use of a token is written down now, so a re-check that counted as one would show at once.
  auth.TOKEN_TOUCH.everyMs = 0;
  try {
    const tess = await member('tess');
    const c = await connect(tess.token);
    const updates: string[] = [];
    c.setNotificationHandler('notifications/resources/updated', (n) => {
      updates.push(n.params.uri);
    });
    const sub = await c.listen({ resourceSubscriptions: ['vr://inbox'] });
    await sleep(300);
    const before = key();
    const used = auth.listTokens(tess.user.id)[0]?.last_used;
    // Each event makes the open listen ask again (the first one at least: nothing is remembered yet).
    store.addComment(slug, { frame: 10, text: 'heard by the listen', author: 'Mia' });
    for (let i = 0; i < 100 && !updates.length; i++) await sleep(50);
    assert.ok(updates.length, 'the listen heard it, so it asked');
    await sleep(200);
    assert.equal(key(), before, 'users.json was not written by the re-check');
    assert.equal(auth.listTokens(tess.user.id)[0]?.last_used, used, 'last_used says when the token was last used, not that it is connected');
    await sub.close();
  } finally {
    auth.TOKEN_TOUCH.everyMs = was;
  }
});

test('AGENT-7: a connection holds at most LISTEN_LIMITS.perCaller listen streams', async () => {
  const LISTEN_LIMIT = LISTEN_LIMITS.perCaller;
  const c = await connect(tokens.olivia as string);
  const subs = [];
  for (let i = 0; i < LISTEN_LIMIT; i++) subs.push(await c.listen({ resourceSubscriptions: ['vr://inbox'] }));
  await assert.rejects(c.listen({ resourceSubscriptions: ['vr://inbox'] }), 'one more is refused');
  // Another caller still listens.
  const other = await connect(tokens.rita as string);
  const theirs = await other.listen({ resourceSubscriptions: ['vr://inbox'] });
  await theirs.close();
  // A closed one frees its place.
  await subs[0]?.close();
  await sleep(300);
  const again = await c.listen({ resourceSubscriptions: ['vr://inbox'] });
  for (const s of [again, ...subs.slice(1)]) await s.close();
});

// ---------------------------------------------------------------- VA2-1, VA2-6: per connection and per person

/** An app connected through OAuth for `user` (as the token endpoint makes it). */
async function appFor(user: { id: string; epoch: number }, client_id: string) {
  const crypto = await import('node:crypto');
  const oauth = await import('../../lib/oauth/store.ts');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const client = { client_id, kind: 'dcr' as const, name: client_id, host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' as const };
  const asked = oauth.createRequest({
    client,
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const code = oauth.createCode(asked, auth.getUser(user.id) as import('../../lib/auth.ts').User);
  return oauth.redeemCode({ code, client_id, redirect_uri: 'http://127.0.0.1:9/cb', code_verifier: verifier, resource: `${PUBLIC}/mcp` }).access_token;
}

test('VA2-1: listens count by account across tokens and apps, and a new name changes nothing', async () => {
  const was = LISTEN_LIMITS.perPerson;
  LISTEN_LIMITS.perPerson = 6;
  try {
    const lena = await member('lena');
    const second = auth.createToken(lena.user.id, 'second agent').token;
    const [one, two, viaApp] = [await connect(lena.token), await connect(second), await connect(await appFor(lena.user, 'lena-app'))];
    const subs = [];
    for (let i = 0; i < 4; i++) subs.push(await one.listen({ resourceSubscriptions: ['vr://inbox'] }));
    await assert.rejects(one.listen({ resourceSubscriptions: ['vr://inbox'] }), /this connection/, 'a connection’s own four');
    for (let i = 0; i < 2; i++) subs.push(await two.listen({ resourceSubscriptions: ['vr://inbox'] }));
    await assert.rejects(two.listen({ resourceSubscriptions: ['vr://inbox'] }), /your account/, 'the person’s six, across tokens');
    await assert.rejects(viaApp.listen({ resourceSubscriptions: ['vr://inbox'] }), /your account/, 'apps count with them');
    await auth.updateUser(lena.user.id, { name: 'Lena Renamed' });
    await assert.rejects(viaApp.listen({ resourceSubscriptions: ['vr://inbox'] }), /your account/, 'a new name is the same person');
    await subs[0]?.close();
    await sleep(300);
    subs[0] = await viaApp.listen({ resourceSubscriptions: ['vr://inbox'] });
    for (const sub of subs) await sub?.close();
  } finally {
    LISTEN_LIMITS.perPerson = was;
  }
});

test('VA2-6: a person’s fifth agent waits like the first; past the person’s cap the answer says so', async () => {
  const kai = await member('kai');
  const agents = [kai.token, ...[2, 3, 4, 5].map((n) => auth.createToken(kai.user.id, `agent ${n}`).token)];
  const held = agents.map((t) => call(t, 'wait_for_feedback', { timeout_s: 2 }));
  const done = await Promise.all(held);
  assert.ok(
    done.every((d) => !d.isError && /No new feedback in 2 s/.test(d.text)),
    done.map((d) => d.text).join('\n'),
  );
  const was = WAIT_LIMITS.perPerson;
  WAIT_LIMITS.perPerson = 4;
  try {
    const open = agents.slice(0, 4).map((t) => call(t, 'wait_for_feedback', { timeout_s: 2 }));
    await sleep(400);
    const over = await call(agents[4] as string, 'wait_for_feedback', { timeout_s: 2 });
    assert.equal(over.isError, true);
    assert.match(over.text, /your agents hold 4 waits open across your tokens and apps/);
    await Promise.all(open);
  } finally {
    WAIT_LIMITS.perPerson = was;
  }
});

// ---------------------------------------------------------------- A12-D12: places kept for the people who run agents

async function someone(name: string, role: 'member' | 'reviewer' | 'admin') {
  const u = await auth.createUser({ email: `${name}@example.com`, name, password: 'a long password', role });
  return auth.createToken(u.id, 'agent').token;
}

test('A12-D12: reviewers can’t fill a workspace’s waits, nor members its owners’ — each role has its share', async () => {
  const was = { ...WAIT_LIMITS };
  Object.assign(WAIT_LIMITS, { perWorkspace: 6, reviewers: 2, belowAdmins: 4, perReviewer: 1 });
  try {
    const [r1, r2, r3, m1, m2] = [
      await someone('rev-one', 'reviewer'),
      await someone('rev-two', 'reviewer'),
      await someone('rev-three', 'reviewer'),
      await someone('mem-one', 'member'),
      await someone('mem-two', 'member'),
    ];
    const open = [call(r1, 'wait_for_feedback', { timeout_s: 3 })];
    await sleep(300);
    // a reviewer holds fewer than a person who runs agents
    const second = await call(r1, 'wait_for_feedback', { timeout_s: 3 });
    assert.match(second.text, /a reviewer holds at most 1 wait/);
    open.push(call(r2, 'wait_for_feedback', { timeout_s: 3 }));
    await sleep(300);
    // the reviewers' share is taken: one more reviewer waits for later, people who run agents still wait
    const third = await call(r3, 'wait_for_feedback', { timeout_s: 3 });
    assert.equal(third.isError, true);
    assert.match(third.text, /reviewers in this workspace hold 2 waits open together/);
    open.push(call(m1, 'wait_for_feedback', { timeout_s: 3 }), call(m2, 'wait_for_feedback', { timeout_s: 3 }));
    await sleep(300);
    // members and reviewers together: the last places are the owners' and admins'
    const fifth = await call(m1, 'wait_for_feedback', { timeout_s: 3 });
    assert.match(fifth.text, /keeps its last 2 waits for its owners and admins/);
    open.push(wait('olivia', 3), wait('olivia', 3));
    await sleep(300);
    const done = await Promise.all(open);
    assert.ok(
      done.every((d) => !d.isError),
      done.map((d) => d.text).join('\n'),
    );
  } finally {
    Object.assign(WAIT_LIMITS, was);
  }
});

test('A12-D12: listens too: a workspace holds a bounded number, and its owners still listen when the rest are taken', async () => {
  const was = { ...LISTEN_LIMITS };
  Object.assign(LISTEN_LIMITS, { perWorkspace: 3, reviewers: 1, belowAdmins: 2, perReviewer: 1 });
  try {
    const [r1, r2, m1] = [await someone('lis-rev-one', 'reviewer'), await someone('lis-rev-two', 'reviewer'), await someone('lis-mem-one', 'member')];
    const subs = [await (await connect(r1)).listen({ resourceSubscriptions: ['vr://inbox'] })];
    await assert.rejects((await connect(r2)).listen({ resourceSubscriptions: ['vr://inbox'] }), 'the reviewers’ share');
    const member = await connect(m1);
    subs.push(await member.listen({ resourceSubscriptions: ['vr://inbox'] }));
    await assert.rejects(member.listen({ resourceSubscriptions: ['vr://inbox'] }), 'the owners’ and admins’ place');
    const owner = await connect(tokens.olivia as string);
    subs.push(await owner.listen({ resourceSubscriptions: ['vr://inbox'] }));
    await assert.rejects(owner.listen({ resourceSubscriptions: ['vr://inbox'] }), 'the workspace’s whole');
    for (const sub of subs) await sub.close();
  } finally {
    Object.assign(LISTEN_LIMITS, was);
  }
});
