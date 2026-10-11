// covers: mcp/feedback.ts lib/told.ts mcp/tools/read.ts mcp/format.ts mcp/app.ts server/routes/mcp.ts lib/eventLine.ts lib/store.ts server/routes/review.ts
// The review loop's scenarios as the loop map ran them (a hosted server, Mia in the app, a chat agent over MCP with her
// account), each one a bug the loop had: what the person says while the agent renders reaches it (d: a note on V1 while
// V2 renders; b, step 3: "Still wrong in V2." while V3 renders), whatever cursor it waits with; a note keeps its
// pictures for every version (f: the marked frame next to the same spot on the newest version, fixed notes waiting for
// a check keep theirs, a missing screenshot is said, the card shows its own version's spot); Still wrong carries the
// version it was said on and its drawing (g: REOPENED names V2 and comes with V2's picture); and a fix marked before
// its version (`fix_pending`, lib/handover.ts) is the agent's own hand-over: named, never pictured, never handed back.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';
import { cookieFrom, type Reply } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const oauth = await import('../../lib/oauth/store.ts');

const { base, request } = await startApp({ feed: 50, headers: { Host: 'review.test' } });
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

// Mia: the workspace's owner, in the app
const PASSWORD = ['a', 'long', 'password', 'here'].join(' ');
const mia = await auth.createUser({ email: 'mia@example.com', name: 'Mia Lang', password: PASSWORD, role: 'owner' });
const login = await request('POST', '/api/auth/login', { body: { email: 'mia@example.com', password: PASSWORD }, headers: { Origin: PUBLIC } });
assert.equal(login.status, 200, login.text);
const sessionCookie = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_session=')) || cookieFrom(r);
const person = { Cookie: sessionCookie(login), Origin: PUBLIC };

/** Claude (the chat app), connected through OAuth with Mia's account: its access token. */
function appToken(name: string): string {
  const client_id = `cid-${crypto.randomBytes(4).toString('hex')}`;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const asked = oauth.createRequest({
    client: { client_id, kind: 'dcr', name, host: null, redirect_uris: ['http://127.0.0.1:9/cb'], auth: 'none' },
    redirect_uri: 'http://127.0.0.1:9/cb',
    state: null,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scopes: ['review:read', 'review:comment', 'review:act'],
    resource: `${PUBLIC}/mcp`,
  });
  return oauth.redeemCode({
    code: oauth.createCode(asked, mia),
    client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  }).access_token;
}
const token = appToken('Claude');
async function connect(): Promise<Client> {
  const c = new Client({ name: 'claude-ai', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, Host: 'review.test' } } }),
  );
  clients.push(c);
  return c;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: Result) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const images = (r: Result) => r.content.filter((c) => c.type === 'image');
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = (await c.callTool({ name, arguments: args })) as Result;
  assert.ok(!r.isError, `${name}: ${textOf(r)}`);
  return r;
}

/** A version put up the way a chat agent does: request_upload, then one PUT of the file. */
async function putUp(c: Client, file: string, o: { video?: string; folder?: string; filename: string }): Promise<{ slug: string; v: number; cursor: string }> {
  const r = await call(c, 'request_upload', { filename: o.filename, ...(o.video ? { video: o.video } : { folder: o.folder ?? 'Loop' }) });
  const url = /https?:\/\/\S+\/api\/uploads\/direct\/vrup_[\w-]+/.exec(textOf(r))?.[0];
  assert.ok(url, textOf(r));
  const bytes = fs.readFileSync(file);
  const res = await fetch(url.replace(PUBLIC, base), { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.length) } });
  const json = (await res.json()) as { slug: string; v: number; cursor: string };
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}
let clip = 0;
const render = (freq: number) => makeVideo(path.join(dir, `r/${++clip}.mp4`), { w: 320, h: 180, dur: 6, fps: 10, freq });

