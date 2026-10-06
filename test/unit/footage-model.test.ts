// The footage model (lib/footage/models.ts, embedder.ts): downloaded on first use from one pinned revision, every file
// checked by size and SHA-256 before it is used — never in a test (a stand-in fetch here) — and run in a process of its
// own whose crash fails the request, not the caller, and is parked after three.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, tmpdir } from '../lib/helpers.ts';

isolatedEnv();
const { ensureModel, modelReady, SIGLIP, filesOf, modelDir } = await import('../../lib/footage/models.ts');
const { createEmbedder } = await import('../../lib/footage/embedder.ts');
const { fakeImage, fakeText, FAKE_SIZE } = await import('../../lib/footage/fake.ts');

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = { vision: Buffer.from('vision-bytes'), text: Buffer.from('text-bytes!'), tok: Buffer.from('{"tok":1}'), cfg: Buffer.from('{}') };
const file = (p: string, b: Buffer) => ({ path: p, bytes: b.length, sha256: sha(b) });
const model = {
  ...SIGLIP,
  id: 'tiny',
  repo: 'test/tiny-model',
  vision: file('onnx/vision.onnx', bytes.vision),
  text: file('onnx/text.onnx', bytes.text),
  tokenizer: file('tokenizer.json', bytes.tok),
  tokenizerConfig: file('tokenizer_config.json', bytes.cfg),
};
const served: Record<string, Buffer> = {
  'onnx/vision.onnx': bytes.vision,
  'onnx/text.onnx': bytes.text,
  'tokenizer.json': bytes.tok,
  'tokenizer_config.json': bytes.cfg,
};

function fakeFetch(change: (p: string, b: Buffer) => Buffer = (_p, b) => b) {
  const asked: string[] = [];
  const f = (async (url: string | URL) => {
    asked.push(String(url));
    const p = String(url).split(`/resolve/${model.revision}/`)[1] ?? '';
    const b = served[p];
    return b ? new Response(change(p, b)) : new Response('no', { status: 404 });
  }) as typeof fetch;
  return { f, asked };
}

test('the model is pinned: one revision, a size and a SHA-256 for every file', () => {
  assert.match(SIGLIP.revision, /^[0-9a-f]{40}$/);
  assert.equal(SIGLIP.repo, 'Xenova/siglip-base-patch16-224');
  for (const f of filesOf(SIGLIP)) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    assert.ok(f.bytes > 0);
  }
  assert.deepEqual([SIGLIP.vision.path, SIGLIP.text.path], ['onnx/vision_model_quantized.onnx', 'onnx/text_model_quantized.onnx']);
});

test('a file that doesn’t match its checksum is refused and leaves nothing behind', async () => {
  const root = tmpdir();
  const { f } = fakeFetch((p, b) => (p === 'onnx/text.onnx' ? Buffer.from('text-bytes?') : b));
  await assert.rejects(ensureModel(model, { root, fetchImpl: f, log: () => {} }), /onnx\/text\.onnx is corrupt/);
  assert.equal(modelReady(model, root), false);
  assert.ok(!fs.existsSync(path.join(modelDir(model, root), 'onnx/text.onnx')));
  assert.ok(!fs.existsSync(path.join(modelDir(model, root), 'onnx/text.onnx.part')));
});

test('downloaded once, from the pinned revision; checked files are not fetched or hashed again', async () => {
  const root = tmpdir();
  const first = fakeFetch();
  const logged: string[] = [];
  const [a, b] = await Promise.all([
    ensureModel(model, { root, fetchImpl: first.f, log: (m) => logged.push(m) }),
    ensureModel(model, { root, fetchImpl: first.f, log: (m) => logged.push(m) }),
  ]);
  assert.equal(a, b);
  assert.equal(first.asked.length, 4, 'two callers share one download');
  assert.ok(first.asked.every((u) => u.startsWith(`https://huggingface.co/test/tiny-model/resolve/${model.revision}/`)));
  assert.match(logged[0] ?? '', /downloading test\/tiny-model/);
  assert.equal(modelReady(model, root), true);
  const again = fakeFetch();
  await ensureModel(model, { root, fetchImpl: again.f, log: () => {} });
  assert.equal(again.asked.length, 0);
  // a copy put there by hand (from another machine): checked by its hash, then used
  const copy = tmpdir();
  for (const [p, data] of Object.entries(served)) {
    fs.mkdirSync(path.dirname(path.join(modelDir(model, copy), p)), { recursive: true });
    fs.writeFileSync(path.join(modelDir(model, copy), p), data);
  }
  const none = fakeFetch();
  await ensureModel(model, { root: copy, fetchImpl: none.f, log: () => {} });
  assert.deepEqual([none.asked.length, modelReady(model, copy)], [0, true]);
});

test('the stand-in model through its worker: the same vectors as computed here, texts by their colour words', async () => {
  const e = createEmbedder({ kind: 'fake' });
  try {
    assert.equal(e.key, 'fake');
    assert.equal(e.ready(), true);
    const red = new Uint8Array(FAKE_SIZE * FAKE_SIZE * 3).map((_, i) => (i % 3 === 0 ? 220 : 40));
    const [v] = await e.images([red]);
    assert.deepEqual(Array.from(v as Float32Array), Array.from(fakeImage(red)));
    const [t] = await e.texts(['a red car']);
    assert.deepEqual(Array.from(t as Float32Array), Array.from(fakeText('a red car')));
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
    const [blue] = await e.texts(['blue sky']);
    assert.ok(dot(v as Float32Array, t as Float32Array) > dot(v as Float32Array, blue as Float32Array));
  } finally {
    e.stop();
  }
});

test('a worker that dies fails the request, not the caller; three crashes park it', async () => {
  const dir = tmpdir();
  const worker = path.join(dir, 'crash.mjs');
  fs.writeFileSync(worker, "process.send({ type: 'hello' });\nprocess.on('message', (m) => { if (m.type !== 'load') process.exit(3); });\n");
  const e = createEmbedder({ kind: 'fake', workerPath: worker, log: () => {} });
  for (let i = 0; i < 3; i++) await assert.rejects(e.texts(['x']), /the footage model stopped \(exit 3\)/);
  await assert.rejects(e.texts(['x']), /paused after repeated crashes/);
  e.stop();
});
