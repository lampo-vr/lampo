// What `vr render` reads of render tools (lib/render/tools.ts), how it estimates the time left (lib/render/eta.ts) and
// what of a failure may leave the machine (lib/render/redact.ts), on recorded or representative output: Remotion's
// non-TTY lines (and its terminal bars), an ffmpeg -progress block stream as ffmpeg 8 writes it, aerender's PROGRESS
// lines, Blender's frame lines. No tool runs here; render-cli.test.ts runs them (ffmpeg for real, the others as
// stand-ins).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etaOf } from '../../lib/render/eta.ts';
import { ERROR_MAX, failureWords, redact } from '../../lib/render/redact.ts';
import {
  aerenderReader,
  blenderFrames,
  blenderReader,
  ffmpegPlan,
  ffmpegReader,
  ffmpegTime,
  plain,
  progressOf,
  type Reading,
  remotionLine,
  toolOf,
  withFfmpegProgress,
} from '../../lib/render/tools.ts';

test('the tool is known by its first words', () => {
  assert.equal(toolOf(['npx', 'remotion', 'render', 'src/index.ts', 'Main', 'out/a.mp4']), 'remotion');
  assert.equal(toolOf(['npx', '--yes', 'remotion', 'render', 'Main']), 'remotion');
  assert.equal(toolOf(['npx', 'remotion@4.0.300', 'render']), 'remotion');
  assert.equal(toolOf(['pnpm', 'exec', 'remotion', 'render', 'Main']), 'remotion');
  assert.equal(toolOf(['./node_modules/.bin/remotion', 'render', 'Main']), 'remotion');
  assert.equal(toolOf(['npx', 'remotion', 'still', 'Main']), null, 'a still is no render with progress');
  assert.equal(toolOf(['npx', 'remotion', 'lambda', 'render']), null);
  assert.equal(toolOf(['/opt/homebrew/bin/ffmpeg', '-i', 'a.mov', 'b.mp4']), 'ffmpeg');
  assert.equal(toolOf(['C:\\ffmpeg\\bin\\FFmpeg.exe', '-i', 'a.mov', 'b.mp4']), 'ffmpeg');
  assert.equal(toolOf(['aerender', '-project', 'spot.aep']), 'aerender');
  assert.equal(toolOf(['/Applications/Blender.app/Contents/MacOS/Blender', '-b', 'x.blend', '-a']), 'blender');
  assert.equal(toolOf(['node', 'render.mjs']), null);
  assert.equal(toolOf(['npm', 'run', 'render']), null, 'a script of its own: the file growing tells');
});

test('Remotion without a terminal: one line per update, bundling, then rendering and encoding, each from 0 again', () => {
  // as `npx remotion render` prints into a pipe (packages/cli/src/progress-bar.ts getGuiProgressSubtitle)
  const out = [
    'Bundling 6%',
    'Bundling 54%',
    'Bundling 100%',
    'Getting composition',
    'Rendered 0/90',
    'Rendered 9/90, time remaining: 4s',
    'Rendered 45/90, time remaining: 2s',
    'Rendered 90/90',
    'Encoded 30/90',
    'Encoded 90/90',
    '\x1b[34m+ out/launch.mp4\x1b[39m      \x1b[90m1.2 MB\x1b[39m',
  ];
  const got = out.map(remotionLine).filter((r): r is Reading => !!r);
  assert.deepEqual(
    got.map((r) => [r.stage, r.pct === null ? null : Math.round(r.pct)]),
    [
      ['bundling', 6],
      ['bundling', 54],
      ['bundling', 100],
      ['rendering', 0],
      ['rendering', 10],
      ['rendering', 50],
      ['rendering', 100],
      ['encoding', 33],
      ['encoding', 100],
    ],
  );
  assert.deepEqual(got[5].frames, [45, 90]);
  // the stage starts over: rendering doesn't continue bundling's 100
  assert.ok((got[3].pct ?? 1) < (got[2].pct ?? 0));
});

