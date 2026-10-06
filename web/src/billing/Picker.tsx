// Settings → Billing's plans: a picker, not a row of buttons. The plans are tiles selected like radio buttons (no
// button inside a tile; a plan the workspace can't fit says why and can't be selected), their rows lined up across
// the three by a subgrid (name, line, price, billing, facts, note) so prices and lists sit level in any language; tags
// only inform (Your trial, Current, Your pick). One bar under the tiles, sticky while the plans are in view, says what
// the selection costs this workspace and holds the one orange action: on to the checkout step for a new plan, or a
// switch (with what the next invoice will be) for a running one. The member stepper tries other team sizes and never
// changes the bill. Free and the rest in one row and one line below. Consumers may buy (A13 CLOUD-2): where the provider
// names the VAT a consumer pays (BillingInfo.vat), every price here is shown with it (PAngV), and the foot says that the
// checkout works the tax out for the billing address.
import { useState } from 'react';
import type { BillingInfo, BillingOffer } from '../../../lib/types.ts';
import { currentLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { toast, toastError } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { useConfirm } from '../ui/primitives.tsx';
import { type PlanChoice, useChangePlan, usePlanPreview } from './api.ts';
import { checkoutHash } from './Checkout.tsx';
import { dayOf, daysUntil, gross, money, monthly, planLine, saving, size, unitsFor, vatRate } from './words.ts';

/** "Business as a contract, on invoice: talk to us." — TODO: the address is the maintainer's to give (a placeholder). */
export const TALK_TO_US = 'mailto:';

/** What the address brought: a plan picked on the website, with its interval and currency when it said them. */
export interface Picked {
  plan: string;
  interval?: 'month' | 'year';
  currency?: string;
}

const fitsNow = (o: BillingOffer, n: number) => o.fits && (o.members.max === null || n <= o.members.max);

/** What was chosen last on its way to the checkout step: back from the step, the plans show it selected again. */
let chosenLast: Picked | null = null;
export const lastChoice = () => chosenLast;

export function Picker({
  b,
  ws,
  picked,
  initial,
  onClose,
}: {
  b: BillingInfo & { offers: BillingOffer[] };
  ws: string;
  /** Picked on the website: selected, and said once. */
  picked: Picked | null;
  /** Chosen here before (back from the checkout step): selected, without a word. */
  initial?: Picked | null;
  onClose: () => void;
}) {
  const currencies = b.currencies?.length ? b.currencies : [b.currency ?? 'eur'];
  const from = picked ?? initial ?? null;
  const [interval, setPeriod] = useState<'month' | 'year'>(from?.interval ?? b.interval ?? 'year');
  const [currency, setCurrency] = useState(
    from?.currency && currencies.includes(from.currency) ? from.currency : b.currency && currencies.includes(b.currency) ? b.currency : currencies[0],
  );
  const [n, setN] = useState(Math.max(1, b.usage.members));
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = useChangePlan();
  const preview = usePlanPreview();
  const [ask, confirmation] = useConfirm();
  const subscribed = !!b.subscribed;
  const canPay = b.available !== false && !!b.payments;
  const offers = b.offers;
  const fitting = offers.filter((o) => fitsNow(o, n));
  // the selection: what was clicked, else the website's pick, the plan in force, Team, the first that fits
  const sel =
    [chosen, from?.plan, b.plan, 'team', ...fitting.map((o) => o.plan)].map((p) => fitting.find((o) => o.plan === p)).find((o): o is BillingOffer => !!o) ??
    null;
  const isCurrent = !!sel && subscribed && sel.plan === b.plan && interval === b.interval;

  const go = async () => {
    if (!sel) return;
    const c: PlanChoice = { plan: sel.plan, interval, currency };
    if (!subscribed) {
      chosenLast = { plan: sel.plan, interval, currency };
      location.hash = checkoutHash({ plan: sel.plan, interval, currency });
      return;
    }
    setBusy(true);
    try {
      const p = await preview.mutateAsync(c);
      const ok = await ask({
        title: t('Switch to {plan}?', { plan: sel.name }),
        body: p.date
          ? t('It takes effect at once. The next invoice, on {date}, will be {amount}: the difference for the rest of this period is on it.', {
              date: dayOf(p.date, { year: true }),
              amount: money(p.amount, p.currency),
            })
          : t('It takes effect at once; the difference for the rest of this period is on the next invoice.'),
        action: t('Switch to {plan}', { plan: sel.name }),
      });
      if (!ok) return;
      await change.mutateAsync(c);
      toast(t('{plan} it is: the change shows here in a moment.', { plan: sel.name }), 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const left = b.trialEndsAt ? daysUntil(b.trialEndsAt) : 0;
  const units = sel ? unitsFor(sel, n) : 1;
  const unit = sel ? (monthly(sel, interval, currency) ?? 0) : 0;
  // what a consumer pays: with VAT where the provider names it (the tax on the whole, as the invoice reckons it)
  const year = gross(sel ? (sel.prices[currency]?.year ?? 0) * units : 0, b);
  const month = gross(Math.round(unit * units), b);
  const withVat = !!b.vat?.rate;
  const plusVat = !withVat && b.tax !== 'included';
  const who = !sel
    ? ''
    : sel.perMember
      ? t('{plan} for {n} member|{plan} for {n} members', { plan: sel.name, n })
      : t('{plan} for one person', { plan: sel.name });
  const cost =
    interval === 'year'
      ? withVat
        ? t('{month} a month · {year} billed yearly, incl. VAT', { month: money(month, currency), year: money(year, currency) })
        : plusVat
          ? t('{month} a month · {year} billed yearly, plus VAT', { month: money(month, currency), year: money(year, currency) })
          : t('{month} a month · {year} billed yearly', { month: money(month, currency), year: money(year, currency) })
      : withVat
        ? t('{month} a month, billed monthly, incl. VAT', { month: money(month, currency) })
        : plusVat
          ? t('{month} a month, billed monthly, plus VAT', { month: money(month, currency) })
          : t('{month} a month, billed monthly', { month: money(month, currency) });
  const when = !sel
    ? ''
    : subscribed
      ? isCurrent
        ? t('This is your plan.')
        : t('Takes effect at once; the difference for the rest of this period goes on the next invoice.')
      : !canPay
        ? t('Paying isn’t open on this server yet: the plans show what they will cost.')
        : b.state === 'trial'
          ? sel.plan !== 'business' && left >= 3 && b.trialEndsAt
            ? t('Nothing is charged before {date}: the trial runs on.', { date: dayOf(b.trialEndsAt) })
            : t('{plan} is billed from today: the trial ends when it starts.', { plan: sel.name })
          : t('Billed from today, once you confirm.');
  const pickedOffer = picked ? offers.find((o) => o.plan === picked.plan) : null;

  return (
    <section className="bill-picker" id="billing-picker" aria-label={t('Plans')} data-testid="billing-plans">
      <header className="bill-pk-head">
        <h2 className="section-title">{subscribed ? t('Change plan') : t('Choose a plan')}</h2>
        <div className="bill-pk-ctl">
          <fieldset className="seg bill-seg">
            <legend className="sr-only">{t('Billing interval')}</legend>
            <button type="button" className={interval === 'year' ? 'on' : ''} aria-pressed={interval === 'year'} onClick={() => setPeriod('year')}>
              {t('Yearly')}
              {sel && <i className="bill-save">{saving(sel, currency)}</i>}
            </button>
            <button type="button" className={interval === 'month' ? 'on' : ''} aria-pressed={interval === 'month'} onClick={() => setPeriod('month')}>
              {t('Monthly')}
            </button>
          </fieldset>
          {currencies.length > 1 && (
            <fieldset className="seg bill-seg">
              <legend className="sr-only">{t('Currency')}</legend>
              {currencies.map((c) => (
                <button key={c} type="button" className={currency === c ? 'on' : ''} aria-pressed={currency === c} onClick={() => setCurrency(c)}>
                  {c.toUpperCase()}
                </button>
              ))}
            </fieldset>
          )}
          <div className="bill-stepper" title={t('{ws} has {n} today', { ws, n: b.usage.members })} data-testid="billing-stepper">
            <button type="button" className="bill-step" aria-label={t('One member fewer')} disabled={n <= 1} onClick={() => setN(n - 1)}>
              <I name="minus" size={13} />
            </button>
            <b aria-live="polite">{n}</b>
            <button type="button" className="bill-step" aria-label={t('One member more')} onClick={() => setN(n + 1)}>
              <I name="plus" size={13} />
            </button>
            <span>{t('member|members', { n })}</span>
          </div>
        </div>
      </header>
      {pickedOffer && (
        <p className="bill-pick-note" data-testid="billing-picked">
          <I name="globe" size={14} />
          <span>
            <T
              k="You picked <0>{plan}</0> on lampo.video, so it’s selected. Nothing is charged until you confirm."
              values={{ plan: pickedOffer.name }}
              tags={[(c) => <b>{c}</b>]}
            />
          </span>
        </p>
      )}
      <div className="bill-tiles">
        {offers.map((o, i) => (
          <Tile
            key={o.plan}
            o={o}
            prev={i > 0 ? offers[i - 1] : null}
            b={b}
            ws={ws}
            n={n}
            interval={interval}
            currency={currency}
            on={sel?.plan === o.plan}
            fits={fitsNow(o, n)}
            picked={picked?.plan === o.plan}
            onSelect={() => setChosen(o.plan)}
          />
        ))}
      </div>
      <div className="bill-pick-bar" data-testid="billing-pick-bar">
        <div className="bill-pk-sum">
          <b>{who}</b>
          <span>{cost}</span>
          <small>{when}</small>
        </div>
        {isCurrent ? (
          <button type="button" className="btn lg bill-raised" onClick={onClose}>
            {t('Close')}
          </button>
        ) : (
          <button type="button" className="btn primary lg" onClick={go} disabled={!sel || busy || (!subscribed && !canPay)} data-testid="billing-go">
            {busy && <Spinner />}
            {!sel
              ? t('Choose a plan')
              : !subscribed
                ? t('Continue with {plan}', { plan: sel.name })
                : sel.plan === b.plan
                  ? interval === 'year'
                    ? t('Switch to yearly')
                    : t('Switch to monthly')
                  : t('Switch to {plan}', { plan: sel.name })}
            <I name="right" size={15} />
          </button>
        )}
      </div>
      <div className="bill-pk-foot">
        <div className="bill-free-row">
          <b>Free</b>
          <span>{t('1 member · 10 GB of storage · 3 videos under review at a time · A small Lampo badge on review links')}</span>
        </div>
        <p className="bill-fine">
          {t(
            'Agents and people on review links are free on every plan. More storage on any plan: 1 TB for {amount} a month. Business as a contract, on invoice:',
            {
              amount: money(gross(1000, b), currency),
            },
          )}{' '}
          <a className="bill-u" href={TALK_TO_US}>
            {t('talk to us')}
          </a>
          .
        </p>
        {withVat && b.vat && (
          <p className="bill-fine" data-testid="billing-vat">
            {/* a business abroad pays no VAT only where the provider offers reverse charge (its seller has a VAT ID) */}
            {b.reverseCharge
              ? t('Prices include {rate} VAT. At the checkout it follows your billing address: a business with a VAT ID from another EU country pays none.', {
                  rate: vatRate(b.vat.rate),
                })
              : t('Prices include {rate} VAT. At the checkout it follows your billing address.', { rate: vatRate(b.vat.rate) })}
          </p>
        )}
      </div>
      {confirmation}
    </section>
  );
}

function Tile({
  o,
  prev,
  b,
  ws,
  n,
  interval,
  currency,
  on,
  fits,
  picked,
  onSelect,
}: {
  o: BillingOffer;
  prev: BillingOffer | null;
  b: BillingInfo;
  ws: string;
  n: number;
  interval: 'month' | 'year';
  currency: string;
  on: boolean;
  fits: boolean;
  picked: boolean;
  onSelect: () => void;
}) {
  // with VAT where the provider names it (PAngV): what a consumer pays
  const perMonth = monthly(o, interval, currency);
  const unit = perMonth === null ? null : gross(perMonth, b);
  const year = gross(o.prices[currency]?.year ?? 0, b);
  const facts = [
    o.members.max === 1
      ? t('{n} member|{n} members', { n: 1 })
      : o.members.max === null
        ? t('Members: no limit')
        : t('{min} to {max} members', { min: o.members.min, max: o.members.max }),
    o.bytes.perMember
      ? t('{base} plus {each} per member, pooled', { base: size(o.bytes.base), each: size(o.bytes.perMember) })
      : t('{size} of storage', { size: size(o.bytes.base) }),
    ...(!prev || prev.activeVideos !== o.activeVideos
      ? [
          o.activeVideos === null
            ? t('No limit on videos under review')
            : t('{n} video under review at a time|{n} videos under review at a time', { n: o.activeVideos }),
        ]
      : []),
    ...(o.highlights?.[currentLang()] ?? o.highlights?.en ?? []),
  ];
  const note = !o.fits
    ? o.members.max === 1
      ? t('Fits one member; {ws} has {n}.', { ws, n: b.usage.members })
      : t('Fits up to {max} members; {ws} has {n}.', { max: o.members.max ?? 0, ws, n: b.usage.members })
    : !fits
      ? t('Fits up to {max} members.', { max: o.members.max ?? 0 })
      : o.plan === 'business'
        ? t('Also as a contract, on invoice.')
        : o.perMember && n < o.members.min
          ? t('Billed for at least {n} members.', { n: o.members.min })
          : '';
  return (
    <label className={`bill-tile ${on ? 'on' : ''} ${fits ? '' : 'off'}`} data-plan={o.plan} data-testid={`billing-offer-${o.plan}`}>
      <input type="radio" name="bill-plan" className="sr-only" value={o.plan} checked={on} disabled={!fits} onChange={() => fits && onSelect()} />
      <span className="bill-t-h">
        <span className="bill-radio" aria-hidden="true" />
        <b>{o.name}</b>
        {b.state === 'trial' && b.plan === o.plan && <span className="bill-tag">{t('Your trial')}</span>}
        {b.subscribed && b.plan === o.plan && <span className="bill-tag">{t('Current')}</span>}
        {picked && <span className="bill-tag pick">{t('Your pick')}</span>}
      </span>
      <span className="bill-t-line">{planLine(o.plan)}</span>
      <span className="bill-t-price">
        <b>{unit === null ? '—' : money(unit, currency)}</b>
        <span>
          {o.perMember ? (
            <>
              {t('per member')}
              <br />
              {t('a month')}
            </>
          ) : (
            t('a month')
          )}
        </span>
      </span>
      <span className="bill-t-billed">
        {interval === 'year'
          ? o.perMember
            ? t('{amount} per member billed yearly · {saving}', { amount: money(year, currency), saving: saving(o, currency) })
            : t('{amount} billed yearly · {saving}', { amount: money(year, currency), saving: saving(o, currency) })
          : t('Billed monthly · {amount} if yearly', { amount: money(Math.round(year / 12), currency) })}
      </span>
      <span className="bill-t-facts">
        {prev && <span className="bill-t-plus">{t('Everything in {plan}, plus', { plan: prev.name })}</span>}
        {facts.map((f) => (
          <span key={f} className="bill-t-li">
            <KeyGlyph shape="outline" size={8} />
            <span>{f}</span>
          </span>
        ))}
      </span>
      <span className="bill-t-note">{note}</span>
    </label>
  );
}
