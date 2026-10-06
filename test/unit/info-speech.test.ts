// /api/info is public (the sign-in screen reads it). The speech engine's model path and its last error name the
// server's files and hosts: a hosted server's admins and owners signed in in the browser read them, the machine's owner
// at the machine too; anyone else — signed out, a member, an API token, another device on the machine — reads the
// model's name only, and that the engine isn't working without what it said (audit A12 verification: VC-5).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';
import { client, type Request } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const tmp = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'local', VR_STT_PREFETCH: '0' } }).dir;
const MODEL = path.join(tmp, 'srv', 'northwind', 'models', 'whisper-northwind-finetune.gguf');
process.env.VR_STT_MODEL = MODEL;
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const ws = await import('../../lib/workspaces.ts');

const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
let hosted: http.Server;
let machine: http.Server;
let onServer: Request;
let onMachine: Request;
const as: Record<string, Record<string, string>> = {};

async function signIn(email: string, workspace?: string): Promise<Record<string, string>> {
  const r = await onServer('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: origin });
  assert.equal(r.status, 200, r.text);
  let cookie = String([r.headers['set-cookie']].flat()[0]).split(';')[0];
  if (workspace) {
    const s = await onServer('POST', '/api/workspaces/switch', { body: { id: workspace }, headers: { Cookie: cookie, ...origin } });
    assert.equal(s.status, 200, s.text);
    cookie = String([s.headers['set-cookie']].flat()[0]).split(';')[0];
  }
  return { Cookie: cookie, ...origin };
}

before(async () => {
  hosted = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => hosted.listen(0, '127.0.0.1', r));
  onServer = client((hosted.address() as AddressInfo).port, { Host: 'review.test' });
  machine = http.createServer(createApp(createContext({ cfg: { ...loadConfig(), mode: 'local' }, token: 'unused', loadSessions: async () => [] })));
  await new Promise<void>((r) => machine.listen(0, '127.0.0.1', r));
  onMachine = client((machine.address() as AddressInfo).port);
  const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
  await auth.createUser({ email: 'max@example.com', name: 'Max', password: PASSWORD, role: 'member' });
  as.owner = await signIn('olivia@example.com');
  as.member = await signIn('max@example.com');
  as.ownerToken = { Authorization: `Bearer ${auth.createToken(olivia.id, 'agent').token}` };
  // A customer: Eve owns a workspace of her own (what an open sign-up gets; here she reviews in #1 too), and Ann is an
  // admin of #1.
  await auth.createUser({ email: 'ann@example.com', name: 'Ann', password: PASSWORD, role: 'admin' });
  const eve = await auth.createUser({ email: 'eve@example.com', name: 'Eve', password: PASSWORD, role: 'reviewer' });
  const E = ws.createWorkspace({ name: 'Eve Films', ownerId: eve.id }).id;
  as.otherOwner = await signIn('eve@example.com', E);
  as.admin = await signIn('ann@example.com');
});
after(() => {
  for (const s of [hosted, machine]) {
    s.closeAllConnections();
    s.close();
  }
});

const sttOf = async (ask: Request, headers: Record<string, string> = {}) => (await ask('GET', '/api/info', { headers })).json().stt as { model: string | null };

test('a hosted server: the model’s path for the operator (an owner of #1) in the browser, its name for anyone else', async () => {
  assert.equal((await sttOf(onServer, as.owner)).model, MODEL, 'the owner signed in reads where the model is');
  for (const [what, headers] of [
    ['signed out', {}],
    ['a member', as.member],
    ['the owner’s API token', as.ownerToken],
    ['the owner of another workspace (a customer)', as.otherOwner],
    ['an admin of #1 (not the operator)', as.admin],
  ] as const) {
    const stt = await sttOf(onServer, headers);
    assert.equal(stt.model, 'whisper-northwind-finetune.gguf', `${what}: the model's name only`);
    assert.ok(!JSON.stringify(stt).includes('northwind/models'), `${what}: no path`);
  }
});

test('the machine: its owner at the machine reads the path; another device doesn’t', async () => {
  assert.equal((await sttOf(onMachine)).model, MODEL);
  assert.equal((await sttOf(onMachine, { 'x-forwarded-for': '192.168.1.20' })).model, 'whisper-northwind-finetune.gguf');
});

test('the engine’s last error: that it fails, never what it said', async () => {
  const { publicSttStatus } = await import('../../lib/stt/index.ts');
  const failing = {
    backend: 'local' as const,
    available: true,
    state: 'error' as const,
    model: MODEL,
    device: null,
    error: `speech model not found: ${MODEL}`,
    progress: null,
  };
  const shown = publicSttStatus(failing);
  assert.equal(shown.error, 'the speech engine is not working');
  assert.equal(shown.model, 'whisper-northwind-finetune.gguf');
  assert.ok(!JSON.stringify(shown).includes(tmp));
  assert.equal(publicSttStatus({ ...failing, model: 'whisper-turbo', error: null }).model, 'whisper-turbo', 'a preset keeps its id');
});
