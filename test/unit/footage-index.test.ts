// Footage search on the machine (lib/footage/): a generated clip with known shots and moves is indexed with the
// stand-in model (deterministic vectors from the picture's colours, through the real worker process), and requests are
// answered by the same find() `vr footage find` and find_footage use: filters, ranking, words, the contract's shape,
// what a new version or the sample does to the index, and the contact sheet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { age, encodeOnce, FFMPEG, isolatedEnv, tmpdir } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_FOOTAGE: 'auto', VR_FOOTAGE_MODEL: 'fake', VR_OCR: 'off' } });
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { CHUNK_FRAMES, newReading, readChunk, shotsOf } = await import('../../lib/footage/analyse.ts');
const { createEmbedder, resetEmbedder } = await import('../../lib/footage/embedder.ts');
const { indexNow, targets, prune } = await import('../../lib/footage/indexer.ts');
const { find, forgetLoaded } = await import('../../lib/footage/search.ts');
const service = await import('../../lib/footage/service.ts');
const { openIndex, bump, closeIndexes } = await import('../../lib/footage/db.ts');
const { transcriptFile } = await import('../../lib/transcripts.ts');
const { buildTranscript } = await import('../../lib/transcript.ts');

const e = createEmbedder({ kind: 'fake' });
resetEmbedder(e);
after(() => {
  resetEmbedder();
  closeIndexes();
});

// 25 fps, 320×180: a red grid (f0–49, static), a push-in over a still (50–124), a pan over a still (125–199, the
// window moving right), a blue grid (200–249, static).
const still = (n: number) => `testsrc=s=1280x720:r=25:d=1,trim=end_frame=1,loop=loop=${n - 1}:size=1,setpts=N/25/TB`;
const MOVES = [
  'color=c=0xcc3333:s=320x180:r=25:d=2,drawgrid=w=40:h=40:t=2:c=white[a]',
  `${still(75)},zoompan=z='1+0.006*on':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=320x180:fps=25[b]`,
  `${still(75)},scale=640:360,crop=320:180:x='n*3':y=90[c]`,
  'color=c=0x3344cc:s=320x180:r=25:d=2,drawgrid=w=32:h=32:t=2:c=yellow[d]',
  '[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p,setsar=1[v]',
].join(';');
const clip = (file: string, graph: string) => {
  encodeOnce(file, ['-v', 'error', '-filter_complex', graph, '-map', '[v]', '-c:v', 'libx264', '-g', '50']);
  age(file);
  return file;
};
const moves = clip(path.join(dir, 'footage', 'moves.mp4'), MOVES);
// upright: a green grid, 3 s
const tall = clip(path.join(dir, 'footage', 'tall.mp4'), 'color=c=0x33aa44:s=180x320:r=25:d=3,drawgrid=w=30:h=30:t=2:c=white,format=yuv420p[v]');

test('one decode reads the shots, their moves and keyframes; chunks read the same as one pass', async () => {
  const meta = { fps: 25, width: 320, height: 180 };
  const read = async (chunk: number) => {
    const r = newReading();
    while (!r.ended && r.frames < 250) await readChunk(moves, meta, r, Math.min(250, r.frames + chunk));
    return shotsOf(r, meta);
  };
  const whole = await read(CHUNK_FRAMES);
  assert.deepEqual(
    whole.map((s) => [s.in, s.end, s.motion.kind]),
    [
      [0, 50, 'static'],
      [50, 125, 'push-in'],
      [125, 200, 'pan-right'],
      [200, 250, 'static'],
    ],
  );
  assert.ok((whole[1]?.motion.zoom ?? 0) > 1.2, 'the push-in comes closer');
  // a keyframe per 2.5 s (one for short shots), never on a cut
  assert.deepEqual(
    whole.map((s) => s.keyframes.length),
    [1, 2, 2, 1],
  );
  for (const s of whole) for (const k of s.keyframes) assert.ok(k > s.in && k < s.end - 1);
  // a chunk boundary (each its own job) changes nothing: the seek lands on the frame (lib/shots.ts seekTime)
  assert.deepEqual(await read(37), whole);
});

