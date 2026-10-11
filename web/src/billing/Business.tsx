// Paid plans are for businesses only (the billing provider's rule; its prices stay net): before a checkout starts, the
// person ticks "I'm buying for my business, not as a private person" — on Settings → Billing's plans, at the checkout
// step (the trial's end goes straight there) and in a limit sheet. The provider keeps who confirmed it and when, and says
// so (BillingInfo.business): the box is ticked from then on. What is ticked or unticked here holds for the rest of the
// visit wherever it is asked (billing/buyer.ts), so the plans' tick carries into the checkout. A checkout sends it
// (`business: true`) and the provider starts none without it; the trial and Free ask nothing.
import { useId, useSyncExternalStore } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { Checkbox } from '../ui/controls.tsx';
import { businessSaid, businessTicked, sayBusiness, subscribeBusiness } from './buyer.ts';
import '../styles/billing.css';

/** Whether the box is ticked for the workspace, and the way to tick or untick it. */
export function useBusiness(b: Pick<BillingInfo, 'business'>): [boolean, (on: boolean) => void] {
  const ws = useAuthStatus().data?.workspace?.id ?? '';
  // read so the component hears this visit's changes; the answer itself is businessTicked's
  useSyncExternalStore(subscribeBusiness, () => businessSaid(ws));
  return [businessTicked(b, ws), (on: boolean) => sayBusiness(ws, on)];
}

/**
 * The box itself: the design system's checkbox and its words, a quiet second line where it stands alone (`note`).
 * `boxed`: in a hairline box of its own (the checkout step, a limit sheet); bare in the plans' bar.
 */
export function BusinessTick({
  on,
  onChange,
  disabled,
  note,
  boxed,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  note?: string;
  boxed?: boolean;
}) {
  const id = useId();
  return (
    <div className={`bill-biz ${boxed ? 'boxed' : ''}`} data-testid="billing-business" data-on={on}>
      <Checkbox id={id} checked={on} onCheckedChange={onChange} disabled={disabled} />
      <label htmlFor={id}>
        <span>{t('I’m buying for my business, not as a private person')}</span>
        {note && <small>{note}</small>}
      </label>
    </div>
  );
}