/** Mia writes a note in the app (sent at once). */
async function note(slug: string, frame: number, text: string, o: { severity?: string; drawing?: unknown[] } = {}): Promise<string> {
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, {
    body: { frame, text, severity: o.severity ?? 'must', ...(o.drawing ? { drawing: o.drawing } : {}) },
    headers: person,
  });
  assert.equal(r.status, 200, r.text);
  return r.json().id as string;
}
const BOX = { type: 'box', x: 40, y: 30, w: 80, h: 40 };

/** The wait-now cursor an answer ends with. */
const WAIT = /Now call wait_for_feedback with since "(\S+#\d+)"/;

test('(d) a note Mia writes on V1 while V2 renders reaches the agent, though its cursor came after it', async () => {
  const c = await connect();
  // the agent works on another video too: its newest cursor can come from there
  const elsewhere = await putUp(c, render(330), { filename: 'loop-d-other.mp4' });
  const v1 = await putUp(c, render(440), { filename: 'loop-d.mp4' });
  const n1 = await note(v1.slug, 20, 'Title too small', { drawing: [BOX] });
  // the agent hears N1, reads it and goes off to render
  const heard = await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  assert.match(textOf(heard), new RegExp(`NEW MUST \\[-\\] ${n1}`));
  await call(c, 'get_open_notes', { video: v1.slug, images: 'none' });
  // meanwhile Mia keeps watching V1 and adds N2
  const n2 = await note(v1.slug, 23, 'Music too loud here', { severity: 'should' });
  // V2 with N1 fixed; then a look at the other video, whose answer's cursor comes after N2
  const v2 = await putUp(c, render(660), { video: v1.slug, filename: 'loop-d.mp4' });
  assert.equal(v2.v, 2);
  const fixed = await call(c, 'mark_fixed', { id: n1, note: 'title 20 % larger' });
  assert.match(textOf(fixed), /1 note still open on this video\./);
  const there = await call(c, 'wait_for_feedback', { video: elsewhere.slug, timeout_s: 1 });
  const later = /\ncursor: (\S+)/.exec(textOf(there))?.[1];
  assert.ok(later, textOf(there));
  // its next wait on this video, with that cursor: N2 comes, once
  const next = await call(c, 'wait_for_feedback', { video: v1.slug, since: later, timeout_s: 3 });
  assert.match(textOf(next), /^1 new:/, textOf(next));
  assert.match(textOf(next), new RegExp(`NEW SHOULD \\[-\\] ${n2} .* — "Music too loud here"`));
  const cursor = /\ncursor: (\S+)/.exec(textOf(next))?.[1];
  const again = await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 1 });
  assert.match(textOf(again), /^No new feedback in 1 s\./, 'heard once');
  // an older cursor doesn't bring it again either: what it was told is remembered, whatever the cursor says
  const old = await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 1 });
  assert.match(textOf(old), /^No new feedback in 1 s\./, textOf(old));
});

test('(b, step 3) "Still wrong in V2." said while V3 renders reaches the agent with its next wait', async () => {
  const c = await connect();
  const v1 = await putUp(c, render(440), { filename: 'loop-b.mp4' });
  const [n1, n2, n3] = [
    await note(v1.slug, 20, 'Title too small', { drawing: [BOX] }),
    await note(v1.slug, 40, 'Logo comes in too late', { severity: 'should', drawing: [BOX] }),
    await note(v1.slug, 55, 'Hold the end card longer', { severity: 'nice' }),
  ];
  const first = await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  assert.match(textOf(first), /^3 new:/);
  // V2 with only N1 fixed; it reads again to go on
  await putUp(c, render(550), { video: v1.slug, filename: 'loop-b.mp4' });
  await call(c, 'mark_fixed', { id: n1, note: 'title larger' });
  await call(c, 'get_open_notes', { video: v1.slug, images: 'none' });
  // while it renders V3, Mia says N2 is still wrong in V2 (a reply: V2 carries no fix of it to check)
  const said = await request('PATCH', `/api/comments/${n2}`, { body: { note: 'Still wrong in V2.' }, headers: person });
  assert.equal(said.status, 200, said.text);
  // V3, both fixed: the last fix hands over with a cursor from that moment
  await putUp(c, render(770), { video: v1.slug, filename: 'loop-b.mp4' });
  await call(c, 'mark_fixed', { id: n2, note: 'logo in at 1 s' });
  const last = await call(c, 'mark_fixed', { id: n3, note: 'end card held 2 s' });
  const cursor = WAIT.exec(textOf(last))?.[1];
  assert.ok(cursor, textOf(last));
  const next = await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 3 });
  assert.match(textOf(next), /^1 new:/, textOf(next));
  assert.match(textOf(next), new RegExp(`REPLY ${n2} .* by Mia Lang — "Still wrong in V2\\."`));
});

