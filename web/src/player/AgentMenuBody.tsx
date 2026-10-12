// The agent menu's body, Cursor's way (ClaudeMenu.tsx opens it from the top bar's agent button): the agent's mark and
// one sentence of where it stands ("Claude Code is fixing 1 of 3", "asked you", "stopped listening") with a sub line,
// ⋯ for the rest (the quick check, Copy for an agent, Assign agent…); the moment's one action (Stop; Answer with Show
// the frame; Copy "go on"); a question quoted in a quiet inset; its steps as a thin rail, the latest three, all on
// request; and one "Ask Claude Code…" field with Send inside. What it sends and how stays ClaudeMenu's.
import { type ReactNode, useState } from 'react';
import { AGENT_KIND_LABELS, agentKindOfRef } from '../../../lib/agentKind.ts';
import { enc } from '../api/client.ts';
import { useStopRun } from '../api/mutations.ts';
import { useRunActions } from '../api/runs.ts';
import type { AgentActivity, AgentRunInfo, SessionRef } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { newestFirstKeys } from '../lib/listKeys.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { type NoteAt, say } from '../sessions/activityWords.ts';
import { activityLine, pick, RunUse, useAgentActivity } from '../sessions/Live.tsx';
import { copyGoOn, type Listen, startWith, waitsForStart } from '../sessions/listening.tsx';
import { isOpen, ownWords, phaseOf, type RunLike, stateWords } from '../sessions/runState.ts';
import { ended } from '../sessions/Wake.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';

const clock = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
/** A wait is re-asked every few minutes while it lasts: older than this, the agent stopped waiting. */
const WAIT_FRESH_MS = 15 * 60_000;
/** The rail's lines until the person asks for the rest, and the most it shows. */
const RAIL = 3;
const RAIL_ALL = 11;
const waitingForAnswer = (a: AgentActivity | null): boolean =>
  !!a && a.kind === 'wait' && a.key === 'Waiting for your answer' && Date.now() - (Date.parse(a.at) || 0) < WAIT_FRESH_MS;

export interface AgentMenuBodyProps {
  slug: string;
  session: SessionRef;
  /** The agent as people read it ("Claude Code · Mia"). */
  shown: string;
  listen: Listen | null;
  /** It stopped listening while something waits on it. */
  stalled: boolean;
  /** A Claude Code session on this machine that runs. */
  active: boolean;
  /** The work the agent line speaks of (Player.tsx `stripRun`). */
  run: RunLike | null;
  /** The newest run Lampo started for this video on this machine (its tokens, its log, Stop). */
  wakeRun: AgentRunInfo | null;
  open: boolean;
  noteAt?: NoteAt;
  canAsk: boolean;
  canAssign: boolean;
  /** The agent's newest open question here, with its words. */
  question: { id: string; text: string } | null;
  onAnswer?: (note: string | null) => void;
  onShowNote?: (note: string) => void;
  onAgentView?: () => void;
  /** "Send and start" or "Only send", when the person chose to be asked each time: in the field's place. */
  asking: ReactNode;
  text: string;
  setText: (s: string) => void;
  onSend: () => void;
  /** The quick check of the shot on screen, in ⋯: what it would render in its label (or why it can't). */
  quick: { label: string; disabled: boolean; onClick: () => void } | null;
  onCopy: () => void;
  onAssign: () => void;
  close: () => void;
}

type Now =
  | { kind: 'asked'; note: string | null; at: string | null; quote: string | null }
  | { kind: 'needs'; why: string | null }
  | { kind: 'work'; doing: string; step: string | null; runId: string | null }
  | { kind: 'stalled' }
  | { kind: 'idle' }
  | { kind: 'offline' }
  | { kind: 'listening' }
  | { kind: 'running' }
  | { kind: 'off' };

