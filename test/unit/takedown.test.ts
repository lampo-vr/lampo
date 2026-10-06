// A13 CLOUD-5, the app's side: the server's operator takes a workspace down. Suspended, everything in it is read-only
// for its people (their sessions, tokens and agents read on, nothing is written), its review links answer 410, its posts
// wait, and its people are told; lifted, all of it works again. Deleted — only once its name is typed —, everything it
// held is gone: its folders and every object under its storage prefix (Bunny here), its links, invites, API tokens and
// app connections, the accounts it leaves in no workspace, and its billing (the module hears it); the erasure log names
// it. Never the server's own workspace, and nobody but the operator (anyone else: no such page).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OperatorWorkspaceDetail, WorkspaceDeletionPlan } from '../../lib/types.ts';
import type { CloudModule } from '../../server/extension.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';
import { cookieFrom, type Reply, tusUpload } from '../lib/http.ts';
import { mockBunny } from '../lib/mockStores.ts';

const PUBLIC = 'http://review.test';
const bunny = await mockBunny();
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_STORAGE: 'bunny',
    VR_BUNNY_ZONE: 'zone',
    VR_BUNNY_ACCESS_KEY: 'secret',
    VR_BUNNY_STORAGE_URL: bunny.url,
  },
});
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const ext = await import('../../server/extension.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const { queued } = await import('../../lib/jobs.ts');

const { ctx, base, request } = await startApp({ headers: { Host: 'review.test' } });
after(async () => {
  ctx.mail.stop();
  for (let i = 0; i < 600 && queued() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await bunny.close();
});
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const OUTBOX = path.join(dir, 'cache', 'outbox');
async function signIn(email: string): Promise<Record<string, string>> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return { Cookie: cookieFrom(r), ...origin };
}
const mailsTo = async (address: string) => {
  await ctx.mail.flush();
  return readOutbox(OUTBOX).filter((m) => m.to === address);
};
const ok = (r: Reply, what: string) => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
  return r;
};

// The server's own workspace: Olivia owns it (she runs the server), Carol works there too.
await auth.createUser({ email: 'olivia@example.com', name: 'Olivia Hart', password: PASSWORD, role: 'owner' });
const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol Reyes', password: PASSWORD, role: 'member' });
ws.migrateWorkspaces();
// A customer's workspace: Bob owns it, Dan works in it, Carol too — Bob and Dan work nowhere else.
const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob Lane', password: PASSWORD, role: 'member' });
const B = ws.createWorkspace({ name: 'Kestrel Motion', ownerId: bob.id }).id;
if (ws.roleIn('w1', bob.id)) ws.removeMember('w1', bob.id);
const dan = await auth.createUser({ email: 'dan@example.com', name: 'Dan Moss', password: PASSWORD, role: 'member' });
ws.addMember(B, dan.id, 'member');
if (ws.roleIn('w1', dan.id)) ws.removeMember('w1', dan.id);
ws.addMember(B, carol.id, 'reviewer');

// A video in each workspace (their bytes in the bucket), a review link, an invite and an API token in B.
const oliviaToken = auth.createToken(auth.findUserByEmail('olivia@example.com')?.id as string, 'uploads').token;
const bobToken = auth.createToken(bob.id, 'agent', { workspace: B }).token;
const clip = makeVideo(path.join(dir, 'in/teaser.mp4'), { dur: 1 });
const inW1 = ok(await tusUpload(request, clip, { filename: 'house.mp4', folder: 'House' }, { Authorization: `Bearer ${oliviaToken}` }), 'w1 upload');
const inB = ok(await tusUpload(request, clip, { filename: 'teaser.mp4', folder: 'Spots' }, { Authorization: `Bearer ${bobToken}` }), 'B upload');
const slugB = inB.json().slug as string;
const ops = await signIn('olivia@example.com');
const bobC = await signIn('bob@example.com');
const danC = await signIn('dan@example.com');
const linkB = ok(
  await request('POST', `/api/review/${encodeURIComponent(slugB)}/shares`, { body: { label: 'For the client' }, headers: bobC }),
  'a link',
).json().token as string;
ok(await request('POST', '/api/admin/invites', { body: { role: 'member', email: 'eve@example.com' }, headers: bobC }), 'an invite');
await until(() => [...bunny.objects.keys()].some((k) => k.startsWith(`w/${B}/versions/`)), 'B’s render in the bucket');
const w1Keys = [...bunny.objects.keys()].filter((k) => !k.startsWith('w/'));
assert.ok(w1Keys.length, `w1’s render in the bucket (${inW1.json().slug})`);