test('(d, a verdict) Looks right said while the agent works comes with its next wait, though it read the notes since', async () => {
  const c = await connect();
  const v1 = await putUp(c, render(480), { filename: 'loop-verdict.mp4' });
  const n1 = await note(v1.slug, 20, 'Title too small');
  const n2 = await note(v1.slug, 40, 'Logo comes in too late', { severity: 'should' });
  await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  await putUp(c, render(520), { video: v1.slug, filename: 'loop-verdict.mp4' });
  await call(c, 'mark_fixed', { id: n1, note: 'title larger' });
  // Mia checks N1 while the agent works on N2; the agent reads the notes (N1, checked, isn't among them)
  const ok = await request('PATCH', `/api/comments/${n1}`, { body: { status: 'verified', note: '' }, headers: person });
  assert.equal(ok.status, 200, ok.text);
  const read = await call(c, 'get_open_notes', { video: v1.slug, images: 'none' });
  assert.doesNotMatch(textOf(read), new RegExp(n1));
  const last = await call(c, 'mark_fixed', { id: n2, note: 'logo in at 1 s' });
  const cursor = WAIT.exec(textOf(last))?.[1];
  assert.ok(cursor, textOf(last));
  // its wait, with the fix's cursor (after the verdict): the verdict comes, the notes it read don't come again
  const next = await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 3 });
  assert.match(textOf(next), new RegExp(`^1 new:\\n.*VERIFIED ${n1} `), textOf(next));
});

/** A note's screenshot on disk, once the server has made it (it does so right after the note is written). */
async function shotOf(id: string, kind: 'marked' | 'clean'): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const hit = (fs.readdirSync(dir, { recursive: true }) as string[]).find((f) => f.endsWith(`${id}_${kind}.png`));
    if (hit) return path.join(dir, hit);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} screenshot of ${id}`);
}
const reviewOf = async (slug: string) => {
  const r = await request('GET', `/api/review/${encodeURIComponent(slug)}`, { headers: person });
  assert.equal(r.status, 200, r.text);
  return r.json().review as { comments: { id: string; v: number; replies: Record<string, unknown>[] }[] };
};

test('(f) a note keeps its pictures for every version: fixed ones in the default read, v1 marked beside v3 same spot', async () => {
  const c = await connect();
  const v1 = await putUp(c, render(440), { filename: 'loop-f.mp4' });
  const n1 = await note(v1.slug, 20, 'Title too small', { drawing: [BOX] });
  const n2 = await note(v1.slug, 40, 'Logo comes in too late', { severity: 'should', drawing: [BOX] });
  const n3 = await note(v1.slug, 55, 'Hold the end card longer', { severity: 'nice' });
  await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  // V2 brings N1's fix, V3 N2's
  await putUp(c, render(550), { video: v1.slug, filename: 'loop-f.mp4' });
  await call(c, 'mark_fixed', { id: n1, note: 'title larger' });
  await putUp(c, render(660), { video: v1.slug, filename: 'loop-f.mp4' });
  await call(c, 'mark_fixed', { id: n2, note: 'logo in at 1 s' });
  await shotOf(n2, 'marked');

  // the default read: N3 to work on; N1 and N2 waiting for Mia's check, listed with their pictures
  const list = await call(c, 'get_open_notes', { video: v1.slug });
  assert.match(textOf(list), new RegExp(`\\nFixed, waiting for the person's check \\(no work item\\): ${n1} \\(v2\\), ${n2} \\(v3\\)\\n`), textOf(list));
  assert.match(textOf(list), new RegExp(`${n1} f20 v1 marked, cropped`));
  assert.match(textOf(list), /images: "compare" adds each one's spot in v3/);
  assert.equal(images(list).length, 2, 'N1 and N2 cropped (N3 has no drawing)');

  // compare: each beside its spot in the newest version, the drawing laid over, at the same crop
  const both = await call(c, 'get_open_notes', { video: v1.slug, images: 'compare' });
  assert.match(textOf(both), new RegExp(`${n1} f20 v1 marked, cropped: x(\\d+)–(\\d+) y(\\d+)–(\\d+) of 320×180`));
  const crop = (what: string) => new RegExp(`${n1} f20 ${what}, cropped: (\\S+ \\S+)`).exec(textOf(both))?.[1];
  assert.equal(crop('v3 same spot'), crop('v1 marked'), 'the same crop');
  assert.match(textOf(both), new RegExp(`${n3} f55 v3 same spot, whole frame`));
  assert.equal(images(both).length, 6);

  // get_note: the same pair; a screenshot that is gone is said, not left out
  const one = await call(c, 'get_note', { id: n1 });
  assert.match(textOf(one), new RegExp(`${n1} f20 v1 marked, cropped`));
  assert.match(textOf(one), new RegExp(`${n1} f20 v3 same spot, cropped`));
  assert.equal(images(one).length, 2);
  fs.rmSync(await shotOf(n3, 'marked'));
  const gone = await call(c, 'get_note', { id: n3 });
  assert.match(textOf(gone), new RegExp(`${n3} f55 v1 marked frame: missing \\(not made yet, or gone\\); get_frame v 1 frame 55 shows the frame`));

  // the card shows N1's spot on its own version (V3), drawn on, not V1's screenshot
  const card = await call(c, 'show_review', { video: v1.slug, note: n1 });
  const still = (card.structuredContent as { still: { v: number; kind: string; note: string; frame: number } }).still;
  assert.deepEqual({ v: still.v, kind: still.kind, note: still.note, frame: still.frame }, { v: 3, kind: 'marked', note: n1, frame: 20 });
});

