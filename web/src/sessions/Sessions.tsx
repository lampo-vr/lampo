// Picking the agent that receives a video's feedback. The rules (which rows, what is preselected, when Assign changes
// anything) are in pick.ts.

import { type ComponentPropsWithRef, type ReactElement, useEffect, useState } from 'react';
import { agentKindOfRef, agentShown } from '../../../lib/agentKind.ts';
import { useInfo, useSessions } from '../api/queries.ts';
import type { Session, SessionPick, SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { tilde } from '../lib/format.ts';
import { Spinner } from '../ui/feedback.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { HoverCard } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { changes, initialPick, pickerRows, pickOf, suggested } from './pick.ts';

export { pickOf, sameSession, suggested } from './pick.ts';

// A connected agent: whether it hears new notes (server/agents.ts: listening, working, idle); a Claude Code session:
// its own kind and status as it says them.
const kindLabel = (s: Session) =>
  s.kind === 'connected'
    ? s.status === 'idle'
      ? t('not listening')
      : t('listening')
    : [s.kind === 'background' ? 'background' : null, s.status].filter(Boolean).join(' · ');

/** Where agents get their notes explained: Settings → Connect an agent. */
export function HowAgentsGetNotes() {
  return (
    <a className="how-agents" href="#/settings/mcp">
      {t('How agents get notes')}
    </a>
  );
}

interface SessionListProps {
  sessions: Session[] | null;
  selected: Session | null;
  onSelect: (s: Session | null) => void;
  home?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  current?: SessionRef | null;
}

// selected: a session from the list, or null ("no session")
export function SessionList({ sessions, selected, onSelect, home, refreshing, onRefresh, current }: SessionListProps) {
  // A hosted server lists the agents that connected with `lampo watch`; it cannot see sessions on people's machines.
  const agents = useInfo()?.features.sessions === 'agents';
  if (!sessions)
    return (
      <SkeletonRegion label={agents ? t('Looking for connected agents') : t('Looking for running agents')} className="sessions">
        <RowsSkeleton n={3} thumb={16} action={false} />
        <span className="muted" style={{ fontSize: 11.5 }}>
          {agents ? t('Looking for connected agents…') : t('Looking for running agents…')}
        </span>
      </SkeletonRegion>
    );
  const top = suggested(sessions);
  const rows = pickerRows(sessions, current ?? null);
  return (
    <div className="sessions">
      {rows.map((s) => {
        const sel = !!selected && selected.name === s.name && (selected.sessionId || null) === (s.sessionId || null);
        return (
          <button type="button" key={s.sessionId || s.name} className={`session ${sel ? 'sel' : ''}`} onClick={() => onSelect(s)}>
            <span className="radio" />
            <span className="session-main">
              <span className="session-title">
                <AgentMark kind={s.agent ?? 'claude-code'} size={14} />
                <span className="session-name ellipsis" title={s.name}>
                  {agentShown(s.name, s.agent)}
                </span>
                {top === s && <span className="badge claude">{t('SUGGESTED')}</span>}
                {current && s === rows[0] && <span className="badge">{t('CURRENT')}</span>}
              </span>
              <span className="session-sub ellipsis">
                {tilde(s.cwd, home)}
                {s.reason ? ` · ${s.reason}` : ''}
              </span>
            </span>
            <span className="session-sub session-kind">{s.notRunning ? t('not running') : kindLabel(s)}</span>
          </button>
        );
      })}
      <button type="button" className={`session ${selected === null ? 'sel' : ''}`} onClick={() => onSelect(null)}>
        <span className="radio" />
        <span className="session-main">
          <span className="session-name">{t('No agent')}</span>
          <span className="session-sub">{t('Notes are kept for the agent; assign one later.')}</span>
        </span>
        <span />
      </button>
      <div className="row muted" style={{ fontSize: 11.5, marginTop: 2 }}>
        <span className="grow">
          {agents
            ? sessions.length
              ? t('{n} connected agent.|{n} connected agents.', { n: sessions.length })
              : t('No agent is connected.')
            : sessions.length
              ? t('{n} running agent.|{n} running agents.', { n: sessions.length })
              : t('No running agents found.')}{' '}
          <HowAgentsGetNotes />
        </span>
        <button type="button" className="btn sm ghost" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <Spinner /> : <I name="refresh" size={14} />} {t('Refresh')}
        </button>
      </div>
    </div>
  );
}

