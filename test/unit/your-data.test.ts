// A13 PEOPLE-1: a person's data in their own hands, and in the operator's (GDPR Art. 15, 17, 20). The operator's command
// first — `vr admin delete-account | delete-workspace | export-account` say what goes (a dry run) and with --yes do it —
// then Settings: export my data (a zip of my own: my notes and my replies, never anyone else's words), delete my account
// (my password, or a sign-in this moment; refused while I am the last owner of a workspace others work in), and delete
// my workspace (its owner, its name typed). Never with an API token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';
import { cookieFrom, type Reply, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir, env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_ALLOW_HTTP: '1' } });
const { ctx, port, request } = await startApp({ headers: { Host: 'review.test' } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };

/** A store-only zip's files by name (lib/zip.ts writes every size in the local headers when the CRCs are known). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    out.set(name, buf.subarray(start, start + size));
    at = start + size;
  }
  return out;
}
const jsonIn = (files: Map<string, Buffer>, name: string) => JSON.parse(String(files.get(name) ?? 'null'));
const login = async (email: string) => {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), ...origin };
};
const ok = (r: Reply, what: string) => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
  return r;
};
/** A GET's body as bytes (the zip): the test client reads text. */
const bytesOf = (url: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { Host: 'review.test', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
const sessionGone = (r: Reply) => [r.headers['set-cookie']].flat().some((c) => /vr_session=;/.test(String(c)));

// The server's own workspace: Alice owns it, Erin works there, Carol too. Bob owns "Bravo" with Carol in it; Dan
// signed up alone and owns "Delta".
await auth.createUser({ email: 'alice@example.com', name: 'Alice Hart', password: PASSWORD, role: 'owner' });
const erin = await auth.createUser({ email: 'erin@example.com', name: 'Erin Vale', password: PASSWORD, role: 'member' });
const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol Reyes', password: PASSWORD, role: 'member' });
ws.migrateWorkspaces();
const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob Lane', password: PASSWORD, role: 'member' });
const B = ws.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
if (ws.roleIn('w1', bob.id)) ws.removeMember('w1', bob.id);
ws.addMember(B, carol.id, 'member');
const dan = await auth.createUser({ email: 'dan@example.com', name: 'Dan Moss', password: PASSWORD, role: 'member' });
const D = ws.createWorkspace({ name: 'Delta', ownerId: dan.id }).id;
if (ws.roleIn('w1', dan.id)) ws.removeMember('w1', dan.id);

const asBob = await login('bob@example.com');
const clip = makeVideo(path.join(dir, 'in/spot.mp4'), { dur: 1 });
age(clip);
const slug = ok(await tusUpload(request, clip, { filename: 'spot.mp4', folder: 'Spots' }, asBob), 'upload').json().slug as string;
const sw = await request('POST', '/api/workspaces/switch', { body: { id: B }, headers: await login('carol@example.com') });
const carolInB = { Cookie: cookieFrom(sw), ...origin };
const bobsNote = (await request('POST', `/api/review/${slug}/comments`, { body: { frame: 2, text: 'BOB WROTE THIS' }, headers: asBob })).json();
const carolsNote = (await request('POST', `/api/review/${slug}/comments`, { body: { frame: 3, text: 'CAROL WROTE THIS' }, headers: carolInB })).json();
const reply = (id: string, h: Record<string, string>, text: string) => request('PATCH', `/api/comments/${id}`, { body: { note: text }, headers: h });
ok(await reply(bobsNote.id, carolInB, 'CAROL REPLIED TO BOB'), 'Carol replies to Bob');
ok(await reply(carolsNote.id, asBob, 'BOB REPLIED TO CAROL'), 'Bob replies to Carol');
ok(await request('POST', `/api/review/${slug}/drafts`, { body: { frame: 4, text: 'BOB KEPT THIS' }, headers: asBob }), 'a draft');
const bobToken = auth.createToken(bob.id, 'agent', { workspace: B }).token;

test('vr admin: delete-account and delete-workspace say what goes and do nothing without --yes; export-account writes a zip', () => {
  const plan = vr(['admin', 'delete-account', 'bob@example.com'], env);
  assert.equal(plan.code, 1, plan.out);
  assert.match(plan.out, /workspaces it leaves: none/);
  assert.match(plan.err, /last owner of .*Bravo.*where others work/);
  const dry = vr(['admin', 'delete-workspace', D], env);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /1 members; 1 of them work nowhere else/);
  assert.match(dry.out, /nothing deleted \(a dry run\)/);
  assert.ok(ws.getWorkspace(D), 'still there');
  assert.equal(vr(['admin', 'delete-workspace', 'w1', '--yes'], env).code, 1, 'never the server’s own');
  const out = path.join(dir, 'bob-export.zip');
  const ex = vr(['admin', 'export-account', 'bob@example.com', '--out', out], env);
  assert.equal(ex.code, 0, ex.err);
  const files = unzip(fs.readFileSync(out));
  assert.equal(jsonIn(files, 'profile.json').email, 'bob@example.com');
  assert.equal(vr(['admin', 'export-account', 'bob@example.com', '--out', out], env).code, 1, 'never over a file that is there');
});

test('Export my data: my profile, my notes and replies, my drafts — never anyone else’s words, never a token', async () => {
  assert.equal((await request('GET', '/api/auth/me/export', { headers: { Authorization: `Bearer ${bobToken}` } })).status, 403, 'not with a token');
  const r = await bytesOf('/api/auth/me/export', asBob);
  assert.equal(r.status, 200, String(r.body));
  assert.equal(r.headers['content-type'], 'application/zip');
  assert.match(String(r.headers['content-disposition']), /attachment; filename="lampo-data-\d{4}-\d{2}-\d{2}\.zip"/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const files = unzip(r.body);
  assert.ok(files.has('README.txt'));
  const profile = jsonIn(files, 'profile.json');
  assert.equal(profile.email, 'bob@example.com');
  assert.equal(profile.password, undefined);
  const notes = jsonIn(files, `workspaces/${B}/notes.json`);
  assert.deepEqual(
    notes.map((n: { text: string }) => n.text),
    ['BOB WROTE THIS'],
  );
  assert.deepEqual(notes[0].replies, [], 'Carol’s reply on his note is hers');
  const replies = jsonIn(files, `workspaces/${B}/replies.json`);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'BOB REPLIED TO CAROL');
  assert.equal(replies[0].note, carolsNote.id, 'the note it answers, by id');
  assert.deepEqual(
    jsonIn(files, `workspaces/${B}/drafts.json`).map((d: { text: string }) => d.text),
    ['BOB KEPT THIS'],
  );
  assert.equal(jsonIn(files, `workspaces/${B}/uploads.json`).length, 1, 'what he uploaded');
  const everything = [...files.values()].map(String).join('\n');
  assert.doesNotMatch(everything, /CAROL WROTE THIS|CAROL REPLIED TO BOB/, 'never anyone else’s words');
  assert.doesNotMatch(everything, new RegExp(bobToken.slice(0, 16)), 'never a token');
  assert.deepEqual(
    jsonIn(files, 'workspaces.json').map((w: { id: string; role: string }) => [w.id, w.role]),
    [[B, 'owner']],
  );
});

test('Delete my account: refused while I am the last owner where others work; my password; then everything of mine goes', async () => {
  const plan = ok(await request('GET', '/api/auth/me/deletion', { headers: asBob }), 'the plan').json();
  assert.deepEqual(
    plan.blockedBy.map((w: { id: string }) => w.id),
    [B],
  );
  const blocked = await request('POST', '/api/auth/me/delete', { body: { password: PASSWORD }, headers: asBob });
  assert.equal(blocked.status, 409, blocked.text);
  assert.match(blocked.json().error, /hand over or delete .*Bravo/);
  assert.ok(auth.getUser(bob.id));

  const asDan = await login('dan@example.com');
  const danPlan = ok(await request('GET', '/api/auth/me/deletion', { headers: asDan }), 'Dan’s plan').json();
  assert.deepEqual(
    danPlan.goWith.map((w: { id: string }) => w.id),
    [D],
  );
  assert.equal(
    (
      await request('POST', '/api/auth/me/delete', {
        body: { password: PASSWORD },
        headers: { Authorization: `Bearer ${auth.createToken(dan.id, 't', { workspace: D }).token}` },
      })
    ).status,
    403,
  );
  const wrong = await request('POST', '/api/auth/me/delete', { body: { password: 'not my password' }, headers: asDan });
  assert.equal(wrong.status, 403, wrong.text);
  const gone = ok(await request('POST', '/api/auth/me/delete', { body: { password: PASSWORD }, headers: asDan }), 'Dan deletes his account');
  assert.ok(sessionGone(gone), 'the session is cleared');
  assert.equal(gone.headers['clear-site-data'], '"cache", "storage"');
  assert.equal(auth.getUser(dan.id), null);
  assert.equal(ws.getWorkspace(D), null, 'his own workspace went with it');
  assert.equal(fs.existsSync(ws.workspaceRoot(D).data), false);
  await ctx.mail.flush();
  assert.ok(readOutbox(path.join(dir, 'cache', 'outbox')).some((m) => m.to === 'dan@example.com' && m.kind === 'account-deleted'));

  // A sign-in this moment stands for the password; Erin leaves w1 and her account goes
  const asErin = await login('erin@example.com');
  const stray = await request('POST', '/api/auth/me/delete', { body: {}, headers: asErin });
  assert.equal(stray.status, 400, 'never an empty body, however fresh the sign-in');
  assert.ok(auth.getUser(erin.id));
  ok(await request('POST', '/api/auth/me/delete', { body: { confirm: true }, headers: asErin }), 'Erin, just signed in');
  assert.equal(auth.getUser(erin.id), null);
  assert.ok(ws.getWorkspace('w1'), 'w1 stays');
});

test('Delete workspace: its owner, its name typed; members elsewhere stay, an owner who worked nowhere else goes with it', async () => {
  assert.equal((await request('GET', '/api/workspaces/current/deletion', { headers: carolInB })).status, 403, 'a member can’t');
  const plan = ok(await request('GET', '/api/workspaces/current/deletion', { headers: asBob }), 'the plan').json();
  assert.equal(plan.videos, 1);
  assert.deepEqual(plan.members, { total: 2, accountsGone: 1 });
  assert.equal(
    (await request('POST', '/api/workspaces/current/delete', { body: { name: 'Bravo' }, headers: { Authorization: `Bearer ${bobToken}` } })).status,
    403,
  );
  const wrong = await request('POST', '/api/workspaces/current/delete', { body: { name: 'bravo' }, headers: asBob });
  assert.equal(wrong.status, 400, wrong.text);
  const done = ok(await request('POST', '/api/workspaces/current/delete', { body: { name: 'Bravo' }, headers: asBob }), 'deleted');
  assert.equal(done.json().account, true, 'Bob worked nowhere else');
  assert.ok(sessionGone(done));
  assert.equal(ws.getWorkspace(B), null);
  assert.equal(auth.getUser(bob.id), null);
  assert.ok(auth.getUser(carol.id), 'Carol works on in w1');
  assert.equal(ws.roleIn('w1', carol.id), 'member');
  ctx.mail.stop();
});