test('(g) Still wrong on V2 names V2 and brings the drawing made on it; the next check compares V2 with V3', async () => {
  const c = await connect();
  const v1 = await putUp(c, render(440), { filename: 'loop-g.mp4' });
  const n1 = await note(v1.slug, 20, 'Title too small', { drawing: [BOX] });
  await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  await putUp(c, render(550), { video: v1.slug, filename: 'loop-g.mp4' });
  const fixed = await call(c, 'mark_fixed', { id: n1, note: 'Title 20 % larger' });
  const cursor = WAIT.exec(textOf(fixed))?.[1];
  assert.ok(cursor, textOf(fixed));

  // Mia checks V1 → V2: Still wrong, a box on V2 where the title now touches the logo
  const LOGO = { type: 'box', x: 200, y: 100, w: 90, h: 60 };
  const why = 'Still too small, and now it touches the logo';
  const said = await request('PATCH', `/api/comments/${n1}`, {
    body: { status: 'open', note: why, on: { v: 2, frame: 20, drawing: [LOGO] } },
    headers: person,
  });
  assert.equal(said.status, 200, said.text);
  const heard = await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 10 });
  assert.match(textOf(heard), new RegExp(`REOPENED ${n1} .* by Mia Lang — "${why}" · still wrong in v2, drawn on it \\(get_note shows it\\)`), textOf(heard));
  assert.match(textOf(heard), new RegExp(`${n1} f20 v2 still wrong here, cropped: x\\d+–\\d+ y\\d+–\\d+ of 320×180`));
  assert.equal(images(heard).length, 1, "V2's picture with Mia's box");

  // the note: its thread says V2, V1's marked frame and V2's picture of what is still wrong
  const read = await call(c, 'get_note', { id: n1 });
  assert.match(textOf(read), new RegExp(`\\[open\\]: ${why} · still wrong in v2, drawn on it`));
  assert.match(textOf(read), new RegExp(`${n1} f20 v1 marked`));
  assert.match(textOf(read), new RegExp(`${n1} f20 v2 still wrong here, cropped`));

  // V3, fixed again: check mode compares the version it was turned down on with the new one
  await putUp(c, render(660), { video: v1.slug, filename: 'loop-g.mp4' });
  await call(c, 'mark_fixed', { id: n1, note: 'Title larger, clear of the logo' });
  const { comparedWith } = (await import('../../web/src/player/fixCheck.ts')) as Record<string, unknown>;
  assert.equal(typeof comparedWith, 'function', 'check mode picks what it compares with');
  const n = (await reviewOf(v1.slug)).comments.find((x) => x.id === n1);
  assert.equal((comparedWith as (c: unknown, v: number[], l: number) => number | null)(n, [1, 2, 3], 3), 2, 'V2 → V3, not V1 → V3');

  // Mia: Looks right; the whole history reads in order
  const ok = await request('PATCH', `/api/comments/${n1}`, { body: { status: 'verified', note: '' }, headers: person });
  assert.equal(ok.status, 200, ok.text);
  const done = await call(c, 'get_note', { id: n1 });
  assert.match(textOf(done), /\[fixed v2\][\s\S]*\[open\]: .* still wrong in v2[\s\S]*\[fixed v3\][\s\S]*\[verified\]/);
});

