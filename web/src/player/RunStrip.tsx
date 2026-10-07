// The run strip: one line in a fixed slot wherever a video has an agent — under the side panel's head on a desk and a
// tablet, above the dock on a phone — saying what the agent is doing now ("Claude Code · fixing 3 of 6 · editing
// Logo.tsx  6:12"), with a 2 px edge along its foot that fills while a render or an upload says how far it is. States
// swap words, never heights. Pressing it opens the Agent view. Its only raised button is the one that needs the person:
// Answer (or Check fixes once it is done); Stop, Try again, Nudge and the rest stay quiet and only for who may steer
// agents. Reviewers and review-link visitors see the line, never those controls.
import { type CSSProperties, memo, useEffect, useState } from 'react';
import { agentKindOfRef } from '../../../lib/agentKind.ts';
import { enc } from '../api/client.ts';
import type { SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { startWith } from '../sessions/listening.tsx';
import { idleSaid, type RunAction, type RunLike, type RunSaid, runSaid, type Say } from '../sessions/runWords.ts';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkLine } from '../ui/Skeleton.tsx';

/** Re-renders every second while `on` (a clock that counts). */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export interface RunStripProps {
  slug: string;
  /** The run the strip speaks of (Player.tsx `stripRun`): one going on, one ended badly, one done with fixes waiting. */
  run: RunLike | null;
  /** When `run` was answered (worked time counts on from it while the agent works). */
  asOf: number;
  /** The assigned agent: with no run going, whether it hears notes. */
  session: SessionRef | null;
  reachable: boolean;
  /** An agent connected over MCP (its start command can be copied). */
  copyable: boolean;
  /** Fixes waiting to be checked: done offers Check fixes while there are some. */
  toCheck: number;
  nextV: number;
  /** May steer agents (Stop, Try again, Nudge, copy the start): the `agents` right. */
  canSteer: boolean;
  /** May check fixes. */
  canCheck: boolean;
  say?: Say;
  onOpen: () => void;
  onAnswer: (note: string | null) => void;
  onCheck: () => void;
  /** Phones: above the dock, a thumb's height; pressing it opens the Agent view in the sheet. */
  phone?: boolean;
  /** The view it opens is showing (the line is its head then). */
  open?: boolean;
  /** Warms the Agent view's code up (pointer or focus on the strip). */
  onWarm?: () => void;
  /** A still picture (the styleguide): this moment, and no clock that counts. */
  still?: number;
  /** Stop, Try again and Nudge (api/runs.ts useRunActions, in Player.tsx), and whether one is on its way. */
  act: StripActs;
}

export interface StripActs {
  stop: (id: string) => Promise<unknown>;
  retry: (id: string) => Promise<unknown>;
  nudge: (id: string) => Promise<unknown>;
  busy: boolean;
}

/** What one action is called (literal keys for the translations). */
function actionLabel(a: RunAction): string {
  switch (a) {
    case 'answer':
      return t('Answer');
    case 'check':
      return t('Check fixes');
    case 'log':
      return t('Log');
    case 'retry':
      return t('Try again');
    case 'again':
      return t('Send again');
    case 'nudge':
      return t('Nudge');
    case 'stop':
      return t('Stop');
    case 'cancel':
      return t('Cancel');
    case 'allow':
      return t('How to allow it');
    default:
      return t('Copy');
  }
}

/** Who may press which: steering is the agents right's, checking the verify right's; Answer and Log are for anyone. */
const allowedFor = (a: RunAction, steer: boolean, check: boolean) => (a === 'check' ? check : a === 'answer' || a === 'log' || a === 'allow' ? true : steer);

