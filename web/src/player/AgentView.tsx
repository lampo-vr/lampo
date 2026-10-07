// The side panel's Agent view: the agent's work on this video, whole. Its plan is the person's own notes (each with
// where it stands: next, on it, fixed, asked you), then what it is doing now — its own words to the person quoted,
// quietly, until its next step —, the steps it took (five, the rest in the same box), how it ended, and "Tell it…".
// Earlier work is named by what it made ("V4 · Claude Code · 12 min · 5 fixed"). Never an id, never hidden reasoning
// (the data has none), never the noun for it. Loaded when it is first opened (Player.tsx); its styles come with it.
import { useState } from 'react';
import { compareTime } from '../../../lib/time.ts';
import type { PlacedComment, Run, RunDetail, RunPlanItem, RunStepLine, SessionRef } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { pct, secsWords } from '../lib/format.ts';
import { toastError } from '../lib/toast.ts';
import { PermissionNeeds, PrintedLines } from '../sessions/RunNeeds.tsx';
import { clock, isOpen, madeBy, phaseOf, planCounts, type RunLike, type Say, workedNow } from '../sessions/runWords.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { firstLine } from './noteRows.ts';
import '../styles/agentview.css';

/** Steps shown before "Show all"; the box keeps their height after it (the rest scroll inside). */
const SHOWN = 5;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

export interface AgentViewProps {
  slug: string;
  /** The video's runs, newest first (undefined while they load). */
  runs: Run[] | undefined;
  /** The one to show first: the strip's, else the newest. */
  current: RunLike | null;
  /** A run asked for by name elsewhere (the version picker's "Steps"). */
  pick: string | null;
  /** The shown run's kept steps (Player.tsx asks for them: this chunk carries no query code). */
  detail: RunDetail | undefined;
  onPick: (id: string | null) => void;
  asOf: number;
  session: SessionRef | null;
  /** Who is looking: "started by you". */
  me: string | null;
  notes: PlacedComment[];
  latestV: number;
  /** Stop, Try again and Tell it… are the agents right's. */
  canSteer: boolean;
  /** The agent hears a message now (it listens, or a run Lampo started reads it). */
  reachable: boolean;
  say: Say;
  onNote: (id: string) => void;
  onAnswer: (note: string | null) => void;
  /** The person's writes (Player.tsx: api/runs.ts and the request), passed in so this chunk carries none of them. */
  act: AgentActs;
}

/** Stop, Try again (Send again) and Tell it…, with whether one is on its way. */
export interface AgentActs {
  stop: (id: string) => Promise<unknown>;
  retry: (id: string) => Promise<unknown>;
  tell: (text: string) => Promise<unknown>;
  busy: boolean;
  telling: boolean;
}

/** A plan note's glyph and its word. */
function planLook(p: RunPlanItem): { shape: 'outline' | 'ease' | 'half' | 'diamond' | 'hold'; tone: string; word: string } {
  switch (p.state) {
    case 'doing':
      return { shape: 'ease', tone: 'live', word: t('on it') };
    case 'fixed':
      return { shape: 'half', tone: 'ok', word: t('fixed') };
    case 'asked':
      return { shape: 'diamond', tone: 'ask', word: t('asked you') };
    case 'wontfix':
      return { shape: 'hold', tone: 'quiet', word: t('left as is') };
    case 'replied':
      return { shape: 'diamond', tone: 'quiet', word: t('replied') };
    default:
      return { shape: 'outline', tone: 'quiet', word: t('next') };
  }
}

/** "started by you at 14:05", "started by Mia at 14:05", "started by Claude Code" (an agent's own write). */
function startedLine(r: RunLike & Partial<Pick<Run, 'opened_by'>>, me: string | null): string {
  const at = timeOf(r.started);
  const by = r.opened_by;
  if (!by) return t('started at {time}', { time: at });
  if (by.how === 'agent') return t('started by {name} at {time}', { name: r.agent.name, time: at });
  if (me && by.who === me) return t('started by you at {time}', { time: at });
  return t('started by {name} at {time}', { name: by.who, time: at });
}