// A billing module that hears the deletion (and nothing else matters here).
const heard: string[] = [];
const module: CloudModule = {
  name: 'test-billing',
  entitlements: {
    get: async () => null,
    canUpload: async () => ({ ok: true }),
    canAddMember: async () => ({ ok: true }),
    canAddVideo: async () => ({ ok: true }),
    canShare: async () => ({ ok: true }),
  },
  routes: [],
  workspaces: {
    deleted: async (e) => {
      heard.push(e.workspace);
    },
  },
};
ctx.extension = ext.createExtension(module, ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) }));

/** Dan's agent over MCP (his session's cookie), for one tool call. */
async function mcpCall(name: string, args: Record<string, unknown>) {
  const c = new Client({ name: 'takedown', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Host: 'review.test', ...danC } } }));
  try {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { error: !!r.isError, text: r.content.map((x) => x.text || '').join('\n') };
  } finally {
    await c.close();
  }
}
const note = (headers: Record<string, string>, text: string) =>
  request('POST', `/api/review/${encodeURIComponent(slugB)}/comments`, { body: { frame: 2, text }, headers });

test('only the operator takes a workspace down: anyone else meets no such page, and never the server’s own', async () => {
  for (const who of [bobC, danC])
    for (const [p, b] of [
      [`/api/operator/workspaces/${B}/suspend`, { reason: 'abuse' }],
      [`/api/operator/workspaces/${B}/delete`, { name: 'Kestrel Motion', reason: 'abuse' }],
    ] as const)
      assert.equal((await request('POST', p, { body: b, headers: who })).status, 404, p);
  assert.equal(
    (await request('POST', `/api/operator/workspaces/${B}/suspend`, { body: { reason: 'x' }, headers: { Authorization: `Bearer ${bobToken}` } })).status,
    403,
  );
  const own = await request('POST', '/api/operator/workspaces/w1/suspend', { body: { reason: 'oops' }, headers: ops });
  assert.equal(own.status, 409, own.text);
  assert.equal(
    (await request('POST', '/api/operator/workspaces/w1/delete', { body: { name: ws.getWorkspace('w1')?.name, reason: 'oops' }, headers: ops })).status,
    409,
  );
  assert.equal((await request('POST', `/api/operator/workspaces/${B}/suspend`, { body: { reason: 'two\nlines' }, headers: ops })).status, 400);
});

test('suspended: read-only for its people, its links stop, its agents write nothing, everyone is told; lifted: as before', async () => {
  ok(await note(bobC, 'before the takedown'), 'a note while it works');
  const r = ok(
    await request('POST', `/api/operator/workspaces/${B}/suspend`, { body: { reason: 'Abuse report 12: copyrighted films' }, headers: ops }),
    'suspended',
  );
  const detail = r.json() as OperatorWorkspaceDetail;
  assert.equal(detail.workspace.suspended?.reason, 'Abuse report 12: copyrighted films');
  assert.equal(detail.workspace.suspended?.by, 'Olivia Hart');
  // writes refused, for a session and a token alike; reading goes on
  const refused = await note(bobC, 'during the takedown');
  assert.equal(refused.status, 423, refused.text);
  assert.match(refused.json().error, /suspended/);
  assert.doesNotMatch(refused.text, /Abuse report/, 'never the operator’s reason');
  assert.equal((await note({ Authorization: `Bearer ${bobToken}` }, 'a token, during')).status, 423);
  assert.equal((await request('POST', '/api/admin/invites', { body: { role: 'member' }, headers: bobC })).status, 423, 'no new member');
  assert.equal((await request('PATCH', '/api/workspaces/current', { body: { name: 'Renamed' }, headers: bobC })).status, 423);
  assert.equal(
    (await request('POST', '/api/workspaces/current/delete', { body: { name: 'Kestrel Motion' }, headers: bobC })).status,
    423,
    'not even deleted by its owner',
  );
  ok(await request('GET', '/api/library', { headers: bobC }), 'the library reads');
  ok(await request('GET', `/api/review/${encodeURIComponent(slugB)}`, { headers: { Authorization: `Bearer ${bobToken}` } }), 'a token reads');
  // its people see it (a banner), and are told
  const status = (await request('GET', '/api/auth/status', { headers: danC })).json();
  assert.ok(status.workspace?.suspended, 'the session’s workspace says it is suspended');
  for (const who of ['bob@example.com', 'dan@example.com', 'carol@example.com']) {
    const got = await mailsTo(who);
    assert.ok(
      got.some((m) => m.kind === 'workspace-suspended' && /read-only/.test(m.subject) && !/Abuse report/.test(m.text)),
      `${who} is told (not why)`,
    );
  }
  // the review link answers like an ended one, its media too
  const link = await request('GET', `/api/g/${linkB}`);
  assert.equal(link.status, 410, link.text);
  assert.equal(link.json().expired, undefined, 'no date, no name: just ended');
  assert.equal((await request('GET', `/api/g/${linkB}/waveform`)).status, 410);
  // agents: a write tool answers why, reading works
  const wrote = await mcpCall('add_note', { video: slugB, frame: 2, text: 'an agent, during' });
  assert.ok(wrote.error, wrote.text);
  assert.match(wrote.text, /suspended/);
  const read = await mcpCall('get_open_notes', { video: slugB });
  assert.ok(!read.error, read.text);
  assert.match(read.text, /before the takedown/);

  ok(await request('POST', `/api/operator/workspaces/${B}/unsuspend`, { body: {}, headers: ops }), 'lifted');
  ok(await note(bobC, 'after the takedown'), 'writes again');
  ok(await request('GET', `/api/g/${linkB}`), 'the link opens again');
  assert.equal((await request('GET', '/api/auth/status', { headers: danC })).json().workspace?.suspended, undefined);
  assert.ok((await mailsTo('dan@example.com')).some((m) => m.kind === 'workspace-suspended' && /works again/.test(m.subject)));
});

