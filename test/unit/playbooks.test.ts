// Playbooks (lib/playbooks.ts): the House's and every folder's, inherited down the tree with the deeper one winning;
// revisions with what changed; skills in the SKILL.md format with small files that are served as downloads; agents'
// suggestions a person accepts or rejects (and the inbox shows them to people who may decide); renders stamped with
// the revisions they were made with; playbooks that move with their folders; and who may do what over HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const playbooks = await import('../../lib/playbooks.ts');
const text = await import('../../lib/playbookText.ts');
const files = await import('../../lib/playbookFiles.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const auth = await import('../../lib/auth.ts');
const { forYou } = await import('../../lib/foryou.ts');
const { DATA } = await import('../../lib/paths.ts');

function track(rel: string, folder: string | null): { slug: string; file: string } {
  const file = makeVideo(path.join(dir, rel), { w: 160, h: 90, dur: 1 });
  age(file);
  store.createOrGetReview(file, { by: 'tester' });
  const slug = slugOf(file);
  if (folder) folders.moveVideo(slug, folder, 'tester');
  return { slug, file };
}
const reel = track('acme/export/reel.mp4', 'Acme/Reels');
const loose = track('misc/export/loose.mp4', null);
folders.createFolder('Globex');

// ---------------------------------------------------------------- SKILL.md and diffs (browser-safe)

test('SKILL.md: frontmatter and body round-trip, other frontmatter lines are kept, the naming rule holds', () => {
  const md = '---\nname: export-reels\ndescription: "Export 9:16 reels: H.264, -14 LUFS"\nlicense: MIT\n---\n\n# Export\n\n1. Render the comp.\n';
  const s = text.parseSkill(md);
  assert.deepEqual(
    { name: s.name, description: s.description, extra: s.extra, body: s.body },
    { name: 'export-reels', description: 'Export 9:16 reels: H.264, -14 LUFS', extra: 'license: MIT', body: '# Export\n\n1. Render the comp.' },
  );
  assert.deepEqual(text.parseSkill(text.skillMarkdown(s)), s, 'what it writes reads back the same');
  assert.throws(() => text.parseSkill('no frontmatter'), /frontmatter/);
  assert.equal(text.skillProblem({ name: 'Export_Reels', description: 'x', body: '' })?.includes('lowercase'), true);
  assert.equal(text.skillProblem({ name: 'export--reels', description: 'x', body: '' })?.includes('lowercase'), true, 'no double hyphen');
  assert.equal(text.skillProblem({ name: 'ok-1', description: '', body: '' })?.includes('description'), true);
  assert.equal(text.skillProblem({ name: 'ok-1', description: 'Does it.', body: '' }), null);
});

test('line diff: what a change adds and removes, in order', () => {
  const d = text.lineDiff('- a\n- b\n- c', '- a\n- c\n- d');
  assert.deepEqual(
    d.map((l) => `${l.op[0]}${l.text}`),
    ['s- a', 'd- b', 's- c', 'a- d'],
  );
  assert.deepEqual(text.diffStat(d), { add: 1, del: 1 });
  assert.deepEqual(
    text.lineDiff(null, 'x').map((l) => l.op),
    ['add'],
  );
});

// ---------------------------------------------------------------- inheritance and revisions

test('the House and each folder down the tree: agents read the deepest first, each part says where it comes from', () => {
  playbooks.writeText('', 'rules', '- Logo always bottom right\n- Captions in Inter', { by: 'Sam' });
  playbooks.writeText('Acme', 'brief', 'A running-shoe brand for beginners; warm, honest, never salesy.', { by: 'Sam' });
  playbooks.writeText('Acme/Reels', 'rules', '- 9:16, at most 60 s\n- Logo top left on reels (overrides the House)', { by: 'Sam' });
  assert.deepEqual(files.chainOf('Acme/Reels'), ['', 'Acme', 'Acme/Reels']);
  const md = playbooks.agentMarkdown('Acme/Reels');
  assert.match(md, /^# Playbook: Acme\/Reels/);
  assert.match(md, /Layers, deepest first: Acme\/Reels r1 · Acme r1 · House r1/);
  const rules = md.slice(md.indexOf('## Rules'));
  assert.ok(rules.indexOf('From Acme/Reels') < rules.indexOf('From House'), 'the folder before the House');
  assert.match(md, /## Brief[\s\S]*From Acme \(revision 1\)[\s\S]*running-shoe/);
  const view = playbooks.playbookView('Acme/Reels');
  assert.deepEqual(
    view.layers.map((l) => l.scope),
    ['', 'Acme'],
  );
  assert.deepEqual(view.stamp, [
    { scope: '', rev: 1 },
    { scope: 'Acme', rev: 1 },
    { scope: 'Acme/Reels', rev: 1 },
  ]);
  assert.match(playbooks.agentMarkdown('Globex'), /From House/, 'a folder without its own playbook still gets the House');
});

test('every save is a revision with what it changed; an edit from an older revision is refused only when that section changed since', () => {
  const r2 = playbooks.writeText('Globex', 'brief', 'Launch films for Globex.', { by: 'Sam', message: 'First brief' });
  assert.equal(r2?.rev, 1);
  assert.equal(r2?.message, 'First brief');
  assert.equal(playbooks.writeText('Globex', 'brief', 'Launch films for Globex.', { by: 'Sam' }), null, 'nothing changed, no revision');
  playbooks.writeText('Globex', 'rules', '- No lens flares', { by: 'Mia', base_rev: 1 });
  // Sam opened revision 1, Mia changed the rules since: Sam's brief is fine, Sam's rules would overwrite hers.
  assert.equal(playbooks.writeText('Globex', 'brief', 'Launch films for Globex, B2B.', { by: 'Sam', base_rev: 1 })?.rev, 3);
  assert.throws(
    () => playbooks.writeText('Globex', 'rules', '- Lens flares ok', { by: 'Sam', base_rev: 1 }),
    (e: { status: number; message: string }) => e.status === 409 && /Mia changed this/.test(e.message),
  );
  const h = playbooks.loadPlaybook('Globex').history;
  assert.deepEqual(
    h.map((x) => [x.rev, x.section, x.by]),
    [
      [1, 'brief', 'Sam'],
      [2, 'rules', 'Mia'],
      [3, 'brief', 'Sam'],
    ],
  );
  assert.equal(h[2].before, 'Launch films for Globex.');
  assert.equal(h[2].after, 'Launch films for Globex, B2B.');
});

test('skills: the deepest of a name wins; a rename keeps the skill (and its files); deleting takes the files', async () => {
  const skill = (name: string, description: string) => ({ name, description, body: `Do ${name}.` });
  playbooks.putSkill('', skill('export-reels', 'House export settings'), { by: 'Sam' });
  playbooks.putSkill('Acme/Reels', skill('export-reels', 'Reels export for Acme: -14 LUFS'), { by: 'Sam' });
  playbooks.putSkill('Acme', skill('grade', 'The warm Acme grade'), { by: 'Sam' });
  const here = playbooks.skillsFor('Acme/Reels');
  assert.deepEqual(
    here.map((s) => [s.name, s.from]),
    [
      ['export-reels', 'Acme/Reels'],
      ['grade', 'Acme'],
    ],
  );
  const preset = path.join(dir, 'reels.preset');
  fs.writeFileSync(preset, 'codec=h264\nloudness=-14\n');
  await playbooks.addSkillFile('Acme', 'grade', 'warm.cube', preset, 'Sam');
  const before = playbooks.loadPlaybook('Acme').skills.find((s) => s.name === 'grade');
  assert.ok(before, 'the skill is there');
  assert.ok(before.id.startsWith('sk_'), 'a skill has a stable id');
  assert.ok(fs.existsSync(path.join(DATA, 'playbooks', playbooks.loadPlaybook('Acme').id, 'skills', before.id, 'warm.cube')), 'stored in data/, not the cache');
  playbooks.putSkill('Acme', { ...skill('warm-grade', 'The warm Acme grade'), rename_from: 'grade' }, { by: 'Sam' });
  const renamed = playbooks.loadPlaybook('Acme').skills.find((s) => s.name === 'warm-grade');
  assert.equal(renamed?.id, before.id, 'the same skill');
  assert.equal(await playbooks.skillFile('Acme', 'warm-grade', 'warm.cube').then((f) => f && fs.readFileSync(f, 'utf8')), 'codec=h264\nloudness=-14\n');
  await assert.rejects(playbooks.addSkillFile('Acme', 'warm-grade', '../evil', preset, 'Sam'), /file name/);
  playbooks.deleteSkill('Acme', 'warm-grade', { by: 'Sam' });
  assert.equal(await playbooks.skillFile('Acme', 'warm-grade', 'warm.cube'), null);
});

test('a render arriving now is stamped with the revisions of its folder’s playbooks; an Unsorted one with the House only', () => {
  makeVideo(reel.file, { w: 160, h: 90, dur: 1, pattern: 'smptebars' });
  age(reel.file);
  store.sync(reel.slug);
  const v2 = store.loadReview(reel.slug)?.versions.at(-1);
  assert.equal(v2?.v, 2);
  const house = playbooks.loadPlaybook('').rev;
  assert.deepEqual(v2?.playbook, [
    { scope: '', rev: house },
    { scope: 'Acme', rev: playbooks.loadPlaybook('Acme').rev },
    { scope: 'Acme/Reels', rev: playbooks.loadPlaybook('Acme/Reels').rev },
  ]);
  assert.equal(store.loadReview(reel.slug)?.versions[0].playbook, undefined, 'v1 came before any playbook');
  makeVideo(loose.file, { w: 160, h: 90, dur: 1, pattern: 'smptebars' });
  age(loose.file);
  store.sync(loose.slug);
  assert.deepEqual(store.loadReview(loose.slug)?.versions.at(-1)?.playbook, [{ scope: '', rev: house }]);
});

test('suggestions: an agent proposes, the inbox shows it to people who may edit, accepting makes a revision by the agent accepted by the person', () => {
  const note = store.addComment(reel.slug, { frame: 3, text: 'Logo smaller please', tags: ['logo'], author: 'Mia' });
  const p = playbooks.propose('Acme/Reels', {
    section: 'rules',
    content: '- 9:16, at most 60 s\n- Logo top left on reels (overrides the House)\n- Logo at most 8 % of the height',
    reason: 'Mia asked for a smaller logo three times',
    evidence: [note.id],
    by: 'agent:promo-edit',
  });
  assert.equal(p.status, 'pending');
  assert.throws(
    () => playbooks.propose('Acme/Reels', { section: 'rules', content: 'x', reason: 'r', evidence: ['c_ffffff'], by: 'agent:a' }),
    /no note c_ffffff/,
  );
  assert.throws(() => playbooks.propose('Acme/Reels', { section: 'rules', content: 'x', reason: '  ', by: 'agent:a' }), /say why/);
  const owner = forYou({ key: 'owner', name: 'Sam', role: 'owner' });
  const item = owner.items.find((i) => i.kind === 'playbook');
  assert.equal(item?.proposal, p.id);
  assert.equal(item?.video, 'Acme/Reels');
  assert.equal(owner.counts.playbook, 1);
  assert.equal(forYou({ key: 'rv', name: 'Rita', role: 'reviewer' }).counts.playbook, 0, 'reviewers can’t decide, so they aren’t asked');
  const { rev, proposal } = playbooks.acceptProposal(p.id, { by: 'Sam' });
  assert.equal(proposal.status, 'accepted');
  assert.deepEqual([rev.by, rev.accepted_by, rev.proposal, rev.section], ['agent:promo-edit', 'Sam', p.id, 'rules']);
  assert.match(playbooks.loadPlaybook('Acme/Reels').rules, /8 %/);
  assert.throws(() => playbooks.acceptProposal(p.id, { by: 'Sam' }), /accepted already/);
  const skillProp = playbooks.propose('Acme', {
    section: 'skill:anything',
    content: '---\nname: caption-style\ndescription: How captions look on Acme\n---\n\nInter 600, white, 4 % from the bottom.',
    reason: 'Captions keep coming back',
    by: 'agent:promo-edit',
  });
  assert.equal(skillProp.section, 'skill:caption-style', 'the SKILL.md names the skill');
  const rejected = playbooks.rejectProposal(skillProp.id, { by: 'Sam', reason: 'We decide captions per video' });
  assert.equal(rejected.reject_reason, 'We decide captions per video');
  assert.equal(forYou({ key: 'owner', name: 'Sam', role: 'owner' }).counts.playbook, 0, 'decided: gone from the inbox');
});

test('suggestions from the taste file: recurring asks the rules don’t mention yet', () => {
  for (const t of ['Transition too slow', 'Cut faster here', 'Slow transition again'])
    store.addComment(reel.slug, { frame: 5, text: t, tags: ['timing'], author: 'Mia' });
  const s = playbooks.suggestionsFor('Acme/Reels');
  const timing = s.find((x) => x.tag === 'timing');
  assert.equal(timing?.count, 3);
  assert.equal(timing?.examples.length, 3);
  playbooks.writeText('Acme/Reels', 'rules', `${playbooks.loadPlaybook('Acme/Reels').rules}\n- Timing: transitions at most 8 frames`, { by: 'Sam' });
  assert.equal(
    playbooks.suggestionsFor('Acme/Reels').some((x) => x.tag === 'timing'),
    false,
    'once a rule names it, it is no suggestion',
  );
});

test('playbooks move with their folders; a deleted folder’s is set aside, its subfolders’ move up', () => {
  playbooks.writeText('Globex/Launch', 'rules', '- Always end on the logo', { by: 'Sam' });
  folders.renameFolder('Globex', 'Globex Corp', 'Sam');
  assert.equal(files.readPlaybook('Globex'), null);
  assert.match(files.readPlaybook('Globex Corp')?.brief || '', /Launch films/);
  assert.match(files.readPlaybook('Globex Corp/Launch')?.rules || '', /end on the logo/);
  folders.deleteFolder('Globex Corp', 'Sam');
  assert.equal(files.readPlaybook('Globex Corp'), null);
  assert.match(files.readPlaybook('Launch')?.rules || '', /end on the logo/, 'the subfolder moved up, its playbook with it');
  assert.ok(
    fs.readdirSync(path.join(DATA, 'playbooks', 'archive')).some((f) => f.startsWith('f_')),
    'the deleted folder’s playbook is kept aside',
  );
});

// ---------------------------------------------------------------- over HTTP

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });
let reviewer = '';
let member = '';
before(async () => {
  const rv = await auth.createUser({ email: 'rita@example.test', name: 'Rita', password: 'a long password here', role: 'reviewer' });
  reviewer = auth.createToken(rv.id, 'test').token;
  const mb = await auth.createUser({ email: 'max@example.test', name: 'Max', password: 'a long password here', role: 'member' });
  member = auth.createToken(mb.id, 'test').token;
});

function request(method: string, url: string, { body, token }: { body?: unknown; token?: string } = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders; json: () => any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...(data !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, text: t, headers: res.headers, json: () => JSON.parse(t) });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const enc = encodeURIComponent;

test('HTTP: the team reads; people who may edit write; reviewers suggest but can’t edit or decide', async () => {
  const view = await request('GET', `/api/playbook?folder=${enc('Acme/Reels')}`, { token: reviewer });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json().label, 'Acme/Reels');
  assert.equal(view.json().suggestions, undefined, 'suggestions go to people who may edit');
  assert.equal((await request('GET', `/api/playbook?video=${enc(reel.slug)}`, { token: reviewer })).json().scope, 'Acme/Reels', 'a video → its folder');
  assert.equal((await request('GET', `/api/playbook?folder=Nope`)).status, 404);
  const put = { folder: 'Acme', section: 'rules', content: '- Warm, never orange-teal' };
  assert.equal((await request('PUT', '/api/playbook/text', { body: put, token: reviewer })).status, 403);
  // a member may edit, in the app: an API token (how agents and scripts connect) only suggests
  const viaToken = await request('PUT', '/api/playbook/text', { body: put, token: member });
  assert.equal(viaToken.status, 403, viaToken.text);
  assert.match(viaToken.json().error, /suggest the change instead/);
  const ok = await request('PUT', '/api/playbook/text', { body: put });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().rev.by, 'tester');
  const sug = await request('POST', '/api/playbook/proposals', {
    body: { folder: 'Acme', section: 'rules', content: '- Warm, never orange-teal\n- Grain at 3 %', reason: 'Every approved render had grain', by: 'agent:x' },
    token: reviewer,
  });
  assert.equal(sug.status, 201, sug.text);
  assert.equal(sug.json().by, 'Rita', 'a reviewer can’t pass for an agent');
  assert.equal((await request('POST', `/api/playbook/proposals/${sug.json().id}/accept`, { body: {}, token: reviewer })).status, 403);
  assert.equal((await request('POST', `/api/playbook/proposals/${sug.json().id}/accept`, { body: {}, token: member })).status, 403, 'not with a token');
  const read = await request('GET', `/api/playbook/proposals/${sug.json().id}`, { token: reviewer });
  assert.equal(read.json().current, '- Warm, never orange-teal', 'the text it would replace, for the diff');
  const acc = await request('POST', `/api/playbook/proposals/${sug.json().id}/accept`, { body: {} });
  assert.equal(acc.status, 200, acc.text);
  assert.equal(acc.json().rev.accepted_by, 'tester');
  assert.deepEqual(
    (await request('GET', '/api/playbooks')).json().playbooks.map((p: { scope: string }) => p.scope),
    ['', 'Acme', 'Acme/Reels', 'Launch'].sort(),
  );
});

