// Files from outside (uploads, fix previews) meet ffmpeg only through the incoming demuxers, with wall-clock limits,
// and renders whose headers promise absurd sizes or durations are refused before any work starts on them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const probe = await import('../../lib/probe.ts');
const { slugify } = await import('../../lib/paths.ts');
const { attachPreview } = await import('../../lib/previews.ts');

const incoming = path.join(dir, 'incoming');
fs.mkdirSync(incoming, { recursive: true });
const at = (name: string) => path.join(incoming, name);
const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);
const upload = (file: string, name = path.basename(file)) => store.ingestUpload(file, { name, folder: 'Hostile', keep: true });

const good = at('good.mp4');
makeVideo(good, { w: 160, h: 90, dur: 1 });
age(good);

test('a concat playlist dressed up as an mp4 is refused without ffmpeg opening it as a playlist', async () => {
  const list = at('list.mp4');
  fs.writeFileSync(list, 'ffconcat version 1.0\nfile good.mp4\n');
  // Before: ffprobe read it as "concat" (and opened good.mp4 through it); the error named the playlist format.
  await assert.rejects(upload(list), (e: Error) => /not a video ffmpeg can read/.test(e.message) && !/concat/.test(e.message));
  assert.equal(await probe.probeFormat(list), '', 'the incoming probe never identifies a playlist');
});

test('an HLS playlist renamed .mp4 is refused', async () => {
  const hls = at('hls.mp4');
  fs.writeFileSync(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${good}\n#EXT-X-ENDLIST\n`);
  await assert.rejects(upload(hls), /not a video ffmpeg can read/);
});

test('a render whose header claims an absurd duration is refused before any job runs on it', async () => {
  const mkv = at('forever.mkv');
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mkv);
  // Matroska's segment Duration (ID 0x4489) in milliseconds: claim a billion seconds.
  const bytes = fs.readFileSync(mkv);
  const i = bytes.indexOf(Buffer.from([0x44, 0x89]));
  assert.ok(i > 0, 'the segment has a duration');
  if (bytes[i + 2] === 0x88) bytes.writeDoubleBE(1e12, i + 3);
  else bytes.writeFloatBE(1e12, i + 3);
  fs.writeFileSync(mkv, bytes);
  assert.ok((await probe.probe(mkv)).duration > 1e8, 'ffprobe believes the header');
  await assert.rejects(upload(mkv), /at most \d+ s/);
});

test('a 30000 × 30000 PNG header is refused as a still, quickly', async () => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(30000, 0);
  ihdr.writeUInt32BE(30000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = at('bomb.png');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(png, Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(90003))), chunk('IEND', Buffer.alloc(0))]));
  const { review } = await upload(good, 'target.mp4');
  const note = store.addComment(slugify(review.video), { frame: 3, text: 'Logo später', author: 'tester' });
  const t0 = Date.now();
  await assert.rejects(attachPreview(note.id, png, { kind: 'still', by: 'agent:x' }), /px on each side|PNG, JPEG or WebP/);
  assert.ok(Date.now() - t0 < 5000, 'refused from the header, without decoding 900 megapixels');
});

test('ffmpeg runs have a wall-clock limit and are killed after it', { timeout: 20_000 }, async () => {
  const t0 = Date.now();
  // An endless source: before, this never returned.
  await assert.rejects(probe.run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16', '-f', 'null', '-'], { timeout: 400 }), /took longer than/);
  assert.ok(Date.now() - t0 < 5000);
});

// A container capped at 8 CPUs on a 32-thread host: ffmpeg counted 32 and started ~3 × 32 threads per run; a few runs
// at once used up the container's process limit and Accept's PNG encoder failed to start.
test('every ffmpeg run gets as many threads as this machine or container has (at most 8), unless the caller set its own', () => {
  const n = probe.ffmpegThreads();
  assert.ok(n >= 1 && n <= 8, `threads ${n}`);
  const t = String(n);
  assert.deepEqual(probe.safeArgs(probe.FFMPEG, ['-v', 'error', '-i', 'in.mp4', '-frames:v', '1', 'out.png'], null), [
    ...['-filter_threads', t, '-filter_complex_threads', t, '-v', 'error'],
    ...['-protocol_whitelist', 'file,pipe', '-threads', t, '-i', 'in.mp4', '-frames:v', '1', '-threads', t, 'out.png'],
  ]);
  const own = ['-threads', '2', '-i', 'in.mp4', 'out.png'];
  assert.ok(!probe.safeArgs(probe.FFMPEG, own, null).includes('-filter_threads'), "a caller's own -threads is left alone");
  assert.deepEqual(probe.safeArgs(probe.FFPROBE, ['-i', 'in.mp4'], null).includes('-threads'), false, 'ffprobe is untouched');
});

test('a hosted instance holds every detected input to the incoming demuxers; forced formats stay as they are', async () => {
  // the caller's own -threads: the thread cap stays out of this check
  const args = ['-threads', '1', '-i', 'in.mp4', '-f', 'lavfi', '-i', 'anullsrc', '-f', 'null', '-'];
  assert.deepEqual(probe.safeArgs(probe.FFMPEG, args, null), [
    ...['-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', 'in.mp4', '-f', 'lavfi', '-protocol_whitelist', 'file,pipe', '-i', 'anullsrc'],
    ...['-f', 'null', '-'],
  ]);
  assert.deepEqual(probe.safeArgs(probe.FFMPEG, args, 'mov'), [
    ...['-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-i', 'in.mp4'],
    ...['-f', 'lavfi', '-protocol_whitelist', 'file,pipe', '-i', 'anullsrc', '-f', 'null', '-'],
  ]);
  probe.restrictFormats(true);
  try {
    const list = at('list2.mp4');
    fs.writeFileSync(list, 'ffconcat version 1.0\nfile good.mp4\n');
    await assert.rejects(probe.run(FFMPEG, ['-v', 'error', '-i', list, '-f', 'null', '-']), /not on whitelist|Invalid data/);
    const jpg = at('still.jpg');
    ffmpeg('-i', good, '-frames:v', '1', jpg);
    await probe.run(FFMPEG, ['-v', 'error', '-i', good, '-i', jpg, '-filter_complex', '[0:v][1:v]overlay', '-frames:v', '1', '-f', 'null', '-']);
    assert.equal((await probe.probe(good)).width, 160, 'renders and our own frames still open');
  } finally {
    probe.restrictFormats(false);
  }
});

test('on the machine too, files from outside are read again only through the incoming demuxers', async () => {
  const { toM4a } = await import('../../lib/voice.ts');
  // A "voice note" that is a concat playlist of a sound file next to it: ffmpeg would read the playlist and the file.
  const wav = at('tone.wav');
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav);
  const list = at('voice.webm');
  fs.writeFileSync(list, 'ffconcat version 1.0\nfile tone.wav\n');
  await assert.rejects(toM4a(list, at('voice.m4a')), /not on whitelist|Invalid data/);
  await toM4a(wav, at('tone.m4a'));
  assert.ok(fs.statSync(at('tone.m4a')).size > 0, 'a real recording still converts');
});

