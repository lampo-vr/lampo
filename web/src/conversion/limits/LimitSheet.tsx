// A limit is reached: a sheet, not a toast (the toaster opens it for a 402 or a feature of a higher plan, ui/layers.tsx).
// It names what was asked for and why there is no room, with the workspace's own numbers; what fits, by the smallest step
// (a plan, or one more terabyte when that is the cheaper answer); what changes, now → then; and it pays right there
// (conversion/pay.tsx). The other way out — making room — is on it too. "Not now" leaves what was asked for waiting
// (an upload stays in the tray), and once the plan holds it, it goes on by itself (`ask.retry`). Only owners and admins
// choose a plan: anyone else, a review link's page, or a server without a billing provider gets the refusal's sentence as a
// toast, as before. Never more than one orange button: Pay. Its code loads the first time a limit is reached.

import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BillingInfo, BillingPreview } from '../../../../lib/types.ts';
import { useAuthStatus } from '../../api/auth.ts';
import { useBilling, useInfo, useLibrary } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { useLang } from '../../i18n/T.tsx';
import { storePref } from '../../lib/prefs.ts';
import { refusalText } from '../../lib/refusal.ts';
import { type LimitAsk, toast } from '../../lib/toast.ts';
import { LIBRARY_PER_TAB, LIBRARY_PREFS } from '../../library/model.ts';
import { Spinner } from '../../ui/feedback.tsx';
import { I, type IconName } from '../../ui/icons.tsx';
import { KeyGlyph } from '../../ui/KeyGlyph.tsx';
import { IconButton } from '../../ui/primitives.tsx';
import { currencyOf, periodTotal } from '../facts.ts';
import { momentEvent } from '../moments.ts';
import { PayInPlace, type PayWhat, previewMoney, previewSwitch } from '../pay.tsx';
import {
  changeRows,
  contractMail,
  day,
  type Fit,
  fitFor,
  keepOf,
  ledeOf,
  money,
  needOf,
  payLabel,
  planLine,
  priceOf,
  type Reason,
  reasonOf,
  saving,
  size,
  titleOf,
} from './model.ts';
import '../../styles/limits.css';

type Phase = 'offer' | 'confirming' | 'done';

const ICON: Record<Reason, IconName> = { storage: 'archive', members: 'users', videos: 'film', feature: 'chart' };
const eyebrowOf = (r: Reason, ask: LimitAsk) =>
  r === 'storage'
    ? t('Storage')
    : r === 'members'
      ? t('Members')
      : r === 'videos'
        ? t('Videos under review')
        : ask.feature === 'roles'
          ? t('Roles')
          : ask.feature === 'webhooks'
            ? t('Webhooks')
            : 'Insights';

/** Where the sheet can't show, the refusal says itself as before: a toast (with the way to the plans for who chooses them). */
function sayInstead(ask: LimitAsk, manage: boolean) {
  const said = refusalText(ask.message ?? '', ask as Record<string, unknown>);
  toast(
    manage ? said : `${said} ${t('Owners and admins choose the plan.')}`,
    'error',
    manage
      ? {
          label: t('See plans'),
          onClick: () => {
            location.hash = '#/settings/billing';
          },
        }
      : undefined,
  );
}

export function LimitSheet({ ask, onClose }: { ask: LimitAsk; onClose: () => void }) {
  const info = useInfo();
  const [phase, setPhase] = useState<Phase>('offer');
  const q = useBilling(!!info?.billing, phase === 'confirming');
  const b = q.data as BillingInfo | undefined;
  const reason = reasonOf(ask);
  const guest = location.pathname.startsWith('/g/');
  // a sheet for who chooses the plan, where paying works; anyone else reads the sentence
  const sheet = !guest && !!reason && !!b && b.manage && !b.complimentary && b.available !== false && !!b.offers?.length;
  const known = guest || (info !== null && (!info.billing || !!b || q.isError));
  const closed = useRef(false);
  useEffect(() => {
    if (!known || sheet || closed.current) return;
    closed.current = true;
    sayInstead(ask, !!b?.manage);
    onClose();
  }, [known, sheet, ask, b, onClose]);
  if (!sheet || !b || !reason) return null;
  return <Sheet ask={ask} b={b} reason={reason} phase={phase} setPhase={setPhase} onClose={onClose} />;
}

