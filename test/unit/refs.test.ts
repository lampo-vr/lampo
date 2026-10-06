// References on notes: images, clips, links and moments of renders attached to a note ("like this"), with stills for
// thumbnails and agents, limits, hostile files refused, and the files gone with the note.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { attachRefFile, describeRef, frameRef, linkRef, saveRefs, REF_FILE } = await import('../../lib/refs.ts');
const { reviewDir } = await import('../../lib/paths.ts');
const { eventLine } = await import('../../lib/eventLine.ts');

const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);
const media = path.join(dir, 'media');
fs.mkdirSync(media, { recursive: true });
const make = (name: string, ...args: string[]) => {
  const out = path.join(media, name);
  ffmpeg(...args, out);
  return out;
};

const src = path.join(dir, 'renders/spot.mp4');
makeVideo(src, { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
age(src);
store.createOrGetReview(src, { by: 'tester' });
const slug = path.resolve(src).split('/').join('__');
const other = path.join(dir, 'renders/other.mp4');
makeVideo(other, { w: 320, h: 180, fps: 25, dur: 2, freq: 660 });
age(other);
store.createOrGetReview(other, { by: 'tester' });
const otherSlug = path.resolve(other).split('/').join('__');

const note = (text = 'Mehr Tempo') => store.addComment(slug, { frame: 10, text, author: 'tester' });
const refsDir = path.join(reviewDir(slug), 'refs');
const onDisk = () => (fs.existsSync(refsDir) ? fs.readdirSync(refsDir).sort() : []);

test('an image: kept as sent, with a still for thumbnails and agents, on the note itself', async () => {
  const c = note();
  const png = make('ref.png', '-f', 'lavfi', '-i', 'testsrc2=s=2000x1000', '-frames:v', '1');
  const out = await attachRefFile(c.id, png, { by: 'tester', caption: '  So viel Luft oben  ' });
  assert.equal(out.ref.kind, 'image');
  assert.equal(out.ref.caption, 'So viel Luft oben');
  assert.deepEqual([out.ref.width, out.ref.height], [2000, 1000]);
  assert.match(out.ref.file as string, /^r_[a-f0-9]{10}\.png$/);
  assert.match(out.ref.still as string, /^r_[a-f0-9]{10}\.t\.jpg$/);
  for (const f of [out.ref.file, out.ref.still]) assert.ok(REF_FILE.test(f as string) && fs.existsSync(path.join(refsDir, f as string)), f);
  const w = Number(
    execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), [
      '-v',
      'error',
      '-show_entries',
      'stream=width',
      '-of',
      'csv=p=0',
      path.join(refsDir, out.ref.still as string),
    ])
      .toString()
      .trim(),
  );
  assert.equal(w, 1280, 'the still is at most 1280 px on the long side');
  const saved = store.findComment(c.id)?.comment;
  assert.equal(saved?.refs?.length, 1);
  assert.equal(saved?.replies.length, 0, 'without a note it belongs to the note, not a reply');
  const ev = store.readEvents({ limit: 1 })[0];
  assert.equal(ev?.type, 'ref');
  assert.match(eventLine(ev as NonNullable<typeof ev>), /REFERENCE c_\w+ .*image 2000×1000 — "So viel Luft oben"/);
});

test('a clip: re-encoded to H.264 with a poster and a strip of six moments; a GIF with motion is a clip too', async () => {
  const c = note();
  const mov = make('ref.mov', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-c:v', 'mpeg4');
  const out = await attachRefFile(c.id, mov, { by: 'agent:edit', note: 'So soll die Blende laufen' });
  assert.equal(out.ref.kind, 'clip');
  assert.match(out.ref.file as string, /\.mp4$/);
  assert.ok(out.ref.duration && Math.abs(out.ref.duration - 3) < 0.2, `duration ${out.ref.duration}`);
  assert.match(out.ref.strip as string, /\.s\.jpg$/);
  const codec = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    path.join(refsDir, out.ref.file as string),
  ])
    .toString()
    .trim();
  assert.equal(codec, 'h264');
  const reply = store.findComment(c.id)?.comment.replies.at(-1);
  assert.deepEqual([reply?.text, reply?.refs], ['So soll die Blende laufen', [out.ref.id]], 'with a note they come as a reply');
  const gif = make('ref.gif', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=1');
  const g = await attachRefFile(c.id, gif, { by: 'tester' });
  assert.equal(g.ref.kind, 'clip');
  const one = make('one.gif', '-f', 'lavfi', '-i', 'testsrc2=s=160x90', '-frames:v', '1');
  const o = await attachRefFile(c.id, one, { by: 'tester' });
  assert.equal(o.ref.kind, 'image');
  assert.match(o.ref.file as string, /\.png$/, 'a single-picture GIF is kept as a PNG');
});

