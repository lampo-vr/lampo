// Settings → Billing's first part: the plan, one panel, the page's answer to "where do we stand". The plan's name is
// the only heading, with a tag for its state; the price on the right (owners and admins); one sentence with the dates;
// a trial's or a grace period's days as a ruler; in a trial's last three days what Free would mean for the workspace;
// extra storage; what the workspace uses; and the one thing to do in that state (change or cancel a running plan, keep
// a cancelled one, pay a renewal that didn't go through, or — for a member — let the owners know). Cancelling is
// "Cancel contracts here" (§ 312k BGB): its own confirmation step, billing/Cancel.tsx.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { BillingInfo, BillingOffer } from '../../../lib/types.ts';
import { ApiError, api } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { toast } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { toastRefusal, useCancel } from './api.ts';
import { FitGrid, Meter, Ruler, RulerTicks } from './parts.tsx';
import { dayOf, daysUntil, money, ofLimit, size, stateLine, unitsFor, whyFailed } from './words.ts';

const DAY = 86_400_000;
/** A failed renewal's grace (the provider's): a week from the failure to read-only. */
const GRACE_DAYS = 7;

/** Where the workspace stands, as the page draws it. */
export type Kind = 'comp' | 'trial' | 'free' | 'paid' | 'cancelled' | 'failed' | 'grace' | 'read-only';

export function kindOf(b: BillingInfo): Kind {
  if (b.complimentary) return 'comp';
  if ((b.state === 'grace' || b.state === 'read-only') && b.reason === 'payment') return 'failed';
  if (b.state === 'trial') return 'trial';
  if (b.state === 'paid') return b.endsAt ? 'cancelled' : 'paid';
  return b.state;
}

