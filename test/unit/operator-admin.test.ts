// The operator's admin (server/routes/operator.ts, lib/operator.ts): every workspace with its owner, members, videos,
// storage and last activity, and its plan when a billing module runs (set by hand: complimentary, a trial's date, back
// to normal — logged with who, when, what and why); every account with its workspaces and roles, when it was last active
// (its last sign-in, or its session in use: stamped at most hourly, never by a review link or an API token), and
// Disable / Enable, which end and give back access. Only the server's operator gets an answer: LAMPO_OPERATOR when set,
// else the owners of the first workspace. An admin or member there, another workspace's owner, an API token, the app on
// a person's own machine and a stranger are all answered as if there were no such page — the same for ids that exist
// and ids that don't. No answer carries a password hash or a token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import type { OperatorAccount, OperatorAccounts, OperatorWorkspace, OperatorWorkspaceDetail, OperatorWorkspaces, PlanLogEntry } from '../../lib/types.ts';
import type { CloudModule } from '../../server/extension.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const ext = await import('../../server/extension.ts');
const { operatorList, OPERATORS_MAX } = await import('../../lib/config.ts');
const { isOperator, unknownOperators } = await import('../../lib/operator.ts');
const { readEvents } = await import('../../lib/store.ts');
const { inWorkspace } = await import('../../lib/scope.ts');
const shares = await import('../../lib/shares.ts');

