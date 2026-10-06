// Speech-to-text: model choice, the language/prompt/silence rules, config migration, the verified download, the
// OpenAI-compatible backend, and the worker lifecycle (crash, hang, idle) against a fake worker. A real transcription
// runs only when VR_STT_TEST_MODEL points at a GGUF file (CI stays light).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FFMPEG, isolatedEnv, tmpdir } from '../lib/helpers.ts';

const REAL_MODEL = process.env.VR_STT_TEST_MODEL;
const { dir } = isolatedEnv();
const { pickModel, ensureModel, downloadProgress, MODELS } = await import('../../lib/stt/models.ts');
const { forSpeaker, needsLanguageRetry, promptCollapsed, transcribeWithPolicy, isSilent, vocabularyPrompt } = await import('../../lib/stt/policy.ts');
const { sttConfig } = await import('../../lib/config.ts');
const { httpTranscribe, endpoint, wav16 } = await import('../../lib/stt/http.ts');
const { LocalEngine, MissingModelError } = await import('../../lib/stt/local.ts');
const FAKE = fileURLToPath(new URL('../lib/fakeSttWorker.ts', import.meta.url));

const gpu = [{ name: 'MTL0', kind: 'metal', deviceType: 'gpu' }];
const cpuOnly = [
  { name: 'Vulkan0', kind: 'vulkan', deviceType: 'igpu' },
  { name: 'CPU', kind: 'cpu', deviceType: 'cpu' },
];

test('model auto: Whisper-turbo with a GPU, Parakeet on CPU (integrated GPUs count as CPU)', () => {
  assert.equal(pickModel('auto', gpu).id, 'whisper-turbo');
  assert.equal(pickModel('auto', cpuOnly).id, 'parakeet-v3');
  assert.equal(pickModel('qwen3-asr-1.7b', gpu).id, 'qwen3-asr-1.7b');
  assert.deepEqual(pickModel('/models/ggml-whisper-small.gguf', cpuOnly), { id: 'custom', path: '/models/ggml-whisper-small.gguf', family: 'whisper' });
  assert.throws(() => pickModel('whisper-large', gpu), /unknown speech model/);
});

test('language policy: only a language the reviewer does not speak triggers one more run', () => {
  assert.equal(needsLanguageRetry('nl', ['de', 'en']), true);
  assert.equal(needsLanguageRetry('de', ['de', 'en']), false);
  assert.equal(needsLanguageRetry('', ['de']), false, 'Parakeet reports no language');
  assert.equal(needsLanguageRetry('fr', []), false, 'no list = accept anything');
});

test('a person’s own speech: their languages, Automatic ([]) as any language, else the server’s list', () => {
  const server = { languages: ['de', 'en'], model: 'x' };
  assert.deepEqual(forSpeaker(server, undefined).languages, ['de', 'en']);
  assert.deepEqual(forSpeaker(server, ['sv']).languages, ['sv']);
  assert.deepEqual(forSpeaker(server, []).languages, [], 'Automatic never falls back to the server’s list');
  assert.equal(forSpeaker(server, []).model, 'x');
});

test('prompt guard: non-Latin output or too few words for the audio means the prompt run collapsed', () => {
  assert.equal(promptCollapsed('Beiôt说加入Roll kilometers', 6, ['de', 'en']), true);
  assert.equal(promptCollapsed('und', 8, ['de']), true);
  assert.equal(promptCollapsed('Die Caption ist zu klein und das B-Roll zu lang', 5, ['de', 'en']), false);
  assert.equal(promptCollapsed('ok', 2, ['de']), false, 'short clips have few words');
  assert.equal(promptCollapsed('日本語のメモです', 3, []), false, 'unknown languages: no script check');
});

test('policy runs: prompt collapse → re-run without prompt; foreign language → re-run in the first language', async () => {
  const calls: object[] = [];
  const answers = [
    { text: '说加入', language: 'zh' },
    { text: 'Het logo komt te vroeg', language: 'nl' },
    { text: 'Das Logo kommt zu früh', language: 'de' },
  ];
  const r = await transcribeWithPolicy(
    async (a) => {
      calls.push(a);
      return answers[calls.length - 1];
    },
    { languages: ['de', 'en'], prompt: 'Logo, Caption', seconds: 3 },
  );
  assert.deepEqual(calls, [{ prompt: 'Logo, Caption' }, {}, { language: 'de' }]);
  assert.equal(r.text, 'Das Logo kommt zu früh');
});

