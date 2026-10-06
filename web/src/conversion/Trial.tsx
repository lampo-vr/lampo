// The trial, visible all along (conversion spec §1): a calm line at the sidebar's foot — "Team trial · 10 days left"
// over a ruler of the trial's days, today the playhead, the end a keyframe (half and amber in the last three days, never
// red, never a dot) — and, on a click only, its popover: what the trial includes with the workspace's own numbers, the
// day it ends, and one way on (Choose a plan, for the people who choose it). A bottom sheet on a phone. The account
// menu carries the same line and opens the same card under the account chip. The grace week after a trial is the same
// line on a 7-day ruler. Loaded after the first paint (billing/due.ts billingCode); the line's room is held before.

import { Dialog, Popover } from 'radix-ui';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { usePhone } from '../lib/media.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, type MenuEntry } from '../ui/primitives.tsx';
import { graceOf, includes, inUse, trialOf } from './facts.ts';
import { momentEvent } from './moments.ts';
import { BILLING, dayMonth, keepLine, leftWords, shortDate, size, trialName, weekdayDate } from './words.ts';
import '../styles/conversion.css';

/** The days as frames on a timeline: the elapsed ones filled, today the playhead, the end a keyframe. */
export function Ruler({ day, of, last, lg }: { day: number; of: number; last?: boolean; lg?: boolean }) {
  const at = Math.min(1, Math.max(0, (day - 0.5) / of));
  return (
    <span className={`cv-ruler ${lg ? 'lg' : ''}`} style={{ '--n': of } as CSSProperties} aria-hidden="true">
      <span className="cv-ruler-cells">
        {Array.from({ length: of }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a day's cell is its place
          <i key={i} className={i < day - 1 ? 'p' : i === day - 1 ? 't' : undefined} />
        ))}
        <span className="cv-ph" style={{ left: `${(at * 100).toFixed(2)}%` }} />
      </span>
      <KeyGlyph shape={last ? 'half' : 'outline'} className={`cv-end ${last ? 'last' : ''}`} />
    </span>
  );
}

/** The ruler's dates: the start, "today" over the playhead, the end; an edge date steps aside when today is near it. */
function Ticks({ day, of, from, to }: { day: number; of: number; from: string; to: string }) {
  const at = Math.min(1, Math.max(0, (day - 0.5) / of));
  return (
    <span className="cv-ticks" aria-hidden="true">
      <span>{at < 0.18 ? '' : shortDate(from)}</span>
      <span className="now" style={{ left: `${(at * 100).toFixed(1)}%` }}>
        {t('today')}
      </span>
      <span>{at > 0.82 ? '' : shortDate(to)}</span>
    </span>
  );
}

/** The line's words and ruler: the trial's, or the grace week's after it. */
function lineOf(b: BillingInfo): { title: string; words: string; day: number; of: number; last: boolean } | null {
  const tr = trialOf(b);
  if (tr) return { title: trialName(b), words: leftWords(tr), day: tr.day, of: tr.of, last: tr.last };
  const g = graceOf(b);
  if (g && b.reason !== 'payment')
    return { title: t('Free · grace'), words: t('until {date}', { date: shortDate(g.until) }), day: g.day, of: g.of, last: true };
  return null;
}

// The card is opened from the sidebar's line, from the drawer's (a sheet: a popover can't open over the drawer, which
// keeps the focus), or from the account menu (anchored under the account chip): one at a time.
type Where = 'sidebar' | 'drawer' | 'menu' | null;
let where: Where = null;
const subs = new Set<() => void>();
const setWhere = (w: Where) => {
  if (w === where) return;
  where = w;
  if (w) momentEvent('shown', 'trial_popover', w);
  for (const f of subs) f();
};
const useWhere = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => where,
  );