test('Remotion in a terminal or an older version: its bar lines read the same', () => {
  const bar = '━'.repeat(9) + ' '.repeat(9);
  assert.deepEqual(remotionLine(`Bundling code       ${bar} 40%`), { stage: 'bundling', pct: 40 });
  assert.deepEqual(remotionLine(`Rendering frames    ${bar} 340/900 12s remaining`)?.frames, [340, 900]);
  assert.equal(remotionLine(`\x1b[34mEncoding video\x1b[39m      ${bar}  120/900`)?.stage, 'encoding');
  assert.equal(remotionLine(`Muxing video        ${bar}  900/900`)?.pct, 100);
  assert.deepEqual(remotionLine('Rendered frames     ━━━━━━━━━━━━━━━━━━ 1234ms'), { stage: 'rendering', pct: 100 });
  assert.equal(remotionLine('Bundled code        ━━━━━━━━━━━━━━━━━━ 812ms')?.pct, 100);
  assert.equal(remotionLine('Rendering the intro: 3/4 shots ready'), null, 'not one of its own lines');
  assert.equal(remotionLine('  Rendered 3/4 from the composition log'), null, 'only lines that start with its words');
});

test('ffmpeg: -progress goes to a pipe of ours (progress flags only), its own -progress is left alone', () => {
  assert.deepEqual(withFfmpegProgress(['-y', '-i', 'a.mov', 'b.mp4'], 3), ['-progress', 'pipe:3', '-nostats', '-y', '-i', 'a.mov', 'b.mp4']);
  assert.deepEqual(withFfmpegProgress(['-stats', '-i', 'a.mov', 'b.mp4'], 3), ['-progress', 'pipe:3', '-stats', '-i', 'a.mov', 'b.mp4']);
  assert.deepEqual(withFfmpegProgress(['-progress', 'log.txt', '-i', 'a.mov', 'b.mp4'], 3), ['-progress', 'log.txt', '-i', 'a.mov', 'b.mp4']);
  assert.equal(ffmpegPlan(['-progress', 'log.txt', '-i', 'a.mov', 'b.mp4']).ownProgress, true);
});

test('ffmpeg: how long the render is, from its own arguments', () => {
  assert.equal(ffmpegTime('90'), 90);
  assert.equal(ffmpegTime('00:01:30.5'), 90.5);
  assert.equal(ffmpegTime('1:02:03'), 3723);
  assert.equal(ffmpegTime('1500ms'), 1.5);
  assert.equal(ffmpegTime('nonsense'), null);
  assert.deepEqual(ffmpegPlan(['-y', '-i', 'a.mov', '-frames:v', '240', 'b.mp4']), { inputs: ['a.mov'], ownProgress: false, frames: 240 });
  assert.deepEqual(ffmpegPlan(['-ss', '10', '-i', 'a.mov', '-t', '20', '-r', '25', 'b.mp4']), {
    inputs: ['a.mov'],
    ownProgress: false,
    seconds: 20,
    start: 10,
    fps: 25,
  });
  assert.equal(ffmpegPlan(['-i', 'a.mov', '-ss', '5', '-to', '35', 'b.mp4']).seconds, 30);
  // an input's own -t limits what is read of it
  assert.equal(ffmpegPlan(['-t', '12', '-i', 'a.mov', 'b.mp4']).seconds, 12);
  // two inputs: the first is the one probed
  assert.deepEqual(ffmpegPlan(['-i', 'v.mov', '-i', 'music.wav', '-shortest', 'b.mp4']).inputs, ['v.mov', 'music.wav']);
  // a value is never read as an option: a -t inside a filter's text is no duration
  assert.equal(ffmpegPlan(['-i', 'a.mov', '-metadata', 'title=-t', 'b.mp4']).seconds, undefined);
});

