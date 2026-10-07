// What an agent is doing right now, from what Lampo sees anyway (server/activity.ts): the calls it makes, the output of
// a run Lampo started, a render still being written, an upload. The agent spends no tokens on any of it. Asked for
// only where it is shown and after the first paint; SSE `agent-activity` refetches it (api/live.ts, at most once a
// second).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { compareTime } from '../../../lib/time.ts';
import { api } from '../api/client.ts';
import type { ActivityWords, AgentActivity, AgentActivityResponse, AgentLive, AgentRunInfo } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { ago, pct } from '../lib/format.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { type NoteAt, phrase, say } from './activityWords.ts';
import { RunLine } from './Wake.tsx';

// The sidebar's Agents section rides this chunk (it loads after the first paint anyway).
export { SidebarAgents } from './SidebarAgents.tsx';

/** An agent's own words in the UI's language, for the cards' run lines once this module is here (RunLine.tsx). */
export const sayWords = (w: ActivityWords): string => say(w);

/** How long the latest action counts as "now". A wait is re-asked every few minutes while it lasts. */
const FRESH_MS = 90_000;
const WAIT_FRESH_MS = 15 * 60_000;
/** Earlier actions shown under the current one, at most; `SHOWN` lines in all until the person asks for the rest. */
const TIMELINE = 10;
const SHOWN = 3;

const fresh = (a: AgentActivity | null | undefined, now: number): boolean =>
  !!a && a.kind !== 'run' && now - (Date.parse(a.at) || 0) < (a.kind === 'wait' ? WAIT_FRESH_MS : FRESH_MS);

/** Re-renders every `ms` while `on`: "now" turns into "a minute ago" without new data. */
function useNow(on: boolean, ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [on, ms]);
  return now;
}

/** One video's agents, or (no slug) every agent's latest. `agent` names the one wanted even before it touched the video. */
export function useAgentActivity(slug: string | null, agent: string | null, enabled: boolean): AgentLive[] {
  const q = new URLSearchParams();
  if (slug) q.set('slug', slug);
  if (agent) q.set('agent', agent);
  return (
    useQuery({
      queryKey: ['agent-activity', slug ?? '', agent ?? ''],
      queryFn: () => api<AgentActivityResponse>(`/api/agent-activity${q.size ? `?${q}` : ''}`),
      enabled,
      staleTime: 5_000,
    }).data?.agents ?? []
  );
}

/**
 * The video's agent as the activity knows it: the assigned one when it did something, else whoever worked on the video
 * last. An agent can reach Lampo under another name than its assignment's (an MCP client without `by` is named after
 * its app), and someone working on the video is what the person wants to see.
 */
function pick(all: AgentLive[], agent: string | null): AgentLive | null {
  return all.find((a) => a.agent === agent && a.recent.length) ?? all.find((a) => a.slug && a.recent.length) ?? null;
}

/** What the video's agent is doing now (null when nothing happened for a while), ticking itself out of date. */
export function useAgentNow(slug: string, agent: string | null, enabled: boolean): AgentActivity | null {
  const current = pick(useAgentActivity(slug, agent, enabled), agent)?.current ?? null;
  const now = useNow(!!current);
  return fresh(current, now) ? current : null;
}

/** Every agent's current action by name (the sidebar's Agents rows): only the fresh ones. */
export function useAgentsNow(enabled: boolean): Map<string, AgentActivity> {
  const all = useAgentActivity(null, null, enabled);
  const now = useNow(all.length > 0);
  const m = new Map<string, AgentActivity>();
  for (const a of all) if (a.current && fresh(a.current, now)) m.set(a.agent, a.current);
  return m;
}

/**
 * A board card's line while an agent works on its video: the turning keyframe, the agent, and what it is doing now — a
 * render still being written on the machine included ("Rendering… 340 MB") —, or that it is on it. With no agent at
 * it, the card's own line (`children`).
 */
