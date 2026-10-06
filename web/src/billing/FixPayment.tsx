// A renewal that didn't go through, fixed in place (spec §7b–d): a sheet over Settings → Billing. Its head says what
// happened in our words (the provider's decline code, never its text), the amount, and when the provider tries the old
// card again; on the left what still works — the week of grace as a line, what keeps working after it, what waits —
// and the open invoice; on the right a new card through the provider's payment form, the amount due and Pay, the card
// paying renewals from then on. Paid, it says so: the plan goes on, the card renewals use, the invoice's PDF.
import { useEffect, useState } from 'react';
import type { BillingInfo, BillingSecret } from '../../../lib/types.ts';
import { locale, t } from '../i18n/index.ts';
import { useLoaded } from '../lib/lazy.ts';
import { errorMessage, toastError } from '../lib/toast.ts';
import { methodLabel, payForms } from '../settings/BillingAccount.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Modal } from '../ui/primitives.tsx';
import { useBillingAccount, useDefaultMethod, usePayInvoice } from './api.ts';
import { dayOf, money, whyFailed } from './words.ts';

const DAY = 86_400_000;

export function FixPayment({ b, onClose }: { b: BillingInfo; onClose: () => void }) {
  const pay = usePayInvoice();
  const def = useDefaultMethod();
  const { data: a } = useBillingAccount(true);
  const [secret, setSecret] = useState<BillingSecret | null>(null);
  const [failed, setFailed] = useState('');
  const [paid, setPaid] = useState<{ method: string | null } | null>(null);
  const forms = useLoaded(payForms);
  const ask = pay.mutateAsync;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the sheet opens
  useEffect(() => {
    payForms.load().catch(() => {});
    ask().then(setSecret, (e) => setFailed(errorMessage(e)));
  }, []);

  const f = b.failure;
  const currency = f?.currency ?? secret?.currency ?? b.currency ?? 'eur';
  const amount = f?.amount ?? secret?.amount;
  const total = amount !== undefined ? money(amount, currency, { cents: true }) : '';
  const invoice = a?.invoices.find((i) => (f ? i.number === f.invoice || i.id === f.invoice : i.status === 'open'));
  const failedOn = b.graceUntil ? new Date(Date.parse(b.graceUntil) - 7 * DAY).toISOString() : null;
  const retries = (f?.retryAt ?? []).filter((d) => Date.parse(d) > Date.now());
  const list = new Intl.ListFormat(locale(), { type: 'conjunction' });
  const email = a?.details.email;

  if (paid) {
    const m = paid.method ? a?.methods.find((x) => x.id === paid.method) : undefined;
    return (
      <Modal title={t('Paid. {plan} goes on.', { plan: b.planName })} onClose={onClose} width={520}>
        <div className="bill-fix-done" role="status" data-testid="billing-fix-done">
          <KeyGlyph shape="diamond" size={22} pop className="bill-ok" />
          <p>
            {m
              ? t('{amount} for {plan} is paid. Renewals use {method} from now on.', { amount: total, plan: b.planName, method: methodLabel(m) })
              : t('{amount} for {plan} is paid. Renewals use the new card from now on.', { amount: total, plan: b.planName })}
          </p>
          <div className="bill-fix-done-acts">
            <button type="button" className="btn bill-raised" onClick={onClose}>
              {t('Done')}
            </button>
            {invoice?.pdf && (
              <a className="btn-link" href={invoice.pdf} target="_blank" rel="noopener noreferrer" download>
                <I name="download" size={14} />
                {t('Invoice {number} (PDF)', { number: invoice.number ?? '' })}
              </a>
            )}
          </div>
          {email && <p className="bill-fine">{t('The receipt is on its way to {email}.', { email })}</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={f ? t('The renewal didn’t go through') : t('Pay the open invoice')}
      onClose={onClose}
      width={968}
      foot={
        <>
          <span className="bill-fix-room">
            <I name="info" size={14} />
            <span>
              {t('Rather pay by bank transfer?')}{' '}
              {invoice?.pdf ? (
                <a className="bill-u" href={invoice.pdf} target="_blank" rel="noopener noreferrer" download>
                  {t('Get the invoice as PDF')}
                </a>
              ) : (
                t('The invoice’s PDF is under Invoices.')
              )}
            </span>
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Not now')}
          </button>
        </>
      }
    >
      <div className="bill-fix" data-testid="billing-fix">
        {f && (
          <p className="bill-fix-lede">
            {f.method
              ? t('The renewal of {plan} for {amount} didn’t go through: {why}.', { plan: b.planName, amount: total, why: whyFailed(f.code, f.method) })
              : t('The renewal of {plan} for {amount} didn’t go through.', { plan: b.planName, amount: total })}{' '}
            {retries.length
              ? t('Stripe tries the old card again on {dates}; a new card settles it now.', { dates: list.format(retries.map((d) => dayOf(d))) })
              : t('A new card settles it now.')}
          </p>
        )}
        <div className="bill-fix-cols">
          <section className="bill-fix-works" aria-label={t('What still works')}>
            <p className="bill-k">{t('What still works')}</p>
            {failedOn && b.graceUntil && (
              <div className="bill-fix-tl" aria-hidden="true">
                <span className="bill-fix-pt">
                  <KeyGlyph shape="diamond" size={9} className="bill-must" />
                  <b>{dayOf(failedOn, { short: true })}</b>
                  <small>{t('renewal failed')}</small>
                </span>
                <span className="bill-fix-line">
                  <i style={{ inlineSize: `${Math.min(100, Math.max(4, ((Date.now() - Date.parse(failedOn)) / (7 * DAY)) * 100)).toFixed(0)}%` }} />
                  <em>{t('today')}</em>
                </span>
                <span className="bill-fix-pt end">
                  <KeyGlyph shape="outline" size={9} />
                  <b>{dayOf(b.graceUntil, { short: true })}</b>
                  <small>{t('read-only, if unpaid')}</small>
                </span>
              </div>
            )}
            <ul className="bill-fix-todo">
              {b.graceUntil && b.state === 'grace' && (
                <li>
                  <KeyGlyph shape="diamond" size={9} className="bill-ok" />
                  {t('Until {date}: everything, as it is', { date: dayOf(b.graceUntil) })}
                </li>
              )}
              <li>
                <KeyGlyph shape="diamond" size={9} className="bill-ok" />
                {b.state === 'grace'
                  ? t('After that, still: reviewing, notes, approvals, downloads and the review links you sent')
                  : t('Still: reviewing, notes, approvals, downloads and the review links you sent')}
              </li>
              <li className="wait">
                <KeyGlyph shape="outline" size={9} />
                {t('Paused until it’s paid: uploads, new versions, members and links')}
              </li>
            </ul>
            {(invoice || f) && (
              <div className="bill-fix-inv" data-testid="billing-fix-invoice">
                <I name="notes" size={14} />
                <span className="bill-fix-inv-t">
                  <b>{invoice?.number ?? f?.invoice}</b>
                  {invoice?.description && <small>{invoice.description}</small>}
                </span>
                <b>{total}</b>
                <span className="bill-tag bad">
                  <KeyGlyph shape="outline" size={8} />
                  {t('Open')}
                </span>
              </div>
            )}
            <p className="bill-fix-keep">
              <KeyGlyph shape="diamond" size={10} className="bill-ok" />
              {t('Nothing is deleted, ever, because of a payment.')}
            </p>
          </section>
          <section className="bill-fix-pay" aria-label={t('A new card')}>
            {failed ? (
              <p className="bill-err" role="alert">
                {failed}
              </p>
            ) : secret && forms && b.payments ? (
              <>
                <forms.IntentForm
                  publishableKey={b.payments.key}
                  clientSecret={secret.clientSecret}
                  kind="payment"
                  title={t('A new card')}
                  action={total ? t('Pay {amount}', { amount: total }) : t('Pay')}
                  onDone={async (method) => {
                    if (method) await def.mutateAsync(method).catch(toastError);
                    setPaid({ method });
                  }}
                  onCancel={onClose}
                >
                  {total && (
                    <dl className="bill-fix-sum">
                      {invoice?.description && (
                        <div>
                          <dt>{invoice.description}</dt>
                          <dd>{total}</dd>
                        </div>
                      )}
                      <div className="total">
                        <dt>{t('Due now')}</dt>
                        <dd>{total}</dd>
                      </div>
                    </dl>
                  )}
                </forms.IntentForm>
                <p className="bill-fine bill-fix-after">{t('This card pays renewals from now on.')}</p>
              </>
            ) : (
              <div className="bill-pay-loading" role="status">
                <Spinner /> {t('Loading the payment form')}
              </div>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