/** A trial's days, from its start (the provider's, or fourteen days before its end) to its end, and today's place. */
function trialSpan(b: BillingInfo, now: number) {
  const end = Date.parse(b.trialEndsAt ?? '');
  const start = b.trialStartsAt ? Date.parse(b.trialStartsAt) : end - 14 * DAY;
  const of = Math.max(1, Math.round((end - start) / DAY));
  return { of, day: Math.min(of, Math.max(1, Math.floor((now - start) / DAY) + 1)), start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** The week of grace after a failed renewal: the failure is its first day. */
function graceSpan(b: BillingInfo, now: number) {
  const end = Date.parse(b.graceUntil ?? '');
  const start = end - GRACE_DAYS * DAY;
  return {
    of: GRACE_DAYS,
    day: Math.min(GRACE_DAYS, Math.max(1, Math.floor((now - start) / DAY) + 1)),
    start: new Date(start).toISOString(),
    end: b.graceUntil ?? '',
  };
}

/** What the running plan costs this workspace per billing period (its members, its extra storage), from its offer. */
export function planPrice(
  b: BillingInfo,
): { offer: BillingOffer; interval: 'month' | 'year'; currency: string; units: number; period: number; unitMonth: number } | null {
  const offer = b.offers?.find((o) => o.plan === b.plan);
  const currency = b.currency ?? 'eur';
  const p = offer?.prices[currency];
  if (!offer || !p) return null;
  const interval = b.interval ?? 'month';
  const units = b.seats ?? unitsFor(offer, b.usage.members);
  // `addons` comes with the price of one terabyte even when none is bought: only bought terabytes are billed
  const period = (interval === 'year' ? p.year : p.month) * units + (b.addons?.storageTB ?? 0) * (b.addons?.price ?? 0);
  return { offer, interval, currency, units, period, unitMonth: interval === 'year' ? Math.round(p.year / 12) : p.month };
}

export function PlanPanel({
  b,
  ws,
  picker,
  onPicker,
  onFix,
}: {
  b: BillingInfo | null;
  ws: string;
  /** The plans are open under the panel (Change plan). */
  picker: boolean;
  onPicker: () => void;
  /** A renewal that didn't go through: the fix, in a sheet. */
  onFix: () => void;
}) {
  if (!b)
    return (
      <section className="panel bill-hero" aria-label={t('Plan')} aria-busy="true" data-testid="billing-plan">
        <div className="bill-hero-top">
          <div className="bill-hero-name">
            <h2>
              <SkLine w="4em" />
            </h2>
          </div>
        </div>
        <p className="bill-hero-line">
          <SkLine w="70%" />
        </p>
      </section>
    );
  return <Loaded b={b} ws={ws} picker={picker} onPicker={onPicker} onFix={onFix} />;
}

function Loaded({ b, ws, picker, onPicker, onFix }: { b: BillingInfo; ws: string; picker: boolean; onPicker: () => void; onFix: () => void }) {
  const now = Date.now();
  const kind = kindOf(b);
  const cancel = useCancel();
  const price = b.manage ? planPrice(b) : null;
  const left = b.trialEndsAt ? daysUntil(b.trialEndsAt, now) : 0;
  const renews = b.renewsAt ? dayOf(b.renewsAt, { year: true }) : '';
  const failedOn = b.graceUntil ? new Date(Date.parse(b.graceUntil) - GRACE_DAYS * DAY).toISOString() : '';
  const until = b.graceUntil ? dayOf(b.graceUntil, { weekday: true }) : '';
  const canPay = b.manage && b.available !== false && !!b.payments;

  const keep = async () => {
    try {
      await cancel.mutateAsync(false);
      toast(t('{plan} goes on.', { plan: b.planName }), 'ok');
    } catch (e) {
      toastRefusal(e);
    }
  };

  // the tag beside the name: the state in two words
  const tag =
    kind === 'comp' ? (
      <span className="badge ok">{t('On the house')}</span>
    ) : kind === 'trial' ? (
      <span className={`badge ${left <= 3 ? 'warn' : ''}`}>
        {left <= 0 ? t('Trial · ends today') : t('Trial · {n} day left|Trial · {n} days left', { n: left })}
      </span>
    ) : kind === 'paid' ? (
      <span className="badge ok">{t('Active')}</span>
    ) : kind === 'cancelled' && b.endsAt ? (
      <span className="badge warn">{t('Ends {date}', { date: dayOf(b.endsAt, { short: true }) })}</span>
    ) : kind === 'failed' ? (
      <span className="badge danger">{t('Payment due')}</span>
    ) : kind === 'grace' ? (
      <span className="badge warn">{t('Grace period')}</span>
    ) : kind === 'read-only' ? (
      <span className="badge danger">{t('Read-only')}</span>
    ) : null;

  // the price, right: what this workspace pays (owners and admins only)
  const vat = b.tax === 'included' ? 'included' : 'plus';
  const priceBlock =
    kind === 'trial' && b.manage ? (
      <div className="bill-hero-price">
        <span className="bill-hp-k">{t('Nothing to pay yet')}</span>
        <span className="bill-hp-s">{t('No card until you choose')}</span>
      </div>
    ) : price && (kind === 'paid' || kind === 'cancelled' || kind === 'failed') ? (
      <div className="bill-hero-price" data-testid="billing-price">
        <span className="bill-hp-k">
          <b>{money(price.period, price.currency)}</b> {price.interval === 'year' ? t('a year') : t('a month')}
        </span>
        <span className="bill-hp-s">
          {price.interval === 'year'
            ? vat === 'plus'
              ? t('about {amount} a month · plus VAT', { amount: money(Math.round(price.period / 1200) * 100, price.currency) })
              : t('about {amount} a month · VAT included', { amount: money(Math.round(price.period / 1200) * 100, price.currency) })
            : vat === 'plus'
              ? t('Billed monthly · plus VAT')
              : t('Billed monthly · VAT included')}
        </span>
      </div>
    ) : null;

  // one sentence: where it stands, with the dates
  const line = (() => {
    switch (kind) {
      case 'comp':
        return t(
          '{ws} is complimentary: everything Lampo has, no limits, nothing to pay and no plan to choose. If that ever changes, you’ll hear from us a month before.',
          { ws },
        );
      case 'trial': {
        const date = b.trialEndsAt ? dayOf(b.trialEndsAt, { weekday: true }) : '';
        return b.manage
          ? t('Everything in {plan} until {date}. Choose a plan below to keep it; without one, {ws} moves to Free.', { plan: b.planName, date, ws })
          : t('Everything in {plan} until {date}. The owner and the admins choose a plan to keep it.', { plan: b.planName, date });
      }
      case 'paid':
        if (!b.renewsAt) return stateLine(b, now);
        if (!b.manage)
          return b.seats
            ? t('For {n} member, renews on {date}.|For {n} members, renews on {date}.', { n: b.seats, date: renews })
            : t('Renews on {date}.', { date: renews });
        if (price?.offer.perMember)
          return price.interval === 'year'
            ? t(
                'Billed yearly for {n} member, renews on {date}. The bill follows the people: someone new adds {amount} a month, prorated.|Billed yearly for {n} members, renews on {date}. The bill follows the people: someone new adds {amount} a month, prorated.',
                { n: price.units, date: renews, amount: money(price.unitMonth, price.currency) },
              )
            : t(
                'Billed monthly for {n} member, renews on {date}. The bill follows the people: someone new adds {amount} a month, prorated.|Billed monthly for {n} members, renews on {date}. The bill follows the people: someone new adds {amount} a month, prorated.',
                { n: price.units, date: renews, amount: money(price.unitMonth, price.currency) },
              );
        return b.interval === 'year' ? t('Billed yearly, renews on {date}.', { date: renews }) : t('Billed monthly, renews on {date}.', { date: renews });
      case 'cancelled': {
        const date = dayOf(b.endsAt ?? '', { year: true });
        // cancelled with one month's notice: the refund it owes (owners and admins only are told)
        if (b.manage && b.refund)
          return t(
            'Cancelled with one month’s notice: {plan} runs until {date}, then {ws} moves to Free, and the time paid for after that, {amount}, goes back to your card. Nothing is deleted, and you can keep {plan} until then with one click.',
            { plan: b.planName, date, ws, amount: money(b.refund.amount, b.refund.currency, { cents: true }) },
          );
        return b.manage
          ? t('Cancelled: {plan} runs until {date}, then {ws} moves to Free. Nothing is deleted, and you can keep {plan} until then with one click.', {
              plan: b.planName,
              date,
              ws,
            })
          : t('Cancelled: {plan} runs until {date}, then {ws} moves to Free. Nothing is deleted.', { plan: b.planName, date, ws });
      }
      case 'failed': {
        const date = failedOn ? dayOf(failedOn) : '';
        if (!b.manage)
          return b.state === 'grace'
            ? t('The last payment for {ws} didn’t go through. Everything keeps working until {until}; the owner and the admins can update the card.', {
                ws,
                until,
              })
            : t(
                'The last payment for {ws} didn’t go through, so it is read-only until it’s paid. The owner and the admins can update the card; nothing is deleted.',
                {
                  ws,
                },
              );
        if (b.state === 'read-only')
          return t(
            'The renewal on {date} didn’t go through, so {ws} is read-only until it’s paid. Reviewing, notes, approvals, downloads and every review link sent keep working; nothing is deleted.',
            { date, ws },
          );
        return b.failure?.method
          ? t('The renewal on {date} didn’t go through: {why}. Everything keeps working until {until}; after that {ws} is read-only until it’s paid.', {
              date,
              why: whyFailed(b.failure.code, b.failure.method),
              until,
              ws,
            })
          : t('The renewal on {date} didn’t go through. Everything keeps working until {until}; after that {ws} is read-only until it’s paid.', {
              date,
              until,
              ws,
            });
      }
      default:
        return stateLine(b, now);
    }
  })();

  const tone = kind === 'failed' || kind === 'read-only' ? 'bad' : kind === 'cancelled' || kind === 'grace' || (kind === 'trial' && left <= 3) ? 'warn' : '';
  const trial = kind === 'trial' && b.trialEndsAt ? trialSpan(b, now) : null;
  const grace = (kind === 'failed' || kind === 'grace') && b.state === 'grace' && b.graceUntil ? graceSpan(b, now) : null;
  const { usage, limits } = b;
  const noLimit = (n: string) => t('{n} · no limit', { n });
  const meter = (used: number, limit: number | null, show: (n: number) => string) =>
    kind === 'comp' || limit === null ? { value: noLimit(show(used)), share: null } : { value: ofLimit(show(used), show(limit)), share: used / limit };
  const members = meter(usage.members, limits.members, String);
  const storage = meter(usage.bytes, limits.bytes, size);
  const videos = meter(usage.activeVideos, limits.activeVideos, String);
  const addon = b.addons?.storageTB && b.manage && kind !== 'trial' && kind !== 'comp' ? b.addons : null;

  return (
    <section className={`panel bill-hero ${tone}`} aria-label={t('Plan')} data-testid="billing-plan" data-kind={kind}>
      <div className="bill-hero-top">
        <div className="bill-hero-name">
          <h2>{kind === 'comp' ? t('Complimentary') : b.planName}</h2>
          {tag}
        </div>
        {priceBlock}
      </div>
      <p className="bill-hero-line" data-testid="billing-line">
        {line}
      </p>
      {trial && (
        <div className="bill-hero-ruler" data-testid="billing-ruler">
          <Ruler day={trial.day} of={trial.of} end={left <= 3 ? 'half' : 'outline'} tone={left <= 3 ? 'should' : ''} />
          <RulerTicks day={trial.day} of={trial.of} start={trial.start} end={trial.end} />
        </div>
      )}
      {grace && (
        <div className={`bill-hero-ruler ${kind === 'failed' ? 'grace' : ''}`} data-testid="billing-ruler">
          <Ruler day={grace.day} of={grace.of} end={kind === 'failed' ? 'diamond' : 'half'} tone={kind === 'failed' ? 'must' : 'should'} />
          <RulerTicks day={grace.day} of={grace.of} start={grace.start} end={grace.end} />
        </div>
      )}
      {kind === 'trial' && b.manage && left <= 3 && (
        <div className="bill-hero-free">
          <p className="bill-k">{t('What Free would mean for {ws}', { ws })}</p>
          <FitGrid usage={usage} />
          <p className="bill-fine">
            {t('A week of grace after {date}, then read-only until it fits. Nothing is deleted.', { date: dayOf(b.trialEndsAt ?? '') })}
          </p>
        </div>
      )}
      {addon && (
        <div className="bill-hero-addon" data-testid="billing-addon">
          <I name="archive" size={14} />
          <span>
            <b>{t('Extra storage')}</b> ·{' '}
            {t('{size} · {amount} {per}', {
              size: size(addon.storageTB * 1e12),
              amount: money(addon.price, b.currency ?? 'eur'),
              per: b.interval === 'year' ? t('a year') : t('a month'),
            })}
          </span>
        </div>
      )}
      <div className="bill-usage" data-testid="billing-usage">
        <Meter label={t('Members')} value={members.value} share={members.share} testid="billing-members" />
        <Meter label={t('Storage')} value={storage.value} share={storage.share} testid="billing-storage" />
        <Meter label={t('Videos under review')} value={videos.value} share={videos.share} testid="billing-videos" />
      </div>
      <Actions b={b} kind={kind} ws={ws} picker={picker} onPicker={onPicker} onFix={onFix} canPay={canPay} busy={cancel.isPending} onKeep={keep} />
    </section>
  );
}

function Actions({
  b,
  kind,
  ws,
  picker,
  onPicker,
  onFix,
  canPay,
  busy,
  onKeep,
}: {
  b: BillingInfo;
  kind: Kind;
  ws: string;
  picker: boolean;
  onPicker: () => void;
  onFix: () => void;
  canPay: boolean;
  busy: boolean;
  onKeep: () => void;
}) {
  if (kind === 'paid' && b.manage && b.available !== false && b.subscribed)
    return (
      <div className="bill-hero-acts">
        <button type="button" className="btn sm bill-raised" aria-expanded={picker} onClick={onPicker} data-testid="billing-change">
          {picker ? t('Close plans') : t('Change plan')}
        </button>
        {/* § 312k BGB: its own words, leading straight to the confirmation step (billing/Cancel.tsx) */}
        <a className="btn ghost sm bill-quiet" href="#/settings/billing/cancel" data-testid="billing-cancel">
          {t('Cancel contracts here')}
        </a>
      </div>
    );
  if (kind === 'cancelled' && b.manage && b.available !== false)
    return (
      <div className="bill-hero-acts">
        <button type="button" className="btn primary" onClick={onKeep} disabled={busy} data-testid="billing-resume">
          {busy && <Spinner />} {t('Keep {plan}', { plan: b.planName })}
        </button>
        <span className="bill-fine">
          {b.refund ? t('Then nothing is refunded: it simply renews again.') : t('Nothing is charged now: it simply renews again.')}
        </span>
      </div>
    );
  if (kind === 'failed' && b.manage && canPay)
    return (
      <div className="bill-hero-acts">
        <button type="button" className="btn primary" onClick={onFix} data-testid="billing-pay-now">
          {b.failure ? t('Pay {amount}', { amount: money(b.failure.amount, b.failure.currency, { cents: true }) }) : t('Pay now')}
        </button>
        <span className="bill-fine">{t('With a new card; it renews from then on.')}</span>
      </div>
    );
  if (kind === 'failed' && !b.manage) return <Nudge ws={ws} />;
  return null;
}

/** A member can't pay: one notification to the owners and admins, once per failure (POST /api/billing/nudge). */
function Nudge({ ws }: { ws: string }) {
  const [told, setTold] = useState(false);
  const nudge = useMutation({ mutationFn: () => api('/api/billing/nudge', { method: 'POST' }) });
  const tell = async () => {
    try {
      await nudge.mutateAsync();
      setTold(true);
    } catch (e) {
      // a provider without the route yet: say it plainly, nothing else went wrong
      if (e instanceof ApiError && e.status === 404) toast(t('Couldn’t tell them right now. Let the owner of {ws} know yourself.', { ws }), 'error');
      else toastRefusal(e);
    }
  };
  return (
    <div className="bill-hero-acts">
      {told ? (
        <span className="bill-told" role="status" data-testid="billing-nudged">
          <KeyGlyph shape="diamond" className="bill-ok" />
          {t('The owner and the admins have an email about it')}
        </span>
      ) : (
        <button type="button" className="btn sm bill-raised" onClick={tell} disabled={nudge.isPending} data-testid="billing-nudge">
          {nudge.isPending && <Spinner />} {t('Let them know')}
        </button>
      )}
    </div>
  );
}
