// Two workspaces on one server, read every way a member of A can: every registered route (with A's ids, and with B's —
// slugs, note ids, link tokens, invites, tokens, people), writes aimed at B's ids, the live stream while B works, every
// MCP tool with A's API token, the file URLs of B's screenshots and renders, A's review links, and the disk and storage
// keys A's paths resolve to. Nothing ever shows B: not its names, notes, ids, links, people, agents — nor that it
// changed. B's video has the same name in the same folder as one of A's (the same slug) and the same bytes, so nothing
// keyed by a slug or a render's hash can mix them. B owns one of everything stored per workspace (references, playbook
// skills and their files, a recording, a fix preview, a transcript, a picture, two snoozes, two apps, a post of a final
// video with its cover and publish kit, a publishing connection with its sealed secret, a footage index; Carol, in both,
// has a token, an app and a draft in B), the walks ask for each of them by its id, its file and its query beside a
// made-up one of the same shape (a picture says nothing in words: B's being served where nobody's isn't is the leak),
// and a check holds the two trees to the same kinds of files, so a feature added to A's setup alone can't slip past the walks. Also: the
// route walk with roles per workspace (a reviewer in A who owns B is a reviewer in A), and a person in both workspaces
// whose session in A shows A only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo, sleep, until } from '../lib/helpers.ts';
import { client, type Reply, tusUpload } from '../lib/http.ts';
import { registeredRoutes } from '../lib/routes.ts';

// A stand-in speech server (transcripts and recorded feedback need one): every clip says the same four words — in
// English; asked for Swedish (A hears the render both workspaces hold that way), words of A's own.
const stt = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    const [a, b, c, d] = /name="language"\r\n\r\nsv\r\n/.test(body) ? ['ALPHA', 'words', 'in', 'Swedish.'] : ['Every', 'morning', 'we', 'start.'];
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: `${a} ${b} ${c} ${d}`,
        language: 'english',
        words: [
          { word: a, start: 0.1, end: 0.32 },
          { word: b, start: 0.32, end: 0.64 },
          { word: c, start: 0.64, end: 0.8 },
          { word: d, start: 0.8, end: 1.04 },
        ],
        segments: [{ text: `${a} ${b} ${c} ${d}`, start: 0.1, end: 1.04 }],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));
const sttUrl = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({
  vars: {
    VR_MODE: 'server',
    VR_PUBLIC_URL: PUBLIC,
    VR_WEBHOOK_ALLOW_PRIVATE: '1',
    VR_STT: 'http',
    VR_STT_URL: sttUrl,
    // footage search with the stand-in model (no download): each workspace's index is one of the things it owns
    VR_FOOTAGE: 'auto',
    VR_FOOTAGE_MODEL: 'fake',
  },
});
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const { startServerFeed } = await import('../../server/feed.ts');
const { ruleFor } = await import('../../server/permissions.ts');
const { can } = await import('../../lib/permissions.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');
const paths = await import('../../lib/paths.ts');
const oauth = await import('../../lib/oauth/store.ts');
const jobs = await import('../../lib/jobs.ts');

const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
const app = createApp(ctx);
let server: http.Server;
let port = 0;
let request: ReturnType<typeof client>;
const feed = startServerFeed(ctx, 50);
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Host: 'review.test' });
  ctx.hub.startPing(200);
});
after(() => {
  feed.stop();
  server.closeAllConnections();
  server.close();
  stt.close();
});

const PASSWORD = 'a long password';
/** Turns footage search on for the caller's workspace, waits until its videos are indexed: its shot ids. */
let footageShots: (headers: Record<string, string>) => Promise<string[]>;
const origin = { Origin: PUBLIC };
const enc = encodeURIComponent;

// ---------------------------------------------------------------- the two teams

const A = 'w1';
let B = '';
const ids = {
  slugIntro: '',
  slugB2: '',
  slugA2: '',
  noteA: '',
  linkA: '',
  folderLinkA: '',
  notesB: [] as string[],
  linkB: '',
  folderLinkB: '',
  linkIdsB: [] as string[],
  inviteB: '',
  tokenIdB: '',
  draftB: '',
  bob: '',
  carol: '',
  /** What else B owns: reference, skill, recording, preview, picture and app ids, and the names of their files. */
  ownedB: [] as string[],
  /** Each of B's own things as the route walks name it — by id, by file, by query — with a made-up one of its shape. */
  ownedSets: [] as Values[],
  /** The For-you items snoozed in B (Bob's and Carol's own). */
  snoozedB: [] as string[],
  /** A's side, for the walk from B: more notes, links, an invite, Alice's token, and one of everything A owns. */
  notesA: [] as string[],
  linkIdsA: [] as string[],
  inviteA: '',
  tokenIdA: '',
  alice: '',
  ownedA: [] as string[],
  ownedSetsA: [] as Values[],
  snoozedA: [] as string[],
  /** Each workspace's footage shot ids (each index numbers from a random start). */
  shotsA: [] as string[],
  shotsB: [] as string[],
  /** Each workspace's own files, as its people read them: the URL, who asks, and the bytes it must serve. */
  ownFiles: [] as { what: string; url: string; who: Record<string, string>; bytes: Buffer }[],
  /** Carol's own things in each workspace (her draft, her recording): what her own export may carry from the other. */
  carolsInA: [] as string[],
  carolsInB: [] as string[],
};
const caller: Record<string, Record<string, string>> = {};
/** B's people, for the walk the other way. */
const callerB: Record<string, Record<string, string>> = {};

async function signIn(email: string, workspace?: string): Promise<string> {
  const r = await request('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  let cookie = String([r.headers['set-cookie']].flat()[0]).split(';')[0];
  if (workspace) {
    const s = await request('POST', '/api/workspaces/switch', { body: { id: workspace }, headers: { Cookie: cookie, ...origin } });
    assert.equal(s.status, 200, s.text);
    cookie = String([s.headers['set-cookie']].flat()[0]).split(';')[0];
  }
  return cookie;
}
/**
 * A project file pushed into a folder (lib/files.ts): the push names it, its one-time URL takes its bytes. Its id, its
 * folder's id inside the area, and its bytes' sha256 (the blob's name in the workspace's tree).
 */
async function pushFile(headers: Record<string, string>, folder: string, filePath: string, data: Buffer): Promise<{ id: string; dir: string; sha256: string }> {
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const asked = ok(
    await request('POST', '/api/files/uploads', { body: { folder, files: [{ path: filePath, size: data.length, sha256 }] }, headers }),
    `push ${filePath}`,
  );
  const slot = asked.json().uploads[0] as { url?: string };
  assert.ok(slot.url, 'new bytes: a URL to send them to');
  ok(await request('PUT', new URL(slot.url).pathname, { body: data, headers: { 'content-length': String(data.length) } }), `bytes of ${filePath}`);
  const listing = ok(await request('GET', `/api/files?folder=${enc(folder)}&deep=1&own=1`, { headers }), 'files').json();
  const file = listing.files.find((f: { path: string }) => f.path === filePath);
  const top = ok(await request('GET', `/api/files?folder=${enc(folder)}&own=1`, { headers }), 'folders').json();
  const dir = top.dirs.find((d: { path: string }) => filePath.startsWith(`${d.path}/`));
  assert.ok(file?.id && dir?.id, `${filePath} and its folder listed`);
  return { id: file.id, dir: dir.id, sha256 };
}

const ok = (r: Reply, what: string) => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};

/** An elements map of the 1 s clip both workspaces hold (160×90 at 30 fps): one named element. */
const elementsMap = (id: string, name: string) => ({
  v: 1,
  fps: 30,
  size: [160, 90],
  elements: [{ id, name, kind: 'image', keys: [[0, 10, 10, 60, 40]], runs: [[0, 29]] }],
});

/** A video made final by `who`, its YouTube post drafted with a cover frame and its kit made: the post's id. */
async function finalWithPost(slug: string, who: Record<string, string>, title: string): Promise<string> {
  ok(await request('PUT', `/api/review/${enc(slug)}/approval`, { body: { status: 'approved', v: 1 }, headers: who }), `${title}: approved`);
  ok(await request('PUT', `/api/review/${enc(slug)}/final`, { body: { v: 1, confirm: true }, headers: who }), `${title}: final`);
  const draft = { platform: 'youtube', title, description: `${title} text`, tags: [title.split(' ')[0]], cover_frame: 1 };
  const id = ok(await request('POST', `/api/review/${enc(slug)}/posts`, { body: draft, headers: who }), `${title}: drafted`).json().id as string;
  ok(await request('POST', `/api/posts/${id}/kit`, { headers: who }), `${title}: kit asked for`);
  for (let i = 0; i < 1200; i++) {
    const kit = (await request('GET', `/api/posts/${id}/kit`, { headers: who })).json();
    assert.notEqual(kit.state, 'failed', JSON.stringify(kit));
    if (kit.state === 'ready') break;
    await sleep(100);
  }
  ok(await request('GET', `/api/posts/${id}/cover.jpg`, { headers: who }), `${title}: cover`);
  return id;
}

/** Everything of B that must never show to A: its marker word, its workspace id, its notes, links, people and files. */
function secretsOfB(): string[] {
  return [
    'bravo',
    B,
    ...ids.notesB,
    ids.linkB,
    ids.folderLinkB,
    ...ids.linkIdsB,
    ids.inviteB,
    ids.tokenIdB,
    ids.draftB,
    ids.bob,
    'bob@example.com',
    ...ids.ownedB,
  ].filter(Boolean);
}
/** Everything of A that must never show to B's people: its marker word, its notes, links, invite, Alice and A's files. */
function secretsOfA(): string[] {
  return ['alpha', ...ids.notesA, ids.linkA, ids.folderLinkA, ...ids.linkIdsA, ids.inviteA, ids.tokenIdA, ids.alice, 'alice@example.com', ...ids.ownedA].filter(
    Boolean,
  );
}
/** Secrets in an answer — but not the ones the asker sent (an error that names the id it was asked about tells nothing new). */
const leaksOf =
  (secrets: () => string[]) =>
  (text: string, extra: string[] = [], sent = '') =>
    [...secrets(), ...extra].filter((s) => text.toLowerCase().includes(s.toLowerCase()) && !sent.toLowerCase().includes(s.toLowerCase()));
/** B's secrets in an answer to A. */
const leaks = leaksOf(secretsOfB);

/** Collects what one event stream says until stopped. */
function listen(headers: Record<string, string>) {
  let text = '';
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: 'review.test', ...headers }, agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      text += d;
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    text: () => text,
    stop: () => req.destroy(),
  };
}

/** What A's people's streams said while B worked (taken before anyone in A writes anything). */
const heard: Record<string, string> = {};

