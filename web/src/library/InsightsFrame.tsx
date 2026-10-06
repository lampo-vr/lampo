// Insights' frame, light enough to ride in the library's chunk: the period in the page's header, the card every section
// shares, and the page in its loading shape — the rows each card showed last time (remembered per device), each in
// the anatomy of the row that replaces it, so nothing moves when the answer arrives. The page itself (Insights.tsx)
// loads on its own when it is first opened; this stands in meanwhile, and again while its answer is on its way.
import type { ReactNode } from 'react';
import type { InsightsBoard, InsightsPeriod } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { usePrefs } from '../lib/prefs.ts';
import { I } from '../ui/icons.tsx';
import { Segmented } from '../ui/primitives.tsx';
import { Skeleton, SkLine } from '../ui/Skeleton.tsx';
import { Panel } from '../ui/system.tsx';

export const PERIODS: InsightsPeriod[] = ['7d', '30d', '90d', 'all'];
const periodLabel = (p: InsightsPeriod) => (p === '7d' ? t('7 days') : p === '30d' ? t('30 days') : p === '90d' ? t('90 days') : t('All time'));
export const PREFS = 'vr.insights';
export const periodOf = (v: unknown): InsightsPeriod => (PERIODS.includes(v as InsightsPeriod) ? (v as InsightsPeriod) : '30d');

/** The period, in the page header across from the title (the library draws the header); remembered per device. */
export function PeriodPicker() {
  const [prefs, setPref] = usePrefs(PREFS);
  return (
    <Segmented
      label={t('Period')}
      className="ins-period"
      value={periodOf(prefs.period)}
      onChange={(v) => setPref('period', v)}
      options={PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))}
    />
  );
}

// ---------------------------------------------------------------- the frame every card shares

interface CardProps {
  id: string;
  title: string;
  /** What the card comes to, in one quiet sentence under its title (null while loading: its line keeps its place). */
  answer?: ReactNode | null;
  children: ReactNode;
  className?: string;
}

/** A card: its title, the one sentence it comes to, then the rows that show it. */
export function Card({ id, title, answer, children, className = '' }: CardProps) {
  return (
    <Panel pad="lg" className={`ins-sec ${className}`} aria-labelledby={`ins-${id}`} data-testid={`ins-${id}`}>
      <header className="ins-head">
        <h2 id={`ins-${id}`}>{title}</h2>
        {answer !== undefined && (
          <p className="ins-lede" data-testid={`ins-${id}-answer`}>
            {answer ?? <SkLine w="56%" />}
          </p>
        )}
      </header>
      {children}
    </Panel>
  );
}

/** A list with nothing in it: one plain sentence in the room of a row — what will show here. */
export function RowEmpty({ testId, ghost, children }: { testId?: string; ghost?: boolean; children: ReactNode }) {
  return (
    <p className={`ins-empty ${ghost ? 'ins-ghost' : ''}`} data-testid={testId} aria-hidden={ghost || undefined}>
      {children}
    </p>
  );
}

/** Rows that haven't arrived: `n` of `row`. */
export const pendingRows = (n: number, row: (i: number) => ReactNode) => Array.from({ length: n }, (_, i) => row(i));

// ---------------------------------------------------------------- what the page showed last time

/** Rows per card the last time (and whether the cards that come and go were there): the loading state's shape. */
export interface Shape {
  causes: number;
  /** 0: no card of projects (one project needs none). */
  projects: number;
  back: number;
  agents: number;
  stuck: number;
  /** 0: no card of clients (none watched). */
  clients: number;
  unopened: number;
  /** 1: the causes' quiet line under their rows. */
  foot: number;
}
const KEYS: (keyof Shape)[] = ['causes', 'projects', 'back', 'agents', 'stuck', 'clients', 'unopened', 'foot'];
const GUESS: Shape = { causes: 4, projects: 0, back: 3, agents: 2, stuck: 3, clients: 0, unopened: 0, foot: 0 };
export const shapeOf = (v: unknown): Shape => {
  const xs = String(v ?? '')
    .split(',')
    .map((x) => Number.parseInt(x, 10));
  return Object.fromEntries(KEYS.map((k, i) => [k, Number.isFinite(xs[i]) ? Math.min(20, Math.max(0, xs[i] as number)) : GUESS[k]])) as unknown as Shape;
};
export const shapeKey = (s: Shape) => KEYS.map((k) => s[k]).join(',');

