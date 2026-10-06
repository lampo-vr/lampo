// What a media tool prints on stderr is kept only from its end (audit A12, MEDIA-1). A damaged or crafted file makes
// ffmpeg print a line for every broken frame, even at `-v error`, so a whole stderr kept in memory let one upload drive
// the server out of it. Here ffmpeg prints a line per frame for 6,000 frames (about 2 MB): run() keeps the end, with
// the last line in it; a spawned process's stderr is read and bounded too, so it never stalls on a full pipe either.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { FFMPEG, run, spawnMedia, STDERR_KEEP, tailOf } = await import('../../lib/probe.ts');

// 6,000 frames of a tiny picture, each told by showinfo on stderr: about 2 MB of text.
const LOUD = ['-hide_banner', '-nostats', '-v', 'info', '-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=100:duration=60', '-vf', 'showinfo', '-f', 'null', '-'];

test('run() keeps the end of stderr, however much a tool prints', async () => {
  const { stderr } = await run(FFMPEG, LOUD, { timeout: 60_000 });
  assert.ok(stderr.length <= STDERR_KEEP, `kept ${stderr.length} bytes`);
  assert.ok(stderr.length > STDERR_KEEP / 2, 'the end is kept, not nothing');
  assert.match(stderr, /n:\s*5999 /, 'the last frame’s line is in it');
});

test('a failing run says how it ended from the kept end', async () => {
  const failing = [...LOUD.slice(0, -2), '-f', 'mp4', '/nonexistent-dir/x.mp4'];
  await assert.rejects(run(FFMPEG, failing, { timeout: 60_000 }), (e: Error & { stderr: string }) => {
    assert.ok(e.stderr.length <= STDERR_KEEP);
    assert.match(e.message, /exited/);
    return true;
  });
});

test('a spawned media process: stderr is read as it comes and only its end is kept', { timeout: 60_000 }, async () => {
  const p = spawnMedia(FFMPEG, LOUD);
  const code = await new Promise<number | null>((r) => p.on('close', r));
  assert.equal(code, 0, 'it ran to the end (a stderr nobody reads would have stalled it on a full pipe)');
  const tail = p.stderrTail();
  assert.ok(tail.length <= STDERR_KEEP, `kept ${tail.length} bytes`);
  assert.match(tail, /n:\s*5999 /);
});

test('tailOf: the last bytes, whatever the chunks', () => {
  const t = tailOf(10);
  for (const s of ['abc', 'defghij', 'klmnopqrstuvwxyz', '0123']) t.push(Buffer.from(s));
  assert.equal(t.text(), 'stuvwxyz0123'.slice(-10));
  const one = tailOf(4);
  one.push(Buffer.from('a very long single chunk'));
  assert.equal(one.text(), 'hunk');
});