before(async () => {
  // A (workspace #1, the store as it was): Alice owns it; Carol reviews in it.
  ids.alice = (await auth.createUser({ email: 'alice@example.com', name: 'Alice', password: PASSWORD, role: 'owner' })).id;
  const carol = await auth.createUser({ email: 'carol@example.com', name: 'Carol', password: PASSWORD, role: 'reviewer' });
  const bob = await auth.createUser({ email: 'bob@example.com', name: 'Bob', password: PASSWORD, role: 'reviewer' });
  ids.bob = bob.id;
  ids.carol = carol.id;
  // B: made by Bob; Carol owns it too. Bob is not in A (his account was made in A's days: he leaves it).
  B = ws.createWorkspace({ name: 'Bravo Studio', ownerId: bob.id }).id;
  ws.addMember(B, carol.id, 'owner');
  ws.removeMember(A, bob.id);
  assert.equal(ws.roleIn(A, bob.id), null);

  const aliceA = await signIn('alice@example.com');
  const aliceMade = (await request('POST', '/api/auth/tokens', { body: { name: 'alice a' }, headers: { Cookie: aliceA, ...origin } })).json();
  const aliceToken = aliceMade.token;
  ids.tokenIdA = aliceMade.info.id;
  const carolA = await signIn('carol@example.com', A);
  const carolMade = (await request('POST', '/api/auth/tokens', { body: { name: 'carol a' }, headers: { Cookie: carolA, ...origin } })).json();
  const carolToken = carolMade.token;
  ids.ownedA.push(carolMade.info.id);
  const bobB = await signIn('bob@example.com');
  caller['alice (session)'] = { Cookie: aliceA, ...origin };
  caller['alice (token)'] = { Authorization: `Bearer ${aliceToken}` };
  caller['carol in A (session)'] = { Cookie: carolA, ...origin };
  caller['carol in A (token)'] = { Authorization: `Bearer ${carolToken}` };
  const asBob = { Cookie: bobB, ...origin };

  // A's work: a video named like B's, a note, a review link, a folder link.
  const aClip = makeVideo(path.join(dir, 'a/intro.mp4'), { dur: 1, pattern: 'testsrc' });
  age(aClip);
  const upA = ok(await tusUpload(request, aClip, { filename: 'intro.mp4', folder: 'Reels' }, caller['alice (token)']), 'A upload');
  ids.slugIntro = upA.json().slug;
  const a2 = makeVideo(path.join(dir, 'a/alpha-cut.mp4'), { dur: 1, pattern: 'rgbtestsrc' });
  age(a2);
  ids.slugA2 = ok(await tusUpload(request, a2, { filename: 'alpha-cut.mp4', folder: 'Alpha' }, caller['alice (token)']), 'A upload 2').json().slug;
  ids.noteA = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/comments`, {
      body: { frame: 3, text: 'ALPHA note: tighten the cut' },
      headers: caller['alice (session)'],
    }),
    'A note',
  ).json().id;
  ids.notesA.push(ids.noteA);
  const linkA = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/shares`, { body: { label: 'ALPHA link' }, headers: caller['alice (session)'] }),
    'A link',
  ).json();
  ids.linkA = linkA.token;
  const folderLinkA = ok(
    await request('POST', '/api/folder-shares', { body: { folder: 'Reels', label: 'ALPHA folder' }, headers: caller['alice (session)'] }),
    'A folder',
  ).json();
  ids.folderLinkA = folderLinkA.token;
  ids.linkIdsA.push(linkA.id, folderLinkA.id);
  // let A's own background work (posters, checks) finish before the streams listen
  await sleep(1500);

  const aliceStream = listen(caller['alice (session)']);
  const carolStream = listen(caller['carol in A (session)']);
  await sleep(200);

  // B's work, while A's people listen: the same name in the same folder with the same bytes (everything keyed by a
  // render's hash — posters, transcripts, cuts, checksums — meets A's), a video of its own, notes, a reply, review
  // links and their visitors, a folder, the House playbook, a webhook, an invite, a token, an agent, a draft, verdicts.
  const bClip = path.join(dir, 'b/intro.mp4');
  fs.mkdirSync(path.dirname(bClip), { recursive: true });
  fs.copyFileSync(aClip, bClip);
  age(bClip);
  const upB = ok(await tusUpload(request, bClip, { filename: 'intro.mp4', folder: 'Reels' }, asBob), 'B upload');
  assert.equal(upB.json().slug, ids.slugIntro, 'the same slug as A’s');
  const b2 = makeVideo(path.join(dir, 'b/bravo-cut.mp4'), { dur: 1, pattern: 'smptehdbars' });
  age(b2);
  ids.slugB2 = ok(await tusUpload(request, b2, { filename: 'bravo-cut.mp4', folder: 'Bravo-only' }, asBob), 'B upload 2').json().slug;
  for (const [slug, text] of [
    [ids.slugIntro, 'BRAVO note one #bravotag'],
    [ids.slugB2, 'BRAVO note two'],
  ] as const) {
    const n = ok(await request('POST', `/api/review/${enc(slug)}/comments`, { body: { frame: 2, text, severity: 'must' }, headers: asBob }), 'B note').json();
    ids.notesB.push(n.id);
  }
  ok(await request('PATCH', `/api/comments/${ids.notesB[0]}`, { body: { note: 'BRAVO reply' }, headers: asBob }), 'B reply');
  const linkB = ok(await request('POST', `/api/review/${enc(ids.slugB2)}/shares`, { body: { label: 'BRAVO link' }, headers: asBob }), 'B link').json();
  ids.linkB = linkB.token;
  ids.linkIdsB.push(linkB.id);
  const folderB = ok(
    await request('POST', '/api/folder-shares', { body: { folder: 'Bravo-only', label: 'BRAVO folder link' }, headers: asBob }),
    'B folder link',
  ).json();
  ids.folderLinkB = folderB.token;
  ids.linkIdsB.push(folderB.id);
  ok(await request('GET', `/api/g/${ids.linkB}`), 'B link visited');
  ok(await request('POST', '/api/folders', { body: { path: 'Bravo-folder' }, headers: asBob }), 'B folder');
  ok(
    await request('PUT', '/api/playbook/text', {
      body: { section: 'rules', content: '- BRAVO rule: always the bravo logo', message: 'BRAVO rules' },
      headers: asBob,
    }),
    'B playbook',
  );
  // B's webhook: only workspace #1 may send to private addresses (WS-9), so it is put in B's file as one kept from before
  ws.inWorkspace(B, () => ctx.webhooks.add({ url: 'http://127.0.0.1:9/bravo-hook', label: 'BRAVO hook' }, 'Bob'));
  ids.inviteB = ok(
    await request('POST', '/api/admin/invites', { body: { role: 'member', email: 'bravo-invitee@example.com' }, headers: asBob }),
    'B invite',
  ).json().invite.id;
  // who each workspace's videos are for (the setup): kept on the workspace, shown to its own members only
  ok(
    await request('PUT', '/api/workspaces/current/persona', { body: { personas: ['agency', 'other'], personaOther: 'BRAVO training films' }, headers: asBob }),
    'B persona',
  );
  ok(
    await request('PUT', '/api/workspaces/current/persona', {
      body: { personas: ['other'], personaOther: 'ALPHA explainers' },
      headers: caller['alice (session)'],
    }),
    'A persona',
  );
  const bobToken = ok(await request('POST', '/api/auth/tokens', { body: { name: 'BRAVO token' }, headers: asBob }), 'B token').json();
  ids.tokenIdB = bobToken.info.id;
  const asBobToken = { Authorization: `Bearer ${bobToken.token}` };
  ok(
    await request('POST', '/api/agents/heartbeat', { body: { session_id: 'bravo-session', name: 'BRAVO agent', cwd: '/work/bravo' }, headers: asBobToken }),
    'B agent',
  );
  ok(
    await request('POST', '/api/agents/activity', {
      body: { entries: [{ agent: 'BRAVO agent', kind: 'read', text: 'Reading BRAVO notes', video: ids.slugB2 }] },
      headers: asBobToken,
    }),
    'B activity',
  );
  ok(await request('POST', `/api/review/${enc(ids.slugB2)}/request`, { body: { text: 'BRAVO request: render again' }, headers: asBob }), 'B request');
  ok(await request('PUT', `/api/review/${enc(ids.slugB2)}/agent-status`, { body: { text: 'BRAVO status: rendering' }, headers: asBobToken }), 'B status');
  ok(
    await request('PUT', `/api/review/${enc(ids.slugIntro)}/approval`, { body: { status: 'changes', note: 'BRAVO verdict', v: 1 }, headers: asBob }),
    'B verdict',
  );
  ok(await request('POST', `/api/review/${enc(ids.slugB2)}/watch`, { body: { v: 1, seen: 'f'.repeat(25), secs: 3 }, headers: asBob }), 'B watch');
  ids.draftB = ok(
    await request('POST', `/api/review/${enc(ids.slugB2)}/drafts`, { body: { frame: 1, text: 'BRAVO draft' }, headers: asBob }),
    'B draft',
  ).json().id;
  ok(await request('POST', '/api/for-you/dismiss', { body: { keys: ['bravo-key'] }, headers: asBob }), 'B dismiss');
  // Everything else B stores per workspace: a reference on a note, a skill with a file and a reference in its
  // playbook, a recording, a fix preview, a transcript (of the bytes A has too), Bob's picture, an app Bob allowed.
  const still = path.join(dir, 'b/frame.png');
  execFileSync(FFMPEG, ['-v', 'error', '-i', b2, '-frames:v', '1', '-y', still]);
  const png = fs.readFileSync(still).toString('base64');
  const owned = (...names: (string | undefined | null)[]) => ids.ownedB.push(...names.filter((n): n is string => !!n));
  // An elements map (its agent's, by token) on the render both workspaces hold — the same bytes, the same renderKey —
  // and on B's own, and a note pointing into one: B reads what its note points at, A's walk below must never.
  for (const s of [ids.slugIntro, ids.slugB2])
    ok(
      await request('PUT', `/api/review/${enc(s)}/versions/1/elements`, { body: elementsMap('bravoLogo', 'BRAVO logo'), headers: asBobToken }),
      'B elements map',
    );
  const pointing = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/comments`, {
      body: { frame: 2, text: 'BRAVO logo too big', drawing: [{ type: 'box', x: 10, y: 10, w: 60, h: 40 }] },
      headers: asBob,
    }),
    'B note on an element',
  ).json();
  ids.notesB.push(pointing.id);
  owned('bravoLogo');
  assert.deepEqual(ok(await request('GET', `/api/review/${enc(ids.slugIntro)}/elements`, { headers: asBob }), 'B pointers').json(), {
    notes: { [pointing.id]: { elements: ['bravoLogo'] } },
    names: { bravoLogo: 'BRAVO logo' },
  });
  const ref = ok(
    await request('POST', `/api/comments/${ids.notesB[1]}/refs`, { body: { kind: 'image', caption: 'BRAVO like this', data: png }, headers: asBob }),
    'B reference',
  ).json().ref;
  owned(ref.id, ref.file, ref.still);
  const skill = '---\nname: bravo-export\ndescription: BRAVO export preset\n---\n\nRender with the bravo preset.';
  ok(await request('PUT', '/api/playbook/skill', { body: { folder: 'Bravo-only', markdown: skill }, headers: asBob }), 'B skill');
  const skilled = ok(
    await request('POST', '/api/playbook/skill/files', {
      body: { folder: 'Bravo-only', skill: 'bravo-export', name: 'preset.epr', data: Buffer.from('<bravo-preset/>').toString('base64') },
      headers: asBob,
    }),
    'B skill file',
  ).json();
  owned(...(skilled.playbook.skills as { id: string }[]).map((s) => s.id));
  const pbRef = ok(
    await request('POST', '/api/playbook/refs', { body: { folder: 'Bravo-only', kind: 'image', caption: 'BRAVO mood', data: png }, headers: asBob }),
    'B playbook reference',
  ).json().ref;
  owned(pbRef.id, pbRef.file);
  // A question with options asked on a folder before any render (lib/asks.ts): its own file under asks/<id>/.
  const askB = ok(
    await request('POST', '/api/asks', {
      body: {
        folder: 'Bravo-only',
        text: 'BRAVO pick a look',
        options: [{ id: 'look', label: 'BRAVO look', items: [{ id: 'l1', label: 'BRAVO warm', ref: { kind: 'file', data: png } }, { id: 'l2' }] }],
      },
      headers: asBob,
    }),
    'B question on a folder',
  ).json();
  const askBFile = ok(await request('GET', `/api/asks/${askB.id}`, { headers: asBob }), 'B question').json().options[0].items[0].ref.file as string;
  owned(askB.id, askBFile);
  // A project file in B's own folder (lib/files.ts): asked for by its id, its folder's id and its bytes, never served to A
  const fileB = await pushFile(asBob, 'Bravo-only', 'BRAVO cut/bravo-take.txt', Buffer.from('BRAVO project file\n'));
  owned(fileB.id, fileB.dir, fileB.sha256);
  // An agent's run (lib/runs.ts: data/<slug>/runs.jsonl) on the video both workspaces hold: Bob's request to its agent.
  ok(
    await request('PUT', `/api/review/${enc(ids.slugIntro)}/session`, { body: { name: 'BRAVO agent', sessionId: 'mcp-b0b0b0b0b0b0' }, headers: asBob }),
    'B agent',
  );
  ok(await request('POST', `/api/review/${enc(ids.slugIntro)}/request`, { body: { text: 'BRAVO run request' }, headers: asBob }), 'B run');
  const runB = ok(await request('GET', `/api/runs?slug=${enc(ids.slugIntro)}`, { headers: asBob }), 'B runs').json().runs[0]?.id as string;
  assert.match(runB, /^run_[0-9a-f]{12}$/, 'B’s request opened its agent’s run');
  owned(runB);
  const recording = ok(
    await request('POST', `/api/review/${enc(ids.slugB2)}/recordings`, { body: { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 2 }] }, headers: asBob }),
    'B recording',
  ).json();
  owned(recording.id);
  const mic = fs.readFileSync(makeVideo(path.join(dir, 'b/mic.mp4'), { w: 32, h: 32, fps: 5, dur: 1, freq: 330 }));
  ok(
    await request('PUT', `/api/review/${enc(ids.slugB2)}/recordings/${recording.id}/audio`, { body: mic, headers: { ...asBob, 'content-type': 'audio/mp4' } }),
    'B recording audio',
  );
  const fix = ok(
    await request('POST', `/api/comments/${ids.notesB[1]}/previews`, { body: { kind: 'still', frame: 0, note: 'BRAVO fix shown', data: png }, headers: asBob }),
    'B fix preview',
  ).json().preview;
  owned(fix.id, fix.file);
  const picture = ok(await request('PUT', '/api/auth/me/avatar', { body: { data: png }, headers: asBob }), 'B picture').json().user;
  owned(picture.avatar);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id: 'bravo-app-client', kind: 'dcr', name: 'BRAVO app', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  const code = oauth.createCode(asked, bob, B);
  oauth.redeemCode({ code, client_id: 'bravo-app-client', redirect_uri: 'http://127.0.0.1:9/cb', code_verifier: verifier, resource: `${PUBLIC}/mcp` });
  owned(...oauth.listApps(bob.id, B).map((a) => a.id));
  // Carol is in both: in B she has a token, an app and a draft of her own, which her session and token in A must never
  // list, show or touch (A12 verification: VA2-4).
  const carolB = { Cookie: await signIn('carol@example.com', B), ...origin };
  const carolTokenB = ok(await request('POST', '/api/auth/tokens', { body: { name: 'BRAVO carol token' }, headers: carolB }), 'B: Carol’s token').json();
  owned(carolTokenB.info.id);
  callerB['bob (session)'] = asBob;
  callerB['bob (token)'] = asBobToken;
  callerB['carol in B (session)'] = carolB;
  callerB['carol in B (token)'] = { Authorization: `Bearer ${carolTokenB.token}` };
  const carolVerifier = crypto.randomBytes(32).toString('base64url');
  const carolAsked = oauth.createRequest({
    client: { client_id: 'bravo-carol-client', kind: 'dcr', name: 'BRAVO carol app', host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(carolVerifier).digest('base64url'),
    scopes: ['review:read'],
    resource: `${PUBLIC}/mcp`,
  });
  oauth.redeemCode({
    code: oauth.createCode(carolAsked, carol, B),
    client_id: 'bravo-carol-client',
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: carolVerifier,
    resource: `${PUBLIC}/mcp`,
  });
  const [bobApp] = oauth.listApps(bob.id, B);
  const [carolApp] = oauth.listApps(carol.id, B);
  assert.ok(bobApp && carolApp);
  owned(carolApp.id);
  const carolDraft = ok(
    await request('POST', `/api/review/${enc(ids.slugB2)}/drafts`, { body: { frame: 1, text: 'BRAVO carol draft' }, headers: carolB }),
    'B: Carol’s draft',
  ).json().id;
  owned(carolDraft);
  ids.carolsInB.push(carolDraft);
  // Snoozed: a real item of Bob's and one of Carol's (a client's note through B's link), stored in B's for-you.json.
  const roomB = ok(await request('GET', `/api/g/${ids.linkB}`), 'B: the link’s room').json();
  const clientNote = ok(
    await request('POST', `/api/g/${ids.linkB}/comments`, {
      body: { name: 'Bravo client', slug: roomB.videos[0].slug, scope: 'video', text: 'BRAVO client note' },
      headers: { ...origin, 'x-forwarded-for': '203.0.113.50' },
    }),
    'B: a client’s note',
  ).json();
  ids.notesB.push(clientNote.id);
  for (const [who, headers] of [
    ['Bob', asBob],
    ['Carol', carolB],
  ] as const) {
    const items = (await request('GET', '/api/for-you', { headers })).json().items as { key: string; slug?: string }[];
    const item = items.find((i) => i.slug === ids.slugB2);
    assert.ok(item, `${who} has something to do on B's own video: ${items.map((i) => i.key).join(', ')}`);
    ok(
      await request('POST', '/api/for-you/snooze', { body: { keys: [item.key], until: new Date(Date.now() + 86400e3).toISOString() }, headers }),
      `B: ${who}'s snooze`,
    );
    ids.snoozedB.push(item.key);
  }
  // Footage search, on in B now and in A once A's people stopped listening (a hosted workspace's owner turns it on):
  // each indexes its own videos in the background, and the walks ask for B's shots by id (a contact sheet) and its
  // index by words (a search), A's the other way. Indexing B spoke on B's stream only (the live stream test below).
  footageShots = async (headers: Record<string, string>) => {
    ok(await request('PUT', '/api/footage/settings', { body: { on: true }, headers }), 'footage search on');
    await until(async () => {
      const st = (await request('GET', '/api/footage/status', { headers })).json();
      return st.videos === 2 && st.indexed === 2;
    }, 'the workspace’s footage indexed');
    return (await request('GET', '/api/footage/find?q=&limit=50', { headers })).json().shots.map((x: { id: string }) => x.id) as string[];
  };
  ids.shotsB = await footageShots(asBob);
  const shotB = ids.shotsB[0] as string;
  assert.ok(shotB, 'B has footage shots');
  // What the walks ask for by name: each owned thing by its id and its file (and the query a route reads it by).
  const base = { slug: ids.slugB2, token: ids.linkB, v: '1' };
  ids.ownedSets = [
    { ...base, what: 'recording', id: recording.id },
    { ...base, what: 'fix preview', id: fix.id, file: fix.file },
    { ...base, what: 'reference', id: ref.id, file: ref.file },
    { ...base, what: 'reference still', id: ref.id, file: ref.still },
    { ...base, what: 'playbook reference', id: pbRef.id, file: pbRef.file, query: '?folder=Bravo-only' },
    { ...base, what: 'skill', id: skilled.playbook.skills[0].id, query: '?folder=Bravo-only&skill=bravo-export&name=preset.epr' },
    { ...base, what: 'skill by name', id: skilled.playbook.skills[0].id, query: '?folder=Bravo-only&name=bravo-export' },
    { ...base, what: 'Bob’s picture', id: bob.id, file: picture.avatar },
    { ...base, what: 'Bob’s app', id: bobApp.id },
    { ...base, what: 'Carol’s app', id: carolApp.id },
    { ...base, what: 'Carol’s token', id: carolTokenB.info.id },
    { ...base, what: 'Carol’s draft', id: carolDraft },
    { ...base, what: 'a snooze', id: ids.snoozedB[0] as string },
    { ...base, what: 'question on a folder', id: askB.id, file: askBFile },
    { ...base, what: 'footage shot', id: shotB, query: `?ids=${shotB}&q=bravo` },
    { ...base, what: 'elements map', id: 'bravoLogo' },
    { ...base, what: 'agent run', id: runB, query: `?slug=${enc(ids.slugIntro)}` },
    { ...base, what: 'project file', id: fileB.id, query: '?folder=Bravo-only' },
    { ...base, what: 'project folder', id: fileB.dir, query: '?folder=Bravo-only' },
  ].map((x) => ({ ...x, control: madeUp(x) }));
  // one of each, named: the walks below look for every one of them
  assert.ok([ref.id, ref.file, pbRef.id, recording.id, fix.id, fix.file, picture.avatar].every(Boolean), JSON.stringify(ids.ownedB));
  assert.equal(skilled.playbook.skills.length, 1);
  assert.equal(oauth.listApps(bob.id, B).length, 1);
  // Heard in B's own workspace (A has the same bytes and hears them on its own), and the recording heard too, before
  // anything takes a snapshot of B.
  for (let i = 0; i < 300; i++) {
    const t = (await request('GET', `/api/review/${enc(ids.slugIntro)}/transcript`, { headers: asBob })).json();
    const recs = (await request('GET', `/api/review/${enc(ids.slugB2)}/recordings`, { headers: asBob })).json().recordings as { state: string }[];
    if (t.state !== 'pending' && recs.every((r) => r.state === 'ready' || r.state === 'failed')) {
      assert.equal(t.state, 'ready', JSON.stringify(t));
      break;
    }
    await sleep(100);
  }
  // Publishing: B's video final, its YouTube post drafted (with its cover and kit), a connection (its secret sealed).
  // (after its transcript was heard, so its kit has the SRT A's has) on the video both workspaces hold (the same slug, the same bytes): the kits' file names are the same in both trees
  const postB = await finalWithPost(ids.slugIntro, asBob, 'BRAVO post');
  const connB = ok(
    await request('POST', '/api/publish/connections', {
      body: { kind: 'youtube', label: 'BRAVO channel', client_id: 'bravo-client-id-0001', client_secret: 'bravo-client-secret-0001' },
      headers: asBob,
    }),
    'B: a publishing connection',
  ).json().id as string;
  ids.ownedSets.push(
    ...[
      { ...base, what: 'post', id: postB, file: 'kit.zip' },
      { ...base, what: 'publishing connection', id: connB },
    ].map((x) => ({ ...x, control: madeUp(x) })),
  );
  // the feed carries B's events (webhooks, push, the MCP inbox) in B
  await sleep(800);
  aliceStream.stop();
  carolStream.stop();
  heard.alice = aliceStream.text();
  heard.carol = carolStream.text();

  // A's own things, made once A's people stopped listening (their streams hold what B did only): one of everything B
  // owns, for the walk the other way — B's people asking for each of A's by its id, its file and its query. Where it
  // can, it sits on the video both workspaces hold (the same slug), so a read that ends up in A's tree would find it.
  const asAlice = caller['alice (session)'] as Record<string, string>;
  const carolInA = caller['carol in A (session)'] as Record<string, string>;
  const ownA = (...names: (string | undefined | null)[]) => ids.ownedA.push(...names.filter((n): n is string => !!n));
  const stillA = path.join(dir, 'a/frame.png');
  execFileSync(FFMPEG, ['-v', 'error', '-i', aClip, '-frames:v', '1', '-y', stillA]);
  const pngA = fs.readFileSync(stillA).toString('base64');
  ids.inviteA = ok(
    await request('POST', '/api/admin/invites', { body: { role: 'member', email: 'alpha-invitee@example.com' }, headers: asAlice }),
    'A invite',
  ).json().invite.id;
  const refA = ok(
    await request('POST', `/api/comments/${ids.noteA}/refs`, { body: { kind: 'image', caption: 'ALPHA like this', data: pngA }, headers: asAlice }),
    'A reference',
  ).json().ref;
  ownA(refA.id, refA.file, refA.still);
  const skillA = '---\nname: alpha-export\ndescription: ALPHA export preset\n---\n\nRender with the alpha preset.';
  ok(await request('PUT', '/api/playbook/skill', { body: { folder: 'Alpha', markdown: skillA }, headers: asAlice }), 'A skill');
  const skilledA = ok(
    await request('POST', '/api/playbook/skill/files', {
      body: { folder: 'Alpha', skill: 'alpha-export', name: 'preset.epr', data: Buffer.from('<alpha-preset/>').toString('base64') },
      headers: asAlice,
    }),
    'A skill file',
  ).json();
  const skillIdA = (skilledA.playbook.skills as { id: string }[])[0]?.id as string;
  ownA(skillIdA);
  const pbRefA = ok(
    await request('POST', '/api/playbook/refs', { body: { folder: 'Alpha', kind: 'image', caption: 'ALPHA mood', data: pngA }, headers: asAlice }),
    'A playbook reference',
  ).json().ref;
  ownA(pbRefA.id, pbRefA.file);
  const askA = ok(
    await request('POST', '/api/asks', {
      body: {
        folder: 'Alpha',
        text: 'ALPHA pick a look',
        options: [{ id: 'look', label: 'ALPHA look', items: [{ id: 'l1', label: 'ALPHA warm', ref: { kind: 'file', data: pngA } }, { id: 'l2' }] }],
      },
      headers: asAlice,
    }),
    'A question on a folder',
  ).json();
  const askAFile = ok(await request('GET', `/api/asks/${askA.id}`, { headers: asAlice }), 'A question').json().options[0].items[0].ref.file as string;
  ownA(askA.id, askAFile);
  const fileA = await pushFile(asAlice, 'Alpha', 'ALPHA cut/alpha-take.txt', Buffer.from('ALPHA project file\n'));
  ownA(fileA.id, fileA.dir, fileA.sha256);
  // A's own run on the video both hold (the same slug as B's)
  ok(
    await request('PUT', `/api/review/${enc(ids.slugIntro)}/session`, { body: { name: 'ALPHA agent', sessionId: 'mcp-a0a0a0a0a0a0' }, headers: asAlice }),
    'A agent',
  );
  ok(await request('POST', `/api/review/${enc(ids.slugIntro)}/request`, { body: { text: 'ALPHA run request' }, headers: asAlice }), 'A run');
  const runA = ok(await request('GET', `/api/runs?slug=${enc(ids.slugIntro)}`, { headers: asAlice }), 'A runs').json().runs[0]?.id as string;
  assert.match(runA, /^run_[0-9a-f]{12}$/, 'A’s request opened its agent’s run');
  ownA(runA);
  // Carol's, so that Carol — in both — asking from B would be served it if a read fell back to A's tree
  const recA = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/recordings`, {
      body: { v: 1, duration: 1, events: [{ t: 0, k: 'frame', f: 2 }] },
      headers: carolInA,
    }),
    'A recording',
  ).json();
  ownA(recA.id);
  ids.carolsInA.push(recA.id);
  const micA = fs.readFileSync(makeVideo(path.join(dir, 'a/mic.mp4'), { w: 32, h: 32, fps: 5, dur: 1, freq: 550 }));
  ok(
    await request('PUT', `/api/review/${enc(ids.slugIntro)}/recordings/${recA.id}/audio`, {
      body: micA,
      headers: { ...carolInA, 'content-type': 'audio/mp4' },
    }),
    'A recording audio',
  );
  const fixA = ok(
    await request('POST', `/api/comments/${ids.noteA}/previews`, { body: { kind: 'still', frame: 0, note: 'ALPHA fix shown', data: pngA }, headers: asAlice }),
    'A fix preview',
  ).json().preview;
  ownA(fixA.id, fixA.file);
  const pictureA = ok(await request('PUT', '/api/auth/me/avatar', { body: { data: pngA }, headers: asAlice }), 'A picture').json().user;
  ownA(pictureA.avatar);
  // A's own elements map on the render both hold (the same renderKey as B's) and a note pointing into it: each reads its own
  ok(
    await request('PUT', `/api/review/${enc(ids.slugIntro)}/versions/1/elements`, { body: elementsMap('alphaLogo', 'ALPHA logo'), headers: asAlice }),
    'A elements map',
  );
  const pointingA = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/comments`, {
      body: { frame: 2, text: 'ALPHA logo too small', drawing: [{ type: 'box', x: 10, y: 10, w: 60, h: 40 }] },
      headers: asAlice,
    }),
    'A note on an element',
  ).json();
  ids.notesA.push(pointingA.id);
  ownA('alphaLogo');
  assert.deepEqual(ok(await request('GET', `/api/review/${enc(ids.slugIntro)}/elements`, { headers: asAlice }), 'A pointers').json(), {
    notes: { [pointingA.id]: { elements: ['alphaLogo'] } },
    names: { alphaLogo: 'ALPHA logo' },
  });
  const alice = auth.getUser(ids.alice);
  assert.ok(alice);
  for (const [who, clientId, name] of [
    [alice, 'alpha-app-client', 'ALPHA app'],
    [carol, 'alpha-carol-client', 'ALPHA carol app'],
  ] as const) {
    const v = crypto.randomBytes(32).toString('base64url');
    const asked = oauth.createRequest({
      client: { client_id: clientId, kind: 'dcr', name, host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
      redirect_uri: 'http://127.0.0.1:9/cb',
      state: null,
      code_challenge: crypto.createHash('sha256').update(v).digest('base64url'),
      scopes: ['review:read'],
      resource: `${PUBLIC}/mcp`,
    });
    oauth.redeemCode({
      code: oauth.createCode(asked, who, A),
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:9/cb',
      code_verifier: v,
      resource: `${PUBLIC}/mcp`,
    });
  }
  const [aliceApp] = oauth.listApps(ids.alice, A);
  const [carolAppA] = oauth.listApps(ids.carol, A);
  assert.ok(aliceApp && carolAppA);
  ownA(aliceApp.id, carolAppA.id);
  const carolDraftA = ok(
    await request('POST', `/api/review/${enc(ids.slugIntro)}/drafts`, { body: { frame: 1, text: 'ALPHA carol draft' }, headers: carolInA }),
    'A: Carol’s draft',
  ).json().id;
  ownA(carolDraftA);
  ids.carolsInA.push(carolDraftA);
  {
    const items = (await request('GET', '/api/for-you', { headers: asAlice })).json().items as { key: string; slug?: string }[];
    const item = items.find((i) => i.slug === ids.slugA2 || i.slug === ids.slugIntro);
    assert.ok(item, `Alice has something to do on A's videos: ${items.map((i) => i.key).join(', ')}`);
    ok(
      await request('POST', '/api/for-you/snooze', { body: { keys: [item.key], until: new Date(Date.now() + 86400e3).toISOString() }, headers: asAlice }),
      'A: Alice’s snooze',
    );
    ids.snoozedA.push(item.key);
  }
  // A hears the render both workspaces hold in Swedish: words of its own, where B's say "Every morning we start."
  ok(await request('POST', `/api/review/${enc(ids.slugIntro)}/transcript/rerun?language=sv`, { headers: asAlice }), 'A: heard again in Swedish');
  for (let i = 0; i < 300; i++) {
    const t = (await request('GET', `/api/review/${enc(ids.slugIntro)}/transcript`, { headers: asAlice })).json();
    const recs = (await request('GET', `/api/review/${enc(ids.slugIntro)}/recordings`, { headers: carolInA })).json().recordings as { state: string }[];
    if (t.state !== 'pending' && recs.every((r) => r.state === 'ready' || r.state === 'failed')) {
      assert.match(JSON.stringify(t), /ALPHA/, 'A’s own words');
      break;
    }
    await sleep(100);
  }
  const postA = await finalWithPost(ids.slugIntro, asAlice, 'ALPHA post');
  const connA = ok(
    await request('POST', '/api/publish/connections', {
      body: { kind: 'youtube', label: 'ALPHA channel', client_id: 'alpha-client-id-0001', client_secret: 'alpha-client-secret-0001' },
      headers: asAlice,
    }),
    'A: a publishing connection',
  ).json().id as string;
  const baseA = { slug: ids.slugIntro, token: ids.linkA, v: '1' };
  ids.shotsA = await footageShots(asAlice);
  // each index numbers its shots from a random start: neither names the other's
  assert.ok(!ids.shotsA.some((x) => ids.shotsB.includes(x)), `${ids.shotsA} / ${ids.shotsB}`);
  const shotA = ids.shotsA[0] as string;
  ids.ownedSetsA = [
    { ...baseA, what: 'post in A', id: postA, file: 'kit.zip' },
    { ...baseA, what: 'publishing connection in A', id: connA },
    { ...baseA, what: 'recording', id: recA.id },
    { ...baseA, what: 'fix preview', id: fixA.id, file: fixA.file },
    { ...baseA, what: 'reference', id: refA.id, file: refA.file },
    { ...baseA, what: 'reference still', id: refA.id, file: refA.still },
    { ...baseA, what: 'playbook reference', id: pbRefA.id, file: pbRefA.file, query: '?folder=Alpha' },
    { ...baseA, what: 'skill', id: skillIdA, query: '?folder=Alpha&skill=alpha-export&name=preset.epr' },
    { ...baseA, what: 'skill by name', id: skillIdA, query: '?folder=Alpha&name=alpha-export' },
    { ...baseA, what: 'Alice’s picture', id: ids.alice, file: pictureA.avatar },
    { ...baseA, what: 'Alice’s app', id: aliceApp.id },
    { ...baseA, what: 'Carol’s app in A', id: carolAppA.id },
    { ...baseA, what: 'Carol’s token in A', id: carolMade.info.id },
    { ...baseA, what: 'Carol’s draft in A', id: carolDraftA },
    { ...baseA, what: 'a snooze in A', id: ids.snoozedA[0] as string },
    { ...baseA, what: 'question on a folder in A', id: askA.id, file: askAFile },
    { ...baseA, what: 'footage shot in A', id: shotA, query: `?ids=${shotA}&q=alpha` },
    { ...baseA, what: 'elements map in A', id: 'alphaLogo' },
    { ...baseA, what: 'agent run in A', id: runA, query: `?slug=${enc(ids.slugIntro)}` },
    { ...baseA, what: 'project file in A', id: fileA.id, query: '?folder=Alpha' },
    { ...baseA, what: 'project folder in A', id: fileA.dir, query: '?folder=Alpha' },
  ].map((x) => ({ ...x, control: madeUp(x) }));

  // What each workspace's people read of their own files: the walks look for what must not show; these are what must.
  const asBobS = callerB['bob (session)'] as Record<string, string>;
  const files: [string, string, Record<string, string>, string, string][] = [
    // what, URL, who asks, the workspace, the file's name in that workspace's tree
    ['A reference', `/api/refs/${enc(ids.slugIntro)}/${refA.file}`, asAlice, A, refA.file],
    ['A reference still', `/api/refs/${enc(ids.slugIntro)}/${refA.still}`, asAlice, A, refA.still],
    ['A fix preview', `/api/previews/${enc(ids.slugIntro)}/${fixA.file}`, asAlice, A, fixA.file],
    ['A recording', `/api/review/${enc(ids.slugIntro)}/recordings/${recA.id}/audio`, carolInA, A, `${recA.id}.m4a`],
    ['A playbook reference', `/api/playbook/refs/${pbRefA.file}?folder=Alpha`, asAlice, A, pbRefA.file],
    ['A skill file', '/api/playbook/skill/files?folder=Alpha&skill=alpha-export&name=preset.epr', asAlice, A, 'preset.epr'],
    ['A question’s file', `/api/asks/${askA.id}/files/${askAFile}`, asAlice, A, askAFile],
    ['A project file', `/api/files/${fileA.id}/download`, asAlice, A, fileA.sha256],
    ['B reference', `/api/refs/${enc(ids.slugB2)}/${ref.file}`, asBobS, B, ref.file],
    ['B reference still', `/api/refs/${enc(ids.slugB2)}/${ref.still}`, asBobS, B, ref.still],
    ['B fix preview', `/api/previews/${enc(ids.slugB2)}/${fix.file}`, asBobS, B, fix.file],
    ['B recording', `/api/review/${enc(ids.slugB2)}/recordings/${recording.id}/audio`, asBobS, B, `${recording.id}.m4a`],
    ['B playbook reference', `/api/playbook/refs/${pbRef.file}?folder=Bravo-only`, asBobS, B, pbRef.file],
    ['B skill file', '/api/playbook/skill/files?folder=Bravo-only&skill=bravo-export&name=preset.epr', asBobS, B, 'preset.epr'],
    ['B question’s file', `/api/asks/${askB.id}/files/${askBFile}`, asBobS, B, askBFile],
    ['B project file', `/api/files/${fileB.id}/download`, asBobS, B, fileB.sha256],
  ];
  for (const [what, url, who, w, name] of files) ids.ownFiles.push({ what, url, who, bytes: fileIn(w, name) });
});

