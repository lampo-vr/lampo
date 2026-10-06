// The files of options an agent offers (lib/refs.ts storeOptionFile) are untrusted media (audit A12, OPTM-2): a sound
// whose header promises more than any real one is refused before ffmpeg decodes it, every ffmpeg run on such a file
// has a wall-clock limit, and a question's files are worked on through the job queue — one at a time, under a hosted
// workspace's cap. And OPTM-1's other half: ffmpeg killed by a signal mid-encode is read as it is by the machine's
// owner and as a sentence by everyone else. A stand-in ffmpeg (the real one, logged — and held, crashed or slowed when
// the test says so) watches what runs. Synthetic tones and patterns only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, FFMPEG, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const { dir } = isolatedEnv({ vars: { VR_STT: 'off' } });
// The stand-in: every run logged; `hang` holds any run, `crash` kills an AAC encode with a signal after a line naming a
// file, `slow` holds an AAC encode for a moment and notes how many were running then.
const ctl = path.join(dir, 'ffmpeg-ctl');
fs.mkdirSync(ctl);
const STAND_IN = path.join(dir, 'ffmpeg');
const CRASH_SAYS = 'Error while decoding stream #0:0 of /srv/example/tmp/vr-ref-x/agent-input.wav';
fs.writeFileSync(
  STAND_IN,
  `#!/bin/bash
d='${ctl}'
echo "$*" >> "$d/runs.log"
enc=0; for a in "$@"; do [ "$a" = aac ] && enc=1; done
[ -e "$d/hang" ] && exec sleep 600
if [ $enc = 1 ] && [ -e "$d/crash" ]; then echo '${CRASH_SAYS}' >&2; kill -SEGV $$; fi
if [ $enc = 1 ] && [ -e "$d/slow" ]; then
  touch "$d/enc.$$"; ls "$d" | grep -c '^enc\\.' >> "$d/overlap.log"; sleep 0.5
  '${FFMPEG}' "$@"; rc=$?; rm -f "$d/enc.$$"; exit $rc
fi
exec '${FFMPEG}' "$@"
`,
  { mode: 0o755 },
);
process.env.VR_FFMPEG = STAND_IN;
const flag = (name: 'hang' | 'crash' | 'slow', on: boolean) =>
  on ? fs.writeFileSync(path.join(ctl, name), '') : fs.rmSync(path.join(ctl, name), { force: true });