test('HTTP: a skill as a whole SKILL.md, its file served as a download (never shown or run), references with their pictures', async () => {
  const md = '---\nname: reels-export\ndescription: Export an Acme reel\n---\n\nRender with the preset.';
  const put = await request('PUT', '/api/playbook/skill', { body: { folder: 'Acme', markdown: md } });
  assert.equal(put.status, 200, put.text);
  const file = await request('POST', '/api/playbook/skill/files', {
    body: { folder: 'Acme', skill: 'reels-export', name: 'reels.epr', data: Buffer.from('<preset/>').toString('base64') },
  });
  assert.equal(file.status, 200, file.text);
  const dl = await request('GET', `/api/playbook/skill/files?folder=Acme&skill=reels-export&name=reels.epr`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers['content-type'], 'application/octet-stream');
  assert.match(String(dl.headers['content-disposition']), /^attachment; filename="reels\.epr"$/);
  assert.equal(dl.text, '<preset/>');
  const sk = (await request('GET', `/api/playbook/skill?video=${enc(reel.slug)}&name=reels-export`)).json();
  assert.equal(sk.from, 'Acme');
  assert.match(sk.markdown, /^---\nname: reels-export\n/);
  assert.equal(sk.id, undefined);
  const link = await request('POST', '/api/playbook/refs', {
    body: { folder: 'Acme', kind: 'link', url: 'https://user:pw@example.com/moodboard', caption: 'Mood' },
  });
  assert.equal(link.status, 200, link.text);
  assert.equal(link.json().ref.url, 'https://example.com/moodboard', 'credentials never stored');
  const frame = await request('POST', '/api/playbook/refs', { body: { folder: 'Acme', kind: 'frame', video: reel.slug, frame: 2, caption: 'This warmth' } });
  assert.equal(frame.status, 200, frame.text);
  const still = frame.json().ref.still;
  const pic = await request('GET', `/api/playbook/refs/${still}?folder=Acme`);
  assert.equal(pic.status, 200, pic.text);
  assert.match(String(pic.headers['content-type']), /^image\/jpeg/);
  assert.equal((await request('GET', `/api/playbook/refs/${still}?folder=Acme/Reels`)).status, 404, 'only through its own playbook');
  assert.equal((await request('DELETE', `/api/playbook/refs?folder=Acme&id=${link.json().ref.id}`)).status, 200);
  assert.equal(playbooks.loadPlaybook('Acme').refs.length, 1);
});