const { ctx, request } = await startApp({ headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const as = (cookie: string) => ({ headers: { Cookie: cookie, ...origin } });
async function signIn(email: string, password = PASSWORD): Promise<string> {
  const r = await request('POST', '/api/auth/login', { body: { email, password }, headers: origin });
  assert.equal(r.status, 200, r.text);
  return cookieFrom(r);
}

// Workspace #1, the operator's own: Olivia owns it, Ada administers, Max is a member.
const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia Hart', password: PASSWORD, role: 'owner' });
await auth.createUser({ email: 'ada@example.com', name: 'Ada Brooks', password: PASSWORD, role: 'admin' });
await auth.createUser({ email: 'max@example.com', name: 'Max Field', password: PASSWORD, role: 'member' });
ws.migrateWorkspaces();
// A customer's workspace: Lee owns it, Mia works in it.
const lee = await auth.createUser({ email: 'lee@example.com', name: 'Lee Quinn', password: PASSWORD, role: 'member' });
const B = ws.createWorkspace({ name: 'Kestrel Motion', ownerId: lee.id }).id;
if (ws.roleIn('w1', lee.id)) ws.removeMember('w1', lee.id);
const mia = await auth.createUser({ email: 'mia@example.com', name: 'Mia Stone', password: PASSWORD, role: 'member' });
ws.addMember(B, mia.id, 'member');
if (ws.roleIn('w1', mia.id)) ws.removeMember('w1', mia.id);
// a video in B (its version's bytes and its event: the list's storage and last activity)
const leeToken = auth.createToken(lee.id, 'uploads', { workspace: B }).token;
const up = await tusUpload(
  request,
  makeVideo(path.join(dir, 'in/teaser.mp4'), { dur: 1 }),
  { filename: 'teaser.mp4', folder: 'Spots' },
  {
    Authorization: `Bearer ${leeToken}`,
  },
);
assert.equal(up.status, 200, up.text);

const ops = await signIn('olivia@example.com');
const adaC = await signIn('ada@example.com');
const maxC = await signIn('max@example.com');
const leeC = await signIn('lee@example.com');

const READS = (b: string, account: string) => [
  ['GET', '/api/operator/funnel'],
  ['GET', '/api/operator/workspaces'],
  ['GET', `/api/operator/workspaces/${b}`],
  ['GET', '/api/operator/accounts'],
  ['GET', `/api/operator/accounts/${account}`],
];
const WRITES = (b: string, account: string): [string, string, object][] => [
  ['POST', `/api/operator/workspaces/${b}/plan`, { kind: 'complimentary', plan: 'team', reason: 'Partner' }],
  ['POST', `/api/operator/accounts/${account}/disable`, {}],
  ['POST', `/api/operator/accounts/${account}/enable`, {}],
];

test('the operator reads every workspace: owner, members, videos, storage, last activity — no plans without a module', async () => {
  const r = await request('GET', '/api/operator/workspaces', as(ops));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['cache-control'], 'no-store');
  const out = r.json() as OperatorWorkspaces;
  assert.equal(out.plans, false);
  const byId = Object.fromEntries(out.workspaces.map((w) => [w.id, w])) as Record<string, OperatorWorkspace>;
  assert.deepEqual(Object.keys(byId).sort(), ['w1', B].sort());
  const k = byId[B] as OperatorWorkspace;
  assert.equal(k.name, 'Kestrel Motion');
  assert.deepEqual(k.owner, { id: lee.id, name: 'Lee Quinn', email: 'lee@example.com' });
  assert.equal(k.members, 2);
  assert.equal(k.videos, 1);
  assert.ok(k.bytes > 1000, `${k.bytes} bytes`);
  const newest = inWorkspace(B, () => readEvents({ limit: 1 })).at(-1)?.at;
  assert.ok(newest);
  assert.equal(k.active, newest, 'its log’s newest event');
  assert.equal(k.plan, undefined);
  assert.equal(byId.w1?.owner?.id, olivia.id);
  assert.equal(byId.w1?.members, 3);
  assert.equal(byId.w1?.active, null, 'nothing happened there yet');
});

test('a workspace opened: its facts and its members with name, email and role; no plans to set without a module', async () => {
  const r = await request('GET', `/api/operator/workspaces/${B}`, as(ops));
  assert.equal(r.status, 200, r.text);
  const d = r.json() as OperatorWorkspaceDetail;
  assert.equal(d.workspace.id, B);
  assert.equal(d.plans, false);
  assert.deepEqual(d.log, []);
  assert.deepEqual(
    d.members.map((m) => [m.name, m.email, m.role]),
    [
      ['Lee Quinn', 'lee@example.com', 'owner'],
      ['Mia Stone', 'mia@example.com', 'member'],
    ],
  );
  const set = await request('POST', `/api/operator/workspaces/${B}/plan`, { body: { kind: 'normal', reason: 'x' }, ...as(ops) });
  assert.equal(set.status, 409, set.text);
  assert.equal((await request('GET', '/api/operator/workspaces/w_000000000000', as(ops))).status, 404);
  assert.equal((await request('GET', '/api/operator/workspaces/nope', as(ops))).status, 400);
});

test('every account: name, email, workspaces and roles, created, last sign-in, disabled; one opened', async () => {
  const r = await request('GET', '/api/operator/accounts', as(ops));
  assert.equal(r.status, 200, r.text);
  const { accounts } = r.json() as OperatorAccounts;
  assert.equal(accounts.length, 5);
  const by = Object.fromEntries(accounts.map((a) => [a.email, a])) as Record<string, OperatorAccount>;
  assert.deepEqual(by['lee@example.com']?.workspaces, [{ id: B, name: 'Kestrel Motion', role: 'owner' }]);
  assert.deepEqual(
    by['olivia@example.com']?.workspaces.map((w) => [w.id, w.role]),
    [['w1', 'owner']],
  );
  assert.equal(by['olivia@example.com']?.you, true);
  assert.equal(by['olivia@example.com']?.operator, true);
  assert.equal(by['ada@example.com']?.operator, undefined, 'an admin of #1 runs nothing');
  assert.ok(by['lee@example.com']?.signedIn, 'signed in above');
  assert.equal(by['mia@example.com']?.signedIn, null, 'never signed in');
  assert.equal(by['mia@example.com']?.disabled, null);
  assert.ok(by['mia@example.com']?.created);
  const one = await request('GET', `/api/operator/accounts/${mia.id}`, as(ops));
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json().account.email, 'mia@example.com');
  assert.equal((await request('GET', '/api/operator/accounts/u_000000000000', as(ops))).status, 404);
});

