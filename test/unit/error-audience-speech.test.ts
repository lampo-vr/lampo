// What a speech engine says when it fails (a speech server's traceback, its internal host, a model's path) is the
// server's business: the machine's owner at the machine reads it as it is; a token, an agent over MCP and every caller
// of a hosted server get a sentence instead — in the transcript's answer, in `get_transcript` and in a recording's
// (audit A12 verification: VC-4).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { age, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

// A speech server that fails the way a real one does: with its own traceback.
const ENGINE_SAYS = 'Traceback (most recent call last): File "/srv/whisper/app.py", line 88: model /mnt/models/large-v3.bin missing on gpu-01.internal';
const engine = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => res.writeHead(500).end(ENGINE_SAYS));
});
await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r));
const { dir } = isolatedEnv({ vars: { VR_STT: 'http', VR_STT_URL: `http://127.0.0.1:${(engine.address() as AddressInfo).port}` } });
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const auth = await import('../../lib/auth.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');

// A render with sound (the engine is only asked when there is some to hear).
const video = makeVideo(path.join(dir, 'proj', 'spot.mp4'), { w: 160, h: 90, dur: 2, audio: true });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(video);
const enc = encodeURIComponent;

let machine: http.Server;
let hosted: http.Server;
let onMachine: Request;
let onServer: Request;
let token = '';
let hostedCtx: ReturnType<typeof createContext>;
const consoleError = console.error;
before(async () => {
  console.error = () => {};
  machine = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => machine.listen(0, '127.0.0.1', r));
  onMachine = client((machine.address() as AddressInfo).port);
  hostedCtx = createContext({ cfg: { ...loadConfig(), mode: 'server' }, token: 'unused', loadSessions: async () => [] });
  hosted = http.createServer(createApp(hostedCtx));
  await new Promise<void>((r) => hosted.listen(0, '127.0.0.1', r));
  onServer = client((hosted.address() as AddressInfo).port);
  const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'a long password', role: 'member' });
  token = auth.createToken(max.id, 'agent').token;
});
after(() => {
  console.error = consoleError;
  for (const s of [machine, hosted]) {
    s.closeAllConnections();
    s.close();
  }
  engine.close();
});

const SECRETS = ['Traceback', '/srv/whisper', 'gpu-01.internal', '/mnt/models', 'speech server answered'];
const named = (text: string) => SECRETS.filter((s) => text.includes(s));

/** The transcript's answer once hearing it has failed. */
async function failed(ask: Request, headers: Record<string, string> = {}): Promise<{ state: string; error?: string }> {
  for (let i = 0; i < 200; i++) {
    const a = (await ask('GET', `/api/review/${enc(slug)}/transcript`, { headers })).json();
    if (a.state !== 'pending') return a;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the transcript never settled');
}

test('a failed transcript: the owner at the machine reads the engine, a token and a hosted server’s callers a sentence', async () => {
  const owner = await failed(onMachine);
  assert.equal(owner.state, 'failed');
  assert.match(owner.error ?? '', /Traceback/, 'the machine’s owner reads what the engine said');

  const bearer = { Authorization: `Bearer ${token}` };
  for (const [what, a] of [
    ['a token on the machine', await failed(onMachine, bearer)],
    ['a token on a server', await failed(onServer, bearer)],
  ] as const) {
    assert.equal(a.state, 'failed', what);
    assert.deepEqual(named(a.error ?? ''), [], `${what}: ${a.error}`);
    assert.equal(a.error, 'the speech engine could not hear this version', what);
  }
});

test('get_transcript over MCP: an agent on a hosted server gets a sentence with a ref', async () => {
  const c = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  const port = (hosted.address() as AddressInfo).port;
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const r = (await c.callTool({ name: 'get_transcript', arguments: { video: slug } })) as { content: { text?: string }[]; isError?: boolean };
    assert.equal(r.isError, true);
    const text = r.content[0]?.text ?? '';
    assert.deepEqual(named(text), [], text);
    assert.match(text, /\(ref [0-9a-f]{8}\)/, text);
  } finally {
    await c.close();
  }
});

test('the rule itself: a failure kept to be read later is the owner’s to read, a sentence for anyone else', async () => {
  const { shownTo, isInternal } = await import('../../lib/publicError.ts');
  assert.equal(shownTo('owner', ENGINE_SAYS, 'the recording could not be heard'), ENGINE_SAYS);
  assert.equal(shownTo('other', ENGINE_SAYS, 'the recording could not be heard'), 'the recording could not be heard');
  assert.equal(shownTo('other', 'speech server answered 500: out of memory', 'not heard'), 'not heard', 'whatever it looks like');
  const { transcribeTimed } = await import('../../lib/stt/index.ts');
  const thrown = await transcribeTimed(video, loadConfig().stt).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(thrown && isInternal(thrown), 'an engine’s failure is internal where it is thrown');
});

// "Listen again" answers with what the run says at once: a failure kept from before (a run for the same render still
// settling) goes by audience there too, like every other answer about a transcript (A12 hardening).
test('Listen again: a failure in its answer is a sentence for a token', async () => {
  const start = hostedCtx.background.startTranscript;
  hostedCtx.background.startTranscript = (_review, v) => ({ state: 'failed', v, error: ENGINE_SAYS }) as ReturnType<typeof start>;
  try {
    const r = await onServer('POST', `/api/review/${enc(slug)}/transcript/rerun`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(named(r.text), [], r.text);
    assert.equal(r.json().error, 'the speech engine could not hear this version');
  } finally {
    hostedCtx.background.startTranscript = start;
  }
});