test('(early fix) a fix marked before its version is the agent’s own hand-over: named, never pictured on a version without it, never handed back', async () => {
  const c = await connect();
  const v1 = await putUp(c, render(610), { filename: 'loop-early.mp4' });
  const n1 = await note(v1.slug, 20, 'Title too small', { drawing: [BOX] });
  const n2 = await note(v1.slug, 40, 'Logo comes in too late', { severity: 'should' });
  const heard = await call(c, 'wait_for_feedback', { since: v1.cursor, timeout_s: 10 });
  const cursor = /\ncursor: (\S+)/.exec(textOf(heard))?.[1];
  // V2 with N1 fixed, found still wrong in V2 (no drawing); the agent fixes it again before V3 exists: it rides with V3
  await putUp(c, render(620), { video: v1.slug, filename: 'loop-early.mp4' });
  await call(c, 'mark_fixed', { id: n1, note: 'title larger' });
  const back = await request('PATCH', `/api/comments/${n1}`, { body: { status: 'open', note: 'Still too small', on: { v: 2 } }, headers: person });
  assert.equal(back.status, 200, back.text);
  await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 10 });
  await call(c, 'mark_fixed', { id: n1, note: 'title larger again' });
  const riding = (await reviewOf(v1.slug)).comments.find((x) => x.id === n1) as { status?: string; fix_pending?: boolean };
  assert.deepEqual([riding.status, riding.fix_pending], ['open', true], 'riding with V3');
  // the read names it after the work, with no picture: V2 hasn't the fix, and the ask is the agent's own to put up
  const list = await call(c, 'get_open_notes', { video: v1.slug, images: 'compare' });
  assert.match(textOf(list), new RegExp(`Fixed, riding with your next version \\(put it up; no work item\\): ${n1}`), textOf(list));
  assert.doesNotMatch(textOf(list), new RegExp(`${n1} f20 v\\d (marked|same spot)`), 'no picture of a fix no version has');
  assert.match(textOf(list), new RegExp(`${n2} OPEN SHOULD`), 'the work left is listed');
  // the note in full: its marked frame, but not V2's "same spot", which would read as the agent's own fix
  const full = await call(c, 'get_note', { id: n1 });
  assert.match(textOf(full), /marked frame/);
  assert.doesNotMatch(textOf(full), /same spot/);
  // a Still wrong can't be said on it: nothing is there to check
  const refused = await request('PATCH', `/api/comments/${n1}`, { body: { status: 'open', note: 'no', on: { v: 2 } }, headers: person });
  assert.equal(refused.status, 400, refused.text);
  // and its wait hears nothing of its own hand-over, only what a person does
  const quiet = await call(c, 'wait_for_feedback', { video: v1.slug, since: cursor, timeout_s: 1 });
  assert.match(textOf(quiet), /^No new feedback in 1 s\./, textOf(quiet));
});