export function CardAgentLine({
  slug,
  agent,
  working,
  watch,
  children,
}: {
  slug: string;
  agent: string | null;
  working: boolean;
  /** Ask for the video's activity (a card in "Being fixed"); other cards ask nothing. */
  watch: boolean;
  children: ReactNode;
}) {
  // the agent menu's own reading of the video (useAgentNow): its assigned agent, else whoever worked on it last
  // (a query switched off still answers from the cache — the agent menu's, say: only a card that asks shows it)
  const cached = useAgentNow(slug, agent, watch);
  const live = watch ? cached : null;
  if (!live && !working) return <>{children}</>;
  return <AgentOnIt agent={live?.agent ?? agent} step={live ? stepLine(live) : null} />;
}

/** The working line itself (also what a card shows before this module arrives: no step yet). */
export function AgentOnIt({ agent, step }: { agent: string | null; step: string | null }) {
  const words = step ?? (agent ? t('is working on it') : t('An agent is working on it'));
  return (
    <span className="bcard-agent" data-testid="bcard-agent" title={agent ? `${agent} · ${words}` : words}>
      <KeyGlyph shape="ease" className="nav-kg live" />
      <span className="bcard-text">
        {agent && <b>{agent}</b>} {step ? `· ${step}` : words}
      </span>
    </span>
  );
}

/** An Agents row's words while the agent does something with no work open on a video (the sidebar): the state in a
 * word or two and how far, its step whole in the title. `idle`: what it says while the agent does nothing ("ready"). */
export function AgentNowText({ agent, idle = null }: { agent: string; idle?: string | null }) {
  const now = useAgentsNow(true).get(agent);
  if (!now)
    return idle ? (
      <span className="nav-now" data-testid="agent-now-row" data-phase="ready">
        {idle}
      </span>
    ) : null;
  const tight = activityShort(now);
  return <NavNow agent={agent} words={tight.words} figure={tight.figure} full={stepLine(now)} />;
}

/** An Agents row's state after the agent's name (the sidebar): its words give way with an ellipsis, the figure never.
 * `full` says it all — in the title after the agent's name, and to screen readers in place of the short words. */
export function NavNow({ agent, words, figure, full, phase }: { agent: string; words: string; figure?: string | null; full: string; phase?: string }) {
  return (
    <span className="nav-now" data-testid="agent-now-row" data-phase={phase} title={`${agent} · ${full}`}>
      <span className="nav-now-words" aria-hidden="true">
        {words}
      </span>
      {figure && (
        <span className="nav-now-fig" aria-hidden="true">
          {figure}
        </span>
      )}
      <span className="sr-only">{full}</span>
    </span>
  );
}

/**
 * What an agent is doing where nothing of its work is open (the sidebar's rows, the agent button), as a tight place says
 * it: a word for the state — ready while it only waits for notes, working else, rendering or uploading while one says
 * how far — and that figure. Never its step or its own sentence: those go whole into the place's title (`stepLine`).
 */
export function activityShort(a: AgentActivity): { words: string; figure: string | null } {
  const far = howFar(a);
  if (a.kind === 'wait') return { words: t('ready'), figure: null };
  if (far !== null && a.kind === 'upload') return { words: t('uploading'), figure: pct(far / 100) };
  if (far !== null) return { words: t('rendering'), figure: pct(far / 100) };
  return { words: t('working'), figure: null };
}

/** An Agents row's keyframe: turning while the agent runs or did something a moment ago. */
export function AgentNowDot({ agent, active }: { agent: string; active: boolean }) {
  const doing = useAgentsNow(true).has(agent);
  const on = active || doing;
  return <KeyGlyph shape={on ? 'ease' : 'outline'} className={`nav-kg ${on ? 'live' : ''}`} />;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

/** An action's words with what moves on it: how far an upload is, since when a wait lasts. */
/** How far a render or an upload is (`vr render`'s progress, else an upload's percentage), while it goes on. */
const howFar = (a: { kind?: string; pct?: number; progress?: AgentActivity['progress'] }): number | null => {
  const p = a.progress?.pct ?? (a.kind === 'upload' ? a.pct : undefined);
  return p != null && p < 100 && (a.kind === 'upload' || a.kind === 'render') ? p : null;
};

export function activityLine(a: AgentActivity, noteAt?: NoteAt): string {
  const words = say(a, noteAt);
  const far = howFar(a);
  if (far !== null) return `${words} · ${pct(far / 100)}`;
  if (a.kind === 'wait' && a.since) return `${words} · ${t('since {time}', { time: clock(a.since) })}`;
  return words;
}

/** One line for small places (the agent button, the sidebar): the words without a quote. */
export const stepLine = (a: ActivityWords & { kind?: string; pct?: number; progress?: AgentActivity['progress'] }, noteAt?: NoteAt): string => {
  const far = howFar(a);
  return far !== null ? `${phrase(a, noteAt)} · ${pct(far / 100)}` : phrase(a, noteAt);
};

const compact = (n: number) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const usd = (n: number) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 3 : 2 }).format(n);

