// Sign-up on a hosted server with workspaces (server/signup.ts, the onSignup seam): someone who signs up on their own
// (VR_SIGNUP=open) gets a workspace of their own once their address is confirmed — empty, with them as its owner,
// named after them until they name it — and never sees the team that was here first; someone invited lands in the
// invite's workspace. The first run asks the new owner to name the workspace, and counts only what happens in it. Open
// sign-up is refused on a person's own machine whatever the seam. Every message goes to the log transport's outbox.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { type Reply, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_SIGNUP: 'open', VR_TRUST_PROXY: 'loopback' } });
const { loadConfig } = await import('../../lib/config.ts');
const { mailProblems } = await import('../../lib/mail/config.ts');
const { onSignup } = await import('../../server/signup.ts');
const auth = await import('../../lib/auth.ts');
type User = import('../../lib/auth.ts').User;
const ws = await import('../../lib/workspaces.ts');
const { readOutbox } = await import('../../lib/mail/index.ts');
const { usageOf } = await import('../../server/extension.ts');

const { ctx, request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });
after(() => ctx.mail.stop());

const OUTBOX = path.join(dir, 'cache', 'outbox');
const origin = { Origin: PUBLIC };
const cookiesOf = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .join('; ');
let n = 0;
const somewhere = () => ({ 'X-Forwarded-For': `198.51.100.${(n++ % 250) + 1}` });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  request('POST', url, { body, headers: { ...origin, ...somewhere(), ...headers } });
const get = (url: string, headers: Record<string, string>) => request('GET', url, { headers: { ...somewhere(), ...headers } });
async function confirmLinkOf(address: string): Promise<string> {
  await ctx.mail.flush();
  const mail = readOutbox(OUTBOX).filter((m) => m.to === address && m.kind === 'verify')[0];
  const token = /#\/verify\/(vt_[\w-]+)/.exec(mail?.text ?? '')?.[1];
  assert.ok(token, `a confirm link went to ${address}`);
  return token as string;
}

let olivia: Record<string, string>;
before(async () => {
  // The team that was here first: Olivia owns workspace #1 and has a video in it (the store is not migrated yet:
  // making the first sign-up's workspace migrates it).
  await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'olivias password', role: 'owner' });
  ctx.setup.token = null;
  const login = await post('/api/auth/login', { email: 'olivia@example.com', password: 'olivias password' });
  assert.equal(login.status, 200, login.text);
  olivia = { Cookie: cookiesOf(login) };
  const { token } = auth.createToken((auth.findUserByEmail('olivia@example.com') as User).id, 'upload');
  const clip = makeVideo(path.join(dir, 'in', 'team-reel.mp4'), { w: 320, h: 180, dur: 1, pattern: 'testsrc' });
  age(clip);
  const up = await tusUpload(request, clip, { filename: 'team-reel.mp4', folder: 'Team' }, { Authorization: `Bearer ${token}`, ...origin });
  assert.equal(up.status, 200, up.text);
});

