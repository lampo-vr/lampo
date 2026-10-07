// covers: server/routes/mcp.ts mcp/feedback.ts mcp/tools/read.ts mcp/core.ts server/agents.ts lib/sessions.ts server/helpers.ts
// Assign a video to an agent connected over /mcp, write notes, and the agent hears of them: end to end on a hosted
// server, the way Claude Code connects (an OAuth app that names itself "claude-code"), with a long-lived store's shapes —
// another store's history inside events.jsonl, a second workspace made after the agent connected, notes written while
// the agent wasn't listening. And what the app shows: whether the agent listens, from its open waits.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, sleep, until } from '../lib/helpers.ts';
import { cookieFrom, type Reply, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const oauth = await import('../../lib/oauth/store.ts');
const store = await import('../../lib/store.ts');
const { LISTEN_TIMES } = await import('../../server/agents.ts');
const { inWorkspace } = await import('../../lib/scope.ts');

const { base, request } = await startApp({ feed: 50, headers: { Host: 'review.test' } });
const PASSWORD = 'a long password';
const origin = { Origin: PUBLIC };
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

const cookie = (r: Reply) =>
  [r.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .find((c) => c.startsWith('vr_session=')) || cookieFrom(r);
const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: PASSWORD, role: 'owner' });
const login = await request('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: PASSWORD }, headers: origin });
assert.equal(login.status, 200, login.text);
let person = { Cookie: cookie(login), ...origin };

// Another store's history, as an earlier version's import appended it to the log itself (hundreds of lines).
const history = Array.from({ length: 600 }, (_, i) =>
  JSON.stringify({
    at: new Date(Date.parse('2026-09-27T20:48:08Z') + i * 60_000).toISOString().replace('.000Z', '+00:00'),
    type: i % 3 ? 'comment' : 'status',
    by: 'Olivia',
    video: '/@uploads/Old/film.mp4',
    slug: '__@uploads__Old__film.mp4',
    session: 'old-session',
    id: `c_${(0x100000 + i).toString(16)}`,
    text: 'from before the move',
    imported: 'b_9770fbdd81bbbfeb',
  }),
);
fs.mkdirSync(path.dirname(store.eventsFile()), { recursive: true });
fs.appendFileSync(store.eventsFile(), `${history.join('\n')}\n`);

const setupToken = auth.createToken(owner.id, 'setup').token;
async function upload(name: string): Promise<string> {
  const clip = makeVideo(path.join(dir, `in/${name}`), { dur: 1 });
  age(clip);
  const up = await tusUpload(request, clip, { filename: name, folder: 'Reels' }, { Authorization: `Bearer ${setupToken}` });
  assert.equal(up.status, 200, up.text);
  return up.json().slug as string;
}

/** An app connected through OAuth, as Claude Code connects: its access token. */
function appToken(name = 'Claude Code'): string {
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
    code: oauth.createCode(asked, owner),
    client_id,
    redirect_uri: 'http://127.0.0.1:9/cb',
    code_verifier: verifier,
    resource: `${PUBLIC}/mcp`,
  }).access_token;
}

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: Result) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** An MCP client over HTTP that names itself `name`, as Claude Code names itself "claude-code". */
async function agent(name: string): Promise<Client> {
  const c = new Client({ name, version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appToken()}`, Host: 'review.test' } } }),
  );
  clients.push(c);
  await c.listTools();
  return c;
}

interface Listed {
  name: string;
  sessionId: string;
  status: string;
}
/** The agent as the assign picker lists it. */
const listed = (name: string, slug = '') =>
  until(async () => {
    const r = await request('GET', `/api/sessions${slug ? `?video=${encodeURIComponent(slug)}` : ''}`, { headers: person });
    return (r.json().sessions as Listed[]).find((s) => s.name.startsWith(`${name} ·`));
  }, `${name} listed for assigning`);

/** …assigned to the video by the person, in the app. */
async function assign(slug: string, name: string): Promise<Listed> {
  const a = await listed(name, slug);
  const r = await request('PUT', `/api/review/${encodeURIComponent(slug)}/session`, {
    body: { name: a.name, sessionId: a.sessionId, agent: 'claude-code' },
    headers: person,
  });
  assert.equal(r.status, 200, r.text);
  return a;
}

async function note(slug: string, frame: number, text: string) {
  const r = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame, text, severity: 'should' }, headers: person });
  assert.equal(r.status, 200, r.text);
  return r.json() as { id: string };
}

/** The video as the player gets it: its agent's state. */
const summaryOf = async (slug: string) =>
  (await request('GET', `/api/review/${encodeURIComponent(slug)}`, { headers: person })).json().summary as {
    sessionActive: boolean | null;
    sessionListening?: boolean | null;
    stage: { next: { kind: string } };
  };

test('a listening agent hears a note on its video at once, past another store’s history in the log', async () => {
  const slug = await upload('reel-a.mp4');
  const c = await agent('agent-a');
  await assign(slug, 'agent-a');
  const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 20 } }) as Promise<Result>;
  await until(async () => (await listed('agent-a')).status === 'listening', 'listening');
  const t = Date.now();
  const n = await note(slug, 5, 'The title sits under the top bar');
  const got = await waiting;
  assert.match(textOf(got), new RegExp(n.id), textOf(got));
  assert.ok(Date.now() - t < 5000, `delivered in ${Date.now() - t} ms`);
});

test('a second workspace made after the agent connected changes nothing for it', async () => {
  const slug = await upload('reel-b.mp4');
  const c = await agent('agent-b');
  await assign(slug, 'agent-b');
  const made = await request('POST', '/api/workspaces', { body: { name: 'Second' }, headers: person });
  assert.equal(made.status, 200, made.text);
  // The person's session moved into the new workspace (as in the app): back to the first one to write.
  const back = await request('POST', '/api/workspaces/switch', { body: { id: 'w1' }, headers: person });
  assert.equal(back.status, 200, back.text);
  person = { ...person, Cookie: cookie(back) || person.Cookie };
  const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 20 } }) as Promise<Result>;
  await until(async () => (await listed('agent-b')).status === 'listening', 'listening');
  const n = await note(slug, 6, 'Colour pops too much');
  assert.match(textOf(await waiting), new RegExp(n.id));
});

test('notes written while the agent wasn’t listening reach it when it starts to, once', async () => {
  const slug = await upload('reel-c.mp4');
  const c = await agent('agent-c');
  await assign(slug, 'agent-c');
  await note(slug, 2, 'One');
  await note(slug, 3, 'Two');
  // "Work on my Lampo notes": what is assigned to it (over HTTP "me" is the connection's agent)…
  const mine = (await c.callTool({ name: 'list_videos', arguments: { session: 'me' } })) as Result;
  assert.ok(!mine.isError, textOf(mine));
  assert.match(textOf(mine), /reel-c\.mp4/);
  assert.doesNotMatch(textOf(mine), /reel-a\.mp4|reel-b\.mp4/, 'only its own videos');
  // …and "listen for my notes" starts with what already waits for it, at once.
  const t = Date.now();
  const first = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 10 } })) as Result;
  assert.ok(Date.now() - t < 5000, `answered in ${Date.now() - t} ms: ${textOf(first)}`);
  assert.match(textOf(first), /^Waiting for you/);
  assert.match(textOf(first), /video: \/@uploads\/Reels\/reel-c\.mp4 · 2 open notes/);
  assert.match(textOf(first), /cursor: \S+/);
  // Told once: the next wait without a cursor waits (an agent that loops without one doesn't spin on the same notes).
  const again = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 1 } })) as Result;
  assert.match(textOf(again), /No new feedback in 1 s/);
  // A note after that is waiting for it again, and one it read with get_open_notes is not.
  await note(slug, 4, 'Three');
  assert.match(textOf((await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 5 } })) as Result), /3 open notes/);
  await note(slug, 5, 'Four');
  await c.callTool({ name: 'get_open_notes', arguments: { video: 'reel-c.mp4' } });
  assert.match(textOf((await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 1 } })) as Result), /No new feedback/);
});

test('a request made in the second the video was assigned reaches the agent’s first wait', async () => {
  const slug = await upload('reel-r.mp4');
  const c = await agent('agent-r');
  await assign(slug, 'agent-r');
  const asked = await request('POST', `/api/review/${encodeURIComponent(slug)}/request`, { body: { text: 'Check the logo first' }, headers: person });
  assert.equal(asked.status, 200, asked.text);
  // events have whole seconds: the request is logged in the second the assignment was made
  const assigned = inWorkspace('w1', () => store.loadReview(slug)?.session?.assigned) as string;
  const file = inWorkspace('w1', () => store.eventsFile());
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const i = lines.findLastIndex((l) => l.includes('"type":"request"') && l.includes('Check the logo first'));
  assert.ok(i >= 0 && assigned, 'the request and the assignment');
  lines[i] = JSON.stringify({ ...JSON.parse(lines[i] as string), at: new Date(Math.floor(Date.parse(assigned) / 1000) * 1000).toISOString() });
  fs.writeFileSync(file, lines.join('\n'));
  const first = (await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 5 } })) as Result;
  assert.match(textOf(first), /^Waiting for you/, textOf(first));
  assert.match(textOf(first), /1 request/, textOf(first));
  assert.match(textOf(first), /Check the logo first/);
});

test('the app shows whether the assigned agent listens: from its open waits, not from being connected', async () => {
  const was = { ...LISTEN_TIMES };
  LISTEN_TIMES.betweenMs = 1000;
  LISTEN_TIMES.workingMs = 1500;
  try {
    const slug = await upload('reel-d.mp4');
    const c = await agent('agent-d');
    await assign(slug, 'agent-d');
    await note(slug, 1, 'Before it listens');
    // Connected, not listening: the picker says so, and the video doesn't claim "an agent is on it".
    assert.equal((await listed('agent-d')).status, 'idle');
    let s = await summaryOf(slug);
    assert.equal(s.sessionListening, false);
    assert.equal(s.sessionActive, false);
    assert.equal(s.stage.next.kind, 'fix');
    const agents = (await request('GET', '/api/agents', { headers: person })).json().agents as { name: string; state?: string }[];
    assert.equal(agents.find((a) => a.name.startsWith('agent-d ·'))?.state, 'idle');
    // In wait_for_feedback: listening.
    await c.callTool({ name: 'get_open_notes', arguments: { video: 'reel-d.mp4' } });
    const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 20 } }) as Promise<Result>;
    await until(async () => (await summaryOf(slug)).sessionListening === true, 'the video says its agent listens');
    s = await summaryOf(slug);
    assert.equal(s.sessionActive, true);
    assert.equal(s.stage.next.kind, 'wait_agent');
    // It hands out a note: working on it, for a while; then, without another wait, idle again.
    await note(slug, 2, 'While it listens');
    await waiting;
    assert.equal((await listed('agent-d')).status, 'working');
    await until(async () => (await listed('agent-d')).status === 'idle', 'idle once it stopped waiting');
    assert.equal((await summaryOf(slug)).sessionListening, false);
    // A wait whose time ran out: still listening while the next one is called, idle when none comes.
    await c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 0 } });
    assert.equal((await listed('agent-d')).status, 'listening');
    await until(async () => (await listed('agent-d')).status === 'idle', 'idle after the pause between waits');
    // An agent connected over MCP that isn't connected now isn't listening either.
    const gone = await upload('reel-e.mp4');
    const r = await request('PUT', `/api/review/${encodeURIComponent(gone)}/session`, {
      body: { name: 'claude-code · Olivia', sessionId: 'mcp-000000000000', agent: 'claude-code' },
      headers: person,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal((await summaryOf(gone)).sessionListening, false);
  } finally {
    Object.assign(LISTEN_TIMES, was);
  }
});

test('the watch prompt sets an agent to work and keeps it listening, in one command', async () => {
  const c = await agent('agent-f');
  const { prompts } = await c.listPrompts();
  const watch = prompts.find((p) => p.name === 'watch');
  assert.ok(watch, JSON.stringify(prompts));
  const got = await c.getPrompt({ name: 'watch', arguments: {} });
  const promptText = (r: { messages: { content: unknown }[] }) => (r.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
  const text = promptText(got);
  assert.match(text, /list_videos\(\{session: "me"/);
  assert.match(text, /wait_for_feedback/);
  assert.match(text, /until I approve or say stop/);
  const one = await c.getPrompt({ name: 'watch', arguments: { video: 'reel-a.mp4' } });
  assert.match(promptText(one), /Only this video: reel-a\.mp4/);
  // The server's instructions tell the same loop, so "use Lampo" is enough without it: wait again after every answer.
  assert.match(c.getInstructions() ?? '', /wait_for_feedback with the cursor the last answer gave, and again after every answer/);
});

test('one log line per tool call: the agent, the tool, how long, how a wait ended — never what was said', async () => {
  const slug = await upload('reel-g.mp4');
  const c = await agent('agent-g');
  const a = await assign(slug, 'agent-g');
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('mcp: ')) lines.push(line);
    else log(...args);
  };
  try {
    const waiting = c.callTool({ name: 'wait_for_feedback', arguments: { timeout_s: 20 } }) as Promise<Result>;
    await until(async () => (await listed('agent-g')).status === 'listening', 'listening');
    await note(slug, 7, 'A secret word: marmalade');
    await waiting;
    await c.callTool({ name: 'get_open_notes', arguments: { video: 'reel-g.mp4' } });
    await c.callTool({ name: 'get_note', arguments: { id: 'c_000000' } });
    await sleep(50);
  } finally {
    console.log = log;
  }
  const mine = lines.filter((l) => l.includes(a.sessionId));
  assert.deepEqual(
    mine.map((l) => l.replace(/\d+\.\d\ds$/, 'Ns')),
    [
      `mcp: w1 ${a.sessionId} wait_for_feedback start timeout_s=20 first`,
      `mcp: w1 ${a.sessionId} wait_for_feedback 1 event Ns`,
      `mcp: w1 ${a.sessionId} get_open_notes ok Ns`,
      `mcp: w1 ${a.sessionId} get_note error Ns`,
    ],
  );
  assert.ok(!lines.join('\n').match(/marmalade|reel-g|Olivia/), lines.join('\n'));
});