// ---------------------------------------------------------------- times and decisions

/** Rewrites stored fields of a playbook, as another machine (another clock, another offset) would have written them. */
function restamp(scope: string, fn: (p: ReturnType<typeof playbooks.loadPlaybook>) => void): void {
  const p = files.readPlaybook(scope);
  assert.ok(p);
  fn(p);
  fs.writeFileSync(files.playbookFile(scope), `${JSON.stringify(p, null, 2)}\n`);
}

test('the inbox lists suggestions newest first by the instant, whatever offset the machine that wrote them had', () => {
  const laptop = playbooks.propose('Acme', { section: 'brief', content: 'Written on a laptop in Berlin.', reason: 'r', by: 'agent:laptop' });
  const server = playbooks.propose('Acme', { section: 'rules', content: '- Written on a server in UTC', reason: 'r', by: 'agent:server' });
  restamp('Acme', (p) => {
    for (const x of p.proposals) {
      // 10:00 in Berlin is 08:00 UTC: an hour before the server's 09:00, although its text sorts after it.
      if (x.id === laptop.id) x.at = '2026-09-30T10:00:00+02:00';
      if (x.id === server.id) x.at = '2026-09-30T09:00:00Z';
    }
  });
  assert.deepEqual(
    playbooks.pendingProposals().map((x) => x.by),
    ['agent:server', 'agent:laptop'],
  );
  for (const x of [laptop, server]) playbooks.rejectProposal(x.id, { by: 'Sam' });
});

