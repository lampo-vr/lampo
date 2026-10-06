// Stand-in for lib/stt/worker.ts in tests: speaks the same protocol without a model.
// The first PCM sample picks the behaviour: 0.5 → crash, 0.25 → never answer, otherwise answer "fake <n samples>"
// (+ " in <language>" when one is forced, + " late" when the first line may start late).
// Detected language is FAKE_LANG (default "de") unless the request forces one; a prompt answers in Chinese to
// exercise the collapse guard when FAKE_COLLAPSE=1.
import type { WorkerIn, WorkerOut } from '../../lib/stt/protocol.ts';

const send = (m: WorkerOut) => process.send?.(m);
// FAKE_HELLO_MS: a slow start, like a busy machine or a first Metal kernel compile.
setTimeout(
  () => send({ type: 'hello', devices: [{ name: 'CPU', kind: 'cpu', deviceType: process.env.FAKE_GPU === '1' ? 'gpu' : 'cpu' }] }),
  Number(process.env.FAKE_HELLO_MS || 0),
);

process.on('message', (m: WorkerIn) => {
  if (m.type === 'load') send({ type: 'loaded', device: 'FAKE0', arch: 'fake', ms: 1 });
  if (m.type === 'exit') process.exit(0);
  if (m.type !== 'run') return;
  if (m.pcm[0] === 0.5) process.exit(3);
  if (m.pcm[0] === 0.25) return;
  const text =
    m.prompt && process.env.FAKE_COLLAPSE === '1' ? '说加入' : `fake ${m.pcm.length}${m.language ? ` in ${m.language}` : ''}${m.lateStart ? ' late' : ''}`;
  send({ type: 'result', id: m.id, text, language: m.language || process.env.FAKE_LANG || 'de', ms: 1 });
});
process.on('disconnect', () => process.exit(0));
