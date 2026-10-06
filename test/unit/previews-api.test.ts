// Fix previews over HTTP on a hosted server: attaching (inline and through a one-time upload URL), serving, verifying
// on a preview, recording where a render came from, the roles, and the next upload confirming the fix on its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');

const FPS = 25;
const BOX = 'drawbox=x=40:y=30:w=80:h=50:color=white:t=fill';
const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y']);
const render = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 320, h: 180, fps: FPS, dur: 2, pattern: 'testsrc2' });
const fixedRender = path.join(dir, 'renders/spot-fixed.mp4');
ffmpeg('-i', render, '-vf', BOX, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', fixedRender);
const still = path.join(dir, 'renders/fix.png');
ffmpeg('-ss', ((10 - 0.5) / FPS).toFixed(6), '-i', render, '-frames:v', '1', '-vf', BOX, still);
const clip = path.join(dir, 'renders/fix.mov');
ffmpeg('-ss', ((5 - 0.5) / FPS).toFixed(6), '-i', fixedRender, '-frames:v', '25', '-c:v', 'mpeg4', '-q:v', '2', '-an', clip);

const { request, base } = await startApp();
let owner: Record<string, string> = {};
let reviewer: Record<string, string> = {};
before(async () => {
  const o = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const r = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  owner = { Authorization: `Bearer ${auth.createToken(o.id, 'test').token}` };
  reviewer = { Authorization: `Bearer ${auth.createToken(r.id, 'test').token}` };
});

let slug = '';
let note = '';
let previewId = '';
const s = () => encodeURIComponent(slug);

test('an agent attaches a still inline; it is served, with the project name but never its folders', async () => {
  const up = await tusUpload(request, render, { filename: 'spot.mp4', folder: 'Acme' }, owner);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
  const c = await request('POST', `/api/review/${s()}/comments`, { body: { frame: 10, text: 'Logo zu früh' }, headers: owner });
  assert.equal(c.status, 200, c.text);
  note = c.json().id;

  const body = {
    kind: 'still',
    fixed: true,
    note: 'Logo kommt jetzt bei 0:01',
    source: { app: 'After Effects', project: '/Users/someone/Projects/secret-client/spot.aep', comp: 'Main', time: 0.4 },
    data: fs.readFileSync(still).toString('base64'),
  };
  assert.equal((await request('POST', `/api/comments/${note}/previews`, { body, headers: reviewer })).status, 403, "reviewers don't fix");
  const r = await request('POST', `/api/comments/${note}/previews`, { body, headers: owner });
  assert.equal(r.status, 200, r.text);
  const { preview, comment } = r.json();
  previewId = preview.id;
  assert.deepEqual([preview.kind, preview.frame, preview.v, preview.width, preview.height], ['still', 10, 1, 320, 180]);
  assert.equal(preview.source.project, 'spot.aep');
  assert.ok(!r.text.includes('secret-client'));
  assert.equal(comment.status, 'fixed');

  const img = await fetch(`${base}/api/previews/${s()}/${preview.file}`, { headers: reviewer });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, fs.statSync(still).size);
  for (const bad of ['p_0000000000.png', '..%2Freview.json', 'review.json'])
    assert.equal((await request('GET', `/api/previews/${s()}/${bad}`, { headers: owner })).status, 404, bad);
});

test('refused: not an image, too big, an unknown preview, a preview with the wrong status', async () => {
  const notImage = await request('POST', `/api/comments/${note}/previews`, {
    body: { kind: 'still', data: Buffer.from('hello').toString('base64') },
    headers: owner,
  });
  assert.equal(notImage.status, 422);
  assert.match(notImage.json().error, /PNG, JPEG or WebP/);
  const big = await request('POST', `/api/comments/${note}/previews`, { body: { kind: 'still', data: 'A'.repeat(12_000_000) }, headers: owner });
  assert.ok([400, 413].includes(big.status), `${big.status}`);
  const unknown = await request('PATCH', `/api/comments/${note}`, { body: { status: 'verified', preview: 'p_0000000000' }, headers: reviewer });
  assert.equal(unknown.status, 400);
  const wrong = await request('PATCH', `/api/comments/${note}`, { body: { status: 'wontfix', preview: previewId }, headers: owner });
  assert.equal(wrong.status, 400);
});

test('the reviewer verifies on the preview: resolved for them, the video waits for the render', async () => {
  const v = await request('PATCH', `/api/comments/${note}`, { body: { status: 'verified', preview: previewId }, headers: reviewer });
  assert.equal(v.status, 200, v.text);
  assert.deepEqual(v.json().verified_on, { preview: previewId, v: 1 });
  const review = (await request('GET', `/api/review/${s()}`, { headers: owner })).json();
  assert.equal(review.summary.stage.on_preview, 1);
  assert.match(review.summary.stage.detail, /1 fix checked on a preview/);
  // Marking final is a person's decision (in the app, signed in), never a token's.
  const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'a long password' }, headers: { Origin: PUBLIC } });
  const olivia = { Cookie: cookieFrom(login), Origin: PUBLIC };
  const final = await request('PUT', `/api/review/${s()}/final`, { body: { confirm: true }, headers: olivia });
  assert.equal(final.status, 409, 'not final while the fix exists only in the project');
  assert.match(final.json().error, /verified on a preview only/);
});