test('last sign-in: a new session, and `vr login` making a token', async () => {
  const before = auth.getUser(mia.id)?.signed_in;
  assert.equal(before, undefined);
  const t = await request('POST', '/api/auth/token', { body: { email: 'mia@example.com', password: PASSWORD, name: 'laptop' }, headers: origin });
  assert.equal(t.status, 200, t.text);
  const after = auth.getUser(mia.id)?.signed_in;
  assert.ok(after && Date.parse(after) > Date.now() - 60_000, after);
  // it never shows anywhere else: the account's own answers leave it out
  const me = await request('GET', '/api/auth/me', as(await signIn('mia@example.com')));
  assert.equal(me.status, 200, me.text);
  assert.doesNotMatch(me.text, /signed_in/);
});

test('last active: a request through the session stamps `seen`, once an hour; a review link and an API token never; only the operator reads it', async () => {
  const fileKey = () => {
    const st = fs.statSync(auth.USERS_FILE);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  };
  const listed = async (id: string) =>
    ((await request('GET', '/api/operator/accounts', as(ops))).json() as OperatorAccounts).accounts.find((a) => a.id === id) as OperatorAccount;
  // the operator's own requests began it (the first `seen`), so an account made after it that never signed in: "never"
  assert.ok((await listed(olivia.id)).lastActive);
  assert.ok(auth.seenSince());
  const kim = await auth.createUser({ email: 'kim@example.com', name: 'Kim Reed', password: PASSWORD, role: 'member' });
  ws.addMember(B, kim.id, 'member');
  const fresh = await listed(kim.id);
  assert.deepEqual([fresh.lastActive, fresh.signedIn, fresh.neverSignedIn], [null, null, true]);
  // an account from before it was kept, with nothing recorded, is no "never": it may have signed in unrecorded
  const old = await auth.createUser({ email: 'old@example.com', name: 'Old Timer', password: PASSWORD, role: 'member' });
  const raw = JSON.parse(fs.readFileSync(auth.USERS_FILE, 'utf8'));
  raw.users.find((u: { id: string }) => u.id === old.id).created = '2026-01-05T09:00:00+00:00';
  fs.writeFileSync(auth.USERS_FILE, JSON.stringify(raw, null, 2));
  const before = await listed(old.id);
  assert.deepEqual([before.lastActive, before.neverSignedIn], [null, undefined]);

  // an agent at work with the person's API token: no stamp
  const token = { headers: { Authorization: `Bearer ${auth.createToken(kim.id, 'agent', { workspace: B }).token}` } };
  assert.equal((await request('GET', '/api/library', token)).status, 200);
  assert.equal(auth.getUser(kim.id)?.seen, undefined, 'an API token stamps nothing');
  // signing in stamps signed_in (the request that signs in carries no session yet)
  const kimC = await signIn('kim@example.com');
  assert.equal(auth.getUser(kim.id)?.seen, undefined);
  assert.ok(auth.getUser(kim.id)?.signed_in);
  // the person opening a review link of their own workspace, session cookie and all: no stamp either
  const link = inWorkspace(B, () => shares.createShare({ folder: 'Spots' }, { label: 'Client' }));
  const guest = await request('GET', `/api/g/${link.token}`, as(kimC));
  assert.equal(guest.status, 200, guest.text);
  // a visit asks who is visiting (the team's own aren't counted): still no stamp
  const visit = await request('POST', `/api/g/${link.token}/visit`, { body: { name: 'Kim' }, ...as(kimC) });
  assert.equal(visit.status, 200, visit.text);
  assert.equal(auth.getUser(kim.id)?.seen, undefined, 'a review link stamps nothing');

  // the first request through the session stamps it; another within the hour writes nothing
  assert.equal((await request('GET', '/api/auth/me', as(kimC))).status, 200);
  const seen = auth.getUser(kim.id)?.seen;
  assert.ok(seen && Math.abs(Date.parse(seen) - Date.now()) < 60_000, seen);
  const written = fileKey();
  const me = await request('GET', '/api/auth/me', as(kimC));
  assert.equal(me.status, 200);
  assert.equal(fileKey(), written, 'users.json not written again within the hour');
  assert.equal(auth.getUser(kim.id)?.seen, seen);
  // an hour on, the next one writes again
  assert.equal(auth.noteSeen(kim.id, Date.now() + auth.SEEN_EVERY.ms + 1000), true);
  assert.notEqual(auth.getUser(kim.id)?.seen, seen);

  // the operator's answer: the later of the two, `signedIn` as before; nothing of it leaves anywhere else
  const now = await listed(kim.id);
  assert.equal(now.lastActive, auth.lastActive(auth.getUser(kim.id) as User));
  assert.equal(now.lastActive, auth.getUser(kim.id)?.seen, 'the later one');
  assert.equal(now.signedIn, auth.getUser(kim.id)?.signed_in);
  assert.equal(now.neverSignedIn, undefined);
  assert.equal(auth.lastActive({ seen: '2026-10-01T10:00:00+02:00', signed_in: '2026-10-01T09:30:00Z' }), '2026-10-01T09:30:00Z', 'times, not text');
  assert.equal(auth.lastActive({}), null);
  assert.equal('seen' in auth.publicUser(auth.getUser(kim.id) as User), false, 'publicUser leaves it out');
  assert.equal('signed_in' in auth.publicUser(auth.getUser(kim.id) as User), false);
  assert.equal(me.json().user?.seen, undefined, 'the account’s own answer leaves it out');
  const members = await request('GET', '/api/admin/users', as(leeC));
  assert.equal(members.status, 200, members.text);
  assert.match(members.text, /kim@example\.com/);
  assert.doesNotMatch(members.text, /"seen"|signed_in/, 'and the workspace’s people list');
});

