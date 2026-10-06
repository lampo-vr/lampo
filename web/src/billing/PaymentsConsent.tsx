// The payment form's third parties wait for the person's say (A13 CLOUD-1): Stripe.js, which sets Stripe's cookies
// against fraud, and the address search inside it, whose suggestions come from Google. The cookie settings' box asks
// once (consent/consent.ts); refused, the form says so in a sentence where it would be, with the way to allow it there and
// then, and the settings.
import { useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { Spinner } from '../ui/feedback.tsx';
import { consent } from './stripe.ts';
import '../styles/checkout.css';

export interface PaymentsChoice {
  stripe: boolean;
  address: boolean;
}

/**
 * The person's choice for the payment form: null until they made one (the box is showing meanwhile), then what it
 * allows — again whenever they change it (the box, the settings, Allow below).
 */
export function usePaymentsChoice(enabled: boolean): PaymentsChoice | null {
  const [choice, setChoice] = useState<PaymentsChoice | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let off = () => {};
    (async () => {
      const c = await consent();
      if (!live) return;
      const ask = () => c.paymentsChoice().then((x) => live && setChoice({ stripe: x.stripe, address: x.address }));
      off = c.onConsentChange(() => void ask());
      await ask();
    })().catch(() => live && setChoice({ stripe: false, address: false }));
    return () => {
      live = false;
      off();
    };
  }, [enabled]);
  return choice;
}

/** Refused: where the form would be, what it needs and the two ways on — allow it now, or open the settings. */
export function PaymentsConsent() {
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try {
      await (await consent()).allowPayments();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="co-failed co-consent" role="status" data-testid="billing-consent">
      <p>
        {t(
          'The payment form is Stripe’s: it sets Stripe’s cookies against fraud, and its address search sends what you type to Google. It loads once you allow it in the cookie settings.',
        )}
      </p>
      <div className="co-consent-acts">
        <button type="button" className="btn lg" onClick={allow} disabled={busy} data-testid="billing-consent-allow">
          {busy && <Spinner />}
          {t('Allow the payment form')}
        </button>
        <button type="button" className="btn ghost lg" onClick={() => consent().then((c) => c.showSettings())} data-testid="billing-consent-settings">
          {t('Cookie settings')}
        </button>
      </div>
    </div>
  );
}
