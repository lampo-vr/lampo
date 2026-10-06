// Every workspace on the server (#/operator/workspaces) and one opened (#/operator/workspaces/<id>). The list: name and
// owner, plan and state, members, storage used of the plan, videos, made, last active — searched by name or owner,
// filtered by where the plan stands, ordered by last activity or by when it was made. A workspace: its facts, its
// members, and its plan set by hand (complimentary, the trial to a day, back to normal billing), each with a reason, and
// the log of those. Without a billing module there are no plans: the list leaves the column out, the page the card.
// Last, the takedown (A13 CLOUD-5): suspended — read-only for its people, its review links stopped, everyone told — and
// lifted; deleted with everything it holds once its name is typed. Never the server's own workspace.
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import type { OperatorMember, OperatorPlan, OperatorWorkspace, OperatorWorkspaces, PlanLogEntry, WorkspaceDeletionPlan } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { useInfo } from '../api/queries.ts';
import { WorkspaceMark } from '../auth/Workspaces.tsx';
import { locale, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { roleLabel } from '../i18n/terms.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { usePhone } from '../lib/media.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Card, Confirm, Facts } from '../settings/parts.tsx';
import { inDays, longDay, ymd } from '../share/dates.ts';
import { Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Modal, Popover, Segmented } from '../ui/primitives.tsx';
import { Skeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { opKeys, type PlanAsk, refused, useDeleteWorkspace, useDeletionPlan, useOpWorkspace, useOpWorkspaces, useSetPlan, useSuspend } from './api.ts';
import { Crumb, day, dayTime, Gone, groupOf, PlanBadge, type PlanGroup, SearchField, shortDay, since, storageOf } from './parts.tsx';

type Sort = 'active' | 'created';
type Group = 'all' | PlanGroup;

/** What the list was showing, kept while a workspace is open: back is where you were. */
const view: { q: string; group: Group; sort: Sort } = { q: '', group: 'all', sort: 'active' };

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

function matches(w: OperatorWorkspace, q: string): boolean {
  if (!q) return true;
  const hay = `${w.name}\n${w.owner?.name ?? ''}\n${w.owner?.email ?? ''}\n${w.id}`.toLocaleLowerCase(locale());
  return q
    .toLocaleLowerCase(locale())
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

const GROUPS = (): { value: Group; label: string }[] => [
  { value: 'all', label: t('All') },
  { value: 'trial', label: t('Trial') },
  { value: 'paid', label: t('Paid') },
  { value: 'free', label: t('Free') },
  { value: 'attention', label: t('Grace or read-only') },
  { value: 'complimentary', label: t('Complimentary') },
];

/** The columns' names, for the eye; each row says its numbers to a screen reader in words. */
function Head({ plans }: { plans: boolean }) {
  return (
    <div className={`set-row op-row op-head ${plans ? 'op-plans' : ''}`} aria-hidden="true">
      <span className="op-c-mark" />
      <span className="op-c-main">{t('Workspace')}</span>
      {plans && <span className="op-c-plan">{t('Plan')}</span>}
      <span className="op-c-members op-num">{t('Members')}</span>
      <span className="op-c-storage op-num">{t('Storage')}</span>
      <span className="op-c-videos op-num">{t('Videos')}</span>
      <span className="op-c-created op-num">{t('Created')}</span>
      <span className="op-c-active op-num">{t('Last active')}</span>
    </div>
  );
}

function Row({ w, plans }: { w: OperatorWorkspace; plans: boolean }) {
  return (
    <a className={`set-row op-row ${plans ? 'op-plans' : ''}`} href={`#/operator/workspaces/${w.id}`} data-testid="op-ws-row" data-id={w.id}>
      <span className="op-c-mark">
        <WorkspaceMark name={w.name} size="md" />
      </span>
      <span className="op-c-main">
        <span className="op-name-line">
          <b className="ellipsis">{w.name}</b>
          {w.suspended && <span className="badge danger">{t('SUSPENDED')}</span>}
        </span>
        <span className="set-sub ellipsis">{w.owner ? `${w.owner.name} · ${w.owner.email}` : t('No owner who can sign in')}</span>
      </span>
      {plans && <span className="op-c-plan">{w.plan ? <PlanBadge plan={w.plan} size="sm" /> : <span className="op-dim">—</span>}</span>}
      <span className="op-c-members op-num">
        <span className="sr-only">{t('{n} member|{n} members', { n: w.members })}</span>
        <span aria-hidden="true">{w.members}</span>
      </span>
      <span className="op-c-storage op-num">
        <span className="sr-only">{t('Storage')}: </span>
        {storageOf(w.bytes, w.plan?.storage)}
      </span>
      <span className="op-c-videos op-num">
        <span className="sr-only">{t('{n} video|{n} videos', { n: w.videos })}</span>
        <span aria-hidden="true">{w.videos}</span>
      </span>
      <span className="op-c-created op-num" title={dayTime(w.created)}>
        <span className="sr-only">{t('Created')}: </span>
        {shortDay(w.created)}
      </span>
      <span className="op-c-active op-num" title={w.active ? dayTime(w.active) : undefined}>
        <span className="sr-only">{t('Last active')}: </span>
        {since(w.active, t('not yet'))}
      </span>
    </a>
  );
}

/** A row on its way: the same row, its words still bars. */
function RowPending({ i, plans }: { i: number; plans: boolean }) {
  return (
    <div className={`set-row op-row ${plans ? 'op-plans' : ''}`} aria-hidden="true">
      <span className="op-c-mark">
        <Skeleton w={24} h={24} r={6} />
      </span>
      <span className="op-c-main">
        <b>
          <SkLine w={`${9 + ((i * 5) % 7)}em`} />
        </b>
        <span className="set-sub">
          <SkLine w={`${13 + ((i * 3) % 6)}em`} />
        </span>
      </span>
      {plans && (
        <span className="op-c-plan">
          <SkLine w="7em" />
        </span>
      )}
      <span className="op-c-members op-num">
        <SkLine w="1.5em" />
      </span>
      <span className="op-c-storage op-num">
        <SkLine w="6em" />
      </span>
      <span className="op-c-videos op-num">
        <SkLine w="1.5em" />
      </span>
      <span className="op-c-created op-num">
        <SkLine w="4em" />
      </span>
      <span className="op-c-active op-num">
        <SkLine w="4em" />
      </span>
    </div>
  );
}

export function WorkspacesPage() {
  const q = useOpWorkspaces();
  const billing = !!useInfo()?.billing;
  const [search, setSearchState] = useState(view.q);
  const [group, setGroupState] = useState<Group>(view.group);
  const [sort, setSortState] = useState<Sort>(view.sort);
  const setSearch = (v: string) => {
    view.q = v;
    setSearchState(v);
  };
  const setGroup = (v: Group) => {
    view.group = v;
    setGroupState(v);
  };
  const setSort = (v: Sort) => {
    view.sort = v;
    setSortState(v);
  };
  const field = useRef<HTMLInputElement | null>(null);
  // the chips scroll sideways in what the row leaves them, a soft edge where there are more
  const [chipsRef, chipsEdges] = useScrollEdges<HTMLDivElement>();
  if (refused(q.error) || (q.error instanceof ApiError && q.error.status === 404)) return <Gone />;
  const data = q.data;
  // plans where a billing module runs (/api/info says so before the list answers): the column keeps its room meanwhile
  const plans = data?.plans ?? billing;
  const all = data?.workspaces ?? [];
  const counts: Record<Group, number> = { all: all.length, trial: 0, paid: 0, free: 0, attention: 0, complimentary: 0 };
  for (const w of all) if (w.plan) counts[groupOf(w.plan)]++;
  const term = search.trim();
  const found = all.filter((w) => matches(w, term));
  const shown = found
    .filter((w) => group === 'all' || (w.plan && groupOf(w.plan) === group))
    .sort((a, b) => (sort === 'active' ? time(b.active) - time(a.active) : 0) || time(b.created) - time(a.created) || a.name.localeCompare(b.name));
  return (
    <>
      <header className="set-head">
        <h1>{t('Workspaces')}</h1>
        <p>{t('Every workspace on this server: who owns it, what it holds and where its plan stands. Open one to see its people or set its plan by hand.')}</p>
      </header>
      <div className="op-toolbar" role="toolbar" aria-label={t('Workspaces')}>
        <SearchField
          value={search}
          onChange={setSearch}
          inputRef={field}
          placeholder={t('Search by workspace or owner')}
          label={t('Search the workspaces by name, owner or email')}
          disabled={!data}
        />
        {plans && (
          <div className={`op-chips ${chipsEdges}`} ref={chipsRef}>
            <Segmented
              label={t('Where the plan stands')}
              className="chips"
              value={group}
              onChange={(g) => g && setGroup(g as Group)}
              options={GROUPS().map((g) => ({ ...g, count: data ? counts[g.value] : null }))}
            />
          </div>
        )}
        <span className="grow" />
        <Segmented
          label={t('Order')}
          className="op-sort"
          value={sort}
          onChange={(s) => s && setSort(s as Sort)}
          options={[
            { value: 'active', label: t('Last active') },
            { value: 'created', label: t('Newest') },
          ]}
        />
      </div>
      {q.error && !data ? (
        <EmptyState
          art="error"
          titleAs="h2"
          title={t('The workspaces didn’t load')}
          action={<Button onClick={() => void q.refetch()}>{t('Try again')}</Button>}
        >
          {(q.error as Error).message}
        </EmptyState>
      ) : !data ? (
        <SkeletonRegion label={t('Loading the workspaces')}>
          <div className="set-rows op-rows">
            <Head plans={plans} />
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <RowPending key={i} i={i} plans={plans} />
            ))}
          </div>
        </SkeletonRegion>
      ) : (
        <div className="set-rows op-rows" data-testid="op-workspaces">
          <Head plans={plans} />
          {shown.map((w) => (
            <Row key={w.id} w={w} plans={plans} />
          ))}
          {!shown.length && (
            <div className="op-rows-empty">
              {term ? (
                <EmptyState
                  art="search"
                  size="sm"
                  title={t('No workspace matches “{q}”', { q: term })}
                  testId="op-ws-none"
                  action={
                    <Button
                      onClick={() => {
                        setSearch('');
                        field.current?.focus();
                      }}
                    >
                      {t('Clear the search')}
                    </Button>
                  }
                >
                  {t('Search finds a workspace by its name, or by its owner’s name or email.')}
                </EmptyState>
              ) : (
                <EmptyState
                  art="filter"
                  size="sm"
                  title={t('No workspace here right now')}
                  testId="op-ws-none"
                  action={<Button onClick={() => setGroup('all')}>{t('Show all')}</Button>}
                >
                  {t('None of the workspaces is in this state today.')}
                </EmptyState>
              )}
            </div>
          )}
        </div>
      )}
      {data && shown.length > 0 && (
        <p className="op-foot set-sub">
          {shown.length === all.length
            ? t('{n} workspace|{n} workspaces', { n: all.length })
            : t('{n} of {of} workspaces', { n: shown.length, of: all.length })}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- one workspace

/** A plan in a sentence: what it is now and why, for the plan card's lede. */
function planSentence(p: OperatorPlan): string {
  if (p.state === 'complimentary') return t('{plan}, complimentary: no limits, never billed.', { plan: p.name });
  if (p.state === 'trial') return t('{plan}, a trial until {day}.', { plan: p.name, day: day(p.trialEndsAt) });
  if (p.state === 'grace')
    return p.reason === 'payment'
      ? t('{plan}, in grace until {day}: its last payment failed.', { plan: p.name, day: day(p.graceUntil) })
      : t('{plan}, in grace until {day}: its trial ended over Free’s limits.', { plan: p.name, day: day(p.graceUntil) });
  if (p.state === 'read-only')
    return p.reason === 'payment'
      ? t('{plan}, read-only until its open invoice is paid.', { plan: p.name })
      : t('{plan}, read-only: it holds more than its plan allows.', { plan: p.name });
  return p.plan === 'free' ? t('Free: nothing paid, Free’s limits.') : t('{plan}, paid.', { plan: p.name });
}

/** What a line of the log did, in words. */
function changeWords(e: PlanLogEntry): string {
  const c = e.change;
  if (c.kind === 'complimentary') return t('Complimentary on {plan}', { plan: PLAN_NAMES[c.plan] ?? c.plan });
  if (c.kind === 'trial') return t('Trial to {day}', { day: day(c.until) });
  return t('Back to normal billing');
}

const PLAN_NAMES: Record<string, string> = { solo: 'Solo', team: 'Team', business: 'Business' };

/** Why the module said no, in the page's words (its own sentence is English). */
const refusalWords = (reason: unknown): string | null =>
  reason === 'fixed'
    ? t('The server’s settings make this workspace complimentary: change it there.')
    : reason === 'paying'
      ? t('This workspace pays for a plan: its subscription has to end before a plan can be set by hand.')
      : reason === 'date'
        ? t('The trial’s new end must be a day after today and within a year.')
        : reason === 'none'
          ? t('Nothing was set by hand here: it is billed as usual already.')
          : reason === 'reason'
            ? t('Say why in one line.')
            : null;

const calendarCode = loader(() => import('../share/ExpiryCalendar.tsx'));

/** The trial's new last day: a week, two or a month on from today or its end now, or any day in the calendar. */
function TrialDay({ value, onChange, from }: { value: string; onChange: (day: string) => void; from: string | null }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const Calendar = useLoaded(calendarCode, open)?.default;
  const base = from && Date.parse(from) > Date.now() ? new Date(from) : new Date();
  const presets = [7, 14, 30].map((n) => ({ n, day: ymd(inDays(n, base)) }));
  const preset = presets.find((p) => p.day === value);
  const pick = (d: string) => {
    onChange(d);
    setOpen(false);
  };
  const calendar = Calendar ? (
    <Calendar value={value} onPick={pick} />
  ) : (
    <div className="op-day-loading">
      <Spinner />
    </div>
  );
  const custom = !!value && !preset;
  const button = (
    <button type="button" className={`btn sm ${custom ? 'on' : ''}`} aria-pressed={custom} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <I name="clock" size={13} /> {custom ? longDay(value) : t('Day…')}
    </button>
  );
  const days = value ? Math.round((Date.parse(`${value}T12:00:00`) - Date.parse(`${ymd(new Date())}T12:00:00`)) / 86_400_000) : 0;
  return (
    <div className="op-day">
      <fieldset className="op-day-presets" aria-label={t('The trial’s last day')}>
        {presets.map((p) => (
          <button
            key={p.n}
            type="button"
            className={`btn sm ${preset?.n === p.n ? 'on' : ''}`}
            aria-pressed={preset?.n === p.n}
            onClick={() => onChange(p.day)}
          >
            {t('+{n} days', { n: p.n })}
          </button>
        ))}
        {phone ? (
          button
        ) : (
          <Popover open={open} onOpenChange={setOpen} trigger={button} className="op-day-pop">
            {calendar}
          </Popover>
        )}
      </fieldset>
      <div className="op-day-readout" aria-live="polite">
        {value ? (
          <T
            k={'Runs through <0>{day}</0> ({n}), then billing as usual'}
            values={{ day: longDay(value), n: t('in {n} day|in {n} days', { n: days }) }}
            tags={[(c) => <b>{c}</b>]}
          />
        ) : (
          t('Pick the trial’s last day.')
        )}
      </div>
      {phone && open && (
        <Modal title={t('The trial’s last day')} onClose={() => setOpen(false)}>
          <div className="op-day-sheet">{calendar}</div>
        </Modal>
      )}
    </div>
  );
}

type Change = 'complimentary' | 'trial' | 'normal';

/** The plan set by hand: what it is now, and a change with its reason. */
function PlanCard({ w }: { w: OperatorWorkspace }) {
  const plan = w.plan;
  const set = useSetPlan(w.id);
  const override = plan?.override;
  // with a plan set by hand, ending it is the likely next step; without one, a gift
  const [change, setChange] = useState<Change>(override ? 'normal' : 'complimentary');
  const [tier, setTier] = useState<'solo' | 'team' | 'business'>(override?.kind === 'complimentary' ? override.plan : 'team');
  const [until, setUntil] = useState(() =>
    ymd(inDays(14, plan?.trialEndsAt && Date.parse(plan.trialEndsAt) > Date.now() ? new Date(plan.trialEndsAt) : new Date())),
  );
  const [reason, setReason] = useState('');
  if (!plan)
    return (
      <Card title={t('Plan')} lede={t('The billing module didn’t say this workspace’s plan.')}>
        <span />
      </Card>
    );
  const why = reason.trim();
  const ready = !!why && (change !== 'trial' || !!until) && !set.isPending;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const ask: PlanAsk =
      change === 'complimentary'
        ? { kind: 'complimentary', plan: tier, reason: why }
        : change === 'trial'
          ? { kind: 'trial', until, reason: why }
          : { kind: 'normal', reason: why };
    try {
      await set.mutateAsync(ask);
      setReason('');
      toast(
        change === 'complimentary'
          ? t('{name} is complimentary on {plan}', { name: w.name, plan: PLAN_NAMES[tier] as string })
          : change === 'trial'
            ? t('{name}’s trial runs through {day}', { name: w.name, day: longDay(until) })
            : t('{name} is billed as usual again', { name: w.name }),
        'ok',
      );
      if (change === 'normal') setChange('complimentary');
    } catch (err) {
      const words = err instanceof ApiError ? refusalWords(err.details.reason) : null;
      if (words) toast(words, 'error');
      else toastError(err);
    }
  };
  const action = change === 'complimentary' ? t('Make complimentary') : change === 'trial' ? t('Run the trial to this day') : t('Back to normal billing');
  const options: { value: Change; label: string }[] = [
    { value: 'complimentary', label: t('Complimentary') },
    { value: 'trial', label: t('Trial to a day') },
    ...(override ? [{ value: 'normal' as const, label: t('Normal billing') }] : []),
  ];
  return (
    <Card title={t('Plan')} lede={planSentence(plan)} testid="op-plan-card">
      <div className="op-plan-now">
        <PlanBadge plan={plan} />
        <span className="set-sub">{storageOf(w.bytes, plan.storage)}</span>
      </div>
      {override && (
        <p className="op-set-by set-sub" data-testid="op-override">
          <T
            k={'Set by hand by <0>{name}</0> on {day}: “{reason}”'}
            values={{ name: override.by.name, day: day(override.at), reason: override.reason }}
            tags={[(c) => <b>{c}</b>]}
          />
        </p>
      )}
      {plan.fixed ? (
        <p className="op-note set-sub" data-testid="op-plan-fixed">
          {plan.fixed === 'own'
            ? t('This is the server’s own workspace: it is always complimentary.')
            : t('LAMPO_COMPLIMENTARY makes this workspace complimentary: change it there.')}
        </p>
      ) : plan.paying ? (
        <p className="op-note set-sub" data-testid="op-plan-paying">
          {t('It pays for {plan}. A plan set by hand needs its subscription to end first: nothing here bills or refunds.', { plan: plan.name })}
        </p>
      ) : (
        <form className="set-form op-plan-form" onSubmit={submit}>
          <Segmented label={t('Change the plan')} value={change} onChange={(v) => v && setChange(v as Change)} options={options} />
          <div className="op-plan-panels">
            <div className={`op-plan-panel ${change === 'complimentary' ? 'on' : ''}`} inert={change !== 'complimentary'}>
              <div className="set-field">
                <span>{t('On which plan')}</span>
                <Segmented
                  label={t('On which plan')}
                  value={tier}
                  onChange={(v) => v && setTier(v as typeof tier)}
                  options={[
                    { value: 'solo', label: 'Solo' },
                    { value: 'team', label: 'Team' },
                    { value: 'business', label: 'Business' },
                  ]}
                />
              </div>
              <p className="set-sub op-hint">{t('Everything the plan has, with no limits; nothing is ever billed while it lasts.')}</p>
            </div>
            <div className={`op-plan-panel ${change === 'trial' ? 'on' : ''}`} inert={change !== 'trial'}>
              <div className="set-field">
                <span>{t('The trial’s last day')}</span>
                <TrialDay value={until} onChange={setUntil} from={plan.trialEndsAt ?? null} />
              </div>
            </div>
            <div className={`op-plan-panel ${change === 'normal' ? 'on' : ''}`} inert={change !== 'normal'}>
              <p className="set-sub op-hint">{t('The plan set by hand ends now: the workspace is billed by what it has paid for, its trial or Free.')}</p>
            </div>
          </div>
          <label className="set-field">
            <span>{t('Why')}</span>
            <input
              className="input"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value.replace(/[\r\n]+/g, ' '))}
              placeholder={t('Launch partner, agreed by email')}
              data-testid="op-reason"
            />
          </label>
          <div className="set-actions">
            <span className="grow set-sub">{t('Kept in this workspace’s log with your name.')}</span>
            <button type="submit" className="btn primary" disabled={!ready} data-testid="op-plan-submit">
              {set.isPending && <Spinner />} {action}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * The plans set by hand, newest first. Only once there is one: it comes last on the page, so nothing above moves when it
 * arrives, and a workspace billed as usual has no empty box (its plan card says how it is billed).
 */
function LogCard({ log }: { log: PlanLogEntry[] | undefined }) {
  if (!log?.length) return null;
  return (
    <Card title={t('Set by hand')} lede={t('Every plan set on this page: who, when, what and why. Newest first.')} testid="op-log">
      <div className="set-rows">
        {log.map((e) => (
          <div key={`${e.at}-${e.change.kind}`} className="set-row op-log-row" data-testid="op-log-row">
            <span className="op-log-mark">
              <KeyGlyph shape={e.change.kind === 'normal' ? 'outline' : e.change.kind === 'trial' ? 'half' : 'diamond'} size={10} />
            </span>
            <span className="grow op-col">
              <b>{changeWords(e)}</b>
              <span className="set-sub">“{e.reason}”</span>
              <span className="set-sub op-log-who">
                {e.by.name}
                {e.by.email ? ` · ${e.by.email}` : ''} · {dayTime(e.at)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MembersCard({ members }: { members: OperatorMember[] | undefined }) {
  return (
    <Card
      title={members ? t('{n} member|{n} members', { n: members.length }) : t('Members')}
      lede={t('Everyone with an account in it, by role. Open one for their account.')}
      testid="op-members"
    >
      {!members ? (
        <SkeletonRegion label={t('Loading the members')}>
          <div className="set-rows">
            {[0, 1, 2].map((i) => (
              <div key={i} className="set-row">
                <Skeleton w={30} h={30} r={15} />
                <span className="grow op-col">
                  <b>
                    <SkLine w={`${8 + i * 2}em`} />
                  </b>
                  <span className="set-sub">
                    <SkLine w="12em" />
                  </span>
                </span>
                <SkLine w="5em" />
              </div>
            ))}
          </div>
        </SkeletonRegion>
      ) : (
        <div className="set-rows">
          {members.map((m) => (
            <a
              key={m.id}
              className={`set-row op-link-row ${m.disabled || m.suspended ? 'off' : ''}`}
              href={`#/operator/accounts/${m.id}`}
              data-testid="op-member"
            >
              <Avatar name={m.name} size={30} kind="person" />
              <span className="grow op-col">
                <span className="ellipsis">
                  <b>{m.name}</b> {m.disabled && <span className="badge danger">{t('DISABLED')}</span>}{' '}
                  {!m.disabled && m.suspended && <span className="badge">{t('SUSPENDED HERE')}</span>}
                </span>
                <span className="set-sub ellipsis">{m.email}</span>
              </span>
              <span className={`badge role-${m.role}`}>{roleLabel(m.role).toUpperCase()}</span>
              <I name="right" size={14} className="op-chevron" />
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

/** What a deletion takes, counted (the dialog's list): its videos and their bytes, links, people, ways in. */
function TakedownFacts({ plan }: { plan: WorkspaceDeletionPlan | undefined }) {
  const rows: [string, string | null][] = [
    [t('Videos'), plan ? `${plan.videos} · ${storageOf(plan.bytes, undefined)}` : null],
    [t('Review links'), plan ? String(plan.links) : null],
    [t('Members'), plan ? t('{n} · {gone} work nowhere else', { n: plan.members.total, gone: plan.members.accountsGone }) : null],
    [t('Invites, tokens, apps'), plan ? `${plan.invites} · ${plan.tokens} · ${plan.apps}` : null],
  ];
  return (
    <dl className="op-gone" data-testid="op-delete-plan">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? <SkLine w="5em" />}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The takedown: suspend (a reason, for this page alone) or lift it; delete, its name typed and a reason given. What a
 * deletion takes is counted when its dialog opens. The server's own workspace has no such card (the server refuses it).
 */
function TakedownCard({ w }: { w: OperatorWorkspace }) {
  const suspend = useSuspend(w.id);
  const del = useDeleteWorkspace(w.id);
  const [asking, setAsking] = useState<'suspend' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const plan = useDeletionPlan(w.id, asking === 'delete');
  const s = w.suspended;
  const open = (what: 'suspend' | 'delete') => {
    setReason('');
    setTyped('');
    setAsking(what);
  };
  const why = reason.trim();
  const named = typed.trim() === w.name.trim();
  const doSuspend = async () => {
    try {
      await suspend.mutateAsync(why);
      toast(t('{name} is suspended: its people were told', { name: w.name }), 'ok');
      setAsking(null);
    } catch (err) {
      toastError(err);
    }
  };
  const lift = async () => {
    try {
      await suspend.mutateAsync(null);
      toast(t('{name} works again: its people were told', { name: w.name }), 'ok');
    } catch (err) {
      toastError(err);
    }
  };
  const doDelete = async () => {
    try {
      const done = await del.mutateAsync({ name: typed.trim(), reason: why });
      toast(t('{name} is deleted', { name: done.deleted.name }), 'ok');
      setAsking(null);
      location.hash = '#/operator/workspaces';
    } catch (err) {
      toastError(err);
    }
  };
  const reasonField = (
    <label className="set-field">
      <span>{t('Why')}</span>
      <input
        className="input"
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value.replace(/[\r\n]+/g, ' '))}
        placeholder={t('Abuse report, 6 October')}
        data-testid="op-takedown-reason"
        {...(asking === 'suspend' ? { 'data-autofocus': '' } : {})}
      />
    </label>
  );
  return (
    <Card
      title={t('Suspend or delete')}
      danger
      testid="op-takedown"
      lede={
        s
          ? t('Suspended: its people can sign in, read and download, but nothing can change, its agents write nothing and its review links don’t open.')
          : t(
              'Suspending makes it read-only for its people and stops its review links; they are told by email. Deleting removes it with everything it holds, for good.',
            )
      }
    >
      {s && (
        <p className="op-note set-sub" data-testid="op-suspended">
          <T k={'Suspended by <0>{name}</0> on {day}: “{reason}”'} values={{ name: s.by, day: dayTime(s.at), reason: s.reason }} tags={[(c) => <b>{c}</b>]} />
        </p>
      )}
      <div className="set-actions">
        <span className="grow" />
        {s ? (
          <button type="button" className="btn" onClick={() => void lift()} disabled={suspend.isPending} data-testid="op-unsuspend">
            {suspend.isPending ? <Spinner /> : <I name="unlock" size={15} />} {t('Lift the suspension')}
          </button>
        ) : (
          <button type="button" className="btn danger-outline" onClick={() => open('suspend')} data-testid="op-suspend">
            <I name="lock" size={15} /> {t('Suspend…')}
          </button>
        )}
        <button type="button" className="btn danger-outline" onClick={() => open('delete')} data-testid="op-delete">
          <I name="trash" size={15} /> {t('Delete…')}
        </button>
      </div>
      {asking === 'suspend' && (
        <Confirm
          title={t('Suspend {name}?', { name: w.name })}
          action={t('Suspend')}
          danger
          busy={suspend.isPending}
          ready={!!why}
          onClose={() => setAsking(null)}
          onConfirm={() => void doSuspend()}
        >
          <div className="op-ask">
            <p>
              {t(
                'Its people can still sign in, read and download, but nothing can be added or changed, and its review links stop. Everyone in it is told by email; your reason stays on this page.',
              )}
            </p>
            {reasonField}
          </div>
        </Confirm>
      )}
      {asking === 'delete' && (
        <Confirm
          title={t('Delete {name}?', { name: w.name })}
          action={t('Delete workspace')}
          danger
          busy={del.isPending}
          ready={!!why && named && !!plan.data}
          onClose={() => setAsking(null)}
          onConfirm={() => void doDelete()}
        >
          <div className="op-ask">
            <p>
              {t(
                'Its videos and every version of them, its notes, review links, playbooks and files go for good, and so do the accounts of its people who work nowhere else. Everyone in it is told by email. This can’t be undone.',
              )}
            </p>
            <TakedownFacts plan={plan.data} />
            {reasonField}
            <label className="set-field">
              <span>
                <T k={'Type <0>{name}</0> to delete it'} values={{ name: w.name }} tags={[(c) => <b className="op-typed">{c}</b>]} />
              </span>
              <input
                className={`input ${typed && !named ? 'invalid' : ''}`}
                value={typed}
                maxLength={200}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('The workspace’s name')}
                data-testid="op-delete-name"
                data-autofocus=""
              />
            </label>
          </div>
        </Confirm>
      )}
    </Card>
  );
}

export function WorkspacePage({ id }: { id: string }) {
  const q = useOpWorkspace(id);
  const billing = !!useInfo()?.billing;
  // from the list: the name and the numbers at once, the people and the plan's log as they arrive
  const listed = useQueryClient()
    .getQueryData<OperatorWorkspaces>(opKeys.workspaces)
    ?.workspaces.find((x) => x.id === id);
  if (refused(q.error)) return <Gone />;
  const d = q.data;
  const w = d?.workspace ?? listed;
  const missing = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
  if (missing)
    return (
      <>
        <Crumb href="#/operator/workspaces" list={t('Workspaces')} />
        <EmptyState
          art="search"
          titleAs="h1"
          title={t('No workspace with this address')}
          testId="op-ws-missing"
          action={
            <Button variant="primary" onClick={() => (location.hash = '#/operator/workspaces')}>
              {t('All workspaces')}
            </Button>
          }
        >
          {t('It may have been removed, or the address is mistyped.')}
        </EmptyState>
      </>
    );
  const plans = d?.plans ?? (w ? !!w.plan : billing);
  return (
    <>
      <Crumb href="#/operator/workspaces" list={t('Workspaces')} />
      <header className="set-head op-title" data-testid="op-workspace">
        <h1>
          {w ? (
            <>
              <WorkspaceMark name={w.name} size="md" />
              <span>{w.name}</span>
            </>
          ) : (
            <SkLine w="12ch" />
          )}
        </h1>
        <p>
          {w ? (
            <>
              {w.owner ? (
                <T k={'Owned by <0>{name}</0> · created {day}'} values={{ name: w.owner.name, day: day(w.created) }} tags={[(c) => <b>{c}</b>]} />
              ) : (
                t('No owner who can sign in · created {day}', { day: day(w.created) })
              )}
              {w.suspended && (
                <>
                  {' '}
                  <span className="badge danger" data-testid="op-suspended-badge">
                    {t('SUSPENDED')}
                  </span>
                </>
              )}
            </>
          ) : (
            <SkLine w="22em" />
          )}
        </p>
      </header>
      {q.error && !d && !w ? (
        <EmptyState art="error" titleAs="h2" title={t('The workspace didn’t load')} action={<Button onClick={() => void q.refetch()}>{t('Try again')}</Button>}>
          {(q.error as Error).message}
        </EmptyState>
      ) : (
        <>
          <Card title={t('At a glance')} testid="op-facts">
            <Facts
              rows={[
                { label: t('Owner'), value: w ? w.owner ? `${w.owner.name} · ${w.owner.email}` : t('nobody who can sign in') : <SkLine w="16em" /> },
                { label: t('Members'), value: w ? String(w.members) : <SkLine w="2em" /> },
                { label: t('Videos'), value: w ? String(w.videos) : <SkLine w="2em" /> },
                { label: t('Storage'), value: w ? storageOf(w.bytes, w.plan?.storage) : <SkLine w="8em" /> },
                {
                  label: t('Last active'),
                  value: w ? w.active ? `${since(w.active)} · ${dayTime(w.active)}` : t('nothing has happened yet') : <SkLine w="10em" />,
                },
                { label: t('Created'), value: w ? dayTime(w.created) : <SkLine w="10em" /> },
                { label: t('Workspace id'), value: id, mono: true },
              ]}
            />
          </Card>
          {plans && (w?.plan && d ? <PlanCard key={`${w.plan.state}-${w.plan.override?.at ?? ''}`} w={w} /> : <PlanPending />)}
          <MembersCard members={d?.members} />
          {plans && <LogCard log={d?.log} />}
          {d && id !== 'w1' && <TakedownCard w={d.workspace} />}
        </>
      )}
    </>
  );
}

/** The plan card on its way: its title and lede line, the form's rows as bars. */
function PlanPending() {
  return (
    <Card title={t('Plan')} lede={<SkLine w="22em" />} testid="op-plan-card">
      <SkeletonRegion label={t('Loading the plan')}>
        <div className="op-plan-now">
          <SkLine w="9em" />
        </div>
        <div className="set-form">
          <SkLine w="18em" />
          <SkLine w="100%" />
        </div>
      </SkeletonRegion>
    </Card>
  );
}
