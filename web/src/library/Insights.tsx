// #/insights — one question: why does a video take so many versions to approval, and what would cut that? Fewer rounds
// are less of the reviewer's time and fewer agent tokens. The page answers it in a sentence ("7.8 versions to approval,
// up from 5.1. SFX notes cause most of the rounds."), four tiles that serve it, then a card per part of the answer,
// each one sentence first, then rows: what causes the rounds (a click away from a rule agents follow), versions to
// approval per project against the target, what came back as still wrong, how often each agent is right the first
// time, what is stuck now (with the one thing to do about each), and — only when clients watched through review links
// — what they watched. One period (7 / 30 / 90 days, all time) drives it all, each figure against the period before.
// The page stands on the library's grid; every card speaks in one type scale (insights.css). Its code loads on its
// own (Library.tsx); InsightsFrame.tsx holds the frame and the loading state, the rows each card showed last time.
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { AGENT_KIND_LABELS, agentShown } from '../../../lib/agentKind.ts';
import type { AgentKind, BillingInfo } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { playbookHref } from '../api/playbooks.ts';
import { useBilling, useInfo, useInsights } from '../api/queries.ts';
import type {
  InsightsAgent,
  InsightsBoard,
  InsightsCause,
  InsightsCauses,
  InsightsStillWrong,
  InsightsStuck,
  InsightsToApproval,
  InsightsUnopened,
  InsightsWaitingOn,
  InsightsWatchedVideo,
  InsightsWatchViewer,
} from '../api/types.ts';
import { includes } from '../conversion/facts.ts';
import { InsightsExplained } from '../conversion/limits/InsightsExplained.tsx';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { tagLabel } from '../i18n/terms.ts';
import { ago, hoursWords, pct, secsWords } from '../lib/format.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { usePrefs } from '../lib/prefs.ts';
import { toast, toastError } from '../lib/toast.ts';
import { useFirstRun } from '../onboarding/state.ts';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { nextLabel } from '../status/stageText.ts';
import { AgentMark, I } from '../ui/icons.tsx';
import { Avatar } from '../ui/plain.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';
import { Skeleton } from '../ui/Skeleton.tsx';
import {
  AgentHeads,
  Card,
  EMPTY,
  InsightsBody,
  type Kpi,
  Kpis,
  Lead,
  PREFS,
  ProjectHeads,
  periodOf,
  RowEmpty,
  shapeFor,
  shapeOf,
  TasteLine,
} from './InsightsFrame.tsx';
import { chartLevelsOf, facts, num, secondsOf, whoName } from './insightsWords.ts';

