// "Cancel contracts here" (§ 312k BGB, A13 CLOUD-2): the confirmation page the cancel button leads to, a step of its own
// inside Settings → Billing (#/settings/billing/cancel), in the checkout step's anatomy (billing/Checkout.tsx): the crumb,
// the title, how to cancel on the left (at the period's end, or for an important reason with that reason), on the right
// the contract — who, which plan, until when — and the one button, "Cancel now" / "Jetzt kündigen". Received, it says
// when it was received and when the plan ends, and that the confirmation is on its way by email (the provider sends it
// at once). Where there is nothing to cancel it says why. Without signing in, the operator's own page (LAMPO_CANCEL_URL) is
// the way: the sign-in's foot and Settings → About link it.
// A consumer's yearly plan after its first year (§ 309 Nr. 9 BGB, the terms' § 6 (1)) may also end with one month's
// notice, the time paid for after that refunded pro rata: offered only when the provider says so (`ways.notice`, asked
// as the step opens), with the day it would end and the amount, in the contract too and in what was received.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { BillingCancelOptions, BillingInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { locale, t } from '../i18n/index.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Panel } from '../ui/system.tsx';
import { useCancelContract } from './api.ts';
import { kindOf, planPrice } from './Plan.tsx';
import { FitGrid } from './parts.tsx';
import { billingSaid, dayOf, money } from './words.ts';
import '../styles/checkout.css';

/** The step's own address. */
export const CANCEL_HASH = '#/settings/billing/cancel';
export const isCancelHash = (hash: string) => /^#\/settings\/billing\/cancel(\?.*)?$/.test(hash);

/** "8 October 2026, 11:05": when it was received, in the page's language and time. */
const stamp = (iso: string) => new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

type Kind = 'ordinary' | 'extraordinary' | 'notice';

interface Received {
  kind: Kind;
  receivedAt: string;
  endsAt: string | null;
  refund?: { amount: number; currency: string; days: number; of: number };
}

/** "€136.24": a refund, always with its cents. */
const refunded = (r: { amount: number; currency: string }) => money(r.amount, r.currency, { cents: true });

