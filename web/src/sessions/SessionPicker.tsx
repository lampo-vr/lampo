// Picking the agent that receives a video's feedback: the list and the picker (the library's Assign agent… dialog,
// the player's agent menu, Add video). Its own chunk: asked for when a picker opens (the library's first paint carries
// only the chip and its hover card, sessions/Sessions.tsx). The rules (which rows, what is preselected, when Assign
// changes anything) are in pick.ts.

import { useEffect, useState } from 'react';
import { agentShown } from '../../../lib/agentKind.ts';
import { useInfo, useSessions } from '../api/queries.ts';
import type { Session, SessionPick, SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { tilde } from '../lib/format.ts';
import { LeaveLink } from '../lib/leave.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { changes, initialPick, pickerRows, pickOf, suggested } from './pick.ts';

export { pickOf, suggested } from './pick.ts';

// A connected agent: whether it hears new notes (server/agents.ts: listening, working, idle); a Claude Code session:
// its own kind and status as it says them.
const kindLabel = (s: Session) =>
  s.kind === 'connected'
    ? s.status === 'idle'
      ? t('not listening')
      : t('listening')
    : [s.kind === 'background' ? 'background' : null, s.status].filter(Boolean).join(' · ');

/** Where agents get their notes explained: Settings → Connect an agent; its way back opens the picker it was in again. */
export function HowAgentsGetNotes() {
  return (
    <LeaveLink className="how-agents" href="#/settings/mcp">
      {t('How agents get notes')}
    </LeaveLink>
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
                {top === s && <span className="badge agent">{t('SUGGESTED')}</span>}
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
