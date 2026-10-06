// The billing page's form for a new payment method or an open invoice, loaded on demand (Settings → Billing,
// `payForms`): Stripe's Payment Element on a setup or a payment (a plan's checkout is its own step, billing/Checkout.tsx).
// Everything is on this page; a bank that wants its own approval page is the only time anyone leaves it, and it comes
// back here. Card fields are Stripe's frames: what is typed there goes to Stripe, never to this app.
import { type ReactNode, useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { PaymentsConsent, usePaymentsChoice } from './PaymentsConsent.tsx';
import { CARD, Element } from './Slots.tsx';
import {
  appearance,
  declined,
  elementsOptions,
  methodId,
  onThemeChange,
  type StripeElement,
  type StripeElements,
  type Stripe as StripeJs,
  stripeFor,
} from './stripe.ts';

/** Where a bank's own approval page sends the person back: this page, which then waits for the plan to arrive. */
const back = (q: string) => `${location.origin}${location.pathname}#/settings/billing?${q}`;

export interface IntentFormProps {
  publishableKey: string;
  clientSecret: string;
  /** A setup (a new payment method) or a payment (an open invoice). */
  kind: 'setup' | 'payment';
  /** What the form is for, as its eyebrow ("Add a card", "A new card"). */
  title: string;
  /** The one orange action ("Save card", "Pay €171.36"). */
  action: string;
  /** Between the card and the actions: the caller's own choice ("Use it for renewals"). */
  children?: ReactNode;
  /** The payment method that was used, when Stripe says which. */
  onDone: (method: string | null) => void;
  onCancel: () => void;
}

/**
 * Stripe's Payment Element on a setup or a payment of this workspace's customer, on the page's one control scale: the
 * card alone (no wallets, no Link, the country only where a card needs it), its room kept while it loads, Cancel and
 * the one orange action at the field height, and where the card details go.
 */
export function IntentForm({ publishableKey, clientSecret, kind, title, action, children, onDone, onCancel }: IntentFormProps) {
  const [ctx, setCtx] = useState<{ stripe: StripeJs; elements: StripeElements; el: StripeElement } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Stripe.js waits for the person's say in the cookie settings (A13 CLOUD-1)
  const allowed = usePaymentsChoice(true);
  const stripeOk = !!allowed?.stripe;
  const refused = allowed?.stripe === false;
  useEffect(() => {
    if (!stripeOk) return;
    let live = true;
    let offTheme = () => {};
    let el: StripeElement | null = null;
    (async () => {
      const stripe = await stripeFor(publishableKey);
      if (!live) return;
      const elements = stripe.elements({ clientSecret, ...elementsOptions() });
      offTheme = onThemeChange(() => elements.update?.({ appearance: appearance() }));
      el = elements.create('payment', {
        layout: 'tabs',
        wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
        fields: { billingDetails: { address: 'if_required' } },
        terms: { card: 'auto' },
      });
      el.on('ready', () => live && setReady(true));
      setCtx({ stripe, elements, el });
    })().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      offTheme();
      el?.destroy();
    };
  }, [publishableKey, clientSecret, stripeOk]);

  const submit = async () => {
    if (!ctx) return;
    setBusy(true);
    setError('');
    const o = { elements: ctx.elements, redirect: 'if_required' as const, confirmParams: { return_url: back(kind === 'setup' ? 'method=done' : 'paid=done') } };
    const r = kind === 'setup' ? await ctx.stripe.confirmSetup(o) : await ctx.stripe.confirmPayment(o);
    if (r.error) {
      setBusy(false);
      return setError(declined(r.error));
    }
    const done = 'setupIntent' in r ? r.setupIntent : 'paymentIntent' in r ? r.paymentIntent : undefined;
    onDone(methodId(done?.payment_method));
  };

  return (
    <div className="co-intent" data-testid={`billing-${kind}`}>
      <p className="eyebrow">{title}</p>
      {refused && <PaymentsConsent />}
      <Element el={ctx?.el ?? null} ready={ready} slots={CARD} terms="intent" testid="billing-payment-element" />
      {/* what the card's bank or Stripe said, right under the card */}
      {error && (
        <p className="bill-error" role="alert" data-testid="billing-pay-error">
          {error}
        </p>
      )}
      {children}
      <div className="co-intent-acts">
        <button type="button" className="btn ghost lg" onClick={onCancel} disabled={busy}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn primary lg" onClick={submit} disabled={!ready || !ctx || busy} data-testid="billing-intent-submit">
          {((!ready && !refused) || busy) && <Spinner />}
          {ready || refused ? action : t('Loading the payment form')}
        </button>
      </div>
      <p className="co-safe">
        <I name="lock" size={12} /> {t('Card details go straight to Stripe and never reach this app.')}
      </p>
    </div>
  );
}
