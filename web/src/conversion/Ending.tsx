// The trial ending and ended (conversion spec §6), at the library's head: one line while closed — its room is held from
// the first paint (Library.tsx, billing/due.ts bannerDue) and it opens only on a click, so nothing below it ever moves on
// its own (audit B-M6). Three days before: the date, and opened, what Free would mean with the workspace's own numbers
// and what happens if nobody chooses. On the last day: the hour. After it: a week of grace and the three honest ways on
// (keep the plan, fit into Free, or do nothing: read-only on a named date), and read-only itself, where Keep becomes
// the view's one orange (Add video is locked then: ReadOnlyPop). Nothing is ever lost by surprise. A failed payment's
// grace and read-only say their own sentence and lead to Settings → Billing, where the card is fixed.

import { Dialog, Popover } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { useAuthStatus, useUsers } from '../api/auth.ts';
import { useBilling } from '../api/queries.ts';
import { stateLine } from '../billing/words.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { usePhone } from '../lib/media.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { graceOf, type Stage, stageOf, trialOf } from './facts.ts';
import { momentEvent } from './moments.ts';
import { BILLING, checkoutHref, clock, dayMonth, keepLine, keepName, overFree, shortDate, size, weekdayDate } from './words.ts';
import '../styles/conversion.css';

// Put away for this visit (the trial's last days only): the banner comes back on the next visit.
const awayThisVisit = new Set<string>();
// Counted once per stage and visit.
const counted = new Set<string>();
// "Fit into Free" from the locked Add video's popover opens the banner's options.
const OPEN = 'cv-banner-open';

export function BillingBanner({ className = '' }: { className?: string }) {
  const b = useBilling().data as BillingInfo | undefined;
  const ws = useAuthStatus().data?.workspace?.name ?? '';
  const stage = stageOf(b);
  const key = `${stage}:${b?.trialEndsAt ?? b?.graceUntil ?? ''}`;
  const [open, setOpen] = useState(false);
  const [, hide] = useState(0);
  useEffect(() => {
    if (!stage || counted.has(key)) return;
    counted.add(key);
    momentEvent('shown', 'banner', stage);
  }, [stage, key]);
  useEffect(() => {
    const f = () => setOpen(true);
    window.addEventListener(OPEN, f);
    return () => window.removeEventListener(OPEN, f);
  }, []);
  if (!b || !stage || awayThisVisit.has(key)) return null;
  if (stage === 'pay') return <PaymentBanner b={b} className={className} />;
  const trialEnd = stage === 'soon' || stage === 'today';
  const tone = stage === 'ro' ? 'bad' : stage === 'soon' ? 'soft' : 'warn';
  const f = trialOf(b);
  const g = graceOf(b);
  const head =
    stage === 'soon'
      ? [t('The trial ends on {date}.', { date: weekdayDate(f?.endsAt ?? '') }), t('Choose a plan to keep everything as it is.')]
      : stage === 'today'
        ? [t('The trial ends today, at {time}.', { time: clock(f?.endsAt ?? '') }), t('Choose a plan and nothing changes. Otherwise a week of grace starts.')]
        : stage === 'grace'
          ? [
              b.reason === 'canceled'
                ? t('The plan has ended.')
                : b.reason === 'over-limit'
                  ? t('{workspace} holds more than its plan.', { workspace: ws })
                  : t('The trial has ended.'),
              t('{workspace} keeps working as it is until {date}.', { workspace: ws, date: weekdayDate(g?.until ?? b.graceUntil ?? '') }),
            ]
          : [t('{workspace} is read-only for now.', { workspace: ws }), t('Nothing is deleted, and the review links you sent keep working.')];
  return (
    <section
      className={`cv-te ${tone} ${open ? 'open' : ''} ${className}`}
      role={stage === 'ro' ? 'alert' : 'status'}
      data-testid="billing-banner"
      data-stage={stage}
    >
      <div className="cv-te-row">
        {stage === 'ro' ? <I name="lock" size={15} /> : <KeyGlyph shape="half" size={12} className="cv-te-kg" />}
        <span className="cv-te-t">
          <b>{head[0]}</b> {head[1]}
        </span>
        <span className="cv-te-acts">
          <button type="button" className="btn ghost sm cv-te-tog" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="banner-more">
            {open ? t('Less') : trialEnd ? t('What Free means') : t('Your options')}
            <I name="down" size={13} />
          </button>
          {!open && b.manage && (
            <a className="btn sm" href={BILLING} data-testid="banner-choose">
              {t('Choose a plan')}
            </a>
          )}
        </span>
        {trialEnd && (
          <IconButton
            className="btn ghost sm icon-only cv-te-x"
            label={t('Hide for now')}
            icon="x"
            size={14}
            onClick={() => {
              awayThisVisit.add(key);
              momentEvent('dismissed', 'banner', stage);
              hide((n) => n + 1);
            }}
          />
        )}
      </div>
      {open && <div className="cv-te-body">{trialEnd ? <WhatFreeMeans b={b} ws={ws} stage={stage} /> : <ThreeWays b={b} stage={stage} />}</div>}
    </section>
  );
}

