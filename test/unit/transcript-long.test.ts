// covers: lib/probe.ts lib/stt/index.ts lib/stt/seams.ts lib/transcripts.ts lib/transcript.ts
// A tool's output past its run's buffer fails the run and stops the tool: never a success with the answer cut. A render
// longer than one window of audio (lib/stt decodes half an hour at a time) is heard to its end, window after window, its
// words on the render's clock, through the real transcript path (makeTranscript → transcribeTimed → the HTTP engine).
// The stand-in engine hears what is in the audio it is sent: each burst of tone is a word, from where it starts to where
// it ends in that audio, so a window's edge cuts a word as it would cut a real one. The windows overlap, and a word
// spoken across where one ends is heard whole, once; a word both windows heard whole is kept once too. A window that
// starts later in the file decodes the same samples a decode from the start gives there (compressed audio included).
// A transcript kept from before, of a render that long, is heard again; a shorter one stays.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Transcript, Version } from '../../lib/types.ts';
import { FFMPEG, isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { run, OutputTooLargeError } = await import('../../lib/probe.ts');
const { cachedTranscript, makeTranscript, transcriptFile } = await import('../../lib/transcripts.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { decodePcm } = await import('../../lib/stt/index.ts');

// 32 minutes as a small WAV (8 kHz, 8 bits): silence, and a burst of tone for every word, one of them across 30:00
const MINUTES = 32;
const RATE = 8000;
const SAID: [number, number][] = [
  [300, 300.5],
  [1793, 1793.4],
  [1799.7, 1800.3],
  [1900, 1900.5],
];
const audio = path.join(dir, 'talk.wav');
{
  const n = MINUTES * 60 * RATE;
  const wav = Buffer.alloc(44 + n, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n, 40);
  for (const [t0, t1] of SAID)
    for (let i = Math.round(t0 * RATE); i < Math.round(t1 * RATE); i++) wav[44 + i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * 330 * i) / RATE));
  fs.writeFileSync(audio, wav);
}

// the engine: how long each WAV it is sent runs, and a word for every burst in it, timed on that WAV's clock
const received: number[] = [];
const stt = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const riff = body.indexOf('RIFF');
    const bytes = body.readUInt32LE(riff + 40);
    received.push(bytes / 32000);
    const words: { word: string; start: number; end: number }[] = [];
    let start = -1;
    let last = -1;
    for (let i = 0; i < bytes / 2; i++) {
      if (Math.abs(body.readInt16LE(riff + 44 + 2 * i)) < 2000) continue;
      if (start >= 0 && i - last > 800) {
        words.push({ word: 'word', start: start / 16000, end: (last + 1) / 16000 });
        start = -1;
      }
      if (start < 0) start = i;
      last = i;
    }
    if (start >= 0) words.push({ word: 'word', start: start / 16000, end: (last + 1) / 16000 });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: words.map((w) => w.word).join(' '), language: 'english', words, segments: words.map((w) => ({ text: w.word, ...w })) }));
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));
after(() => stt.close());
const settings = {
  backend: 'http',
  http: { url: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`, model: 'stand-in' },
  languages: [],
  model: 'x',
  vocabulary: [],
} as unknown as Parameters<typeof makeTranscript>[2];

const FPS = 25;
const version = (seconds: number, n: number): Version =>
  ({
    v: 1,
    hash: String(n).repeat(40),
    sample: String(n + 1).repeat(40),
    mtime: '',
    size: 1,
    frames: seconds * FPS,
    fps: FPS,
    width: 160,
    height: 90,
    duration: seconds,
    registered: '',
  }) as Version;

test('a tool that writes past its run’s buffer fails the run and is stopped; within it, the whole answer comes', { timeout: 30_000 }, async () => {
  await assert.rejects(run('/bin/sh', ['-c', 'head -c 300000 /dev/zero'], { maxBuffer: 100_000 }), (e: Error & { stdout: Buffer }) => {
    assert.ok(e instanceof OutputTooLargeError, e.message);
    assert.equal(e.stdout.length, 0, 'no part of it passes for the answer');
    return true;
  });
  // one that would write for good is stopped, not waited for
  await assert.rejects(run('/bin/sh', ['-c', 'exec yes'], { maxBuffer: 1_000_000 }), OutputTooLargeError);
  assert.equal((await run('/bin/sh', ['-c', 'head -c 300000 /dev/zero'], { maxBuffer: 300_000 })).stdout.length, 300_000);
});

test('a render longer than one window is heard to its end: every word once and whole, on the render’s clock, and kept', async () => {
  const ver = version(MINUTES * 60, 1);
  const t = await makeTranscript(audio, ver, settings);
  assert.deepEqual(
    t.words.map((w) => [Math.round(w.t0 * 10) / 10, Math.round(w.t1 * 10) / 10]),
    SAID,
    `each word once, the one across 30:00 whole: ${JSON.stringify(t.words.map((w) => [w.t0, w.t1]))}`,
  );
  assert.deepEqual(
    received.map((s) => Math.round(s)),
    [1800, (MINUTES - 30) * 60 + 10],
    'two windows: half an hour, then the rest from ten seconds before it ended',
  );
  assert.ok(Math.abs((t.words.at(-1)?.f0 ?? 0) - 1900 * FPS) <= 1, `the last word's frame: ${t.words.at(-1)?.f0}`);
  assert.equal(cachedTranscript(ver)?.words.length, SAID.length, 'kept as heard');
});

