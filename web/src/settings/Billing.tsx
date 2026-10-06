// Settings → Billing: only where a billing provider runs (/api/info `billing`, a module behind server/extension.ts). One
// page in three parts, in this order: the plan (billing/Plan.tsx: where the workspace stands, what it uses, the one
// thing to do), the plans to choose from (billing/Picker.tsx: a trial, Free, or Change plan), and the account
// (BillingAccount.tsx: payment method, billing details, invoices) — the last two for owners and admins. A complimentary
// workspace and a member read their own words instead. Choosing a new plan goes on to the checkout step
// (#/settings/billing/checkout, billing/Checkout.tsx); a renewal that didn't go through is fixed in a sheet
// (billing/FixPayment.tsx). Nobody is sent to the provider's own pages. Every name, price and limit comes from the
// provider (lib/types.ts BillingInfo); the words around them are ours.
import { useEffect, useState } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { useBilling } from '../api/queries.ts';
import { useCancelOptions } from '../billing/api.ts';
import { CancelStep, isCancelHash } from '../billing/Cancel.tsx';
import { CheckoutStep, choiceFromHash } from '../billing/Checkout.tsx';
import { FixPayment } from '../billing/FixPayment.tsx';
import { lastChoice, type Picked, Picker } from '../billing/Picker.tsx';
import { kindOf, PlanPanel } from '../billing/Plan.tsx';
import { t } from '../i18n/index.ts';
import { errorMessage } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { BillingAccountPanel } from './BillingAccount.tsx';
import '../styles/billing.css';

/** What the address says on arrival: back from a bank's approval page, or a plan picked on the website. */
const params = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const returned = (): string | null => {
  const p = params();
  if (p.get('checkout')) return p.get('checkout');
  if (p.get('method') === 'done') return 'method';
  if (p.get('paid') === 'done') return 'paid';
  return null;
};
/** The website's pricing buttons send `?plan=cloud-solo|cloud-team|cloud-business`, and may say the interval and the
 * currency they showed; anything else is ignored. */
const PICKS: Record<string, string> = { 'cloud-solo': 'solo', 'cloud-team': 'team', 'cloud-business': 'business' };
const pickedPlan = (): Picked | null => {
  const p = params();
  const plan = PICKS[p.get('plan') ?? ''];
  if (!plan || /\/checkout/.test(location.hash)) return null;
  const interval = p.get('interval');
  const currency = p.get('currency');
  return {
    plan,
    ...(interval === 'month' || interval === 'year' ? { interval } : {}),
    ...(currency && /^(eur|usd)$/.test(currency) ? { currency } : {}),
  };
};

export function Billing() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const follow = () => setHash(location.hash);
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);
  const { data: b, isPending } = useBilling(true);
  const ws = useAuthStatus().data?.workspace?.name ?? t('This workspace');
  // the checkout is a step of its own, at its own address (#/settings/billing/checkout?plan=…)
  const choice = choiceFromHash(hash, b?.currency);
  // "Cancel contracts here" (§ 312k BGB) is one too: #/settings/billing/cancel
  const cancelling = isCancelHash(hash);
  // a running plan's ways to cancel beyond the two every plan has (one month's notice: the provider says when it applies)
  const askWays = cancelling && !!b?.manage && !!b.subscribed && !b.endsAt;
  const ways = useCancelOptions(askWays);
  // the step's own room comes with the plan's answer; the page's loading state in between would jump — and so would a
  // way to cancel that arrived after the step (a failed answer leaves the two ways every plan has)
  if ((choice || cancelling) && isPending) return null;
  if (askWays && ways.isPending) return null;
  if (cancelling && b)
    return (
      <CancelStep
        b={b}
        ways={ways.data}
        workspace={ws}
        onBack={() => {
          location.hash = '#/settings/billing';
        }}
      />
    );
  // not only before a subscription: paying makes one, and the step stays to show that it's done
  if (choice && b?.manage)
    return (
      <CheckoutStep
        b={b}
        choice={choice}
        workspace={ws}
        onBack={() => {
          location.hash = '#/settings/billing';
        }}
        onPaid={() => {}}
      />
    );
  return <BillingPage ws={ws} />;
}