/** A failed payment's grace or read-only: the sentence Settings → Billing says, and the way there. */
function PaymentBanner({ b, className }: { b: BillingInfo; className: string }) {
  return (
    <section
      className={`cv-te ${b.state === 'read-only' ? 'bad' : 'warn'} ${className}`}
      role={b.state === 'read-only' ? 'alert' : 'status'}
      data-testid="billing-banner"
      data-stage="pay"
    >
      <div className="cv-te-row">
        {b.state === 'read-only' ? <I name="lock" size={15} /> : <KeyGlyph shape="half" size={12} className="cv-te-kg" />}
        <span className="cv-te-t">{stateLine(b)}</span>
        <span className="cv-te-acts">
          <a className="btn sm" href={BILLING}>
            {b.manage ? t('Update the card') : t('Details')}
          </a>
        </span>
      </div>
    </section>
  );
}

/** One resource against Free: what the workspace holds, Free's notch, the part over it hatched. */
function FitBar({ label, has, free, hasLabel, freeLabel }: { label: string; has: number; free: number; hasLabel: string; freeLabel: string }) {
  const scale = Math.max(has, free) * 1.08 || 1;
  const h = (has / scale) * 100;
  const f = (free / scale) * 100;
  return (
    <div className="cv-fit">
      <div className="cv-fit-h">
        <span>{label}</span>
        <b>{hasLabel}</b>
      </div>
      <div className="cv-fit-bar" aria-hidden="true">
        <span className="cv-fit-in" style={{ width: `${Math.min(h, f)}%` }} />
        {has > free && <span className="cv-fit-over" style={{ left: `${f}%`, width: `${h - f}%` }} />}
        <span className="cv-fit-notch" style={{ left: `${f}%` }} />
      </div>
      {/* Free's words hang from its notch, toward the room there is: right of it, or left of it near the end */}
      <div className="cv-fit-free">
        <span style={f > 55 ? { right: `${100 - f}%` } : { left: `${f}%` }}>{freeLabel}</span>
      </div>
    </div>
  );
}

