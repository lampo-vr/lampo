// The operator's funnel (#/operator/funnel, a page of Operator.tsx's frame): how sign-ups become paying workspaces,
// from the server's own first-party counts (lib/funnel.ts, GET /api/operator/funnel). Four figures, the eight steps as
// one bar each with the biggest drop before paying flagged, each sign-up week's share per step (the weeks still in
// their trial marked), and what is counted and what never is. With nothing counted yet it says so and what will be
// counted — never an example number.
import { useQuery } from '@tanstack/react-query';
import { type CSSProperties, type KeyboardEvent, useState } from 'react';
import type { FunnelReport, FunnelStep } from '../../../lib/types.ts';
import { ApiError, api } from '../api/client.ts';
import { locale, t } from '../i18n/index.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Segmented } from '../ui/primitives.tsx';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState, Panel } from '../ui/system.tsx';
import { Gone } from './parts.tsx';

type Weeks = '4' | '8' | '12';
const WEEKS: Weeks[] = ['4', '8', '12'];
/** The steps a workspace can stop at before paying: where the biggest drop is looked for. */
const BEFORE_PAYING: FunnelStep[] = ['setup_done', 'video_first', 'link_first', 'link_opened_first', 'fix_checked_first'];

const stepLabel = (s: FunnelStep): string =>
  ({
    signup: t('Signed up'),
    setup_done: t('Setup done'),
    video_first: t('First video'),
    link_first: t('First review link'),
    link_opened_first: t('Link opened'),
    fix_checked_first: t('First fix checked'),
    trial_end: t('Active at trial end'),
    plan_paid: t('Paid'),
  })[s];

const count = (n: number) => n.toLocaleString(locale());
const pct = (x: number, digits = 0) =>
  new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(x);
/** "10 Aug", "10. Aug." — weeks are UTC Mondays. */
const day = (iso: string) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const span = (a: string, b: string) => t('{from} – {to}', { from: day(a), to: day(b) });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const days = (d: number) => t('{x} day|{x} days', { n: d, x: d.toLocaleString(locale(), { maximumFractionDigits: 1 }) });

/** What is counted, and what never is: on the page whatever the numbers. */
function Counted() {
  return (
    <Panel pad="lg" className="set-card op-privacy" data-testid="op-privacy">
      <header>
        <h2 className="section-title">{t('What is counted, and what never is')}</h2>
      </header>
      <div className="op-privacy-cols">
        <div>
          <p className="op-k">{t('Counted')}</p>
          <ul className="op-list">
            <li>
              <KeyGlyph shape="diamond" size={9} className="op-ok" />
              {t(
                'Eight steps, once per workspace: sign-up, setup done, first video, first review link, a link’s first opening, first fix checked, the trial’s end, the first payment.',
              )}
            </li>
            <li>
              <KeyGlyph shape="diamond" size={9} className="op-ok" />
              {t('Each with a workspace id, the day (UTC) and the plan, written by this server into its own store.')}
            </li>
            <li>
              <KeyGlyph shape="diamond" size={9} className="op-ok" />
              {t('The conversion moments: which card or sheet showed, was put away or used, and where. Not who.')}
            </li>
          </ul>
        </div>
        <div>
          <p className="op-k">{t('Never collected')}</p>
          <ul className="op-list never">
            <li>
              <I name="x" size={12} />
              {t('Names, email addresses, IP addresses, devices')}
            </li>
            <li>
              <I name="x" size={12} />
              {t('Videos, titles, notes, frames, or anything a visitor types on a review link: only that a link was opened')}
            </li>
            <li>
              <I name="x" size={12} />
              {t('No third-party trackers, no cookies for this, no fingerprinting. Nothing leaves this server.')}
            </li>
          </ul>
        </div>
        <p className="op-keep">{t('Kept 13 months; after that only the weekly counts remain. A self-hosted server counts nothing.')}</p>
      </div>
    </Panel>
  );
}