test('a workspace’s videos are indexed, and requests find their shots by picture, move, aspect and length', async () => {
  store.createOrGetReview(moves, { by: 'tester' });
  store.createOrGetReview(tall, { by: 'tester' });
  assert.equal(service.status().waiting, 2);
  assert.equal(await indexNow(targets(), { e }), 2);
  const s = service.status();
  assert.deepEqual([s.videos, s.indexed, s.waiting, s.shots], [2, 2, 0, 5]);
  assert.equal(s.model_ready, true);

  const red = await find({ query: 'red' }, { local: true });
  assert.equal(red.shots[0]?.in, 0, JSON.stringify(red.shots.slice(0, 2)));
  assert.equal(red.searched, 5);
  const blue = await find({ query: 'a blue picture' });
  assert.equal(blue.read.show, 'blue picture');
  assert.equal(blue.shots[0]?.in, 200);
  // a move is a bonus over the picture: the push-in first, the pan with it
  assert.equal((await find({ query: 'slow push-in' })).shots[0]?.move, 'push-in');
  assert.equal((await find({ query: 'pan' })).shots[0]?.move, 'pan-right');
  // aspect and length are filters
  const upright = await find({ query: 'green, 9:16' });
  assert.deepEqual(
    upright.shots.map((x) => x.name),
    ['tall.mp4'],
  );
  assert.ok((await find({ query: 'anything, at least 2.5 s' })).shots.every((x) => x.length_s >= 2.5));
  assert.deepEqual(
    (await find({ query: '', max_s: 2 })).shots.map((x) => x.in),
    [0, 200],
  );
  // the same index answers the same, ids included
  assert.deepEqual(await find({ query: 'red' }, { local: true }), red);
});