/** 6a/6c opened: what Free would mean for the workspace, and what happens if nobody chooses. */
function WhatFreeMeans({ b, ws, stage }: { b: BillingInfo; ws: string; stage: Stage }) {
  const { free } = overFree(b);
  const f = trialOf(b);
  const graceEnd = f ? new Date(Date.parse(f.endsAt) + 7 * 86_400_000).toISOString() : '';
  return (
    <div className="cv-te-free">
      <div className="cv-te-col">
        <p className="eyebrow">{ws ? t('What Free means for {workspace}', { workspace: ws }) : t('What Free means')}</p>
        <div className="cv-fit-grid">
          <FitBar
            label={t('Members')}
            has={b.usage.members}
            free={free.members}
            hasLabel={String(b.usage.members)}
            freeLabel={t('Free holds {n}', { n: free.members })}
          />
          <FitBar
            label={t('Storage')}
            has={b.usage.bytes}
            free={free.bytes}
            hasLabel={size(b.usage.bytes)}
            freeLabel={t('Free holds {n}', { n: size(free.bytes) })}
          />
          <FitBar
            label={t('Videos under review')}
            has={b.usage.activeVideos}
            free={free.activeVideos}
            hasLabel={String(b.usage.activeVideos)}
            freeLabel={t('Free holds {n}', { n: free.activeVideos })}
          />
        </div>
        <p className="cv-te-say">
          <T
            k={'You have <0>{members} and {bytes}</0>; Free holds <1>{free} and {freeBytes}</1>.'}
            values={{
              members: t('{n} member|{n} members', { n: b.usage.members }),
              bytes: size(b.usage.bytes),
              free: t('{n} member|{n} members', { n: free.members }),
              freeBytes: size(free.bytes),
            }}
            tags={[(c) => <b>{c}</b>, (c) => <b>{c}</b>]}
          />
        </p>
      </div>
      <div className="cv-te-col">
        <p className="eyebrow">{t('If no plan is chosen')}</p>
        <EndLine stage={stage} trialEnd={f?.endsAt ?? ''} graceEnd={graceEnd} />
        <p className="cv-te-say">
          {ws
            ? t(
                'A week of grace, until {date}: everything keeps working. Then {workspace} becomes read-only — reviewing, notes and the links you sent keep working; nothing new is added. Nothing is deleted.',
                { date: dayMonth(graceEnd), workspace: ws },
              )
            : t(
                'A week of grace, until {date}: everything keeps working. Then the workspace becomes read-only — reviewing, notes and the links you sent keep working; nothing new is added. Nothing is deleted.',
                { date: dayMonth(graceEnd) },
              )}
        </p>
        {b.manage && (
          <div className="cv-te-keep">
            <a className="btn sm" href={checkoutHref(b)} onClick={() => momentEvent('used', 'banner', stage)} data-testid="banner-keep">
              {t('Keep {plan}', { plan: b.planName })}
            </a>
            {keepLine(b, true) && <span className="cv-fine">{keepLine(b, true)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The days around the end as a timeline: the trial's end, a week of grace, the day it would become read-only. */
function EndLine({ stage, trialEnd, graceEnd }: { stage: Stage; trialEnd: string; graceEnd: string }) {
  const today = stage === 'soon' ? 6 : stage === 'today' ? 21 : stage === 'grace' ? 40 : 99;
  return (
    <div className="cv-endline" aria-hidden="true">
      <div className="cv-el-track">
        <span className="cv-el-seg trial" />
        <span className="cv-el-seg grace">
          <em>{t('a week of grace: everything works')}</em>
        </span>
        <span className="cv-el-seg ro" />
        <span className="cv-el-today" style={{ left: `${today}%` }}>
          <b>{t('today')}</b>
        </span>
      </div>
      <div className="cv-el-pts">
        <span className="cv-el-pt">
          <KeyGlyph shape="outline" size={9} />
          <span>
            <b>{shortDate(trialEnd)}</b> · {t('Trial ends')}
          </span>
        </span>
        <span className="cv-el-pt">
          <KeyGlyph shape="outline" size={9} />
          <span>
            <b>{shortDate(graceEnd)}</b> · {t('Read-only, if nothing changes')}
          </span>
        </span>
      </div>
    </div>
  );
}

/** 6d/6e opened: keep the plan, fit into Free (exactly what that takes), or do nothing (what still works, what waits). */
function ThreeWays({ b, stage }: { b: BillingInfo; stage: Stage }) {
  const over = overFree(b);
  const me = useAuthStatus().data?.user?.id;
  const users = useUsers(b.manage && over.members > 0).data?.users;
  const others = (users ?? []).filter((u) => u.id !== me && !u.disabled).map((u) => u.name);
  const names = others.length && others.length <= 3 ? others.join(', ') : null;
  const fit = over.members > 0 ? '#/settings/users' : '#/';
  return (
    <div className="cv-te-ways">
      <div className="cv-way lead">
        <p className="eyebrow">{t('Keep {plan}', { plan: keepName(b) })}</p>
        {keepLine(b, true) && <p>{keepLine(b, true)}</p>}
        <p className="cv-fine">{t('Everything stays as it was in the trial, from the moment it’s paid.')}</p>
        {b.manage ? (
          <a
            className={`btn sm ${stage === 'ro' ? 'primary' : ''}`}
            href={checkoutHref(b)}
            onClick={() => momentEvent('used', 'banner', stage)}
            data-testid="banner-keep"
          >
            {t('Choose {plan}', { plan: keepName(b) })}
          </a>
        ) : (
          <p className="cv-fine">{t('The workspace’s owners and admins choose its plan.')}</p>
        )}
      </div>
      <div className="cv-way">
        <p className="eyebrow">{t('Fit into Free')}</p>
        <ul className="cv-todo">
          {over.members > 0 && (
            <li>
              <KeyGlyph shape="outline" size={9} />
              {names
                ? t('{n} member to remove: {names}|{n} members to remove: {names}', { n: over.members, names })
                : t('{n} member to remove|{n} members to remove', { n: over.members })}
            </li>
          )}
          {over.videos > 0 && (
            <li>
              <KeyGlyph shape="outline" size={9} />
              {t('{n} of {of} videos to finish or archive', { n: over.videos, of: b.usage.activeVideos })}
            </li>
          )}
          {over.bytes > 0 && (
            <li>
              <KeyGlyph shape="outline" size={9} />
              {t('{size} to archive or download', { size: size(over.bytes) })}
            </li>
          )}
        </ul>
        <a className="btn sm" href={fit} onClick={() => momentEvent('made_room', 'banner', stage)}>
          {t('Show me how')}
        </a>
      </div>
      <div className="cv-way">
        <p className="eyebrow">{stage === 'ro' ? t('What still works') : t('Or do nothing: on {date}', { date: dayMonth(b.graceUntil ?? '') })}</p>
        <ul className="cv-todo works">
          <li>
            <KeyGlyph shape="diamond" size={9} className="cv-ok" />
            {t('Reviewing, notes, approvals, downloads')}
          </li>
          <li>
            <KeyGlyph shape="diamond" size={9} className="cv-ok" />
            {t('The review links you sent')}
          </li>
          <li className="wait">
            <KeyGlyph shape="outline" size={9} />
            {t('New uploads, versions, members and links wait')}
          </li>
        </ul>
        <p className="cv-fine">{t('Nothing is deleted, ever, because of a plan.')}</p>
      </div>
    </div>
  );
}

/**
 * Read-only: Add video is a neutral button with a lock (never the orange primary that fails later: audit B-M8); a
 * click explains, beside it (a sheet on a phone): new videos wait, what still works, and the two ways on.
 */
export function ReadOnlyPop({ onClose }: { onClose: () => void }) {
  const phone = usePhone();
  const b = useBilling().data as BillingInfo | undefined;
  const ws = useAuthStatus().data?.workspace?.name ?? '';
  const anchor = useRef({ getBoundingClientRect: () => document.querySelector('.topbar .add-video')?.getBoundingClientRect() ?? new DOMRect() });
  if (!b) return null;
  const body = (
    <div className="cv-ro" data-testid="readonly-pop">
      <p className="cv-ro-h">
        <I name="lock" size={14} />
        <b>{t('New videos wait for now')}</b>
      </p>
      <p>
        {t(
          '{workspace} holds more than {plan} allows, so nothing new is added until it fits its plan or has a bigger one. Reviewing and the links you sent keep working.',
          { workspace: ws || t('This workspace'), plan: b.planName },
        )}
      </p>
      <div className="cv-ro-acts">
        {b.manage ? (
          <a className="btn sm primary" href={BILLING} onClick={onClose}>
            {t('Choose a plan')}
          </a>
        ) : null}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event(OPEN));
            document.querySelector('.lib-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          {t('Fit into Free')}
        </button>
      </div>
    </div>
  );
  if (phone)
    return (
      <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="backdrop cv-sheet-backdrop" />
          <Dialog.Content className="cv-sheet" aria-label={t('New videos wait for now')} aria-describedby={undefined}>
            {body}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content className="cv-pop cv-ro-pop" side="bottom" align="end" sideOffset={8} collisionPadding={8} aria-label={t('New videos wait for now')}>
          {body}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
