// `lampo mcp config <client>` and the snippets Settings shows: every client × setup produces a config its client can
// parse (JSON, or TOML for Codex, checked with Python's tomllib when available), with the right URL and token wiring,
// under the key lampo, starting bin/lampo-mcp and reading the token from $LAMPO_TOKEN — and a setup under the earlier
// key video-review (or with bin/vr-mcp, $VR_TOKEN) is still one Lampo serves.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { CLIENT_LABELS, MCP_CLIENTS, MCP_NAME, type McpSnippet, type McpTarget, mcpSnippet } from '../../lib/mcpConfig.ts';
import { isolatedEnv, ROOT, VR, vr } from '../lib/helpers.ts';

const LAMPO = path.join(ROOT, 'bin/lampo');

const { env } = isolatedEnv();

const targets: Record<string, McpTarget> = {
  stdio: { kind: 'stdio', command: '/opt/video review/bin/lampo-mcp' },
  local: { kind: 'http', url: 'http://localhost:4747/mcp' },
  hosted: { kind: 'http', url: 'https://review.example.com/mcp', tokenEnv: 'LAMPO_TOKEN' },
  literal: { kind: 'http', url: 'https://review.example.com/mcp', token: 'vr_secret123' },
};

/** The server's key in a snippet, read the way its client reads it. */
function keyOf(s: McpSnippet): string | undefined {
  if (s.language === 'shell') return /^claude mcp add (?:--transport http )?(\S+) /.exec(s.text)?.[1];
  if (s.language === 'toml') return /^\[mcp_servers\.([^\]]+)\]$/m.exec(s.text)?.[1];
  const j = JSON.parse(s.text) as Record<string, Record<string, unknown>>;
  const keys = Object.keys(j.mcpServers ?? j.servers ?? j.context_servers ?? {});
  return keys.length === 1 ? keys[0] : undefined;
}