// ---------------------------------------------------------------- the headline and the stat tiles

export const KPIS = ['versions', 'top', 'first', 'turnaround'] as const;
export type KpiId = (typeof KPIS)[number];
export interface Kpi {
  id: KpiId;
  label: string | null;
  value: string | null;
  sub: string | null;
}

/** The four numbers that serve the question, each a tile: its label, the figure, a line under it. */
export function Kpis({ tiles }: { tiles: Kpi[] | null }) {
  return (
    <ul className="ins-kpis" data-testid="ins-kpis">
      {(tiles ?? KPIS.map((id) => ({ id, label: null, value: null, sub: null }))).map((x) => (
        <li key={x.id} className="ins-kpi" data-testid={`ins-kpi-${x.id}`}>
          <span className="ins-label">{x.label ?? <SkLine w="9em" />}</span>
          <span className="ins-kpi-value">{x.value ?? <SkLine w="3.5em" />}</span>
          <span className="ins-kpi-sub">{x.sub ?? <SkLine w="9em" />}</span>
        </li>
      ))}
    </ul>
  );
}

/** The page's answer, in one or two sentences over everything else. */
export function Lead({ children }: { children: ReactNode | null }) {
  return (
    <p className="ins-lead" data-testid="ins-headline">
      {children ?? <SkLine w="min(36em, 90%)" />}
    </p>
  );
}

// ---------------------------------------------------------------- rows that haven't arrived (the same anatomy)

/** A topic behind the rounds: its name over its counts · its bar · its share · its action. */
export function CauseRowPending() {
  return (
    <li className="ins-row rc-row" aria-hidden="true">
      <span className="rc-topic">
        <b>
          <SkLine w="6em" />
        </b>
        <span>
          <SkLine w="11em" />
        </span>
      </span>
      <span className="rc-bar" />
      <span className="rc-num">
        <SkLine w="2.5em" />
      </span>
      <span className="rc-act">
        <span className="btn sm ins-ghost">{t('Make it a rule')}</span>
      </span>
    </li>
  );
}

/** The column heads of the projects' rows: the target's place on the bars' scale. */
export function ProjectHeads({ target, at }: { target: number | null; at: number | null }) {
  return (
    <li className="pj-heads" aria-hidden="true">
      <span />
      <span className="pj-scale">
        {target != null && at != null && (
          <span className="pj-target-label ins-label" style={{ left: `${at * 100}%` }}>
            {t('Target ≤ {n}', { n: target })}
          </span>
        )}
      </span>
      <span />
    </li>
  );
}

export function ProjectRowPending() {
  return (
    <li className="ins-row pj-row" aria-hidden="true">
      <span className="pj-name">
        <b>
          <SkLine w="6em" />
        </b>
        <span>
          <SkLine w="9em" />
        </span>
      </span>
      <span className="pj-bar" />
      <span className="pj-num">
        <b>
          <SkLine w="2em" />
        </b>
        <span>
          <SkLine w="4em" />
        </span>
      </span>
    </li>
  );
}

/** A topic that came back: its name over how often · a note that came back and why · the agents it came back from. */
export function BackRowPending() {
  return (
    <li className="ins-row bk-row" aria-hidden="true">
      <span className="bk-topic">
        <b>
          <SkLine w="6em" />
        </b>
        <span>
          <SkLine w="5em" />
        </span>
      </span>
      <span className="bk-example">
        <span className="bk-quote">
          <SkLine w="70%" />
        </span>
        <span className="bk-why">
          <SkLine w="40%" />
        </span>
      </span>
      <span className="bk-agents">
        <SkLine w="8em" />
      </span>
    </li>
  );
}

/** The column heads, once above the agents' rows where the card is wide (each row's cells carry their own words). */
export function AgentHeads() {
  return (
    <li className="ag-heads" aria-hidden="true">
      <span />
      <span className="ins-label">{t('Right the first time')}</span>
      <span className="ins-label">{t('Typical time to fix')}</span>
      <span className="ins-label">{t('Came back as still wrong')}</span>
    </li>
  );
}

