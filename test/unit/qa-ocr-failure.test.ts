// Auto-check with a text recognition that is installed but fails at run time (tesseract with broken language data, a
// run the OOM killer ends): the real runQa with a stand-in tesseract that lists its languages and then fails on the
// images it is told to. A frame it failed on is unread, never a frame without text: on all of them the text wasn't
// checked (not "no text on screen"), on some the rest was, and the result says how many in a note either way.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Version } from '../../lib/types.ts';
import { isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';

const bin = tmpdir('vr-tesseract-');
const mode = path.join(bin, 'mode');
// `fail`: every image; `alternate`: every other sampled frame (r-00001.jpg, r-00003.jpg …); `ok`: two words on each
fs.writeFileSync(
  path.join(bin, 'tesseract'),
  `#!/bin/sh
if [ "$1" = "--list-langs" ]; then printf 'List of available languages in "/x/" (3):\\ndeu\\neng\\nosd\\n'; exit 0; fi
m="$(cat "${mode}")"
odd=no
case "$1" in *[13579].jpg) odd=yes ;; esac
if [ "$m" = fail ] || { [ "$m" = alternate ] && [ $odd = yes ]; }; then
  echo "Error opening data file /x/eng.traineddata" >&2; exit 1
fi
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n'
printf '1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t640\\t360\\t-1\\t\\n'
printf '5\\t1\\t1\\t1\\t1\\t1\\t200\\t280\\t110\\t30\\t95\\tWelcome\\n'
printf '5\\t1\\t1\\t1\\t1\\t2\\t320\\t280\\t110\\t30\\t95\\tfriends\\n'
`,
  { mode: 0o755 },
);
const { dir } = isolatedEnv({ vars: { VR_OCR: 'tesseract', VR_TESSERACT: path.join(bin, 'tesseract') } });
const { runQa, cachedQa } = await import('../../lib/qa.ts');
const { probeSync, quickHash } = await import('../../lib/probe.ts');

let n = 0;
function render(): { file: string; ver: Version } {
  const file = makeVideo(path.join(dir, `r${++n}.mp4`), { w: 640, h: 360, dur: 2, freq: 300 + n * 70 });
  const m = probeSync(file);
  const ver = {
    v: 1,
    hash: quickHash(file),
    mtime: '',
    size: fs.statSync(file).size,
    registered: '',
    fps: m.fps,
    width: m.width,
    height: m.height,
    frames: m.frames,
    duration: m.duration,
  } as Version;
  return { file, ver };
}

test('text recognition fails on every frame: not checked (never "no text"), said, and Run again can retry it', async () => {
  fs.writeFileSync(mode, 'fail');
  const { file, ver } = render();
  const r = await runQa(file, ver);
  assert.ok(r.samples > 0);
  assert.equal(r.spelling?.unread, r.samples, 'every sampled frame unread');
  assert.equal(r.spelling?.state, 'unavailable', 'the text wasn’t checked');
  assert.match((r.notes ?? []).join('\n'), new RegExp(`text recognition failed on all ${r.samples} sampled frames`));
  assert.ok(cachedQa(ver), 'kept like any result: Run again clears it');
});

test('text recognition fails on some frames: the rest is checked, and how many weren’t is said', async () => {
  fs.writeFileSync(mode, 'alternate');
  const { file, ver } = render();
  const r = await runQa(file, ver);
  const unread = r.spelling?.unread ?? 0;
  assert.ok(unread > 0 && unread < r.samples, `some frames unread: ${unread} of ${r.samples}`);
  assert.match((r.notes ?? []).join('\n'), new RegExp(`text recognition failed on ${unread} of ${r.samples} sampled frames`));
});

test('a recognition that reads every frame says nothing of the kind', async () => {
  fs.writeFileSync(mode, 'ok');
  const { file, ver } = render();
  const r = await runQa(file, ver);
  assert.equal(r.spelling?.unread, undefined);
  assert.doesNotMatch((r.notes ?? []).join('\n'), /text recognition failed/);
});