test('ffmpeg: its -progress blocks, as ffmpeg 8 writes them, against the frames in all', () => {
  // recorded from `ffmpeg -progress pipe:1 -i in.mp4 -vf scale=1280:720 out.mp4` (4 s at 25 fps)
  const stream = `frame=0
fps=0.00
stream_0_0_q=0.0
bitrate=N/A
total_size=0
out_time_us=N/A
out_time_ms=N/A
out_time=N/A
dup_frames=0
drop_frames=0
speed=N/A
progress=continue
frame=50
fps=49.46
stream_0_0_q=28.0
bitrate=1092.5kbits/s
total_size=262192
out_time_us=1920000
out_time_ms=1920000
out_time=00:00:01.920000
dup_frames=0
drop_frames=0
speed= 1.9x
progress=continue
frame=100
fps=66.08
stream_0_0_q=-1.0
bitrate=1385.1kbits/s
total_size=678694
out_time_us=3920000
out_time_ms=3920000
out_time=00:00:03.920000
dup_frames=0
drop_frames=0
speed=2.59x
progress=end`;
  const byFrames = ffmpegReader(() => ({ seconds: 4, frames: 100 }));
  const got = stream
    .split('\n')
    .map(byFrames)
    .filter((r): r is Reading => !!r);
  assert.deepEqual(got, [
    { stage: 'rendering', pct: 0, frames: [0, 100] },
    { stage: 'rendering', pct: 50, frames: [50, 100] },
    { stage: 'rendering', pct: 100, frames: [100, 100] },
  ]);
  // only a length in seconds: by out_time_us (ffmpeg's out_time_ms is microseconds too)
  const bySeconds = ffmpegReader(() => ({ seconds: 4 }));
  const second = stream
    .split('\n')
    .map(bySeconds)
    .filter((r): r is Reading => !!r);
  assert.equal(second[1].pct, 48);
  assert.equal(second[1].frames, undefined);
  // no length known at all: it says it renders, without a share
  const blind = ffmpegReader(() => ({}));
  assert.deepEqual(stream.split('\n').map(blind).filter(Boolean)[1], { stage: 'rendering', pct: null });
});

test('aerender: the comp’s start and duration, then each PROGRESS line as a share and frames', () => {
  // the line shapes nexrender's parser reads (Adobe documents none); a German build says Anfang / Dauer
  const out = [
    'PROGRESS:  10/7/26 10:00:00 AM: Starting composition “Main”.',
    'PROGRESS:  Render Settings: Best Settings',
    'PROGRESS:  Start: 0:00:00:00',
    'PROGRESS:  End: 0:00:09:29',
    'PROGRESS:  Duration: 0:00:10:00',
    'PROGRESS:  Frame Rate: 30.00 (comp)',
    'PROGRESS:  0:00:00:00 (1): 0 Seconds',
    'PROGRESS:  0:00:04:29 (150): 3 Seconds',
    'PROGRESS:  0:00:09:29 (300): 7 Seconds',
    'PROGRESS:  Total Time Elapsed: 8 Seconds',
  ];
  const read = aerenderReader();
  const got = out.map(read).filter((r): r is Reading => !!r);
  assert.deepEqual(
    got.map((r) => [Math.round(r.pct ?? -1), r.frames]),
    [
      [0, undefined],
      [0, [1, 300]],
      [50, [150, 300]],
      [100, [300, 300]],
    ],
  );
  const de = aerenderReader();
  for (const l of ['PROGRESS:  Anfang: 0:00:02:00', 'PROGRESS:  Dauer: 0:00:04:00']) de(l);
  // no rate said: a share all the same (counted alike), no frames
  const half = de('PROGRESS:  0:00:03:29 (89): 2 Sekunden');
  assert.equal(Math.round(half?.pct ?? -1), 50);
  assert.equal(half?.frames, undefined);
  assert.equal(aerenderReader()('PROGRESS:  0:00:01:00 (30): 1 Seconds'), null, 'nothing before the duration');
});