test('silence gate and vocabulary prompt', () => {
  assert.equal(isSilent(new Float32Array(16000)), true);
  assert.equal(isSilent(new Float32Array(1000).fill(0.5)), true, 'under 0.3 s is not a note');
  const tone = Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  assert.equal(isSilent(tone), false);
  assert.equal(vocabularyPrompt([' Caption', 'B-Roll', 'Caption', '']), 'Caption, B-Roll');
  assert.equal(vocabularyPrompt([]), null);
  assert.ok((vocabularyPrompt(Array.from({ length: 200 }, (_, i) => `term${i}`)) || '').length <= 400);
});

test('config: stt defaults, the old whisper_language migrates, env wins', () => {
  assert.deepEqual(sttConfig({}, {}).languages, []);
  assert.equal(sttConfig({}, {}).backend, 'local');
  assert.deepEqual(sttConfig({ whisper_language: 'de' }, {}).languages, ['de', 'en']);
  assert.deepEqual(sttConfig({ whisper_language: 'en' }, {}).languages, ['en']);
  assert.deepEqual(sttConfig({ whisper_language: 'de', stt: { languages: ['fr'] } }, {}).languages, ['fr']);
  assert.deepEqual(sttConfig({ whisper_language: 'de' }, { VR_STT_LANGUAGES: 'EN, de' }).languages, ['en', 'de']);
  const h = sttConfig({}, { VR_STT: 'http', VR_STT_URL: 'http://gpu:8080', VR_STT_API_KEY: 'k', VR_STT_HTTP_MODEL: 'large-v3' });
  assert.deepEqual([h.backend, h.http], ['http', { url: 'http://gpu:8080', api_key: 'k', model: 'large-v3' }]);
  assert.equal(sttConfig({}, { VR_STT_PREFETCH: '1' }).prefetch, true);
  assert.throws(() => sttConfig({}, { VR_STT: 'whisper' }), /local, http or off/);
});

test('model download: streamed, size + SHA-256 verified, shared by concurrent callers, nothing left on failure', async () => {
  const body = crypto.randomBytes(300_000);
  const good = { ...MODELS['parakeet-v3'], file: 'tiny.gguf', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  let fetches = 0;
  const fake: typeof fetch = async () => {
    fetches++;
    return new Response(body);
  };
  const models = path.join(dir, 'models');
  const logs: string[] = [];
  const [a, b] = await Promise.all([ensureModel(models, good, (m) => logs.push(m), fake), ensureModel(models, good, () => {}, fake)]);
  assert.equal(a, b);
  assert.equal(fetches, 1);
  assert.ok(fs.readFileSync(a).equals(body));
  assert.ok(logs.some((l) => l.includes('100%')) && logs.at(-1)?.includes('ready'), logs.join('\n'));
  await ensureModel(models, good, () => {}, fake);
  assert.equal(fetches, 1, 'present: no second download');

  const bad = { ...good, file: 'bad.gguf', sha256: '0'.repeat(64) };
  await assert.rejects(
    ensureModel(models, bad, () => {}, fake),
    /corrupt/,
  );
  assert.deepEqual(fs.readdirSync(models).sort(), ['tiny.gguf']);
});

test('model download: how far it is, for the UI (0–1 while it runs, nothing after)', async () => {
  const body = crypto.randomBytes(200_000);
  const preset = { ...MODELS['parakeet-v3'], file: 'progress.gguf', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  const models = path.join(dir, 'models-progress');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // Half the file, then a pause until the test has looked.
  const fake: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(new Uint8Array(body.subarray(0, 100_000)));
          await gate;
          c.enqueue(new Uint8Array(body.subarray(100_000)));
          c.close();
        },
      }),
    );
  assert.equal(downloadProgress(models, preset), null, 'nothing before it starts');
  const done = ensureModel(models, preset, () => {}, fake);
  for (let i = 0; i < 50 && !downloadProgress(models, preset); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(downloadProgress(models, preset), 0.5);
  release();
  await done;
  assert.equal(downloadProgress(models, preset), null, 'nothing once it is there');
});

test('OpenAI-compatible backend: WAV upload, bearer key, language names become codes', async () => {
  let seen: { auth?: string; url?: string; body: string } = { body: '' };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, url: req.url, body: Buffer.concat(chunks).toString('latin1') };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: ' Das Logo kommt zu früh. ', language: 'german' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const r = await httpTranscribe(new Float32Array(1600), { prompt: 'Logo' }, { url, api_key: 'sk-test', model: 'large-v3' });
  srv.close();
  assert.deepEqual(r, { text: 'Das Logo kommt zu früh.', language: 'de' });
  assert.equal(seen.auth, 'Bearer sk-test');
  assert.equal(seen.url, '/v1/audio/transcriptions');
  assert.ok(seen.body.includes('filename="note.wav"') && seen.body.includes('large-v3') && seen.body.includes('RIFF'));
  assert.equal(endpoint('http://x/v1'), 'http://x/v1/audio/transcriptions');
  assert.equal(endpoint('http://x/v1/audio/transcriptions/'), 'http://x/v1/audio/transcriptions');
  assert.equal(wav16(new Float32Array(10)).length, 44 + 20);
});

