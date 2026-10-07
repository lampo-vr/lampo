// An agent's heartbeat (POST /api/agents/heartbeat, what `vr watch` sends) speaks for the account that posts it only:
// another member can't post under someone's agent's session id (it would read as listening for good) nor list an agent
// under someone else's name alone — a heartbeat's name carries whose it is, like everything posted under an agent's.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, until } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const { base, request } = await startApp({ headers: { Host: 'review.test' } });
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const alex = await auth.createUser({ email: 'alex@example.com', name: 'Alex', password: 'a long password', role: 'member' });
const mallory = await auth.createUser({ email: 'mallory@example.com', name: 'Mallory', password: 'a long password', role: 'member' });
const alexTok = auth.createToken(alex.id, 'alex agent').token;
const asAlex = { Authorization: `Bearer ${alexTok}` };
const asMallory = { Authorization: `Bearer ${auth.createToken(mallory.id, 'm').token}` };
type Listed = { name: string; session_id: string; state?: string; user?: string | null };
const agents = async () => (await request('GET', '/api/agents', { headers: asMallory })).json().agents as Listed[];

test('another member’s heartbeat under someone’s agent is refused, and that agent stays as it was', async () => {
  const c = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { ...asAlex, Host: 'review.test' } } }));
  clients.push(c);
  await c.listTools();
  const theirs = await until(async () => (await agents()).find((a) => a.name === 'claude-code · Alex'), 'Alex’s agent is listed');
  assert.equal(theirs.state, 'idle', 'it never waited');
  const hb = await request('POST', '/api/agents/heartbeat', { body: { session_id: theirs.session_id, name: 'claude-code · Alex' }, headers: asMallory });
  assert.equal(hb.status, 400, `an MCP agent’s id is the MCP server’s own: ${hb.text}`);
  // spelled so the registry reads the same id (a leading space, a zero-width character, another case): refused too
  for (const spelled of [` ${theirs.session_id}`, `\u200b${theirs.session_id}`, theirs.session_id.toUpperCase()]) {
    const r = await request('POST', '/api/agents/heartbeat', { body: { session_id: spelled, name: 'claude-code' }, headers: asMallory });
    assert.equal(r.status, 400, `${JSON.stringify(spelled)}: ${r.text}`);
  }
  // and after the agent was quiet for longer than a heartbeat lives: still never anyone else's
  const real = Date.now;
  Date.now = () => real() + 100_000;
  try {
    const later = await request('POST', '/api/agents/heartbeat', { body: { session_id: ` ${theirs.session_id}`, name: 'claude-code' }, headers: asMallory });
    assert.equal(later.status, 400, later.text);
    await c.callTool({ name: 'list_videos', arguments: {} });
    const back = await until(async () => (await agents()).find((a) => a.session_id === theirs.session_id), 'Alex’s agent is listed again');
    assert.equal(back.user, 'Alex', 'its own calls list it as Alex’s');
  } finally {
    Date.now = real;
  }
  const now = (await agents()).find((a) => a.session_id === theirs.session_id);
  assert.equal(now?.state, 'idle', 'not listening');
  assert.equal(now?.user, 'Alex');
});

test('a session id another account’s heartbeat holds is theirs while it is listed', async () => {
  assert.equal((await request('POST', '/api/agents/heartbeat', { body: { session_id: 'sess-alex-1', name: 'claude' }, headers: asAlex })).status, 200);
  const taken = await request('POST', '/api/agents/heartbeat', { body: { session_id: 'sess-alex-1', name: 'claude' }, headers: asMallory });
  assert.equal(taken.status, 409, taken.text);
  const listed = (await agents()).find((a) => a.session_id === 'sess-alex-1');
  assert.equal(listed?.name, 'claude · Alex');
  assert.equal(listed?.user, 'Alex');
  assert.equal(
    (await request('POST', '/api/agents/heartbeat', { body: { session_id: 'sess-alex-1', name: 'claude' }, headers: asAlex })).status,
    200,
    'its own',
  );
});

test('a heartbeat named after someone else lists with whose it really is', async () => {
  const r = await request('POST', '/api/agents/heartbeat', { body: { session_id: 'mallory-own-1', name: 'claude-code · Alex' }, headers: asMallory });
  assert.equal(r.status, 200, r.text);
  const listed = (await agents()).find((a) => a.session_id === 'mallory-own-1');
  assert.equal(listed?.name, 'claude-code · Alex · Mallory');
  assert.equal((await agents()).filter((a) => a.name === 'claude-code · Alex').length, 1, 'one agent under Alex’s name: Alex’s own');
});