test('Blender: the frames asked for, and which one it is on (5.x and 4.x lines)', () => {
  assert.deepEqual(blenderFrames(['-b', 'x.blend', '-s', '1', '-e', '4', '-a']), { first: 1, step: 1, count: 4 });
  assert.deepEqual(blenderFrames(['-b', 'x.blend', '-s', '10', '-e', '20', '-j', '5', '-a']), { first: 10, step: 5, count: 3 });
  assert.deepEqual(blenderFrames(['-b', 'x.blend', '-f', '3,7..9']), { first: 3, step: 1, count: 4, list: [3, 7, 8, 9] });
  assert.equal(blenderFrames(['-b', 'x.blend', '-a']), null, 'the scene’s own range: not in the arguments');
  assert.equal(blenderFrames(['-b', 'x.blend', '-f', '+1']), null);
  const read = blenderReader(blenderFrames(['-b', 'x.blend', '-s', '1', '-e', '4', '-a']));
  const out = [
    '00:00.104  render           | Rendering frame 1',
    '00:00.517  render           | Fra: 1 | Mem:31.2M (Peak 31.2M) | Time:00:00.41 | Sample 16/64',
    '00:01.002  render           | Time: 00:00.89 (Saving: 00:00.02)',
    '00:01.003  render           | Rendering frame 2',
    'Fra:3 Mem:12.34M (Peak 15.00M) | Time:00:01.23 | Remaining:00:10.00 | Scene, ViewLayer | Rendering 12 / 64 samples',
    '00:02.100  render           | Rendering frame 4',
    '00:02.900  render           | Video append frame 4',
  ];
  assert.deepEqual(
    out.map(read).map((r) => r?.frames ?? null),
    [[0, 4], [0, 4], null, [1, 4], [2, 4], [3, 4], [4, 4]],
  );
  // without a range: it renders, nobody can say how far
  assert.deepEqual(blenderReader(null)('Fra: 12 | Mem:1M'), { stage: 'rendering', pct: null });
});

test('a reading becomes the contract’s RunProgress: what follows the stage, numbers rounded and bounded', () => {
  assert.deepEqual(progressOf({ stage: 'rendering', pct: 41.6, frames: [374, 900] }, { eta_s: 70, tool: 'remotion', v: 4 }), {
    what: 'render',
    stage: 'rendering',
    pct: 42,
    frames: [374, 900],
    eta_s: 70,
    tool: 'remotion',
    v: 4,
  });
  assert.deepEqual(progressOf({ stage: 'uploading', pct: 130 }), { what: 'upload', stage: 'uploading', pct: 100 });
  assert.deepEqual(progressOf({ stage: 'checking', pct: null }, { tool: null, v: null }), { what: 'check', stage: 'checking', pct: null });
  assert.equal(plain('\x1b]8;;file:///x\x07out.mp4\x1b]8;;\x07\r'), 'out.mp4');
});

test('time left: from the last ~10 s; none below 5 % and none while the rate swings', () => {
  // 2 % a second, steady: from 5 % on, (100 − pct) / 2 seconds
  const steady = etaOf();
  const at = (s: number) => s * 1000;
  let last: number | undefined;
  for (let s = 0; s <= 2; s += 0.5) assert.equal(steady.push(at(s), s * 2), undefined, `below 5 % at ${s * 2} %`);
  for (let s = 2.5; s <= 20; s += 0.5) last = steady.push(at(s), s * 2);
  assert.equal(last, 30, '40 % at 2 % a second: 30 s left');
  // the rate doubles from one half of the window to the other: no number until it settles
  const swing = etaOf();
  let pct = 10;
  for (let s = 0; s <= 10; s += 0.5) {
    pct += s < 5 ? 0.5 : 1.5;
    last = swing.push(at(s), pct);
  }
  assert.equal(last, undefined, 'a rate that triples is no basis for a number');
  for (let s = 10.5; s <= 25; s += 0.5) {
    pct += 1.5;
    last = swing.push(at(s), Math.min(pct, 99));
  }
  assert.ok(last !== undefined, 'settled again: a number');
  // within the 50 %: still a number
  const mild = etaOf();
  pct = 10;
  for (let s = 0; s <= 10; s += 0.5) {
    pct += s < 5 ? 1 : 1.3;
    last = mild.push(at(s), pct);
  }
  assert.ok(last !== undefined);
  // readings a tool prints many times a second are used, not all kept
  const busy = etaOf();
  for (let ms = 0; ms <= 12_000; ms += 5) last = busy.push(ms, 6 + ms / 1000);
  assert.equal(last, 82);
});