interface SessionPickerProps {
  video: string;
  current: SessionRef | null;
  onAssign: (s: SessionPick | null) => void;
  home?: string | null;
}

// Picker body, used in the library (inside a modal) and in the player header (inside a popover).
export function SessionPicker({ video, current, onAssign, home }: SessionPickerProps) {
  const { sessions, refreshing, refresh } = useSessions(video);
  const [sel, setSel] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    if (sel !== undefined || !sessions) return;
    setSel(initialPick(pickerRows(sessions, current), current, suggested(sessions)));
  }, [sessions, current, sel]);
  return (
    <>
      <SessionList sessions={sessions} selected={sel ?? null} onSelect={setSel} home={home} refreshing={refreshing} onRefresh={refresh} current={current} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn primary"
          onClick={() => onAssign(pickOf(sel ?? null))}
          disabled={sessions === null || sel === undefined || !changes(sel, current)}
          data-testid="assign-agent"
        >
          {t('Assign')}
        </button>
      </div>
    </>
  );
}

/** Who gets the feedback, on hover: the session's name, whether it runs, where it works, how many videos it has. */
export function SessionHover({
  session,
  active,
  listening,
  videos,
  side = 'top',
  children,
}: {
  session: SessionRef;
  active: boolean | null;
  /** Whether it hears new notes by itself (VideoSummary.sessionListening). */
  listening?: boolean | null;
  videos?: number;
  side?: 'top' | 'bottom' | 'right';
  children: ReactElement;
}) {
  return (
    <HoverCard trigger={children} side={side} className="session-hc">
      <SessionDetails session={session} active={active} listening={listening} videos={videos} />
    </HoverCard>
  );
}

/**
 * Whether the agent gets new notes: an agent connected over MCP only while it listens (`listening`, from the video's
 * summary; the player's agent menu says it live, with the command that starts it); a Claude Code session on this
 * machine while it runs.
 */
const statusLine = (active: boolean | null, listening: boolean | null | undefined) =>
  listening === false && !active
    ? t('Not listening: new notes wait until you start it')
    : active || listening
      ? t('Running: new notes reach it right away')
      : t('Not running: it gets the notes when it starts');

// The card's content: rendered only when it shows (a chip on every card doesn't ask for the server's info).
function SessionDetails({ session, active, listening, videos }: { session: SessionRef; active: boolean | null; listening?: boolean | null; videos?: number }) {
  const home = useInfo()?.home;
  return (
    <>
      <div className="hc-head">
        <KeyGlyph shape={active ? 'ease' : 'outline'} className={`nav-kg ${active ? 'live' : ''}`} />
        <AgentMark kind={agentKindOfRef(session)} size={14} />
        <b className="ellipsis">{agentShown(session.name, agentKindOfRef(session))}</b>
      </div>
      <dl className="hc-rows">
        <dt>{t('Status')}</dt>
        <dd>{statusLine(active, listening)}</dd>
        {session.cwd && (
          <>
            <dt>{t('Works in')}</dt>
            <dd className="mono">{tilde(session.cwd, home)}</dd>
          </>
        )}
        {videos !== undefined && (
          <>
            <dt>{t('Videos')}</dt>
            <dd>{videos}</dd>
          </>
        )}
      </dl>
    </>
  );
}

// Spreads extra props so it can be a Radix trigger (asChild) as well as a plain button.
type ChipProps = { session: SessionRef | null; active: boolean | null; listening?: boolean | null } & ComponentPropsWithRef<'button'>;

export function SessionChip({ session, active, listening, ...rest }: ChipProps) {
  if (!session)
    return (
      <button type="button" aria-label={t('Assign agent')} {...rest} className="session-chip none">
        <I name="terminal" size={13} /> <span className="sc-long">{t('Assign agent')}</span>
        <span className="sc-short">{t('Assign')}</span>
      </button>
    );
  return (
    <SessionHover session={session} active={active} listening={listening}>
      <button
        type="button"
        aria-label={active ? t('Agent {name}, working', { name: session.name }) : t('Agent {name}', { name: session.name })}
        {...rest}
        className="session-chip"
      >
        <KeyGlyph shape={active ? 'ease' : 'outline'} className={`nav-kg ${active ? 'live' : ''}`} />
        <AgentMark kind={agentKindOfRef(session)} size={13} />
        <span className="ellipsis">{agentShown(session.name, agentKindOfRef(session))}</span>
      </button>
    </SessionHover>
  );
}