/** Where the agent stands, most pressing first: what needs the person, then what it does, then whether it hears notes. */
function nowOf(p: AgentMenuBodyProps, head: AgentActivity | null): Now {
  if (p.stalled) return { kind: 'stalled' };
  const run = p.run && isOpen(p.run) ? p.run : null;
  const phase = run ? phaseOf(run) : null;
  if (run && phase === 'needs_you') {
    const k = run.needs?.kind;
    return k === 'permission' || k === 'sign_in'
      ? { kind: 'needs', why: run.needs?.text ? say(run.needs.text, p.noteAt) : null }
      : {
          kind: 'asked',
          note: run.needs?.note ?? p.question?.id ?? null,
          at: run.now?.at ?? null,
          quote: p.question?.text ?? (run.needs?.text ? say(run.needs.text, p.noteAt) : null),
        };
  }
  // it waits for an answer to its open question here (a wait alone is an agent listening for notes)
  if (p.question && waitingForAnswer(head) && !waitsForStart(p.listen))
    return { kind: 'asked', note: p.question.id, at: head?.since ?? head?.at ?? null, quote: p.question.text };
  if (run) return { kind: 'work', doing: stateWords(run), step: ownWords(run), runId: run.id };
  if (p.wakeRun?.state === 'running') return { kind: 'work', doing: t('working'), step: null, runId: null };
  if (p.listen === 'idle') return { kind: 'idle' };
  if (p.listen === 'offline') return { kind: 'offline' };
  if (p.listen === 'working') return { kind: 'work', doing: t('working'), step: null, runId: null };
  if (p.listen === 'listening') return { kind: 'listening' };
  return p.active ? { kind: 'running' } : { kind: 'off' };
}

/** The sentence after the agent's name (literal keys, so the translations find them). */
function whatOf(now: Now): string {
  switch (now.kind) {
    case 'asked':
      return t('asked you');
    case 'needs':
      return t('needs you');
    case 'work':
      return t('is {doing}', { doing: now.doing });
    case 'stalled':
      return t('stopped listening');
    case 'idle':
      return t('isn’t listening');
    case 'offline':
      return t('isn’t connected');
    case 'listening':
      return t('is listening');
    case 'running':
      return t('is running');
    default:
      return t('isn’t running');
  }
}

