// A13 PEOPLE-2: what of a person is left once their account goes (lib/erasure.ts afterAccountGone, from every way an
// account is removed: deleteUser, the sweep of sign-ups nobody confirmed). Bob uploads a picture, subscribes a phone,
// keeps a draft and an unsent recording (raw microphone audio), watches a video, puts a For-you item aside, connects an
// app — then Alice removes him, and his account goes. Nothing of his stays on the disk: no file names him, his address
// or his id (the erasure log keeps ids alone, for a restored backup; the test mail outbox is the test's own transport).
// His watching stays in the team's numbers under no name. Removed from one workspace while the account goes on, his
// drafts and recordings there go and the rest stay (afterMemberGone). Only his own things go: Alice's stay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';

// a speech engine that hears every recording: its words would stay on the disk with it
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'Bob says private words.',
        language: 'english',
        words: [{ word: 'Bob', start: 0.1, end: 0.3 }],
        segments: [{ text: 'Bob says private words.', start: 0.1, end: 0.9 }],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));

const { isolatedEnv, makeVideo, age, until, FFMPEG } = await import('../lib/helpers.ts');
const { tusUpload, cookieFrom } = await import('../lib/http.ts');
const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_ALLOW_HTTP: '1',
    VR_STT: 'http',
    VR_STT_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`,
  },
});
const { startApp } = await import('../lib/app.ts');
const t = await startApp({ headers: { Host: 'review.test' } });
after(() => {
  stt.close();
  t.ctx.mail.stop();
});
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const oauth = await import('../../lib/oauth/store.ts');
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };

/** Every file under `root` whose name or bytes hold `needle` (paths relative to the test's folder). */
function grep(root: string, needle: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(needle) || (fs.statSync(p).size < 20e6 && fs.readFileSync(p).includes(needle))) out.push(rel);
    }
  };
  walk(root);
  return out;
}
// The test's own mail transport (a production server's queue holds sealed messages and drops them once sent) and the
// erasure log (ids only, by design: a restored backup is held to it) — checked on their own below.
const notOurs = (rel: string) => rel.startsWith(path.join('cache', 'outbox')) || rel === path.join('data', 'erasures.jsonl');
const everywhere = (needle: string) => [...grep(path.join(dir, 'data'), needle, notOurs), ...grep(path.join(dir, 'cache'), needle, notOurs)];

const login = async (email: string) => {
  const r = await t.request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), ...origin };
};
/** A person's picture, phone, draft, unsent recording (heard), watching and For-you snooze on a video. */
async function leaveTraces(who: Record<string, string>, slug: string, words: string) {
  const still = path.join(dir, `in/${words.length}-face.png`);
  fs.mkdirSync(path.dirname(still), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', still]);
  const pic = await t.request('PUT', '/api/auth/me/avatar', { body: { data: fs.readFileSync(still).toString('base64') }, headers: who });
  assert.equal(pic.status, 200, pic.text);
  const sub = await t.request('POST', '/api/push/subscribe', {
    body: {
      subscription: {
        endpoint: `https://fcm.googleapis.com/fcm/send/${words.replace(/\W/g, '')}-endpoint`,
        keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
      },
      name: 'A phone',
    },
    headers: who,
  });
  assert.equal(sub.status, 200, sub.text);
  const draft = await t.request('POST', `/api/review/${slug}/drafts`, { body: { frame: 2, text: `${words} DRAFT` }, headers: who });
  assert.equal(draft.status, 200, draft.text);
  const rec = await t.request('POST', `/api/review/${slug}/recordings`, { body: { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 2 }] }, headers: who });
  assert.equal(rec.status, 200, rec.text);
  const recId = rec.json().id as string;
  const mic = fs.readFileSync(makeVideo(path.join(dir, `in/${recId}.mp4`), { w: 32, h: 32, fps: 5, dur: 1, freq: 330 }));
  const put = await t.request('PUT', `/api/review/${slug}/recordings/${recId}/audio`, { body: mic, headers: { ...who, 'content-type': 'audio/mp4' } });
  assert.ok(put.status < 300, put.text);
  await until(async () => {
    const l = (await t.request('GET', `/api/review/${slug}/recordings`, { headers: who })).json().recordings as { state: string }[];
    return l.length > 0 && l.every((x) => x.state === 'ready' || x.state === 'failed');
  }, 'the recording heard');
  const w = await t.request('POST', `/api/review/${slug}/watch`, { body: { v: 1, seen: 'f'.repeat(25), secs: 3 }, headers: who });
  assert.equal(w.status, 204, w.text);
  return { recId, avatar: pic.json().user.avatar as string };
}

const alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice Hart', password: PASSWORD, role: 'owner' });
const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob Example', password: PASSWORD, role: 'member' });
// the store moves to workspaces (as on Lampo Cloud): its backup of users.json holds Bob's address and password hash
const other = ws.createWorkspace({ name: 'Other', ownerId: alice.id });
assert.ok(
  fs.readdirSync(path.join(dir, 'data', 'backups')).some((n) => n.startsWith('workspaces-')),
  'the move made its backup',
);
const asAlice = await login('alice@example.com');
const asBob = await login('bob@example.com');
const clip = makeVideo(path.join(dir, 'in/clip.mp4'), { dur: 1 });
age(clip);
const slug = (await tusUpload(t.request, clip, { filename: 'clip.mp4', folder: 'P' }, asAlice)).json().slug as string;