test('the seam is cut where neither window hears a word, in the middle half of their overlap', async () => {
  const { seamCut } = await import('../../lib/stt/seams.ts');
  const heard = (spans: [number, number][]) => ({ words: spans.map(([t0, t1]) => ({ t0, t1 })), segments: [] });
  // the earlier window hears up to 100, the later one from 90: a word at 93–93.4 in both, one cut at 100 by the first
  const cut = seamCut(
    heard([
      [93, 93.4],
      [99.7, 100],
    ]),
    heard([
      [93, 93.4],
      [99.7, 100.3],
    ]),
    90,
    100,
  );
  assert.ok(cut > 93.4 && cut < 97.5, `cut at ${cut}`);
  // speech all through the middle half: its middle
  assert.equal(seamCut(heard([[91, 99]]), heard([[91, 99]]), 90, 100), 95);
});

test('a window that starts later in the file gives the samples a decode from its start gives there', async () => {
  const tone = path.join(dir, 'tone.m4a');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30', '-c:a', 'aac', '-b:a', '128k', '-y', tone]);
  const whole = await decodePcm(tone, { from: 0, seconds: 20 });
  for (const from of [10, 12.345, 17.9]) {
    const later = await decodePcm(tone, { from, seconds: 2 });
    const at = Math.round(from * 16000);
    let most = 0;
    for (let i = 0; i < 640; i++) most = Math.max(most, Math.abs((later[i] as number) - (whole[at + i] as number)));
    assert.ok(most < 0.002, `from ${from} s: the first 40 ms differ by up to ${most.toFixed(4)}`);
  }
});

test('a transcript kept from before of a render over half an hour is heard again; a shorter one stays', () => {
  const keep = (ver: Version, transcript_version: number) => {
    const t: Transcript = {
      transcript_version,
      hash: ver.hash,
      language: 'en',
      engine: 'http:x',
      timing: 'word',
      fps: FPS,
      frames: ver.frames,
      words: [],
      lines: [],
      created: '',
    };
    fs.mkdirSync(path.dirname(transcriptFile(renderKey(ver))), { recursive: true });
    fs.writeFileSync(transcriptFile(renderKey(ver)), JSON.stringify(t));
  };
  for (const [made, n] of [
    [2, 3],
    [3, 7],
  ]) {
    const long = version(40 * 60, n);
    const short = version(10 * 60, n + 2);
    keep(long, made);
    keep(short, made);
    assert.equal(cachedTranscript(long), null, `version ${made}: cut at half an hour, or at its seam then: heard again`);
    assert.equal(cachedTranscript(short)?.transcript_version, made, `version ${made}: heard whole then: kept`);
  }
});