/** A file of workspace `w` found by its name in its own trees (workspace #1's without the other workspaces' `w/`). */
function fileIn(w: string, name: string): Buffer {
  const root = paths.workspaceRoot(w);
  const found: string[] = [];
  const walk = (d: string, top: boolean) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (top && e.name === 'w') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), false);
      else if (e.name === name) found.push(path.join(d, e.name));
    }
  };
  for (const r of [root.data, root.cache]) walk(r, true);
  assert.equal(found.length >= 1, true, `${name} is in ${w}'s tree`);
  return fs.readFileSync(found[0] as string);
}

// ---------------------------------------------------------------- reading every route

/** What a route pattern is filled with: what exists in A, B's ids aimed at A, or one of B's own things by name. */
interface Values {
  slug: string;
  token: string;
  id: string;
  v: string;
  /** `:file` (else the note's screenshot, `<id>_clean.png`). */
  file?: string;
  /** A query string some routes read what they serve by (a playbook's folder, a skill's name). */
  query?: string;
  /** One of B's own things: what it is, and a made-up one of its shape to tell "served" from "any id answers so". */
  what?: string;
  control?: Values;
}

/** A route pattern filled with `values`. */
function fill(pattern: string, v: Values): string {
  return `${pattern
    .replace(/\{\*[a-z]+\}/gi, 'x/y')
    .replace(/:slug/g, enc(v.slug))
    .replace(/:token/g, v.token)
    .replace(/:id/g, v.id)
    .replace(/:file/g, v.file ?? `${v.id}_clean.png`)
    .replace(/:v/g, v.v)
    .replace(/:[a-z]+/gi, 'x')}${v.query ?? ''}`;
}