test('limits: clip length, the kind asked for, eight per note', async () => {
  const c = note();
  const long = make('long.mp4', '-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=5:d=62');
  await assert.rejects(attachRefFile(c.id, long, { by: 'tester' }), /at most 60 s/);
  const png = make('small.png', '-f', 'lavfi', '-i', 'testsrc2=s=64x36', '-frames:v', '1');
  await assert.rejects(attachRefFile(c.id, png, { by: 'tester', kind: 'clip' }), /one picture/);
  const links = Array.from({ length: 8 }, (_, i) => linkRef(`https://example.com/${i}`, { by: 'tester' }));
  await saveRefs(c.id, slug, links, { by: 'tester' });
  await assert.rejects(attachRefFile(c.id, png, { by: 'tester' }), /at most 8 references/);
  assert.throws(() => store.addRefs(c.id, [linkRef('https://example.com/9', { by: 'tester' })], { by: 'tester' }), /at most 8/);
});

test('hostile files are refused before any work: a playlist or a concat list named .mp4, text, a bomb header', async () => {
  const c = note();
  const hls = path.join(media, 'playlist.mp4');
  fs.writeFileSync(hls, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
  const concat = path.join(media, 'concat.mp4');
  fs.writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
  const txt = path.join(media, 'notes.png');
  fs.writeFileSync(txt, 'hello');
  for (const f of [hls, concat, txt]) await assert.rejects(attachRefFile(c.id, f, { by: 'tester' }), /can read/, f);
  const huge = make('huge.png', '-f', 'lavfi', '-i', 'color=s=8200x10:c=red', '-frames:v', '1');
  await assert.rejects(attachRefFile(c.id, huge, { by: 'tester' }), /8192 px/);
  assert.equal(store.findComment(c.id)?.comment.refs, undefined, 'nothing recorded');
});

test('links: http(s) only, credentials dropped, never fetched', () => {
  const r = linkRef('https://user:secret@www.example.com/look?t=12#here', { by: 'tester', caption: 'Diese Blende' });
  assert.equal(r.url, 'https://www.example.com/look?t=12#here');
  assert.equal(r.site, 'example.com');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.y/z', 'data:text/html,hi', 'not a link', `https://x.com/${'a'.repeat(2001)}`])
    assert.throws(() => linkRef(bad, { by: 'tester' }), /link/, bad);
  assert.match(describeRef(r), /link https:\/\/www\.example\.com\/look\?t=12#here — "Diese Blende"/);
});

test('a frame reference: a moment (or a range) of another render, stored as frame-exact stills', async () => {
  const c = note();
  const ref = await frameRef(slug, { video: otherSlug, frame: 12, to_frame: 30 }, { by: 'tester', caption: 'Wie hier' });
  assert.deepEqual([ref.kind, ref.name, ref.v, ref.frame, ref.to_frame, ref.timecode], ['frame', 'other.mp4', 1, 12, 30, '00:00:12']);
  assert.ok(ref.still && ref.end);
  await saveRefs(c.id, slug, [ref], { by: 'tester' });
  for (const f of [ref.still, ref.end]) assert.ok(fs.existsSync(path.join(refsDir, f as string)), f);
  assert.match(describeRef(ref), /frame of other\.mp4 v1 at 00:00:12 \(f12\) to 00:01:05 \(f30\) — "Wie hier"/);
  await assert.rejects(frameRef(slug, { video: otherSlug, frame: 50 }, { by: 'tester' }), /outside 0–49/);
  await assert.rejects(frameRef(slug, { video: otherSlug, frame: 5, to_frame: 5 }, { by: 'tester' }), /range must end after/);
  await assert.rejects(frameRef(slug, { video: 'no__such', frame: 1 }, { by: 'tester' }), /not in the library/);
});

test('captions change, a reference goes with its files, and a deleted note takes all of them along', async () => {
  const c = note('Weg damit');
  const png = make('gone.png', '-f', 'lavfi', '-i', 'testsrc2=s=64x36', '-frames:v', '1');
  const a = await attachRefFile(c.id, png, { by: 'tester' });
  const b = await attachRefFile(c.id, png, { by: 'tester', note: 'noch eins' });
  store.setRefCaption(c.id, a.ref.id, 'Neue Unterschrift', 'tester');
  assert.equal(store.findComment(c.id)?.comment.refs?.[0]?.caption, 'Neue Unterschrift');
  store.removeRef(c.id, b.ref.id, 'tester');
  const after = store.findComment(c.id)?.comment;
  assert.deepEqual(
    after?.refs?.map((r) => r.id),
    [a.ref.id],
  );
  assert.deepEqual(after?.replies.at(-1)?.refs, [], 'the reply forgets it');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!onDisk().some((f) => f.startsWith(b.ref.id)), 'its files are gone');
  store.deleteComment(c.id, 'tester');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!onDisk().some((f) => f.startsWith(a.ref.id)), 'the note took its references along');
});

test('an old store loads unchanged: notes without refs or scope stay as they were', () => {
  const c = note('Alt');
  const raw = JSON.parse(fs.readFileSync(path.join(reviewDir(slug), 'review.json'), 'utf8'));
  const saved = raw.comments.find((x: { id: string }) => x.id === c.id);
  assert.equal('refs' in saved, false);
  assert.equal('scope' in saved, false);
});