function Head({ weeks, onWeeks, range }: { weeks: Weeks; onWeeks: (w: Weeks) => void; range: string | null }) {
  return (
    <>
      <header className="set-head">
        <h1>{t('Funnel')}</h1>
        <p>{t('From sign-up to paid, by the week people signed up. Each step counts a workspace once, the first time it happens.')}</p>
      </header>
      <div className="op-controls">
        <Segmented
          label={t('Weeks')}
          value={weeks}
          onChange={(v) => v && onWeeks(v as Weeks)}
          options={WEEKS.map((w) => ({ value: w, label: t('{n} weeks', { n: Number(w) }) }))}
        />
        <span className="op-fine">{range ?? <SkLine w="16ch" />}</span>
      </div>
    </>
  );
}

/** The four figures over the weeks shown (sign-ups) and the weeks whose trial has ended (the rest). */
function Figures({ r }: { r: FunnelReport }) {
  const at = (s: FunnelStep) => r.steps.find((x) => x.step === s);
  const base = at('signup')?.count ?? 0;
  const paid = at('plan_paid')?.count ?? 0;
  const end = at('trial_end')?.count ?? 0;
  const median = at('plan_paid')?.medianDays ?? null;
  const signups = r.cohorts.reduce((s, c) => s + c.signups, 0);
  // the trend between whole weeks: this week has only begun
  const done = r.cohorts.slice(0, -1);
  const first = done.find((c) => c.signups > 0);
  const last = done.at(-1);
  const now = r.cohorts.at(-1);
  const trend = first && last && first !== last ? (last.signups - first.signups) / first.signups : null;
  const tiles: [string, string, string, string][] = [
    [
      'signups',
      t('Sign-ups, {n} week|Sign-ups, {n} weeks', { n: r.weeks }),
      count(signups),
      trend === null
        ? t('{n} this week', { n: now?.signups ?? 0 })
        : t('{x} from the first week to the last', { x: `${trend >= 0 ? '+' : '−'}${pct(Math.abs(trend))}` }),
    ],
    [
      'paid',
      t('Paid, of finished trials'),
      base ? pct(paid / base, 1) : '—',
      base ? t('{paid} of {base} workspaces', { paid: count(paid), base: count(base) }) : t('No trial has ended in these weeks yet'),
    ],
    [
      'end',
      t('Trial end → paid'),
      end ? pct(paid / end) : '—',
      end ? t('of the {n} still active at the end', { n: count(end) }) : t('Nobody active at a trial’s end yet'),
    ],
    [
      'days',
      t('Median days to paid'),
      median === null ? '—' : median.toLocaleString(locale(), { maximumFractionDigits: 1 }),
      t('from sign-up to the first payment'),
    ],
  ];
  return (
    <div className="op-figures" data-testid="op-figures">
      {tiles.map(([k, label, value, sub]) => (
        <Panel key={k} className="op-figure">
          <span className="op-figure-k">{label}</span>
          <b className="op-figure-v">{value}</b>
          <span className="op-figure-s">{sub}</span>
        </Panel>
      ))}
    </div>
  );
}