test('open sign-up: confirmed, the person owns a workspace of their own, empty, and sees nothing of the team’s', async () => {
  assert.equal(ws.isMigrated(), false, 'one workspace so far');
  // a name the team already uses is fine: names are told apart per workspace, and "taken" would tell who is here
  const made = await post('/api/auth/signup', { name: 'Olivia', email: 'olivia.other@example.com', password: 'another long password', lang: 'en' });
  assert.equal(made.status, 200, made.text);
  const held = auth.findUserByEmail('olivia.other@example.com') as User;
  assert.ok(auth.isGated(held), 'held until confirmed');
  assert.equal(ws.homeWorkspace(held.id), null, 'in no workspace while held');
  assert.equal(ws.roleIn('w1', held.id), null);
  // held, it may sign in — to confirm its address, in no workspace, reaching nothing
  const early = await post('/api/auth/login', { email: 'olivia.other@example.com', password: 'another long password' });
  assert.equal(early.status, 200, early.text);
  const earlyHeaders = { Cookie: cookiesOf(early) };
  const heldStatus = (await get('/api/auth/status', earlyHeaders)).json();
  assert.ok(heldStatus.user?.unverified && !heldStatus.workspace, JSON.stringify(heldStatus));
  assert.deepEqual(heldStatus.workspaces, []);
  const blocked = await get('/api/library', earlyHeaders);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json().unconfirmed, true);

  const token = await confirmLinkOf('olivia.other@example.com');
  // opened in the browser that signed up (its cookie): that browser is signed in
  const done = await post('/api/auth/verify', { token }, { Cookie: cookiesOf(made) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().released, true);
  const pia = { Cookie: cookiesOf(done) };

  const status = (await get('/api/auth/status', pia)).json();
  assert.equal(status.workspace.role, 'owner');
  assert.notEqual(status.workspace.id, 'w1');
  assert.equal(status.workspace.name, 'Olivia', 'named after them until they name it');
  assert.equal(status.workspace.signup, true);
  assert.deepEqual(
    status.workspaces.map((w: { id: string }) => w.id),
    [status.workspace.id],
    'only their own',
  );
  assert.equal(ws.roleIn('w1', held.id), null, 'never a member of the team that was here first');
  assert.equal(ws.isMigrated(), true, 'the store moved to workspaces on the way');
  assert.equal(ws.roleIn('w1', (auth.findUserByEmail('olivia@example.com') as User).id), 'owner', 'the team is as it was');

  const lib = (await get('/api/library', pia)).json();
  assert.deepEqual(lib.videos, [], 'an empty library');
  const teamLib = (await get('/api/library', olivia)).json();
  assert.equal(teamLib.videos.length, 1, 'the team still has its video');
  assert.equal((await get(`/api/review/${encodeURIComponent(teamLib.videos[0].slug)}`, pia)).status, 404, 'and it is nothing to the newcomer');
  assert.equal((await post('/api/workspaces/switch', { id: 'w1' }, pia)).status, 404);

  // the first run: Cloud's steps for agent work (the setup names the workspace); nothing of the team's counts as theirs
  // — not its project, not its video, not an agent on it
  const first = (await get('/api/onboarding', pia)).json();
  assert.deepEqual(
    first.steps.map((s: { id: string; done: boolean }) => [s.id, s.done]),
    [
      ['project', false],
      ['agent', false],
      ['agent_video', false],
      ['share', false],
      ['invite', false],
    ],
  );
  assert.equal(status.user.prefs.onboarding.setup_due, true, 'the setup is due on the first visit');
  assert.equal(ws.workspaceNamed(status.workspace.id), false);
  assert.equal((await request('PATCH', '/api/workspaces/current', { body: { name: 'Pia Films' }, headers: { ...origin, ...pia } })).status, 200);
  assert.equal(ws.workspaceNamed(status.workspace.id), true, 'named by a person now');
  assert.equal((await get('/api/auth/status', pia)).json().workspace.name, 'Pia Films');

  // a second click on the link changes nothing (the seam is idempotent), even two at once
  assert.equal((await post('/api/auth/verify', { token })).status, 410);
  await Promise.all([1, 2].map(() => onSignup?.({ user: auth.publicUser(auth.getUser(held.id) as User) })));
  assert.equal(ws.workspacesOf(held.id).length, 1, 'still one workspace');
  assert.equal(ws.createWorkspace({ name: 'Again', ownerId: held.id, signup: true }).id, status.workspace.id, 'a sign-up has one');
});

test('the first run’s sample is the workspace’s own, and never counts against a plan', async () => {
  const pia = await post('/api/auth/login', { email: 'olivia.other@example.com', password: 'another long password' });
  const piaHeaders = { Cookie: cookiesOf(pia) };
  const piaWs = (await get('/api/auth/status', piaHeaders)).json().workspace.id;
  const made = await post('/api/onboarding/sample', { lang: 'en' }, piaHeaders);
  assert.equal(made.status, 200, made.text);
  const theirs = (await get('/api/library', piaHeaders)).json().videos;
  assert.equal(theirs.length, 1, 'the sample, in their library');
  assert.ok(!(await get('/api/library', olivia)).json().videos.some((v: { slug: string }) => v.slug === made.json().slug), 'not in the team’s');
  assert.deepEqual(
    usageOf(piaWs),
    { bytes: 0, files: { bytes: 0, kept: 0, count: 0 }, members: 1, activeVideos: 0, room: { videos: 0, bytes: 0 } },
    'the sample is Lampo’s, not theirs to pay for',
  );
  // the team's own sample is another one, made in its own workspace
  const teams = await post('/api/onboarding/sample', { lang: 'en' }, olivia);
  assert.equal(teams.status, 200, teams.text);
  assert.equal(teams.json().created, true, 'one per workspace');
  assert.equal((await post('/api/onboarding/sample', { lang: 'en' }, piaHeaders)).json().created, false, 'theirs is there already');
});

