// `vr mcp config <client>`: a ready config that connects an agent (Claude Code, Codex, Cursor, VS Code, …) to
// Lampo over MCP. The config goes to stdout and the explanation to stderr, so it can be redirected into a file.
import path from 'node:path';
import { readCredentials } from './backend/credentials.ts';
import { loadConfig } from './config.ts';
import { CLIENT_LABELS, isMcpClient, MCP_CLIENTS, MCP_NAME, type McpTarget, mcpSnippet } from './mcpConfig.ts';
import { ROOT } from './paths.ts';

type Opts = Record<string, string | true | string[] | undefined>;

const usage = `vr mcp config <client> [--stdio | --http] [--url <server>] [--token-env NAME] [--with-token] [--name ${MCP_NAME}]
  clients: ${MCP_CLIENTS.join(', ')}
  --name: the server's key in the client's config (default ${MCP_NAME}; a setup under video-review keeps working).
  Local store: stdio by default (runs bin/vr-mcp); --http uses the running app at http://localhost:<port>/mcp.
  After vr login (or with --url): the server's /mcp endpoint with an API token from $VR_TOKEN (--with-token: the
  token of this vr login, written into the config).`;

export function mcpCommand({ pos, opt }: { pos: string[]; opt: Opts }): void {
  const [sub, client] = pos;
  if (sub !== 'config') throw new Error(usage);
  if (!client) {
    process.stdout.write(`${usage}\n\n${MCP_CLIENTS.map((c) => `  ${c.padEnd(9)} ${CLIENT_LABELS[c]}`).join('\n')}\n`);
    return;
  }
  if (!isMcpClient(client)) throw new Error(`unknown client "${client}" (${MCP_CLIENTS.join(', ')})`);
  const s = mcpSnippet(client, target(opt), typeof opt.name === 'string' ? opt.name : undefined);
  if (opt.json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${s.label} → ${s.where}${s.note ? `\n${s.note}` : ''}\n\n`);
  // A command with the token in it stays in the shell's history (a file config doesn't): say so, without repeating it.
  if (s.language === 'shell' && opt.with_token && s.text.includes('Bearer vr_'))
    process.stderr.write(
      'vr: warning: this command holds your token, and your shell keeps it in its history: leave out --with-token to use $VR_TOKEN instead, or clear that line from the history after running it\n\n',
    );
  process.stdout.write(`${s.text}\n`);
}

function target(opt: Opts): McpTarget {
  const creds = readCredentials();
  const url = typeof opt.url === 'string' ? opt.url.replace(/\/+$/, '') : null;
  const tokenEnv = typeof opt.token_env === 'string' ? opt.token_env : 'VR_TOKEN';
  if (opt.stdio) return { kind: 'stdio', command: path.join(ROOT, 'bin', 'vr-mcp') };
  if (url || creds) {
    const server = url || (creds?.server || '').replace(/\/+$/, '');
    const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(server);
    return {
      kind: 'http',
      url: `${server}/mcp`,
      token: opt.with_token && creds && !url ? creds.token : null,
      tokenEnv: local && !creds ? undefined : tokenEnv,
    };
  }
  if (opt.http) return { kind: 'http', url: `http://localhost:${loadConfig().port}/mcp` };
  return { kind: 'stdio', command: path.join(ROOT, 'bin', 'vr-mcp') };
}