// Key-shaped test strings are put together here, never written out whole: no line of the repository looks like a key.
const joined = (...parts: string[]): string => parts.join('');
const AWS_ID = joined('AK', 'IA', 'IOSFODNN7', 'EXAMPLE');
const ANTHROPIC = joined('sk-', 'ant-api03-', 'AbCdEfGhIjKl', 'MnOpQrStUvWxYz012345');
const GITHUB = joined('gh', 'p_', '0123456789abcdefghij', 'ABCDEFGHIJ0123');
const JWT = [joined('ey', 'JhbGciOiJIUzI1NiJ9'), joined('ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0'), 'dozjgNryP4J3jVmNHl0w5N'].join('.');
const LAMPO = joined('vr', '_', 'AbCdEfGhIjKlMnOpQrStUv');
const KEY_BLOCK = [joined('-'.repeat(5), 'BEGIN'), 'RSA', 'PRIVATE', joined('KEY', '-'.repeat(5), 'MIIEpAIBAAKCAQEA')].join(' ');

test('redaction: tokens, keys and passwords go, the rest of the line stays', () => {
  const cases: [string, string[], string[]][] = [
    ['upload to https://render:hunter2@cdn.example.com/x failed', ['hunter2'], ['upload to https://', '@cdn.example.com/x failed']],
    ['Authorization: Bearer abcdefghijklmnop.qrstuvwx', ['abcdefghijklmnop'], ['Authorization']],
    ['curl https://api.example.com/v1?token=s3cr3tvalue&x=1', ['s3cr3tvalue'], ['x=1']],
    ['"password": "correct horse battery"', ['correct horse'], ['"password"']],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI'], ['AWS_SECRET_ACCESS_KEY=']],
    [`using key ${AWS_ID}`, [AWS_ID], ['using key']],
    [`${ANTHROPIC} rejected`, [ANTHROPIC.slice(14, 26)], ['rejected']],
    [`${GITHUB} is not valid`, [GITHUB.slice(0, 14)], ['is not valid']],
    [`session ${JWT}`, [JWT.slice(0, 8)], ['session']],
    [`vr login --token ${LAMPO}`, [LAMPO.slice(0, 9)], ['vr login --token']],
    ['--password hunter2 --verbose', ['hunter2'], ['--verbose']],
    ['X-Amz-Signature=8c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b', ['8c1a2b3c'], ['X-Amz-Signature=']],
    [KEY_BLOCK, ['MIIEpAIB'], []],
  ];
  for (const [text, gone, kept] of cases) {
    const out = redact(text);
    for (const g of gone) assert.ok(!out.includes(g), `${g} is gone from: ${out}`);
    for (const k of kept) assert.ok(out.includes(k), `${k} stays in: ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  // what isn't a secret stays word for word: paths, file names, frames, a design or a signal
  for (const text of [
    "Error: ENOENT: no such file or directory, open '/work/LaunchFilm_Main_1920x1080_v12_FINAL.mp4'",
    'Could not find composition with ID Main. Available: Intro, Outro',
    'The design: 42 frames at 1920x1080, signal: SIGKILL, author=Sam',
    'Killed: 9',
  ])
    assert.equal(redact(text), text);
});

test('redaction: keys named *_KEY, a user’s password given to a command, webhook addresses, more token shapes', () => {
  const cases: [string, string[], string[]][] = [
    [
      `upload failed for ${joined('https://hooks.slack.com/', 'services/', 'T0AAAAAAA/', 'B0BBBBBBB/', 'abcdefghijklmnopqrstuvwx')}`,
      ['abcdefghijklmnop', 'B0BBBBBBB'],
      ['upload failed for', 'hooks.slack.com'],
    ],
    [
      `notify ${joined('https://discord.com/api/', 'webhooks/', '123456789012345678/', 'AbCdEfGhIjKlMnOpQrStUv_-wx')}`,
      ['AbCdEfGhIjKl'],
      ['notify', 'discord.com'],
    ],
    [joined('OPENAI', '_KEY=', 'abcdef0123456789abcdefXYZ'), ['abcdef0123456789'], ['OPENAI_KEY=']],
    [joined('MAILGUN', '_KEY=', 'key-', '0123456789abcdef0123456789ab'), ['0123456789abcdef'], ['MAILGUN_KEY=']],
    [`"stripe.key": "${joined('rk', '-', 'abcdefghijkl')}"`, ['abcdefghijkl'], ['"stripe.key"']],
    ['curl -u admin:hunter2 https://api.example.com/x', ['hunter2'], ['curl -u admin:', 'https://api.example.com/x']],
    ['wget --user=render --password-file x --proxy-user ops:s3cret-pw', ['s3cret-pw'], ['--proxy-user ops:']],
    [
      `Error: AWS secret ${joined('wJalrXUtnFEMI', '/K7MDENG', '/bPxRfiCYEXAMPLEKEY')} rejected`,
      ['wJalrXUtnFEMI', 'bPxRfiCY'],
      ['Error: AWS secret', 'rejected'],
    ],
    [joined('S', 'G.', 'abcdefghijklmnopqrstuv', '.', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcde'), ['abcdefghijklmnop', 'ABCDEFGHIJKLMNOP'], []],
    [`error: ${joined('h', 'f_', 'abcdefghijklmnopqrstuvwxyzABCDEFGH')} invalid`, ['abcdefghijklmnop'], ['error:', 'invalid']],
    [`npm token ${joined('np', 'm_', 'abcdefghijklmnopqrstuvwxyz0123456789')} is invalid`, ['abcdefghijklmnop'], ['npm token', 'is invalid']],
  ];
  for (const [text, gone, kept] of cases) {
    const out = redact(text);
    for (const g of gone) assert.ok(!out.includes(g), `${g} is gone from: ${out}`);
    for (const k of kept) assert.ok(out.includes(k), `${k} stays in: ${out}`);
    assert.match(out, /\[redacted\]/);
    // the server redacts what `vr render` sent once more: nothing changes then
    assert.equal(redact(out), out);
  }
  assert.equal(redact('(api_key=[redacted])'), '(api_key=[redacted])');
  // render settings and paths that look a little like them stay word for word
  for (const text of [
    'x264 [info]: keyint=250 keyint_min=25 scenecut=40',
    'Parsed_colorkey_0: colorkey=0x00ff00:0.3:0.2',
    "Error: ENOENT: no such file or directory, open '/Users/you/Projects/Acme2026/LaunchFilm/export/Main_V12.mp4'",
    'Could not resolve src/components/Logo/AnimatedEntryFrames.tsx',
    'git -u origin main',
  ])
    assert.equal(redact(text), text);
});

test('a failure’s words: the last lines that say what went wrong, redacted, at most 300 characters', () => {
  // Remotion: its error, a stack, its own progress before it
  const remotion = [
    'Rendered 120/900, time remaining: 40s',
    'An error occurred while rendering frame 121:',
    'Error: Could not load font "Inter Display" (token=abcd1234efgh5678)',
    '    at loadFont (webpack://src/fonts.ts:12:9)',
    '    at Main (webpack://src/Main.tsx:40:3)',
  ];
  const r = failureWords(remotion);
  assert.equal(r.quote, 'An error occurred while rendering frame 121: · Error: Could not load font "Inter Display" (token=[redacted])');
  assert.equal(r.line, 'Error: Could not load font "Inter Display" (token=[redacted])');
  // ffmpeg's stats lines are no part of it; the home folder is said as ~
  const ff = [
    'frame=  120 fps= 30 q=28.0 size=     512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1x',
    '/Users/you/clips/missing.mov: No such file or directory',
  ];
  assert.deepEqual(failureWords(ff, { home: '/Users/you' }), {
    quote: '~/clips/missing.mov: No such file or directory',
    line: '~/clips/missing.mov: No such file or directory',
  });
  // nothing that says "error": its last three lines
  assert.equal(failureWords(['one', 'two', 'three', 'four']).quote, 'two · three · four');
  // long: the end is kept, within the bound
  const long = Array.from({ length: 10 }, (_, i) => `Error ${i}: ${'x'.repeat(80)}`);
  const cut = failureWords(long);
  assert.ok(cut.quote.length <= ERROR_MAX, String(cut.quote.length));
  assert.ok(cut.quote.endsWith(`Error 9: ${'x'.repeat(80)}`));
  assert.ok(cut.line.length <= 200);
  assert.deepEqual(failureWords([]), { quote: '', line: '' });
});
