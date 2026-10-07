// The sidebar's Agents: one row per agent. The ones videos are assigned to, with their work in a word or two (needs you,
// failed … before working) or what they do now; and, for people who run agents, every agent connected right now, before
// it is on any video: "connected", then "waiting for your notes" while it sits in wait_for_feedback (server/agents.ts).
// It comes with Live.tsx after the first paint (the start's budget): the section is the sidebar's last, so nothing
// above it moves when it arrives. The row itself is the sidebar's (`Item`: its NavItem, handed in so this chunk never
// pulls the library's).
import { type ComponentType, type ReactElement, type ReactNode, useMemo } from 'react';
import { AGENT_KIND_LABELS, agentKindOf, agentKindOfRef } from '../../../lib/agentKind.ts';
import type { AgentKind, AgentListenState, ConnectedAgent } from '../../../lib/types.ts';
import { useAgents, useAuthStatus, useCan } from '../api/auth.ts';
import type { SessionRef, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { goView, type LibraryView } from '../lib/nav.ts';
import { AgentMark } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { say } from './activityWords.ts';
import { AgentNowDot, AgentNowText, NavNow } from './Live.tsx';
import { cardRun, fullWords, LOOK, mostUrgent, phaseOf, type RunLike, tightOf } from './runState.ts';
import { SessionHover } from './Sessions.tsx';

/** What the sidebar's row takes (library/Sidebar.tsx NavItem). */
export interface AgentRowProps {
  lead: ReactNode;
  label: ReactNode;
  count?: number;
  countOf?: string;
  dot: ReactNode;
  active: boolean;
  onClick: () => void;
  wrap: (row: ReactElement) => ReactElement;
  testId?: string;
}

/** A connected agent's state in a word after its name, the row's room — "ready" as for an agent on a video; its title
 * says it whole ("waiting for your notes"). */
const STATE_WORDS: Record<AgentListenState, () => string> = {
  idle: () => t('connected'),
  listening: () => t('ready'),
  working: () => t('working'),
};
const STATE_LINES: Record<AgentListenState, () => string> = {
  idle: () => t('connected'),
  listening: () => t('waiting for your notes'),
  working: () => t('working'),
};

/**
 * How a row names an agent: what it is ("Claude Code") when its client is a known one, and whose only when it isn't the
 * person's own ("Claude Code · Rita"). The full name is in its hover and is what assigning goes by.
 */
export function shownAgent(name: string, kind: AgentKind | null | undefined, me: string | null | undefined): string {
  const [client, owner] = name.split(' · ');
  const known = kind && !['mcp', 'cli', 'api'].includes(kind) && agentKindOf(client) === kind;
  const what = known ? AGENT_KIND_LABELS[kind] : (client ?? name);
  return owner && owner !== me ? `${what} · ${owner}` : what;
}

/** The agents connected now that no video names: the newest of each name (an agent reconnecting keeps one row). */
function unassigned(connected: readonly ConnectedAgent[], named: ReadonlySet<string>): ConnectedAgent[] {
  const byName = new Map<string, ConnectedAgent>();
  for (const a of connected) if (!named.has(a.name) && (!byName.has(a.name) || a.state === 'listening')) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function SidebarAgents({ videos, view, Item }: { videos: readonly VideoSummary[]; view: LibraryView; Item: ComponentType<AgentRowProps> }) {
  const can = useCan();
  const agents = can('agents');
  const me = useAuthStatus().data?.user?.name ?? null;
  const sessions = useMemo(() => {
    const m = new Map<string, { n: number; active: boolean; ref: SessionRef; runs: RunLike[] }>();
    for (const v of videos) {
      if (!v.session) continue;
      const s = m.get(v.session.name) || { n: 0, active: false, ref: v.session, runs: [] };
      s.n++;
      s.active ||= !!v.sessionActive;
      // its work on its videos: the row says the one that matters most (needs you, failed … before working)
      const r = cardRun(v);
      if (r) s.runs.push(r);
      m.set(v.session.name, s);
    }
    return [...m.entries()].map(([name, s]) => [name, { ...s, run: mostUrgent(s.runs) }] as const).sort((a, b) => a[0].localeCompare(b[0]));
  }, [videos]);
  // every agent connected now, for those who run agents: one that isn't on a video yet shows too (the registry, live)
  const connected = useAgents(30_000, agents).data?.agents;
  const loose = useMemo(() => (connected ? unassigned(connected, new Set(sessions.map(([name]) => name))) : []), [connected, sessions]);
  if (!sessions.length && !loose.length) return null;
  const open = (name: string) => () => goView({ kind: 'session', id: name });
  const here = (name: string) => view.kind === 'session' && view.id === name;
  return (
    <div className="nav-section" data-testid="nav-agents">
      <div className="nav-head">{t('Agents')}</div>
      {sessions.map(([name, s]) => {
        // with work going on (or ended badly), its state in a word or two and its glyph; else what it does now
        const look = s.run ? LOOK[phaseOf(s.run)] : null;
        const tight = s.run ? tightOf(s.run) : null;
        return (
          <Item
            key={name}
            lead={<AgentMark kind={agentKindOfRef(s.ref)} size={15} />}
            label={
              <span className="nav-agent">
                <span className="nav-agent-name">{shownAgent(name, agentKindOfRef(s.ref), me)}</span>
                {s.run && tight ? (
                  // the state in a word or two and how far, never its step or its own sentence (whole in the title)
                  <NavNow agent={name} words={tight.words} figure={tight.figure} full={fullWords(s.run, say)} phase={phaseOf(s.run)} />
                ) : (
                  agents && <AgentNowText agent={name} idle={s.active ? t('ready') : null} />
                )}
              </span>
            }
            count={s.n}
            countOf={t('video|videos', { n: s.n })}
            dot={
              look ? (
                <KeyGlyph shape={look.shape} className={`nav-kg run-kg ${look.tone}`} />
              ) : agents ? (
                <AgentNowDot agent={name} active={s.active} />
              ) : (
                <KeyGlyph shape={s.active ? 'ease' : 'outline'} className={`nav-kg ${s.active ? 'live' : ''}`} />
              )
            }
            active={here(name)}
            onClick={open(name)}
            wrap={(row) => (
              <SessionHover session={s.ref} active={s.active} videos={s.n} side="right">
                {row}
              </SessionHover>
            )}
          />
        );
      })}
      {loose.map((a) => {
        const state = a.state ?? 'listening';
        const on = state !== 'idle';
        const ref: SessionRef = { name: a.name, id: a.session_id, cwd: a.cwd, assigned: a.last_seen, by: '', ...(a.kind ? { agent: a.kind } : {}) };
        return (
          <Item
            key={a.session_id}
            lead={<AgentMark kind={a.kind ?? 'mcp'} size={15} />}
            label={
              <span className="nav-agent">
                <span className="nav-agent-name">{shownAgent(a.name, a.kind, me)}</span>
                <span className="nav-now" data-testid="agent-now-row" data-phase={state} title={`${a.name} · ${STATE_LINES[state]()}`}>
                  {STATE_WORDS[state]()}
                </span>
              </span>
            }
            dot={<KeyGlyph shape={on ? 'ease' : 'outline'} className={`nav-kg ${on ? 'live' : ''}`} />}
            active={here(a.name)}
            onClick={open(a.name)}
            wrap={(row) => (
              <SessionHover session={ref} active={on} listening={state === 'listening'} videos={0} side="right">
                {row}
              </SessionHover>
            )}
            testId="nav-agent-connected"
          />
        );
      })}
    </div>
  );
}
