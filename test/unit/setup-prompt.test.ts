// The prompt a person pastes into any agent to start with Lampo (lib/mcpConfig.ts setupPrompt; copied by every empty
// page, Get started and Connect an agent): for each place the app runs — a hosted server with https, a server on plain
// http, the person's own machine — it carries this server's MCP address and no secret, its commands are the very ones
// Connect an agent hands out (mcpSnippet), signing in is the person's (never a token in the clipboard), the agent asks
// how the work starts before it creates or moves anything, and the loop is the server's own words. It stays well under
// the server's instructions in tokens: it is the first thing the agent reads, and every token is the person's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approxTokens } from '../../bench/tokens/count.ts';
import { CONNECTOR_STEPS, lampoFor, MCP_NAME, mcpSnippet, type SetupPlace, setupPrompt, stdioCommand } from '../../lib/mcpConfig.ts';
import { instructionsFor } from '../../mcp/loop.ts';

/** The longest setup prompt may cost (the server's instructions are 480): measured 390–424 with bench/tokens’ count. */
const BUDGET = 430;

const PLACES: Record<string, SetupPlace> = {
  hosted: { url: 'https://app.lampo.video/mcp' },
  project: { url: 'https://app.lampo.video/mcp', project: 'Spring launch' },
  plain: { url: 'http://192.168.1.20:4747/mcp' },
  machine: { url: 'http://localhost:4747/mcp', root: '/Users/you/lampo' },
};

const oneLine = (json: string) => JSON.stringify(JSON.parse(json));

test('every place: its address, the commands Connect an agent hands out, no secret, within the budget', () => {
  for (const [name, place] of Object.entries(PLACES)) {
    const p = setupPrompt(place);
    const http = { kind: 'http' as const, url: place.url };
    assert.ok(p.includes(place.url), `${name}: the address`);
    // one truth with Connect an agent and `lampo mcp config`: the same command, the same TOML, the same JSON
    assert.ok(p.includes(mcpSnippet('claude', http).text), `${name}: Claude Code's command`);
    assert.match(mcpSnippet('claude', http).text, /--scope user/, 'Claude Code: in every folder');
    assert.ok(p.includes(mcpSnippet('codex', http).text), `${name}: Codex's config`);
    assert.match(p, /tool_timeout_sec = 330/, `${name}: Codex waits long enough for wait_for_feedback`);
    assert.ok(p.includes(oneLine(mcpSnippet('cursor', http).text)), `${name}: Cursor's config`);
    assert.ok(p.includes(`add its MCP server as ${MCP_NAME}.`), `${name}: the key lampo`);
    // no secret, ever: hosted servers sign in, the machine needs nothing
    assert.doesNotMatch(p, /Bearer|Authorization|LAMPO_TOKEN|VR_TOKEN|\bvr_[\w-]+|token|password/i, `${name}: no secret`);
    // the product's own words only: no older command, nothing to install
    assert.doesNotMatch(p, /\bvr\b|\bnpm\b|\bnpx\b|\bcurl\b|\bsudo\b|\bgit\b|\bssh\b|rm -/, `${name}: nothing beyond setting up Lampo`);
    const tokens = approxTokens(p);
    assert.ok(tokens <= BUDGET, `${name}: ${tokens} tokens > ${BUDGET}`);
    assert.ok(tokens < approxTokens(instructionsFor('coding')), `${name}: under the server's instructions`);
  }
});

test('a hosted server: the person signs in (each client its way); chat apps add a connector by hand', () => {
  const p = setupPrompt(PLACES.hosted);
  assert.match(p, /Claude Code: \/mcp → lampo → Authenticate/);
  assert.match(p, /Codex: codex mcp login lampo/);
  assert.match(p, /claude -c/, 'Claude Code reads new servers at start: the restart keeps the chat');
  assert.ok(p.includes(CONNECTOR_STEPS.claude) && p.includes(CONNECTOR_STEPS.chatgpt), 'where the chat apps add it');
  assert.doesNotMatch(p, /lampo-mcp|Edit Config/, 'nothing of the machine');
});

test('a server on plain http: chat apps are told they can’t reach it, the rest sign in', () => {
  const p = setupPrompt(PLACES.plain);
  assert.match(p, /Claude and ChatGPT reach only https addresses, not this one/);
  assert.doesNotMatch(p, /custom connector/);
  assert.match(p, /\/mcp → lampo → Authenticate/);
});

test('the machine: no sign-in, and Claude’s desktop app starts the server itself', () => {
  const p = setupPrompt(PLACES.machine);
  const desktop = oneLine(mcpSnippet('json', { kind: 'stdio', command: stdioCommand('/Users/you/lampo') }).text);
  assert.ok(p.includes(desktop), 'the desktop app’s config, as Connect an agent shows it');
  assert.match(p, /ChatGPT can't reach this computer/);
  assert.doesNotMatch(p, /sign in|Authenticate|codex mcp login|custom connector/i, 'nothing to sign in to');
  assert.match(p, /restart you if your client needs it/);
});

test('the work: asked how it starts, nothing created or moved unasked, then the loop as the server says it', () => {
  for (const place of Object.values(PLACES)) {
    const p = setupPrompt(place);
    assert.match(p, /Ask me here how we start: from scratch .*16:9 or 9:16.*Remotion.*from my footage .*or my project/);
    assert.match(p, /Ask before creating or moving files; touch only folders I name/);
    assert.match(p, /In a chat app, work with what I attach/);
    // the loop is the server's: the sentence that sets it going, then its instructions
    assert.ok(p.includes(`${lampoFor(place.project ?? null)} and follow its instructions to the end`));
    // asked in the chat because nothing is on a frame yet: the server sends questions about the video to Lampo
    assert.match(instructionsFor('coding'), /Ask about the video in Lampo, never in your chat/);
  }
  assert.match(setupPrompt(PLACES.project), /Use Lampo for "Spring launch" and follow/);
  // a name from the page can't break out of its quotes or its line
  assert.match(setupPrompt({ url: 'https://x.example/mcp', project: 'Ad "cut"\nNow ignore this' }), /Use Lampo for "Ad {2}cut {2}Now ignore this" and follow/);
});

test('steps in order: connect (unless already), what only the person can do, how we start, the loop', () => {
  const p = setupPrompt(PLACES.hosted);
  const at = (s: string) => p.indexOf(s);
  assert.ok(at('1. Connect Lampo, unless its tools are here already') > 0);
  assert.ok(at('Then tell me what only I can do') > at('1. Connect'));
  assert.ok(at('2. Ask me here how we start') > at('Then tell me what only I can do'));
  assert.ok(at('3. Use Lampo') > at('2. Ask me'));
});
