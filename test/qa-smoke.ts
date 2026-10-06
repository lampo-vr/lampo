// QA pre-review smoke test: renders a short clip with known defects and checks lib/qa.ts finds them.
// Runs wherever the text engines exist: macOS (Vision + NSSpellChecker) or tesseract (deu+eng) + hunspell
// (de_DE, en_US), e.g. in the Docker image. VR_OCR=tesseract tries the tesseract path on a Mac.
// Uses a temporary store and cache. Run: node --test test/qa-smoke.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { QaKind, Version } from '../lib/types.ts';
import { must } from './lib/helpers.ts';

// Store and cache first: lib/paths.ts resolves them when it is first imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-qa-test-'));
process.env.VR_DATA = path.join(tmp, 'data');
process.env.VR_CACHE = path.join(tmp, 'cache');
const { textTools } = await import('../lib/text/index.ts');
const tools = await textTools();

const has = (cmd: string) => {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const skip = !has('ffmpeg') ? 'ffmpeg missing' : !tools.ocr || !tools.spell ? tools.notes.join('; ') || 'no text engines' : false;

test('QA finds typos, safe-zone hits, a flash frame, black gap, clipping, silence', { skip, timeout: 180000 }, async () => {
  const { runQa, cachedQa } = await import('../lib/qa.ts');
  const { probeSync, quickHash } = await import('../lib/probe.ts');

  // 1080×1920, 6 s @ 30 fps: two typos (top bar + caption zone), a red frame at 90, black 120–123,
  // full-scale audio 2–3 s, silence 4–4.8 s.
  const font = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  ].find((f) => fs.existsSync(f));
  const filter = path.join(tmp, 'f.txt');
  fs.writeFileSync(
    filter,
    [
      `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0x303030@0.85:t=fill`,
      `drawtext=fontfile=${font}:text='Skincrae Routine':fontsize=78:fontcolor=white:x=120:y=90`,
      `drawtext=fontfile=${font}:text='Der Hintergrnud ist zu hell':fontsize=58:fontcolor=white:x=90:y=1700`,
      `drawtext=fontfile=${font}:text='Alles gut hier':fontsize=70:fontcolor=white:x=200:y=900`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='eq(n,90)'`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,120,123)'[v]`,
    ].join(',\n'),
  );
  const clip = path.join(tmp, 'qa.mp4');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1080x1920:rate=30:duration=6',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(between(t\\,2\\,3)\\,0.999*sin(2*PI*440*t)\\,if(between(t\\,4\\,4.8)\\,0\\,0.1*sin(2*PI*440*t))):s=48000:c=stereo:d=6',
    '-filter_complex_script',
    filter,
    '-map',
    '[v]',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-y',
    clip,
  ]);

  const m = probeSync(clip);
  const ver: Version = {
    v: 1,
    hash: quickHash(clip),
    mtime: '',
    size: fs.statSync(clip).size,
    registered: '',
    fps: m.fps,
    width: m.width,
    height: m.height,
    frames: m.frames,
    duration: m.duration,
  };
  const meta = { codec: m.codec, pix_fmt: m.pix_fmt, color_space: m.color_space, color_range: m.color_range, audio: m.audio };
  const r = await runQa(clip, ver, meta);
  const kinds = (k: QaKind) => r.items.filter((i) => i.kind === k);

  const typos = kinds('typo').map((i) => i.text);
  assert.ok(
    typos.some((t) => t.includes('"Skincrae" → "Skincare"')),
    `typo Skincrae: ${typos}`,
  );
  assert.ok(
    typos.some((t) => t.includes('"Hintergrnud" → "Hintergrund"')),
    `typo Hintergrnud: ${typos}`,
  );
  assert.equal(typos.length, 2, `no other typos: ${typos}`);
  // German captions read as German and are checked in it (a recogniser alone named rare languages for a few words)
  assert.equal(r.text_language, 'de', `text language ${r.text_language}`);
  assert.deepEqual(r.spelling?.languages, ['de', 'en']);
  assert.deepEqual(
    kinds('safe-zone')
      .map((i) => i.zone)
      .sort(),
    ['ig-caption', 'ig-topbar'],
  );
  assert.deepEqual(
    kinds('flash-frame').map((i) => i.frame),
    [90],
  );
  assert.deepEqual(
    kinds('black-frames').map((i) => i.range),
    [{ in: 120, out: 123 }],
  );
  assert.equal(kinds('clipping').length, 1);
  assert.equal(kinds('silence').length, 1);
  // what the player says comes from the findings' fields: the word and the line, and what the guess rests on
  const typo = must(kinds('typo').find((i) => i.word === 'Hintergrnud'));
  assert.equal(typo.guess, 'Hintergrund');
  assert.equal(typo.line, 'Der Hintergrnud ist zu hell');
  assert.equal(typo.likely, 'problem');
  assert.deepEqual(
    kinds('black-frames').map((i) => [i.likely, i.why]),
    [['problem', 'black-gap']],
  );
  assert.equal(r.spelling?.state, 'checked');
  assert.ok((r.spelling?.words ?? 0) >= 5, `the words spell-checked: ${JSON.stringify(r.spelling)}`);
  for (const it of r.items) {
    assert.ok(it.key && it.kind && ['must', 'should', 'nice'].includes(it.severity) && Number.isInteger(it.frame), JSON.stringify(it));
    if (it.box) assert.ok(it.box.x >= 0 && it.box.y >= 0 && it.box.x + it.box.w <= 1080 && it.box.y + it.box.h <= 1920);
  }
  // cached by content hash, same keys on re-read
  assert.deepEqual(
    must(cachedQa(ver)).items.map((i) => i.key),
    r.items.map((i) => i.key),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});