/** The sidebar's line (the drawer's foot on a phone): opens the card beside the sidebar, bottom-aligned. */
export function TrialLine({ billing }: { billing: BillingInfo }) {
  const phone = usePhone();
  const w = useWhere();
  const line = lineOf(billing);
  // the same line is in the sidebar and in the phone's or tablet's drawer: each opens its own card (from the drawer a
  // sheet: a popover can't open over the drawer, which keeps the focus)
  const ref = useRef<HTMLButtonElement>(null);
  const [inDrawer, setInDrawer] = useState(false);
  useLayoutEffect(() => setInDrawer(!!ref.current?.closest('.drawer')), []);
  if (!line) return <div className="nav-trial" aria-hidden="true" />;
  const mine: Where = inDrawer ? 'drawer' : 'sidebar';
  const open = w === mine;
  const sheet = phone || inDrawer;
  const button = (
    <button
      ref={ref}
      type="button"
      className={`nav-trial ${line.last ? 'last' : ''}`}
      aria-label={`${line.title}: ${line.words}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-testid="trial-line"
      // as a popover's trigger, Radix toggles it (onOpenChange)
      onClick={sheet ? () => setWhere(open ? null : mine) : undefined}
    >
      <span className="nav-trial-top">
        <b>{line.title}</b>
        <span>{line.words}</span>
      </span>
      <Ruler day={line.day} of={line.of} last={line.last} />
    </button>
  );
  if (sheet)
    return (
      <>
        {button}
        <TrialSheet billing={billing} open={open} />
      </>
    );
  return (
    <Popover.Root open={open} onOpenChange={(o) => setWhere(o ? mine : null)}>
      <Popover.Trigger asChild>{button}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cv-pop"
          onOpenAutoFocus={focusCard}
          side="right"
          align="end"
          sideOffset={12}
          collisionPadding={8}
          aria-label={line.title}
          data-testid="trial-pop"
        >
          <TrialCard billing={billing} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A card opens with the focus on itself (its words first, then Tab to its actions), not on its × with a tooltip. */
const focusCard = (e: Event) => {
  e.preventDefault();
  (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('.cv-card')?.focus();
};

/** The account menu's rows while a trial runs: the trial's line (opens its card) and Billing with a quiet tag. */
export function menuEntries(b: BillingInfo | null | undefined): MenuEntry[] {
  if (!b) return [];
  const line = lineOf(b);
  if (!line) return [];
  return [
    { label: `${line.title} · ${line.words}`, mark: <KeyGlyph shape="hold" size={9} />, onClick: () => setTimeout(() => setWhere('menu')) },
    b.manage && {
      label: t('Billing'),
      icon: 'billing',
      shortcut: trialOf(b) ? t('Trial') : t('Grace period'),
      onClick: () => (location.hash = '#/settings/billing'),
    },
    'sep',
  ];
}

/** The card opened from the account menu: under the account chip (a sheet on a phone). */
export function MenuTrialCard({ billing }: { billing: BillingInfo | null | undefined }) {
  const phone = usePhone();
  const w = useWhere();
  const anchor = useRef({ getBoundingClientRect: () => document.querySelector('.topbar .user-chip')?.getBoundingClientRect() ?? new DOMRect() });
  if (!billing || !lineOf(billing)) return null;
  const open = w === 'menu';
  if (phone) return <TrialSheet billing={billing} open={open} />;
  return (
    <Popover.Root open={open} onOpenChange={(o) => setWhere(o ? 'menu' : null)}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          className="cv-pop"
          onOpenAutoFocus={focusCard}
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={trialName(billing)}
          data-testid="trial-pop"
        >
          <TrialCard billing={billing} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TrialSheet({ billing, open }: { billing: BillingInfo; open: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && setWhere(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="backdrop cv-sheet-backdrop" />
        <Dialog.Content className="cv-sheet" aria-describedby={undefined} data-testid="trial-pop">
          <TrialCard billing={billing} sheet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One fact of what the trial includes: its icon, its name, the workspace's number (and a mini bar of the room). */
function Fact({ icon, name, value, share }: { icon: IconName; name: string; value: string; share?: number | null }) {
  return (
    <div>
      <I name={icon} size={14} />
      <dt>{name}</dt>
      <dd>
        {value}
        {share != null && (
          <span className="cv-mini" aria-hidden="true">
            <i style={{ width: `${Math.max(3, Math.min(100, share * 100)).toFixed(1)}%` }} />
          </span>
        )}
      </dd>
    </div>
  );
}

/** The popover's card: the end, the ruler with its dates, what the trial includes for this workspace, one way on. */
export function TrialCard({ billing: b, sheet }: { billing: BillingInfo; sheet?: boolean }) {
  const ws = useAuthStatus().data?.workspace?.name ?? '';
  const tr = trialOf(b);
  const g = tr ? null : graceOf(b);
  const close = () => setWhere(null);
  const first = useRef<HTMLButtonElement>(null);
  // the card speaks first to a screen reader and the keyboard: its close button takes the focus on a phone's sheet
  useEffect(() => {
    if (sheet) first.current?.focus();
  }, [sheet]);
  const head = (eyebrow: string, aside: ReactNode) => (
    <header className="cv-pop-head">
      <span className="eyebrow">
        <KeyGlyph shape="hold" size={8} /> {eyebrow}
      </span>
      <span className="cv-pop-day">{aside}</span>
      {sheet ? (
        <Dialog.Close asChild>
          <IconButton ref={first} className="btn ghost sm icon-only cv-x" label={t('Close')} icon="x" size={14} />
        </Dialog.Close>
      ) : (
        <Popover.Close asChild>
          <IconButton className="btn ghost sm icon-only cv-x" label={t('Close')} icon="x" size={14} />
        </Popover.Close>
      )}
    </header>
  );
  const foot = (
    <footer className="cv-pop-foot">
      {b.manage ? (
        <>
          <a
            className="btn primary"
            href={BILLING}
            onClick={() => {
              momentEvent('used', 'trial_popover', where ?? undefined);
              close();
            }}
            data-testid="trial-choose"
          >
            {t('Choose a plan')}
          </a>
          {keepLine(b) && <span className="cv-fine">{keepLine(b)}</span>}
        </>
      ) : (
        <span className="cv-fine">{t('The workspace’s owners and admins choose its plan.')}</span>
      )}
    </footer>
  );
  if (g)
    return (
      <div className="cv-card" tabIndex={-1}>
        {head(t('Free · grace'), t('Day {day} of {of}', { day: g.day, of: g.of }))}
        <h3>{t('Everything works until {date}', { date: weekdayDate(g.until) })}</h3>
        <p className="cv-pop-sub">{t('The trial has ended. A week of grace, then {workspace} becomes read-only until it fits its plan.', { workspace: ws })}</p>
        <div className="cv-ruler-lg">
          <Ruler day={g.day} of={g.of} last lg />
          <Ticks day={g.day} of={g.of} from={new Date(Date.parse(g.until) - g.of * 86_400_000).toISOString()} to={g.until} />
        </div>
        <p className="cv-pop-after">{t('Reviewing, notes, approvals, downloads and the review links you sent keep working. Nothing is deleted.')}</p>
        {foot}
      </div>
    );
  if (!tr) return null;
  return (
    <div className="cv-card" tabIndex={-1}>
      {head(trialName(b), t('Day {day} of {of}', { day: tr.day, of: tr.of }))}
      <h3>{t('Ends {date}', { date: weekdayDate(tr.endsAt) })}</h3>
      <p className="cv-pop-sub">
        {tr.left === 0
          ? t('Ends today. No card until you choose a plan.')
          : t('{n} day left. No card until you choose a plan.|{n} days left. No card until you choose a plan.', { n: tr.left })}
      </p>
      <div className="cv-ruler-lg">
        <Ruler day={tr.day} of={tr.of} last={tr.last} lg />
        <Ticks day={tr.day} of={tr.of} from={tr.startsAt} to={tr.endsAt} />
      </div>
      <div className="cv-pop-sec">
        <p className="cv-pop-h">
          {ws ? t('Everything in {plan}, for {workspace}', { plan: b.planName, workspace: ws }) : t('Everything in {plan}', { plan: b.planName })}
        </p>
        <dl className="cv-facts">
          <Fact
            icon="users"
            name={t('Members')}
            value={
              b.limits.members === null
                ? t('{n} · no limit', { n: b.usage.members })
                : t('{used} of {limit}', { used: b.usage.members, limit: b.limits.members })
            }
            share={b.limits.members ? b.usage.members / b.limits.members : null}
          />
          <Fact
            icon="box"
            name={t('Storage')}
            value={b.limits.bytes === null ? size(b.usage.bytes) : t('{used} of {limit}', { used: size(b.usage.bytes), limit: size(b.limits.bytes) })}
            share={b.limits.bytes ? b.usage.bytes / b.limits.bytes : null}
          />
          <Fact
            icon="film"
            name={t('Videos under review')}
            value={
              b.limits.activeVideos === null
                ? t('{n} · no limit', { n: b.usage.activeVideos })
                : t('{used} of {limit}', { used: b.usage.activeVideos, limit: b.limits.activeVideos })
            }
          />
          {includes(b, 'roles') && includes(b, 'insights') && includes(b, 'webhooks') && (
            <Fact
              icon="shield"
              name={t('Roles, Insights, webhooks')}
              value={inUse(b, 'roles') || inUse(b, 'insights') || inUse(b, 'webhooks') ? t('in use') : t('included')}
            />
          )}
          <Fact icon="link" name={t('Review links')} value={t('in your name')} />
        </dl>
      </div>
      <p className="cv-pop-after">
        {ws
          ? t('After {date}, {workspace} moves to Free unless you choose a plan. Nothing is deleted.', { date: dayMonth(tr.endsAt), workspace: ws })
          : t('After {date}, the workspace moves to Free unless you choose a plan. Nothing is deleted.', { date: dayMonth(tr.endsAt) })}
      </p>
      {foot}
    </div>
  );
}

/** The trial facts a test or the library reads without rendering (the line's words). */
export const trialLineWords = (b: BillingInfo): string | null => {
  const l = lineOf(b);
  return l ? `${l.title} · ${l.words}` : null;
};