/** `lines`: what its row shows besides the name (narrow cards give each measure a line): 0 = no fixes, 1 = fixes, 2 =
 * fixes and topics that came back. */
export function AgentRowPending({ lines }: { lines: number }) {
  return (
    <li className="ins-row ag-row" aria-hidden="true">
      <span className="ag-who">
        <Skeleton w={32} h={32} r="50%" />
        <span className="ag-name">
          <b>
            <SkLine w="6em" />
          </b>
          <span>
            <SkLine w="10em" />
          </span>
        </span>
      </span>
      <span className="ag-rate">
        <span className="ag-bar" />
        <SkLine w="5em" />
      </span>
      <span className="ag-time">{lines > 0 ? <SkLine w="3em" /> : <span className="ag-quiet ag-none">–</span>}</span>
      <span className="ag-back">
        {lines > 1 && (
          <span className="ch">
            <SkLine w="4em" />
          </span>
        )}
      </span>
    </li>
  );
}

/** What agents read, a click away: the quiet line at the end of the agents' card (here without its dialog). */
export function TasteLine({ children }: { children?: ReactNode }) {
  return (
    <p className="ins-taste-link">
      {t('Agents also read a summary of your notes before they start.')}{' '}
      {children ?? (
        <button type="button" tabIndex={-1} aria-hidden="true">
          {t('See what agents read')}
        </button>
      )}
    </p>
  );
}

/** A video waiting now: picture, name and what it waits for · on whom · how long · the one thing to do. */
export function StuckRowPending() {
  return (
    <li className="ins-row st-row" aria-hidden="true">
      <span className="st-video">
        <span className="st-thumb" />
        <span className="st-name">
          <b>
            <SkLine w="8em" />
          </b>
          <span>
            <SkLine w="6em" />
          </span>
        </span>
      </span>
      <span className="st-who">
        <SkLine w="4em" />
      </span>
      <span className="st-for">
        <SkLine w="2.5em" />
      </span>
      <span className="st-act">
        <span className="btn sm ins-ghost">{t('Nudge agent')}</span>
      </span>
    </li>
  );
}

/** A client who watched: who and through which link · the video and version · how far · the share. */
export function ClientRowPending() {
  return (
    <li className="ins-row cl-row" aria-hidden="true">
      <span className="cl-who">
        <Skeleton w={24} h={24} r="50%" />
        <span className="cl-name">
          <b>
            <SkLine w="4em" />
          </b>
          <span>
            <SkLine w="7em" />
          </span>
        </span>
      </span>
      <span className="cl-video">
        <b>
          <SkLine w="8em" />
        </b>
        <span>
          <SkLine w="5em" />
        </span>
      </span>
      <span className="wv-done">
        <span className="wv-done-line">
          <span className="wv-lane unseen" />
        </span>
      </span>
      <span className="wv-num">
        <b>
          <SkLine w="2.5em" />
        </b>
        <span>
          <SkLine w="4em" />
        </span>
      </span>
      <span className="btn ghost sm icon-only wv-toggle ins-ghost" />
    </li>
  );
}