test('a clip through a one-time upload URL (one plain PUT), served as mp4', async () => {
  const other = await request('POST', `/api/review/${s()}/comments`, { body: { frame: 5, text: 'Übergang zu hart' }, headers: owner });
  const ticket = await request('POST', `/api/comments/${other.json().id}/previews`, { body: { kind: 'clip', frame: 5 }, headers: owner });
  assert.equal(ticket.status, 200, ticket.text);
  const url = String(ticket.json().upload.url);
  assert.ok(url.startsWith(`${PUBLIC}/api/uploads/direct/vrup_`), url);
  const bytes = fs.readFileSync(clip);
  const put = await fetch(url.replace(PUBLIC, base), { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const done = (await put.json()) as { preview: { kind: string; frames: number; file: string } };
  assert.equal(put.status, 200, JSON.stringify(done));
  assert.deepEqual([done.preview.kind, done.preview.frames], ['clip', 25]);
  const video = await fetch(`${base}/api/previews/${s()}/${done.preview.file}`, { headers: { ...reviewer, Range: 'bytes=0-99' } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(url.replace(PUBLIC, base), { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } })).status, 410);
});

test('where a render came from: set by who uploads, folders stripped, cleared with an empty body', async () => {
  const body = { app: 'After Effects', project: 'C:\\Jobs\\Acme\\spot.aep', comp: 'Main 9x16', start_frame: 12, fps: 25 };
  assert.equal((await request('PUT', `/api/review/${s()}/versions/1/source`, { body, headers: reviewer })).status, 403);
  const r = await request('PUT', `/api/review/${s()}/versions/1/source`, { body, headers: owner });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json().source, { ...body, project: 'spot.aep' });
  assert.equal((await request('PUT', `/api/review/${s()}/versions/1/source`, { body: { app: 'x', path: '/etc' }, headers: owner })).status, 400);
});

test('the next upload contains the fix: the server compares it with the preview and confirms the note', async () => {
  const up = await tusUpload(request, fixedRender, { filename: 'spot.mp4', slug }, owner);
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json().v, 2);
  let c: { status: string; verified_on?: unknown; previews: { confirmed?: { v: number } }[] } | undefined;
  // The check is a background job queued behind posters and sprites: give it a minute when the whole suite runs at once.
  for (let i = 0; i < 600; i++) {
    c = (await request('GET', `/api/comments/${note}`, { headers: owner })).json().comment;
    if (c?.previews[0].confirmed) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(c?.previews[0].confirmed?.v, 2, JSON.stringify(c));
  assert.equal(c?.status, 'verified');
  assert.equal(c?.verified_on, undefined);
});

// ---------------------------------------------------------------- MCP (hosted /mcp)

test('MCP: set_render_source, attach_preview inline and as an upload URL, get_note shows project time and previews', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const c = new Client({ name: 'ae-agent', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: owner } }));
  type Result = { content: { type: string; text?: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as Result;
    return { ...r, text: r.content.map((x) => x.text || '').join('\n') };
  };
  try {
    const src = await call('set_render_source', { video: 'spot.mp4', app: 'After Effects', project: '/Volumes/Jobs/spot.aep', comp: 'Main', start_frame: 12 });
    assert.ok(!src.isError, src.text);
    assert.match(src.text, /^v2: After Effects · spot\.aep · Main \(from frame 12\)$/);
    const note = (await request('POST', `/api/review/${s()}/comments`, { body: { frame: 20, text: 'Farbe kippt' }, headers: owner })).json().id;
    const got = await call('get_note', { id: note });
    assert.match(got.text, /project: 1\.280 s · frame 32 in After Effects · spot\.aep · Main \(from frame 12\) \(v2\)/, got.text);

    const refused = await call('attach_preview', { id: note, path: '/etc/passwd' });
    assert.ok(refused.isError, 'a hosted server never reads paths');
    const png = path.join(dir, 'renders/mcp.png');
    ffmpeg('-ss', ((20 - 0.5) / FPS).toFixed(6), '-i', fixedRender, '-frames:v', '1', png);
    const inline = await call('attach_preview', { id: note, data: fs.readFileSync(png).toString('base64'), fixed: true, note: 'Grade zurückgenommen' });
    assert.ok(!inline.isError, inline.text);
    assert.match(inline.text, /^c_[a-f0-9]{6}: preview p_[a-f0-9]{10} still of f20 on v2 by agent:ae-agent · marked fixed/);

    const ticket = await call('attach_preview', { id: note, kind: 'clip', frame: 5 });
    assert.ok(!ticket.isError, ticket.text);
    assert.match(ticket.text, /curl -fT <file> 'http:\/\/review\.test\/api\/uploads\/direct\/vrup_[\w-]+'/);
    const after = await call('get_note', { id: note });
    assert.match(after.text, /preview p_[a-f0-9]{10} still of f20 on v2 by agent:ae-agent/);
    assert.match(after.text, /\[fixed v2\]: Grade zurückgenommen Preview: still of 00:00:20 \(f20\) on top of v2\./);
  } finally {
    await c.close();
  }
});