const runs = () => (fs.existsSync(path.join(ctl, 'runs.log')) ? fs.readFileSync(path.join(ctl, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const { createFolder } = await import('../../lib/folders.ts');
const { loudnessOf, measureLoudness, REF_LIMITS, REF_TIMEOUTS, storeOptionFile } = await import('../../lib/refs.ts');
const { levelGains } = await import('../../lib/options.ts');
const { storage } = await import('../../lib/storage/index.ts');
const { FFPROBE } = await import('../../lib/probe.ts');
const { QUEUE_LIMITS } = await import('../../lib/jobs.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

// Media made with the real ffmpeg (helpers' FFMPEG was resolved before the stand-in was named).
const make = (name: string, args: string[]): string => {
  const file = path.join(dir, name);
  execFileSync(FFMPEG, ['-v', 'error', ...args, '-y', file]);
  return file;
};
const tone = make('tone.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=1']);
const toneM4a = make('tone.m4a', ['-i', tone, '-c:a', 'aac']);
const picture = make('pattern.png', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90', '-frames:v', '1']);
const clip = make('clip.mp4', [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=10:d=1',
  '-f',
  'lavfi',
  '-i',
  'sine=d=1',
  '-c:v',
  'libx264',
  '-c:a',
  'aac',
  '-shortest',
]);
// Headers past any real sound: 384 kHz, 12 channels; and a clip whose sound is 384 kHz.
const fast = make('fast.wav', ['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=384000:d=0.3']);
const wide = make('wide.wav', ['-f', 'lavfi', '-i', `aevalsrc=${Array(12).fill('0.1*sin(2*PI*440*t)').join('|')}:s=48000:d=0.3`]);
const fastClip = make('fast-clip.mkv', [
  ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:d=0.5', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=384000:d=0.5'],
  ...['-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest'],
]);
const b64 = (f: string) => fs.readFileSync(f).toString('base64');
// A render in the library, for moments (frame items).
const spot = makeVideo(path.join(dir, 'renders', 'spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
age(spot);
store.createOrGetReview(spot, { by: 'tester' });
const slug = slugify(spot);
const keyOf = (f: string) => `asks/c_0a0a0a/${f}`;
const req = { by: 'agent:sound' };

let machine: http.Server;
let hosted: http.Server;
let onMachine: Request;
let onServer: Request;
let token = '';
const logged: unknown[][] = [];
const consoleError = console.error;
before(async () => {
  machine = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => machine.listen(0, '127.0.0.1', r));
  onMachine = client((machine.address() as AddressInfo).port, { Connection: 'close' });
  hosted = http.createServer(createApp(createContext({ cfg: { ...loadConfig(), mode: 'server' }, token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => hosted.listen(0, '127.0.0.1', r));
  onServer = client((hosted.address() as AddressInfo).port, { Connection: 'close' });
  const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  token = auth.createToken(max.id, 'agent').token;
  createFolder('Demo');
  console.error = (...a: unknown[]) => logged.push(a);
});
after(() => {
  console.error = consoleError;
  for (const s of [machine, hosted]) {
    s.closeAllConnections();
    s.close();
  }
});
const bearer = () => ({ Authorization: `Bearer ${token}` });
const ask = (items: unknown[], text = 'Which voice?') => ({ folder: 'Demo', text, options: [{ id: 'voice', items }] });

test('a sound whose header promises more than any real one is refused before ffmpeg decodes a sample of it', async () => {
  for (const [file, why] of [
    [fast, /sample rate is 384000 Hz; at most 192 kHz/],
    [wide, /says it has 12 channels; at most 8/],
    [fastClip, /the clip’s sound says its sample rate is 384000 Hz/],
  ] as const) {
    fs.rmSync(path.join(ctl, 'runs.log'), { force: true });
    await assert.rejects(storeOptionFile(file, keyOf, req), why, path.basename(file));
    assert.deepEqual(runs(), [], `${path.basename(file)}: only ffprobe read its header, ffmpeg never ran`);
  }
  assert.equal(REF_LIMITS.audioRate, 192_000);
  assert.equal(REF_LIMITS.audioChannels, 8);
  // Our own words about the caller's file: a token reads them as they are.
  const r = await onServer('POST', '/api/asks', { body: ask([{ id: 'a', ref: { kind: 'file', data: b64(fast) } }, { id: 'b' }]), headers: bearer() });
  assert.equal(r.status, 422, r.text);
  assert.equal(r.json().error, 'voice/a: the sound says its sample rate is 384000 Hz; at most 192 kHz');
});

// A12 OPTM-3: any audio codec in the allowed containers was decoded (MS ADPCM, WavPack, G.726: decoders nobody needs
// for a voice or a music bed), and a raw FLAC was refused as "not an image or a video".
test('a sound is decoded only in the codecs sounds come in; one the app can’t read is told so as a sound', async () => {
  const adpcm = make('adpcm.wav', ['-f', 'lavfi', '-i', 'sine=d=0.5', '-c:a', 'adpcm_ms']);
  const wavpack = make('wavpack.mkv', ['-f', 'lavfi', '-i', 'sine=d=0.5', '-c:a', 'wavpack']);
  for (const file of [adpcm, wavpack]) {
    fs.rmSync(path.join(ctl, 'runs.log'), { force: true });
    await assert.rejects(
      storeOptionFile(file, keyOf, req),
      /a sound must be PCM \(WAV\), MP3, AAC, ALAC, FLAC, Vorbis, Opus or AC-3, not /,
      path.basename(file),
    );
    assert.deepEqual(runs(), [], `${path.basename(file)}: refused from its header, never decoded`);
  }
  const flac = make('take.flac', ['-f', 'lavfi', '-i', 'sine=d=0.5']);
  await assert.rejects(storeOptionFile(flac, keyOf, req), /not a picture, clip or sound this app can read .*WAV, MP3, M4A/);
  // what sounds come in still does: PCM in WAV, AAC in M4A, Opus in WebM, FLAC in MKV
  const ok = [
    tone,
    toneM4a,
    make('opus.webm', ['-f', 'lavfi', '-i', 'sine=d=0.5', '-c:a', 'libopus']),
    make('flac.mkv', ['-f', 'lavfi', '-i', 'sine=d=0.5', '-c:a', 'flac']),
  ];
  for (const file of ok) assert.equal((await storeOptionFile(file, keyOf, req)).kind, 'audio', path.basename(file));
});

// A12 OPTM-4: the agent's tags (title, comment) were kept in the stored file and served; the loudness was read from
// the last "Summary:" anywhere in ffmpeg's output, and a true peak it couldn't read became -70 dBFS (room to raise).
test('a stored sound keeps none of the sender’s tags; loudness is read from the meter’s own summary only', async () => {
  const tagged = make('tagged.mp3', ['-f', 'lavfi', '-i', 'sine=d=1', '-metadata', 'title=Sent by an agent', '-metadata', 'comment=see https://example.com']);
  const ref = await storeOptionFile(tagged, keyOf, req);
  const stored = storage().localPath(keyOf(ref.file as string));
  const tags = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', stored]).toString();
  assert.doesNotMatch(tags, /Sent by an agent|example\.com/, tags);
  const summary = (i: string, peak = '') =>
    `[Parsed_ebur128_0 @ 0x600000bac300] Summary:\n\n  Integrated loudness:\n    I:         ${i} LUFS\n    Threshold: -31.8 LUFS\n${peak ? `\n  True peak:\n    Peak:      ${peak} dBFS\n` : ''}`;
  assert.deepEqual(loudnessOf(summary('-21.8', '-18.1')), { i: -21.8, tp: -18.1 });
  assert.deepEqual(loudnessOf(summary('-21.8')), { i: -21.8 }, 'a true peak not read is unknown, not -70');
  // A tag that looks like a summary, and no summary of the meter's own: nothing is read.
  const forged = `  Metadata:\n    comment         : Summary:\n                    :   Integrated loudness:\n                    :     I:  -5.0 LUFS\n                    :   True peak:\n                    :     Peak: -60.0 dBFS\n`;
  assert.equal(loudnessOf(forged), null);
  assert.deepEqual(loudnessOf(`${forged}${summary('-30.0', '-12.0')}`), { i: -30, tp: -12 });
  // A sound whose peak is unknown is never raised past what is known.
  assert.deepEqual(levelGains([{ i: -30 }, { i: -20, tp: -10 }]), [0, -10]);
});

test('every ffmpeg run on an option’s file has a wall-clock limit: one that hangs is stopped', { timeout: 90_000 }, async () => {
  const saved = { ...REF_TIMEOUTS };
  Object.assign(REF_TIMEOUTS, { picture: 1500, clip: 1500, sound: 1500, loudness: 1500 });
  flag('hang', true);
  try {
    for (const [what, file] of [
      ['a sound', tone],
      ['a clip', clip],
      ['a picture', picture],
    ] as const) {
      const t0 = Date.now();
      await assert.rejects(storeOptionFile(file, keyOf, req), /took longer than 2 s and was stopped/, what);
      assert.ok(Date.now() - t0 < 30_000, `${what}: stopped at its limit (${Date.now() - t0} ms)`);
    }
    // The measurement on its own: no loudness rather than a run without end (the sound then plays as it is).
    assert.equal(await measureLoudness(toneM4a), null);
  } finally {
    flag('hang', false);
    Object.assign(REF_TIMEOUTS, saved);
  }
  assert.ok(REF_TIMEOUTS.sound <= 120_000 && REF_TIMEOUTS.loudness <= 60_000 && REF_TIMEOUTS.clip <= 300_000 && REF_TIMEOUTS.picture <= 60_000);
});

test('one question’s files are worked on one at a time, through the job queue, however many upload URLs arrive at once', async () => {
  fs.rmSync(path.join(ctl, 'overlap.log'), { force: true });
  flag('slow', true);
  try {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, ref: { kind: 'file' } }));
    const made = await onServer('POST', '/api/asks', { body: ask(items, 'Which bed?'), headers: bearer() });
    assert.equal(made.status, 200, made.text);
    const urls = Object.values(made.json().uploads as Record<string, { url: string }>).map((t) => new URL(t.url).pathname);
    assert.equal(urls.length, 4);
    const bytes = fs.readFileSync(tone);
    await Promise.all(urls.map((p) => onServer('PUT', p, { body: bytes, headers: { 'content-length': String(bytes.length) } })));
    for (let i = 0; i < 240; i++) {
      const states = await Promise.all(urls.map((p) => onServer('GET', p)));
      if (states.every((s) => s.status !== 202)) {
        for (const s of states) assert.equal(s.status, 200, s.text);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const seen = fs.readFileSync(path.join(ctl, 'overlap.log'), 'utf8').trim().split('\n').map(Number);
    assert.equal(seen.length, 4, 'four sounds re-encoded');
    assert.equal(Math.max(...seen), 1, `never two at once: ${seen.join(', ')}`);
    const view = (await onServer('GET', `/api/asks/${made.json().id}`, { headers: bearer() })).json();
    for (const it of view.options[0].items) assert.equal(it.ref?.kind, 'audio', it.id);
  } finally {
    flag('slow', false);
  }
});

test('a hosted workspace’s full queue refuses an option’s file: 503, its sentence and when to try again; nothing half-made', async () => {
  const saved = { ...QUEUE_LIMITS };
  Object.assign(QUEUE_LIMITS, { perWorkspace: 0, reserved: 0 });
  try {
    const r = await onServer('POST', '/api/asks', {
      body: ask([{ id: 'a', ref: { kind: 'file', data: b64(tone) } }, { id: 'b' }], 'Which take?'),
      headers: bearer(),
    });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.headers['retry-after'], '60');
    assert.match(r.json().error, /^this workspace has 0 jobs waiting already/);
  } finally {
    Object.assign(QUEUE_LIMITS, saved);
  }
  const asks = (await onServer('GET', '/api/asks', { headers: bearer() })).json().asks as { text: string }[];
  assert.ok(!asks.some((a) => a.text === 'Which take?'), 'no question left without its file');
});

// A12 OPT-1: one question with 48 moments made 197 ffmpeg runs inline, and any reviewer could send it.
test('moments of renders: at most 8 a question, refused before a frame is grabbed, and grabbed through the job queue', async () => {
  const moments = (g: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${g}${i}`, ref: { kind: 'frame', video: slug, frame: i } }));
  const options = (n: number) => [
    { id: 'a', items: moments('a', Math.ceil(n / 2)) },
    { id: 'b', items: moments('b', Math.floor(n / 2)) },
  ];
  fs.rmSync(path.join(ctl, 'runs.log'), { force: true });
  const nine = await onServer('POST', '/api/asks', { body: { folder: 'Demo', text: 'Which moment?', options: options(9) }, headers: bearer() });
  assert.equal(nine.status, 422, nine.text);
  assert.equal(nine.json().error, 'a question shows at most 8 moments of renders (this one 9)');
  assert.deepEqual(runs(), [], 'nothing grabbed');
  const eight = await onServer('POST', '/api/asks', { body: { folder: 'Demo', text: 'Which moment?', options: options(8) }, headers: bearer() });
  assert.equal(eight.status, 200, eight.text);
  const saved = { ...QUEUE_LIMITS };
  Object.assign(QUEUE_LIMITS, { perWorkspace: 0, reserved: 0 });
  try {
    const full = await onServer('POST', '/api/asks', {
      body: { folder: 'Demo', text: 'This one?', options: [{ id: 'a', items: moments('a', 2) }] },
      headers: bearer(),
    });
    assert.equal(full.status, 503, `a moment waits its turn in the queue: ${full.text}`);
  } finally {
    Object.assign(QUEUE_LIMITS, saved);
  }
});

// A12 OPT-6: an item's file could arrive after the person had answered (no event, the answer about another set).
test('an upload URL used after the question was answered or closed: 409, and the item stays as it was answered', async () => {
  const bytes = fs.readFileSync(tone);
  for (const end of ['answer', 'close'] as const) {
    const made = await onServer('POST', '/api/asks', {
      body: ask(
        [
          { id: 'a', ref: { kind: 'file' } },
          { id: 'b', label: 'B' },
        ],
        `Which one (${end})?`,
      ),
      headers: bearer(),
    });
    assert.equal(made.status, 200, made.text);
    const { id, uploads } = made.json() as { id: string; uploads: Record<string, { url: string }> };
    const ended = await onServer('POST', `/api/asks/${id}/${end}`, { body: end === 'answer' ? { picks: { voice: ['b'] } } : {}, headers: bearer() });
    assert.equal(ended.status, 200, ended.text);
    const put = await onServer('PUT', new URL(must(uploads['voice/a']).url).pathname, { body: bytes, headers: { 'content-length': String(bytes.length) } });
    assert.equal(put.status, 409, `${end}: ${put.text}`);
    assert.match(put.json().error, /answered or closed: it takes no more files/);
    const view = (await onServer('GET', `/api/asks/${id}`, { headers: bearer() })).json();
    assert.equal(view.options[0].items[0].ref, undefined, `${end}: no file on the item`);
  }
});

// What only the machine's owner may read: the stand-in's path (the store's folder), the file ffmpeg named, its words.
const SECRETS = [dir, fs.realpathSync(os.tmpdir()), '/srv/example', 'exited', 'Error while decoding', 'SEGV'];
function plain(what: string, text: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what} names ${JSON.stringify(s)}: ${text.slice(0, 300)}`);
  const ref = /\(ref ([0-9a-f]{8})\)/.exec(text)?.[1];
  assert.ok(ref, `${what}: a sentence with a ref to the log line: ${text.slice(0, 300)}`);
  assert.ok(
    logged.some((line) => line.join(' ').includes(ref) && line.join(' ').includes(CRASH_SAYS)),
    `${what}: the whole error is in the log under its ref`,
  );
}

test('ffmpeg killed by a signal mid-encode (exited null): the machine’s owner reads it, tokens and agents over HTTP a sentence', async () => {
  const body = ask([{ id: 'a', ref: { kind: 'file', data: b64(tone) } }, { id: 'b' }], 'Which voice, again?');
  flag('crash', true);
  try {
    const owner = await onMachine('POST', '/api/asks', { body });
    assert.equal(owner.status, 422, owner.text);
    assert.match(owner.json().error, /^voice\/a: .* exited null: .*Error while decoding/, 'which item, and what ffmpeg said');
    for (const [what, request] of [
      ['a token on the machine', onMachine],
      ['a token on a server', onServer],
    ] as const) {
      const r = await request('POST', '/api/asks', { body, headers: bearer() });
      assert.equal(r.status, 422, `${what}: ${r.text}`);
      plain(what, r.json().error);
    }
    const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(hosted.address() as AddressInfo).port}/mcp`), { requestInit: { headers: bearer() } }),
    );
    try {
      const r = (await c.callTool({
        name: 'ask_options',
        arguments: { folder: 'Demo', text: 'Which voice, again?', groups: [{ id: 'voice', items: [{ id: 'a', data: b64(tone) }, { id: 'b' }] }] },
      })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true);
      plain('an agent’s ask_options over HTTP', r.content[0]?.text ?? '');
    } finally {
      await c.close();
    }
  } finally {
    flag('crash', false);
  }
});

// A12 OPT-3b: ask_options took a question of any size (900,000 characters were stored); its input has the API's bounds.
test('ask_options has the API’s bounds: text, labels, ids, items, data, links', async () => {
  const port = (hosted.address() as AddressInfo).port;
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: bearer() } }));
  const two = [{ id: 'a' }, { id: 'b' }];
  try {
    // A12 OPT-8: /mcp takes 1 MB a request, so its tool says what fits inline there (stdio: 8 MB).
    const said = (await c.listTools()).tools.find((t) => t.name === 'ask_options')?.description ?? '';
    assert.match(said, /base64 data ≤ 700 KB; bigger, or none: upload: true/, said);
    assert.doesNotMatch(said, /8 MB/, said);
    for (const [what, args] of [
      ['text', { video: slug, text: 'x'.repeat(5001), groups: [{ id: 'g', items: two }] }],
      ['prompt', { video: slug, text: 'Which?', prompt: 'p'.repeat(401), groups: [{ id: 'g', items: two }] }],
      ['a group label', { video: slug, text: 'Which?', groups: [{ id: 'g', label: 'L'.repeat(161), items: two }] }],
      ['an item id', { video: slug, text: 'Which?', groups: [{ id: 'g', items: [{ id: 'i'.repeat(25) }, { id: 'b' }] }] }],
      ['items', { video: slug, text: 'Which?', groups: [{ id: 'g', items: Array.from({ length: 10 }, (_, i) => ({ id: `i${i}` })) }] }],
      ['a link', { video: slug, text: 'Which?', groups: [{ id: 'g', items: [{ id: 'a', url: `https://example.com/${'x'.repeat(2000)}` }, { id: 'b' }] }] }],
    ] as const) {
      const r = (await c.callTool({ name: 'ask_options', arguments: args })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true, `${what}: ${JSON.stringify(r.content).slice(0, 200)}`);
      assert.match(r.content[0]?.text ?? '', /too_big|Too big|Too many|validation/i, `${what}: ${r.content[0]?.text}`);
    }
  } finally {
    await c.close();
  }
  assert.ok(!(store.loadReview(slug)?.comments ?? []).some((n) => n.text.length > 5000), 'nothing that long was stored');
});

// A12 OPT-4: upload URLs were minted after the question was written, so a refusal (429: too many open) left a question
// stored and announced without its URLs; and over MCP every words-only item took a URL. Last in this file: it uses
// up the token's open upload URLs.
test('upload URLs come before the question: refused, nothing is stored or told; over MCP only items that ask get one', async () => {
  const port = (hosted.address() as AddressInfo).port;
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: bearer() } }));
  const tool = async (items: Record<string, unknown>[], text: string) =>
    (await c.callTool({ name: 'ask_options', arguments: { folder: 'Demo', text, groups: [{ id: 'voice', items }] } })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
  try {
    const words = await tool(
      [
        { id: 'a', label: 'Calm' },
        { id: 'b', label: 'Warm' },
      ],
      'Words only?',
    );
    assert.ok(!words.isError, JSON.stringify(words.content));
    assert.doesNotMatch(words.content[0]?.text ?? '', /PUT its file/, 'words-only items take no URL');
    const one = await tool(
      [
        { id: 'a', upload: true },
        { id: 'b', label: 'Warm' },
      ],
      'One file later?',
    );
    assert.ok(!one.isError, JSON.stringify(one.content));
    assert.equal((one.content[0]?.text ?? '').match(/PUT its file/g)?.length, 1, one.content[0]?.text);

    // Use up the open upload URLs this account may hold, one question at a time.
    let refused: { status: number; text: string } | null = null;
    for (let i = 0; i < 60 && !refused; i++) {
      const r = await onServer('POST', '/api/asks', { body: ask([{ id: 'a', ref: { kind: 'file' } }, { id: 'b' }], `Later ${i}?`), headers: bearer() });
      if (r.status !== 200) refused = r;
    }
    assert.equal(refused?.status, 429, refused?.text);
    const told = store.readEvents({ limit: 500 }).filter((e) => e.type === 'comment' && /^Later \d+\?$/.test(e.text ?? ''));
    const kept = (await onServer('GET', '/api/asks', { headers: bearer() })).json().asks as { text: string }[];
    assert.equal(kept.filter((a) => /^Later \d+\?$/.test(a.text)).length, told.length, 'every question kept was told, and no other');
    const last = /Later (\d+)\?/.exec(told.at(-1)?.text ?? '')?.[1];
    assert.ok(!kept.some((a) => a.text === `Later ${Number(last) + 1}?`), 'the refused one isn’t stored');
    const viaMcp = await tool([{ id: 'a', upload: true }, { id: 'b' }], 'Refused over MCP?');
    assert.equal(viaMcp.isError, true);
    assert.match(viaMcp.content[0]?.text ?? '', /upload URLs are open already/);
    assert.ok(!(await onServer('GET', '/api/asks', { headers: bearer() })).json().asks.some((a: { text: string }) => a.text === 'Refused over MCP?'));
  } finally {
    await c.close();
  }
});