function BillingPage({ ws }: { ws: string }) {
  const [back, setBack] = useState(returned);
  const [picked] = useState(pickedPlan);
  // back from paying: ask until the provider has told the server (a few seconds), at most a minute
  const [waiting, setWaiting] = useState(back === 'done');
  const { data: b, error, isPending } = useBilling(true, waiting);
  const [change, setChange] = useState(!!picked);
  const [fixing, setFixing] = useState(false);
  useEffect(() => {
    if (back || picked) history.replaceState(history.state, '', '#/settings/billing');
  }, [back, picked]);
  // a bank's page that answers within the tab (no reload) comes back through the address as well
  useEffect(() => {
    const heard = () => {
      const r = returned();
      if (!r) return;
      setBack(r);
      setWaiting(r === 'done');
      history.replaceState(history.state, '', '#/settings/billing');
    };
    addEventListener('hashchange', heard);
    return () => removeEventListener('hashchange', heard);
  }, []);
  useEffect(() => {
    if (!waiting) return;
    if (b?.subscribed) return setWaiting(false);
    const stop = setTimeout(() => setWaiting(false), 60_000);
    return () => clearTimeout(stop);
  }, [waiting, b?.subscribed]);
  // a plan picked on the website: shown where it is, once
  useEffect(() => {
    if (!picked || !b?.offers) return;
    document.querySelector(`[data-testid=billing-offer-${picked.plan}]`)?.scrollIntoView({ block: 'center' });
  }, [picked, b?.offers]);
  const kind = b ? kindOf(b) : null;
  const manage = !!b?.manage;
  const pickerOpen =
    !!b && manage && !!b.offers?.length && (kind === 'trial' || kind === 'free' || kind === 'grace' || kind === 'read-only' || (kind === 'paid' && change));
  const quiet = !!b && (b.complimentary || !manage);
  const toggle = () => {
    setChange(!change);
    if (!change) requestAnimationFrame(() => document.getElementById('billing-picker')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };
  return (
    <div className="bill-page">
      <header className="set-head">
        <h1>{t('Billing')}</h1>
        <p>{quiet ? t('{ws}’s plan and what it uses.', { ws }) : t('{ws}’s plan, what it uses, and how it’s paid.', { ws })}</p>
      </header>
      {back && <Returned back={back} waiting={waiting} b={b} />}
      {error ? (
        <section className="panel bill-hero">
          <p className="bill-err" role="alert">
            {errorMessage(error)}
          </p>
        </section>
      ) : (
        <PlanPanel b={isPending ? null : (b ?? null)} ws={ws} picker={change} onPicker={toggle} onFix={() => setFixing(true)} />
      )}
      {b && pickerOpen && b.offers && <Picker b={{ ...b, offers: b.offers }} ws={ws} picked={picked} initial={lastChoice()} onClose={() => setChange(false)} />}
      {b && manage && b.account && b.available !== false && <BillingAccountPanel b={b} onPay={() => setFixing(true)} />}
      {b?.complimentary ? (
        <section className="panel bill-who" data-testid="billing-who">
          <I name="info" size={16} />
          <p>{t('Nothing to set up here: no payment method, no invoices. Members, storage and videos have no limits.')}</p>
        </section>
      ) : b && !manage ? (
        <section className="panel bill-who" data-testid="billing-who">
          <I name="users" size={16} />
          <p>{t('The owner and the admins of {ws} choose the plan and how it’s paid.', { ws })}</p>
        </section>
      ) : null}
      {fixing && b && <FixPayment b={b} onClose={() => setFixing(false)} />}
    </div>
  );
}

function Returned({ back, waiting, b }: { back: string; waiting: boolean; b: BillingInfo | undefined }) {
  const done = back !== 'cancelled';
  const arrived = back === 'done' && !!b?.subscribed;
  const text =
    back === 'method'
      ? t('The payment method is saved.')
      : back === 'paid'
        ? t('Thank you: the invoice is paid. The plan shows it in a moment.')
        : back === 'cancelled'
          ? t('Nothing was charged.')
          : arrived
            ? t('Thank you: this workspace is on {plan} now.', { plan: b?.planName ?? '' })
            : waiting
              ? t('Thank you: the payment is through. The new plan shows here in a moment.')
              : t('The payment is through, but the new plan hasn’t arrived yet. Reload this page in a minute.');
  return (
    <div className={`bill-note ${done ? 'ok' : ''}`} role="status" data-testid="billing-return">
      {back === 'done' && waiting && !arrived ? <Spinner /> : <I name={done ? 'check' : 'info'} size={15} />}
      <span>{text}</span>
    </div>
  );
}
