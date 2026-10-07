// Whether a video's agent hears new notes by itself, and what the person does when it doesn't. An agent connected over
// MCP (Claude Code, Codex …) acts only when prompted: it hears notes while it waits in wait_for_feedback — the server
// knows that from its open waits (server/agents.ts) — and one command starts it: the server's `watch` prompt, which
// Claude Code shows as /lampo:watch. A Claude Code session on this machine is told apart by Lampo itself (Wake.tsx).
import { useEffect, useRef } from 'react';
import { agentKindOfRef } from '../../../lib/agentKind.ts';
import { MCP_NAME } from '../../../lib/brand.ts';
import type { AgentListenState } from '../../../lib/types.ts';
import { useAgents } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import type { SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { usePainted } from '../lib/lazy.ts';
import { copyText, toast } from '../lib/toast.ts';
import { IconButton } from '../ui/primitives.tsx';

/** Claude Code lists the server's `watch` prompt as this command (typing /mcp__lampo__watch runs it too). */
export const WATCH_COMMAND = `/${MCP_NAME}:watch`;
/** What any other agent is told instead: "use Lampo", the whole loop in a sentence (agent-facing, so in English). */
export const WATCH_WORDS = 'Use Lampo: work my notes, then keep listening until I approve or say stop.';

/** A connected agent's state, or `offline` when it isn't connected now; null where Lampo can't tell. */
export type Listen = AgentListenState | 'offline';

/**
 * Where the assigned agent stands, live: from the connected agents (refetched when one changes, server/agents.ts), else
 * from what the video's summary said. Null for no agent, or one Lampo can't see into (a Claude Code session here).
 */
export function useListening(session: SessionRef | null, summary?: { active: boolean | null; listening?: boolean | null }): Listen | null {
  const hosted = useInfo()?.features.sessions === 'agents';
  const knowable = !!session && (hosted || !!session.id?.startsWith('mcp-'));
  // asked after the first paint (the summary's word stands until then)
  const agents = useAgents(30_000, usePainted(knowable) && knowable).data?.agents;
  if (!session || !knowable) return null;
  if (!agents) return summary?.listening ? 'listening' : summary?.active ? 'working' : summary?.listening === false ? 'idle' : null;
  const a = agents.find((x) => !!session.id && x.session_id === session.id) ?? agents.find((x) => x.name === session.name);
  if (!a) return 'offline';
  // an older server lists only agents that follow the notes (`vr watch`)
  return a.state ?? 'listening';
}

/** The status line for an agent's state. */
export function listenLine(state: Listen): string {
  if (state === 'listening') return t('Listening: new notes reach it right away');
  if (state === 'working') return t('Working on its notes: it listens again when it’s done');
  if (state === 'idle') return t('Connected, not listening: new notes wait until you start it');
  return t('Not connected: new notes wait until you start it');
}

/** Whether new notes wait for the person to start the agent. */
export const waitsForStart = (state: Listen | null): boolean => state === 'idle' || state === 'offline';

/** What starts it: the command in Claude Code, a sentence for any other agent. */
export function startWith(session: SessionRef): { claude: boolean; text: string } {
  const claude = agentKindOfRef(session) === 'claude-code';
  // A Claude Code session that followed with `vr watch` (not an MCP connection) listens again by running it.
  if (claude && session.id && !session.id.startsWith('mcp-')) return { claude, text: 'vr watch' };
  return { claude, text: claude ? WATCH_COMMAND : WATCH_WORDS };
}

/** One line and the command (or sentence) to copy: how to set the agent to work and keep it listening. */
export function StartListening({ session }: { session: SessionRef }) {
  const how = startWith(session);
  return (
    <div className="listen-how" data-testid="listen-how">
      <span className="listen-how-line">{how.claude ? t('To start it, type this in Claude Code:') : t('To start it, tell it:')}</span>
      <span className="listen-how-row">
        <code className={`listen-how-text${how.claude ? ' cmd' : ''}`}>{how.text}</code>
        <IconButton
          className="btn sm ghost icon-only"
          label={t('Copy')}
          icon="copy"
          size={14}
          onClick={async () => {
            if (await copyText(how.text)) toast(t('Copied: paste it into {name}', { name: session.name }), 'ok');
          }}
        />
      </span>
    </div>
  );
}

/** Videos this page already said it for: once is enough (the agent menu keeps saying it). */
const nudged = new Set<string>();

/**
 * When a note arrives on a video whose agent doesn't listen, one toast says how to start it — once per video and page.
 * `open`: the video's open notes now (a new note raises it, whichever way it came: the composer, drafts, Auto-check).
 */
export function useListenNudge(slug: string, session: SessionRef | null, state: Listen | null, open: number, enabled: boolean): void {
  const seen = useRef<{ slug: string; open: number } | null>(null);
  useEffect(() => {
    const last = seen.current;
    seen.current = { slug, open };
    if (!enabled || !session || !waitsForStart(state) || !last || last.slug !== slug || open <= last.open || nudged.has(slug)) return;
    nudged.add(slug);
    const how = startWith(session);
    toast(
      how.claude
        ? t('{name} isn’t listening: it gets your notes once you type {cmd} in Claude Code.', { name: session.name, cmd: how.text })
        : t('{name} isn’t listening: it gets your notes once you tell it to work on them.', { name: session.name }),
      'info',
      { label: t('Copy'), onClick: () => void copyText(how.text) },
      { duration: 12_000 },
    );
  }, [slug, open, state, enabled, session]);
}