test('nobody else: an admin and a member of #1, another workspace’s owner, a token, signed out — the same for ids that exist and those that don’t', async () => {
  const opsToken = { headers: { Authorization: `Bearer ${auth.createToken(olivia.id, 'script').token}` } };
  const callers: [string, { headers: Record<string, string> }, number][] = [
    ['an admin of #1', as(adaC), 404],
    ['a member of #1', as(maxC), 404],
    ['another workspace’s owner', as(leeC), 404],
    ['the operator’s own API token', opsToken, 403],
    ['signed out', { headers: origin }, 401],
  ];
  for (const [who, h, status] of callers)
    for (const [b, account] of [
      [B, mia.id],
      ['w_000000000000', 'u_000000000000'],
      ['not-an-id', 'x%20y'],
    ] as const) {
      for (const [method, url] of READS(b, account)) {
        const r = await request(method, url, h);
        assert.equal(r.status, status, `${who}: ${method} ${url} → ${r.status} ${r.text}`);
        assert.doesNotMatch(r.text, /Kestrel|mia@|Mia Stone/, `${who}: ${url} names nothing`);
        if (status === 403) assert.equal(r.json().person, true);
      }
      for (const [method, url, b2] of WRITES(b, account)) {
        const r = await request(method, url, { ...h, body: b2 });
        assert.equal(r.status, status, `${who}: ${method} ${url} → ${r.status} ${r.text}`);
      }
    }
  assert.equal(auth.getUser(mia.id)?.disabled, undefined, 'nothing was disabled');
  // and the account menu offers the operator pages to the operator alone
  assert.equal((await request('GET', '/api/auth/status', as(ops))).json().operator, true);
  for (const c of [adaC, maxC, leeC]) assert.equal((await request('GET', '/api/auth/status', as(c))).json().operator, undefined);
  assert.equal((await request('GET', '/api/auth/status', opsToken)).json().operator, undefined, 'never to a token');
});

