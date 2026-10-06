// Agents connected right now: MCP clients calling /mcp (Claude Code, Codex, …) and Claude Code sessions that run
// `vr watch` against this server. They are what a video can be assigned to; the server cannot see sessions on people's
// machines otherwise. Each says whether it hears new notes: an MCP client only while it waits for them
// (server/agents.ts), so one that doesn't gets the command that starts it.
import type { ConnectedAgent } from '../../../lib/types.ts';
import { useAgents } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { StartListening } from '../sessions/listening.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Card, Code, serverUrl, when } from './parts.tsx';

/** An agent's state in words: listening, working on what it got, or connected without listening. */
const stateWords = (a: ConnectedAgent) => (a.state === 'idle' ? t('not listening') : a.state === 'working' ? t('working') : t('listening'));

export function Agents() {
  const url = serverUrl(useInfo()?.public_url);
  const { data } = useAgents();
  const agents = data?.agents ?? null;
  // The first one that doesn't listen: how to start it, below the list.
  const idle = agents?.find((a) => a.state === 'idle') ?? null;
  return (
    <>
      <header className="set-head">
        <h1>{t('Connected agents')}</h1>
        <p>
          <T
            k={
              'An agent shows up here while it talks to Lampo (over MCP, or with <0>vr watch</0>), and you can hand videos to it. It hears new notes only while it listens; it disappears about a minute after it stops.'
            }
            tags={[(c) => <code>{c}</code>]}
          />
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

      <Card
        title={t('Connect an agent')}
        lede={t('On the machine where the agent works: vr login opens your browser, and you allow it there (or it takes a token from API tokens).')}
      >
        <ol className="set-steps">
          <li>
            <span>{t('Sign this machine in:')}</span>
            <Code>{`vr login ${url}`}</Code>
          </li>
          <li>
            <span>
              {t('Inside the Claude Code session, keep this running (e.g. under a Monitor): new notes arrive as lines, and the session becomes assignable.')}
            </span>
            <Code>{t('vr watch')}</Code>
          </li>
          <li>
            <span>{t('Put videos up for review from there:')}</span>
            <Code>{'vr push export/film.mp4 --folder "Acme/Reels"'}</Code>
          </li>
        </ol>
        <div className="set-sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <I name="terminal" size={14} />
          <span>
            <T
              k={'MCP clients work the same way with <0>VR_SERVER</0> and <1>VR_TOKEN</1>; see API tokens.'}
              tags={[(c) => <code>{c}</code>, (c) => <code>{c}</code>]}
            />
          </span>
        </div>
      </Card>
    </>
  );
}
