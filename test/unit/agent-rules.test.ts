// Agents never sign off and fix nothing on a final video (docs/workflow.md). `vr` and the MCP tools say so, and the
// server holds it too: with an API token, approving, carrying an approval over, marking final and reopening are
// refused, and so is marking a note fixed or won't-fix on a final video. People do all of it in the app.
import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
const { request } = await startApp({ headers: { Connection: 'close' } });
let agent: Record<string, string> = {};
let person: Record<string, string> = {};
let slug = '';
let note = '';
before(async () => {
  const max = await auth.createUser({ email: 'max@example.com', name: 'Max', password: 'maxs password 1', role: 'member' });
  agent = { Authorization: `Bearer ${auth.createToken(max.id, 'agent').token}` };
  const login = await request('POST', '/api/auth/login', { body: { email: 'max@example.com', password: 'maxs password 1' }, headers: { Origin: PUBLIC } });
  assert.equal(login.status, 200, login.text);
  person = { Cookie: cookieFrom(login), Origin: PUBLIC };
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Acme' }, agent);
  assert.equal(up.status, 200, up.text);
  slug = encodeURIComponent(up.json().slug);
  const c = await request('POST', `/api/review/${slug}/comments`, { body: { frame: 3, text: 'Heller', severity: 'must' }, headers: person });
  assert.equal(c.status, 200, c.text);
  note = c.json().id;
});

test('an API token signs nothing off: no approval, no carry-over, no final, no reopen', async () => {
  for (const [method, url, body] of [
    ['PUT', `/api/review/${slug}/approval`, { status: 'approved' }],
    ['POST', `/api/review/${slug}/approval/carry`, {}],
    ['PUT', `/api/review/${slug}/final`, { confirm: true }],
  ] as const) {
    const r = await request(method, url, { body, headers: agent });
    assert.equal(r.status, 403, `${method} ${url} with a token: ${r.text}`);
  }
  const approved = await request('PUT', `/api/review/${slug}/approval`, { body: { status: 'approved' }, headers: person });
  assert.equal(approved.status, 200, 'a person approves');
  const final = await request('PUT', `/api/review/${slug}/final`, { body: { confirm: true }, headers: person });
  assert.equal(final.status, 200, `a person marks it final: ${final.text}`);
  assert.equal((await request('DELETE', `/api/review/${slug}/final`, { headers: agent })).status, 403, 'nor reopens it with a token');
});

test('a final video is locked for agents: nothing fixed or won’t-fix through a token until it is reopened', async () => {
  const fixed = await request('PATCH', `/api/comments/${note}`, { body: { status: 'fixed', note: 'done', by: 'agent:edit' }, headers: agent });
  assert.equal(fixed.status, 409, fixed.text);
  assert.match(fixed.json().error, /is final \(v1, by Max\): nothing to fix until the reviewer reopens it/);
  const wontfix = await request('PATCH', `/api/comments/${note}`, { body: { status: 'wontfix', note: 'no' }, headers: agent });
  assert.equal(wontfix.status, 409, wontfix.text);
  const preview = await request('POST', `/api/comments/${note}/previews`, { body: { fixed: true, note: 'done' }, headers: agent });
  assert.equal(preview.status, 409, `a fix preview marked fixed: ${preview.text}`);
  assert.equal((await request('PATCH', `/api/comments/${note}`, { body: { note: 'a question about it' }, headers: agent })).status, 200, 'replies still go');

  assert.equal((await request('DELETE', `/api/review/${slug}/final`, { headers: person })).status, 200, 'a person reopens it');
  const now = await request('PATCH', `/api/comments/${note}`, { body: { status: 'fixed', note: 'done', by: 'agent:edit' }, headers: agent });
  assert.equal(now.status, 200, now.text);
});