test('the answer’s shape is the contract (docs/footage.md): frames both included, seconds, the file only for the machine', async () => {
  const a = await find({ query: 'blue', limit: 1 }, { local: true });
  const shot = a.shots[0];
  assert.ok(shot);
  assert.deepEqual(Object.keys(a).sort(), ['footage_version', 'index', 'query', 'read', 'searched', 'shots']);
  assert.deepEqual(
    Object.keys(shot).sort(),
    [
      'aspect',
      'file',
      'folder',
      'fps',
      'frame',
      'height',
      'id',
      'in',
      'length_s',
      'move',
      'name',
      'out',
      'said',
      'score',
      'speed',
      't0',
      't1',
      'text',
      'v',
      'video',
      'width',
    ].sort(),
  );
  assert.match(shot.id, /^s\d+$/);
  assert.deepEqual([shot.in, shot.out, shot.t0, shot.t1, shot.length_s], [200, 249, 8, 10, 2]);
  assert.deepEqual([shot.width, shot.height, shot.aspect, shot.move, shot.speed, shot.v, shot.fps], [320, 180, '16:9', 'static', null, 1, 25]);
  assert.equal(shot.video, slugify(moves));
  assert.equal(shot.name, 'moves.mp4');
  assert.ok(shot.frame >= shot.in && shot.frame <= shot.out);
  // the render's bytes on this machine: the frames a tool cuts are the ones Lampo numbered
  assert.ok(shot.file && fs.existsSync(shot.file));
  const frame = (f: number, file: string) =>
    execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${f}),scale=8:8`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.deepEqual(frame(shot.in, shot.file), frame(shot.in, moves));
  // anyone else: no path
  assert.equal((await find({ query: 'blue', limit: 1 })).shots[0]?.file, undefined);
});

test('words: text read in the picture, what is said (from a transcript the video has), “no text”', async () => {
  const db = openIndex();
  const key = renderKey(store.loadReview(slugify(moves))?.versions[0] as never);
  db.prepare("UPDATE shots SET text = 'SALE -30%' WHERE render = ? AND f_in = 0").run(key);
  bump(db);
  const sale = await find({ query: 'a shop window "SALE"' });
  assert.equal(sale.shots[0]?.in, 0);
  assert.deepEqual(sale.shots[0]?.matched, ['text']);
  assert.ok(!(await find({ query: 'red, no text' })).shots.some((x) => x.in === 0 && x.name === 'moves.mp4'), '“no text” leaves it out');
  // a transcript the video has: its words on the shot they're said in
  const ver = store.loadReview(slugify(moves))?.versions[0];
  assert.ok(ver);
  const words = [
    { text: 'The', t0: 5.2, t1: 5.4 },
    { text: 'battery', t0: 5.4, t1: 5.9 },
    { text: 'lasts', t0: 5.9, t1: 6.3 },
  ];
  fs.mkdirSync(path.dirname(transcriptFile(renderKey(ver))), { recursive: true });
  fs.writeFileSync(transcriptFile(renderKey(ver)), JSON.stringify(buildTranscript({ words, segments: [], language: 'en', engine: 'test' }, ver, 'now')));
  const said = await find({ query: 'where the voice-over says the battery lasts' });
  assert.equal(said.shots.length, 1, 'only shots with the words');
  assert.equal(said.shots[0]?.in, 125);
  assert.equal(said.shots[0]?.said, 'The battery lasts');
  db.prepare("UPDATE shots SET text = '' WHERE render = ?").run(key);
  bump(db);
});

test('a contact sheet of shots by id: three to a row, labelled; ids it doesn’t know are left out', async () => {
  const a = await find({ query: 'red', limit: 4 });
  const out = path.join(tmpdir(), 'sheet.jpg');
  const r = await service.sheet([...a.shots.map((s) => s.id), 's999999'], out);
  assert.equal(r.shots.length, 4);
  assert.deepEqual([r.width, r.height], [3 * 324 - 4, 2 * 184 - 4]);
  const size = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], {
    encoding: 'utf8',
  });
  assert.equal(size.trim(), `${r.width},${r.height}`);
  await assert.rejects(service.sheet(['s999999']), /no shot s999999/);
});

test('a new version replaces the old one’s shots; the sample and archived videos are never searched', async () => {
  const before = await find({ query: 'green' });
  const old = before.shots.find((s) => s.name === 'tall.mp4');
  assert.ok(old);
  // a re-render to the same path: a purple picture
  encodeOnce(tall, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x8833aa:s=180x320:r=25:d=3',
    '-vf',
    'drawgrid=w=30:h=30:t=2:c=white,format=yuv420p',
    '-c:v',
    'libx264',
  ]);
  age(tall);
  const synced = store.sync(slugify(tall));
  assert.equal(synced?.review.versions.length, 2);
  // the index waits for the new version: until then the video's old shots aren't offered as its newest
  assert.equal(service.status().waiting, 1);
  assert.ok(!(await find({ query: 'green' })).shots.some((s) => s.name === 'tall.mp4'));
  await indexNow(targets(), { e });
  assert.equal(prune(targets().map((t) => t.key)), 1, 'the old render left the index');
  const now = (await find({ query: 'purple' })).shots[0];
  assert.equal(now?.name, 'tall.mp4');
  assert.equal(now?.v, 2);
  assert.notEqual(now?.id, old.id);
  await assert.rejects(service.sheet([old.id]), /no shot/);
  // the onboarding sample is a demo, never footage
  store.mutate(slugify(tall), (r) => {
    r.onboarding_sample = { made: 'now', by: 'tester' };
  });
  forgetLoaded();
  assert.ok(!(await find({ query: 'purple' })).shots.some((s) => s.name === 'tall.mp4'));
  assert.equal(service.status().videos, 1);
  // an archived video isn't offered either; its index is kept for when it comes back
  store.mutate(slugify(moves), (r) => {
    r.archived = 'now';
  });
  assert.deepEqual([(await find({ query: 'red' })).shots.length, service.status().videos], [0, 0]);
  // pruning keeps the archived video's render; the sample's (never footage) goes
  assert.equal(prune(targets(undefined, { archived: true }).map((t) => t.key)), 1);
  assert.equal(openIndex().prepare('SELECT count(*) AS n FROM renders').get()?.n, 1);
  store.mutate(slugify(moves), (r) => {
    delete r.archived;
  });
  assert.equal((await find({ query: 'red' })).shots[0]?.in, 0);
});

test('vectors from another CPU family or model are not compared: the index says it is waiting for them', async () => {
  const db = openIndex();
  db.prepare("UPDATE vectors SET model = 'siglip-b16-int8-pad@linux-x64'").run();
  bump(db);
  const a = await find({ query: 'red' });
  assert.equal(a.index.waiting, 1);
  assert.match(a.index.note ?? '', /no picture of these videos is indexed here yet: this answer used the filters and words only/);
  assert.ok(
    a.shots.every((s) => s.score === 0),
    'nothing ranked by a picture',
  );
  // a request that is only filters answers as before
  assert.equal((await find({ query: '', max_s: 2 })).shots.length, 2);
  db.prepare("UPDATE vectors SET model = 'fake'").run();
  bump(db);
  assert.equal((await find({ query: 'red' })).index.waiting, 0);
});

test('off for the workspace: nothing is searched, and the answer says so', async () => {
  service.setOn(false, 'tester');
  const a = await find({ query: 'red' });
  assert.deepEqual([a.shots.length, a.index.on], [0, false]);
  assert.match(a.index.note ?? '', /off for this workspace/);
  service.setOn(true, 'tester');
  assert.ok((await find({ query: 'red' })).shots.length > 0);
});
