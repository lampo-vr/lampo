// Starting the video's agent when it isn't running, on this machine only (server/wake.ts checks the same): whether it
// can be done here, what the person chose to happen (Settings → Connect an agent), the question when they chose to be
// asked, and the run Lampo started — what it's doing, Stop, its log.
import { useQuery } from '@tanstack/react-query';
import { WAKE_DEFAULT, wakeBlocker } from '../../../lib/agentRun.ts';
import { useAuthStatus } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { useStopRun } from '../api/mutations.ts';
import { useInfo } from '../api/queries.ts';
import type { AgentRunInfo, SessionRef, WakePref } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { toastError } from '../lib/toast.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';

export interface WakeChoice {
  /** This machine can start the video's agent (a Claude Code session with its id and folder, seen from the machine). */
  here: boolean;
  /** …and it isn't running now: sending something can start it. */
  possible: boolean;
  pref: WakePref;
  /** Where it would start, with the home folder as ~. */
  folder: string;
}

export function useWakeChoice(session: SessionRef | null, active: boolean | null, home?: string | null): WakeChoice {
  const status = useAuthStatus().data;
  const info = useInfo();
  const here = status?.via === 'local' && !!info?.capabilities?.wakeAgents && !wakeBlocker(session);
  const cwd = session?.cwd || '';
  const folder = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return { here, possible: here && !active, pref: status?.user?.prefs?.wake ?? WAKE_DEFAULT, folder };
}

/** A folder short enough for a sentence: its last two parts after an ellipsis when the whole is long. */
const shortFolder = (f: string) => {
  if (f.length <= 40) return f;
  const parts = f.split('/').filter(Boolean);
  return `…/${parts.slice(-2).join('/')}`;
};

/** Runs Lampo started for this video, newest first (only asked for where they can exist). */
export function useAgentRuns(slug: string, enabled: boolean): AgentRunInfo[] {
  return (
    useQuery({
      queryKey: ['agent-runs', slug],
      queryFn: () => api<{ runs: AgentRunInfo[] }>(`/api/agent-runs?slug=${enc(slug)}`),
      enabled,
      staleTime: 10_000,
    }).data?.runs ?? []
  );
}

/** Asked each time: send and start, or only send. One sentence says what starting does. */
export function WakeAsk({
  name,
  folder,
  quote,
  busy,
  onStart,
  onSend,
  notes = false,
}: {
  name: string;
  folder: string;
  /** What is being sent, when the person wrote it (an answer): shown, since the field it was typed in is gone. */
  quote?: string;
  busy: boolean;
  onStart: () => void;
  onSend: () => void;
  /** Notes are sent (drafts/Unsent.tsx), not a request. */
  notes?: boolean;
}) {
  return (
    <div className="wake-ask" data-testid="wake-ask">
      {quote && <q className="wake-ask-quote">{quote}</q>}
      <p>
        <b>{t('{name} isn’t running', { name })}</b>
        <span title={folder}>
          {notes
            ? t('Starts it in {folder} with your notes. It uses your Claude Code settings.', { folder: shortFolder(folder) })
            : t('Starts it in {folder} with this request. It uses your Claude Code settings.', { folder: shortFolder(folder) })}
        </span>
      </p>
      <div className="wake-ask-acts">
        <button type="button" className="btn sm primary" onClick={onStart} disabled={busy} data-testid="wake-start">
          {t('Send and start {name}', { name })}
        </button>
        <button type="button" className="btn sm" onClick={onSend} disabled={busy} data-testid="wake-send">
          {t('Only send')}
        </button>
      </div>
    </div>
  );
}

// How a run ended (literal keys, so the translations find them).
const ended = (s: AgentRunInfo['state']) =>
  s === 'finished' ? t('Finished') : s === 'failed' ? t('Couldn’t start') : s === 'timeout' ? t('Stopped after the time limit') : t('Stopped');

/** The newest run: working (with Stop) while it goes, how it ended afterwards; its log either way. */
export function RunLine({ run }: { run: AgentRunInfo }) {
  const stop = useStopRun();
  const going = run.state === 'running';
  return (
    <div className="wake-run" data-testid="agent-run" data-state={run.state}>
      <KeyGlyph shape={going ? 'ease' : 'outline'} className={`nav-kg ${going ? 'live' : ''}`} />
      <span className="grow">
        {going ? t('Working · started by Lampo') : ended(run.state)}
        {!going && run.state === 'finished' && run.exit ? ` · ${t('exit {code}', { code: run.exit })}` : ''}
      </span>
      <a className="how-agents" href={`/api/agent-runs/${enc(run.id)}/log`} target="_blank" rel="noreferrer">
        {t('Log')}
      </a>
      {going && (
        <button
          type="button"
          className="btn sm"
          data-testid="agent-run-stop"
          disabled={stop.isPending}
          onClick={() => stop.mutateAsync(run.id).catch(toastError)}
        >
          {t('Stop')}
        </button>
      )}
    </div>
  );
}