test('LAMPO_OPERATOR: only the accounts it names (by address or id); an owner of #1 not on it is refused', async () => {
  try {
    ctx.cfg.operators = operatorList('LEE@example.com, nobody@example.com');
    assert.equal((await request('GET', '/api/operator/workspaces', as(leeC))).status, 200, 'listed by address, owner of another workspace');
    assert.equal((await request('GET', '/api/auth/status', as(leeC))).json().operator, true);
    assert.equal((await request('GET', '/api/operator/workspaces', as(ops))).status, 404, 'an owner of #1 not on the list');
    assert.equal((await request('GET', '/api/operator/funnel', as(ops))).status, 404, 'the funnel too');
    assert.equal((await request('GET', '/api/auth/status', as(ops))).json().operator, undefined);
    ctx.cfg.operators = operatorList(auth.findUserByEmail('ada@example.com')?.id);
    assert.equal((await request('GET', '/api/operator/accounts', as(adaC))).status, 200, 'listed by id');
    assert.equal((await request('GET', '/api/operator/accounts', as(leeC))).status, 404);
  } finally {
    ctx.cfg.operators = [];
  }
  assert.equal((await request('GET', '/api/operator/accounts', as(ops))).status, 200, 'unset: the owners of #1 again');
});

test('LAMPO_OPERATOR read: separated by commas or spaces, lower case, bounded; unknown entries are said at start', async () => {
  assert.deepEqual(operatorList(' A@Example.com,b@example.com  u_0a1b2c3d4e5f;a@example.com '), ['a@example.com', 'b@example.com', 'u_0a1b2c3d4e5f']);
  assert.deepEqual(operatorList(undefined), []);
  assert.equal(operatorList(Array.from({ length: 50 }, (_, i) => `p${i}@example.com`).join(',')).length, OPERATORS_MAX);
  assert.deepEqual(operatorList(`${'x'.repeat(300)}@example.com`), [], 'longer than an address');
  const cfg = { mode: 'server' as const, operators: ['lee@example.com', 'ghost@example.com', olivia.id] };
  assert.deepEqual(unknownOperators(cfg, auth.listUsers()), ['ghost@example.com']);
  // a sign-up waiting for its link is anyone who typed the address
  const held = await auth.signUp({ email: 'ghost@example.com', name: 'Ghost', password: PASSWORD, mode: 'open', anyName: true });
  assert.ok('made' in held);
  assert.equal(isOperator(cfg, 'made' in held ? held.made.id : ''), false);
  assert.deepEqual(unknownOperators(cfg, auth.listUsers()), ['ghost@example.com']);
  assert.equal(isOperator({ mode: 'local', operators: [] }, olivia.id), false, 'never on a person’s own machine');
});

