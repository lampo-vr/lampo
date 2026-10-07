// What kind of agent is on the other end: named once here for the server (from an MCP client's name, `lampo`'s
// environment) and the UI (the label and the mark next to an agent, web/src/ui/agentMarks.ts). Browser-safe: no Node
// imports.
import type { AgentKind, AssignedSession } from './types.ts';

export const AGENT_KINDS: readonly AgentKind[] = [
  'claude-code',
  'codex',
  'cursor',
  'claude',
  'chatgpt',
  'gemini',
  'vscode',
  'antigravity',
  'windsurf',
  'zed',
  'mcp',
  'api',
  'cli',
];

export const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  vscode: 'VS Code',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  zed: 'Zed',
  mcp: 'MCP client',
  api: 'API',
  cli: 'lampo',
};

/**
 * An agent's name as people read it. An MCP client over HTTP is named by its own id ("claude-code · Mia",
 * "codex-mcp-client"): that id reads as its kind's name ("Claude Code · Mia", "Codex"). A name someone gave (a Claude
 * Code session's, `--by agent:promo-edit`) stays as it is, and so does one whose kind is only "an MCP client".
 */
export function agentShown(name: string, kind?: AgentKind | null): string {
  const [head = '', ...rest] = name.split(' · ');
  const k = kind ?? agentKindOf(head);
  const id = /^[a-z0-9][a-z0-9._-]*$/.test(head);
  if (!id || ['mcp', 'cli', 'api'].includes(k) || agentKindOf(head) !== k) return name;
  return [AGENT_KIND_LABELS[k], ...rest].join(' · ');
}

/** An MCP client's own name (`clientInfo.name`, "codex-mcp-client", "claude-ai", "Cursor", "Visual Studio Code" …) → its kind. */
export function agentKindOf(client: string | null | undefined): AgentKind {
  const c = (client || '').toLowerCase();
  if (/claude[\s-]?code/.test(c)) return 'claude-code';
  if (c.includes('codex')) return 'codex';
  if (c.includes('cursor')) return 'cursor';
  if (/chatgpt|openai/.test(c)) return 'chatgpt';
  if (c.includes('antigravity')) return 'antigravity';
  if (c.includes('gemini')) return 'gemini';
  if (/visual studio code|vs ?code|copilot/.test(c)) return 'vscode';
  if (/windsurf|codeium/.test(c)) return 'windsurf';
  if (/\bzed\b/.test(c)) return 'zed';
  if (c.includes('claude')) return 'claude';
  return 'mcp';
}

/**
 * The kind of the agent a video is assigned to. Assignments made before kinds were stored: MCP clients have `mcp-…` ids
 * and their client's name (server/routes/mcp.ts); everything else was a Claude Code session (found on the machine, or
 * `lampo watch` from inside one).
 */
export function agentKindOfRef(ref: Pick<AssignedSession, 'name' | 'id' | 'agent'>): AgentKind {
  if (ref.agent) return ref.agent;
  if (ref.id?.startsWith('mcp-')) return agentKindOf(ref.name);
  return 'claude-code';
}