test('every ffmpeg run on a reference, a profile picture, a voice note or a fix-preview clip names the incoming demuxers', () => {
  // Those files always come from outside (clients, agents, other people): the probe checks them with the list, and
  // every later read of them keeps to it, on a hosted instance and on the machine alike.
  const calls = (file: string, only?: string): string[] => {
    let src = fs.readFileSync(path.join(import.meta.dirname, '../../lib', file), 'utf8');
    if (only) src = src.slice(src.indexOf(`async function ${only}(`), src.indexOf('\n}\n', src.indexOf(`async function ${only}(`)));
    const out: string[] = [];
    for (let i = src.indexOf('run('); i >= 0; i = src.indexOf('run(', i + 1)) {
      let depth = 0;
      let j = i + 3;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      out.push(src.slice(i, j + 1));
    }
    return out.filter((c) => c.includes('FFMPEG'));
  };
  for (const [file, only] of [['refs.ts'], ['avatars.ts'], ['voice.ts'], ['previews.ts', 'playableClip']] as const) {
    const found = calls(file, only);
    assert.ok(found.length, `${file}: ffmpeg runs found`);
    for (const c of found) assert.match(c, /incoming: true/, `${file}${only ? ` ${only}` : ''}: ${c.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
});

// A13 MEDIA-2: a side and an aspect ratio no render has. A 16×8192 upload passed and every analysis scaled its height
// with the aspect (128 × 65536 RGB frames for footage search, 160 × 81920 for the diff): seconds of a frozen server.
const thinClip = (name: string, w: number, h: number, seconds = 0.2) => {
  const f = at(name);
  ffmpeg('-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=25`, '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f);
  return f;
};

test('an upload thinner than 1:8, wider than 8:1 or under 32 px on a side is refused before any work starts', async () => {
  await assert.rejects(upload(thinClip('sliver.mp4', 16, 8192), 'sliver.mp4'), /16×8192/);
  await assert.rejects(upload(thinClip('thin.mp4', 32, 8192), 'thin.mp4'), /8:1/);
  await assert.rejects(upload(thinClip('ribbon.mp4', 264, 32), 'ribbon.mp4'), /8:1/);
  await assert.rejects(upload(thinClip('tiny.mp4', 24, 24), 'tiny.mp4'), /at least 32 px/);
  const { review } = await upload(thinClip('banner.mp4', 256, 32), 'banner.mp4');
  assert.equal(review.versions[0]?.width, 256, 'a banner at 8:1 is still a render');
});

test('analysis pictures stay small whatever the aspect ratio: a thin render on the machine is squeezed, not decoded huge', async () => {
  const { analysisSize } = await import('../../lib/diff.ts');
  const { analysisHeight, newReading, readChunk } = await import('../../lib/footage/analyse.ts');
  // real shapes keep their analysis size: 16:9, 9:16, 4:5
  assert.deepEqual(analysisSize(1920, 1080), { w: 160, h: 90 });
  assert.deepEqual(analysisSize(1080, 1920), { w: 160, h: 284 });
  assert.deepEqual(analysisSize(1080, 1350), { w: 160, h: 200 });
  assert.equal(analysisHeight(1920, 1080), 72);
  // the diff's 160 px picture, footage search's 128 px one, Auto-check's and the shot cuts' 64 px one: at most 1:4
  assert.ok(analysisSize(16, 8192).h <= 640, `the diff's picture is 160 × ${analysisSize(16, 8192).h}`);
  assert.ok(analysisHeight(16, 8192) <= 512, `footage search's picture is 128 × ${analysisHeight(16, 8192)}`);
  assert.equal(probe.analysisRows?.(64, 16, 8192), 256, "Auto-check's and the cuts' picture is 64 × 256");
  // a 16×8192 file tracked on the machine (no upload check there) read by footage search: a few small frames held
  const thin = thinClip('thin-local.mp4', 16, 8192, 0.4);
  const meta = await probe.probe(thin);
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const poll = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
  }, 2);
  try {
    await readChunk(thin, meta, newReading(), 10);
  } finally {
    clearInterval(poll);
  }
  assert.ok(peak < 16e6, `reading 10 frames held ${Math.round(peak / 1e6)} MB`);
});