/** Tokens a run Lampo started reports (and its cost, only when it states it). */
function RunUse({ run }: { run: AgentRunInfo }) {
  const l = run.live;
  if (!l) return null;
  const used = l.tokens.input + l.tokens.output + l.tokens.cache_write;
  if (!used && !l.tokens.cache_read && l.cost_usd == null) return null;
  return (
    <div className="am-use" data-testid="agent-run-use">
      <span>{t('{count} tokens', { count: compact(used) })}</span>
      {l.tokens.cache_read > 0 && <span>{t('{count} from cache', { count: compact(l.tokens.cache_read) })}</span>}
      {l.cost_usd != null && <span>{usd(l.cost_usd)}</span>}
    </div>
  );
}

/**
 * The agent menu's Live part: what it is doing now (a turning keyframe while it works), the actions before it with
 * their times — three lines in all, the rest on request —, and for a run Lampo started its tokens, Stop and Log.
 * Nothing at all before an agent did anything. `noteAt` names a note by its moment instead of its id.
 */
export function LiveSection({
  slug,
  agent,
  run,
  enabled,
  noteAt,
}: {
  slug: string;
  agent: string;
  run: AgentRunInfo | null;
  enabled: boolean;
  noteAt?: NoteAt;
}) {
  const [all, setAll] = useState(false);
  const mine = pick(useAgentActivity(slug, agent, enabled), agent);
  const recent = mine?.recent ?? [];
  const going = run?.state === 'running';
  const now = useNow(recent.length > 0 || going);
  const head = recent[0] ?? null;
  const working = going || fresh(head, now);
  const total = Math.min(recent.length, TIMELINE + 1);
  if (!head && !run) return null;
  // While a run goes, its own step is the newest thing known (the activity follows within a second).
  const step = going && run?.live?.step && (!head || compareTime(run.live.updated, head.at) > 0) ? run.live.step : null;
  return (
    <div className="am-live" data-testid="agent-live" data-working={working || undefined}>
      <div className="label">
        {working ? t('Live') : t('Latest')}
        {mine && mine.agent !== agent ? ` · ${mine.agent}` : ''}
      </div>
      {(head || step) && (
        <div className="am-now" data-testid="agent-now">
          <KeyGlyph shape={working ? 'ease' : 'outline'} className={`nav-kg ${working ? 'live' : ''}`} />
          <span className="am-now-text">{step ? say(step, noteAt) : head && activityLine(head, noteAt)}</span>
          {head && !step && <span className="am-when">{ago(head.at)}</span>}
        </div>
      )}
      {recent.length > 1 && (
        <ol className="am-timeline" data-testid="agent-timeline">
          {recent.slice(1, all ? TIMELINE + 1 : SHOWN).map((a) => (
            <li key={`${a.at}-${a.text}`} data-kind={a.kind}>
              <time dateTime={a.at}>{clock(a.at)}</time>
              <span className="ellipsis" title={activityLine(a, noteAt)}>
                {activityLine(a, noteAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {total > SHOWN && (
        <button type="button" className="btn sm ghost am-more" onClick={() => setAll(!all)} aria-expanded={all} data-testid="agent-log-more">
          {all ? t('Show fewer') : t('Show all {n}', { n: total })}
        </button>
      )}
      {run && <RunUse run={run} />}
      {run && <RunLine run={run} />}
    </div>
  );
}