/** The same shape, nobody's: hex digits zeroed, the query's folder and names ones no workspace has. */
function madeUp(v: Values): Values {
  const zero = (s: string) => s.replace(/[0-9a-f]/g, '0');
  return {
    ...v,
    id: zero(v.id),
    ...(v.file ? { file: zero(v.file) } : {}),
    ...(v.query ? { query: v.query.replace(/Bravo-only|Alpha/g, 'Nowhere').replace(/bravo|alpha/g, 'nothing') } : {}),
  };
}
const methodsOf = (m: string) => (m === '*' ? ['GET'] : [m]);

/** One request that cuts streams after a moment (SSE, MCP's listen). */
function ask(method: string, url: string, headers: Record<string, string>, body?: string, cut = 600): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: 'review.test', ...headers };
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      h['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      let text = '';
      const done = () => resolve({ status: res.statusCode || 0, text });
      const timer = setTimeout(() => {
        req.destroy();
        done();
      }, cut);
      res.setEncoding('latin1');
      res.on('data', (d) => {
        if (text.length < 400_000) text += d;
      });
      res.on('end', () => {
        clearTimeout(timer);
        done();
      });
      res.on('error', () => done());
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e) }));
    req.end(body);
  });
}

/**
 * What a person in both workspaces may see of B in A: its name in the switcher (which workspaces they belong to) — in
 * the browser only: an API token acts in its one workspace and is told of no other (A12 WS-10).
 */
