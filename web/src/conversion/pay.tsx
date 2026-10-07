// Paying in place, for the moments outside Settings → Billing (a limit's sheet, an invite beyond the plan): one small
// interface, so whatever pays on the billing page pays here too by changing this file alone. A new plan is the billing
// page's checkout step in its one-column `sheet` layout (billing/Checkout.tsx: a Checkout Session, Stripe's card and
// country, the session's own order and its one orange button); on a running subscription the card on file pays: another
// plan (`POST /api/billing/plan`) or one more terabyte (`POST /api/billing/storage`, which takes the terabytes the
// subscription carries in all), both settled on the next invoice.
// Its own chunk's styles come with it (billing.css, settings.css, pay.css): nothing here leans on CSS another chunk loads.
import { useState } from 'react';
import type { BillingInfo, BillingMethod, BillingPreview } from '../../../lib/types.ts';
import { api } from '../api/client.ts';
import { useBillingAccount } from '../billing/api.ts';
import { CheckoutStep } from '../billing/Checkout.tsx';
import { billingSaid } from '../billing/words.ts';
import { t } from '../i18n/index.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { money } from './limits/model.ts';
import '../styles/settings.css';
import '../styles/billing.css';
import '../styles/pay.css';

/**
 * What is paid for: a plan on the page, another plan or one more terabyte on a running subscription — `storageTB` is the
 * subscription's terabytes in all once paid (POST /api/billing/storage sets the total: what it has + 1), never the step.
 */
export type PayWhat =
  | { kind: 'checkout'; plan: string; interval: 'month' | 'year'; currency: string }
  | { kind: 'switch'; plan: string; interval: 'month' | 'year' }
  | { kind: 'addon'; storageTB: number };

export interface PayProps {
  what: PayWhat;
  billing: BillingInfo;
  /** The orange button's words on a running subscription ("Add 1 TB and upload"); a new plan's checkout says "Buy now". */
  label: string;
  /** The workspace's name: the checkout's title is what is bought ("Solo for Costa Cuts"). */
  workspace: string;
  /** The lines of the order above the button, on a running subscription (the checkout shows its own total). */
  order?: { k: string; sub?: string; v: string; muted?: boolean }[];
  /** What the order's total says ("Today €0.00") and the sentence under it. */
  total?: { k: string; v: string; note?: string };
  onPaid: () => void;
  onCancel?: () => void;
}

const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB' };

/** "Visa •••• 4242". */
export const cardLabel = (m: BillingMethod): string =>
  m.last4
    ? `${BRANDS[m.brand ?? ''] ?? (m.brand ? m.brand[0].toUpperCase() + m.brand.slice(1) : t('Card'))} •••• ${m.last4}`
    : (BRANDS[m.brand ?? ''] ?? m.type);

/** The card renewals are charged to, once the account is read (owners and admins of a paying workspace). */
export function useCardOnFile(b: BillingInfo): { card: BillingMethod | null; loading: boolean } {
  const q = useBillingAccount(!!b.account && b.manage);
  return { card: q.data?.methods.find((m) => m.default) ?? q.data?.methods[0] ?? null, loading: q.isLoading };
}

/** A card's brand, small (the brand's own colours; a plain card for the others). */
export function BrandMark({ brand }: { brand?: string }) {
  if (brand === 'visa')
    return (
      <svg className="pay-brand" viewBox="0 0 32 20" aria-hidden="true">
        <rect width="32" height="20" rx="3" fill="#fff" stroke="rgba(0,0,0,.12)" />
        <path
          d="M13.3 13.6h-1.9l1.2-7.2h1.9zm6.9-7c-.4-.1-1-.3-1.7-.3-1.9 0-3.2 1-3.2 2.4 0 1.1.9 1.6 1.7 2 .7.3 1 .6 1 .9 0 .5-.6.7-1.2.7-.8 0-1.2-.1-1.9-.4l-.3-.1-.3 1.6c.5.2 1.3.4 2.2.4 2 0 3.3-1 3.3-2.5 0-.8-.5-1.4-1.6-2-.7-.3-1.1-.6-1.1-.9 0-.3.3-.6 1.1-.6.6 0 1.1.1 1.4.3l.2.1zm4.9-.6h-1.5c-.5 0-.8.1-1 .6l-2.8 6.6h2l.4-1.1h2.4l.2 1.1h1.8zm-2.3 4.6.8-2 .4 2zm-11.8-4.6-1.9 4.9-.2-1c-.3-1.1-1.4-2.4-2.6-3l1.7 6.3h2l3-7.2z"
          fill="#1a1f71"
        />
      </svg>
    );
  if (brand === 'mastercard')
    return (
      <svg className="pay-brand" viewBox="0 0 32 20" aria-hidden="true">
        <rect width="32" height="20" rx="3" fill="#fff" stroke="rgba(0,0,0,.12)" />
        <circle cx="13" cy="10" r="5.4" fill="#eb001b" />
        <circle cx="19" cy="10" r="5.4" fill="#f79e1b" />
        <path d="M16 5.5a5.4 5.4 0 0 1 0 9 5.4 5.4 0 0 1 0-9" fill="#ff5f00" />
      </svg>
    );
  return (
    <span className="pay-brand plain" aria-hidden="true">
      <I name="billing" size={15} />
    </span>
  );
}

