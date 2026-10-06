// The publish kit (lib/publish/kit.ts), checked with ffprobe: each platform's encode is H.264 High 4:2:0 in MP4 with
// the index at the front, AAC at 48 kHz, scaled down (never up) within the platform's frame and its frame rate within
// its range; the SRT from the transcript, the cover frame as a JPEG, the copy, one ZIP of them; and when the final file
// goes out as it is or as the platform's encode.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const posts = await import('../../lib/publish/posts.ts');
const { makeKit, kitPath, kitZip, kitInfo, encodeArgs, fitsAsIs, platformFile } = await import('../../lib/publish/kit.ts');
const { ENCODE_SPECS } = await import('../../lib/publish/platforms.ts');
const { buildTranscript } = await import('../../lib/transcript.ts');
const { transcriptFile } = await import('../../lib/transcripts.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { FFPROBE } = await import('../../lib/probe.ts');

interface Stream {
  codec_type: string;
  codec_name: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
}
const probe = (file: string): { streams: Stream[]; format: { format_name: string } } =>
  JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());

/** A final video: a wide 72 fps render with 44.1 kHz sound — more than any platform takes — and its transcript. */
const file = makeVideo(path.join(dir, 'renders/big-render.mp4'), { w: 2400, h: 1350, fps: 72, dur: 0.6 });
store.createOrGetReview(file, { by: 'tester' });
const slug = slugify(file);
store.setApproval(slug, { status: 'approved' }, 'tester');
store.setFinal(slug, {}, 'tester');
const review = () => store.loadReview(slug) as NonNullable<ReturnType<typeof store.loadReview>>;
const ver = review().versions[0] as NonNullable<ReturnType<typeof review>['versions'][number]>;
const heard = { words: [], segments: [{ text: 'Spring is here.', t0: 0, t1: 0.5 }], language: 'en', engine: 'test' };
fs.mkdirSync(path.dirname(transcriptFile(renderKey(ver))), { recursive: true });
fs.writeFileSync(
  transcriptFile(renderKey(ver)),
  JSON.stringify(buildTranscript(heard, { hash: renderKey(ver), fps: ver.fps, frames: ver.frames }, new Date().toISOString())),
);

test('Instagram’s kit: an encode inside 1920 × 1080 at 60 fps at most, H.264 High, AAC 48 kHz, the index first; SRT, cover, copy, ZIP', async () => {
  const { post } = posts.draftPost({ slug, platform: 'instagram', fields: { description: 'Spring is here #spring', cover_frame: 10 }, by: 'tester' });
  const kit = await makeKit(post, review());
  assert.equal(kit.state, 'ready', kit.error);
  assert.deepEqual(
    kit.files.map((f) => f.name),
    ['big-render-instagram.mp4', 'big-render-instagram.srt', 'big-render-instagram-cover.jpg', 'big-render-instagram-copy.txt', 'kit.zip'],
  );
  const video = kitPath(post.id, 'big-render-instagram.mp4') as string;
  const p = probe(video);
  const v = p.streams.find((s) => s.codec_type === 'video') as Stream;
  const a = p.streams.find((s) => s.codec_type === 'audio') as Stream;
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.profile, 'High');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.deepEqual([v.width, v.height], [1920, 1080], 'scaled down to fit, the shape kept');
  assert.equal(v.avg_frame_rate, '60/1', '72 fps is more than Instagram takes');
  assert.equal(a.codec_name, 'aac');
  assert.equal(a.sample_rate, '48000');
  assert.match(p.format.format_name, /mp4/);
  const bytes = fs.readFileSync(video);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'the index before the data (fast start)');
  assert.ok(bytes.length < ENCODE_SPECS.instagram.maxBytes);
  const srt = fs.readFileSync(kitPath(post.id, 'big-render-instagram.srt') as string, 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,[0-9]{3}\nSpring is here\.\n/);
  const cover = probe(kitPath(post.id, 'big-render-instagram-cover.jpg') as string).streams[0] as Stream;
  assert.equal(cover.codec_name, 'mjpeg');
  assert.deepEqual([cover.width, cover.height], [2400, 1350], 'the cover at the final’s full size');
  assert.equal(fs.readFileSync(kitPath(post.id, 'big-render-instagram-copy.txt') as string, 'utf8'), 'Spring is here #spring\n');
  // the ZIP: every file stored, and an unzipper lists them
  const zip = path.join(dir, 'kit.zip');
  const out = fs.createWriteStream(zip);
  for await (const chunk of kitZip(post.id).bytes()) out.write(chunk);
  await new Promise((r) => out.end(r));
  assert.equal(fs.statSync(zip).size, kit.files.find((f) => f.name === 'kit.zip')?.bytes);
  const listed = execFileSync('unzip', ['-l', zip]).toString();
  for (const f of kit.files.filter((x) => x.kind !== 'zip')) assert.ok(listed.includes(f.name), `${f.name} in the ZIP`);
  assert.equal(kitPath(post.id, '../kit.json'), null, 'only names the kit lists');
  assert.equal(kitInfo(post.id)?.state, 'ready');
});

