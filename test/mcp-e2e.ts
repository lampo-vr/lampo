#!/usr/bin/env node
// End-to-end test of the MCP server over stdio with the real SDK client, against a throwaway store. The client is the
// v1 SDK, which speaks 2025-11-25: the stdio server serves that era as well as 2026-07-28.
//   node test/mcp-e2e.ts            (needs ffmpeg; creates and deletes a temp dir)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Review, ReviewEvent } from '../lib/types.ts';
import { cutFrames, fixBox, makeShotsVideo, must } from './lib/helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p)) || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-mcp-'));
const DATA = path.join(tmp, 'data');
const VIDEO = path.join(tmp, 'proj', 'export', 'clip.mp4');
fs.mkdirSync(path.dirname(VIDEO), { recursive: true });

const render = (out: string, pattern: string) =>
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `${pattern}=size=1080x1920:rate=30:duration=3`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=300:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    out,
  ]);
render(VIDEO, 'testsrc2');
const RANGE_VIDEO = path.join(tmp, 'proj', 'export', 'stretch.mp4');
render(RANGE_VIDEO, 'testsrc2');

const log = (...a: string[]) => console.log('  ✓', ...a);
const isJpeg = (b64: string) =>
  Buffer.from(b64, 'base64')
    .subarray(0, 3)
    .equals(Buffer.from([0xff, 0xd8, 0xff]));
const textOf = (res: CallToolResult) =>
  res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const images = (res: CallToolResult) => res.content.filter((c) => c.type === 'image');
// Width × height of a JPEG (its first SOF marker).
const jpegSize = (b64: string): [number, number] => {
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i + 9 < buf.length; i += 2 + buf.readUInt16BE(i + 2))
    if (buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(buf[i + 1])) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
  return [0, 0];
};

// The speech engine: a stand-in OpenAI-compatible server with timed words (get_transcript hears the render through it).
const stt = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'Every morning we start.',
        language: 'english',
        words: [
          { word: 'Every', start: 0.1, end: 0.32 },
          { word: 'morning', start: 0.32, end: 0.64 },
          { word: 'we', start: 0.64, end: 0.8 },
          { word: 'start.', start: 0.8, end: 1.04 },
        ],
      }),
    );
  });
});
await new Promise<void>((r) => stt.listen(0, '127.0.0.1', r));