let python = true;
function parseToml(text: string): unknown {
  try {
    return JSON.parse(
      execFileSync('python3', ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8' }),
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') python = false;
    else throw e;
    return null;
  }
}

test('every client × setup parses and wires URL and token the way that client expects', () => {
  for (const client of MCP_CLIENTS)
    for (const [kind, target] of Object.entries(targets)) {
      const s = mcpSnippet(client, target);
      const what = `${client}/${kind}`;
      assert.equal(s.label, CLIENT_LABELS[client]);
      if (s.language === 'json') assert.doesNotThrow(() => JSON.parse(s.text), what);
      if (s.language === 'toml') {
        const t = parseToml(s.text) as { mcp_servers?: Record<string, Record<string, unknown>> } | null;
        if (t) {
          const server = t.mcp_servers?.lampo;
          assert.ok(server, what);
          assert.equal(server.tool_timeout_sec, 330, 'room for wait_for_feedback');
          if (kind === 'hosted') assert.equal(server.bearer_token_env_var, 'LAMPO_TOKEN');
          if (kind === 'literal') assert.deepEqual(server.http_headers, { Authorization: 'Bearer vr_secret123' });
        }
      }
      if (target.kind === 'http') assert.ok(s.text.includes(target.url), `${what} has the URL`);
      if (kind === 'stdio') assert.ok(s.text.includes('bin/lampo-mcp'), what);
      if (kind === 'local') assert.ok(!/Authorization/.test(s.text), `${what}: loopback needs no token`);
      if (kind === 'literal') assert.ok(s.text.includes('vr_secret123'), what);
    }
  assert.match(mcpSnippet('claude', targets.stdio).text, /^claude mcp add lampo -- '\/opt\/video review\/bin\/lampo-mcp'$/, 'paths with spaces are quoted');
  assert.equal(mcpSnippet('claude', targets.local).text, 'claude mcp add --transport http lampo http://localhost:4747/mcp');
  assert.match(
    mcpSnippet('claude', targets.hosted).text,
    /--transport http lampo https:\/\/review\.example\.com\/mcp --header "Authorization: Bearer \$LAMPO_TOKEN"/,
  );
  assert.match(mcpSnippet('cursor', targets.hosted).text, /"Authorization": "Bearer \$\{env:LAMPO_TOKEN\}"/);
  assert.match(mcpSnippet('vscode', targets.hosted).text, /\$\{input:lampo-token\}[\s\S]*"password": true/);
  // a variable the person already has keeps working when named
  assert.match(
    mcpSnippet('cursor', { kind: 'http', url: 'https://review.example.com/mcp', tokenEnv: 'VR_TOKEN' }).text,
    /"Authorization": "Bearer \$\{env:VR_TOKEN\}"/,
  );
  assert.match(mcpSnippet('gemini', targets.hosted).text, /"httpUrl": "https:\/\/review\.example\.com\/mcp"/);
  // Windsurf is Devin Desktop: its file moved and remote servers take `url`, not `serverUrl`.
  const windsurf = mcpSnippet('windsurf', targets.hosted);
  assert.equal(windsurf.where, '~/.config/devin/mcp_config.json (Cascade panel ⋯ → Open MCP config file)');
  assert.deepEqual(JSON.parse(windsurf.text).mcpServers.lampo, {
    url: 'https://review.example.com/mcp',
    headers: { Authorization: `Bearer \${env:LAMPO_TOKEN}` },
  });
  assert.doesNotMatch(windsurf.text, /serverUrl/);
  // Antigravity has a file of its own and takes a remote server's address only as `serverUrl`; it reads no variables in
  // headers, so a token goes in as a value
  const antigravity = mcpSnippet('antigravity', targets.hosted);
  assert.equal(antigravity.where, '~/.gemini/config/mcp_config.json (or .agents/mcp_config.json in a project)');
  assert.deepEqual(JSON.parse(antigravity.text).mcpServers.lampo, {
    serverUrl: 'https://review.example.com/mcp',
    headers: { Authorization: 'Bearer <your API token>' },
  });
  assert.doesNotMatch(antigravity.text, /"(url|httpUrl)"/);
  assert.deepEqual(JSON.parse(mcpSnippet('antigravity', { kind: 'http', url: 'https://app.example.com/mcp' }).text).mcpServers.lampo, {
    serverUrl: 'https://app.example.com/mcp',
  });
  assert.match(mcpSnippet('zed', targets.hosted).text, /"context_servers"[\s\S]*<your API token>/);
  // Zed stops a tool call after 60 s; wait_for_feedback may take 300.
  for (const kind of Object.keys(targets)) assert.equal(JSON.parse(mcpSnippet('zed', targets[kind]).text).context_servers.lampo.timeout, 330, `zed/${kind}`);
  if (!python) console.log('# tomllib not available: Codex TOML checked by shape only');
});

test('every client, every setup: the server is keyed lampo, or the name asked for', () => {
  assert.equal(MCP_NAME, 'lampo');
  for (const client of MCP_CLIENTS)
    for (const [kind, target] of Object.entries(targets)) {
      assert.equal(keyOf(mcpSnippet(client, target)), 'lampo', `${client}/${kind}`);
      assert.equal(keyOf(mcpSnippet(client, target, 'video-review')), 'video-review', `${client}/${kind} under the earlier key`);
    }
});

test('lampo mcp config: stdio here, the local app over HTTP, or a hosted server from the environment', () => {
  const stdio = vr(['mcp', 'config', 'cursor'], env);
  assert.equal(stdio.code, 0, stdio.err);
  assert.equal(JSON.parse(stdio.out).mcpServers.lampo.command, path.join(ROOT, 'bin', 'lampo-mcp'));
  const lampo = spawnSync(process.execPath, [LAMPO, 'mcp', 'config', 'cursor'], { env, encoding: 'utf8' });
  assert.equal(lampo.stdout, stdio.out, 'the same config whichever name ran it');

  const local = vr(['mcp', 'config', 'vscode', '--http'], env);
  assert.deepEqual(JSON.parse(local.out).servers.lampo, { type: 'http', url: 'http://localhost:4747/mcp' });
  assert.equal(vr(['mcp', 'config', 'claude', '--http'], env).out.trim(), 'claude mcp add --transport http lampo http://localhost:4747/mcp');

  const hostedEnv = { ...env, VR_SERVER: 'https://review.example.com/', VR_TOKEN: 'vr_fromenv' };
  const codex = vr(['mcp', 'config', 'codex'], hostedEnv);
  assert.match(codex.out, /url = "https:\/\/review\.example\.com\/mcp"\nbearer_token_env_var = "LAMPO_TOKEN"/);
  assert.match(vr(['mcp', 'config', 'codex', '--token-env', 'VR_TOKEN'], hostedEnv).out, /bearer_token_env_var = "VR_TOKEN"/);
  assert.ok(!codex.out.includes('vr_fromenv'), 'the token stays out unless asked for');
  assert.match(vr(['mcp', 'config', 'codex', '--with-token'], hostedEnv).out, /http_headers = \{ "Authorization" = "Bearer vr_fromenv" \}/);
  // AGENT-12: a command line with the token in it lands in the shell's history; saying so costs a line on stderr.
  // (spawnSync: the stderr of a command that succeeds)
  const both = (args: string[]) => spawnSync(process.execPath, [VR, ...args], { env: hostedEnv, encoding: 'utf8' });
  const shell = both(['mcp', 'config', 'claude', '--with-token']);
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(shell.stdout, /--header "Authorization: Bearer vr_fromenv"/);
  assert.match(shell.stderr, /warning: this command holds your token.*history/);
  assert.ok(!shell.stderr.includes('vr_fromenv'), 'the warning does not repeat it');
  assert.match(shell.stderr, /use \$LAMPO_TOKEN instead/);
  assert.doesNotMatch(both(['mcp', 'config', 'claude']).stderr, /warning/, 'with $LAMPO_TOKEN there is nothing to warn about');
  assert.doesNotMatch(both(['mcp', 'config', 'codex', '--with-token']).stderr, /warning/, 'a file is no shell history');

  const list = vr(['mcp', 'config'], env);
  for (const c of MCP_CLIENTS) assert.ok(list.out.includes(c), c);
  assert.match(list.out, /^lampo mcp config <client> .*--name lampo\]/, 'the usage names the command and the default key');
  assert.equal(vr(['mcp', 'config', 'notepad'], env).code, 1);
});

test('lampo mcp config for every client prints the key lampo', () => {
  for (const client of MCP_CLIENTS) {
    const r = vr(['mcp', 'config', client, '--json'], env);
    assert.equal(r.code, 0, `${client}: ${r.err}`);
    assert.equal(keyOf(JSON.parse(r.out) as McpSnippet), 'lampo', client);
  }
});

test('a setup under the earlier key video-review is still served: --name prints one, and nothing about Lampo depends on it', async () => {
  // The key lives in the client's config only; the client never sends it, so the server can't tell the two apart.
  const old = vr(['mcp', 'config', 'claude', '--stdio', '--name', 'video-review'], env);
  assert.equal(old.code, 0, old.err);
  assert.match(old.out, /^claude mcp add video-review -- \S*bin\/lampo-mcp/);
  const codex = vr(['mcp', 'config', 'codex', '--name', 'video-review'], env);
  assert.match(codex.out, /^\[mcp_servers\.video-review\]\ncommand = /);
  // Claude Code names an MCP tool mcp__<key>__<tool>: the live agent monitor reads Lampo's tools under either key.
  const { toolStep } = await import('../../lib/runStream.ts');
  for (const key of ['lampo', 'video-review']) assert.equal(toolStep(`mcp__${key}__get_note`, { id: 'c_7f3a01' }, '/work').text, 'Reading note c_7f3a01', key);
});
