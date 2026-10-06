// Which agent: the one choice Connect an agent (settings/Mcp.tsx) and a fresh API token (settings/Tokens.tsx) share.
// Tiles wear each agent's mark (ui/agentMarks.ts); "Other client" opens the formats behind it, each with its mark too.
import { MCP_CLIENTS, type McpClient } from '../../../lib/mcpConfig.ts';
import type { AgentKind } from '../../../lib/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { AgentMark } from '../ui/icons.tsx';

export type AgentPick = 'claude-code' | 'codex' | 'cursor' | 'chatgpt' | 'claude' | 'other';

export const AGENT_TILES = perLang((): { id: AgentPick; label: string; mark: AgentKind; sub: string }[] => [
  { id: 'claude-code', label: 'Claude Code', mark: 'claude-code', sub: t('Terminal') },
  { id: 'codex', label: 'Codex', mark: 'codex', sub: t('Terminal or app') },
  { id: 'cursor', label: 'Cursor', mark: 'cursor', sub: t('Editor') },
  { id: 'chatgpt', label: 'ChatGPT', mark: 'chatgpt', sub: t('Chat app') },
  { id: 'claude', label: 'Claude', mark: 'claude', sub: t('Chat app') },
  { id: 'other', label: t('Other client'), mark: 'mcp', sub: t('VS Code, Zed and more') },
]);

/** The snippet formats behind "Other client", with the mark each one wears. */
export const OTHER_CLIENTS = MCP_CLIENTS.filter((c): c is Exclude<McpClient, 'claude' | 'codex' | 'cursor'> => !['claude', 'codex', 'cursor'].includes(c));
const OTHERS = perLang(
  (): Record<(typeof OTHER_CLIENTS)[number], { label: string; mark: AgentKind }> => ({
    vscode: { label: 'VS Code', mark: 'vscode' },
    antigravity: { label: 'Antigravity', mark: 'antigravity' },
    windsurf: { label: 'Windsurf', mark: 'windsurf' },
    gemini: { label: 'Gemini CLI', mark: 'gemini' },
    zed: { label: 'Zed', mark: 'zed' },
    json: { label: t('Any (JSON)'), mark: 'mcp' },
  }),
);

/** The config format for a pick that has one (the chat apps connect by address instead). */
export const clientOf = (pick: AgentPick, other: McpClient): McpClient =>
  pick === 'claude-code' ? 'claude' : pick === 'codex' || pick === 'cursor' ? pick : other;

/** The agents as tiles, one picked. `only` keeps those (a token can't connect a chat app: they sign in). */
export function AgentTiles({
  value,
  onChange,
  only,
  name,
  label,
}: {
  value: AgentPick;
  onChange: (pick: AgentPick) => void;
  only?: AgentPick[];
  /** The radio group's name, unique on the page. */
  name: string;
  label: string;
}) {
  const tiles = only ? AGENT_TILES().filter((x) => only.includes(x.id)) : AGENT_TILES();
  return (
    // the wrapper is what the columns measure: the panel the tiles stand in, not the window
    <div className="set-tiles-w">
      <fieldset className={`set-tiles n${tiles.length}`} data-testid="agent-tiles">
        <legend className="sr-only">{label}</legend>
        {tiles.map((x) => (
          <label key={x.id} className="set-tile">
            <input type="radio" name={name} value={x.id} className="sr-only" checked={value === x.id} onChange={() => onChange(x.id)} />
            <AgentMark kind={x.mark} size={18} />
            <b>{x.label}</b>
            <span>{x.sub}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** Behind "Other client": the formats as chips, each with its client's mark. */
export function OtherClients({ value, onChange, name }: { value: McpClient; onChange: (client: McpClient) => void; name: string }) {
  return (
    <fieldset className="set-chips" data-testid="agent-others">
      <legend className="sr-only">{t('MCP client')}</legend>
      {OTHER_CLIENTS.map((c) => (
        <label key={c} className="set-chip">
          <input type="radio" name={name} value={c} className="sr-only" checked={value === c} onChange={() => onChange(c)} />
          <AgentMark kind={OTHERS()[c].mark} size={14} />
          {OTHERS()[c].label}
        </label>
      ))}
    </fieldset>
  );
}
