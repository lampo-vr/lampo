// Starting an upload asks the workspace's plan first (a billing module). Its refusal goes out as it is — a 402 with the
// module's sentence, and for a person's browser the reason and numbers the limit sheet shows —, but a plan check that
// fails inside (here a module whose store can't be read, an errno naming its file) is the server's fault: a 500 with
// a sentence and a ref, never the errno or the path, for a person and an agent alike.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const ext = await import('../../server/extension.ts');
const auth = await import('../../lib/auth.ts');

let mode: 'broken' | 'full' = 'broken';
const canUpload = async () => {
  if (mode === 'full') return { ok: false as const, reason: 'storage' as const, message: 'This workspace’s plan is full.' };
  throw Object.assign(new Error("EACCES: permission denied, open '/srv/billing/store-of-acme.json'"), { code: 'EACCES', errno: -13, syscall: 'open' });
};
const allow = async () => ({ ok: true as const });
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
ctx.extension = ext.createExtension(
  {
    name: 'stand-in',
    entitlements: { get: async () => null, canUpload, canAddMember: allow, canAddVideo: allow, canShare: allow },
    routes: [],
    workspaces: {},
  },
  ext.hostContext({ publicUrl: PUBLIC, who: () => null, sameOrigin: () => false }),
);
const { request } = await startApp({ ctx, headers: { Connection: 'close', Host: 'review.test' } });
const clip = makeVideo(path.join(dir, 'up', 'spot.mp4'), { dur: 1 });

const max = await auth.createUser({ email: 'm@example.com', name: 'Max', password: 'maxs password 1', role: 'owner' });
const login = await request('POST', '/api/auth/login', { body: { email: 'm@example.com', password: 'maxs password 1' }, headers: { Origin: PUBLIC } });
const callers = [
  ['a person in the browser', { Cookie: cookieFrom(login), Origin: PUBLIC }],
  ['an API token', { Authorization: `Bearer ${auth.createToken(max.id, 'agent').token}` }],
] as const;

test('a plan check that fails inside: a 500 sentence with a ref, no errno, no path', async () => {
  mode = 'broken';
  for (const [who, headers] of callers) {
    const r = await tusUpload(request, clip, { filename: 'spot.mp4' }, headers);
    assert.equal(r.status, 500, `${who}: ${r.status} ${r.text}`);
    assert.match(r.text, /\(ref [0-9a-f]{8}\)/, who);
    for (const secret of ['EACCES', '/srv/', 'store-of-acme']) assert.ok(!r.text.includes(secret), `${who} reads ${secret}: ${r.text}`);
  }
});

test('the plan’s own refusal still goes out as it is: a 402, its reason for the browser, its sentence for the agent', async () => {
  mode = 'full';
  const [[, browser], [, token]] = callers;
  const b = await tusUpload(request, clip, { filename: 'spot.mp4' }, browser);
  assert.equal(b.status, 402, b.text);
  const said = JSON.parse(b.text) as { error: string; reason?: string };
  assert.equal(said.error, 'This workspace’s plan is full.');
  assert.equal(said.reason, 'storage');
  const t = await tusUpload(request, clip, { filename: 'spot.mp4' }, token);
  assert.equal(t.status, 402, t.text);
  assert.equal(t.text, 'This workspace’s plan is full.');
});