test('deleted: only with its name typed, then everything it held is gone — files, objects, links, invites, tokens, accounts, billing', async () => {
  const plan = ok(await request('GET', `/api/operator/workspaces/${B}/deletion`, { headers: ops }), 'the plan').json() as WorkspaceDeletionPlan;
  assert.deepEqual(plan.members, { total: 3, accountsGone: 2 }, 'Bob and Dan work nowhere else');
  assert.equal(plan.videos, 1);
  assert.equal(plan.links, 1);
  assert.equal(plan.invites, 1);
  assert.ok(plan.tokens >= 1);
  assert.equal(plan.refused, undefined);
  const wrong = await request('POST', `/api/operator/workspaces/${B}/delete`, { body: { name: 'Kestrel', reason: 'Abuse report 12' }, headers: ops });
  assert.equal(wrong.status, 400, wrong.text);
  assert.ok(ws.getWorkspace(B), 'nothing happened');
  const root = ws.workspaceRoot(B);
  assert.ok(fs.existsSync(root.data));

  const done = ok(
    await request('POST', `/api/operator/workspaces/${B}/delete`, { body: { name: 'Kestrel Motion', reason: 'Abuse report 12' }, headers: ops }),
    'deleted',
  );
  assert.equal(done.json().accountsGone, 2);
  assert.equal(ws.getWorkspace(B), null, 'out of the registry');
  for (const d of [root.data, root.cache, root.versions]) assert.equal(fs.existsSync(d), false, `${path.relative(dir, d)} is gone`);
  assert.deepEqual(
    [...bunny.objects.keys()].filter((k) => k.startsWith(`w/${B}/`)),
    [],
    'every object under its prefix went through the storage adapter',
  );
  for (const k of w1Keys) assert.ok(bunny.objects.has(k), `the server’s own render stays (${k})`);
  // its links name nothing, its invites, tokens and accounts are gone; Carol works on in w1
  assert.equal((await request('GET', `/api/g/${linkB}`)).status, 404);
  const linksFile = path.join(dir, 'data', 'links.json');
  if (fs.existsSync(linksFile)) assert.doesNotMatch(fs.readFileSync(linksFile, 'utf8'), new RegExp(B));
  assert.doesNotMatch(fs.readFileSync(auth.INVITES_FILE, 'utf8'), new RegExp(B), 'no invite of it');
  assert.equal(auth.listTokens().filter((t) => t.workspace === B).length, 0);
  assert.equal((await request('GET', '/api/library', { headers: { Authorization: `Bearer ${bobToken}` } })).status, 401);
  assert.equal(auth.getUser(bob.id), null, 'Bob worked nowhere else');
  assert.equal(auth.getUser(dan.id), null, 'nor did Dan');
  assert.equal((await request('GET', '/api/auth/status', { headers: bobC })).json().user, null);
  assert.equal(ws.roleIn('w1', carol.id), 'member', 'Carol works on');
  // billing heard it; the erasure log names it and the accounts that went with it
  await until(() => heard.includes(B), 'the billing module heard it');
  const { listErasures } = await import('../../lib/erasure.ts');
  const log = listErasures();
  assert.ok(log.some((e) => e.kind === 'workspace' && e.id === B && e.by === 'operator'));
  for (const id of [bob.id, dan.id])
    assert.ok(
      log.some((e) => e.kind === 'account' && e.id === id),
      id,
    );
  // everyone is told; those whose account went with it, that it did
  assert.ok((await mailsTo('carol@example.com')).some((m) => m.kind === 'workspace-deleted' && /stay as they are/.test(m.text)));
  assert.ok((await mailsTo('dan@example.com')).some((m) => m.kind === 'workspace-deleted' && /your account went with it/.test(m.text)));
});