function fakeEngine(opts: { idleMs?: number } = {}) {
  const model = path.join(dir, 'whisper-fake.gguf');
  fs.writeFileSync(model, 'x');
  return new LocalEngine({ model, modelsDir: dir, threads: 1, idleMs: opts.idleMs ?? 60_000, workerPath: FAKE, log: () => {} });
}
const pcm = (first = 0.1, n = 3200) => {
  const a = new Float32Array(n).fill(0.1);
  a[0] = first;
  return a;
};

test('worker: answers, survives a crash (next call respawns), a hang times out, idle unloads', async () => {
  const eng = fakeEngine({ idleMs: 300 });
  assert.deepEqual(await eng.run(pcm(), {}, 5000), { text: 'fake 3200', language: 'de' });
  assert.equal(eng.state, 'ready');
  assert.equal(eng.info?.family, 'whisper');

  await assert.rejects(eng.run(pcm(0.5), {}, 5000), /speech engine stopped \(exit 3\)/);
  assert.equal(eng.state, 'error');
  assert.deepEqual(await eng.run(pcm(), { language: 'en' }, 5000), { text: 'fake 3200 in en', language: 'en' });
  assert.equal((await eng.run(pcm(), { lateStart: true }, 5000)).text, 'fake 3200 late', 'a late first line reaches the worker');

  await assert.rejects(eng.run(pcm(0.25), {}, 300), /timed out/);
  assert.deepEqual((await eng.run(pcm(), {}, 5000)).text, 'fake 3200');

  await new Promise((r) => setTimeout(r, 600));
  assert.equal(eng.state, 'idle', 'unloaded after the idle period');
  assert.equal((await eng.run(pcm(), {}, 5000)).text, 'fake 3200');
  eng.stop();
});

test('worker: the idle timer of the last call never stops an engine that is still starting', async () => {
  const eng = fakeEngine({ idleMs: 50 });
  await assert.rejects(eng.run(pcm(0.25), {}, 100), /timed out/);
  // The timeout armed a 50 ms idle timer; the next worker takes 300 ms to say hello.
  process.env.FAKE_HELLO_MS = '300';
  try {
    assert.equal((await eng.run(pcm(), {}, 5000)).text, 'fake 3200');
  } finally {
    delete process.env.FAKE_HELLO_MS;
    eng.stop();
  }
});

test('worker: three crashes in a row park the engine instead of respawning forever', async () => {
  const eng = fakeEngine();
  for (let i = 0; i < 3; i++) await assert.rejects(eng.run(pcm(0.5), {}, 5000), /stopped/);
  await assert.rejects(eng.run(pcm(), {}, 5000), /paused after repeated crashes/);
  eng.stop();
});

test('worker: a preset that is not downloaded yet is reported, not fetched, when downloads are off', async () => {
  const eng = new LocalEngine({ model: 'parakeet-v3', modelsDir: path.join(dir, 'empty'), threads: 1, idleMs: 60_000, workerPath: FAKE, log: () => {} });
  await assert.rejects(eng.ensure({ download: false }), (e: Error) => e instanceof MissingModelError);
  assert.equal(eng.state, 'idle');
  assert.equal(eng.info?.model, 'parakeet-v3');
});

const saySkip = !REAL_MODEL ? 'set VR_STT_TEST_MODEL=/path/to/model.gguf' : process.platform !== 'darwin' ? 'needs macOS `say`' : false;
test('real model: a German note, an English note, and silence', { skip: saySkip, timeout: 240000 }, async () => {
  const { transcribeFile, stopStt } = await import('../../lib/stt/index.ts');
  const tmp = tmpdir('vr-stt-');
  const de = path.join(tmp, 'de.aiff');
  const en = path.join(tmp, 'en.aiff');
  const quiet = path.join(tmp, 'quiet.wav');
  execFileSync('say', ['-v', 'Anna', '-o', de, 'Die Bauchbinde steht zu lange im Bild.']);
  execFileSync('say', ['-v', 'Samantha', '-o', en, 'The logo comes in too early.']);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=pink:a=0.001', '-y', quiet]);
  const s = sttConfig({ stt: { model: REAL_MODEL, languages: ['de', 'en'] } }, {});
  const norm = (t: string | null) => (t || '').toLowerCase().replace(/[^\p{L} ]/gu, '');
  assert.match(norm(await transcribeFile(de, s)), /bauchbinde steht zu lange im bild/);
  assert.match(norm(await transcribeFile(en, s)), /logo comes in too early/);
  assert.equal(await transcribeFile(quiet, s), '');
  stopStt();
});