const SWITCHER = /^\/api\/(auth\/(status|me)|workspaces)$/;
const switcherOf = (who: string, pattern: string) => who.startsWith('carol') && who.endsWith('(session)') && SWITCHER.test(pattern);
/**
 * What the server's operator reads of B on their own pages (server/routes/operator.ts; Alice owns workspace #1, so she
 * runs this server): every workspace and account on it, on purpose — B's name and id, its people's names and addresses.
 * Nothing else of B (notes, links, invites, tokens, files), and to nobody else (Alice's token, Carol, B's people).
 */
/**
 * A person's own data, whichever workspace it is in (A13 PEOPLE-1): their export and what deleting their account takes,
 * in the browser only — Carol's own things in the other workspace (its name and id, her draft, her recording), nothing
 * else of it (nobody else's notes, links or people).
 */
const OWN_DATA = /^\/api\/auth\/me\/(export|deletion)$/;
const ownDataOf = (who: string, pattern: string, hers: string[]) =>
  who.startsWith('carol') && who.endsWith('(session)') && OWN_DATA.test(pattern) ? hers : [];
const OPERATOR = /^\/api\/operator\/(workspaces|accounts)(\/|$)/;
const operatorView = (who: string, pattern: string) => (who === 'alice (session)' && OPERATOR.test(pattern) ? ['bravo', B, ids.bob, 'bob@example.com'] : []);

/**
 * Every GET route read by `callers`, with their own ids (`own`), the other workspace's ids aimed at theirs, and each of
 * the other workspace's own things by its id, its file and its query beside a made-up one: what of the other workspace
 * showed (`leaks`), what it served where a made-up one isn't, and any 5xx. `answered`: the routes that answered `counted`
 * with its own ids.
 */