export const RunStrip = memo(function RunStrip(p: RunStripProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const run = p.run;
  const counting = !!run && (run.state === 'queued' || run.state === 'starting' || (run.state === 'working' && !run.progress?.pct));
  const ticked = useTick(counting && p.still === undefined);
  const now = p.still ?? ticked;
  const said: RunSaid | null = run
    ? runSaid(run, { now, asOf: p.asOf, nextV: p.nextV, say: p.say, toCheck: p.toCheck })
    : p.session
      ? idleSaid(p.session.name, p.reachable, p.copyable)
      : null;
  if (!said) return null;
  const kind = run ? run.agent.kind : p.session ? agentKindOfRef(p.session) : null;
  const actions = said.actions.filter((a) => allowedFor(a, p.canSteer, p.canCheck));
  const busy = p.act.busy;
  // the line as it is cut with an ellipsis where it doesn't fit: whole in its title, and pressing opens all of it
  const full = [said.name, said.words, said.figure].filter(Boolean).join(' · ');
  const act = (a: RunAction) => {
    if (a === 'answer') return p.onAnswer(run?.needs?.note ?? null);
    if (a === 'check') return p.onCheck();
    if (a === 'allow' || (a === 'log' && !(run && 'log' in run && run.log))) return p.onOpen();
    if (a === 'log' && run) return void window.open(`/api/runs/${enc(run.id)}/log`, '_blank', 'noopener');
    if (a === 'copy' && p.session) {
      const how = startWith(p.session);
      return void copyText(how.text).then((ok) => ok && toast(t('Copied: paste it into {name}', { name: p.session?.name ?? '' }), 'ok'));
    }
    if (!run) return;
    const write = a === 'stop' || a === 'cancel' ? p.act.stop : a === 'nudge' ? p.act.nudge : p.act.retry;
    write(run.id).then(() => a === 'nudge' && toast(t('Nudged {name}', { name: run.agent.name }), 'ok'), toastError);
  };
  const primary = (a: RunAction) => a === 'answer' || a === 'check';
  return (
    <div className={`run-strip${p.phone ? ' phone' : ''}${p.open ? ' open' : ''}`} data-testid="run-strip" data-phase={said.phase} data-run={run?.id}>
      <button
        type="button"
        className="run-main"
        onClick={p.onOpen}
        aria-label={p.open ? full : t('{line} · show what the agent is doing', { line: full })}
        title={full}
        aria-expanded={p.phone ? undefined : p.open}
        data-testid="run-open"
        onPointerEnter={p.onWarm}
        onFocus={p.onWarm}
      >
        <KeyGlyph shape={said.shape} className={`nav-kg run-kg ${said.tone}`} />
        <AgentMark kind={kind} size={14} />
        <span className="run-words" data-testid="run-words">
          {said.name && <b>{said.name}</b>}
          {said.name && said.words ? ' · ' : ''}
          {said.words}
        </span>
        {said.figure && (
          <span className="run-fig" data-testid="run-fig">
            {said.figure}
          </span>
        )}
        {!p.open && !actions.length && <I name="right" size={14} className="run-go" />}
      </button>
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          className={primary(a) ? 'btn sm primary run-act' : 'btn sm ghost run-act'}
          onClick={() => act(a)}
          disabled={busy && !primary(a)}
          data-testid={`run-${a}`}
          aria-label={a === 'copy' && p.session ? t('Copy what starts {name}', { name: p.session.name }) : undefined}
        >
          {a === 'copy' ? <I name="copy" size={14} /> : actionLabel(a)}
        </button>
      ))}
      {said.edge !== null && <span className="run-edge" data-testid="run-edge" style={{ '--edge': said.edge } as CSSProperties} aria-hidden="true" />}
    </div>
  );
});

/** The strip's slot while the review loads: the same box, the words on their way. */
export function RunStripPending({ phone = false }: { phone?: boolean }) {
  return (
    <div className={`run-strip pending${phone ? ' phone' : ''}`} data-testid="run-strip" aria-hidden="true">
      <span className="run-main">
        <KeyGlyph shape="outline" className="nav-kg run-kg quiet" />
        <span className="run-words">
          <SkLine w="14em" />
        </span>
      </span>
    </div>
  );
}
