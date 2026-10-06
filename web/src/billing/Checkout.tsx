// The checkout as a step of its own (conversion SPEC §5): Settings → Billing mounts it at #/settings/billing/checkout
// (`page`: a crumb, the form beside the sticky order), a limit sheet (§3) inside the sheet (`sheet`: one column, card
// and country). It opens a Checkout Session for the choice (POST /api/billing/checkout) and pays it on the page with
// Stripe's own fields — the billing address, the business's name and VAT ID, the card — in the app's look
// (billing/stripe.ts). The order beside them is the session's own numbers: the lines, the tax from the address, a
// promotion code, the total, and what is due today. Until Stripe's fields arrive their room is held, field by field, so
// nothing moves when they do. Card details go to Stripe and never reach this app.
// Consumers may buy (A13 CLOUD-2): "I'm purchasing as a business" is optional and off (the business's name and VAT ID
// only when ticked); a consumer asks for the plan to start at once (§ 356(4) / § 357a BGB) in a box
// above the order button, the terms line with the operator's pages sits right above it, and the button says the order
// costs money: "Buy now" / "Zahlungspflichtig bestellen" (§ 312j(3) BGB). What was agreed is recorded with the provider
// right before the order goes to Stripe.
// Reverse charge only where the provider offers it (BillingInfo.reverseCharge: its seller has a VAT ID of its own): then
// the business's name and VAT ID are Stripe's Tax ID Element, and a VAT ID abroad makes the tax "Reverse charge".
// Without it the page asks them in two fields of its own, the VAT ID goes to the provider for the invoice only (with the
// consent), and every buyer pays the VAT the address brings: nothing on the page says reverse charge.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { BillingInfo, BillingOffer } from '../../../lib/types.ts';
import { keys, useBilling, useInfo } from '../api/queries.ts';
import { locale, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { errorMessage } from '../lib/toast.ts';
import { methodLabel, vatProblem } from '../settings/BillingAccount.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Panel } from '../ui/system.tsx';
import { useBillingAccount, useCheckout, useOrderConsent, useSaveDetails } from './api.ts';
import { PaymentsConsent, usePaymentsChoice } from './PaymentsConsent.tsx';
import { Ruler } from './parts.tsx';
import { ADDRESS, CARD, Element, TAX_ID } from './Slots.tsx';
import {
  appearance,
  type CheckoutActions,
  type CheckoutSdk,
  type CheckoutSession,
  declined,
  elementsOptions,
  onThemeChange,
  type StripeElement,
  stripeFor,
} from './stripe.ts';
import { day, dayOf, money } from './words.ts';
import '../styles/checkout.css';

export interface CheckoutChoice {
  plan: string;
  interval: 'month' | 'year';
  currency: string;
}

export interface CheckoutStepProps {
  /** The workspace's billing answer (the provider's key, the offers, the trial, the usage). */
  b: BillingInfo;
  choice: CheckoutChoice;
  /** The workspace's name: the title is what is bought ("Team for Northwind Studio"). */
  workspace: string;
  /** `page`: the crumb, the form beside the sticky order (Settings → Billing). `sheet`: one column inside a sheet. */
  layout?: 'page' | 'sheet';
  /** Back to where the person chose (the crumb, Change). */
  onBack: () => void;
  /**
   * Paid (or, in a trial, the card saved for its end): the provider's events follow. A `page` step then shows its own
   * done panel (it polls the plan until it arrives, and leaves through its own links); a `sheet` shows the caller's.
   */
  onPaid: (choice: CheckoutChoice) => void;
}

/** Reads a checkout choice from the address (`#/settings/billing/checkout?plan=team&interval=year&currency=eur`). */
export function choiceFromHash(hash: string, fallbackCurrency = 'eur'): CheckoutChoice | null {
  const m = /^#\/settings\/billing\/checkout(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? '');
  const plan = q.get('plan') ?? '';
  if (!/^(solo|team|business)$/.test(plan)) return null;
  const interval = q.get('interval') === 'month' ? 'month' : 'year';
  const currency = /^(eur|usd)$/.test(q.get('currency') ?? '') ? (q.get('currency') as string) : fallbackCurrency;
  return { plan, interval, currency };
}

/** The address of a checkout step for a choice. */
export const checkoutHash = (c: CheckoutChoice) => `#/settings/billing/checkout?plan=${c.plan}&interval=${c.interval}&currency=${c.currency}`;

// Paying in the trial keeps its days for Solo and Team when at least 49 hours are left (the billing module's rule,
// cloud routes.ts MIN_TRIAL_CARRY_MS). Only a guess for the moment before the session arrives, so that the "due today"
// box has its room from the start; the session's own total decides.
const CARRIES = new Set(['solo', 'team']);
const CARRY_MS = 49 * 3600 * 1000;
const keepsTrial = (b: BillingInfo, plan: string): boolean =>
  b.state === 'trial' && !!b.trialEndsAt && CARRIES.has(plan) && Date.parse(b.trialEndsAt) - Date.now() >= CARRY_MS;

/** An amount on the order, always with its cents (as Stripe's own amounts are): "€480.00". */
const cents = (minor: number, currency: string) =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2 }).format(minor / 100);

