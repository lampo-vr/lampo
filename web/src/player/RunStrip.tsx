// The agent's line, Cursor's way: one line wherever a video has an agent at work — under the notes panel's head on a
// desk and a tablet, above the dock on a phone — saying who and what in one sentence ("Claude Code is fixing 1 of 3",
// "asked you", "stopped listening") with ONE action at its end (Stop, Answer, Copy "go on", Try again …), and under it
// one folded line: its latest step and how long, the question it asked, or what to tell it. Pressing either opens the
// Agent view. Only while something is going on or needs the person: an agent that is just ready says nothing here.
// Checking the fixes is the notes' "To check" header's (NotesPanel.tsx), not this line's. Reviewers and review-link
// visitors see the line, never its controls.
import { type CSSProperties, memo, useEffect, useState } from 'react';
import { AGENT_KIND_LABELS, agentKindOfRef, agentShown } from '../../../lib/agentKind.ts';
import type { SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { copyGoOn, goOnWords, startWith } from '../sessions/listening.tsx';
import { type RunAction, type RunLike, type RunSaid, runSaid, type Say, stalledSaid } from '../sessions/runWords.ts';
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
  /** The assigned agent: its name and app when no run is going (it stopped listening). */
  session: SessionRef | null;
  /** It stopped listening while something waits on it: the line says to tell it "go on" (sessions/listening.tsx). */
  stalled?: boolean;
  /** Fixes waiting to be checked: a finished run's line stays while there are some (checking them is the notes'
   * "To check" header's and the top bar's, never this line's). */
  toCheck: number;
  nextV: number;
  /** May steer agents (Stop, Try again, Nudge, copy the start): the `agents` right. */
  canSteer: boolean;
  say?: Say;
  onOpen: () => void;
  onAnswer: (note: string | null) => void;
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
const allowedFor = (a: RunAction, steer: boolean) => (a === 'answer' || a === 'log' || a === 'allow' ? true : steer);

/** The one action a line offers, of those its state allows: what needs the person first, Log never (the Agent view has it). */
const ONE: RunAction[] = ['answer', 'allow', 'go_on', 'retry', 'again', 'nudge', 'stop', 'cancel', 'copy'];
/** A name as the line says it: an app's own id by its app's name ("Claude Code"), whose it is in the line's title. */
const lineName = (name: string, kind?: Parameters<typeof agentShown>[1]) => agentShown(name, kind).split(' · ')[0] || name;

export const RunStrip = memo(function RunStrip(p: RunStripProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const kind = p.run ? p.run.agent.kind : p.session ? agentKindOfRef(p.session) : null;
  const shown = p.run ? agentShown(p.run.agent.name, p.run.agent.kind) : p.session ? agentShown(p.session.name, kind) : '';
  const name = p.run ? lineName(p.run.agent.name, p.run.agent.kind) : p.session ? lineName(p.session.name, kind) : '';
  // the run as the line says it: its agent by the line's name
  const run = p.run ? { ...p.run, agent: { ...p.run.agent, name } } : null;
  const counting = !!run && (run.state === 'queued' || run.state === 'starting' || (run.state === 'working' && !run.progress?.pct));
  const ticked = useTick(counting && p.still === undefined);
  const now = p.still ?? ticked;
  const said: RunSaid | null =
    p.stalled && p.session ? stalledSaid(goOnWords(p.session)) : run ? runSaid(run, { now, asOf: p.asOf, nextV: p.nextV, say: p.say }) : null;
  // nothing going on and nothing needing the person: no line (an agent that is just ready, or not running with nothing
  // waiting on it, or done with nothing of its left to check)
  if (!said || (said.phase === 'done' && !p.toCheck)) return null;
  const phase = said.phase;
  const action = ONE.find((a) => said.actions.includes(a) && allowedFor(a, p.canSteer)) ?? null;
  const busy = p.act.busy;
  const asked = phase === 'needs_you' && (run?.needs?.kind === 'question' || run?.needs?.kind === 'options' || !run?.needs);
  const working = phase === 'working' || phase === 'rendering' || phase === 'uploading' || phase === 'checking';
  // The line's words are the strip's (runWords.ts), split in two: where it stands in a few words is the sentence, after
  // the agent's name ("Claude Code is fixing 3 of 7", "… needs permission"), and the rest is the folded line under it
  // (its latest step, how long, why it stopped); a line without a name says its own ("V3 is ready", "Stopped after 4 min").
  const [head = '', ...rest] = said.words.split(' · ');
  const what =
    phase === 'not_listening' ? t('stopped listening') : asked ? t('asked you') : said.name ? (working ? t('is {doing}', { doing: head }) : head) : null;
  // the folded line: what to tell it, the question in its words, or the rest of the strip's words
  const fold =
    phase === 'not_listening' && p.session
      ? ['mcp', 'api', 'cli'].includes(agentKindOfRef(p.session))
        ? t('Tell it “go on”: your notes are waiting for it.')
        : t('Tell it “go on” in {app}: your notes are waiting for it.', { app: AGENT_KIND_LABELS[agentKindOfRef(p.session)] })
      : asked && run?.needs?.text
        ? t('“{quote}”', { quote: p.say ? p.say(run.needs.text) : run.needs.text.text })
        : rest.join(' · ') || null;
  // how far, beside the folded words and never cut ("42%")
  const figure = working ? said.figure : null;
  // the line whole, as it is cut where it doesn't fit: in its title, and pressing opens all of it
  const sentence = what ? `${name} ${what}` : head;
  const full = [shown !== name && what ? `${sentence} (${shown})` : sentence, fold, figure].filter(Boolean).join(' · ');
  const act = (a: RunAction) => {
    if (a === 'answer') return p.onAnswer(run?.needs?.note ?? null);
    if (a === 'allow') return p.onOpen();
    if (a === 'go_on' && p.session) return void copyGoOn(p.session);
    if (a === 'copy' && p.session) {
      const how = startWith(p.session);
      return void copyText(how.text).then((ok) => ok && toast(t('Copied: paste it into {name}', { name: shown }), 'ok'));
    }
    if (!run) return;
    const write = a === 'stop' || a === 'cancel' ? p.act.stop : a === 'nudge' ? p.act.nudge : p.act.retry;
    write(run.id).then(() => a === 'nudge' && toast(t('Nudged {name}', { name }), 'ok'), toastError);
  };
  // the one raised button: Answer, when the agent asks (the view's one: + Note steps down); everything else is quiet
  const primary = action === 'answer';
  const live = phase === 'working' || phase === 'rendering' || phase === 'uploading' || phase === 'checking' || phase === 'starting' || phase === 'queued';
  return (
    <div className={`run-strip${p.phone ? ' phone' : ''}${p.open ? ' open' : ''}`} data-testid="run-strip" data-phase={phase} data-run={run?.id}>
      <div className="al-line">
        <span className={`al-mark${phase === 'not_listening' ? ' quiet' : ''}`} aria-hidden="true">
          <AgentMark kind={kind} size={14} />
        </span>
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
          <span className="run-words" data-testid="run-words">
            {what ? (
              <>
                <b>{name}</b> {what}
              </>
            ) : (
              head
            )}
          </span>
          {live && <KeyGlyph shape={said.shape} className={`nav-kg run-kg ${said.tone}`} />}
        </button>
        {action && (
          <button
            type="button"
            className={primary ? 'btn sm primary run-act' : 'btn sm run-act'}
            onClick={() => act(action)}
            disabled={busy && !primary}
            data-testid={`run-${action}`}
            aria-label={action === 'copy' && p.session ? t('Copy what starts {name}', { name: shown }) : undefined}
          >
            {action === 'copy' || action === 'go_on' ? (
              <>
                <I name="copy" size={14} /> {action === 'go_on' ? t('Copy “go on”') : t('Copy')}
              </>
            ) : (
              actionLabel(action)
            )}
          </button>
        )}
      </div>
      {/* the folded line keeps its room whatever the state, so the notes under it never move */}
      {fold || figure ? (
        <button type="button" className="al-fold" onClick={p.onOpen} title={[fold, figure].filter(Boolean).join(' · ')} data-testid="run-fold">
          {asked || phase === 'not_listening' ? null : <span aria-hidden="true">›</span>}
          {fold && <span className="ellipsis">{fold}</span>}
          {fold && figure && <span aria-hidden="true">·</span>}
          {figure && (
            <span className="run-fig" data-testid="run-fig">
              {figure}
            </span>
          )}
        </button>
      ) : (
        <span className="al-fold" aria-hidden="true" />
      )}
      {said.edge !== null && <span className="run-edge" data-testid="run-edge" style={{ '--edge': said.edge } as CSSProperties} aria-hidden="true" />}
    </div>
  );
});

/** The strip's slot while the review loads: the same box, the words on their way. */
export function RunStripPending({ phone = false }: { phone?: boolean }) {
  return (
    <div className={`run-strip pending${phone ? ' phone' : ''}`} data-testid="run-strip" aria-hidden="true">
      <div className="al-line">
        <span className="al-mark quiet" />
        <span className="run-main">
          <span className="run-words">
            <SkLine w="14em" />
          </span>
        </span>
      </div>
      <span className="al-fold">
        <SkLine w="10em" />
      </span>
    </div>
  );
}