/** The card on file, one line, with Change (Settings → Billing, where cards are managed). */
export function SavedCard({ card, sub }: { card: BillingMethod | null; sub: string }) {
  return (
    <div className="pay-saved" data-testid="pay-saved-card">
      <BrandMark brand={card?.brand} />
      <span className="pay-saved-t">
        <b>{card ? cardLabel(card) : t('The card on file')}</b>
        <small>{sub}</small>
      </span>
      <a className="btn ghost sm" href="#/settings/billing">
        {t('Change')}
      </a>
    </div>
  );
}

/**
 * A new plan paid on the page: the billing page's checkout step, one column inside the sheet (its fields keep their room).
 * Its button is the checkout's own ("Buy now", § 312j(3) BGB), whatever the moment would call it.
 */
function Checkout({ what, billing, workspace, onPaid, onCancel }: PayProps & { what: Extract<PayWhat, { kind: 'checkout' }> }) {
  const { plan, interval, currency } = what;
  return (
    <CheckoutStep
      b={billing}
      choice={{ plan, interval, currency }}
      workspace={workspace}
      layout="sheet"
      onBack={onCancel ?? (() => {})}
      onPaid={() => onPaid()}
    />
  );
}

/** Another plan or one more terabyte on a running subscription: the card on file, settled on the next invoice. */
function OnFile({ what, billing, label, order = [], total, onPaid }: PayProps) {
  const { card } = useCardOnFile(billing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      if (what.kind === 'switch') await api('/api/billing/plan', { method: 'POST', body: { plan: what.plan, interval: what.interval } });
      else if (what.kind === 'addon') await api('/api/billing/storage', { method: 'POST', body: { tb: what.storageTB } });
      onPaid();
    } catch (e) {
      setBusy(false);
      setError(billingSaid(e));
    }
  };
  return (
    <>
      <SavedCard
        card={card}
        sub={
          card?.expMonth && card.expYear
            ? t('Expires {date} · pays for {plan}', { date: `${String(card.expMonth).padStart(2, '0')}/${card.expYear}`, plan: billing.planName })
            : t('Pays for {plan}', { plan: billing.planName })
        }
      />
      <dl className="pay-sum" data-testid="pay-order">
        {order.map((r) => (
          <div key={r.k} className={r.muted ? 'muted' : ''}>
            <dt>
              {r.k}
              {r.sub && <small>{r.sub}</small>}
            </dt>
            <dd>{r.v}</dd>
          </div>
        ))}
        {total && (
          <div className="pay-total">
            <dt>{total.k}</dt>
            <dd>{total.v}</dd>
          </div>
        )}
        {total?.note && <p className="pay-note">{total.note}</p>}
      </dl>
      {error && (
        <p className="bill-error" role="alert" data-testid="pay-error">
          {error}
        </p>
      )}
      <button type="button" className="btn primary lg pay-go" onClick={go} disabled={busy} data-testid="pay-go">
        {busy && <Spinner />} {label}
      </button>
    </>
  );
}

/** Paying for what a moment offers, in place. */
export function PayInPlace(props: PayProps) {
  if (props.what.kind === 'checkout') return <Checkout {...props} what={props.what} />;
  return <OnFile {...props} />;
}

/** What a plan change puts on the next invoice: its date and the prorated difference (when the provider says it). */
export async function previewSwitch(plan: string, interval: 'month' | 'year'): Promise<BillingPreview | null> {
  try {
    return await api<BillingPreview>('/api/billing/plan/preview', { method: 'POST', body: { plan, interval } });
  } catch {
    return null;
  }
}

/**
 * "€17.60": the switch's own part of the next invoice — only what a step up costs; a credit, nothing, or a sum the
 * provider didn't give (it leaves `prorated` out when Stripe paged the proration lines) is not said.
 */
export const previewMoney = (p: BillingPreview | null | undefined): string | null =>
  p && typeof p.prorated === 'number' && p.prorated > 0 ? money(p.prorated, p.currency, true) : null;