export function AgentView(p: AgentViewProps) {
  const [text, setText] = useState('');
  const shown: RunLike | null = (p.pick && p.runs?.find((r) => r.id === p.pick)) || p.current || p.runs?.[0] || null;
  const whole = shown && 'plan' in shown ? shown : (p.runs?.find((r) => r.id === shown?.id) ?? null);
  const detail = p.detail?.run.id === shown?.id ? p.detail : undefined;
  const run = detail?.run ?? whole ?? shown;
  const name = run?.agent.name ?? p.session?.name ?? t('the agent');
  const others = (p.runs ?? []).filter((r) => r.id !== run?.id);
  const tell = async () => {
    const words = text.trim();
    if (!words) return;
    try {
      await p.act.tell(words);
      setText('');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="av" data-testid="agent-view">
      <div className="av-scroll">
        {!run ? (
          p.runs === undefined && p.current ? (
            <AgentViewPending />
          ) : (
            <EmptyState size="sm" className="av-empty" art="agents" title={t('Nothing from {name} here yet', { name })}>
              {t('Send your notes: what it does with each one shows here, step by step.')}
            </EmptyState>
          )
        ) : (
          <Shown
            run={run}
            whole={whole ?? (detail?.run as Run | undefined) ?? null}
            steps={detail?.steps}
            props={p}
            onStop={() => p.act.stop(run.id).catch(toastError)}
            onRetry={() => p.act.retry(run.id).catch(toastError)}
            busy={p.act.busy}
          />
        )}
        {others.length > 0 && (
          <section className="av-sec" aria-label={t('Earlier')}>
            <div className="av-label">{t('Earlier')}</div>
            <ul className="av-history" data-testid="agent-history">
              {others.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <button type="button" className="av-hrow" onClick={() => p.onPick(r.id)}>
                    <span className="av-hv">{r.result?.v ? `V${r.result.v}` : timeOf(r.started)}</span>
                    <span className="av-htext">{historyLine(r)}</span>
                    <I name="right" size={13} className="av-go" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {p.canSteer && (p.session || run) && (
        <form
          className="av-tell"
          onSubmit={(e) => {
            e.preventDefault();
            void tell();
          }}
        >
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('Tell {name}…', { name })}
            aria-label={t('Tell {name}…', { name })}
            data-testid="agent-tell"
          />
          <button type="submit" className="btn sm" disabled={!text.trim() || p.act.telling} aria-label={t('Send')}>
            <I name="send" size={14} />
          </button>
          {!p.reachable && <p className="av-tell-note">{t('It reads this when it next checks in.')}</p>}
        </form>
      )}
    </div>
  );
}

/** Earlier work in a line: what it made, or what it did ("Claude Code asked 1 question · 3 min"). */
function historyLine(r: Run): string {
  if (r.result?.v) return madeBy(r);
  if (r.state === 'failed') return t('{name} stopped · it failed', { name: r.agent.name });
  if (r.state === 'stopped') return t('Stopped after {time}', { time: secsWords(Math.max(1, r.worked_s)) });
  if (r.result?.asked)
    return `${t('{name} asked {n} question|{name} asked {n} questions', { name: r.agent.name, n: r.result.asked })} · ${secsWords(Math.max(1, r.worked_s))}`;
  return madeBy(r);
}

function Shown({
  run,
  whole,
  steps,
  props: p,
  onStop,
  onRetry,
  busy,
}: {
  run: RunLike;
  whole: Run | null;
  steps: RunStepLine[] | undefined;
  props: AgentViewProps;
  onStop: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const [all, setAll] = useState(false);
  const open = isOpen(run);
  const phase = phaseOf(run);
  const plan = whole?.plan ?? [];
  const counts = planCounts(whole ?? run);
  const byId = new Map(p.notes.map((c) => [c.id, c]));
  // what it is doing now: its newest action, and what it said after it (a thought folds once the next step comes)
  const action = steps?.find((s) => s.type === 'action' || s.type === 'elicitation') ?? (run.now && run.now.type !== 'thought' ? run.now : null);
  const thoughtStep = steps?.[0]?.type === 'thought' ? steps[0] : run.now?.type === 'thought' ? run.now : null;
  const thought = thoughtStep && (!action || compareTime(thoughtStep.at, action.at) >= 0) ? thoughtStep : null;
  const prog = run.state === 'working' ? run.progress : null;
  const worked = workedNow(run, Date.now(), p.asOf);
  const where = whole?.agent.runner ? t('on {computer}', { computer: whole.agent.runner }) : null;
  return (
    <>
      <section className="av-head" aria-label={run.agent.name}>
        <p className="av-meta">{[startedLine(whole ?? run, p.me), clock(worked), where].filter(Boolean).join(' · ')}</p>
        {/* the strip above says Stop while it works; while it asks you, Answer is the strip's and Stop is here */}
        {run.state === 'needs_you' && run.ended == null && p.canSteer && (
          <button type="button" className="btn sm" onClick={onStop} disabled={busy} data-testid="agent-stop">
            <I name="stop" size={14} /> {t('Stop')}
          </button>
        )}
      </section>
      {whole?.request && <q className="av-request">{whole.request}</q>}

      {plan.length > 0 && (
        <section className="av-sec" aria-label={t('Your notes')}>
          <div className="av-label">
            <span>{t('Your {n} note|Your {n} notes', { n: plan.length })}</span>
            {/* the strip's count: the note it is on while it works, the ones answered once it ended */}
            <span className="av-count">
              {t('{n} of {total}', { n: open ? Math.min(counts.total, counts.answered + Math.max(1, counts.doing)) : counts.answered, total: counts.total })}
            </span>
          </div>
          <ul className="av-plan" data-testid="agent-plan">
            {plan.map((item) => {
              const c = byId.get(item.id);
              const look = planLook(item);
              const asks = item.state === 'asked';
              return (
                <li key={item.id} data-state={item.state}>
                  <button type="button" className="av-row" onClick={() => (asks ? p.onAnswer(item.id) : p.onNote(item.id))} data-testid="agent-plan-row">
                    <KeyGlyph shape={look.shape} className={`nav-kg run-kg ${look.tone}`} />
                    <span className="av-tc">{c ? (c.scope === 'video' ? t('Whole video') : c.timecodeHere) : '–'}</span>
                    <span className="av-text">{c ? firstLine(c.text) || t('(marked frame)') : t('A note')}</span>
                    <span className={`av-word ${look.tone}`}>
                      {item.added && item.state === 'todo' ? t('added') : look.word}
                      {asks && <I name="right" size={12} />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {open ? (
        <section className="av-sec av-now" aria-label={t('Now')} data-testid="agent-now-block">
          <div className="av-label">{t('Now')}</div>
          {prog ? (
            <div className="av-line">
              <KeyGlyph shape="ease" className="nav-kg run-kg live" />
              <span>
                {[
                  prog.pct != null ? pct(prog.pct / 100) : null,
                  prog.frames ? t('{done} of {total} frames', { done: prog.frames[0], total: prog.frames[1] }) : null,
                  prog.eta_s ? t('about {time} left', { time: secsWords(prog.eta_s) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || t('working')}
              </span>
            </div>
          ) : action ? (
            <div className="av-line">
              <KeyGlyph shape={phase === 'needs_you' ? 'diamond' : 'ease'} className={`nav-kg run-kg ${phase === 'needs_you' ? 'ask' : 'live'}`} />
              <span>{p.say(action)}</span>
            </div>
          ) : (
            <div className="av-line quiet">
              <KeyGlyph shape="outline" className="nav-kg run-kg quiet" />
              <span>{phase === 'queued' ? t('waiting for it to start') : t('nothing yet')}</span>
            </div>
          )}
          {thought && (
            <q className="av-thought" data-testid="agent-thought">
              {p.say({ ...thought, quote: undefined })}
            </q>
          )}
          {/* a permission it was refused: the exact rule to copy and where it goes ("How to allow it" opens this) */}
          {run.needs?.kind === 'permission' && <PermissionNeeds run={run} bare={!!action} />}
        </section>
      ) : (
        <Ended run={run} props={p} onRetry={onRetry} busy={busy} />
      )}

      <section className="av-sec" aria-label={t('Steps')}>
        <div className="av-label">{t('Steps')}</div>
        <ol className={`av-steps${all ? ' all' : ''}`} data-testid="agent-steps">
          {!steps
            ? ['70%', '52%', '64%', '44%', '58%'].map((w) => (
                <li key={w} className="av-step pending">
                  <SkLine w="2.6em" />
                  <SkLine w={w} />
                </li>
              ))
            : (all ? steps : steps.slice(0, SHOWN)).map((s) => (
                <li key={`${s.at}-${s.text}`} className={`av-step${s.type === 'thought' ? ' thought' : ''}${s.type === 'error' ? ' err' : ''}`}>
                  <time dateTime={s.at}>{timeOf(s.at)}</time>
                  <span className="av-step-text" title={p.say(s)}>
                    {s.type === 'thought' ? t('“{quote}”', { quote: p.say({ ...s, quote: undefined }) }) : p.say(s)}
                  </span>
                </li>
              ))}
        </ol>
        {steps && steps.length > SHOWN && (
          <button type="button" className="btn sm ghost av-more" onClick={() => setAll(!all)} aria-expanded={all} data-testid="agent-steps-more">
            {all ? t('Show fewer') : t('Show all {n}', { n: steps.length })}
          </button>
        )}
      </section>
    </>
  );
}

/** How it ended: what it made, why it failed, or that it was stopped — and what the person can do about it. */
function Ended({ run, props: p, onRetry, busy }: { run: RunLike; props: AgentViewProps; onRetry: () => void; busy: boolean }) {
  const res = run.result;
  if (run.state === 'done')
    return (
      <section className="av-sec av-end" aria-label={t('Done')} data-testid="agent-ended">
        <div className="av-label">{t('Done')}</div>
        <div className="av-line">
          <KeyGlyph shape="half" className="nav-kg run-kg ok" />
          <span>{res?.v ? `V${res.v} · ${madeBy(run)}` : madeBy(run)}</span>
        </div>
        {res?.summary && <q className="av-thought">{res.summary}</q>}
        {res?.tokens && (
          <p className="av-use">
            {t('{count} tokens', { count: compact(res.tokens.input + res.tokens.output + res.tokens.cache_write) })}
            {res.cost_usd != null ? ` · ${usd(res.cost_usd)}` : ''}
          </p>
        )}
      </section>
    );
  // it ended waiting for you: a permission it lacks (the rule, then Send again), or a question your answer sends on
  if (run.state === 'needs_you')
    return (
      <section className="av-sec av-end" aria-label={t('Needs you')} data-testid="agent-ended">
        <div className="av-label">{t('Needs you')}</div>
        {run.needs?.kind === 'permission' ? (
          <PermissionNeeds run={run} />
        ) : (
          <div className="av-line">
            <KeyGlyph shape="diamond" className="nav-kg run-kg ask" />
            <span>{t('It asked you · your answer sends it on')}</span>
          </div>
        )}
        {p.canSteer && run.needs?.kind === 'permission' && (
          <div className="av-acts">
            <button type="button" className="btn sm" onClick={onRetry} disabled={busy} data-testid="agent-retry">
              {t('Send again')}
            </button>
          </div>
        )}
      </section>
    );
  const failed = run.state === 'failed';
  return (
    <section className="av-sec av-end" aria-label={failed ? t('Failed') : t('Stopped')} data-testid="agent-ended">
      <div className="av-label">{failed ? t('Failed') : t('Stopped')}</div>
      <div className={`av-line${failed ? ' err' : ''}`}>
        <KeyGlyph shape="hold" className={`nav-kg run-kg ${failed ? 'err' : 'quiet'}`} />
        <span>
          {failed
            ? run.error
              ? p.say({ ...run.error, quote: undefined })
              : t('it stopped with an error')
            : run.stop_pending
              ? t('Stopped · it will notice at its next step')
              : t('Stopped after {time}', { time: secsWords(Math.max(1, run.worked_s)) })}
        </span>
      </div>
      {/* what the tool printed last, where it says what went wrong */}
      {failed && <PrintedLines words={run.error} />}
      {p.canSteer && (
        <div className="av-acts">
          <button type="button" className="btn sm" onClick={onRetry} disabled={busy} data-testid="agent-retry">
            {failed ? t('Try again') : t('Send again')}
          </button>
        </div>
      )}
    </section>
  );
}

const compact = (n: number) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const usd = (n: number) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 3 : 2 }).format(n);

/** The view while the video's work loads: the same sections, their lines on the way. */
export function AgentViewPending() {
  return (
    <div className="av-pending" aria-hidden="true">
      <p className="av-meta">
        <SkLine w="16em" />
      </p>
      <div className="av-label">
        <SkLine w="6em" />
      </div>
      {['62%', '48%', '56%'].map((w) => (
        <div key={w} className="av-row">
          <SkLine w={w} />
        </div>
      ))}
    </div>
  );
}