/** "19%", "19 %": a tax rate in the page's language. */
const percent = (p: number) => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 2 }).format(p / 100);

const DAY = 86_400_000;
/** Where the trial stands: today's day (1-based) of its length, from when it began and ends. */
const rulerOf = (b: BillingInfo): { day: number; of: number } | null => {
  if (!b.trialStartsAt || !b.trialEndsAt) return null;
  const start = Date.parse(b.trialStartsAt);
  const of = Math.max(1, Math.round((Date.parse(b.trialEndsAt) - start) / DAY));
  return { day: Math.min(of, Math.max(1, Math.ceil((Date.now() - start) / DAY))), of };
};

/** Members billed: per-member plans bill everyone, at least the plan's minimum (Team: 2); others bill once. */
const unitsOf = (o: BillingOffer, b: BillingInfo) => (o.perMember ? Math.max(o.members.min, b.usage.members) : 1);

/**
 * Stripe's checkout for a session: its elements, its actions and its state as it changes — once the person allowed the
 * payment form in the cookie settings (`allowed`); its address search only with Google's suggestions allowed too.
 */
function useStripeCheckout(key: string | undefined, secret: string | null, form: 'full' | 'card', allowed: { stripe: boolean; address: boolean } | null) {
  const [sdk, setSdk] = useState<CheckoutSdk | null>(null);
  const [els, setEls] = useState<{ address: StripeElement | null; payment: StripeElement } | null>(null);
  const [actions, setActions] = useState<CheckoutActions | null>(null);
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [ready, setReady] = useState({ address: false, payment: false });
  const [error, setError] = useState('');
  const stripeOk = !!allowed?.stripe;
  const search = !!allowed?.address;
  useEffect(() => {
    if (!key || !secret || !stripeOk) return;
    let live = true;
    let offTheme = () => {};
    const made: StripeElement[] = [];
    (async () => {
      const stripe = await stripeFor(key);
      if (!live) return;
      const init = stripe.initCheckoutElementsSdk ?? stripe.initCheckout;
      if (!init) throw new Error(t('The payment form could not load. Reload the page and try again.'));
      const checkout = init.call(stripe, { clientSecret: secret, elementsOptions: elementsOptions() });
      checkout.on('change', (s) => live && setSession(s));
      offTheme = onThemeChange(() => checkout.changeAppearance?.(appearance()));
      // the address is searched (Stripe's own autocomplete, its suggestions powered by Google) where the cookie settings
      // allow Google's suggestions: one pick fills street, postal code and city, "Enter address manually" stays;
      // without them it is typed. A sheet asks only the card and the country, inside the Payment Element
      const address = form === 'full' ? checkout.createBillingAddressElement({ autocomplete: { mode: search ? 'automatic' : 'disabled' } }) : null;
      const payment = checkout.createPaymentElement({
        layout: 'tabs',
        wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
        fields: { billingDetails: { address: form === 'full' ? 'never' : 'auto' } },
        terms: { card: 'auto' },
      });
      address?.on('ready', () => live && setReady((r) => ({ ...r, address: true })));
      payment.on('ready', () => live && setReady((r) => ({ ...r, payment: true })));
      made.push(payment, ...(address ? [address] : []));
      setSdk(checkout);
      setEls({ address, payment });
      const loaded = await checkout.loadActions();
      if (!live) return;
      if (loaded.type === 'error') return setError(loaded.error.message ?? t('The payment form could not load. Reload the page and try again.'));
      setActions(loaded.actions);
      setSession(loaded.actions.getSession());
    })().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      offTheme();
      for (const el of made) el.destroy();
    };
  }, [key, secret, form, stripeOk, search]);
  return { sdk, els, actions, session, ready, error };
}