async function walkReads(o: {
  callers: Record<string, Record<string, string>>;
  own: Values;
  aimed: Values[];
  owned: Values[];
  leaks: (text: string, extra?: string[], sent?: string) => string[];
  /** What a caller may read of the other workspace on a route (a person in both: its name in their switcher). */
  allowed: (who: string, pattern: string) => string[];
  /** Words that are the caller's own on a route (Carol's draft and app, in her own export): taken out of the answer before it is searched, the rest still is. */
  theirs?: (who: string, pattern: string) => string[];
  counted: string;
}): Promise<{ problems: string[]; answered: Set<string> }> {
  const routes = registeredRoutes(app).filter(([m]) => m === 'GET' || m === '*' || m === 'HEAD');
  assert.ok(routes.length > 60, `${routes.length} routes`);
  const problems: string[] = [];
  const answered = new Set<string>();
  const asked = new Set<string>();
  const served = (s: number) => s >= 200 && s < 300;
  for (const [who, headers] of Object.entries(o.callers)) {
    for (const [m, pattern] of routes) {
      // A review link is its own credential: whoever holds the other's link sees it through it, by design. Not a way in.
      if (/^\/(api\/|media\/|data\/)?g\//.test(pattern)) continue;
      for (const method of methodsOf(m)) {
        for (const values of [o.own, ...o.aimed, ...o.owned]) {
          const url = fill(pattern, values);
          // a route that names none of it asks the same as before: once is enough
          if (asked.has(`${who} ${method} ${url}`)) continue;
          asked.add(`${who} ${method} ${url}`);
          const r = await ask(method, url, headers);
          if (r.status >= 500) problems.push(`${who} ${method} ${url} → ${r.status}`);
          if (values === o.own && who === o.counted && r.status < 300) answered.add(pattern);
          const allowed = o.allowed(who, pattern);
          const text = (o.theirs?.(who, pattern) ?? []).reduce((t, w) => t.split(w).join(''), r.text);
          const found = o.leaks(text, [], decodeURIComponent(url)).filter((s) => !allowed.includes(s));
          if (found.length) problems.push(`${who} ${method} ${url} → ${r.status}: shows ${found.join(', ')}`);
          // a picture or a file says nothing in words: what gives it away is that the other's is served where nobody's isn't
          if (values.control && served(r.status)) {
            const c = await ask(method, fill(pattern, values.control), headers);
            if (!served(c.status)) problems.push(`${who} ${method} ${url} → ${r.status}: serves the other's ${values.what} (a made-up one: ${c.status})`);
          }
        }
      }
    }
  }
  return { problems, answered };
}

test('every route read by a member of A (or by nobody), with A’s ids and with B’s: nothing of B, ever, and no 5xx', async () => {
  // Signed out too: sign-in, setup and /api/info run outside any workspace, where touching one is refused (a 5xx).
  const { problems, answered } = await walkReads({
    callers: { ...caller, 'nobody (signed out)': origin },
    own: { slug: ids.slugIntro, token: ids.linkA, id: ids.noteA, v: '1' },
    aimed: [
      { slug: ids.slugB2, token: ids.linkB, id: ids.notesB[1] as string, v: '1' },
      { slug: ids.slugIntro, token: ids.folderLinkB, id: ids.notesB[0] as string, v: '1' },
      { slug: ids.slugB2, token: ids.linkB, id: ids.inviteB, v: '1' },
      { slug: ids.slugB2, token: ids.linkB, id: ids.tokenIdB, v: '1' },
      { slug: ids.slugB2, token: ids.linkB, id: ids.bob, v: '1' },
      { slug: ids.slugB2, token: ids.linkB, id: B, v: '1' },
    ],
    owned: ids.ownedSets,
    leaks,
    allowed: (who, pattern) => [
      ...(switcherOf(who, pattern) ? ['bravo', B] : []),
      ...ownDataOf(who, pattern, ['bravo', B, ...ids.carolsInB]),
      ...operatorView(who, pattern),
    ],
    counted: 'alice (session)',
  });
  assert.deepEqual(problems, [], `B showed to A, or a route failed:\n${problems.join('\n')}`);
  // the walk read real things: most routes answered A with data
  assert.ok(answered.size >= 50, `only ${answered.size} routes answered A`);
});

// The same walk from the other side (A12 VE2b-7). A is workspace #1, whose paths are the store's own (DATA, CACHE,
// rootStorage()): a read in B that falls back to them — or to DEFAULT_WORKSPACE's members, apps or files — shows A's
// things to B's people, which the walk from A can never see. B's people ask with B's ids, with A's aimed at B, and for
// each of A's own things by name (on the video both hold, where a file check is reached).
test('every route read by B’s people, with B’s ids and with A’s: nothing of A, ever (workspace #1 is no fallback)', async () => {
  const name = ws.getWorkspace(A)?.name ?? '';
  const { problems, answered } = await walkReads({
    callers: callerB,
    own: { slug: ids.slugB2, token: ids.linkB, id: ids.notesB[1] as string, v: '1' },
    aimed: [
      { slug: ids.slugA2, token: ids.linkA, id: ids.noteA, v: '1' },
      { slug: ids.slugIntro, token: ids.folderLinkA, id: ids.noteA, v: '1' },
      { slug: ids.slugA2, token: ids.linkA, id: ids.inviteA, v: '1' },
      { slug: ids.slugA2, token: ids.linkA, id: ids.tokenIdA, v: '1' },
      { slug: ids.slugA2, token: ids.linkA, id: ids.alice, v: '1' },
    ],
    owned: ids.ownedSetsA,
    leaks: leaksOf(secretsOfA),
    allowed: (who, pattern) => [...(switcherOf(who, pattern) ? [name.toLowerCase()] : []), ...ownDataOf(who, pattern, [name.toLowerCase(), ...ids.carolsInA])],
    // A's marker word is in what Carol wrote and allowed there herself; anywhere else in her export it is A's
    theirs: (who, pattern) => ownDataOf(who, pattern, ['ALPHA carol draft', 'ALPHA carol app']),
    counted: 'bob (session)',
  });
  assert.deepEqual(problems, [], `A showed to B, or a route failed:\n${problems.join('\n')}`);
  assert.ok(answered.size >= 50, `only ${answered.size} routes answered B`);
});

test('each workspace’s people read their own files, byte for byte: references, previews, recordings, playbook files, transcripts', async () => {
  const problems: string[] = [];
  for (const f of ids.ownFiles) {
    const got = await fetchBytes(f.url, f.who);
    if (sha(got) !== sha(f.bytes))
      problems.push(`${f.what}: ${got.length} bytes served, not its own ${f.bytes.length} (${got.toString('latin1').slice(0, 120)})`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  // the render both hold, heard in each: A's in Swedish (A's own words), B's in English
  const words = async (headers: Record<string, string>) =>
    JSON.stringify((await request('GET', `/api/review/${enc(ids.slugIntro)}/transcript`, { headers })).json().transcript ?? null);
  assert.match(await words(caller['alice (session)'] as Record<string, string>), /ALPHA/);
  const inB = await words(callerB['bob (session)'] as Record<string, string>);
  assert.match(inB, /Every/);
  assert.doesNotMatch(inB, /ALPHA/);
});

test('snoozes are kept by their workspace: B’s in B’s for-you.json, A’s in A’s, neither in the other', () => {
  const snoozedIn = (w: string): Record<string, Record<string, unknown>> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(paths.workspaceRoot(w).data, 'for-you.json'), 'utf8'))['@snoozed'] ?? {};
    } catch {
      return {};
    }
  };
  const keysIn = (w: string) => Object.values(snoozedIn(w)).flatMap((v) => Object.keys(v));
  const inA = keysIn(A);
  const inB = keysIn(B);
  assert.equal(ids.snoozedB.length, 2);
  for (const k of ids.snoozedB) {
    assert.ok(inB.includes(k), `B's snooze ${k} is stored in B: ${JSON.stringify(snoozedIn(B))}`);
    assert.ok(!inA.includes(k), `B's snooze ${k} is not in A`);
  }
  assert.ok(ids.snoozedA.length >= 1);
  for (const k of ids.snoozedA) {
    assert.ok(inA.includes(k), `A's snooze ${k} is stored in A: ${JSON.stringify(snoozedIn(A))}`);
    assert.ok(!inB.includes(k), `A's snooze ${k} is not in B`);
  }
});

test('a person in both workspaces sees B only in the switcher, and only as one of their own', async () => {
  const s = (await request('GET', '/api/auth/status', { headers: caller['carol in A (session)'] })).json();
  assert.equal(s.workspace.id, A);
  assert.equal(s.user.role, 'reviewer', 'her role in A');
  assert.deepEqual(s.workspaces.map((w: { id: string }) => w.id).sort(), [A, B].sort());
  // Alice (A only) never hears of B at all
  const a = (await request('GET', '/api/workspaces', { headers: caller['alice (session)'] })).json();
  assert.deepEqual(
    a.workspaces.map((w: { id: string }) => w.id),
    [A],
  );
  // Carol's API token for A acts in A and is told of A alone: an agent given it learns nothing of her other teams (WS-10)
  const token = caller['carol in A (token)'] as Record<string, string>;
  for (const url of ['/api/auth/status', '/api/auth/me', '/api/workspaces']) {
    const r = (await request('GET', url, { headers: token })).json();
    assert.deepEqual(
      r.workspaces.map((w: { id: string }) => w.id),
      [A],
      url,
    );
  }
});

test('storage keys and the disk (before anyone in A writes): B’s files live under w/<B>/ only; A’s tree holds nothing of B', () => {
  const root = paths.workspaceRoot(B);
  assert.ok(fs.existsSync(path.join(root.versions, ids.slugIntro, 'v1.mp4')));
  assert.ok(fs.existsSync(path.join(root.versions, ids.slugB2, 'v1.mp4')));
  assert.ok(fs.existsSync(path.join(root.data, ids.slugB2, 'review.json')));
  // A's writes aimed at B's slug may leave an empty folder behind in A (a lock taken before the 404); nothing of B's
  assert.deepEqual(
    fs.existsSync(path.join(paths.DATA, ids.slugB2)) ? fs.readdirSync(path.join(paths.DATA, ids.slugB2), { recursive: true }) : [],
    [],
    'nothing of B in A’s data',
  );
  const problems: string[] = [];
  const bVersion = sha(fs.readFileSync(path.join(root.versions, ids.slugB2, 'v1.mp4')));
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      // what belongs to no workspace: accounts, invites, OAuth, the workspace list, the link index and backups
      if (e.isDirectory()) {
        if ((d === paths.DATA || d === paths.CACHE || d === paths.VERSIONS) && ['w', 'backups', 'uploads', 'oauth'].includes(e.name)) continue;
        walk(f);
        continue;
      }
      if (d === paths.DATA && ['users.json', 'invites.json', 'workspaces.json', 'links.json'].includes(e.name)) continue;
      if (ids.notesB.some((id) => e.name.includes(id))) problems.push(`a file named after B's note: ${f}`);
      const buf = fs.readFileSync(f);
      if (/\.(json|jsonl|md|txt)$/.test(e.name)) {
        const found = leaks(buf.toString('utf8'));
        if (found.length) problems.push(`${f}: ${found.join(', ')}`);
      }
      if (sha(buf) === bVersion) problems.push(`B's render bytes in A's tree: ${f}`);
    }
  };
  for (const r of [paths.DATA, paths.CACHE, paths.VERSIONS]) walk(r);
  assert.deepEqual(problems, [], problems.join('\n'));
  // the account file knows Bob (accounts belong to no workspace) and the workspace list names B: both global, 0600
  for (const f of ['users.json', 'workspaces.json', 'links.json']) assert.equal(fs.statSync(path.join(paths.DATA, f)).mode & 0o777, 0o600, f);
});

