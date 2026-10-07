// Ready-to-paste MCP setups for the agents people use. `lampo mcp config <client>` prints them and Settings → API tokens
// shows the same, so there is one source. Formats follow each client's documentation (October 2026). Shared with
// the browser: no Node imports.

import { BRAND_NAME, MCP_NAME } from './brand.ts';

// The key people give the server (lib/brand.ts, where the first paint can read it without the setups below).
export { MCP_NAME };

/**
 * What a person tells their agent once it is connected, any agent in any client: "use Lampo" is the whole loop (the
 * server's instructions, mcp/loop.ts) — it finds or names the project, puts up V1, works the notes and keeps waiting
 * for the next ones until the person approves. Agent-facing, so in English. No project yet: the one it works in.
 */
export const lampoFor = (project?: string | null): string =>
  project ? `Use ${BRAND_NAME} for "${project.replace(/["\n]/g, ' ').trim()}"` : `Use ${BRAND_NAME} for this project`;

export const MCP_CLIENTS = ['claude', 'codex', 'cursor', 'vscode', 'antigravity', 'windsurf', 'gemini', 'zed', 'json'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const CLIENT_LABELS: Record<McpClient, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  gemini: 'Gemini CLI',
  zed: 'Zed',
  json: 'Other (JSON)',
};

/** How the agent reaches Lampo: the stdio server on this machine, or the HTTP endpoint (local or hosted). */
export type McpTarget =
  | { kind: 'stdio'; command: string }
  | {
      kind: 'http';
      url: string;
      /** Hosted servers need a token. `token` puts the value in the config; otherwise it is read from `tokenEnv`. */
      token?: string | null;
      tokenEnv?: string;
    };

export interface McpSnippet {
  client: McpClient;
  label: string;
  /** Where it goes (a file, or "terminal"). */
  where: string;
  language: 'shell' | 'toml' | 'json';
  text: string;
  note?: string;
}

/** The variable a setup reads the API token from, unless it is given another (`--token-env`). */
export const TOKEN_ENV = 'LAMPO_TOKEN';

/** The stdio server in a checkout at `root`: what a client starts (bin/vr-mcp is the same, for configs written before). */
export const stdioCommand = (root: string): string => `${root.replace(/\/+$/, '')}/bin/lampo-mcp`;

/** wait_for_feedback may wait up to 300 s; clients that cap tool calls (Codex and Zed: 60 s) get room for that. */
const TOOL_TIMEOUT_S = 330;