export function CancelStep({ b, ways, workspace, onBack }: { b: BillingInfo; ways?: BillingCancelOptions; workspace: string; onBack: () => void }) {
  const me = useAuthStatus().data?.user;
  const cancel = useCancelContract();
  const [kind, setKind] = useState<Kind>('ordinary');
  // one month's notice, where the provider offers it today: when it would end, what would go back
  const notice = ways?.notice ?? null;
  const noticeEnds = notice ? dayOf(notice.endsAt, { year: true }) : null;
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Received | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);
  const k = kindOf(b);
  const price = b.manage ? planPrice(b) : null;
  const ends = b.renewsAt ? dayOf(b.renewsAt, { year: true }) : null;

  const crumb = (
    <nav className="co-crumb" aria-label={t('Where you are')}>
      <button type="button" className="btn-link" onClick={onBack} disabled={cancel.isPending} data-testid="billing-cancel-back">
        <I name="back" size={14} />
        {t('Billing')}
      </button>
      <span aria-hidden="true">/</span>
      <b>{t('Cancel contracts')}</b>
    </nav>
  );

  if (done) return <Done b={b} workspace={workspace} email={me?.email ?? null} done={done} />;

  // nothing to cancel here: who may, what there is, said plainly — the way back the one thing to do
  const nothing: ReactNode =
    k === 'comp'
      ? t('{ws} is complimentary: there is no contract to cancel.', { ws: workspace })
      : !b.manage
        ? t('The owner and the admins of {ws} cancel its plan.', { ws: workspace })
        : k === 'cancelled' && b.endsAt
          ? t('{plan} is cancelled already: it ends on {date}, then {ws} moves to Free.', {
              plan: b.planName,
              date: dayOf(b.endsAt, { year: true }),
              ws: workspace,
            })
          : k === 'trial'
            ? t('There is no paid plan to cancel: the trial ends by itself on {date}, and nothing is charged.', {
                date: b.trialEndsAt ? dayOf(b.trialEndsAt, { year: true }) : '',
              })
            : k === 'paid' || k === 'failed' || (k === 'grace' && b.subscribed)
              ? null
              : t('There is no paid plan to cancel: {ws} is on Free.', { ws: workspace });
  if (nothing || !b.subscribed)
    return (
      <div className="co page" data-testid="billing-cancel-step">
        {crumb}
        <header className="co-head">
          <h1 className="co-title" ref={title} tabIndex={-1}>
            {t('Cancel contracts')}
          </h1>
          <p data-testid="billing-cancel-nothing">{nothing ?? t('There is no paid plan to cancel: {ws} is on Free.', { ws: workspace })}</p>
        </header>
        <div>
          <button type="button" className="btn lg" onClick={onBack}>
            {t('Back to Billing')}
          </button>
        </div>
      </div>
    );

  const go = async () => {
    if (kind === 'extraordinary' && reason.trim().length < 3) {
      setMissing(true);
      document.getElementById('co-reason')?.focus();
      return;
    }
    setError('');
    try {
      const r = await cancel.mutateAsync({ kind, ...(kind === 'extraordinary' ? { reason: reason.trim() } : {}) });
      setDone({ kind: r.kind, receivedAt: r.receivedAt, endsAt: r.endsAt, ...(r.refund ? { refund: r.refund } : {}) });
    } catch (e) {
      setError(billingSaid(e));
    }
  };

  const fact = (dt: string, dd: ReactNode) => (
    <div>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </div>
  );

  return (
    <div className="co page" data-testid="billing-cancel-step">
      {crumb}
      <header className="co-head">
        <h1 className="co-title" ref={title} tabIndex={-1}>
          {t('Cancel {plan} for {workspace}', { plan: b.planName, workspace })}
        </h1>
        <p>{t('Say how, then Cancel now. The confirmation comes by email at once, with when it was received and when the plan ends.')}</p>
      </header>
      <div className="co-grid">
        <div className="co-form">
          <section className="co-sec" aria-labelledby="co-how-h">
            <h3 id="co-how-h">
              <span className="co-n">1</span>
              {t('How you cancel')}
            </h3>
            <div className="co-radios" role="radiogroup" aria-labelledby="co-how-h">
              <label className={`co-chk co-radio ${kind === 'ordinary' ? 'on' : ''}`} data-testid="billing-cancel-ordinary">
                <input type="radio" name="co-kind" checked={kind === 'ordinary'} onChange={() => setKind('ordinary')} disabled={cancel.isPending} />
                <span className="co-chk-t">
                  {t('At the end of the period')}
                  <small>
                    {ends
                      ? t('{plan} runs until {date}, then {ws} moves to Free. Nothing is deleted.', { plan: b.planName, date: ends, ws: workspace })
                      : t('{plan} runs until the end of the period paid for, then {ws} moves to Free. Nothing is deleted.', {
                          plan: b.planName,
                          ws: workspace,
                        })}
                  </small>
                </span>
              </label>
              {notice && (
                <label className={`co-chk co-radio ${kind === 'notice' ? 'on' : ''}`} data-testid="billing-cancel-notice">
                  <input type="radio" name="co-kind" checked={kind === 'notice'} onChange={() => setKind('notice')} disabled={cancel.isPending} />
                  <span className="co-chk-t">
                    {t('With one month’s notice')}
                    <small>
                      {t('{plan} ends on {date}; the time paid for after that, {amount}, goes back to your card once it has ended. Nothing is deleted.', {
                        plan: b.planName,
                        date: noticeEnds ?? '',
                        amount: refunded(notice.refund),
                      })}
                    </small>
                  </span>
                </label>
              )}
              <label className={`co-chk co-radio ${kind === 'extraordinary' ? 'on' : ''}`} data-testid="billing-cancel-extraordinary">
                <input type="radio" name="co-kind" checked={kind === 'extraordinary'} onChange={() => setKind('extraordinary')} disabled={cancel.isPending} />
                <span className="co-chk-t">
                  {t('For an important reason, at once')}
                  <small>{t('We look at the reason and answer by email. Until then the plan runs until the end of the period at the latest.')}</small>
                </span>
              </label>
            </div>
            {kind === 'extraordinary' && (
              <label className="co-f">
                <span className="co-l">{t('The reason')}</span>
                <textarea
                  id="co-reason"
                  className={`input co-in co-reason ${missing && reason.trim().length < 3 ? 'invalid' : ''}`}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setMissing(false);
                  }}
                  maxLength={500}
                  rows={3}
                  disabled={cancel.isPending}
                  data-testid="billing-cancel-reason"
                />
                {missing && reason.trim().length < 3 && (
                  <span className="bill-error" role="alert">
                    {t('Say the reason in a few words.')}
                  </span>
                )}
              </label>
            )}
          </section>
          {kind !== 'extraordinary' && (
            <section className="co-sec" aria-labelledby="co-free-h">
              <h3 id="co-free-h">
                <span className="co-n">2</span>
                {t('What Free would mean for {ws}', { ws: workspace })}
              </h3>
              <FitGrid usage={b.usage} />
            </section>
          )}
        </div>
        <Panel pad="lg" as="div" className="co-sum" aria-label={t('Your contract')} data-testid="billing-cancel-contract">
          <div className="co-plan">
            <span className="co-plan-t">
              <b>{b.planName}</b>
              <span>{price ? (price.interval === 'year' ? t('Billed yearly') : t('Billed monthly')) : workspace}</span>
            </span>
          </div>
          <dl className="co-facts one">
            {fact(t('Workspace'), workspace)}
            {fact(t('Cancelled by'), me ? `${me.name} · ${me.email}` : '—')}
            {fact(
              t('Ends'),
              kind === 'notice'
                ? (noticeEnds ?? '—')
                : kind === 'ordinary'
                  ? (ends ?? t('At the end of the period'))
                  : t('Once we confirm the reason; {date} at the latest', { date: ends ?? '—' }),
            )}
            {/* where a refund is possible its row is there for every way, so choosing one doesn't move the button */}
            {notice &&
              fact(
                t('Refund'),
                kind === 'notice'
                  ? t('{amount} for {days} of {of} days', { amount: refunded(notice.refund), days: notice.refund.days, of: notice.refund.of })
                  : kind === 'ordinary'
                    ? t('None')
                    : '—',
              )}
            {fact(t('Confirmation to'), me?.email ?? '—')}
          </dl>
          {error && (
            <p className="bill-error" role="alert" data-testid="billing-cancel-error">
              {error}
            </p>
          )}
          <div className="co-go">
            <button type="button" className="btn danger-fill lg wide" onClick={go} disabled={cancel.isPending} data-testid="billing-cancel-now">
              {cancel.isPending && <Spinner />}
              {t('Cancel now')}
            </button>
            <p className="co-safe">{t('Changed your mind later? Keep {plan} in Billing until it ends.', { plan: b.planName })}</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Received: calm, what and when, the confirmation on its way, the way back. */