test('writes aimed at B’s ids from A (or from nobody) change nothing in B, and none fails with a 5xx', async () => {
  const snapshot = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.name === '.lock' || e.name.endsWith('.tmp')) continue;
        if (e.isDirectory()) walk(f);
        else out.push(`${f}:${crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')}`);
      }
    };
    walk(paths.workspaceRoot(B).data);
    walk(paths.workspaceRoot(B).versions);
    return out.sort().join('\n');
  };
  const before = snapshot();
  const writes = registeredRoutes(app).filter(([m]) => ['POST', 'PUT', 'PATCH', 'DELETE', '*'].includes(m));
  const problems: string[] = [];
  // B's ids, and each of B's own things by its id and file (an app, a token, a draft, a recording, a preview…)
  const aimed: Values[] = [
    { slug: ids.slugB2, token: ids.linkB, id: ids.notesB[1] as string, v: '1' },
    { slug: ids.slugB2, token: ids.folderLinkB, id: ids.inviteB, v: '1' },
    { slug: ids.slugB2, token: ids.linkB, id: ids.tokenIdB, v: '1' },
    { slug: ids.slugB2, token: ids.linkB, id: ids.bob, v: '1' },
    ...ids.ownedSets.map(({ control: _c, ...v }) => v),
  ];
  const seen = new Set<string>();
  for (const [who, headers] of Object.entries({ ...caller, 'nobody (signed out)': origin })) {
    for (const [m, pattern] of writes) {
      if (/^\/(api\/|media\/|data\/)?g\//.test(pattern) || pattern === '/api/auth/logout' || pattern === '/api/auth/logout-everywhere') continue;
      // the server's operator sets plans and disables accounts in any workspace on purpose (operator-admin.test.ts);
      // everyone else is walked through those routes like any other
      if (who === 'alice (session)' && OPERATOR.test(pattern)) continue;
      for (const method of m === '*' ? ['POST', 'PUT', 'PATCH', 'DELETE'] : [m]) {
        for (const values of aimed) {
          const url = fill(pattern, values);
          if (seen.has(`${who} ${method} ${url}`)) continue;
          seen.add(`${who} ${method} ${url}`);
          const bodies = [
            '{}',
            JSON.stringify({ text: 'x', status: 'fixed', id: B, slug: values.slug, keys: [values.id], folder: 'Bravo-only', role: 'admin' }),
          ];
          for (const body of bodies) {
            const r = await ask(method, url, headers, body);
            if (r.status >= 500) problems.push(`${who} ${method} ${url} ${body} → ${r.status}`);
            const found = leaks(r.text, [], decodeURIComponent(url) + body);
            if (found.length) problems.push(`${who} ${method} ${url} → ${r.status}: shows ${found.join(', ')}`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.equal(snapshot(), before, 'B’s store is exactly as it was');
  // …and what B's people hold outside its tree: their apps and tokens there
  assert.equal(oauth.listApps(ids.bob, B).length, 1, 'Bob’s app in B');
  assert.equal(oauth.listApps(ids.carol, B).length, 1, 'Carol’s app in B');
  assert.ok(
    auth.listTokens(ids.carol).some((t) => ids.ownedB.includes(t.id)),
    'Carol’s token in B',
  );
  // B is still whole: Bob sees his notes, links, invite and token
  const bob = await signIn('bob@example.com');
  const answer = await request('GET', `/api/review/${enc(ids.slugB2)}`, { headers: { Cookie: bob } });
  assert.equal(answer.status, 200, answer.text);
  assert.ok(answer.json().review.comments.some((c: { text: string }) => c.text === 'BRAVO note two'));
  assert.equal(ws.roleIn(B, ids.carol), 'owner');
});

/**
 * The kinds of files a tree holds: each file as its folders and name, with slugs, ids and hashes written as what they
 * are — the tree's shape, not its names (`<slug>/refs/r_#.png`, `transcripts/#.json`).
 */
function kindsOf(root: string, skip: (rel: string) => boolean = () => false): Set<string> {
  const shape = (seg: string) =>
    seg.startsWith('__')
      ? '<slug>'
      : seg
          .replace(/[0-9a-f]{6,}/gi, '#')
          // a store's shards by the first two hex characters of a hash (project files' blobs and their index)
          .replace(/^[0-9a-f]{2}(?=\.json$|$)/, '#')
          .replace(/^([a-z]+)_[A-Za-z0-9-]+/, '$1_#')
          .replace(/#[#_-]*#/g, '#');
  const out = new Set<string>();
  const walk = (d: string, rel: string[]) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // lock folders and temporary files come and go with the work
      if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
      const here = [...rel, e.name];
      if (skip(here.join('/'))) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), here);
      else out.add(here.map(shape).join('/'));
    }
  };
  walk(root, []);
  return out;
}
/** Waits until no background job (posters, transcripts, checks, recordings) is queued or running. */
async function settled() {
  for (let quiet = 0, i = 0; quiet < 3 && i < 600; i++) {
    quiet = jobs.queued() === 0 ? quiet + 1 : 0;
    await sleep(100);
  }
}

test('B holds every kind of file A holds: a feature stored in A alone would be one the walks never look for in B', async () => {
  // B is read the way A was by the route walk (its own people, its own ids), so what reading makes (posters, sprites,
  // checks, transcripts) is there too.
  const bob = { Cookie: await signIn('bob@example.com'), ...origin };
  for (const [m, pattern] of registeredRoutes(app))
    if ((m === 'GET' || m === '*') && !/^\/(api\/|media\/|data\/)?g\//.test(pattern))
      await ask('GET', fill(pattern, { slug: ids.slugIntro, token: ids.linkB, id: ids.notesB[0] as string, v: '1' }), bob);
  await settled();
  // What belongs to no workspace lives in A's root (workspace #1's): accounts, invites, links, keys, mail, OAuth grants,
  // people's pictures, helper binaries, the other workspaces' trees, backups and uploads in flight, the erasure log.
  const global = (rel: string) =>
    /^(w|backups|uploads|mail|outbox|models|push|oauth|avatars|bin)(\/|$)/.test(rel) ||
    /^(users|invites|workspaces|links|account-links|oauth[\w-]*|push[\w-]*)\.json$|\.key$|^erasures\.jsonl$/.test(rel);
  const a = paths.workspaceRoot(A);
  const b = paths.workspaceRoot(B);
  const missing: string[] = [];
  const ofB: string[] = [];
  for (const [where, ra, rb] of [
    ['data', a.data, b.data],
    ['cache', a.cache, b.cache],
    ['versions', a.versions, b.versions],
  ] as const) {
    const inA = kindsOf(ra, global);
    const inB = kindsOf(rb);
    for (const k of inA) if (!inB.has(k)) missing.push(`${where}/${k}`);
    for (const k of inB) ofB.push(`${where}/${k}`);
  }
  assert.deepEqual(missing, [], `A holds kinds of files B doesn't — give B one of each in the setup above:\n${missing.join('\n')}`);
  // …and B keeps what it was given for the walks: everything a workspace stores of its own.
  for (const kind of [
    /\/refs\//,
    /\/recordings\//,
    /\/previews\//,
    /\/drafts\//,
    /playbooks\/.*skills\//,
    /transcripts\//,
    /for-you\.json$/,
    /^data\/files\/sha256\//,
  ])
    assert.ok(
      ofB.some((k) => kind.test(k)),
      `B holds no ${kind}:\n${ofB.join('\n')}`,
    );
});

test('the live stream: while B worked, A’s people heard nothing of it', async () => {
  assert.match(heard.alice as string, /retry: 2000/, 'the stream was open');
  for (const [who, s] of Object.entries(heard)) {
    assert.deepEqual(leaks(s), [], `${who}'s stream showed B`);
    const events = [...s.matchAll(/^event: (\S+)/gm)].map((m) => m[1] as string);
    // A's own background (posters, checks of A's videos) may still speak; nothing B did may
    const fromB = events.filter((e) => !['poster', 'analysis', 'qa', 'qa-progress', 'diff', 'sprite', 'transcript'].includes(e));
    assert.deepEqual(fromB, [], `${who} heard B's ${fromB.join(', ')}`);
  }
});

test('file URLs: B’s screenshots, renders, posters and previews are not found from A; the shared slug serves A’s own', async () => {
  for (const headers of [caller['alice (session)'], caller['alice (token)']]) {
    for (const id of ids.notesB) {
      for (const slug of [ids.slugIntro, ids.slugB2]) {
        assert.equal((await ask('GET', `/data/${enc(slug)}/${id}_clean.png`, headers)).status, 404, `${slug} ${id}`);
        assert.equal((await ask('GET', `/data/${enc(slug)}/${id}_marked.png`, headers)).status, 404);
      }
    }
    assert.equal((await ask('GET', `/api/review/${enc(ids.slugB2)}`, headers)).status, 404);
    assert.equal((await ask('GET', `/media/${enc(ids.slugB2)}/v1`, headers)).status, 404);
  }
  // the same slug (and the same bytes) is two videos: each workspace's player gets its own copy and its own notes —
  // never one file both point at, which a change or a removal in one would reach in the other
  const bob = await signIn('bob@example.com');
  const aFile = path.join(paths.VERSIONS, ids.slugIntro, 'v1.mp4');
  const bFile = path.join(paths.VERSIONS, 'w', B, ids.slugIntro, 'v1.mp4');
  const aBytes = await fetchBytes(`/media/${enc(ids.slugIntro)}/v1`, caller['alice (session)']);
  const bBytes = await fetchBytes(`/media/${enc(ids.slugIntro)}/v1`, { Cookie: bob });
  assert.ok(aBytes.length > 1000 && bBytes.length > 1000);
  assert.equal(sha(aBytes), sha(fs.readFileSync(aFile)));
  assert.equal(sha(bBytes), sha(fs.readFileSync(bFile)));
  assert.notEqual(fs.statSync(aFile).ino, fs.statSync(bFile).ino, 'two files, not one shared');
  const notesOf = async (headers: Record<string, string>) =>
    (await request('GET', `/api/review/${enc(ids.slugIntro)}`, { headers }))
      .json()
      .review.comments.map((c: { text: string }) => c.text)
      .join(' | ');
  assert.match(await notesOf(caller['alice (session)'] as Record<string, string>), /ALPHA/);
  assert.doesNotMatch(await notesOf(caller['alice (session)'] as Record<string, string>), /BRAVO/);
  assert.match(await notesOf({ Cookie: bob }), /BRAVO/);
  // B's own render, different bytes: B's player gets B's file
  const b2Bytes = await fetchBytes(`/media/${enc(ids.slugB2)}/v1`, { Cookie: bob });
  assert.equal(sha(b2Bytes), sha(fs.readFileSync(path.join(paths.VERSIONS, 'w', B, ids.slugB2, 'v1.mp4'))));
});

test('the browser’s cache keeps the same URL apart per session: what a session reads varies by its cookie', async () => {
  const varies = (url: string, headers: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, headers: { Host: 'review.test', ...headers }, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(String(res.headers.vary || '')));
      });
      req.on('error', reject);
      req.end();
    });
  // immutable answers under a slug and a version number both workspaces use
  for (const url of [`/media/${enc(ids.slugIntro)}/v1`, `/api/waveform/${enc(ids.slugIntro)}/1`, `/api/poster/${enc(ids.slugIntro)}.jpg`, '/api/library'])
    assert.match(await varies(url, caller['alice (session)']), /\bCookie\b/i, url);
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function fetchBytes(url: string, headers: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: { Host: 'review.test', ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

test('review links: A’s links show A’s video under the shared slug and never reach B’s; B’s link resolves in B', async () => {
  const a = (await request('GET', `/api/g/${ids.folderLinkA}`)).json();
  assert.deepEqual(leaks(JSON.stringify(a)), []);
  const aVideo = (await request('GET', `/api/g/${ids.linkA}`)).json();
  assert.deepEqual(leaks(JSON.stringify(aVideo)), []);
  // B's link, opened by anyone, is B's (its own workspace first) — never A's video of the same name
  const b = await request('GET', `/api/g/${ids.folderLinkB}`);
  assert.equal(b.status, 200, b.text);
  assert.match(b.text, /bravo-cut/);
  assert.doesNotMatch(b.text, /ALPHA/);
});

// ---------------------------------------------------------------- MCP with A's token

async function mcp(token: string, method: string, params: object = {}): Promise<string> {
  const r = await ask(
    'POST',
    '/mcp',
    { Authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    // an MCP answer ends by itself: waited for whole (a clip reference or a wait takes a moment on a busy machine)
    15_000,
  );
  return r.text;
}

test('every MCP tool with A’s API token, aimed at B’s videos, notes and folders: nothing of B', async () => {
  const token = (caller['alice (token)'].Authorization as string).slice('Bearer '.length);
  const list = await mcp(token, 'tools/list');
  const tools = (
    JSON.parse(list.slice(list.indexOf('{'))) as {
      result: { tools: { name: string; inputSchema: { properties?: Record<string, { type?: string; enum?: string[] }> } }[] };
    }
  ).result.tools;
  assert.ok(tools.length > 15, `${tools.length} tools`);
  const problems: string[] = [];
  for (const tool of tools) {
    for (const target of [ids.slugB2, ids.slugIntro, 'Bravo-only', 'bravo-cut.mp4']) {
      const args: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (/video|slug|path|file|of$/.test(name)) args[name] = target;
        else if (/^(id|note|comment|comment_id|note_id)$/.test(name)) args[name] = ids.notesB[1];
        else if (/folder|scope/.test(name)) args[name] = 'Bravo-only';
        else if (p.enum?.length) args[name] = p.enum[0];
        else if (p.type === 'number' || p.type === 'integer') args[name] = name.includes('timeout') ? 1 : 1;
        else if (p.type === 'boolean') args[name] = false;
        else if (p.type === 'array') args[name] = [];
        else if (p.type === 'string') args[name] = 'x';
      }
      const text = await mcp(token, 'tools/call', { name: tool.name, arguments: args });
      const found = leaks(text, [], JSON.stringify(args));
      if (found.length) problems.push(`${tool.name}(${JSON.stringify(args)}): ${found.join(', ')}`);
    }
  }
  for (const uri of ['vr://inbox', `vr://review/${ids.slugB2}`, `vr://review/${ids.slugIntro}`]) {
    const found = leaks(await mcp(token, 'resources/read', { uri }), [], uri);
    if (found.length) problems.push(`${uri}: ${found.join(', ')}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

/** The text of a tools/call answer (JSON, or one SSE message). */
function toolText(raw: string): { text: string; isError: boolean } {
  const msg = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (msg.error) return { text: msg.error.message, isError: true };
  return { text: (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!msg.result?.isError };
}

test('an MCP write naming a path: refused alike whether or not a file is there; nothing tracked, nothing of B served', async () => {
  // Paths a member of A could know or guess: B's render on this disk (also with dot segments, and relative to where the
  // server runs), the account file, any file of the machine, and nothing at all. A path means something to the machine
  // itself only (stdio, loopback); to anyone else it is an unknown name, whatever is there.
  const bRender = path.join(paths.workspaceRoot(B).versions, ids.slugB2, 'v1.mp4');
  assert.ok(fs.existsSync(bRender), 'B’s render is on this disk');
  const probes = [
    bRender,
    `${paths.VERSIONS}/${ids.slugIntro}/../w/${B}/${ids.slugB2}/v1.mp4`,
    path.relative(process.cwd(), bRender),
    path.join(paths.DATA, 'users.json'),
    '/etc/hosts',
    path.join(paths.DATA, 'no-such-render.mp4'),
  ];
  const reviewed = () =>
    fs
      .readdirSync(paths.DATA)
      .filter((d) => fs.existsSync(path.join(paths.DATA, d, 'review.json')))
      .sort();
  const before = reviewed();
  // Every tool that takes a video, with what it needs besides.
  const calls: [string, (p: string) => Record<string, unknown>][] = [
    ['add_note', (p) => ({ video: p, frame: 0, text: 'x' })],
    ['get_frame', (p) => ({ video: p, frame: 0 })],
    ['get_open_notes', (p) => ({ video: p })],
    ['get_transcript', (p) => ({ video: p })],
    ['get_taste', (p) => ({ video: p })],
    ['get_playbook', (p) => ({ video: p })],
    ['show_review', (p) => ({ video: p })],
    ['review_frame', (p) => ({ video: p, frame: 0 })],
    ['request_upload', (p) => ({ filename: 'x.mp4', video: p })],
    ['set_render_source', (p) => ({ video: p, app: 'x' })],
    ['move_video', (p) => ({ video: p, folder: 'Somewhere' })],
    ['set_status', (p) => ({ video: p, text: 'x' })],
    ['wait_for_feedback', (p) => ({ video: p, timeout_s: 0 })],
    ['attach_reference', (p) => ({ id: ids.noteA, video: p, frame: 0 })],
    ['ask_options', (p) => ({ video: p, text: 'x', groups: [{ id: 'g', items: [{ id: 'a' }, { id: 'b' }] }] })],
    ['draft_post', (p) => ({ video: p, platform: 'youtube', title: 'x' })],
    ['get_posts', (p) => ({ video: p })],
    // an option's file named by a path: refused before anything is looked up
    ['ask_options', (p) => ({ folder: 'Alpha', text: 'x', groups: [{ id: 'g', items: [{ id: 'a', path: p }, { id: 'b' }] }] })],
  ];
  const problems: string[] = [];
  for (const who of ['alice (token)', 'carol in A (token)']) {
    const token = String(caller[who]?.Authorization).slice('Bearer '.length);
    const list = await mcp(token, 'tools/list');
    const listed = (JSON.parse(list.slice(list.indexOf('{'), list.lastIndexOf('}') + 1)) as { result: { tools: { name: string }[] } }).result.tools;
    assert.ok(!listed.some((t) => t.name === 'track_video'), `${who}: tracking a path is the machine's`);
    for (const [name, args] of calls) {
      const answers = new Set<string>();
      for (const p of probes) {
        const r = toolText(await mcp(token, 'tools/call', { name, arguments: args(p) }));
        if (!r.isError) problems.push(`${who} ${name}(${p}) was taken: ${r.text.slice(0, 160)}`);
        // An answer may repeat what was asked; past that, the same words for every path, whatever is behind it.
        answers.add(r.text.split(p).join('<path>'));
        const found = leaks(r.text, [], p);
        if (found.length) problems.push(`${who} ${name}(${p}) shows ${found.join(', ')}`);
      }
      if (answers.size !== 1) problems.push(`${who} ${name}: ${answers.size} different answers:\n  ${[...answers].join('\n  ')}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(reviewed(), before, 'nothing was put under review in A');
  for (const p of probes)
    for (const who of ['alice (token)', 'carol in A (token)'])
      assert.equal(
        (await ask('GET', `/media/${enc(paths.slugify(path.resolve(p)))}/v1`, caller[who] as Record<string, string>)).status,
        404,
        `${who}: no bytes of ${p}`,
      );
});

test('what A reads about its own work names no path on this server: review.md over HTTP and MCP, a clip reference', async () => {
  // A clip as a reference on A's note, so get_note says where it plays.
  const clip = makeVideo(path.join(dir, 'a/like-this.mp4'), { dur: 1, pattern: 'testsrc2' });
  const ref = await request('POST', `/api/comments/${ids.noteA}/refs`, {
    body: { kind: 'clip', data: fs.readFileSync(clip).toString('base64') },
    headers: caller['alice (session)'],
  });
  assert.equal(ref.status, 200, ref.text);
  const answers: Record<string, string> = {};
  for (const who of ['alice (session)', 'alice (token)', 'carol in A (token)'])
    answers[`${who} GET review.md`] = (await ask('GET', `/api/review/${enc(ids.slugIntro)}/md`, caller[who] as Record<string, string>)).text;
  for (const who of ['alice (token)', 'carol in A (token)']) {
    const token = String(caller[who]?.Authorization).slice('Bearer '.length);
    answers[`${who} vr://review`] = await mcp(token, 'resources/read', { uri: `vr://review/${ids.slugIntro}` });
    answers[`${who} get_note`] = toolText(await mcp(token, 'tools/call', { name: 'get_note', arguments: { id: ids.noteA } })).text;
  }
  const problems = Object.entries(answers).filter(([, text]) => text.includes(dir) || text.includes(paths.DATA));
  assert.deepEqual(
    problems.map(([what, text]) => `${what}: ${text.slice(0, 400)}`),
    [],
  );
  // …and still says where things are: the screenshots and the data as URLs, the clip where it plays.
  assert.match(
    answers['alice (token) GET review.md'] as string,
    new RegExp(`- marked: /data/${enc(ids.slugIntro).replace(/[%.]/g, '\\$&')}/${ids.noteA}_marked\\.png`),
  );
  assert.match(answers['alice (token) GET review.md'] as string, /- json: \/api\/review\//);
  assert.match(answers['alice (token) get_note'] as string, /play it: \/api\/refs\//);
});

test('wait_for_feedback with A’s token hears nothing while B works', async () => {
  const token = (caller['alice (token)'].Authorization as string).slice('Bearer '.length);
  const waiting = mcp(token, 'tools/call', { name: 'wait_for_feedback', arguments: { timeout: 3 } });
  await sleep(300);
  const bob = await signIn('bob@example.com');
  ok(
    await request('POST', `/api/review/${enc(ids.slugB2)}/comments`, { body: { frame: 4, text: 'BRAVO while A waits' }, headers: { Cookie: bob, ...origin } }),
    'B note',
  );
  const text = await waiting;
  assert.deepEqual(leaks(text, ['while A waits']), []);
});

// ---------------------------------------------------------------- roles per workspace

test('the route walk with roles per workspace: Carol owns B but is a reviewer in A, and A’s routes treat her as one', async () => {
  const problems: string[] = [];
  const valuesA = { slug: ids.slugA2, token: ids.linkA, id: ids.noteA, v: '1' };
  for (const [m, pattern] of registeredRoutes(app)) {
    if (/^\/(api\/|media\/|data\/)?g\/|^\/(oauth|\.well-known|mcp|healthz|readyz)/.test(pattern)) continue;
    for (const method of m === '*' ? ['GET', 'POST'] : m === 'HEAD' ? [] : [m]) {
      const url = fill(pattern, valuesA);
      const { rule } = ruleFor(method, url);
      if (rule === 'self' || rule === 'public' || rule === 'none' || can('reviewer', rule)) continue;
      for (const who of ['carol in A (session)', 'carol in A (token)']) {
        const r = await ask(method, url, caller[who] as Record<string, string>, ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? '{}' : undefined);
        // the project files are the one thing a role doesn't see at all: nothing there (404), never "not for you"
        if (r.status !== (rule === 'files' || rule === 'files-write' ? 404 : 403)) problems.push(`${who} ${method} ${url} (needs ${rule}) → ${r.status}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  // in B she is an owner: the same routes let her through there
  const carolB = await signIn('carol@example.com', B);
  assert.equal((await request('GET', '/api/admin/users', { headers: { Cookie: carolB } })).status, 200);
  assert.equal((await request('GET', '/api/admin/users', { headers: caller['carol in A (session)'] })).status, 403);
});