test('YouTube keeps the final’s size within 4K and its rate; Facebook within 1080p; never scaled up', () => {
  const args = (platform: 'youtube' | 'facebook', w: number, h: number, fps: number) =>
    encodeArgs('in.mp4', 'out.mp4', ENCODE_SPECS[platform], { width: w, height: h, fps });
  const vf = (a: string[]) => a[a.indexOf('-vf') + 1];
  assert.equal(vf(args('youtube', 2400, 1350, 72)), 'scale=2400:1350:flags=lanczos,format=yuv420p,fps=60');
  assert.equal(vf(args('youtube', 640, 360, 25)), 'scale=640:360:flags=lanczos,format=yuv420p', 'small stays small');
  assert.equal(vf(args('facebook', 2160, 3840, 30)), 'scale=1080:1920:flags=lanczos,format=yuv420p', 'a tall 4K to 1080 × 1920');
  assert.equal(vf(args('facebook', 1080, 1920, 15)), 'scale=1080:1920:flags=lanczos,format=yuv420p,fps=24', '24 fps at least');
  const a = args('facebook', 1080, 1920, 30);
  for (const flag of ['-movflags', '+faststart', '-profile:v', 'high', '+cgop', '0:a:0?']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('-g') + 1], '60', 'a keyframe every two seconds');
});

test('what goes out: YouTube the final as it is; Instagram the final when it fits, else its encode with that file’s hash', async () => {
  assert.equal(fitsAsIs('youtube', { video: 'x.mov', meta: { codec: 'prores' } }, { width: 3840, height: 2160, fps: 25, size: 9e9 }), true);
  const ok = { video: 'x.mp4', meta: { codec: 'h264', pix_fmt: 'yuv420p', audio: { codec: 'aac', sample_rate: 48000, channels: 2 } } };
  assert.equal(fitsAsIs('instagram', ok, { width: 1080, height: 1920, fps: 30, size: 50e6 }), true);
  assert.equal(fitsAsIs('instagram', ok, { width: 1080, height: 1920, fps: 30, size: 400e6 }), false, 'over 300 MB');
  assert.equal(fitsAsIs('instagram', { ...ok, meta: { ...ok.meta, codec: 'prores' } }, { width: 1080, height: 1920, fps: 30, size: 50e6 }), false);
  assert.equal(fitsAsIs('instagram', ok, { width: 2160, height: 3840, fps: 30, size: 50e6 }), false, 'wider than Instagram takes');
  assert.equal(fitsAsIs('instagram', { ...ok, video: 'x.mkv' }, { width: 1080, height: 1920, fps: 30, size: 50e6 }), false);
  const ig = posts.findPost(posts.postsOf(slug)[0]?.id as string) as NonNullable<ReturnType<typeof posts.findPost>>;
  const sent = await platformFile(ig, review());
  assert.equal(sent.info.kind, 'encode', 'this final is more than Instagram takes');
  assert.match(sent.info.hash, /^[0-9a-f]{64}$/);
  const { post: yt } = posts.draftPost({ slug, platform: 'youtube', fields: {}, by: 'tester' });
  const own = await platformFile(yt, review());
  assert.deepEqual(own.info, { kind: 'final', hash: renderKey(ver), bytes: ver.size });
});

test('PUB-10: the platform encode carries none of the render’s own metadata (paths, titles, places, chapters)', async () => {
  const { FFMPEG, run } = await import('../../lib/probe.ts');
  const src = path.join(dir, 'tagged.mov');
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1'],
    ...['-c:v', 'libx264', '-c:a', 'aac'],
    ...['-metadata', 'comment=/Volumes/Studio/Spring Campaign/edit v12 internal cut', '-metadata', 'title=internal cut'],
    ...['-metadata', 'location=+48.8566+002.3522/', '-y', src],
  ]);
  const out = path.join(dir, 'tagged-out.mp4');
  await run(FFMPEG, encodeArgs(src, out, ENCODE_SPECS.instagram, { width: 320, height: 180, fps: 25 }));
  const tags = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format_tags:stream_tags:chapters', '-of', 'json', out]).toString();
  for (const said of ['Volumes', 'internal cut', '48.8566']) assert.ok(!tags.includes(said), `"${said}" left the machine: ${tags}`);
});