const posterOf = (slug: string, hash: string | null) => (hash ? `/api/poster/${enc(slug)}.jpg?h=${hash.slice(0, 10)}` : null);
const videoHref = (slug: string, note?: string) => `#/v/${enc(slug)}${note ? `?c=${enc(note)}` : ''}`;
/** How far a client got, drawn: its own chunk, asked for when a row's toggle is pointed at or opened. */
const CHART = loader(() => import('./InsightsChart.tsx'));
const PARTIES: InsightsWaitingOn[] = ['you', 'agents', 'client'];
const bold = [(c: ReactNode) => <b>{c}</b>];
/** The agent's kind in words (its product's name; "MCP client" for any other). */
const kindLabel = (k: AgentKind | undefined) => (!k ? null : k === 'mcp' ? t('MCP client') : AGENT_KIND_LABELS[k]);
/** A topic as the page names it ("no topic" for notes without one; SFX as everyone writes it). */
const topicName = (tag: string) => (tag === 'untagged' ? t('no topic') : tag === 'sfx' ? 'SFX' : tagLabel(tag));
/** A topic at the start of a sentence. */
const Topic = (tag: string) => {
  const s = topicName(tag);
  return `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;
};
/** Rows a card lists at most (the rest are one line under them). */
const CAUSES = 6;
const BACK = 5;
const CLIENTS = 8;

/** Whether there are enough rounds to rank what caused them, and the topic that caused the most. */
const ranked = (c: InsightsCauses | undefined) => !!c && c.withNotes >= c.minRounds && c.topics.length > 0;

// ---------------------------------------------------------------- the headline and the tiles

/** The page's answer: versions to approval against the period before, and the topic behind the most rounds. With too
 * little history, what will show and after how many approvals. */
function leadOf(b: InsightsBoard): ReactNode {
  const a = b.toApproval;
  const c = b.causes;
  if (!a) return t('Versions to approval show here once videos are approved.');
  const top = ranked(c) ? (c?.topics[0] as InsightsCause) : null;
  const topic = top ? Topic(top.tag) : '';
  const cause = !top ? null : top.covered ? (
    <T k="<0>{topic} notes</0> cause the most rounds, even with a rule." values={{ topic }} tags={bold} />
  ) : top.share >= 0.5 ? (
    <T k="<0>{topic} notes</0> cause most of the rounds." values={{ topic }} tags={bold} />
  ) : (
    <T k="<0>{topic} notes</0> cause the most rounds." values={{ topic }} tags={bold} />
  );
  if (a.mean != null && a.n >= a.minApprovals) {
    const before = a.before?.n && a.before.mean != null ? a.before.mean : null;
    const values = { n: a.mean, x: num(a.mean), before: before == null ? '' : num(before) };
    const first =
      before == null ? (
        <T k="<0>{x} version to approval</0>.|<0>{x} versions to approval</0>." values={values} tags={bold} />
      ) : a.mean > before ? (
        <T k="<0>{x} version to approval</0>, up from {before}.|<0>{x} versions to approval</0>, up from {before}." values={values} tags={bold} />
      ) : a.mean < before ? (
        <T k="<0>{x} version to approval</0>, down from {before}.|<0>{x} versions to approval</0>, down from {before}." values={values} tags={bold} />
      ) : (
        <T k="<0>{x} version to approval</0>, as in the period before.|<0>{x} versions to approval</0>, as in the period before." values={values} tags={bold} />
      );
    return (
      <>
        {first} {a.mean <= a.target ? t('Within the target of {n} or fewer.', { n: a.target }) : cause}
      </>
    );
  }
  if (a.n > 0 && a.mean != null)
    return (
      <T
        k={
          '<0>{n} video approved</0> so far, at V{x}. The figure settles after {min} approvals.|<0>{n} videos approved</0> so far, at {x} versions on average. The figure settles after {min} approvals.'
        }
        values={{ n: a.n, x: num(a.mean), min: a.minApprovals }}
        tags={bold}
      />
    );
  if (a.open.videos > 0 && a.open.mean != null)
    return (
      <T
        k={
          'Nothing approved in this period yet: <0>{n} open video</0> is on V{v}.|Nothing approved in this period yet: <0>{n} open videos</0> are on V{v} on average.'
        }
        values={{ n: a.open.videos, v: Math.round(a.open.mean) }}
        tags={bold}
      />
    );
  return t('Versions to approval show here once videos are approved.');
}

function tilesOf(b: InsightsBoard): Kpi[] {
  const a = b.toApproval;
  const c = b.causes;
  const top = ranked(c) ? (c?.topics[0] as InsightsCause) : null;
  const f = b.firstTime;
  const r = b.turnaround;
  const most = r ? PARTIES.reduce((x, y) => ((r.parties[y] ?? 0) > (r.parties[x] ?? 0) ? y : x)) : null;
  const mostWords =
    r && most && r.parties[most]
      ? most === 'you'
        ? t('{time} of it on you', { time: hoursWords(r.parties[most]) })
        : most === 'agents'
          ? t('{time} of it on agents', { time: hoursWords(r.parties[most]) })
          : t('{time} of it out for review', { time: hoursWords(r.parties[most]) })
      : null;
  return [
    {
      id: 'versions',
      label: t('Versions to approval'),
      value: a?.mean != null ? num(a.mean) : '–',
      sub: a?.median != null ? t('median {m} · target ≤ {n}', { m: num(a.median), n: a.target }) : t('Target ≤ {n}', { n: a?.target ?? 3 }),
    },
    {
      id: 'top',
      label: top ? t('Rounds from {topic}', { topic: topicName(top.tag) }) : t('Rounds by topic'),
      value: top ? pct(top.share) : '–',
      sub: top ? t('{n} of {m} rounds', { n: top.rounds, m: c?.withNotes ?? 0 }) : t('After {n} rounds with notes', { n: c?.minRounds ?? 3 }),
    },
    {
      id: 'first',
      label: t('Right the first time'),
      value: f?.rate != null ? pct(f.rate) : '–',
      sub:
        f?.rate == null
          ? t('No fix checked yet')
          : f.before?.rate != null
            ? t('{p} the period before', { p: pct(f.before.rate) })
            : t('{right} of {checked} checked fixes', { right: f.right, checked: f.checked }),
    },
    {
      id: 'turnaround',
      label: t('Turnaround per round'),
      value: r?.median != null ? hoursWords(r.median) : '–',
      sub: r?.rounds ? (mostWords ?? t('{n} round|{n} rounds', { n: r.rounds })) : t('No new versions yet'),
    },
  ];
}

// ---------------------------------------------------------------- what causes the rounds

function causesAnswer(c: InsightsCauses): string {
  if (!c.rounds) return t('No new versions in this period.');
  if (!ranked(c)) return t('What causes the rounds shows after {n} rounds that follow notes: {k} so far.', { n: c.minRounds, k: c.withNotes });
  const [top] = c.topics as [InsightsCause];
  const covered = c.topics.slice(1, 3).find((x) => x.covered);
  const open = c.topics.slice(1, 3).find((x) => !x.covered);
  if (top.covered)
    return open
      ? t('{a} has a rule and still comes up most: sharpen it. A rule for {b} would cut the next most.', { a: Topic(top.tag), b: topicName(open.tag) })
      : t('{a} has a rule and still comes up most: sharpen it.', { a: Topic(top.tag) });
  return covered
    ? t('A rule for {a} would cut the most rounds. {b} has one and still comes up.', { a: topicName(top.tag), b: Topic(covered.tag) })
    : t('A rule for {a} would cut the most rounds.', { a: topicName(top.tag) });
}

function CauseRow({ c, top }: { c: InsightsCause; top: boolean }) {
  const can = useCan();
  return (
    <li className={`ins-row rc-row ${top ? 'top' : ''} ${c.covered ? 'covered' : ''}`} data-testid="rc-row">
      <span className="rc-topic" title={c.examples.map((x) => `“${x.text}”`).join('\n') || undefined}>
        <b>{Topic(c.tag)}</b>
        {/* each fact whole, the line wrapping between them: one ellipsis over the line cut "5 c…" mid-word */}
        <span className="rc-facts">
          {[
            c.covered && (
              <span key="still" className="rc-still" data-testid="rc-covered">
                {t('Rule exists — still {n} round|Rule exists — still {n} rounds', { n: c.rounds })}
              </span>
            ),
            !c.covered && t('{n} round|{n} rounds', { n: c.rounds }),
            !c.covered && c.must > 0 && t('{n} must-fix', { n: c.must }),
            c.back > 0 && t('{n} came back', { n: c.back }),
          ]
            .filter(Boolean)
            .map((x, i, all) => (
              <span key={typeof x === 'string' ? x : 'still'} className="rc-fact">
                {x}
                {i < all.length - 1 ? ' · ' : ''}
              </span>
            ))}
        </span>
      </span>
      <span className="rc-bar" aria-hidden="true">
        <span style={{ '--r': c.share } as CSSProperties} />
      </span>
      <span className="rc-num">{pct(c.share)}</span>
      <span className="rc-act">
        {c.covered ? (
          <a className={`btn sm ${top ? 'primary' : 'ghost'}`} href={playbookHref(c.scope)} data-testid="rc-open-rule">
            {t('Open the rule')}
          </a>
        ) : can('playbook') ? (
          <a className={`btn sm ${top ? 'primary' : 'ghost'}`} href={`${playbookHref(c.scope)}?rule=${enc(c.tag)}`} data-testid="rc-rule">
            {t('Make it a rule')}
          </a>
        ) : null}
      </span>
    </li>
  );
}

/** What else the rounds say, in one quiet line: the ones that followed only small things, the ones without a topic. */
function causesFoot(c: InsightsCauses): string | null {
  const small = c.severity.nice + c.severity.idea;
  const line = facts(
    small > 0 && t('{n} round followed only nice-to-haves and ideas|{n} rounds followed only nice-to-haves and ideas', { n: small }),
    c.untagged > 0 && t('{n} followed notes without a topic', { n: c.untagged }),
    c.rounds > c.withNotes && t('{n} came without notes', { n: c.rounds - c.withNotes }),
  );
  return line || null;
}

function Causes({ c }: { c: InsightsCauses }) {
  if (!ranked(c)) return <RowEmpty testId="ins-causes-empty">{EMPTY.causes()}</RowEmpty>;
  const foot = causesFoot(c);
  return (
    <>
      <ul className="ins-rows rc-list" data-testid="rc-list">
        {c.topics.slice(0, CAUSES).map((x, i) => (
          <CauseRow key={x.tag} c={x} top={i === 0} />
        ))}
      </ul>
      {foot && <p className="ins-foot">{foot}.</p>}
    </>
  );
}

// ---------------------------------------------------------------- versions to approval by project

/** Projects get a card of their own from two up (one project's figure is the tile's). */
const projectsShown = (a: InsightsToApproval | undefined) => (a && a.projects.length >= 2 ? a.projects : []);

function projectsAnswer(a: InsightsToApproval): string {
  const over = a.projects.filter((p) => (p.mean ?? p.openMean ?? 0) > a.target);
  const worst = a.projects[0];
  if (!over.length || !worst) return t('Every project gets to approval within the target.');
  const project = worst.project || t('Unsorted');
  return over.length === a.projects.length
    ? t('All {n} projects are over the target; {project} takes the most versions.', { n: a.projects.length, project })
    : t('{project} takes the most versions; {k} of {n} projects are over the target.', { project, k: over.length, n: a.projects.length });
}

function Projects({ a }: { a: InsightsToApproval }) {
  const list = projectsShown(a);
  const scale = Math.max(a.target + 1, ...list.map((p) => p.mean ?? p.openMean ?? 0)) * 1.05;
  const at = a.target / scale;
  return (
    <ul className="ins-rows pj-list" data-testid="pj-list" style={{ '--t': at } as CSSProperties}>
      <ProjectHeads target={a.target} at={at} />
      {list.map((p) => {
        const value = p.mean ?? p.openMean ?? 0;
        return (
          <li key={p.project} className={`ins-row pj-row ${p.n ? '' : 'open'}`} data-testid="pj-row">
            <span className="pj-name">
              <b>{p.project || t('Unsorted')}</b>
              <span>
                {facts(
                  p.n > 0 && t('{n} approved', { n: p.n }),
                  p.open > 0 && p.openMean != null && t('{n} open at V{v}|{n} open, at V{v} on average', { n: p.open, v: Math.round(p.openMean) }),
                )}
              </span>
            </span>
            <span className="pj-bar" aria-hidden="true">
              <span className="pj-fill" style={{ '--r': value / scale } as CSSProperties} />
            </span>
            <span className="pj-num">
              <b>{p.mean != null ? num(p.mean) : `V${Math.round(p.openMean ?? 0)}`}</b>
              <span>{p.median != null ? t('median {m}', { m: num(p.median) }) : t('none approved')}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- what came back

function backAnswer(s: InsightsStillWrong): string {
  const top = s.topics[0];
  if (s.count && top)
    return t('{n} fix came back as still wrong, most often on {topic}.|{n} fixes came back as still wrong, most often on {topic}.', {
      n: s.count,
      topic: topicName(top.tag),
    });
  return s.fixes ? t('No fix came back as still wrong in this period.') : t('Nothing was fixed in this period.');
}

/** The agents a topic came back from: two with their marks, and how many more. */
function BackAgents({ agents }: { agents: InsightsStillWrong['topics'][number]['agents'] }) {
  return (
    <span className="bk-agents">
      {agents.slice(0, 2).map((a) => (
        <span key={a.name} className="bk-agent">
          <span className="bk-mark" data-kind={a.kind}>
            <AgentMark kind={a.kind} size={12} />
          </span>
          {a.n > 1 ? `${agentShown(a.name, a.kind)} ×${a.n}` : agentShown(a.name, a.kind)}
        </span>
      ))}
      {agents.length > 2 && <span className="ag-more">+{agents.length - 2}</span>}
    </span>
  );
}

function Back({ s }: { s: InsightsStillWrong }) {
  if (!s.topics.length) return <RowEmpty testId="ins-back-empty">{EMPTY.back()}</RowEmpty>;
  return (
    <ul className="ins-rows bk-list" data-testid="bk-list">
      {s.topics.slice(0, BACK).map((x) => (
        <li key={x.tag} className="ins-row bk-row" data-testid="bk-row">
          <span className="bk-topic">
            <b>{Topic(x.tag)}</b>
            <span>{t('{n} came back', { n: x.n })}</span>
          </span>
          {x.example ? (
            <a className="bk-example" href={videoHref(x.example.slug, x.example.id)}>
              <q className="bk-quote">{x.example.text}</q>
              <span className="bk-why">{facts(x.example.reason && `“${x.example.reason}”`, x.example.video)}</span>
            </a>
          ) : (
            <span className="bk-example" />
          )}
          <BackAgents agents={x.agents} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- agents: right the first time

function agentAnswer(agents: InsightsAgent[]): string {
  const checked = agents.filter((a) => a.rate != null);
  const [a, b] = checked;
  if (a && b)
    return t('{a} gets {p} right the first time, {b} {q}.', {
      a: a.name,
      p: pct(a.rate ?? 0),
      b: b.name,
      q: pct(b.rate ?? 0),
    });
  if (a) return t('{name} gets {p} right the first time.', { name: a.name, p: pct(a.rate ?? 0) });
  const top = agents[0];
  if (top?.fixes) return t('{name} made {n} fixes; none checked yet.', { name: top.name, n: top.fixes });
  return t('No agent fixed anything in this period.');
}

/** Topics that came back, most first: two chips (they fit the column) and how many more. */
const CHIPS = 2;

/**
 * One agent: its mark, name and kind, how much it did; then how its fixes held up — the share that looked right the
 * first time as one bar with its fraction —, how long a fix typically takes, and the topics that came back as still
 * wrong (only when some did). The column heads stand once above the list where the card is wide; narrower, each
 * measure says what it is in its own line.
 */
function AgentRow({ a }: { a: InsightsAgent }) {
  const back = a.wrongTopics;
  return (
    <li className="ins-row ag-row" data-testid="ag-row">
      <span className="ag-who">
        <span className="ag-mark" data-kind={a.kind}>
          <AgentMark kind={a.kind} size={16} />
        </span>
        <span className="ag-name">
          <b>{agentShown(a.name, a.kind)}</b>
          <span>
            {facts(
              kindLabel(a.kind),
              a.fixes > 0 && t('{n} fix|{n} fixes', { n: a.fixes }),
              a.questions > 0 && t('{n} question|{n} questions', { n: a.questions }),
            )}
          </span>
        </span>
      </span>
      <span className="ag-rate">
        {a.rate == null ? (
          <span className="ag-quiet">{a.fixes ? t('Not checked yet') : t('No fixes')}</span>
        ) : (
          <>
            <span className="ag-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(a.rate * 100)}%` }} />
            </span>
            <b>{pct(a.rate)}</b>
            <span className="ag-frac">{t('{right} of {checked}', { right: a.right, checked: a.checked })}</span>
            <span className="ag-cap">{t('right the first time')}</span>
          </>
        )}
      </span>
      <span className="ag-time">
        {a.fixHours == null ? (
          <span className="ag-quiet ag-none">–</span>
        ) : (
          <>
            <b>{hoursWords(a.fixHours)}</b>
            <span className="ag-cap">{t('to fix, typically')}</span>
          </>
        )}
      </span>
      <span className="ag-back">
        {back.length > 0 && (
          <>
            <span className="ag-cap">{t('Came back:')}</span>
            {back.slice(0, CHIPS).map((x) => (
              <span key={x.tag} className="ch" data-testid="ag-back">
                {x.n > 1 ? `${tagLabel(x.tag)} ×${x.n}` : tagLabel(x.tag)}
              </span>
            ))}
            {back.length > CHIPS && <span className="ag-more">+{back.length - CHIPS}</span>}
          </>
        )}
      </span>
    </li>
  );
}