test('accepting a suggestion never overwrites what a person changed in that section after it was made; other sections are fine', async () => {
  const scope = 'Acme/Reels';
  const stale = playbooks.propose(scope, { section: 'rules', content: '- Reels at most 30 s', reason: 'Shorter is better', by: 'agent:promo-edit' });
  const fine = playbooks.propose(scope, { section: 'brief', content: 'Reels for the spring campaign.', reason: 'The campaign', by: 'agent:promo-edit' });
  const base = stale.base_rev;
  const mine = `${playbooks.loadPlaybook(scope).rules}\n- Music licensed for social only`;
  const edit = playbooks.writeText(scope, 'rules', mine, { by: 'Mia' });
  assert.equal(edit?.rev, base + 1);
  assert.throws(
    () => playbooks.acceptProposal(stale.id, { by: 'Sam' }),
    (e: { status: number; message: string; details?: Record<string, unknown> }) =>
      e.status === 409 &&
      e.message.includes(`Mia changed the rules in r${base + 1}`) &&
      e.message.includes(`made on r${base}`) &&
      e.details?.by === 'Mia' &&
      e.details?.changed_rev === base + 1,
  );
  assert.equal(playbooks.loadPlaybook(scope).rules, mine, 'the person’s text stands');
  assert.equal(playbooks.findProposal(stale.id)?.proposal.status, 'pending', 'still there to look at again and reject');
  // Only the rules changed since: the brief made on the same revision goes through.
  const { rev } = playbooks.acceptProposal(fine.id, { by: 'Sam' });
  assert.equal(rev.section, 'brief');
  assert.equal(playbooks.loadPlaybook(scope).brief, 'Reels for the spring campaign.');
  // A change that left the text as it was (a skill's file, an edit undone) replaces nothing.
  const skill = '---\nname: reels-grade\ndescription: Grade a reel\n---\n\nWarm, lifted blacks.';
  playbooks.putSkill(scope, playbooks.parseSkill(skill), { by: 'Sam' });
  const better = playbooks.propose(scope, { section: 'skill:x', content: `${skill}\nGrain at 3 %.`, reason: 'Grain', by: 'agent:promo-edit' });
  const file = path.join(dir, 'look.cube');
  fs.writeFileSync(file, 'LUT_3D_SIZE 2\n');
  await playbooks.addSkillFile(scope, 'reels-grade', 'look.cube', file, 'Sam');
  assert.equal(playbooks.acceptProposal(better.id, { by: 'Sam' }).rev.section, 'skill:reels-grade');
  assert.deepEqual(
    playbooks
      .loadPlaybook(scope)
      .skills.find((s) => s.name === 'reels-grade')
      ?.files.map((f) => f.name),
    ['look.cube'],
  );
  playbooks.rejectProposal(stale.id, { by: 'Sam', reason: 'Mia’s rules stand' });
});

test('HTTP: accepting a suggestion someone overtook answers 409 with who and which revision', async () => {
  const scope = 'Acme';
  const prop = await request('POST', '/api/playbook/proposals', {
    body: { folder: scope, section: 'rules', content: '- Grain at 5 %', reason: 'More grain', by: 'agent:x' },
  });
  assert.equal(prop.status, 201, prop.text);
  const edit = await request('PUT', '/api/playbook/text', { body: { folder: scope, section: 'rules', content: '- Grain at 2 %' } });
  assert.equal(edit.status, 200, edit.text);
  const acc = await request('POST', `/api/playbook/proposals/${prop.json().id}/accept`, { body: {} });
  assert.equal(acc.status, 409, acc.text);
  assert.match(acc.json().error, /tester changed the rules in r\d+/);
  assert.equal(acc.json().by, 'tester');
  assert.equal(acc.json().changed_rev, edit.json().rev.rev);
  assert.equal(playbooks.loadPlaybook(scope).rules, '- Grain at 2 %');
  assert.equal((await request('POST', `/api/playbook/proposals/${prop.json().id}/reject`, { body: {} })).status, 200);
});