/** Review links nobody opened, under the clients: as many as last time. */
export function UnopenedPending({ rows }: { rows: number }) {
  if (!rows) return null;
  return (
    <div className="ins-unopened" aria-hidden="true">
      <h3 className="ins-label">{t('Review links not opened yet')}</h3>
      <ul className="ins-rows un-list">
        {pendingRows(rows, (i) => (
          <li key={i} className="ins-row un-row">
            <span className="un-name">
              <I name="link" size={14} className="un-icon" />
              <b>
                <SkLine w="8em" />
              </b>
              <span>
                <SkLine w="6em" />
              </span>
            </span>
            <span className="un-when">
              <SkLine w="5em" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- the page, loading

/** What each card is for, said in its empty row (also the loading state's ghost when no rows are remembered). */
export const EMPTY = {
  causes: () => t('Each new version that follows notes is a round: the notes’ topics show what caused it, a click away from a rule agents follow.'),
  back: () => t('Fixes you mark Still wrong show up here, by topic and by agent.'),
  agents: () => t('Fixes agents make and how they hold up when you check them show up here.'),
  stuck: () => t('Videos waiting on you or an agent, or out for review, show up here, the longest first.'),
};

/**
 * The page before its answer (and before its code, the first time): the headline's line, the four tiles, and every card
 * with as many rows as it had last time. A first visit can't know them: the cards below the first wait unseen.
 */
export function InsightsBody({ shape, lines, first }: { shape: Shape; lines: string; first: boolean }) {
  const below = first ? 'ins-wait' : '';
  return (
    <div className="insights" data-testid="insights" aria-busy="true">
      <div>
        <Lead>{null}</Lead>
      </div>
      <div>
        <Kpis tiles={null} />
      </div>
      <div className={`ins-pair ins-pair-why ${shape.projects ? 'two' : ''}`}>
        <Card id="causes" title={t('What causes the rounds')} answer={null}>
          {shape.causes ? (
            <ul className="ins-rows rc-list" aria-hidden="true">
              {pendingRows(shape.causes, (i) => (
                <CauseRowPending key={i} />
              ))}
            </ul>
          ) : (
            <RowEmpty ghost>{EMPTY.causes()}</RowEmpty>
          )}
          {shape.foot > 0 && (
            <p className="ins-foot" aria-hidden="true">
              <SkLine w="60%" />
            </p>
          )}
        </Card>
        {shape.projects > 0 && (
          <Card id="projects" title={t('Versions to approval by project')} answer={null}>
            <ul className="ins-rows pj-list" aria-hidden="true">
              <ProjectHeads target={null} at={null} />
              {pendingRows(shape.projects, (i) => (
                <ProjectRowPending key={i} />
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className={`ins-pair ins-pair-loop ${below}`}>
        <Card id="back" title={t('What came back')} answer={null}>
          {shape.back ? (
            <ul className="ins-rows bk-list" aria-hidden="true">
              {pendingRows(shape.back, (i) => (
                <BackRowPending key={i} />
              ))}
            </ul>
          ) : (
            <RowEmpty ghost>{EMPTY.back()}</RowEmpty>
          )}
        </Card>
        <Card id="agents" title={t('Agents: right the first time')} answer={null}>
          {shape.agents ? (
            <ul className="ins-rows ag-list" aria-hidden="true">
              <AgentHeads />
              {pendingRows(shape.agents, (i) => (
                <AgentRowPending key={i} lines={Number(lines[i] ?? 1)} />
              ))}
            </ul>
          ) : (
            <RowEmpty ghost>{EMPTY.agents()}</RowEmpty>
          )}
          <TasteLine />
        </Card>
      </div>
      <div className={below}>
        <Card id="stuck" title={t('Where it’s stuck now')} answer={null}>
          {shape.stuck ? (
            <ul className="ins-rows st-list" aria-hidden="true">
              {pendingRows(shape.stuck, (i) => (
                <StuckRowPending key={i} />
              ))}
            </ul>
          ) : (
            <RowEmpty ghost>{EMPTY.stuck()}</RowEmpty>
          )}
        </Card>
      </div>
      {shape.clients > 0 && (
        <div className={below}>
          <Card id="clients" title={t('Review links')} answer={null}>
            <ul className="ins-rows cl-list" aria-hidden="true">
              {pendingRows(shape.clients, (i) => (
                <ClientRowPending key={i} />
              ))}
            </ul>
            <UnopenedPending rows={shape.unopened} />
          </Card>
        </div>
      )}
    </div>
  );
}

/** The library's stand-in while the page's code arrives: the page in its remembered shape. */
export function InsightsPending() {
  const [prefs] = usePrefs(PREFS);
  return <InsightsBody shape={shapeOf(prefs.shape)} lines={String(prefs.agentLines ?? '')} first={prefs.shape === undefined} />;
}

/** The shape a board gives the page (what the next visit's loading state draws). */
export function shapeFor(
  b: InsightsBoard,
  cards: { projects: number; clients: number; unopened: number; causes: number; back: number; foot: boolean },
): string {
  return shapeKey({
    causes: cards.causes,
    projects: cards.projects,
    back: cards.back,
    agents: b.agents?.length ?? 0,
    stuck: b.flow?.stuck.length ?? 0,
    clients: cards.clients,
    unopened: cards.clients ? cards.unopened : 0,
    foot: cards.foot ? 1 : 0,
  });
}
