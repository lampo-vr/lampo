// Agents connected right now: MCP clients calling /mcp (Claude Code, Codex, …) and the `vr watch` of older setups. They
// are what a video can be assigned to; the server cannot see sessions on people's machines otherwise. Each says whether
// it waits for notes: an MCP client hears them only while it waits (server/agents.ts), so one that doesn't gets the
// sentence that starts it. Connecting one is Connect an agent's: one snippet and one sentence per agent.
import type { ConnectedAgent } from '../../../lib/types.ts';
import { useAgents } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { StartListening } from '../sessions/listening.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Card, when } from './parts.tsx';

/** An agent's state in words: connected, waiting for the person's notes, or working on what it got. */
const stateWords = (a: ConnectedAgent) => (a.state === 'idle' ? t('connected') : a.state === 'working' ? t('working') : t('waiting for your notes'));

export function Agents() {
  const { data } = useAgents();
  const agents = data?.agents ?? null;
  // The first one that doesn't listen: how to start it, below the list.
  const idle = agents?.find((a) => a.state === 'idle') ?? null;
  return (
    <>
      <header className="set-head">
        <h1>{t('Connected agents')}</h1>
        <p>
          {t(
            'An agent shows up here while it talks to Lampo, and you can hand videos to it. It hears new notes only while it waits for them; it disappears about a minute after it stops.',
          )}
        </p>
      </header>

      <Card title={t('Now')}>
        {!agents ? (
          <SkeletonRegion label={t('Loading the connected agents')}>
            <RowsSkeleton n={2} thumb={false} />
          </SkeletonRegion>
        ) : agents.length === 0 ? (
          <EmptyState size="sm" art="agents" title={t('No agent connected')}>
            {t('Connect one below: it shows up here while it works.')}
          </EmptyState>
        ) : (
          <div className="set-rows" data-testid="connected-agents">
            {agents.map((a) => (
              <div key={a.session_id} className="set-row" data-state={a.state ?? 'listening'}>
                <KeyGlyph shape={a.state === 'idle' ? 'outline' : 'ease'} className={`nav-kg ${a.state === 'idle' ? '' : 'live'}`} />
                <AgentMark kind={a.kind ?? 'cli'} size={16} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    <b>{a.name}</b>
                    {a.user && <span className="muted"> {t('· as {user}', { user: a.user })}</span>}
                  </div>
                  <div className="set-sub ellipsis mono">{[a.host, a.cwd].filter(Boolean).join(' · ') || a.session_id}</div>
                </div>
                <span className="set-sub">
                  {stateWords(a)} · {t('seen {when}', { when: when(a.last_seen) })}
                </span>
              </div>
            ))}
            {idle && <StartListening session={{ name: idle.name, id: idle.session_id, cwd: null, assigned: '', by: '', agent: idle.kind ?? 'cli' }} />}
          </div>
        )}
      </Card>

      <Card title={t('Connect an agent')} lede={t('One snippet in your agent, then one sentence: Use Lampo for your project.')}>
        <a className="btn" href="#/settings/mcp" data-testid="agents-connect">
          <I name="plug" size={14} /> {t('Connect an agent')}
        </a>
      </Card>
    </>
  );
}