test('a removed account leaves nothing of its person on the disk; the team keeps its numbers and its own things', async () => {
  const mine = await leaveTraces(asAlice, slug, 'ALICE KEEPS');
  const his = await leaveTraces(asBob, slug, 'BOB PRIVATE');
  // an app Bob connected (an OAuth grant, as the token endpoint makes it)
  const asked = oauth.createRequest({
    client: { client_id: 'probe', kind: 'dcr', name: 'Probe', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  oauth.redeemCode({
    code: oauth.createCode(asked, auth.getUser(bob.id) as NonNullable<ReturnType<typeof auth.getUser>>),
    client_id: 'probe',
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    resource: `${PUBLIC}/mcp`,
  });
  assert.equal(oauth.listApps(bob.id).length, 1);
  // a For-you item put aside
  const fy = (await t.request('GET', '/api/for-you', { headers: asBob })).json();
  const key = fy.items?.[0]?.key as string | undefined;
  if (key) assert.equal((await t.request('POST', '/api/for-you/dismiss', { body: { keys: [key] }, headers: asBob })).status, 200);
  assert.ok(everywhere(bob.id).length, 'before: his id is on the disk');

  // Alice removes him: he works nowhere else, so his account goes
  const del = await t.request('DELETE', `/api/admin/users/${bob.id}`, { headers: asAlice });
  assert.equal(del.status, 200, del.text);
  assert.equal(auth.getUser(bob.id), null);
  // the picture's removal waits on the storage: what is still being erased ends first (none before the fix: nothing is)
  await import('../../lib/erasure.ts').then(
    (m) => m.erasuresSettled(),
    () => {},
  );

  assert.deepEqual(everywhere(bob.id), [], 'no file holds his id');
  assert.deepEqual(everywhere('bob@example.com'), [], 'nor his address (the backup of the move included)');
  assert.deepEqual(everywhere('Bob Example'), [], 'nor his name');
  assert.deepEqual(everywhere('BOB PRIVATE'), [], 'nor his draft');
  assert.deepEqual(everywhere('BOBPRIVATE-endpoint'), [], 'nor his phone');
  assert.equal(fs.existsSync(path.join(dir, 'data', slug, 'recordings', `${his.recId}.m4a`)), false, 'his microphone audio is gone');
  assert.equal(fs.existsSync(path.join(dir, 'data', 'avatars', his.avatar)), false, 'his picture is gone');
  assert.equal(oauth.listApps(bob.id).length, 0);
  // the team: his watching in its numbers under no name; Alice's own things all stay
  const aud = (await t.request('GET', `/api/review/${slug}/audience`, { headers: asAlice })).json();
  assert.equal(aud.viewers.length, 2, 'two people watched');
  assert.ok(!aud.viewers.some((v: { name: string | null }) => v.name === 'Bob Example'));
  assert.ok(aud.viewers.some((v: { name: string | null }) => v.name === 'Alice Hart'));
  assert.ok(everywhere('ALICE KEEPS').length, 'Alice’s draft stays');
  assert.ok(fs.existsSync(path.join(dir, 'data', slug, 'recordings', `${mine.recId}.m4a`)), 'Alice’s recording stays');
  assert.ok(fs.existsSync(path.join(dir, 'data', 'avatars', mine.avatar)), 'Alice’s picture stays');
  // the erasure log: his id and nothing else of him
  const log = fs.readFileSync(path.join(dir, 'data', 'erasures.jsonl'), 'utf8');
  assert.match(log, new RegExp(bob.id));
  assert.doesNotMatch(log, /bob@example\.com|Bob Example/);
});

test('removed from one workspace while the account goes on: their drafts and recordings there go, the rest stays', async () => {
  const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol Reyes', password: PASSWORD, role: 'member' });
  if (!ws.roleIn('w1', carol.id)) ws.addMember('w1', carol.id, 'member');
  ws.addMember(other.id, carol.id, 'member');
  const inW1 = await login('carol@example.com');
  const sw = await t.request('POST', '/api/workspaces/switch', { body: { id: other.id }, headers: inW1 });
  const inOther = { Cookie: cookieFrom(sw), ...origin };
  const theirClip = makeVideo(path.join(dir, 'in/other.mp4'), { dur: 1 });
  age(theirClip);
  const otherSlug = (await tusUpload(t.request, theirClip, { filename: 'other.mp4', folder: 'O' }, inOther)).json().slug as string;
  for (const [h, s, words] of [
    [inW1, slug, 'CAROL IN W1'],
    [inOther, otherSlug, 'CAROL IN OTHER'],
  ] as const)
    assert.equal((await t.request('POST', `/api/review/${s}/drafts`, { body: { frame: 2, text: words }, headers: h })).status, 200);
  assert.equal(ws.removeMember(other.id, carol.id).account, false, 'the account goes on in w1');
  assert.deepEqual(grep(path.join(dir, 'data', 'w', other.id), 'CAROL IN OTHER'), [], 'her draft there is gone');
  assert.ok(everywhere('CAROL IN W1').length, 'her draft in w1 stays');
  assert.ok(auth.getUser(carol.id));
});

test('every way an account goes tells the erasure: the sweep of sign-ups nobody confirmed too', async () => {
  const gone: string[] = [];
  const off = auth.onAccountGone((u) => gone.push(u.id));
  try {
    const r = await auth.signUp({ email: 'held@example.com', name: 'Held', password: PASSWORD, mode: 'open', anyName: true });
    assert.ok('made' in r);
    assert.equal(auth.sweepUnconfirmed(7, Date.now() + 8 * 86400e3), 1);
    assert.deepEqual(gone, [r.made.id]);
  } finally {
    off();
  }
});
