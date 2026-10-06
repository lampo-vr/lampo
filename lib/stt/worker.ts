// The speech engine's own process (forked by lib/stt/local.ts): holds one transcribe.cpp model + session and answers
// requests one at a time (the library allows one computation per model). A native crash takes down this process,
// never the server.
//   parent → {type:'load', path, threads} · {type:'run', id, pcm, language?, prompt?, timed?, lateStart?} · {type:'exit'}
//   worker → {type:'hello', devices} · {type:'loaded', device, arch, ms} · {type:'result', id, text, language, ms,
//            words?, segments?} (timed runs: the finest timing the model has — Parakeet words, Whisper segments)
//            · {type:'failed', id?, error}
import type { WorkerIn, WorkerOut } from './protocol.ts';

type TC = typeof import('transcribe-cpp');
type Model = Awaited<ReturnType<TC['TranscribeModel']['load']>>;
type Session = ReturnType<Model['createSession']>;

const send = (m: WorkerOut) => process.send?.(m);
/** A window's length: with `lateStart` the first line may begin anywhere in it. */
const LATE_START_S = 30;

let tc: TC;
try {
  tc = await import('transcribe-cpp');
} catch (e) {
  send({ type: 'failed', error: `transcribe-cpp is not installed for this platform: ${(e as Error).message}` });
  process.exit(1);
}
// Native log lines only matter when something breaks; the parent logs failures itself.
tc.setLogHandler(() => {});

let model: Model | null = null;
let session: Session | null = null;
let queue = Promise.resolve();

send({
  type: 'hello',
  devices: tc.getAvailableBackends().map((d) => ({ name: d.name, kind: d.kind, deviceType: d.deviceType })),
});

async function handle(msg: WorkerIn): Promise<void> {
  if (msg.type === 'load') {
    const t = performance.now();
    try {
      session?.dispose();
      model?.dispose();
      model = await tc.TranscribeModel.load(msg.path);
      session = model.createSession({ nThreads: msg.threads });
      send({ type: 'loaded', device: model.device.name, arch: model.arch, ms: Math.round(performance.now() - t) });
    } catch (e) {
      send({ type: 'failed', error: `cannot load ${msg.path}: ${(e as Error).message}` });
    }
    return;
  }
  if (msg.type === 'run') {
    const t = performance.now();
    if (!session || !model) return void send({ type: 'failed', id: msg.id, error: 'no model loaded' });
    try {
      // Whisper's own options: the vocabulary prompt, and a first line free to start late in the window (whisper.cpp
      // otherwise wants it within the first second, which over a music intro invents a line).
      const whisper =
        (msg.prompt || msg.lateStart) && model.accepts({ kind: 'whisper' })
          ? {
              kind: 'whisper' as const,
              ...(msg.prompt ? { initialPrompt: msg.prompt } : {}),
              ...(msg.lateStart ? { maxInitialTimestamp: LATE_START_S } : {}),
            }
          : null;
      // A timed run (a render's transcript) asks for the finest timing the model has: word/token, or segment.
      const most = model.capabilities.maxTimestampKind;
      const r = await session.run(msg.pcm, {
        ...(msg.language ? { language: msg.language } : {}),
        ...(whisper ? { family: whisper } : {}),
        ...(msg.timed && most !== 'none' ? { timestamps: most === 'token' ? ('word' as const) : most } : {}),
      });
      const timed = (x: { text: string; t0Ms: number; t1Ms: number }) => ({ text: x.text, t0: x.t0Ms / 1000, t1: x.t1Ms / 1000 });
      send({
        type: 'result',
        id: msg.id,
        text: r.text.trim(),
        language: r.language || '',
        ms: Math.round(performance.now() - t),
        ...(msg.timed ? { words: r.words.map(timed), segments: r.segments.map(timed) } : {}),
      });
    } catch (e) {
      send({ type: 'failed', id: msg.id, error: (e as Error).message });
    }
    return;
  }
  if (msg.type === 'exit') {
    session?.dispose();
    model?.dispose();
    process.exit(0);
  }
}

process.on('message', (msg: WorkerIn) => {
  queue = queue.then(() => handle(msg));
});
process.on('disconnect', () => process.exit(0));
