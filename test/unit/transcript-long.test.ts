// covers: lib/probe.ts lib/stt/index.ts lib/transcripts.ts lib/transcript.ts
// A tool's output past its run's buffer fails the run and stops the tool: never a success with the answer cut. A render
// longer than one window of audio (lib/stt decodes half an hour at a time) is heard to its end, window after window, its
// words on the render's clock, through the real transcript path (makeTranscript → transcribeTimed → the HTTP engine) with
// a stand-in engine that answers one word at the start of every minute it is sent. A transcript kept from before, of a
// render that long, stopped at the first window: it is heard again; a shorter one stays.
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

// 32 minutes of tone as a small WAV (8 kHz, 8 bits): more than one window, quick to make and to decode
const MINUTES = 32;
const audio = path.join(dir, 'talk.wav');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=8000:duration=${MINUTES * 60}`, '-c:a', 'pcm_u8', '-y', audio]);

// the engine: how long each WAV it is sent runs, and a word at the start of every minute in it
const received: number[] = [];
const stt = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const seconds = body.readUInt32LE(body.indexOf('RIFF') + 40) / 32000;
    received.push(seconds);
    const words = [];
    for (let m = 0; m * 60 < seconds; m++) words.push({ word: `minute${m}`, start: m * 60 + 1, end: m * 60 + 1.5 });
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

test('a render longer than one window is heard to its end, each word on the render’s clock, and kept', async () => {
  const ver = version(MINUTES * 60, 1);
  const t = await makeTranscript(audio, ver, settings);
  assert.deepEqual(
    received.map((s) => Math.round(s)),
    [1800, (MINUTES - 30) * 60],
    'two windows: half an hour, then the rest',
  );
  // the engine counts the minutes of what it was sent: the second window's start again at minute0
  assert.deepEqual(
    t.words.map((w) => w.text),
    Array.from({ length: MINUTES }, (_, m) => `minute${m % 30}`),
  );
  for (const [m, w] of t.words.entries()) assert.ok(Math.abs(w.t0 - (m * 60 + 1)) < 0.01, `the word of minute ${m} at ${w.t0} s`);
  assert.equal(t.words.at(-1)?.f0, Math.round((31 * 60 + 1) * FPS));
  assert.equal(cachedTranscript(ver)?.words.length, MINUTES, 'kept as heard');
});

test('a transcript kept from before of a render over half an hour is heard again; a shorter one stays', () => {
  const keep = (ver: Version) => {
    const t: Transcript = {
      transcript_version: 2,
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
  const long = version(40 * 60, 3);
  const short = version(10 * 60, 5);
  keep(long);
  keep(short);
  assert.equal(cachedTranscript(long), null, 'stopped at half an hour then: heard again');
  assert.equal(cachedTranscript(short)?.transcript_version, 2, 'heard whole then: kept');
});