/** The checkout step: one Checkout Session for the choice, paid on the page. "Try again" starts it afresh. */
export function CheckoutStep(props: CheckoutStepProps) {
  const [attempt, setAttempt] = useState(0);
  return <Step key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Step({ b, choice, workspace, layout = 'page', onBack, onPaid, onRetry }: CheckoutStepProps & { onRetry: () => void }) {
  const offer = b.offers?.find((o) => o.plan === choice.plan);
  const form = layout === 'page' ? 'full' : 'card';
  const start = useCheckout();
  const [secret, setSecret] = useState<string | null>(null);
  const [startError, setStartError] = useState('');
  const qc = useQueryClient();
  const save = useSaveDetails();
  const consent = useOrderConsent();
  const info = useInfo();
  const offered = !!offer;
  const key = b.payments?.key;
  // the payment form's third parties wait for the person's say (the cookie settings, asked once: A13 CLOUD-1)
  const allowed = usePaymentsChoice(!!key);
  const refused = !!allowed && !allowed.stripe;
  const { sdk, els, actions, session, ready, error: loadError } = useStripeCheckout(key, secret, form, allowed);
  // a person by default; a business ticks the box (its name and VAT ID for the invoice; abroad, reverse charge where the
  // provider offers it)
  const [business, setBusiness] = useState(false);
  const reverse = !!b.reverseCharge;
  // without reverse charge: the business's name and VAT ID in fields of the page's own (Stripe's Tax ID Element would
  // put the VAT ID where Stripe Tax reads it)
  const [bizName, setBizName] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  // a consumer's express request to start at once, and whether the order button was pressed without it
  const [asked, setAsked] = useState(false);
  const [startMiss, setStartMiss] = useState(false);
  const startBox = useRef<HTMLInputElement>(null);
  const [taxEl, setTaxEl] = useState<StripeElement | null>(null);
  const [taxReady, setTaxReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [promoError, setPromoError] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  const { mutateAsync } = start;
  // one session per visit (a second one for the same choice within the minute is the same session: the module's key)
  // keyed by what the session is for, not by the billing answer's objects: paying refreshes that answer, and must not
  // start a second session
  useEffect(() => {
    if (!offered || !key) return;
    let live = true;
    setStartError('');
    mutateAsync({ plan: choice.plan, interval: choice.interval, currency: choice.currency, form })
      .then((r) => live && setSecret(r.clientSecret))
      .catch((e: Error) => live && setStartError(e.message));
    return () => {
      live = false;
    };
  }, [offered, key, choice.plan, choice.interval, choice.currency, form, mutateAsync]);

  // the title is what's bought: focus lands there on arrival, so a screen reader starts at the step
  useEffect(() => {
    if (layout === 'page') title.current?.focus({ preventScroll: true });
  }, [layout]);

  // the business's name and VAT ID: Stripe's Tax ID Element, while "purchasing as a business" is ticked (reverse charge)
  useEffect(() => {
    if (!reverse || !sdk?.createTaxIdElement || !business || form !== 'full') return;
    const el = sdk.createTaxIdElement({ visibility: 'always' });
    el.on('ready', () => setTaxReady(true));
    setTaxEl(el);
    return () => {
      el.destroy();
      setTaxEl(null);
      setTaxReady(false);
    };
  }, [sdk, business, form, reverse]);
  const untick = async () => {
    setBusiness(false);
    setBizName('');
    setVat('');
    setVatTouched(false);
    // what the element held goes too: no business name or VAT ID on an invoice for a person
    await Promise.resolve()
      .then(() => actions?.updateTaxIdInfo?.(null))
      .catch(() => {});
    await Promise.resolve()
      .then(() => actions?.updateBusinessName?.(null))
      .catch(() => {});
  };

  if (!offer || !b.payments)
    return (
      <div className={`co ${layout}`} data-testid="billing-checkout">
        <p className="bill-error" role="alert">
          {!b.payments ? t('Paying isn’t available here right now.') : t('This plan isn’t offered here.')}
        </p>
        <button type="button" className="btn lg" onClick={onBack}>
          {t('Back to the plans')}
        </button>
      </div>
    );

  if (paid && layout === 'page') return <Done b={b} offer={offer} choice={choice} workspace={workspace} paid={paid} />;

  const units = session?.lineItems?.[0]?.quantity ?? unitsOf(offer, b);
  const unit = offer.prices[choice.currency]?.[choice.interval] ?? 0;
  const yearly = choice.interval === 'year';
  const inTrial = b.state === 'trial' && !!b.trialEndsAt;
  const dueToday = session?.total?.total?.minorUnitsAmount;
  // the trial's days carry over when nothing is due today; before the session says, the module's rule guesses
  const trial = inTrial && (dueToday === undefined ? keepsTrial(b, choice.plan) : dueToday === 0);
  const trialEnd = b.trialEndsAt ? day(b.trialEndsAt) : '';
  const total = trial ? session?.recurring?.dueNext?.total?.amount : session?.total?.total?.amount;
  const totalNow = total ?? (session ? undefined : cents(unit * units, choice.currency));
  const canPay = !!actions && ready.payment && (form === 'card' || ready.address) && !busy && session?.canConfirm !== false;
  const loading = !actions || !ready.payment || (form === 'full' && !ready.address);
  const applied = session?.discountAmounts?.find((d) => d.promotionCode);
  // in a trial nothing is charged today: the code, the tax and the total are those of the first payment
  const basis = trial ? session?.recurring?.dueNext : session?.total;
  const discount = basis?.discount;
  const taxPending = !session || session.tax?.status === 'requires_billing_address';
  const rates = session?.taxAmounts ?? [];
  const taxRows = (
    trial || !rates.length
      ? [
          {
            displayName: rates.length === 1 ? rates[0].displayName : t('Tax'),
            percentage: rates.length === 1 ? rates[0].percentage : undefined,
            ...basis?.taxExclusive,
          },
        ]
      : rates
  ).map((x) => ({ ...x, label: x.percentage ? `${x.displayName} ${percent(x.percentage)}` : (x.displayName ?? t('Tax')) }));

  // the VAT ID as typed, said wrong at its field before anything is sent (the provider checks it again)
  const vatId = vat.replace(/\s+/g, '').toUpperCase();
  const vatCountry = session?.billingAddress?.address?.country ?? '';
  const vatWrong = !reverse && business && vatId ? vatProblem(vatId, vatCountry) : null;

  const pay = async () => {
    if (!actions) return;
    // a consumer's order waits for the express start: the box is shown where it is (a phone's bar is far from it)
    if (!business && !asked) {
      setStartMiss(true);
      startBox.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      startBox.current?.focus({ preventScroll: true });
      return;
    }
    if (vatWrong) {
      setVatTouched(true);
      const field = document.getElementById('co-vat');
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      field?.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    setError('');
    // the business's name on the invoice, through Stripe (its Tax ID Element takes it where there is reverse charge)
    if (business && !reverse && bizName.trim()) {
      const named = await Promise.resolve()
        .then(() => actions.updateBusinessName?.(bizName.trim()))
        .catch(() => undefined);
      if (named?.type === 'error') {
        setBusy(false);
        return setError(named.error.message ?? t('The payment form could not load. Reload the page and try again.'));
      }
    }
    // what was agreed, kept with the provider before the order goes to Stripe (a business's VAT ID for the invoice too)
    try {
      await consent.mutateAsync({
        buyer: business ? 'business' : 'consumer',
        start: !business && asked,
        ...(business && !reverse && vatId ? { vatId } : {}),
      });
    } catch (e) {
      setBusy(false);
      return setError(errorMessage(e));
    }
    // Stripe answers a declined card with an error result; a lost connection throws: both leave the form as it was
    const r = await actions.confirm({ redirect: 'if_required' }).catch(() => ({ type: 'error' as const, error: {} }));
    if (r.type === 'error') {
      setBusy(false);
      return setError(declined(r.error));
    }
    const s = r.session ?? actions.getSession();
    const a = s.billingAddress;
    // a new address for receipts: Stripe keeps the customer's, so it goes on the account once the address is there
    if (email && a?.name && a.address?.line1 && a.address.postal_code && a.address.city && a.address.country)
      await save
        .mutateAsync({
          name: a.name,
          email,
          address: {
            line1: a.address.line1,
            ...(a.address.line2 ? { line2: a.address.line2 } : {}),
            postalCode: a.address.postal_code,
            city: a.address.city,
            ...(a.address.state ? { state: a.address.state } : {}),
            country: a.address.country,
          },
        })
        .catch(() => {});
    setPaid({
      trial,
      ruler: trial ? rulerOf(b) : null,
      first: (trial ? s.recurring?.dueNext?.total?.amount : s.total?.total?.amount) ?? totalNow ?? '',
      on: trial ? trialEnd : '',
      email: email ?? s.email ?? null,
    });
    qc.invalidateQueries({ queryKey: keys.billing });
    onPaid(choice);
  };

  const apply = async (code: string) => {
    if (!actions || !code.trim()) return;
    setPromoError('');
    const r = await actions.applyPromotionCode(code.trim());
    if (r.type === 'error') setPromoError(r.error.message ?? t('That code doesn’t work here.'));
    else setPromo(null);
  };
  const removeCode = async () => {
    if (!actions) return;
    setPromoError('');
    const r = await actions.removePromotionCode();
    if (r.type === 'error') setPromoError(r.error.message ?? t('That code doesn’t work here.'));
  };

  // § 312j(3) BGB: the button says the order costs money, in a trial too (the first payment comes at its end)
  const label = loading && !refused ? t('Loading the payment form') : t('Buy now');
  // the operator's pages, linked where they are set (lib/legal.ts); plain words where they aren't
  const page = (url: string | null | undefined) => (c: ReactNode) =>
    url ? (
      <a href={url} target="_blank" rel="noreferrer">
        {c}
      </a>
    ) : (
      c
    );
  const payButton = (where: 'order' | 'bar') => (
    <button
      type="button"
      className={`btn primary lg ${where === 'order' ? 'wide' : ''}`}
      onClick={pay}
      disabled={!canPay}
      data-testid={where === 'order' ? 'billing-pay' : 'billing-pay-bar'}
    >
      {((loading && !refused) || busy) && <Spinner />}
      {label}
    </button>
  );

  const startFailed = startError || loadError;
  const order = (
    <Panel pad="lg" as="div" className="co-sum" aria-label={t('Your order')} data-testid="billing-summary">
      {layout === 'page' && (
        <div className="co-plan">
          <span className="co-plan-t">
            <b>{offer.name}</b>
            <span>
              {offer.perMember
                ? yearly
                  ? t('{n} member · billed yearly|{n} members · billed yearly', { n: units })
                  : t('{n} member · billed monthly|{n} members · billed monthly', { n: units })
                : yearly
                  ? t('Billed yearly')
                  : t('Billed monthly')}
            </span>
          </span>
          <button type="button" className="btn-link co-lk" onClick={onBack} disabled={busy}>
            {t('Change')}
          </button>
        </div>
      )}
      <dl className="co-lines">
        <div>
          <dt>
            {offer.perMember ? `${offer.name} · ${units} × ${session?.lineItems?.[0]?.unitAmount?.amount ?? money(unit, choice.currency)}` : offer.name}
            <small>
              {offer.perMember
                ? yearly
                  ? t('per member, billed yearly')
                  : t('per member, billed monthly')
                : yearly
                  ? t('billed yearly')
                  : t('billed monthly')}
            </small>
          </dt>
          <dd>{(trial ? session?.recurring?.dueNext?.subtotal?.amount : session?.lineItems?.[0]?.total?.amount) ?? cents(unit * units, choice.currency)}</dd>
        </div>
        {discount?.minorUnitsAmount ? (
          <div className="disc">
            <dt>
              {applied?.promotionCode ?? t('Discount')}
              {applied?.displayName && applied.displayName !== applied.promotionCode && <small>{applied.displayName}</small>}
            </dt>
            <dd>−{discount.amount}</dd>
          </div>
        ) : null}
        {taxPending ? (
          <div className="muted" data-testid="billing-tax">
            <dt>
              {t('VAT')}
              <small>{t('From the billing address')}</small>
            </dt>
            <dd>—</dd>
          </div>
        ) : (
          taxRows.map((x) => (
            <div className="muted" key={x.label} data-testid="billing-tax">
              <dt>
                {x.label}
                {/* always a second line, so the row keeps its height when the tax arrives */}
                <small>
                  {x.minorUnitsAmount
                    ? t('From the billing address')
                    : reverse && business && session?.taxIdInfo
                      ? t('Reverse charge')
                      : t('None for this address')}
                </small>
              </dt>
              <dd>{x.amount}</dd>
            </div>
          ))
        )}
        {/* the promotion code sits above the total it changes */}
        <div className="co-promo">
          {applied?.promotionCode ? (
            <span className="co-promo-on" data-testid="billing-promo-applied">
              <I name="check" size={13} />
              <b>{applied.promotionCode}</b>
              <span>{applied.displayName && applied.displayName !== applied.promotionCode ? applied.displayName : t('applied')}</span>
              <IconButton
                className="btn ghost icon-only co-promo-x"
                label={t('Remove the code')}
                icon="x"
                size={12}
                onClick={removeCode}
                disabled={!actions || busy}
                data-testid="billing-promo-remove"
              />
            </span>
          ) : promo === null ? (
            <button type="button" className="btn-link co-promo-open" onClick={() => setPromo('')} disabled={!actions || busy} data-testid="billing-promo-open">
              {t('Add a promotion code')}
            </button>
          ) : (
            <form
              className="co-promo-f"
              onSubmit={(e) => {
                e.preventDefault();
                apply(promo);
              }}
            >
              <input
                className={`input co-in ${promoError ? 'invalid' : ''}`}
                value={promo}
                onChange={(e) => setPromo(e.target.value)}
                aria-label={t('Promotion code')}
                placeholder={t('Promotion code')}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <button type="submit" className="btn lg" disabled={!promo.trim()}>
                {t('Apply')}
              </button>
            </form>
          )}
          {promoError && (
            <p className="bill-error" role="alert">
              {promoError}
            </p>
          )}
        </div>
        <div className="co-total">
          <dt>{yearly ? t('Total per year') : t('Total per month')}</dt>
          <dd data-testid="billing-total">{totalNow ?? <SkLine w="5em" />}</dd>
        </div>
      </dl>
      {trial ? (
        <div className="co-due" data-testid="billing-due">
          <div>
            <span>{t('Due today')}</span>
            <b>{session?.total?.total?.amount ?? cents(0, choice.currency)}</b>
          </div>
          <p>
            {t('The trial runs on until {date}; the first payment, {amount}, is taken then. Cancel before and nothing is charged.', {
              date: trialEnd,
              amount: totalNow ?? '…',
            })}
          </p>
        </div>
      ) : inTrial ? (
        <p className="co-ends" data-testid="billing-trial-ends">
          {t('The trial ends when you pay: {plan} is billed from today.', { plan: offer.name })}
        </p>
      ) : null}
      <div className="co-go">
        {!business && (
          <label className={`co-chk co-start ${startMiss && !asked ? 'miss' : ''}`} data-testid="billing-start">
            <input
              ref={startBox}
              type="checkbox"
              checked={asked}
              onChange={(e) => {
                setAsked(e.target.checked);
                setStartMiss(false);
              }}
              disabled={busy}
              aria-describedby={startMiss && !asked ? 'co-start-miss' : undefined}
            />
            <span>
              {t(
                'I expressly ask for {plan} to start now, before the 14-day withdrawal period ends. If I withdraw, I pay for the time until then; once the service is fully provided, the right of withdrawal ends.',
                { plan: offer.name },
              )}
            </span>
          </label>
        )}
        {startMiss && !asked && !business && (
          <p className="bill-error" id="co-start-miss" role="alert" data-testid="billing-start-miss">
            {t('Tick the box to start {plan} now, or buy as a business.', { plan: offer.name })}
          </p>
        )}
        <p className="co-terms" data-testid="billing-terms">
          {business ? (
            <T k="By ordering you accept the <0>Terms</0> and have read the <1>Privacy policy</1>." tags={[page(info?.terms_url), page(info?.privacy_url)]} />
          ) : (
            <T
              k="By ordering you accept the <0>Terms</0> and have read the <1>Privacy policy</1> and the <2>withdrawal information</2>."
              tags={[page(info?.terms_url), page(info?.privacy_url), page(info?.withdrawal_url)]}
            />
          )}
        </p>
        {payButton('order')}
        <p className="co-safe">
          <I name="lock" size={12} /> {t('Card details go straight to Stripe and never reach this app.')}
        </p>
      </div>
    </Panel>
  );

  const card = (
    <section className="co-sec" aria-labelledby="co-card-h">
      {layout === 'page' && (
        <h3 id="co-card-h">
          <span className="co-n">2</span>
          {t('Card')}
        </h3>
      )}
      <Element el={els?.payment ?? null} ready={ready.payment} slots={CARD} terms="checkout" testid="billing-payment-element" />
      {/* what the card's bank or Stripe said, right under the card */}
      {error && (
        <p className="bill-error" role="alert" data-testid="billing-pay-error">
          {error}
        </p>
      )}
    </section>
  );

  const failed = refused ? (
    <PaymentsConsent />
  ) : startFailed ? (
    <div className="co-failed" role="alert" data-testid="billing-checkout-error">
      <p className="bill-error">{startFailed}</p>
      <button type="button" className="btn lg" onClick={onRetry}>
        {t('Try again')}
      </button>
    </div>
  ) : null;

  if (layout === 'sheet')
    return (
      <div className="co sheet" data-testid="billing-checkout">
        {failed}
        {card}
        {order}
      </div>
    );

  return (
    <div className="co page" data-testid="billing-checkout">
      <nav className="co-crumb" aria-label={t('Where you are')}>
        <button type="button" className="btn-link" onClick={onBack} disabled={busy} data-testid="billing-checkout-back">
          <I name="back" size={14} />
          {t('Billing')}
        </button>
        <span aria-hidden="true">/</span>
        <b>{t('Checkout')}</b>
      </nav>
      <header className="co-head">
        <h1 className="co-title" ref={title} tabIndex={-1}>
          {t('{plan} for {workspace}', { plan: offer.name, workspace })}
        </h1>
        <p>
          {(offer.perMember
            ? yearly
              ? t('Billed yearly for {n} member.|Billed yearly for {n} members.', { n: units })
              : t('Billed monthly for {n} member.|Billed monthly for {n} members.', { n: units })
            : yearly
              ? t('Billed yearly.')
              : t('Billed monthly.')) +
            (trial ? ` ${t('The trial runs on until {date}.', { date: trialEnd })}` : inTrial ? ` ${t('The trial ends when you pay.')}` : '')}
        </p>
      </header>
      <div className="co-grid">
        <div className="co-form">
          {failed}
          <Receipts email={email ?? session?.email ?? null} known={!!session} edited={email} onEdit={setEmail} busy={busy} />
          <section className="co-sec" aria-labelledby="co-addr-h">
            <h3 id="co-addr-h">
              <span className="co-n">1</span>
              {t('Billing address')}
            </h3>
            <Element el={els?.address ?? null} ready={ready.address} slots={ADDRESS} testid="billing-address-element" />
            {(!reverse || !sdk || sdk.createTaxIdElement) && (
              <label className="co-chk co-biz">
                <input type="checkbox" checked={business} onChange={(e) => (e.target.checked ? setBusiness(true) : untick())} disabled={busy} />
                <span className="co-chk-t">
                  {t('I’m purchasing as a business')}
                  <small>
                    {reverse
                      ? t('Optional: its name and VAT ID on the invoice. A VAT ID is needed only for reverse charge.')
                      : t('Optional: its name and VAT ID on the invoice.')}
                  </small>
                </span>
              </label>
            )}
            {business && reverse && (!sdk || sdk.createTaxIdElement) && <Element el={taxEl} ready={taxReady} slots={TAX_ID} testid="billing-taxid-element" />}
            {business && !reverse && (
              <div className="co-biz-f" data-testid="billing-business-fields">
                <label className="co-f">
                  <span className="co-l">{t('Business name')}</span>
                  <input
                    className="input co-in"
                    value={bizName}
                    onChange={(e) => setBizName(e.target.value)}
                    maxLength={200}
                    autoComplete="organization"
                    disabled={busy}
                    data-testid="billing-business-name"
                  />
                </label>
                <label className="co-f">
                  <span className="co-l">{t('VAT ID (optional)')}</span>
                  <input
                    id="co-vat"
                    className={`input co-in ${vatTouched && vatWrong ? 'invalid' : ''}`}
                    value={vat}
                    onChange={(e) => setVat(e.target.value)}
                    onBlur={() => {
                      // shown as it goes on the invoice
                      setVat((v) => v.replace(/\s+/g, '').toUpperCase());
                      setVatTouched(true);
                    }}
                    placeholder={`${vatCountry === 'GR' ? 'EL' : vatCountry || 'DE'}123456789`}
                    maxLength={30}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    aria-invalid={vatTouched && !!vatWrong}
                    aria-describedby={vatTouched && vatWrong ? 'co-vat-error' : undefined}
                    data-testid="billing-business-vat"
                  />
                  {vatTouched && vatWrong && (
                    <span className="bill-error" id="co-vat-error" role="alert" data-testid="billing-business-vat-error">
                      {vatWrong}
                    </span>
                  )}
                </label>
              </div>
            )}
          </section>
          {card}
        </div>
        {order}
      </div>
      {/* phones: what is due and the one action stay at hand at the bottom */}
      {/* while the form loads the bar is its one waiting button, then what is due beside it: one height throughout */}
      <div className={`co-bar ${loading ? 'loading' : ''}`}>
        <span className="co-bar-t">
          <b>{t('Due today {amount}', { amount: trial ? (session?.total?.total?.amount ?? cents(0, choice.currency)) : (totalNow ?? '…') })}</b>
          {/* the date short: the button beside it says "Zahlungspflichtig bestellen" in German, and both must fit a phone */}
          {trial && (
            <small>{t('then {amount} on {date}', { amount: totalNow ?? '…', date: b.trialEndsAt ? dayOf(b.trialEndsAt, { short: true }) : trialEnd })}</small>
          )}
        </span>
        {payButton('bar')}
      </div>
    </div>
  );
}

/** "Receipts and invoices go to …" and its Change: Stripe keeps the customer's address, so a new one is saved with the
 * billing details once the payment is through. */
function Receipts({
  email,
  known,
  edited,
  onEdit,
  busy,
}: {
  email: string | null;
  known: boolean;
  edited: string | null;
  onEdit: (e: string | null) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  if (open)
    return (
      <form
        className="co-mail-f"
        onSubmit={(e) => {
          e.preventDefault();
          onEdit(draft.trim() || null);
          setOpen(false);
        }}
      >
        <label className="co-f">
          <span className="co-l">{t('Receipts and invoices go to')}</span>
          <input
            className="input co-in"
            type="email"
            required
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={254}
            autoComplete="email"
            autoFocus
          />
        </label>
        <button type="submit" className="btn lg">
          {t('Use it')}
        </button>
        <button type="button" className="btn ghost lg" onClick={() => setOpen(false)}>
          {t('Cancel')}
        </button>
      </form>
    );
  return (
    <p className="co-mail" data-testid="billing-receipts">
      <I name="mail" size={14} />
      <span>
        {known && email ? (
          <T k="Receipts and invoices go to <0>{email}</0>." values={{ email }} tags={[(c) => <b>{c}</b>]} />
        ) : (
          <>
            {t('Receipts and invoices go to')} <SkLine w="6em" />
          </>
        )}
        {edited && <small> {t('(saved when you pay)')}</small>}
      </span>
      <button
        type="button"
        className="btn-link co-lk"
        disabled={!known || busy}
        onClick={() => {
          setDraft(email ?? '');
          setOpen(true);
        }}
      >
        {t('Change')}
      </button>
    </p>
  );
}

/** What the done panel shows: the session's numbers at the moment it was paid. */
interface Paid {
  trial: boolean;
  /** The trial's ruler as it stood when paid (today's day of its length): the done panel sweeps it full. */
  ruler: { day: number; of: number } | null;
  first: string;
  /** The first payment's day (the trial's end, as it was when paid: the plan's answer then drops the trial). */
  on: string;
  email: string | null;
}

/** Paid: calm, the plan named, four facts, and the way on. The plan's own answer is asked until the provider's events
 * have reached the server (a few seconds; at most a minute), then the card on file shows. */
function Done({ b, offer, choice, workspace, paid }: { b: BillingInfo; offer: BillingOffer; choice: CheckoutChoice; workspace: string; paid: Paid }) {
  const [waiting, setWaiting] = useState(true);
  const { data: now } = useBilling(true, waiting);
  const arrived = !!now?.subscribed;
  useEffect(() => {
    if (arrived) return setWaiting(false);
    const stop = setTimeout(() => setWaiting(false), 60_000);
    return () => clearTimeout(stop);
  }, [arrived]);
  const account = useBillingAccount(arrived && !!now?.account);
  const method = account.data?.methods.find((m) => m.default) ?? account.data?.methods[0];
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus({ preventScroll: true }), []);
  const units = unitsOf(offer, b);
  const yearly = choice.interval === 'year';
  const trialEnd = paid.on;
  const fact = (dt: string, dd: ReactNode) => (
    <div>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </div>
  );
  return (
    <div className="co page done" data-testid="billing-checkout-done">
      <Panel pad="lg" className="co-paid" aria-labelledby="co-paid-h">
        {paid.ruler && (
          <div className="co-paid-ruler">
            <Ruler day={paid.ruler.day} of={paid.ruler.of} end="diamond" sweep />
          </div>
        )}
        <div className="co-paid-h" role="status">
          <KeyGlyph shape="diamond" size={16} className="ok" pop />
          <h2 id="co-paid-h" ref={head} tabIndex={-1}>
            {t('{workspace} is on {plan}', { workspace, plan: offer.name })}
          </h2>
        </div>
        <p className="co-paid-l">
          {(offer.perMember
            ? yearly
              ? t('Billed yearly for {n} member.|Billed yearly for {n} members.', { n: units })
              : t('Billed monthly for {n} member.|Billed monthly for {n} members.', { n: units })
            : yearly
              ? t('Billed yearly.')
              : t('Billed monthly.')) +
            ' ' +
            (paid.trial ? t('The trial runs on until {date}; the first payment is taken then.', { date: trialEnd }) : t('The first payment is through.'))}
        </p>
        <dl className="co-facts">
          {fact(t('Plan'), `${offer.name} · ${yearly ? t('yearly') : t('monthly')}`)}
          {fact(t('First payment'), `${paid.first} · ${paid.trial ? trialEnd : t('today')}`)}
          {fact(t('Card'), method ? methodLabel(method) : waiting ? <SkLine w="8em" /> : t('Saved with Stripe'))}
          {fact(t('Invoices to'), paid.email ?? '—')}
        </dl>
        {paid.email && (
          <p className="co-fine">
            {paid.trial
              ? t('A confirmation is on its way to {email}. Each invoice, with its PDF, lands in Billing → Invoices, the first on {date}.', {
                  email: paid.email,
                  date: trialEnd,
                })
              : t('A confirmation is on its way to {email}. Each invoice, with its PDF, lands in Billing → Invoices.', { email: paid.email })}
          </p>
        )}
        <div className="co-paid-acts">
          <a className="btn lg" href="#/">
            {t('Back to the library')}
          </a>
          <a className="btn-link" href="#/settings/billing" data-testid="billing-see-billing">
            <I name="billing" size={14} />
            {t('See Billing')}
          </a>
        </div>
      </Panel>
    </div>
  );
}
