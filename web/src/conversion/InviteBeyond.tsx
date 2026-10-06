// Inviting a teammate the plan has no room for, on a running subscription (a card on file): as soon as a valid address
// is typed and the plan's member limit is reached, the invite form says what brings them in — the plan that fits, its
// price for the people there will be, what grows with it, and what is due today (nothing: the difference goes on the
// next invoice, paid with the card on file) — and its button switches the plan, then sends the invite once the plan
// shows. Without a subscription the invite is refused (402) and the limit's sheet takes over (conversion/limits/).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { BillingInfo, BillingOffer, BillingPreview } from '../../../lib/types.ts';
import { api } from '../api/client.ts';
import { keys, useBilling, useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { I } from '../ui/icons.tsx';
import { bytesOf, currencyOf, monthTotal } from './facts.ts';
import { day, fitFor, money, nameFromAddress, size } from './limits/model.ts';
import { momentEvent } from './moments.ts';
import { cardLabel, previewMoney, previewSwitch, useCardOnFile } from './pay.tsx';
import '../styles/limits.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Beyond {
  b: BillingInfo;
  plan: BillingOffer;
  interval: 'month' | 'year';
  members: number;
  /** Who is invited, by first name ("Ben"), or null. */
  name: string | null;
}

/** The plan the invite needs, once a valid address is typed on a full plan with a card on file; else null. */
export function useBeyond(email: string, name: string): Beyond | null {
  const info = useInfo();
  const b = useBilling(!!info?.billing).data as BillingInfo | undefined;
  const valid = EMAIL.test(email.trim());
  const full = !!b && b.limits.members !== null && b.usage.members >= b.limits.members;
  const beyond = useMemo(() => {
    if (!b || !valid || !full || !b.manage || !b.subscribed || b.complimentary) return null;
    const fit = fitFor(b, { reason: 'members' }, 'members');
    if (fit.kind !== 'plan') return null;
    const first = name.trim().split(/\s+/)[0] || nameFromAddress(email.trim());
    return { b, plan: fit.offer, interval: b.interval ?? 'month', members: b.usage.members + 1, name: first || null };
  }, [b, valid, full, name, email]);
  // shown once per form, the first time it applies
  const shown = !!beyond;
  useEffect(() => {
    if (shown) momentEvent('shown', 'invite_beyond', 'users');
  }, [shown]);
  return beyond;
}

/** The button's words: switch and invite (the dialog's purpose: the orange one). */
export const beyondAction = (x: Beyond) =>
  x.name ? t('Switch to {plan} and invite {name}', { plan: x.plan.name, name: x.name }) : t('Switch to {plan} and send the invite', { plan: x.plan.name });

/** Switches the plan with the card on file and waits until it shows (the provider confirms a moment later). */
export function useSwitchPlan() {
  const qc = useQueryClient();
  return async (x: Beyond) => {
    momentEvent('used', 'invite_beyond', 'users');
    await api('/api/billing/plan', { method: 'POST', body: { plan: x.plan.plan, interval: x.interval } });
    for (let i = 0; i < 30; i++) {
      const b = await qc.fetchQuery({ queryKey: keys.billing, queryFn: () => api<BillingInfo>('/api/billing'), staleTime: 0 });
      if (b.plan === x.plan.plan && (b.limits.members === null || b.limits.members > b.usage.members)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
}

/** What brings them in, in the invite form: the plan, its price for the people there will be, and what is due today. */
export function BeyondLine({ x }: { x: Beyond }) {
  const { b, plan, interval, members } = x;
  const { card } = useCardOnFile(b);
  const [preview, setPreview] = useState<BillingPreview | null>(null);
  useEffect(() => {
    let live = true;
    void previewSwitch(plan.plan, interval).then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [plan.plan, interval]);
  const currency = currencyOf(b, plan);
  const now = monthTotal(plan, interval, members, currency);
  const yearly = monthTotal(plan, 'year', members, currency);
  const lacking = b.features?.insights === false || b.features?.roles === false || b.features?.webhooks === false;
  const who = x.name ?? t('them');
  const price =
    now === null
      ? ''
      : interval === 'month'
        ? t('{amount} a month for the {n} of you', { amount: money(now, currency), n: members })
        : t('{amount} a month for the {n} of you, billed yearly', { amount: money(now, currency), n: members });
  const grows =
    b.limits.bytes !== null
      ? lacking
        ? t('Storage grows from {from} to {to}, and roles, Insights and webhooks come with it.', {
            from: size(b.limits.bytes),
            to: size(bytesOf(plan, members)),
          })
        : t('Storage grows from {from} to {to}.', { from: size(b.limits.bytes), to: size(bytesOf(plan, members)) })
      : '';
  const prorated = previewMoney(preview);
  const when = preview?.date ? day(preview.date) : b.renewsAt ? day(b.renewsAt) : null;
  const paidWith = card ? cardLabel(card) : t('the card on file');
  const today =
    prorated && when
      ? t('Nothing. The difference for the rest of this period, {amount} plus VAT, is on the invoice of {date}, paid with {card} like {plan}.', {
          amount: prorated,
          date: when,
          card: paidWith,
          plan: b.planName,
        })
      : when
        ? t('Nothing. The difference for the rest of this period is on the invoice of {date}, plus VAT, paid with {card}.', { date: when, card: paidWith })
        : t('Nothing. The difference for the rest of this period is on the next invoice, plus VAT, paid with {card}.', { card: paidWith });
  return (
    <div className="lim-beyond" data-testid="invite-beyond" role="status">
      <I name="users" size={16} />
      <div>
        <b>
          {b.limits.members === 1
            ? t('{plan} is for one person.', { plan: b.planName })
            : t('{plan} holds {n} members.', { plan: b.planName, n: b.limits.members ?? 0 })}
        </b>
        <p>
          <T k={'{plan} brings {who} in: <0>{price}</0>.'} values={{ plan: plan.name, who, price }} tags={[(c) => <strong>{c}</strong>]} />
          {interval === 'month' && yearly !== null && ` ${t('({amount} a month billed yearly.)', { amount: money(yearly, currency) })}`} {grows}
        </p>
        <div className="lim-beyond-today">
          <span>{t('Today')}</span>
          <span>{today}</span>
        </div>
      </div>
    </div>
  );
}
