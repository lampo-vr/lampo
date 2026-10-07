// A billing provider's routes (a module, server/extension.ts), as Settings → Billing and the banner use them. Only on a
// server whose /api/info says `billing`: without a provider none of this is asked for. Nothing here leaves the app:
// paying, payment methods, billing details and invoices are all on the page (the payment forms in billing/Pay.tsx).
// The plan itself is `useBilling` (api/queries.ts): the banner reads it from there.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingAccount, BillingAddress, BillingCancelled, BillingCancelOptions, BillingPreview, BillingSecret } from '../../../lib/types.ts';
import { ApiError, api } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import { toast, toastError } from '../lib/toast.ts';
import { billingSaid } from './words.ts';

export interface PlanChoice {
  plan: string;
  interval: 'month' | 'year';
  currency?: string;
  /** `full`: Stripe's address form on the page (Settings → Billing); `card`: card and country only (a limit sheet). */
  form?: 'full' | 'card';
}

/** A billing refusal as a toast in the page's language (billingSaid); a plan's limit (402) still opens its sheet. */
export function toastRefusal(e: unknown): void {
  if (e instanceof ApiError && e.status === 402) toastError(e);
  else toast(billingSaid(e), 'error');
}

/** Under the plan's key: whatever changes the plan refreshes the account too, and the other way round. */
const accountKey = [...keys.billing, 'account'] as const;

/** The billing account's details, payment methods and invoices (owners and admins, once a plan was paid for). */
export const useBillingAccount = (enabled: boolean) =>
  useQuery({ queryKey: accountKey, queryFn: () => api<BillingAccount>('/api/billing/account'), enabled, staleTime: 30_000 });

/** After a change the provider confirms a moment later: the plan and the account again. */
function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.billing });
}

/** A checkout for a plan: its client secret, for the payment form on this page. */
export const useCheckout = () => useMutation({ mutationFn: (c: PlanChoice) => api<BillingSecret>('/api/billing/checkout', { method: 'POST', body: c }) });

/**
 * What the buyer agreed to, recorded right before the order goes to the provider (A13 CLOUD-2): as a consumer (with the
 * express request to start at once, § 356(4) / § 357a BGB) or as a business — with its VAT ID for the invoice where the
 * checkout offers no reverse charge (the provider puts it on the invoices).
 */
export const useOrderConsent = () =>
  useMutation({
    mutationFn: (c: { buyer: 'consumer' | 'business'; start: boolean; vatId?: string }) => api('/api/billing/checkout/consent', { method: 'POST', body: c }),
  });

/** What a plan change will put on the next invoice (nothing changes yet). */
export const usePlanPreview = () =>
  useMutation({
    mutationFn: (c: PlanChoice) => api<BillingPreview>('/api/billing/plan/preview', { method: 'POST', body: { plan: c.plan, interval: c.interval } }),
  });

/** Another plan or interval for a running subscription (the provider confirms it a moment later). */
export function useChangePlan() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (c: PlanChoice) => api('/api/billing/plan', { method: 'POST', body: { plan: c.plan, interval: c.interval } }),
    onSettled: refresh,
  });
}

/**
 * "Cancel contracts here" (§ 312k BGB): ordinary at the period's end, for an important reason (said in a line), or with
 * one month's notice where the provider offers it (`useCancelOptions`). The provider confirms it by email at once and
 * answers when it was received, when the plan ends and, with notice, what is refunded.
 */
export function useCancelContract() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (c: { kind: 'ordinary' | 'extraordinary' | 'notice'; reason?: string }) =>
      api<BillingCancelled>('/api/billing/cancel', { method: 'POST', body: c }),
    onSettled: refresh,
  });
}

/**
 * How the plan may be cancelled today beyond the two ways every plan has: a consumer's yearly plan after its first year
 * with one month's notice, the end and the refund (the provider's answer; asked when the cancel step opens, never kept:
 * the notice runs from the day it is given).
 */
export const useCancelOptions = (enabled: boolean) =>
  useQuery({
    queryKey: [...keys.billing, 'cancel'] as const,
    queryFn: () => api<BillingCancelOptions>('/api/billing/cancel'),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

/** Cancel at the end of the paid period, or keep the plan after all. */
export function useCancel() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (cancel: boolean) => api(cancel ? '/api/billing/cancel' : '/api/billing/resume', { method: 'POST' }), onSettled: refresh });
}

/** A new payment method: the client secret of a setup, for the payment form. */
export const useNewMethod = () => useMutation({ mutationFn: () => api<BillingSecret>('/api/billing/payment-method', { method: 'POST' }) });

/** The oldest open invoice, to pay on the page: its client secret and amount. */
export const usePayInvoice = () => useMutation({ mutationFn: () => api<BillingSecret>('/api/billing/invoice/pay', { method: 'POST' }) });

/** Renewals are charged to this payment method from now on. */
export function useDefaultMethod() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: string) => api('/api/billing/payment-method/default', { method: 'POST', body: { id } }), onSettled: refresh });
}

export function useRemoveMethod() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: string) => api('/api/billing/payment-method/remove', { method: 'POST', body: { id } }), onSettled: refresh });
}

/** The name, email and address on the next invoices. */
export function useSaveDetails() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (d: { name: string; email?: string; address: BillingAddress }) => api('/api/billing/details', { method: 'POST', body: d }),
    onSettled: refresh,
  });
}

export function useAddTaxId() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (x: { type: string; value: string }) => api('/api/billing/tax-id', { method: 'POST', body: x }), onSettled: refresh });
}

export function useRemoveTaxId() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: string) => api('/api/billing/tax-id/remove', { method: 'POST', body: { id } }), onSettled: refresh });
}