export function mcpSnippet(client: McpClient, target: McpTarget, name = MCP_NAME): McpSnippet {
  const label = CLIENT_LABELS[client];
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const envName = target.kind === 'http' ? target.tokenEnv || TOKEN_ENV : TOKEN_ENV;
  const secured = target.kind === 'http' && Boolean(target.token || target.tokenEnv);
  // The Authorization header in each client's own interpolation syntax (or the literal token when we have it).
  const bearer = (ref: string) => (target.kind === 'http' && target.token ? `Bearer ${target.token}` : `Bearer ${ref}`);
  const envNote =
    secured && !(target.kind === 'http' && target.token) ? `Set ${envName} to your API token (Settings → API tokens) before starting the client.` : undefined;

  switch (client) {
    case 'claude': {
      const text =
        target.kind === 'stdio'
          ? `claude mcp add ${name} -- ${shellQuote(target.command)}`
          : `claude mcp add --transport http ${name} ${target.url}${secured ? ` --header "Authorization: ${bearer(`$${envName}`)}"` : ''}`;
      return {
        client,
        label,
        where: 'terminal',
        language: 'shell',
        text,
        note: target.kind === 'http' && secured && !target.token ? `Your shell fills in $${envName} when you run it.` : undefined,
      };
    }
    case 'codex': {
      const lines = [`[mcp_servers.${tomlKey(name)}]`];
      if (target.kind === 'stdio') lines.push(`command = ${tomlString(target.command)}`);
      else {
        lines.push(`url = ${tomlString(target.url)}`);
        if (target.token) lines.push(`http_headers = { "Authorization" = ${tomlString(`Bearer ${target.token}`)} }`);
        else if (secured) lines.push(`bearer_token_env_var = ${tomlString(envName)}`);
      }
      lines.push(`tool_timeout_sec = ${TOOL_TIMEOUT_S}`);
      return { client, label, where: '~/.codex/config.toml', language: 'toml', text: lines.join('\n'), note: envNote };
    }
    case 'cursor': {
      const server =
        target.kind === 'stdio'
          ? { command: target.command }
          : { url: target.url, ...(secured ? { headers: { Authorization: bearer(`\${env:${envName}}`) } } : {}) };
      return {
        client,
        label,
        where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
        language: 'json',
        text: json({ mcpServers: { [name]: server } }),
        note: envNote,
      };
    }
    case 'vscode': {
      if (target.kind === 'stdio')
        return {
          client,
          label,
          where: '.vscode/mcp.json (or "MCP: Open User Configuration")',
          language: 'json',
          text: json({ servers: { [name]: { type: 'stdio', command: target.command } } }),
        };
      // VS Code's own input variable, not a JS template.
      const input = ['$', '{input:lampo-token}'].join('');
      const server = { type: 'http', url: target.url, ...(secured ? { headers: { Authorization: bearer(input) } } : {}) };
      const inputs = secured && !target.token ? [{ type: 'promptString', id: 'lampo-token', description: 'Lampo API token', password: true }] : undefined;
      return {
        client,
        label,
        where: '.vscode/mcp.json (or "MCP: Open User Configuration")',
        language: 'json',
        text: json({ servers: { [name]: server }, ...(inputs ? { inputs } : {}) }),
        note: inputs ? 'VS Code asks for the token once and keeps it in its secret storage.' : undefined,
      };
    }
    case 'antigravity': {
      // Antigravity keeps its servers in a file of its own. A remote one's address is `serverUrl`: it ignores `url` and
      // `httpUrl`. With a server that registers clients itself, as Lampo does, it signs in by itself; it documents no
      // variables in headers, so a token goes in as a value.
      const server =
        target.kind === 'stdio'
          ? { command: target.command }
          : {
              serverUrl: target.url,
              ...(secured ? { headers: { Authorization: target.token ? `Bearer ${target.token}` : 'Bearer <your API token>' } } : {}),
            };
      return {
        client,
        label,
        where: '~/.gemini/config/mcp_config.json (or .agents/mcp_config.json in a project)',
        language: 'json',
        text: json({ mcpServers: { [name]: server } }),
        note: secured && !target.token ? 'Replace <your API token> with a token from Settings → API tokens.' : undefined,
      };
    }
    case 'windsurf': {
      // Windsurf is Devin Desktop now: the file moved to ~/.config/devin/ and remote servers take `url` (no `serverUrl`).
      const server =
        target.kind === 'stdio'
          ? { command: target.command }
          : { url: target.url, ...(secured ? { headers: { Authorization: bearer(`\${env:${envName}}`) } } : {}) };
      return {
        client,
        label,
        where: '~/.config/devin/mcp_config.json (Cascade panel ⋯ → Open MCP config file)',
        language: 'json',
        text: json({ mcpServers: { [name]: server } }),
        note: envNote,
      };
    }
    case 'gemini': {
      const server =
        target.kind === 'stdio'
          ? { command: target.command }
          : { httpUrl: target.url, ...(secured ? { headers: { Authorization: bearer(`$${envName}`) } } : {}) };
      return { client, label, where: '~/.gemini/settings.json', language: 'json', text: json({ mcpServers: { [name]: server } }), note: envNote };
    }
    case 'zed': {
      // Zed documents no variable interpolation for context servers: the token goes in as a value. It stops a tool call
      // after 60 s unless the server's `timeout` says otherwise.
      const server =
        target.kind === 'stdio'
          ? { command: target.command, args: [], timeout: TOOL_TIMEOUT_S }
          : {
              url: target.url,
              ...(secured ? { headers: { Authorization: target.token ? `Bearer ${target.token}` : 'Bearer <your API token>' } } : {}),
              timeout: TOOL_TIMEOUT_S,
            };
      return {
        client,
        label,
        where: '~/.config/zed/settings.json (or .zed/settings.json in a project)',
        language: 'json',
        text: json({ context_servers: { [name]: server } }),
        note: secured && !target.token ? 'Replace <your API token> with a token from Settings → API tokens.' : undefined,
      };
    }
    default: {
      const server =
        target.kind === 'stdio'
          ? { command: target.command }
          : {
              type: 'http',
              url: target.url,
              ...(secured ? { headers: { Authorization: target.token ? `Bearer ${target.token}` : 'Bearer <your API token>' } } : {}),
            };
      return { client: 'json', label: CLIENT_LABELS.json, where: "the client's MCP config", language: 'json', text: json({ mcpServers: { [name]: server } }) };
    }
  }
}

export const isMcpClient = (x: unknown): x is McpClient => (MCP_CLIENTS as readonly unknown[]).includes(x);

const shellQuote = (s: string) => (/^[\w./@:+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const tomlString = (s: string) => JSON.stringify(s);
const tomlKey = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s));