export function AgentMenuBody(p: AgentMenuBodyProps) {
  const [all, setAll] = useState(false);
  const acts = useRunActions(p.slug);
  const stopWake = useStopRun();
  const kind = agentKindOfRef(p.session);
  // the app it runs in, where it has one people know (an MCP client or a script is known by its own name)
  const inApp = kind !== 'mcp' && kind !== 'api' && kind !== 'cli';
  const app = AGENT_KIND_LABELS[kind];
  // the name as the sentence says it: an app's own id by its app's name, whose it is in the sentence's title
  const name = p.shown.split(' · ')[0] || p.shown;
  const mine = pick(useAgentActivity(p.slug, p.session.name, p.open), p.session.name);
  const recent = mine?.recent ?? [];
  const head = recent[0] ?? null;
  const now = nowOf(p, head);
  const tc = now.kind === 'asked' && now.note ? p.noteAt?.(now.note) : null;
  const what = whatOf(now);
  const quiet = now.kind === 'stalled' || now.kind === 'idle' || now.kind === 'offline' || now.kind === 'off';
  const wakeGoing = p.wakeRun?.state === 'running';
  // the sub line: when and where it asked, the step it is on, when it was last heard, what happens to new notes
  const sub =
    now.kind === 'asked'
      ? [tc ? t('at {tc}', { tc }) : null, now.at ? ago(now.at) : null].filter(Boolean).join(' · ')
      : now.kind === 'needs'
        ? now.why
        : now.kind === 'work'
          ? (now.step ?? (head ? activityLine(head, p.noteAt) : null))
          : now.kind === 'stalled'
            ? head
              ? t('last heard {ago}', { ago: ago(head.at) })
              : null
            : now.kind === 'idle' || now.kind === 'offline'
              ? [t('New notes wait until you start it'), head ? t('last heard {ago}', { ago: ago(head.at) }) : null].filter(Boolean).join(' · ')
              : now.kind === 'listening'
                ? t('New notes reach it right away')
                : head
                  ? `${activityLine(head, p.noteAt)} · ${ago(head.at)}`
                  : null;
  const more: MenuEntry[] = [
    p.quick && { label: p.quick.label, icon: 'layers', disabled: p.quick.disabled, onClick: p.quick.onClick },
    'sep',
    p.canAsk && { label: t('Copy for an agent'), icon: 'copy', onClick: p.onCopy },
    p.canAssign && { label: t('Assign agent…'), icon: 'terminal', onClick: p.onAssign },
  ];
  // its steps, newest first: the question it waits on is the quote above, not a step (its wait, nor its asking)
  const asked = now.kind === 'asked' ? recent.find((a) => a.kind === 'ask') : undefined;
  const steps = recent.filter((a) => !(now.kind === 'asked' && ((a === head && a.kind === 'wait') || a === asked)));
  const shownSteps = steps.slice(0, all ? RAIL_ALL : RAIL);
  // keyed over all of them: two alike in one second are two lines
  const stepKeys = newestFirstKeys(steps, (a) => `${a.at}-${a.kind}-${a.text}`);
  // a step in the rail; a wait of an agent that no longer listens is over: never "since 12:41" as if it went on
  const stepOf = (a: AgentActivity) => (quiet && a.kind === 'wait' ? say(a, p.noteAt) : activityLine(a, p.noteAt));
  const act = (() => {
    if (!p.canAsk) return null;
    if (now.kind === 'asked' && p.onAnswer)
      return (
        <>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              p.onAnswer?.(now.note);
              p.close();
            }}
            data-testid="agent-answer"
          >
            {t('Answer')}
          </button>
          {now.note && p.onShowNote && (
            <button type="button" className="btn sm ghost" onClick={() => now.note && p.onShowNote?.(now.note)} data-testid="agent-show-frame">
              {t('Show the frame')}
            </button>
          )}
        </>
      );
    if (now.kind === 'needs' && p.onAgentView)
      return (
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            p.onAgentView?.();
            p.close();
          }}
          data-testid="agent-allow"
        >
          {t('How to allow it')}
        </button>
      );
    // a run Lampo started stops at its process; a run the agent reports, by asking it to
    if (now.kind === 'work' && wakeGoing && p.wakeRun)
      return (
        <button
          type="button"
          className="btn sm"
          disabled={stopWake.isPending}
          onClick={() => p.wakeRun && stopWake.mutateAsync(p.wakeRun.id).catch(toastError)}
          data-testid="agent-run-stop"
        >
          {t('Stop')}
        </button>
      );
    if (now.kind === 'work' && now.runId)
      return (
        <button
          type="button"
          className="btn sm"
          disabled={acts.stop.isPending}
          onClick={() => now.runId && acts.stop.mutateAsync(now.runId).catch(toastError)}
          data-testid="agent-stop"
        >
          {t('Stop')}
        </button>
      );
    if (now.kind === 'stalled')
      return (
        <button type="button" className="btn sm primary" onClick={() => void copyGoOn(p.session)} data-testid="agent-go-on">
          <I name="copy" size={14} /> {t('Copy “go on”')}
        </button>
      );
    if (now.kind === 'idle' || now.kind === 'offline') {
      const how = startWith(p.session);
      return (
        <button
          type="button"
          className="btn sm"
          title={how.text}
          onClick={() => void copyText(how.text).then((ok) => ok && toast(t('Copied: paste it into {name}', { name: inApp ? app : name }), 'ok'))}
          data-testid="agent-start"
        >
          <I name="copy" size={14} /> {t('Copy what starts {name}', { name: inApp ? app : name })}
        </button>
      );
    }
    return null;
  })();
  return (
    <div className="am am-cursor" data-testid="agent-menu" data-now={now.kind}>
      <div className="amc-head">
        <span className={`al-mark${quiet ? ' quiet' : ''}`} aria-hidden="true">
          <AgentMark kind={kind} size={14} />
        </span>
        <div className="amc-what">
          <p className="amc-sentence" title={p.shown} data-testid="agent-sentence">
            <b>{name}</b> {what}
          </p>
          {sub && (
            <p className="amc-sub ellipsis" title={sub} data-testid="agent-now">
              {sub}
            </p>
          )}
        </div>
        {(p.canAsk || p.canAssign) && (
          <Menu
            align="end"
            trigger={<IconButton className="btn sm ghost icon-only amc-more" label={t('More')} icon="more" size={16} data-testid="agent-more" />}
            items={more}
          />
        )}
      </div>
      {now.kind === 'asked' && now.quote && (
        <blockquote className="amc-quote" data-testid="agent-question">
          {now.quote}
        </blockquote>
      )}
      {act && <div className="amc-act">{act}</div>}
      {now.kind === 'stalled' && (
        <p className="amc-note">
          {inApp
            ? t('Paste it into {app}: it picks up your notes and goes on where it was.', { app })
            : t('Paste it where it runs: it picks up your notes and goes on where it was.')}
        </p>
      )}
      {/* its steps: a thin rail of the latest few, all on request; a run Lampo started says how it went at the foot */}
      {p.canAsk && (steps.length > 0 || p.wakeRun) && (
        <section className="amc-steps" aria-label={t('Steps')} data-testid="agent-live">
          {steps.length > 0 && (
            <>
              {steps.length > RAIL ? (
                <button type="button" className="amc-steps-head" onClick={() => setAll(!all)} aria-expanded={all} data-testid="agent-log-more">
                  <span>{t('Steps')}</span>
                  <span className="n">{Math.min(steps.length, RAIL_ALL)}</span>
                  <I name={all ? 'down' : 'right'} size={12} />
                </button>
              ) : (
                <p className="amc-steps-head">
                  <span>{t('Steps')}</span>
                  <span className="n">{steps.length}</span>
                </p>
              )}
              <ol className="amc-rail" data-testid="agent-timeline">
                {shownSteps.map((a, i) => (
                  <li key={stepKeys[i]} data-kind={a.kind}>
                    <time dateTime={a.at}>{clock(a.at)}</time>
                    <span className="ellipsis" title={stepOf(a)}>
                      {stepOf(a)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {p.wakeRun && (
            <p className="amc-run" data-testid="agent-run" data-state={p.wakeRun.state}>
              <span>
                {wakeGoing ? t('Working · started by Lampo') : ended(p.wakeRun.state)}
                {!wakeGoing && p.wakeRun.state === 'finished' && p.wakeRun.exit ? ` · ${t('exit {code}', { code: p.wakeRun.exit })}` : ''}
              </span>
              <RunUse run={p.wakeRun} />
              <a className="how-agents" href={`/api/agent-runs/${enc(p.wakeRun.id)}/log`} target="_blank" rel="noreferrer">
                {t('Log')}
              </a>
            </p>
          )}
          {p.onAgentView && all && (
            <button
              type="button"
              className="btn sm ghost amc-all"
              onClick={() => {
                p.onAgentView?.();
                p.close();
              }}
            >
              {t('What the agent did')}
            </button>
          )}
        </section>
      )}
      {p.canAsk &&
        (p.asking ?? (
          <div className="amc-ask">
            <div className="amc-field">
              <input
                className="input"
                placeholder={t('Ask {name}…', { name })}
                aria-label={t('Ask {name}', { name: p.shown })}
                value={p.text}
                onChange={(e) => p.setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && p.text.trim() && p.onSend()}
                data-testid="agent-field"
              />
              <IconButton
                className="btn sm primary icon-only amc-send"
                label={t('Send')}
                icon="send"
                size={14}
                onClick={p.onSend}
                disabled={!p.text.trim()}
                data-testid="agent-send"
              />
            </div>
          </div>
        ))}
    </div>
  );
}