/** The eight steps over the weeks whose trial has ended: one bar each, and the step's detail on hover or Tab. */
function Steps({ r }: { r: FunnelReport }) {
  const [on, setOn] = useState<FunnelStep | null>(null);
  const mature = r.cohorts.filter((c) => c.mature);
  const base = r.steps.find((s) => s.step === 'signup')?.count ?? 0;
  const counts = new Map(r.steps.map((s) => [s.step, s.count]));
  let worst: { step: FunnelStep; rate: number } | null = null;
  for (const step of BEFORE_PAYING) {
    const i = r.steps.findIndex((s) => s.step === step);
    const before = r.steps[i - 1]?.count ?? 0;
    if (!before) continue;
    const rate = (counts.get(step) ?? 0) / before;
    if (!worst || rate < worst.rate) worst = { step, rate };
  }
  const lede = mature.length
    ? t(
        'The {n} week whose trial has ended. Hover or tab through a step for its detail.|The {n} weeks whose trial has ended. Hover or tab through a step for its detail.',
        { n: mature.length },
      )
    : t('No sign-up week has finished its trial yet: the steps fill in once one has.');
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape') setOn(null);
  };
  return (
    <Panel pad="lg" className="set-card" data-testid="op-funnel">
      <header>
        <h2 className="section-title">{t('Where people go, and where they stop')}</h2>
        <p>{lede}</p>
      </header>
      {base > 0 && (
        <div className="op-fn">
          {/* the columns' names, for the eye: each row's button says its numbers, its detail says what they are */}
          <div className="op-fn-row op-fn-head" aria-hidden="true">
            <span>{t('Step')}</span>
            <span>
              {t('Workspaces, from sign-up weeks {weeks}', {
                weeks: span((mature[0] as { week: string }).week, addDays((mature.at(-1) as { week: string }).week, 6)),
              })}
            </span>
            <span>{t('Count')}</span>
            <span>{t('of sign-ups')}</span>
            <span>{t('from the step before')}</span>
          </div>
          <ol className="op-fn-list" aria-label={t('The funnel')}>
            {r.steps.map((s, i) => {
              const before = i ? (r.steps[i - 1]?.count ?? 0) : null;
              const of = s.count / base;
              const from = before ? s.count / before : null;
              const drop = before !== null ? before - s.count : 0;
              const flagged = worst?.step === s.step;
              const tip = `op-tip-${s.step}`;
              return (
                <li key={s.step} className="op-fn-item" data-step={s.step}>
                  <button
                    type="button"
                    className={`op-fn-row ${on === s.step ? 'on' : ''} ${flagged ? 'worst' : ''}`}
                    aria-describedby={on === s.step ? tip : undefined}
                    aria-expanded={on === s.step}
                    onMouseEnter={() => setOn(s.step)}
                    onMouseLeave={() => setOn((x) => (x === s.step ? null : x))}
                    onFocus={() => setOn(s.step)}
                    onBlur={() => setOn((x) => (x === s.step ? null : x))}
                    onClick={() => setOn((x) => (x === s.step ? null : s.step))}
                    onKeyDown={keys}
                  >
                    <span className="op-fn-l">{stepLabel(s.step)}</span>
                    <span className="op-fn-bar">
                      <i style={{ width: `${(of * 100).toFixed(2)}%` }} />
                      {flagged && <span className="op-fn-flag">{t('Biggest drop before paying')}</span>}
                    </span>
                    <span className="op-fn-n">{count(s.count)}</span>
                    <span className="op-fn-p">{pct(of)}</span>
                    <span className="op-fn-c">
                      {from !== null && (
                        <>
                          {pct(from)}
                          <small>−{count(drop)}</small>
                        </>
                      )}
                    </span>
                  </button>
                  {on === s.step && (
                    <span className="op-fn-tip" role="tooltip" id={tip}>
                      <b>{stepLabel(s.step)}</b>
                      <span>{t('{n} of {base} workspaces ({p})', { n: count(s.count), base: count(base), p: pct(of, 1) })}</span>
                      {from !== null && <span>{t('{p} of the step before; {n} stopped here', { p: pct(from, 1), n: count(drop) })}</span>}
                      {s.medianDays !== null && <span>{t('Median time from sign-up: {d}', { d: days(s.medianDays) })}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Panel>
  );
}

/** Each sign-up week's share per step, one ink ramp; the weeks still in their trial marked for the later steps. */
function Cohorts({ r }: { r: FunnelReport }) {
  const running = r.cohorts.filter((c) => !c.mature).length;
  // a phone scrolls the weeks sideways, with a soft edge where there is more
  const [edgesRef, edges] = useScrollEdges<HTMLDivElement>();
  return (
    <Panel pad="lg" className="set-card" data-testid="op-cohorts">
      <header>
        <h2 className="section-title">{t('By sign-up week')}</h2>
        <p>
          {running
            ? t(
                'Share of each week’s sign-ups that reached the step. The youngest week is still in its trial.|Share of each week’s sign-ups that reached the step. The {n} youngest weeks are still in their trial.',
                { n: running },
              )
            : t('Share of each week’s sign-ups that reached the step.')}
        </p>
      </header>
      <div className={`op-table-wrap ${edges}`} ref={edgesRef}>
        <table className="op-cohort">
          <thead>
            <tr>
              <th scope="col">{t('Sign-up week')}</th>
              {r.steps.map((s) => (
                <th key={s.step} scope="col">
                  {s.step === 'signup' ? t('Sign-ups') : stepLabel(s.step)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.cohorts.map((c) => (
              <tr key={c.week}>
                <th scope="row">
                  {day(c.week)}
                  {!c.mature && <small>{t('running')}</small>}
                </th>
                {r.steps.map(({ step }) => {
                  if (step === 'signup')
                    return (
                      <td key={step} className="op-ch-n">
                        {count(c.signups)}
                      </td>
                    );
                  const n = c.reached[step];
                  if (n === null)
                    return (
                      <td key={step} className="op-ch-run">
                        <span>{t('in trial')}</span>
                      </td>
                    );
                  if (!c.signups)
                    return (
                      <td key={step} className="op-ch-none">
                        —
                      </td>
                    );
                  const share = n / c.signups;
                  return (
                    <td
                      key={step}
                      className={`op-ch ${share > 0.42 ? 'hi' : ''}`}
                      style={{ '--s': Math.round(Math.min(1, share) * 100) } as CSSProperties}
                      title={t('Week of {week}: {n} of {base}', { week: day(c.week), n: count(n), base: count(c.signups) })}
                    >
                      {pct(share)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function FunnelPage() {
  const [weeks, setWeeks] = useState<Weeks>('8');
  const q = useQuery({
    queryKey: ['operator', 'funnel', weeks],
    queryFn: () => api<FunnelReport>(`/api/operator/funnel?weeks=${weeks}`),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    staleTime: 60_000,
  });
  const err = q.error instanceof ApiError ? q.error : null;
  // the server no longer answers this person (the operator list changed meanwhile): no such page
  if (err && (err.status === 404 || err.status === 403 || err.status === 401)) return <Gone />;
  const r = q.data;
  const range = r ? t('{range} · Lampo Cloud sign-ups', { range: `${span(r.from, r.to)} ${new Date(`${r.to}T12:00:00Z`).getUTCFullYear()}` }) : null;
  return (
    <>
      <Head weeks={weeks} onWeeks={setWeeks} range={r ? range : null} />
      {q.error && !r ? (
        <EmptyState art="error" titleAs="h2" title={t('The counts didn’t load')} action={<Button onClick={() => void q.refetch()}>{t('Try again')}</Button>}>
          {(q.error as Error).message}
        </EmptyState>
      ) : !r ? (
        <SkeletonRegion label={t('Loading the funnel')}>
          <div className="op-figures" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <Panel key={i} className="op-figure">
                <span className="op-figure-k">
                  <SkLine w="60%" />
                </span>
                <b className="op-figure-v">
                  <SkLine w="3ch" />
                </b>
                <span className="op-figure-s">
                  <SkLine w="80%" />
                </span>
              </Panel>
            ))}
          </div>
        </SkeletonRegion>
      ) : !r.counting ? (
        <EmptyState
          art="insights"
          titleAs="h2"
          className="op-empty"
          testId="op-empty"
          title={t('Nothing counted yet')}
          tips={[t('Each step counts a workspace once, the first time it happens.')]}
        >
          {t(
            'The first sign-up starts the funnel: from then on each week’s sign-ups, their steps and what the conversion moments did show here. Until then there is nothing to show, and no example stands in for it.',
          )}
        </EmptyState>
      ) : (
        <>
          <Figures r={r} />
          <Steps r={r} />
          <Cohorts r={r} />
        </>
      )}
      <Counted />
    </>
  );
}