function Done({ b, workspace, email, done }: { b: BillingInfo; workspace: string; email: string | null; done: Received }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus({ preventScroll: true }), []);
  const fact = (dt: string, dd: ReactNode) => (
    <div>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </div>
  );
  return (
    <div className="co page done" data-testid="billing-cancel-done">
      <Panel pad="lg" className="co-paid" aria-labelledby="co-cancelled-h">
        <div className="co-paid-h" role="status">
          <KeyGlyph shape="diamond" size={16} className="ok" pop />
          <h2 id="co-cancelled-h" ref={head} tabIndex={-1}>
            {t('Your cancellation is received')}
          </h2>
        </div>
        <p className="co-paid-l">
          {done.kind === 'extraordinary'
            ? t('We look at your reason and answer by email. Until then {plan} runs until {date} at the latest.', {
                plan: b.planName,
                date: done.endsAt ? dayOf(done.endsAt, { year: true }) : '—',
              })
            : done.kind === 'notice'
              ? t('With one month’s notice, {plan} for {ws} ends on {date}; then {ws} moves to Free. Nothing is deleted.', {
                  plan: b.planName,
                  ws: workspace,
                  date: done.endsAt ? dayOf(done.endsAt, { year: true }) : '—',
                })
              : t('{plan} for {ws} ends on {date}; then {ws} moves to Free. Nothing is deleted.', {
                  plan: b.planName,
                  ws: workspace,
                  date: done.endsAt ? dayOf(done.endsAt, { year: true }) : '—',
                })}
        </p>
        <dl className="co-facts">
          {fact(t('Received'), stamp(done.receivedAt))}
          {fact(t('Ends'), done.endsAt ? dayOf(done.endsAt, { year: true }) : '—')}
          {done.refund
            ? fact(t('Refund'), refunded(done.refund))
            : fact(t('How'), done.kind === 'extraordinary' ? t('For an important reason') : t('At the end of the period'))}
          {fact(t('Confirmation to'), email ?? '—')}
        </dl>
        {done.refund && (
          <p className="co-fine" data-testid="billing-cancel-refund">
            {t('{amount} for {days} of the {of} days paid for goes back to the card the plan was paid with once it has ended, with a credit note.', {
              amount: refunded(done.refund),
              days: done.refund.days,
              of: done.refund.of,
            })}
          </p>
        )}
        {email && <p className="co-fine">{t('The confirmation is on its way to {email}.', { email })}</p>}
        <div className="co-paid-acts">
          <a className="btn lg" href="#/settings/billing" data-testid="billing-cancel-see-billing">
            {t('Back to Billing')}
          </a>
        </div>
      </Panel>
    </div>
  );
}