function Sheet({
  ask,
  b,
  reason,
  phase,
  setPhase,
  onClose,
}: {
  ask: LimitAsk;
  b: BillingInfo;
  reason: Reason;
  phase: Phase;
  setPhase: (p: Phase) => void;
  onClose: () => void;
}) {
  useLang();
  const workspace = useAuthStatus().data?.workspace?.name ?? '';
  const [interval, setInterval] = useState<'month' | 'year'>(b.interval ?? 'year');
  // the step that fits and what the workspace holds then are decided once, from the plan the sheet opened on
  const [start] = useState(() => ({ fit: fitFor(b, ask, reason), need: needOf(b, ask, reason), plan: b.plan, bytes: b.limits.bytes ?? 0 }));
  const { fit, need } = start;
  const currency = currencyOf(b, fit.kind === 'plan' ? fit.offer : null);
  const switching = fit.kind === 'plan' && !!b.subscribed;
  // shown: counted once; put away or used: counted as it happens
  useEffect(() => {
    momentEvent('shown', 'limit_sheet', reason);
  }, [reason]);
  // paid: the provider confirms a moment later; then what waited goes on by itself
  const arrived =
    phase === 'confirming' &&
    (fit.kind === 'addon' ? (b.limits.bytes ?? 0) >= start.bytes + fit.tb * 1e12 : fit.kind === 'plan' && b.plan === fit.offer.plan && b.state === 'paid');
  useEffect(() => {
    if (phase !== 'confirming') return;
    // the provider is slow to say so: what waited is asked again anyway (a refusal brings the sheet back)
    const late = window.setTimeout(() => setPhase('done'), 30_000);
    return () => window.clearTimeout(late);
  }, [phase, setPhase]);
  useEffect(() => {
    if (arrived) setPhase('done');
  }, [arrived, setPhase]);
  const retried = useRef(false);
  useEffect(() => {
    if (phase !== 'done' || retried.current) return;
    retried.current = true;
    momentEvent('used', 'limit_sheet', reason);
    void Promise.resolve(ask.retry?.()).catch(() => {});
  }, [phase, ask, reason]);
  const notNow = () => {
    if (phase === 'offer') momentEvent('dismissed', 'limit_sheet', reason);
    onClose();
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && notNow()}>
      <Dialog.Portal>
        <Dialog.Overlay className="lim-scrim" />
        <Dialog.Content
          className={`lim-sheet ${phase === 'done' ? 'done' : ''}`}
          aria-describedby={undefined}
          data-testid="limit-sheet"
          data-reason={reason}
          data-fit={fit.kind === 'plan' ? fit.offer.plan : fit.kind}
          onOpenAutoFocus={(e) => {
            // the title is read out first; nothing is pressed by accident
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLElement>('h2')?.focus();
          }}
        >
          {phase === 'done' ? (
            <Done ask={ask} b={b} fit={fit} reason={reason} workspace={workspace} onClose={onClose} />
          ) : (
            <>
              <header className="lim-head">
                <span className="lim-eyebrow">
                  <I name={ICON[reason]} size={13} />
                  {eyebrowOf(reason, ask)}
                </span>
                <IconButton className="btn ghost sm icon-only lim-x" label={t('Not now')} icon="x" size={15} onClick={notNow} />
                <Dialog.Title asChild>
                  <h2 tabIndex={-1}>{titleOf(reason, ask, workspace, fit)}</h2>
                </Dialog.Title>
                <p className="lim-lede">{ledeOf(reason, ask, b, workspace, fit)}</p>
                {reason === 'storage' && typeof ask.needed === 'number' && <Meter b={b} needed={ask.needed} fit={fit} />}
              </header>
              <div className="lim-body">
                <section className="lim-fit" aria-label={t('What fits')}>
                  <p className="lim-k">{t('What fits')}</p>
                  <FitBlock b={b} fit={fit} reason={reason} need={need} interval={interval} onInterval={setInterval} currency={currency} ask={ask} />
                </section>
                <section className="lim-pay" aria-label={t('Paying')}>
                  <PayColumn
                    ask={ask}
                    b={b}
                    workspace={workspace}
                    fit={fit}
                    reason={reason}
                    need={need}
                    interval={interval}
                    currency={currency}
                    switching={switching}
                    busy={phase === 'confirming'}
                    onPaid={() => setPhase('confirming')}
                  />
                </section>
              </div>
              <footer className="lim-foot">
                <Room ask={ask} reason={reason} onLeave={onClose} />
                <button type="button" className="btn ghost lim-later" onClick={notNow} data-testid="limit-later">
                  {ask.upload ? t('Not now · the upload waits') : t('Not now')}
                </button>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What the workspace holds against the plan's room, with what was asked for hanging over its end. */
function Meter({ b, needed, fit }: { b: BillingInfo; needed: number; fit: Fit }) {
  const limit = b.limits.bytes ?? 0;
  const used = b.usage.bytes;
  const scale = Math.max(limit, used + needed) * 1.04 || 1;
  const pct = (x: number) => `${Math.min(100, (x / scale) * 100).toFixed(2)}%`;
  const plan = fit.kind === 'addon' && b.seats ? t('{plan} for {n}', { plan: b.planName, n: b.seats }) : b.planName;
  return (
    <div className="lim-cap" aria-hidden="true">
      <div className="lim-cap-top">
        <span style={{ left: `min(${pct(used + needed / 2)}, 94%)` }}>+{size(needed)}</span>
      </div>
      <div className="lim-cap-bar">
        <span className="lim-cap-used" style={{ width: pct(used) }} />
        <span className="lim-cap-inc" style={{ left: pct(used), width: pct(needed) }} />
        <span className="lim-cap-lim" style={{ left: pct(limit) }} />
      </div>
      <div className="lim-cap-lbl">
        <span>
          <b>{t('{size} used', { size: size(used) })}</b>
        </span>
        <span className="lim-cap-lim-l" style={{ left: pct(limit) }}>
          {`${plan} · ${size(limit)}`}
        </span>
      </div>
    </div>
  );
}

/** Yearly · Monthly, with what yearly saves said exactly. */
function IntervalSwitch({ value, onChange, save }: { value: 'month' | 'year'; onChange: (v: 'month' | 'year') => void; save: string | null }) {
  return (
    <fieldset className="seg lim-seg" aria-label={t('Billing interval')}>
      {(['year', 'month'] as const).map((v) => (
        <button key={v} type="button" className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
          {v === 'year' ? t('Yearly') : t('Monthly')}
          {v === 'year' && save && <i>{save}</i>}
        </button>
      ))}
    </fieldset>
  );
}

function FitBlock({
  b,
  fit,
  reason,
  need,
  interval,
  onInterval,
  currency,
  ask,
}: {
  b: BillingInfo;
  fit: Fit;
  reason: Reason;
  need: { members: number };
  interval: 'month' | 'year';
  onInterval: (v: 'month' | 'year') => void;
  currency: string;
  ask: LimitAsk;
}) {
  const rows = changeRows(b, fit, reason, need, ask.feature);
  const then = fit.kind === 'plan' ? fit.offer.name : fit.kind === 'addon' ? t('With +1 TB') : '';
  if (fit.kind === 'contract')
    return (
      <div className="lim-contract">
        <h3>Business</h3>
        <p className="lim-line">{t('More than any plan holds: Business is a contract, made for the room you need.')}</p>
        <a className="btn" href={contractMail()}>
          {t('Talk to us')}
        </a>
      </div>
    );
  const price = fit.kind === 'plan' ? priceOf(fit.offer, interval, need.members, currency) : null;
  return (
    <>
      <div className="lim-plan">
        <div>
          <h3>{fit.kind === 'plan' ? fit.offer.name : t('+1 TB of storage')}</h3>
          <p className="lim-line">{fit.kind === 'plan' ? planLine(fit.offer) : t('On any plan, pooled for the whole workspace')}</p>
        </div>
        {/* a running subscription keeps its interval: a switch changes the plan, not how it is billed */}
        {fit.kind === 'plan' && !b.subscribed && <IntervalSwitch value={interval} onChange={onInterval} save={saving(fit.offer, currency)} />}
      </div>
      {fit.kind === 'plan' && price && (
        <div className="lim-price">
          <p>
            <b>{price.big}</b> <span>{price.per}</span>
          </p>
          <p className="lim-price-sub">{price.sub}</p>
        </div>
      )}
      {fit.kind === 'addon' && (
        <div className="lim-price">
          {/* the price for the subscription's interval: a yearly plan says the year, a monthly one the month */}
          <p>
            <b>{money(fit.year ?? fit.month ?? 0, fit.currency)}</b> <span>{fit.year !== null ? t('a year') : t('a month')}</span>
          </p>
          <p className="lim-price-sub">{t('Billed with {plan}', { plan: b.planName })}</p>
        </div>
      )}
      <div className="lim-chg">
        <table>
          <caption className="sr-only">{t('What changes')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('What changes')}</th>
              <th scope="col">{t('Now')}</th>
              <th scope="col">{then}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className={r.same ? 'same' : ''}>
                <th scope="row">{r.k}</th>
                <td className="a">{r.now}</td>
                <td className="b">
                  {r.same ? (
                    <span className="lim-same">{t('stays')}</span>
                  ) : (
                    <span className="lim-next">
                      <I name="right" size={12} className="lim-to" />
                      {r.next}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lim-keep">
        <KeyGlyph shape="diamond" size={10} className="lim-ok" />
        {keepOf(reason, fit)}
      </p>
      <Other b={b} fit={fit} reason={reason} need={need} currency={currency} />
    </>
  );
}

/** The quiet alternative: the other plan that would also do, in one sentence. */
function Other({ b, fit, reason, need, currency }: { b: BillingInfo; fit: Fit; reason: Reason; need: { members: number }; currency: string }) {
  if (fit.kind === 'addon') {
    const business = b.offers?.find((o) => o.plan === 'business');
    if (!business || b.plan === 'business') return null;
    return (
      <p className="lim-other">
        {t('Growing fast? {plan} has {base} plus {each} per member: {total} for the {n} of you.', {
          plan: business.name,
          base: size(business.bytes.base),
          each: size(business.bytes.perMember),
          total: size(business.bytes.base + business.bytes.perMember * Math.max(business.members.min, need.members)),
          n: need.members,
        })}
      </p>
    );
  }
  if (fit.kind !== 'plan' || reason !== 'storage' || fit.offer.perMember) return null;
  const team = b.offers?.find((o) => o.perMember && o.members.min > 1 && o.plan !== fit.offer.plan);
  const total = team ? periodTotal(team, 'year', team.members.min, currency) : null;
  if (!team || total === null) return null;
  return (
    <p className="lim-other">
      {t('Working with someone? {plan} brings them in, from {amount} a month for {n}.', {
        plan: team.name,
        amount: money(Math.round(total / 12), currency),
        n: team.members.min,
      })}
    </p>
  );
}

function PayColumn({
  ask,
  b,
  workspace,
  fit,
  reason,
  need,
  interval,
  currency,
  switching,
  busy,
  onPaid,
}: {
  ask: LimitAsk;
  b: BillingInfo;
  workspace: string;
  fit: Fit;
  reason: Reason;
  need: { members: number };
  interval: 'month' | 'year';
  currency: string;
  switching: boolean;
  busy: boolean;
  onPaid: () => void;
}) {
  const [preview, setPreview] = useState<BillingPreview | null>(null);
  const plan = fit.kind === 'plan' ? fit.offer.plan : null;
  useEffect(() => {
    if (!switching || !plan) return;
    let live = true;
    void previewSwitch(plan, b.interval ?? interval).then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [switching, plan, b.interval, interval]);
  const what: PayWhat | null = useMemo(
    () =>
      fit.kind === 'addon'
        ? { kind: 'addon', storageTB: (b.addons?.storageTB ?? 0) + fit.tb }
        : fit.kind === 'plan'
          ? switching
            ? { kind: 'switch', plan: fit.offer.plan, interval: b.interval ?? interval }
            : { kind: 'checkout', plan: fit.offer.plan, interval, currency }
          : null,
    [fit, switching, b.interval, b.addons?.storageTB, interval, currency],
  );
  if (!what || fit.kind === 'contract') return null;
  const paysWithCard = what.kind === 'checkout';
  const k = ask.upload
    ? t('Pay and upload')
    : reason === 'members' && ask.name
      ? t('Pay and invite')
      : reason === 'feature'
        ? t('Pay and open Insights')
        : t('Pay');
  const renews = b.renewsAt ? day(b.renewsAt) : null;
  const zero = money(0, currency, true);
  const order =
    fit.kind === 'addon'
      ? [
          {
            k: '+1 TB',
            sub:
              fit.year !== null
                ? t('{amount} a year, prorated to the renewal', { amount: money(fit.year, fit.currency) })
                : t('{amount} a month, prorated to the renewal', { amount: money(fit.month ?? 0, fit.currency) }),
            v: money(fit.year ?? fit.month ?? 0, fit.currency, true),
          },
        ]
      : fit.kind === 'plan'
        ? [
            {
              k: fit.offer.perMember ? `${fit.offer.name} · ${need.members < fit.offer.members.min ? fit.offer.members.min : need.members} ×` : fit.offer.name,
              sub: (b.interval ?? interval) === 'year' ? t('billed yearly') : t('billed monthly'),
              v: money(periodTotal(fit.offer, b.interval ?? interval, need.members, currency) ?? 0, currency, true),
            },
          ]
        : [];
  const prorated = previewMoney(preview);
  const when = preview?.date ? day(preview.date) : renews;
  const note =
    fit.kind === 'addon'
      ? renews
        ? t('The rest of this period goes on the next invoice, on {date}, prorated and plus VAT.', { date: renews })
        : t('The rest of this period goes on the next invoice, prorated and plus VAT.')
      : prorated && when
        ? t('The difference for the rest of this period, {amount} plus VAT, is on the invoice of {date}.', { amount: prorated, date: when })
        : when
          ? t('The difference for the rest of this period goes on the invoice of {date}, plus VAT.', { date: when })
          : t('The difference for the rest of this period goes on the next invoice, plus VAT.');
  return (
    <>
      {/* paid: the eyebrow says the plan is on its way, in the same line (nothing below moves) */}
      {busy ? (
        <p className="lim-k lim-confirming" role="status" data-testid="limit-confirming">
          <Spinner /> {t('Paid · the plan is on its way')}
        </p>
      ) : (
        <p className="lim-k">{paysWithCard ? k : t('Pay with')}</p>
      )}
      <PayInPlace
        what={what}
        billing={b}
        workspace={workspace}
        // the checkout puts its total where {amount} stands ("Pay €171.36 and upload")
        label={payLabel(reason, fit, ask, paysWithCard ? '{amount}' : null, switching)}
        order={order}
        total={{ k: t('Today'), v: zero, note }}
        onPaid={onPaid}
      />
      {paysWithCard && reason === 'members' && ask.name && (
        <p className="lim-payfine">
          {t('{name}’s invite goes out the moment {plan} starts.', { name: ask.name, plan: fit.kind === 'plan' ? fit.offer.name : '' })}
        </p>
      )}
    </>
  );
}

/** The other way out: making room instead (only where room can be made). */
function Room({ ask, reason, onLeave }: { ask: LimitAsk; reason: Reason; onLeave: () => void }) {
  const lib = useLibrary(reason === 'videos').data;
  const show = (lane: string) => {
    momentEvent('made_room', 'limit_sheet', reason);
    storePref(LIBRARY_PREFS, 'lane', lane, LIBRARY_PER_TAB);
    location.hash = '#/';
    onLeave();
  };
  if (reason === 'storage' && ask.room && ask.room.videos > 0)
    return (
      <span className="lim-room" data-testid="limit-room">
        <I name="film" size={14} />
        <span>
          {t('Or make room: {n} final video holds {size}.|Or make room: {n} final videos hold {size}.', { n: ask.room.videos, size: size(ask.room.bytes) })}{' '}
          <button type="button" className="lim-link" onClick={() => show('final')}>
            {t('Show them…')}
          </button>
        </span>
      </span>
    );
  if (reason === 'videos' && (lib?.videos.length ?? 0) > 0)
    return (
      <span className="lim-room" data-testid="limit-room">
        <I name="film" size={14} />
        <span>
          {t('Or make room: mark a finished video final, or archive one.')}{' '}
          <button type="button" className="lim-link" onClick={() => show('approved')}>
            {t('Show the approved ones…')}
          </button>
        </span>
      </span>
    );
  return <span className="grow" />;
}

/** Paid: calm, the plan in place, what waited going on. */
function Done({
  ask,
  b,
  fit,
  reason,
  workspace,
  onClose,
}: {
  ask: LimitAsk;
  b: BillingInfo;
  fit: Fit;
  reason: Reason;
  workspace: string;
  onClose: () => void;
}) {
  const title =
    fit.kind === 'addon'
      ? t('{workspace} has {size} now', { workspace, size: size(b.limits.bytes ?? 0) })
      : t('{workspace} is on {plan}', { workspace, plan: fit.kind === 'plan' ? fit.offer.name : b.planName });
  const line =
    reason === 'storage' && ask.name
      ? t('{name} is uploading.', { name: ask.name })
      : reason === 'members' && ask.name
        ? t('{name}’s invite is on its way.', { name: ask.name })
        : reason === 'feature'
          ? t('Insights is open, with everything since your first note.')
          : null;
  const receipt =
    fit.kind === 'addon'
      ? t('Settings → Billing shows the extra storage; remove it there any time.')
      : b.subscribed
        ? t('The difference is on the next invoice; every invoice is in Settings → Billing.')
        : t('The receipt goes to your billing email; every invoice is in Settings → Billing.');
  return (
    <div className="lim-done" data-testid="limit-done">
      <KeyGlyph shape="diamond" size={22} className="lim-ok" pop />
      <Dialog.Title asChild>
        <h2 tabIndex={-1}>{title}</h2>
      </Dialog.Title>
      {line && <p>{line}</p>}
      <button type="button" className="btn" onClick={onClose} data-testid="limit-done-close">
        {t('Done')}
      </button>
      <p className="lim-fine">{receipt}</p>
    </div>
  );
}
