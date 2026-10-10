// A position an agent gives (`lampo add --at`, `lampo ref --at`, MCP `timecode`) names the frame it says or is refused:
// a drop-frame timecode ("00:00:01;15", as editors write 29.97 fps) is read the way a note's text is (`timecodesIn`),
// and anything that isn't a position ("00:00:01.5") is "bad position", never the frame its first numbers name.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { age, isolatedEnv, makeVideo, ROOT, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const { parseFramePosition, timecodesIn } = await import('../../lib/time.ts');
const ntsc = makeVideo(path.join(dir, 'proj/ntsc.mp4'), { fps: 29.97, dur: 2 });
const flat = makeVideo(path.join(dir, 'proj/flat.mp4'), { fps: 30, dur: 2 });
age(ntsc);
age(flat);

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const said = (r: Result) => r.content.find((x) => x.type === 'text')?.text ?? '';

const NTSC = 30000 / 1001;
const MALFORMED = [
  '00:00:01.5',
  '00:00:01;1.5',
  '00:00:01;',
  '00:00;01:15',
  '00:00:01:15:00',
  '00:00:60:00',
  '00:00:01:30',
  '1:60:00:00',
  '0:01',
  'f',
  'f1.5',
  '12,5',
  '-00:00:01:00',
  '',
];

test('parseFramePosition reads both separators and refuses what is not a position', () => {
  // colon: the app's own numbering (ceil of real seconds) at every rate
  assert.equal(parseFramePosition('00:00:01:15', 30), 45);
  assert.equal(parseFramePosition('00:00:01:15', NTSC), 45);
  assert.equal(parseFramePosition('1:00:00:00', 30), 108000);
  // semicolon: SMPTE drop-frame, exactly as a note's text reads it
  for (const code of ['00:00:01;15', '00:01:00;02', '00:10:00;00', '00:00:59;29', '01:00:00;00'])
    assert.equal(parseFramePosition(code, NTSC), timecodesIn(`at ${code}`, NTSC)[0]?.frame, code);
  assert.equal(parseFramePosition('00:00:01;15', NTSC), 45);
  assert.equal(parseFramePosition('00:01:00;02', NTSC), 1800);
  assert.equal(parseFramePosition('00:10:00;00', NTSC), 17982);
  assert.equal(parseFramePosition('00:01:00;04', 60000 / 1001), 3600);
  // a number drop-frame leaves out, and a drop-frame code at a rate that has none, name no frame
  assert.equal(parseFramePosition('00:01:00;00', NTSC), null);
  assert.equal(parseFramePosition('00:01:00;03', 60000 / 1001), null);
  for (const fps of [24, 25, 30, 50, 60]) assert.equal(parseFramePosition('00:00:01;15', fps), null, `drop-frame at ${fps}`);
  // what isn't a position is null, never frame 1
  for (const s of MALFORMED) assert.equal(parseFramePosition(s, NTSC), null, JSON.stringify(s));
  // seconds and fN as they were
  assert.equal(parseFramePosition('1.5', 30), 45);
  assert.equal(parseFramePosition('1.5s', 30), 45);
  assert.equal(parseFramePosition('f45', NTSC), 45);
});

test('lampo add pins a drop-frame position where it says, and says "bad position" for anything else', () => {
  const df = vr(['add', ntsc, '--at', '00:00:01;15', '--text', 'drop-frame', '--by', 'agent:test'], env);
  assert.equal(df.code, 0, df.err);
  assert.match(df.out, /\(f45, v1\)/);
  const colon = vr(['add', 'ntsc.mp4', '--at', '00:00:01:15', '--text', 'colon', '--by', 'agent:test'], env);
  assert.equal(colon.code, 0, colon.err);
  assert.match(colon.out, /\(f45, v1\)/);
  for (const at of ['00:00:01.5', '00:00:01;1.5', '00:01:00;00']) {
    const r = vr(['add', 'ntsc.mp4', '--at', at, '--text', 'x', '--by', 'agent:test'], env);
    assert.equal(r.code, 1, `${at}: ${r.out}`);
    assert.match(r.err, /bad position/, at);
    assert.doesNotMatch(r.out, /pinned/, at);
  }
  const t = vr(['add', 'ntsc.mp4', '--t', '1.5x', '--text', 'x', '--by', 'agent:test'], env);
  assert.equal(t.code, 1, t.out);
  assert.match(t.err, /bad position/);
  // at 30 fps a drop-frame code names no frame
  const at30 = vr(['add', flat, '--at', '00:00:01;15', '--text', 'x', '--by', 'agent:test'], env);
  assert.equal(at30.code, 1, at30.out);
  assert.match(at30.err, /bad position/);
});

test('MCP get_frame and add_note read a drop-frame timecode, and refuse a malformed one by name', async (t) => {
  // started once the lampo runs above are done: they block this process while they run
  const mcp = new Client({ name: 'positions', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'bin/lampo-mcp')],
      env: { ...env, VR_REMOTE: '0' } as Record<string, string>,
      stderr: 'inherit',
    }),
  );
  t.after(() => mcp.close());
  const tool = async (name: string, args: Record<string, unknown>) => (await mcp.callTool({ name, arguments: args })) as Result;
  const df = await tool('get_frame', { video: 'ntsc.mp4', timecode: '00:00:01;15' });
  assert.ok(!df.isError, said(df));
  assert.match(said(df), / f45 /);
  for (const timecode of ['00:00:01.5', '00:00:01;', '00:01:00;00']) {
    const r = await tool('get_frame', { video: 'ntsc.mp4', timecode });
    assert.ok(r.isError, `${timecode}: ${said(r)}`);
    assert.match(said(r), /bad position/, timecode);
  }
  const at30 = await tool('get_frame', { video: 'flat.mp4', timecode: '00:00:01;15' });
  assert.ok(at30.isError, said(at30));
  assert.match(said(at30), /bad position/);
  const note = await tool('add_note', { video: 'ntsc.mp4', timecode: '00:00:01;15', text: 'from MCP', kind: 'info' });
  assert.ok(!note.isError, said(note));
  assert.match(said(note), /\(f45, v1\)/);
  const bad = await tool('add_note', { video: 'ntsc.mp4', timecode: '00:00:01.5', text: 'never pinned', kind: 'info' });
  assert.ok(bad.isError, said(bad));
  assert.match(said(bad), /bad position/);
  const end = await tool('add_note', { video: 'ntsc.mp4', frame: 10, to_timecode: '00:00:01.5', text: 'never a range', kind: 'info' });
  assert.ok(end.isError, said(end));
  assert.match(said(end), /bad position/);
});