// A clean environment: no Claude session, so the author falls back to the client name.
// VR_REMOTE=0: the local store even when this machine is signed in to a server (`vr login`).
// VR_CACHE too: otherwise a checkout without data/ caches frames in ~/.video-review, one with data/ in its live cache.
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  VR_DATA: DATA,
  VR_CACHE: path.join(tmp, 'cache'),
  VR_REMOTE: '0',
  VR_STT: 'http',
  VR_STT_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`,
  // footage search with the stand-in model: the index is made here, find_footage reads it (no model download)
  VR_FOOTAGE: 'auto',
  VR_FOOTAGE_MODEL: 'fake',
};
for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'VR_BY', 'VR_MODE', 'VR_STORAGE']) delete env[k];
const client = new Client({ name: 'mcp-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env, stderr: 'inherit' }));
const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (res.isError) throw new Error(`${name}: ${textOf(res)}`);
  return res;
};

try {
  // The server's name is lampo (the key people give it), its title Lampo; the tool names stay what agents know.
  assert.deepEqual([client.getServerVersion()?.name, client.getServerVersion()?.title], ['lampo', 'Lampo']);
  log('serverInfo → lampo, "Lampo"');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'add_note',
    'ask_options',
    'attach_preview',
    'attach_reference',
    'draft_post',
    'find_footage',
    'get_frame',
    'get_note',
    'get_open_notes',
    'get_playbook',
    'get_posts',
    'get_skill',
    'get_taste',
    'get_transcript',
    'list_folders',
    'list_videos',
    'mark_fixed',
    'move_video',
    'propose_playbook_change',
    'reply',
    'review_frame',
    'set_render_source',
    'set_status',
    'show_review',
    'track_video',
    'wait_for_feedback',
    'wont_fix',
  ]);
  log(`${names.length} tools: ${names.join(', ')}`);

  let res = await call('track_video', { path: VIDEO, folder: 'Tests/MCP' });
  assert.match(textOf(res), /added: .*clip\.mp4 \(v1\) · folder Tests\/MCP/);
  // the person reviews it now: the answer ends with "wait now", with a cursor from this moment (lib/handoff.ts)
  assert.match(textOf(res), /\nNow call wait_for_feedback with since "\S+#\d+": the person's notes arrive together when they press Send\.$/);
  log('track_video → added, filed into Tests/MCP; ends with "Now call wait_for_feedback with since …"');

  res = await call('add_note', {
    video: 'clip.mp4',
    timecode: '00:01:15',
    text: 'Logo zu früh',
    tags: ['timing'],
    kind: 'feedback',
    severity: 'must',
    box: { x: 180, y: 1040, w: 720, h: 400 },
  });
  const id1 = must(/(c_[0-9a-f]{6})/.exec(textOf(res)))[1];
  assert.match(textOf(res), /pinned at 00:01:15 \(f45, v1\) by agent:mcp-e2e/);
  log(`add_note → ${id1} at 00:01:15 = f45, author agent:mcp-e2e (client-name fallback)`);
  // How agents used to ask ("nice" because nothing fit): without a kind it is a question now.
  res = await call('add_note', { video: 'clip.mp4', frame: 80, text: 'Absicht?', severity: 'nice', by: 'agent:promo-edit' });
  const id2 = must(/(c_[0-9a-f]{6})/.exec(textOf(res)))[1];
  assert.match(textOf(res), /\nkind: question$/);
  log(`add_note (by agent:promo-edit) → ${id2}, a question by default`);

  // The notes are a second old when the agent reads them: `since` below is exact to the second.
  await new Promise((r) => setTimeout(r, 1100));
  res = await call('get_open_notes', { video: 'clip.mp4' });
  assert.match(textOf(res), new RegExp(`${id1} OPEN MUST 00:01:15 f45`));
  assert.match(textOf(res), new RegExp(`Questions to the reviewer, not answered yet[^]*${id2} OPEN QUESTION 00:02:20`), 'the question is not a work item');
  assert.match(textOf(res), /drawing: box x180 y1040 w720 h400 \(video px\)/);
  // Only the note with a drawing comes with a picture: its marked frame cropped around the box, ≤ 512 px.
  assert.equal(images(res).length, 1);
  assert.ok(isJpeg(images(res)[0].data));
  const crop = must(new RegExp(`${id1} f45 v1 marked, cropped: x(\\d+)–(\\d+) y(\\d+)–(\\d+) of 1080×1920`).exec(textOf(res)), textOf(res));
  const [x0, x1, y0, y1] = crop.slice(1).map(Number);
  assert.ok(x0 <= 180 && x1 >= 900 && y0 <= 1040 && y1 >= 1440, `the crop holds the box: ${crop[0]}`);
  const [cw, ch] = jpegSize(images(res)[0].data);
  assert.ok(Math.max(cw, ch) <= 512 && Math.abs(cw / ch - (x1 - x0) / (y1 - y0)) < 0.05, `cropped picture ${cw}×${ch}`);
  assert.doesNotMatch(textOf(res), /_marked\.png/, 'screenshot paths are get_note’s');
  const asOf = must(/\nas of (\S+)\n/.exec(textOf(res))?.[1], textOf(res));
  res = await call('get_open_notes', { video: 'clip.mp4', images: 'all' });
  assert.equal(images(res).length, 2);
  assert.ok(images(res).every((i) => i.mimeType === 'image/jpeg' && isJpeg(i.data)));
  log('get_open_notes → work first, questions apart, the drawn note cropped to its box (images: all → 2 marked frames)');

  // Where the render's named elements are (an elements map, written at half size): the drawn note then points at one.
  const mapFile = path.join(tmp, 'proj', 'export', 'clip.elements.json');
  const runs = [[0, 89]];
  fs.writeFileSync(
    mapFile,
    JSON.stringify({
      v: 1,
      fps: 30,
      size: [540, 960],
      elements: [
        { id: 'logo', name: 'Brand logo', kind: 'image', keys: [[0, 100, 530, 320, 180]], runs },
        { id: 'headline', name: 'Headline', kind: 'text', keys: [[0, 60, 120, 420, 90]], runs },
      ],
    }),
  );
  res = await call('track_video', { path: VIDEO, elements: mapFile });
  assert.match(textOf(res), /^already under review: .*clip\.mp4 \(v1\) · folder Tests\/MCP · session - · elements 2 on v1\n/);
  res = await call('get_open_notes', { video: 'clip.mp4', images: 'none' });
  assert.match(textOf(res), new RegExp(`${id1} OPEN MUST 00:01:15 f45 v1 \\[timing\\] · by agent:mcp-e2e · on #logo\\n`));
  assert.match(textOf(res), /\nelements: #logo "Brand logo"\n/);
  const structured = res.structuredContent as { notes: { id: string; elements: string[] }[]; as_of: string };
  assert.deepEqual(
    structured.notes.find((n) => n.id === id1),
    { id: id1, elements: ['logo'] },
  );
  assert.deepEqual(structured.notes.find((n) => n.id === id2)?.elements, [], 'a note without a drawing points at nothing');
  await assert.rejects(call('track_video', { path: VIDEO, elements: path.join(tmp, 'nowhere.json') }), /no elements map at/);
  log('track_video with elements → the map on v1; get_open_notes → "· on #logo", its name once in the header, structured elements');

  res = await call('get_note', { id: id1, clean: true });
  assert.equal(images(res).length, 2);
  log('get_note → marked + clean frame');

  // A question with the answers it expects: kept (cleaned), echoed, and shown with the note; one alone is refused.
  res = await call('add_note', { video: 'clip.mp4', frame: 30, text: 'Name richtig?', choices: ['Ja', '  Nein, es ist …  '], by: 'agent:promo-edit' });
  const idQ = must(/(c_[0-9a-f]{6})/.exec(textOf(res)))[1];
  assert.match(textOf(res), /\nkind: question\nchoices: Ja \| Nein, es ist …/);
  res = await call('get_note', { id: idQ });
  assert.match(textOf(res), /choices offered: Ja \| Nein, es ist …/);
  const lone = (await client.callTool({ name: 'add_note', arguments: { video: 'clip.mp4', frame: 30, text: 'x', choices: ['Ja'] } })) as CallToolResult;
  assert.equal(lone.isError, true, 'one choice is no choice');
  log(`add_note with choices → ${idQ}, echoed and in get_note; a single choice refused`);

  // What is said: heard once through the speech engine, each word on the frames it is heard on (30 fps).
  res = await call('get_transcript', { video: 'clip.mp4' });
  assert.match(textOf(res), /clip\.mp4 · v1 · 30 fps · en · word timings from the engine/);
  assert.match(textOf(res), /\n00:00:03–00:01:01 \(f3–f31\) {2}Every morning we start\.$/);
  res = await call('get_transcript', { video: 'clip.mp4', format: 'words' });
  assert.match(textOf(res), /\n00:00:09 f9–f19 {2}morning\n/);
  res = await call('get_transcript', { video: 'clip.mp4', format: 'srt' });
  assert.equal(textOf(res), '1\n00:00:00,100 --> 00:00:01,040\nEvery morning we start.\n');
  log('get_transcript → lines with frames, words, SRT');

  // A note about a stretch of the video: the range reads as timecodes and seconds, and the frames across it come along.
  // (Its own clip, so clip.mp4's counts below stay as they are.)
  await call('track_video', { path: RANGE_VIDEO });
  res = await call('add_note', {
    video: 'stretch.mp4',
    timecode: '00:00:12',
    to_timecode: '00:01:20',
    text: 'Musik hier zu laut',
    kind: 'feedback',
    severity: 'should',
  });
  const id3 = must(/(c_[0-9a-f]{6})/.exec(textOf(res)))[1];
  assert.match(textOf(res), /range 00:00:12 → 00:01:20 \(f12–f50, 1\.3 s\)/);
  res = await call('get_note', { id: id3 });
  assert.match(textOf(res), new RegExp(`${id3} OPEN SHOULD 00:00:12 f12 range 12-50 v1`), 'the frame tokens agents already parse stay');
  assert.match(textOf(res), /\n {2}range: 00:00:12 → 00:01:20 \(f12–f50, 1\.3 s\)/);
  assert.match(textOf(res), /frames across it, left to right, row by row: f12, f20, f27, f35, f42, f50/);
  assert.equal(images(res).length, 2, 'the marked frame and the strip across the range');
  assert.ok(images(res).every((i) => isJpeg(i.data)));
  const past = (await client.callTool({ name: 'add_note', arguments: { video: 'stretch.mp4', frame: 60, to_frame: 400, text: 'x' } })) as CallToolResult;
  assert.equal(past.isError, true);
  assert.match(textOf(past), /ends after the last frame/);
  log(`add_note with to_timecode → ${id3} range f12–f50; get_note → the range in words + a strip of six frames; past the end refused`);

  // get_frame must be the exact frame: compare with ffmpeg's decode of frames 44, 45, 46.
  res = await call('get_frame', { video: 'clip.mp4', frame: 45 });
  const got = path.join(tmp, 'got.jpg');
  fs.writeFileSync(got, Buffer.from(images(res)[0].data, 'base64'));
  const SMALL = 'scale=54:96:flags=area,format=gray';
  const gray = (input: string, pre = '') =>
    execFileSync(FFMPEG, ['-v', 'error', '-i', input, '-vf', pre + SMALL, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const mine = gray(got);
  const errs = [44, 45, 46].map((n) => {
    const ref = gray(VIDEO, `select=eq(n\\,${n}),`);
    return [n, ref.reduce((s, b, i) => s + Math.abs(b - mine[i]), 0) / ref.length];
  });
  const best = errs.reduce((a, b) => (b[1] < a[1] ? b : a));
  assert.equal(best[0], 45, `get_frame returned frame ${best[0]} (${JSON.stringify(errs)})`);
  log(`get_frame f45 → exact (MAE vs f44/45/46: ${errs.map((e) => e[1].toFixed(1)).join(' / ')})`);

  await call('reply', { id: id1, note: 'Schaue ich mir an' });
  log('reply');

  // Since the first read: id1 has a reply and idQ is new; id2 is only named.
  res = await call('get_open_notes', { video: 'clip.mp4', since: asOf });
  assert.match(textOf(res), new RegExp(`${id1} OPEN MUST 00:01:15 f45[^]*↳ agent:mcp-e2e: Schaue ich mir an`));
  assert.match(textOf(res), new RegExp(`${idQ} OPEN QUESTION`));
  assert.doesNotMatch(textOf(res), new RegExp(`${id2} OPEN`));
  assert.match(textOf(res), new RegExp(`\\nUnchanged since ${asOf.replace(/[.]/g, '\\.')}: ${id2}\\n`));
  log('get_open_notes since → the changed notes in full, the rest by id');

  // Re-render over the same path, then mark fixed: the new version must be registered and used.
  render(VIDEO, 'testsrc');
  res = await call('mark_fixed', { id: id1, note: 'Logo 4 Frames später, jetzt bei f49' });
  assert.match(textOf(res), /fixed in v2/);
  // the video's last open work (the rest are questions): wait for the person now
  assert.match(textOf(res), /fixed in v2\nNow call wait_for_feedback with since "\S+#\d+": /);
  log('re-render + mark_fixed → waited for the fresh render, fixed in v2; nothing open left → "Now call wait_for_feedback"');

  // Where v2 came from, then a still of a fix exported from the project (a file on this machine: path).
  res = await call('set_render_source', { video: 'clip.mp4', app: 'After Effects', project: 'clip.aep', comp: 'Main 9x16' });
  assert.match(textOf(res), /^v2: After Effects · clip\.aep · Main 9x16$/);
  const still = path.join(tmp, 'fix.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=540x960', '-frames:v', '1', '-y', still]);
  res = await call('attach_preview', { id: id2, path: still, note: 'So sähe es mit Logo aus' });
  assert.match(textOf(res), /preview p_[a-f0-9]{10} still of f\d+ on v2 by agent:/);
  res = await call('get_note', { id: id2 });
  assert.match(textOf(res), /project: [\d.]+ s · frame \d+ in After Effects · clip\.aep · Main 9x16 \(v2\)/);
  log('set_render_source + attach_preview (path) → the note shows its project time and the preview');

  // References: what "like this" means — an image, a clip and a moment of a render — come back as pictures.
  const refImage = path.join(tmp, 'ref.png');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', '-y', refImage]);
  const refClip = path.join(tmp, 'ref.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-pix_fmt', 'yuv420p', '-y', refClip]);
  res = await call('attach_reference', { id: id2, path: refImage, caption: 'Farbe so', note: 'Meinst du das?' });
  assert.match(textOf(res), /reference r_[a-f0-9]{10} image 400×300 — "Farbe so"/);
  res = await call('attach_reference', { id: id2, data: fs.readFileSync(refClip).toString('base64'), caption: 'Tempo' });
  assert.match(textOf(res), /clip 2\.0 s/);
  res = await call('attach_reference', { id: id2, video: 'clip.mp4', frame: 3, caption: 'wie hier' });
  assert.match(textOf(res), /frame of clip\.mp4 v2 at .* \(f3\)/);
  await call('attach_reference', { id: id2, url: 'https://example.com/look' });
  res = await call('get_note', { id: id2 });
  const refLines = textOf(res)
    .split('\n')
    .filter((l) => /^ {2}ref r_/.test(l));
  assert.equal(refLines.length, 4, textOf(res));
  const pictures = images(res).length;
  assert.ok(pictures >= 4, `the marked frame and three reference pictures (image, clip strip, frame): ${pictures}`);
  log('attach_reference (path, data, a moment, a link) → get_note shows them, pictures included');

  await call('wont_fix', { id: id2, reason: 'ist gewollt' });
  log('wont_fix');

  res = await call('set_status', { video: 'clip.mp4', text: 'rendering v3', eta_seconds: 60 });
  assert.match(textOf(res), /status: "rendering v3" until/);
  res = await call('list_videos', {});
  assert.match(textOf(res), /status "rendering v3"/);
  await call('set_status', { video: 'clip.mp4', text: '' });
  log('set_status → shown in list_videos, then cleared');

  res = await call('list_videos', { folder: 'Tests' });
  assert.match(textOf(res), /v2 · open 0 \(must 0\) · fixed 1 · done 1 · folder Tests\/MCP/);
  log('list_videos (folder filter) → v2, fixed 1, done 1');

  await call('move_video', { video: 'clip.mp4', folder: 'Tests/Moved' });
  res = await call('list_folders');
  assert.match(textOf(res), /Moved {2}\(1 video, 0 open\) {2}\[Tests\/Moved\]/);
  log('move_video + list_folders');

  res = await call('get_taste', { video: 'clip.mp4' });
  assert.match(textOf(res), /# Taste: Tests/);
  assert.match(textOf(res), /## Decisions that stand\n\n- “Absicht\?” → won't fix: “ist gewollt”/);
  assert.ok(fs.existsSync(path.join(DATA, 'taste', 'tests.md')));
  const tasteStamp = must(/\n(taste [0-9a-f]{8}) \(saved to /.exec(textOf(res))?.[1], textOf(res));
  res = await call('get_taste', { video: 'clip.mp4', known: tasteStamp });
  assert.equal(textOf(res), `Unchanged (${tasteStamp}): what you read still applies.`);
  log('get_taste → markdown with the wontfix decision, saved to data/taste/tests.md; known stamp → unchanged');

  // The team's playbooks, written the way the app writes them (into this test's store): the House and the project.
  process.env.VR_DATA = DATA;
  process.env.VR_CACHE = path.join(tmp, 'cache');
  const pb = await import('../lib/playbooks.ts');
  pb.writeText('', 'rules', '- Always end on the logo', { by: 'Sam' });
  pb.writeText('Tests', 'brief', 'Renders of the MCP suite.', { by: 'Sam' });
  pb.putSkill('Tests', { name: 'export-test', description: 'How test renders are exported', body: 'H.264, yuv420p, AAC.' }, { by: 'Sam' });
  const preset = path.join(tmp, 'test.preset');
  fs.writeFileSync(preset, 'codec=h264\n');
  await pb.addSkillFile('Tests', 'export-test', 'test.preset', preset, 'Sam');
  res = await call('get_playbook', { video: 'clip.mp4' });
  assert.match(textOf(res), /^# Playbook: Tests\/Moved/);
  assert.match(textOf(res), /Layers, deepest first: Tests r\d+ · House r1/);
  assert.match(textOf(res), /From House \(revision 1\)\n\n- Always end on the logo/);
  assert.match(textOf(res), /\*\*export-test\*\* \(from Tests\): How test renders are exported — files: test\.preset/);
  log('get_playbook → the House and the project merged, deepest first, with the skill listed');
  res = await call('get_skill', { name: 'export-test', video: 'clip.mp4' });
  assert.match(textOf(res), /^---\nname: export-test\ndescription: How test renders are exported\n---\n\nH\.264/);
  const presetPath = must(/test\.preset \(1 KB\) → (.+)$/m.exec(textOf(res))?.[1], textOf(res));
  assert.equal(fs.readFileSync(presetPath, 'utf8'), 'codec=h264\n');
  log('get_skill → SKILL.md and its file as a path on this machine');
  res = await call('propose_playbook_change', {
    folder: 'Tests',
    section: 'rules',
    content: '- Logo at most 8 % of the height',
    reason: 'The reviewer asked for a smaller logo twice',
    evidence: [id1],
  });
  const proposalId = must(/as (pp_[0-9a-f]{12}) \(pending\)/.exec(textOf(res))?.[1], textOf(res));
  pb.rejectProposal(proposalId, { by: 'Sam', reason: 'Logo size is per video' });
  res = await call('get_playbook', { folder: 'Tests' });
  assert.match(textOf(res), new RegExp(`${proposalId} · rules · rejected: “Logo size is per video”`));
  log('propose_playbook_change → pending; a person rejects it, get_playbook says why');
  const revisions = must(/Revisions in force: (.+?) \(/.exec(textOf(res))?.[1], textOf(res));
  res = await call('get_playbook', { folder: 'Tests', known: revisions });
  assert.match(textOf(res), new RegExp(`^Unchanged since ${revisions}: what you read still applies\\.`));
  assert.match(textOf(res), new RegExp(`${proposalId} · rules · rejected`), 'suggestions still say where they stand');
  pb.writeText('Tests', 'rules', '- Logo at most 10 % of the height', { by: 'Sam' });
  res = await call('get_playbook', { folder: 'Tests', known: revisions });
  assert.match(textOf(res), /^# Playbook: Tests/, 'a new revision comes in full');
  log('get_playbook known → "unchanged" until a revision changes');
  res = await call('get_note', { id: id1 });
  assert.match(textOf(res), /playbook House r1 · Tests r\d+ · read it before you render: get_playbook/);
  log('get_note → points at the playbook with its revisions');

  // Notes a person saved as drafts (lib/drafts.ts, written the way the app writes them) reach the agent not at all:
  // no tool, resource or wait shows them — until they are sent, when one wait_for_feedback answer brings them all.
  const drafts = await import('../lib/drafts.ts');
  const clipSlug = VIDEO.split('/').join('__');
  const owner = 'u_0123456789ab';
  const kept = [
    drafts.addDraft(clipSlug, owner, { v: 2, frame: 20, text: 'draftmark Logo kleiner', author: 'Sam' }),
    drafts.addDraft(clipSlug, owner, { v: 2, frame: 50, text: 'draftmark Schnitt früher', author: 'Sam' }),
  ];
  res = await call('get_open_notes', { video: 'clip.mp4' });
  assert.doesNotMatch(textOf(res), /draftmark/);
  res = await call('list_videos', {});
  assert.doesNotMatch(textOf(res), /draftmark/);
  const draftNote = (await client.callTool({ name: 'get_note', arguments: { id: kept[0].id } })) as CallToolResult;
  assert.ok(draftNote.isError, 'get_note does not know a draft');
  const inboxNow = await client.readResource({ uri: 'vr://inbox' });
  assert.doesNotMatch(JSON.stringify(inboxNow), /draftmark/);
  // a cursor taken first: however slow the machine, the wait can't start after the send and miss it. Nothing is new
  // yet (the drafts aren't sent): the answer says the notes come together on Send, and to call again.
  const idle = textOf(await call('wait_for_feedback', { video: 'clip.mp4', timeout_s: 0 }));
  assert.match(idle, /^No new feedback in 0 s\.\ncursor: \S+\nThe person's notes arrive together when they press Send: call wait_for_feedback again now/);
  const since = /cursor: (\S+)/.exec(idle)?.[1];
  const waiting = client.callTool({ name: 'wait_for_feedback', arguments: { video: 'clip.mp4', since, timeout_s: 30 } }) as Promise<CallToolResult>;
  const sentNotes = drafts.sendDrafts(clipSlug, owner);
  const batch = textOf(await waiting);
  assert.match(batch, /^2 new:\n/, batch);
  for (const c of sentNotes) assert.match(batch, new RegExp(`NEW .* ${c.id} `));
  res = await call('get_open_notes', { video: 'clip.mp4' });
  assert.match(textOf(res), /draftmark Logo kleiner/);
  log('drafts → invisible to get_open_notes, list_videos, get_note and vr://inbox; sent → one wait_for_feedback answer with both');

  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'vr://inbox'));
  const reviewUri = must(resources.find((r) => r.uri.startsWith('vr://review/'))?.uri, 'review resource');
  const md = await client.readResource({ uri: reviewUri });
  const first = md.contents[0];
  assert.ok('text' in first);
  assert.match(first.text, /# Review: clip\.mp4/);
  log(`resources → vr://inbox, ${reviewUri.slice(0, 40)}… (review.md)`);

  // Errors come back as tool errors, the server keeps running.
  const bad = (await client.callTool({ name: 'get_note', arguments: { id: 'c_000000' } })) as CallToolResult;
  assert.ok(bad.isError && /no note c_000000/.test(textOf(bad)));
  await call('list_folders');
  log('bad id → isError, server still alive');

  // A partial render, opt-in: a person allows one on a note; the agent sends only that stretch through track_video's
  // parameters that aren't announced (SKILL.md documents them), and only with the length it replaces.
  const SHOTS = makeShotsVideo(path.join(tmp, 'proj', 'export', 'shots.mp4'));
  await call('track_video', { path: SHOTS });
  const st = await import('../lib/store.ts');
  const shotsSlug = SHOTS.split('/').join('__');
  const pn = st.addComment(shotsSlug, { frame: 50, text: 'Logo fehlt', part: { in: 40, out: 79, shot: 2, to_shot: 2, handles: 12 }, author: 'Sam' });
  res = await call('get_open_notes', { video: 'shots.mp4' });
  // the note's line ends with the stretch a part may cover (part_ok), the structured answer carries it as frames
  assert.ok(
    textOf(res).includes(`${pn.id} OPEN SHOULD 00:02:00 f50 v1 [-] · part f40–f79\n  Logo fehlt\n  PART RENDER OK: frames 40–79 (shot 2), handles 12\n`),
    textOf(res),
  );
  assert.deepEqual((res.structuredContent as { notes: unknown[] }).notes, [{ id: pn.id, elements: [], part_ok: { from: 40, to: 79 } }]);
  const announced = JSON.stringify(tools.find((t) => t.name === 'track_video')?.inputSchema);
  assert.ok(!/part_of|part_at|handles|elements/.test(announced), 'the part and elements parameters cost no tokens in the tool list');
  const FIXED = makeShotsVideo(path.join(tmp, 'renders', 'shots-fixed.mp4'), { extra: fixBox(40, 79) });
  const longer = (await client.callTool({
    name: 'track_video',
    arguments: { path: cutFrames(FIXED, 28, 97, path.join(tmp, 'renders', 'longer.mp4')), part_of: 'shots.mp4', part_at: 40 },
  })) as CallToolResult;
  assert.ok(longer.isError && /the length changed: .* send a full render/.test(textOf(longer)), textOf(longer));
  res = await call('track_video', { path: cutFrames(FIXED, 28, 92, path.join(tmp, 'renders', 'part.mp4')), part_of: 'shots.mp4', part_at: 40 });
  assert.match(textOf(res), /^v2: a part, frames 40–79 of v1 · seams clean · never final\nNow call wait_for_feedback with since "\S+": /);
  await call('mark_fixed', { id: pn.id, note: 'Logo drin', v: 2 });
  const shotsReview = st.loadReview(shotsSlug);
  assert.deepEqual(
    shotsReview?.versions.map((x) => x.part?.of ?? null),
    [null, 1],
    'the render on disk is not taken for a re-render',
  );
  res = await call('get_open_notes', { video: 'shots.mp4' });
  assert.doesNotMatch(textOf(res), /PART RENDER OK/, 'fixed: nothing left to render as a part');
  log('partial render → PART RENDER OK in the notes, a longer part refused, the stretch as v2 with clean seams');

  // Options before a render: the agent offers two narrator takes (sounds at two levels) and two looks (pictures) on a
  // project before any video is in it; the person picks; one wait_for_feedback answer brings the compact line.
  const take = (name: string, amplitude: number) => {
    const f = path.join(tmp, 'takes', `${name}.wav`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${amplitude}*sin(2*PI*660*t):s=48000:d=1`, '-y', f]);
    return f;
  };
  const look = (name: string, src: string) => {
    const f = path.join(tmp, 'takes', `${name}.png`);
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `${src}=size=320x180:rate=1`, '-frames:v', '1', '-y', f]);
    return f;
  };
  const askedRes = await call('ask_options', {
    folder: 'Launch',
    text: 'Which narrator and which look, before I render?',
    groups: [
      {
        id: 'voice',
        label: 'Narrator',
        items: [
          { id: 'v1', label: 'Calm', path: take('v1', 0.5) },
          { id: 'v2', label: 'Warm', data: fs.readFileSync(take('v2', 0.1)).toString('base64') },
        ],
      },
      {
        id: 'look',
        label: 'Look',
        items: [
          { id: 'l1', label: 'Bars', path: look('l1', 'smptebars') },
          { id: 'l2', label: 'Pattern', path: look('l2', 'testsrc2') },
        ],
      },
    ],
    prompt: 'Anything for the end card?',
  });
  const askId = must(
    /^(c_[0-9a-f]{6}) asked on folder Launch \(no video yet\): voice \(one of 2\), look \(one of 2\)$/m.exec(textOf(askedRes))?.[1],
    textOf(askedRes),
  );
  res = await call('get_note', { id: askId });
  assert.match(textOf(res), new RegExp(`${askId} OPEN QUESTION · folder Launch \\(no video yet\\)`));
  assert.match(textOf(res), /options voice "Narrator" \(pick one\): v1 Calm \(audio 1\.0 s\) · v2 Warm \(audio 1\.0 s\)/);
  assert.match(textOf(res), /options look "Look" \(pick one\): l1 Bars \(image\) · l2 Pattern \(image\)/);
  const before = /cursor: (\S+)/.exec(textOf(await call('wait_for_feedback', { timeout_s: 0 })))?.[1];
  const hearing = client.callTool({ name: 'wait_for_feedback', arguments: { since: before, timeout_s: 30 } }) as Promise<CallToolResult>;
  const asks = await import('../lib/asks.ts');
  const voiceItems = must(asks.findAsk(askId)).options[0].items;
  assert.ok(
    voiceItems.every((it) => it.ref?.kind === 'audio' && it.ref.loudness),
    'both takes measured',
  );
  asks.answerAsk(askId, { picks: { voice: ['v2'], look: ['l1'] }, note: 'lampo.app on the end card' }, 'Sam');
  const heard = await hearing;
  assert.ok(!heard.isError, textOf(heard));
  assert.match(textOf(heard), /^1 new:/);
  assert.match(
    textOf(heard),
    new RegExp(
      `ANSWERED ${askId} folder Launch by Sam — PICKED voice=v2 look=l1 · note: "lampo\\.app on the end card" · on: "Which narrator and which look, before I render\\?"`,
    ),
  );
  log('ask_options → a question on a folder before any render (sounds measured), picked → wait_for_feedback: ANSWERED … PICKED voice=v2 look=l1');

  // Publishing: an agent drafts the post of a final video; a person publishes it (no tool does: drafts only).
  const slug = VIDEO.split('/').join('__');
  const early = (await client.callTool({ name: 'draft_post', arguments: { video: 'clip.mp4', platform: 'youtube' } })) as CallToolResult;
  assert.ok(early.isError);
  assert.match(textOf(early), /clip\.mp4 isn't final \(\w+\): posts are drafted for a final version \(next: .+\)/);
  const store = await import('../lib/store.ts');
  store.setApproval(slug, { status: 'approved' }, 'Sam');
  store.setFinal(slug, {}, 'Sam');
  res = await call('draft_post', { video: 'clip.mp4', platform: 'youtube', title: 'Clip', text: 'Der neue Clip', tags: ['clip'], cover_frame: 12, ai: false });
  const postId = /po_[0-9a-f]{12}/.exec(textOf(res))?.[0] as string;
  assert.match(textOf(res), /^drafted YouTube: po_[0-9a-f]{12} YouTube V2 drafted · note: say whether it is made for kids/);
  assert.match(textOf(res), /choose a connection for YouTube \(Settings → Publishing\), or download the kit/);
  res = await call('draft_post', { video: 'clip.mp4', platform: 'youtube', kids: false });
  assert.match(textOf(res), new RegExp(`^updated YouTube: ${postId} YouTube V2 drafted · note: choose a connection for YouTube`));
  assert.ok(!textOf(res).includes('made for kids'), 'answered');
  res = await call('get_posts', { video: 'clip.mp4' });
  assert.match(textOf(res), new RegExp(`^${postId} YouTube V2 drafted`));
  assert.ok(!names.some((n) => /publish/.test(n)), 'no tool publishes');
  const drafted = (await import('../lib/publish/posts.ts')).findPost(postId);
  assert.deepEqual(
    [drafted?.state, drafted?.by, drafted?.cover_frame, drafted?.ai_generated, drafted?.youtube?.made_for_kids],
    ['draft', 'agent:mcp-e2e', 12, false, false],
  );
  log(`draft_post → ${postId} drafted on the final V2 (refused before final; what is missing said), get_posts; no tool publishes`);

  // Footage search: the videos' shots, indexed here with the stand-in model (the app does it in the background)
  process.env.VR_OCR = 'off';
  const { indexNow, targets } = await import('../lib/footage/indexer.ts');
  const { createEmbedder } = await import('../lib/footage/embedder.ts');
  const fake = createEmbedder({ kind: 'fake' });
  assert.ok((await indexNow(targets(), { e: fake })) >= 1);
  fake.stop();
  res = await call('find_footage', { query: 'a colourful test pattern', aspect: '9:16', sheet: true });
  assert.match(textOf(res), /^\d+ of \d+ shots · "colourful test pattern" · 9:16\ns\d+ \S+\.mp4 (V2 )?00:00:00–/);
  assert.ok(!textOf(res).includes(tmp), 'no path');
  assert.equal(images(res).length, 1, 'one contact sheet');
  assert.ok(isJpeg((images(res)[0] as { data: string }).data));
  log('find_footage → shots one line each, a contact sheet');

  // The files the UI and other agents read.
  const review = JSON.parse(fs.readFileSync(path.join(DATA, slug, 'review.json'), 'utf8'));
  const c1 = must(
    (review as Review).comments.find((c) => c.id === id1),
    id1,
  );
  assert.equal(c1.status, 'fixed');
  assert.equal(c1.fixed_in_v, 2);
  assert.equal(review.versions.length, 2);
  assert.equal(review.folder, 'Tests/Moved');
  assert.ok(!('agent_status' in review));
  assert.ok(fs.existsSync(path.join(DATA, slug, `${id1}_marked.png`)));
  const events = fs
    .readFileSync(path.join(DATA, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l): ReviewEvent => JSON.parse(l));
  const types = events.map((e) => e.type);
  for (const t of ['added', 'comment', 'reply', 'version', 'status', 'moved'] as const) assert.ok(types.includes(t), `event ${t}`);
  log(`review.json + events.jsonl: ${events.length} events (${[...new Set(types)].join(', ')})`);
  console.log('\nMCP e2e: all passed');
} finally {
  await client.close();
  stt.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(`${DATA}-versions`, { recursive: true, force: true });
}