test('plans by hand through the module: an override changes what the workspace may do, and its log says who, when, what, why', async () => {
  // A stand-in for Lampo Cloud: Free refuses a second member; an override held in memory, logged.
  const overrides = new Map<string, { kind: 'complimentary'; plan: 'solo' | 'team' | 'business' } | { kind: 'trial'; until: string }>();
  const logs = new Map<string, PlanLogEntry[]>();
  let broken = false;
  const module: CloudModule = {
    name: 'stand-in',
    routes: [],
    workspaces: {},
    entitlements: {
      get: async (w) => ({ complimentary: overrides.get(w)?.kind === 'complimentary' }),
      canUpload: async () => ({ ok: true }),
      canAddVideo: async () => ({ ok: true }),
      canShare: async () => ({ ok: true }),
      canAddMember: async (w) =>
        w === 'w1' || overrides.has(w) ? { ok: true } : { ok: false, reason: 'members', message: 'Free is for one person.', upgrade: 'team' },
    },
    operator: {
      plans: async (list) =>
        Object.fromEntries(
          list.map(({ workspace: w, usage }) => {
            const o = overrides.get(w);
            if (broken && w === B) return [w, { plan: 'team', state: 'weird', storage: 'lots' }];
            return [
              w,
              w === 'w1'
                ? { plan: 'business', name: 'Business', state: 'complimentary', storage: null, fixed: 'own' }
                : o?.kind === 'complimentary'
                  ? {
                      plan: o.plan,
                      name: 'Team',
                      state: 'complimentary',
                      storage: null,
                      override: { ...o, at: '2026-10-06T10:00:00Z', by: { account: 'x', name: 'x' }, reason: 'x' },
                    }
                  : {
                      plan: 'free',
                      name: 'Free',
                      state: usage.members > 1 ? 'read-only' : 'active',
                      reason: usage.members > 1 ? 'over-limit' : undefined,
                      storage: 10e9,
                    },
            ];
          }),
        ),
      log: async (w) => [...(logs.get(w) ?? [])].reverse(),
      set: async (w, change, by, reason) => {
        if (w === 'w1') return { ok: false, reason: 'fixed', message: 'This is the server’s own workspace: it is always complimentary.' };
        if (change.kind === 'normal') overrides.delete(w);
        else overrides.set(w, change);
        logs.set(w, [...(logs.get(w) ?? []), { at: new Date().toISOString(), by, change, reason }]);
        return { ok: true };
      },
    },
  };
  const before = ctx.extension;
  ctx.extension = ext.createExtension(module, ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) }));
  try {
    const list = (await request('GET', '/api/operator/workspaces', as(ops))).json() as OperatorWorkspaces;
    assert.equal(list.plans, true);
    const k = list.workspaces.find((w) => w.id === B);
    assert.equal(k?.plan?.state, 'read-only');
    assert.equal(k?.plan?.name, 'Free');
    assert.equal(list.workspaces.find((w) => w.id === 'w1')?.plan?.fixed, 'own');
    // the workspace can't take a member now
    const invite = () => request('POST', '/api/admin/invites', { body: { role: 'member' }, ...as(leeC) });
    assert.equal((await invite()).status, 402);
    // complimentary on Team, with a reason
    const set = await request('POST', `/api/operator/workspaces/${B}/plan`, {
      body: { kind: 'complimentary', plan: 'team', reason: '  Launch partner, agreed by mail ' },
      ...as(ops),
    });
    assert.equal(set.status, 200, set.text);
    const d = set.json() as OperatorWorkspaceDetail;
    assert.equal(d.workspace.plan?.state, 'complimentary');
    assert.equal(d.log.length, 1);
    assert.deepEqual(d.log[0]?.by, { account: olivia.id, name: 'Olivia Hart', email: 'olivia@example.com' }, 'who');
    assert.deepEqual(d.log[0]?.change, { kind: 'complimentary', plan: 'team' }, 'what');
    assert.equal(d.log[0]?.reason, 'Launch partner, agreed by mail', 'why');
    assert.ok(Date.now() - Date.parse(d.log[0]?.at ?? '') < 60_000, 'when');
    assert.equal((await invite()).status, 200, 'the override changed what the workspace may do');
    // the trial to a day: it runs to that day's end (UTC)
    const trial = await request('POST', `/api/operator/workspaces/${B}/plan`, { body: { kind: 'trial', until: '2027-01-31', reason: 'Pilot' }, ...as(ops) });
    assert.equal(trial.status, 200, trial.text);
    assert.deepEqual(overrides.get(B), { kind: 'trial', until: '2027-01-31T23:59:59.999Z' });
    const normal = await request('POST', `/api/operator/workspaces/${B}/plan`, { body: { kind: 'normal', reason: 'Pilot over' }, ...as(ops) });
    assert.equal(normal.status, 200, normal.text);
    assert.deepEqual(
      (normal.json() as OperatorWorkspaceDetail).log.map((l) => l.change.kind),
      ['normal', 'trial', 'complimentary'],
      'newest first',
    );
    assert.equal((await invite()).status, 402, 'billed as usual again');
    // the module's refusal, said back
    const fixed = await request('POST', '/api/operator/workspaces/w1/plan', { body: { kind: 'normal', reason: 'x' }, ...as(ops) });
    assert.equal(fixed.status, 409);
    assert.equal(fixed.json().reason, 'fixed');
    // what the operator sends is checked first
    for (const bad of [
      { kind: 'complimentary', plan: 'team', reason: 'two\nlines' },
      { kind: 'complimentary', plan: 'team', reason: '   ' },
      { kind: 'complimentary', plan: 'team', reason: 'x'.repeat(301) },
      { kind: 'complimentary', plan: 'free', reason: 'x' },
      { kind: 'trial', until: '2027-02-30', reason: 'x' },
      { kind: 'trial', until: 'next week', reason: 'x' },
      { kind: 'normal', reason: 'x', extra: true },
      { kind: 'delete', reason: 'x' },
    ]) {
      const r = await request('POST', `/api/operator/workspaces/${B}/plan`, { body: bad, ...as(ops) });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status} ${r.text}`);
    }
    assert.equal(logs.get(B)?.length, 3, 'nothing refused reached the module');
    // a module's malformed plan is left out, not shown
    broken = true;
    const rows = (await request('GET', '/api/operator/workspaces', as(ops))).json() as OperatorWorkspaces;
    assert.equal(rows.workspaces.find((w) => w.id === B)?.plan, undefined);
    assert.equal(rows.workspaces.find((w) => w.id === 'w1')?.plan?.state, 'complimentary', 'the others still are');
  } finally {
    ctx.extension = before;
  }
});

test('disable ends the account’s sessions and tokens at once; enable lets it sign in again', async () => {
  const miaSession = await signIn('mia@example.com');
  const miaToken = { headers: { Authorization: `Bearer ${auth.createToken(mia.id, 'agent', { workspace: B }).token}` } };
  assert.equal((await request('GET', '/api/auth/me', as(miaSession))).status, 200);
  assert.equal((await request('GET', '/api/library', miaToken)).status, 200);
  const off = await request('POST', `/api/operator/accounts/${mia.id}/disable`, { body: {}, ...as(ops) });
  assert.equal(off.status, 200, off.text);
  assert.ok((off.json().account as OperatorAccount).disabled);
  assert.equal((await request('GET', '/api/auth/me', as(miaSession))).status, 401, 'the session ended');
  assert.equal((await request('GET', '/api/library', miaToken)).status, 401, 'the token stopped');
  assert.equal((await request('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: PASSWORD }, headers: origin })).status, 401);
  assert.equal(ws.roleIn(B, mia.id), null, 'no role anywhere while disabled');
  assert.equal(
    ws.membersOf(B).some((m) => m.user === mia.id),
    true,
    'still a member: nothing was deleted',
  );
  // twice is the same
  assert.equal((await request('POST', `/api/operator/accounts/${mia.id}/disable`, { body: {}, ...as(ops) })).status, 200);
  const on = await request('POST', `/api/operator/accounts/${mia.id}/enable`, { body: {}, ...as(ops) });
  assert.equal(on.status, 200, on.text);
  assert.equal((on.json().account as OperatorAccount).disabled, null);
  assert.equal((await request('GET', '/api/auth/me', as(miaSession))).status, 401, 'a session that ended stays ended');
  assert.equal((await request('GET', '/api/auth/me', as(await signIn('mia@example.com')))).status, 200, 'signs in again');
  assert.equal(ws.roleIn(B, mia.id), 'member');
  // never your own account; no body but an empty one
  const self = await request('POST', `/api/operator/accounts/${olivia.id}/disable`, { body: {}, ...as(ops) });
  assert.equal(self.status, 409, self.text);
  assert.equal((await request('POST', `/api/operator/accounts/${mia.id}/disable`, { body: { why: 'x' }, ...as(ops) })).status, 400);
  assert.equal((await request('POST', '/api/operator/accounts/u_000000000000/disable', { body: {}, ...as(ops) })).status, 404);
});

test('no answer carries a password hash, a token, a session’s epoch or a sign-up secret', async () => {
  const token = auth.createToken(lee.id, 'leak check', { workspace: B }).token;
  const texts = [
    (await request('GET', '/api/operator/workspaces', as(ops))).text,
    (await request('GET', `/api/operator/workspaces/${B}`, as(ops))).text,
    (await request('GET', '/api/operator/accounts', as(ops))).text,
    (await request('GET', `/api/operator/accounts/${lee.id}`, as(ops))).text,
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, /scrypt\$|"password"|"epoch"|"hash"|signup_browser|"proven"/);
    assert.ok(!t.includes(token) && !t.includes(leeToken), 'no token');
  }
});

test('the app on a person’s own machine has no operator', async () => {
  ctx.hosted = false;
  try {
    for (const [method, url] of READS(B, mia.id)) assert.equal((await request(method, url, as(ops))).status, 404, url);
  } finally {
    ctx.hosted = true;
  }
});
