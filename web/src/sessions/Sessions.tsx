// The agent that receives a video's feedback, where it shows: a card's chip and its hover card (whether it runs, where
// it works). Picking one is sessions/SessionPicker.tsx, a chunk of its own.

import type { ComponentPropsWithRef, ReactElement } from 'react';
import { agentKindOfRef, agentShown } from '../../../lib/agentKind.ts';
import { useInfo } from '../api/queries.ts';
import type { SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { tilde } from '../lib/format.ts';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { HoverCard } from '../ui/primitives.tsx';

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