test('a workspace made in the app was named by a person: no naming step for its owner', async () => {
  const before = ws.listWorkspaces().length;
  const made = await post('/api/workspaces', { name: 'Side project' }, olivia);
  assert.equal(made.status, 200, made.text);
  assert.equal(ws.listWorkspaces().length, before + 1);
  assert.equal(ws.workspaceNamed(made.json().workspace.id), true);
  assert.equal(made.json().workspace.signup, undefined);
});

test('an invited sign-up lands in the invite’s workspace with its role', async () => {
  // Pia (the owner of her own workspace) invites someone by email; open sign-up with that address still lands there
  const pia = await post('/api/auth/login', { email: 'olivia.other@example.com', password: 'another long password' });
  const piaHeaders = { Cookie: cookiesOf(pia) };
  const inv = await post('/api/admin/invites', { role: 'member', email: 'sam@example.com', send: true, lang: 'en' }, piaHeaders);
  assert.equal(inv.status, 200, inv.text);
  // the email names the workspace it joins, where the server's host would stand
  await ctx.mail.flush();
  const sent = readOutbox(OUTBOX).filter((m) => m.to === 'sam@example.com' && m.kind === 'invite')[0];
  assert.ok(!sent?.subject.includes('Pia Films') && sent?.text.includes('for a workspace named “Pia Films”'), `${sent?.subject}\n${sent?.text}`);
  const piaWs = (await get('/api/auth/status', piaHeaders)).json().workspace.id;
  // with VR_SIGNUP=open an invited address signing up is an open sign-up: it gets its own workspace — the invite is
  // taken through its link instead. The link proves no inbox (Pia holds it too): Sam is held until his address is
  // confirmed, and then lands in the invite's workspace, not one of his own.
  const invToken = inv.json().url.split('/#/invite/')[1];
  const accepted = await post('/api/auth/invite/accept', { token: invToken, name: 'Sam', email: 'sam@example.com', password: 'sams long password' });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(accepted.json(), { held: true });
  const sam = auth.findUserByEmail('sam@example.com') as User;
  assert.equal(ws.roleIn(piaWs, sam.id), null, 'nothing until the address is confirmed');
  const done = await post('/api/auth/verify', { token: await confirmLinkOf('sam@example.com') }, { Cookie: cookiesOf(accepted) });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json().signedIn, true, 'the browser that took the invite');
  assert.equal(ws.roleIn(piaWs, sam.id), 'member');
  assert.equal(ws.roleIn('w1', sam.id), null);
  // placing them again (a confirm link of an invited account) keeps them where the invite put them
  ws.placeSignup(sam.id);
  assert.deepEqual(
    ws.workspacesOf(sam.id).map((w) => w.workspace.id),
    [piaWs],
  );
});

test('open sign-up is for a hosted server: refused on a person’s own machine, whatever the seam', () => {
  const cfg = { ...loadConfig(), mode: 'local' as const, signup: 'open' as const };
  assert.ok(mailProblems(cfg, { signupSeam: true }).some((p) => /hosted server with workspaces/.test(p)));
  assert.deepEqual(
    mailProblems(
      { ...loadConfig(), signup: 'open', terms_url: 'https://review.test/terms', privacy_url: 'https://review.test/privacy' },
      { signupSeam: true },
    ).filter((p) => /VR_SIGNUP/.test(p)),
    [],
    'a hosted server with the seam filled starts',
  );
});
