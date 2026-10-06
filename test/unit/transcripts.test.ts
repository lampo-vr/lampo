// A render's captions as an embed's player asks for them (lib/transcripts.ts captionsVtt): read and parsed once, then
// kept in memory while they are asked for. Many captioned videos asked for in turn stay read once; the memory is
// bounded by bytes; what is asked for stays while the rest makes room; and one workspace's many long videos can't push
// another workspace's captions out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const { captionsMemory, captionsVtt, CAPTIONS_KEPT, transcriptFile } = await import('../../lib/transcripts.ts');
const { TRANSCRIPT_VERSION } = await import('../../lib/transcript.ts');
const { DEFAULT_WORKSPACE, inWorkspace } = await import('../../lib/scope.ts');
const { Memo } = await import('../../lib/rateLimit.ts');

const texts = captionsMemory.captionTexts;
const OTHER = 'w_bbbbbbbbbbbb';

interface Heard {
  ws: string;
  ver: { hash: string };
  file: string;
}

/** A version of workspace `ws` whose transcript says one line of `chars` characters (its WebVTT is about as long). */
function heard(ws: string, hash: string, chars: number): Heard {
  return inWorkspace(ws, () => {
    const file = transcriptFile(hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        transcript_version: TRANSCRIPT_VERSION,
        hash,
        language: 'en',
        engine: 'local:test',
        timing: 'line',
        fps: 25,
        frames: 25,
        words: [],
        lines: [{ text: `${hash} ${'w'.repeat(chars)}`, t0: 0, t1: 1, f0: 0, f1: 24, w0: 0, n: 1 }],
        created: '2026-10-06T10:00:00+02:00',
      }),
    );
    return { ws, ver: { hash }, file };
  });
}

const ask = (h: Heard): string | null => inWorkspace(h.ws, () => captionsVtt(h.ver));

/** How often each of these transcripts is read from disk while `t` runs. */
function countReads(t: TestContext, of: Heard[]): Map<string, number> {
  const reads = new Map(of.map((h) => [h.file, 0]));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => {
    const n = reads.get(args[0] as string);
    if (n !== undefined) reads.set(args[0] as string, n + 1);
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readFileSync);
  return reads;
}
const sum = (reads: Map<string, number>, of: Heard[]) => of.reduce((n, h) => n + (reads.get(h.file) ?? 0), 0);

// a site with a wall of short captioned films, in workspace #1
const wall = Array.from({ length: 40 }, (_, i) => heard(DEFAULT_WORKSPACE, `wall-${i}`, 2_000));
// another workspace's long talks, about 800 KB each in memory: together more than the memory holds (32 MiB)
const talks = Array.from({ length: 53 }, (_, i) => heard(OTHER, `talk-${i}`, 400_000));

test('captions are kept in a memory that is fair between workspaces', () => {
  assert.ok(texts instanceof Memo, 'a Memo (listed with keptInMemory as a Recent)');
});

test('forty captioned videos asked for in turn are each read once', (t) => {
  const reads = countReads(t, wall);
  for (let round = 0; round < 3; round++) for (const h of wall) assert.ok(ask(h)?.includes(`\n${h.ver.hash} www`), h.ver.hash);
  assert.equal(sum(reads, wall), wall.length, `${sum(reads, wall)} reads for ${wall.length} videos asked for three times`);
});

test('long captions are bounded by bytes; one asked for again and again stays while the others make room', (t) => {
  const reads = countReads(t, talks);
  const [first, ...rest] = talks as [Heard, ...Heard[]];
  ask(first);
  for (const h of rest) {
    ask(h);
    ask(first);
  }
  assert.equal(reads.get(first.file), 1, 'the one asked for all along was read once');
  assert.ok(talks.length * 800_000 > CAPTIONS_KEPT.textBytes, 'the talks are more than the memory holds');
  assert.ok(texts.bytes() <= CAPTIONS_KEPT.textBytes, `${texts.bytes()} bytes held`);
  assert.ok(texts.bytes(OTHER) > CAPTIONS_KEPT.textBytes / 2, 'a workspace may use more than its part while nobody else needs it');
  assert.ok(texts.sizeOf(OTHER) < talks.length, 'not every talk is kept');
  ask(talks[1] as Heard);
  assert.equal(reads.get((talks[1] as Heard).file), 2, 'the least recently used made room');
});

test('one workspace’s many long captions, then its many videos, never push another workspace’s captions out', (t) => {
  // the wall (workspace #1) was asked for before the talks filled the memory: it is still there
  const reads = countReads(t, wall);
  for (const h of wall) ask(h);
  assert.equal(sum(reads, wall), 0, 'the wall is read from memory after the other workspace’s flood of bytes');
  // the other workspace now asks for more videos than the memory has entries (made-up renders, no captions)
  inWorkspace(OTHER, () => {
    for (let i = 0; i < CAPTIONS_KEPT.texts + 100; i++) captionsVtt({ hash: `quiet-${i}` });
  });
  assert.ok(texts.size <= CAPTIONS_KEPT.texts, `${texts.size} entries`);
  for (const h of wall) ask(h);
  assert.equal(sum(reads, wall), 0, 'and after its flood of entries');
});