/** What an agent's row shows besides its name, for the loading state to keep its lines (narrow cards give each measure
 * a line): 0 = no fixes (no time to fix), 1 = fixes, 2 = fixes and topics that came back. */
const agentLinesOf = (a: InsightsAgent) => (!a.fixes ? 0 : a.wrongTopics.length ? 2 : 1);

function TasteModal({ onClose }: { onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['taste', 'all'], queryFn: () => api<{ scope: string; markdown: string }>('/api/taste') });
  return (
    <Modal title={t('What agents read before they start')} onClose={onClose} width={640}>
      <p className="muted ins-modal-sub">
        <T k={'Built from your notes. Agents get it per project with <0>lampo taste</0> or the MCP tool <0>get_taste</0>.'} tags={[(c) => <code>{c}</code>]} />
      </p>
      {error ? (
        <p className="muted">{(error as Error).message}</p>
      ) : !data ? (
        <Skeleton w="100%" h={180} r={8} />
      ) : (
        <pre className="ins-taste" data-testid="insights-taste">
          {data.markdown}
        </pre>
      )}
    </Modal>
  );
}

function Agents({ agents }: { agents: InsightsAgent[] }) {
  const [taste, setTaste] = useState(false);
  // someone new who hasn't connected one yet is shown the way (the first run's step)
  const run = useFirstRun();
  const connect = run.shown && run.steps.some((s) => s.id === 'agent' && !s.done);
  return (
    <>
      {!agents.length ? (
        <RowEmpty testId="ins-agents-empty">
          {connect ? (
            <T
              k="<0>Connect an agent</0>: the fixes it makes, and how they hold up when you check them, show up here."
              tags={[(c) => <a href="#/settings/mcp">{c}</a>]}
            />
          ) : (
            EMPTY.agents()
          )}
        </RowEmpty>
      ) : (
        <ul className="ins-rows ag-list" data-testid="ag-list">
          <AgentHeads />
          {agents.map((a) => (
            <AgentRow key={a.name} a={a} />
          ))}
        </ul>
      )}
      <TasteLine>
        <button type="button" onClick={() => setTaste(true)} data-testid="insights-taste-open">
          {t('See what agents read')}
        </button>
      </TasteLine>
      {taste && <TasteModal onClose={() => setTaste(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- where it's stuck now

/** Whom a row waits on: the agent's name, out for review (through a review link), or you. */
const onWhom = (s: InsightsStuck) =>
  s.waitingOn === 'agents' ? t('On {name}', { name: s.agent || t('Agent') }) : s.waitingOn === 'client' ? t('Out for review') : t('On you');

function stuckAnswer(stuck: InsightsStuck[]): string {
  const top = stuck[0];
  if (!top) return t('Nothing waits on anyone right now.');
  const time = hoursWords(top.hours);
  return top.waitingOn === 'you'
    ? t('{video} has waited longest: {time} on you.', { video: top.video, time })
    : top.waitingOn === 'client'
      ? t('{video} has waited longest: {time} out for review.', { video: top.video, time })
      : t('{video} has waited longest: {time} on {agent}.', { video: top.video, time, agent: top.agent || t('an agent') });
}

/** What a stuck video waits for, in one phrase that doesn't repeat whom it waits on. */
function stepWords(s: InsightsStuck): string {
  if (s.waitingOn === 'client') return /open the link/.test(s.label) ? t('Hasn’t opened the link') : t('Their decision');
  if (s.waitingOn === 'agents') return s.kind === 'wait_agent' ? t('Working on it') : t('The fixes');
  return nextLabel({ kind: s.kind ?? 'none', label: s.label });
}

/** What the agent reads when it is nudged from here (agent-facing text stays English, like everything agents parse). */
const nudgeText = (s: InsightsStuck) =>
  `A nudge from Insights: ${s.video} has waited ${Math.max(1, Math.round(s.hours))} h for your fixes. Please pick up its open notes.`;

/** The one thing to do about a stuck video: nudge its agent, send a reminder through the review link, or open it. */
function StuckAction({ s }: { s: InsightsStuck }) {
  const can = useCan();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [link, setLink] = useState(false);
  if (s.waitingOn === 'agents' && s.agent && can('agents'))
    return (
      <button
        type="button"
        className="btn sm"
        disabled={state !== 'idle'}
        data-testid="st-nudge"
        onClick={() => {
          setState('busy');
          api(`/api/review/${enc(s.slug)}/request`, { method: 'POST', body: { text: nudgeText(s) } }).then(
            () => {
              setState('done');
              toast(t('Nudged {name}', { name: s.agent ?? '' }));
            },
            (e: unknown) => {
              setState('idle');
              toastError(e);
            },
          );
        }}
      >
        <I name={state === 'done' ? 'check' : 'send'} size={14} /> {state === 'done' ? t('Nudged') : t('Nudge agent')}
      </button>
    );
  if (s.waitingOn === 'client' && can('share'))
    return (
      <>
        <button type="button" className="btn sm" onClick={() => setLink(true)} data-testid="st-remind">
          <I name="link" size={14} /> {t('Send a reminder')}
        </button>
        {link && <LazyShareModal slug={s.slug} name={s.video} onClose={() => setLink(false)} />}
      </>
    );
  return (
    <a className="btn sm" href={videoHref(s.slug)} data-testid="st-open">
      {t('Open video')}
    </a>
  );
}

function Stuck({ stuck }: { stuck: InsightsStuck[] }) {
  if (!stuck.length) return <RowEmpty testId="ins-stuck-empty">{EMPTY.stuck()}</RowEmpty>;
  return (
    <ul className="ins-rows st-list" data-testid="st-list">
      {stuck.map((s) => {
        const src = posterOf(s.slug, s.hash);
        return (
          <li key={s.slug} className="ins-row st-row" data-testid="st-row">
            <a className="st-video" href={videoHref(s.slug)}>
              <span className="st-thumb">{src && <img src={src} alt="" loading="lazy" />}</span>
              <span className="st-name">
                <b>{s.video}</b>
                <span>{stepWords(s)}</span>
              </span>
            </a>
            <span className="st-who" data-on={s.waitingOn}>
              {onWhom(s)}
            </span>
            <span className="st-for">{hoursWords(s.hours)}</span>
            <span className="st-act">
              <StuckAction s={s} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- clients

interface ClientSeen {
  video: InsightsWatchedVideo;
  viewer: InsightsWatchViewer;
}

/** Every client who watched through a review link in the period, the most recent first. */
const clientsOf = (b: InsightsBoard): ClientSeen[] =>
  (b.watching?.videos ?? [])
    .flatMap((video) => video.viewers.filter((x) => x.kind === 'client').map((viewer) => ({ video, viewer })))
    .sort((x, y) => Date.parse(y.viewer.last) - Date.parse(x.viewer.last));

function clientsAnswer(list: ClientSeen[]): string {
  const again = list.find((x) => x.viewer.again);
  if (again?.viewer.again)
    return t('{name} went back to {stretch} of {video} again and again.', {
      name: whoName(again.viewer),
      stretch: secondsOf(again.viewer.again, again.video.duration),
      video: again.video.video,
    });
  const [first] = list;
  if (!first) return '';
  return t('{name} watched {p} of {video}.', {
    name: whoName(first.viewer),
    p: pct(first.viewer.vWatched ?? first.viewer.watched ?? 0),
    video: first.video.video,
  });
}

type Run = { kind: 'none' | 'seen' | 'again'; len: number };

/** One client's view of a version in runs: what they didn't play, what they played, what they watched again and again. */
function runsOf(plays: number[], again: InsightsWatchViewer['again']): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < 100; i++) {
    const kind: Run['kind'] = again && i >= again.from && i <= again.to ? 'again' : (plays[i] ?? 0) > 0 ? 'seen' : 'none';
    const last = out.at(-1);
    if (last && last.kind === kind) last.len++;
    else out.push({ kind, len: 1 });
  }
  return out;
}

/** The version from start to end: the parts played in ink, the stretch watched again and again in the brand's orange. */
function WatchLane({ plays, again, label }: { plays: number[]; again: InsightsWatchViewer['again']; label: string }) {
  return (
    <span className="wv-lane" role="img" aria-label={label} data-testid="wv-lane">
      {runsOf(plays, again).map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs in order along the version, never reordered
        <i key={i} className={r.kind} style={{ flexGrow: r.len, '--s': 1 } as CSSProperties} />
      ))}
    </span>
  );
}

/** A client's watching as the chart draws a video: one viewer, their plays, their stretch watched again. */
const chartOf = ({ video, viewer }: ClientSeen): InsightsWatchedVideo => {
  const plays = viewer.plays ?? [];
  const seen = plays.map((p) => (p > 0 ? 1 : 0));
  return {
    ...video,
    viewers: [{ ...viewer, watched: viewer.vWatched ?? viewer.watched }],
    seenBy: 1,
    heat: seen,
    plays,
    retention: seen,
    rewatched: viewer.again ? [viewer.again] : [],
    completion: viewer.vWatched ?? viewer.watched,
  };
};

function ClientRow({ x, open, onOpen }: { x: ClientSeen; open: boolean; onOpen: () => void }) {
  const { video, viewer } = x;
  const chart = useLoaded(CHART, open);
  const share = viewer.vWatched ?? viewer.watched ?? 0;
  const plays = viewer.plays ?? [];
  const againWords = viewer.again ? t('again at {stretch}', { stretch: secondsOf(viewer.again, video.duration) }) : null;
  const v = viewer.v ?? video.v;
  return (
    <li className={`ins-row cl-row ${open ? 'open' : ''}`} data-testid="cl-row">
      <span className="cl-who">
        <Avatar name={viewer.name || whoName(viewer)} size={24} kind="client" />
        <span className="cl-name">
          <b>{whoName(viewer)}</b>
          <span>{facts(viewer.link && t('via {link}', { link: viewer.link }), ago(viewer.last))}</span>
        </span>
      </span>
      <a className="cl-video" href={videoHref(video.slug)}>
        <b>{video.video}</b>
        <span>{facts(`V${v}`, v < video.v && t('V{v} is newer', { v: video.v }))}</span>
      </a>
      <span className="wv-done">
        <span className="wv-done-line">
          {plays.length ? (
            <WatchLane plays={plays} again={viewer.again} label={facts(t('{p} watched', { p: pct(share) }), againWords)} />
          ) : (
            <span className="wv-lane unseen" aria-hidden="true" />
          )}
        </span>
        {againWords && (
          <span className="wv-again" data-testid="wv-again">
            <i aria-hidden="true" />
            {againWords}
          </span>
        )}
      </span>
      <span className="wv-num">
        <b>{pct(share)}</b>
        <span>{facts(secsWords(viewer.secs), t('{n}×', { n: viewer.sessions }))}</span>
      </span>
      {plays.length > 0 ? (
        <IconButton
          className={`btn ghost sm icon-only wv-toggle ${open ? 'on' : ''}`}
          label={t('How far {name} got in {video}', { name: whoName(viewer), video: video.video })}
          tip={open ? t('Hide how far they got') : t('How far they got')}
          icon="down"
          size={14}
          aria-expanded={open}
          onPointerEnter={() => CHART.load()}
          onFocus={() => CHART.load()}
          onClick={onOpen}
          data-testid="wv-toggle"
        />
      ) : (
        <span className="btn ghost sm icon-only wv-toggle ins-ghost" aria-hidden="true" />
      )}
      {open && plays.length > 0 && (
        <div className="wv-detail">
          {chart ? <chart.default v={chartOf(x)} /> : <div className="wc" style={{ '--lvls': chartLevelsOf(chartOf(x)) } as CSSProperties} />}
        </div>
      )}
    </li>
  );
}

/** Review links nobody has opened yet: what they cover, and when they were sent. */
function Unopened({ links }: { links: InsightsUnopened[] }) {
  if (!links.length) return null;
  return (
    <div className="ins-unopened" data-testid="ins-unopened">
      <h3 className="ins-label">{t('Review links not opened yet')}</h3>
      <ul className="ins-rows un-list">
        {links.map((u) => (
          <li key={`${u.label}-${u.created}`} className="ins-row un-row">
            <a className="un-name" href={u.slug ? videoHref(u.slug) : u.folder ? `#/folder/${enc(u.folder)}` : '#/'}>
              <I name="link" size={14} className="un-icon" />
              <b>{u.label}</b>
              <span>{u.video ?? u.folder}</span>
            </a>
            <span className="un-when">{t('sent {when}', { when: ago(u.created) })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Clients({ list, unopened }: { list: ClientSeen[]; unopened: InsightsUnopened[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <ul className="ins-rows cl-list" data-testid="cl-list">
        {list.slice(0, CLIENTS).map((x) => {
          const key = `${x.viewer.key}|${x.video.slug}`;
          return <ClientRow key={key} x={x} open={open === key} onOpen={() => setOpen((k) => (k === key ? null : key))} />;
        })}
      </ul>
      <Unopened links={unopened} />
    </>
  );
}

// ---------------------------------------------------------------- the page

/**
 * On a plan without Insights (the billing provider says so, conversion/facts.ts) the page explains what they would show
 * instead (conversion/limits/InsightsExplained.tsx), and asks for no Insights at all; otherwise the page.
 */
export default function Insights({ pending = false }: { pending?: boolean }) {
  const info = useInfo(!pending);
  const billing = useBilling(!pending && !!info?.billing).data as BillingInfo | undefined;
  if (billing && !includes(billing, 'insights')) return <InsightsExplained b={billing} />;
  return <InsightsPage pending={pending} />;
}

function InsightsPage({ pending = false }: { pending?: boolean }) {
  const [prefs, setPref] = usePrefs(PREFS);
  const period = periodOf(prefs.period);
  const { data, isPlaceholderData } = useInsights(period, !pending);
  const b = data?.board ?? null;
  const clients = b ? clientsOf(b) : [];
  const projects = projectsShown(b?.toApproval);
  const causeRows = b?.causes && ranked(b.causes) ? Math.min(CAUSES, b.causes.topics.length) : 0;
  const shape = b
    ? shapeFor(b, {
        causes: causeRows,
        projects: projects.length,
        back: Math.min(BACK, b.stillWrong?.topics.length ?? 0),
        foot: !!(causeRows && b.causes && causesFoot(b.causes)),
        clients: Math.min(CLIENTS, clients.length),
        unopened: b.watching?.unopened.length ?? 0,
      })
    : null;
  // and each agent's lines (what a narrow card shows under its name)
  const agentLines = b?.agents ? b.agents.map(agentLinesOf).join('') : null;
  useEffect(() => {
    if (shape != null && shape !== prefs.shape) setPref('shape', shape);
    if (agentLines != null && agentLines !== prefs.agentLines) setPref('agentLines', agentLines);
  }, [shape, prefs.shape, agentLines, prefs.agentLines, setPref]);
  if (!b) return <InsightsBody shape={shapeOf(prefs.shape)} lines={String(prefs.agentLines ?? '')} first={prefs.shape === undefined} />;
  const stale = isPlaceholderData ? 'ins-stale' : undefined;
  const causes = b.causes;
  return (
    <div className="insights" data-testid="insights" aria-busy={isPlaceholderData}>
      <div className={stale}>
        <Lead>{leadOf(b)}</Lead>
      </div>
      <div className={stale}>
        <Kpis tiles={tilesOf(b)} />
      </div>
      <div className={`ins-pair ins-pair-why ${projects.length ? 'two' : ''} ${stale ?? ''}`}>
        <Card id="causes" title={t('What causes the rounds')} answer={causes ? causesAnswer(causes) : t('No new versions in this period.')}>
          {causes ? <Causes c={causes} /> : <RowEmpty>{EMPTY.causes()}</RowEmpty>}
        </Card>
        {b.toApproval && projects.length > 0 && (
          <Card id="projects" title={t('Versions to approval by project')} answer={projectsAnswer(b.toApproval)}>
            <Projects a={b.toApproval} />
          </Card>
        )}
      </div>
      <div className={`ins-pair ins-pair-loop ${stale ?? ''}`}>
        <Card id="back" title={t('What came back')} answer={b.stillWrong ? backAnswer(b.stillWrong) : t('Nothing was fixed in this period.')}>
          {b.stillWrong ? <Back s={b.stillWrong} /> : <RowEmpty>{EMPTY.back()}</RowEmpty>}
        </Card>
        <Card id="agents" title={t('Agents: right the first time')} answer={agentAnswer(b.agents ?? [])}>
          <Agents agents={b.agents ?? []} />
        </Card>
      </div>
      <div className={stale}>
        <Card id="stuck" title={t('Where it’s stuck now')} answer={stuckAnswer(b.flow?.stuck ?? [])}>
          <Stuck stuck={b.flow?.stuck ?? []} />
        </Card>
      </div>
      {clients.length > 0 && (
        <div className={stale}>
          <Card id="clients" title={t('Review links')} answer={clientsAnswer(clients)}>
            <Clients list={clients} unopened={b.watching?.unopened ?? []} />
          </Card>
        </div>
      )}
    </div>
  );
}
