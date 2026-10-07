// Back from paying (a bank's page, the checkout's own return): Settings → Billing thanks for a payment the address
// names only in the tab that started one. An address alone is anyone's to send: "the invoice is paid" on this app's
// own page must never come from a link.
const KEY = 'vr.billing.paying';
/** How long a payment started here may take to come back (a bank's page, a slow approval). */
const WITHIN_MS = 3_600_000;

/** Right before a payment or a card is confirmed: this tab started one. */
export function payingHere(): void {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {}
}

/** Whether this tab started a payment within the hour. */
export function startedHere(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(KEY));
    return at > 0 && now - at < WITHIN_MS;
  } catch {
    return false;
  }
}

/** Its return was shown: the next address that names one is a link's again. */
export function returnedHere(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

/** What an address says on arrival: `?checkout=<state>`, `?method=done`, `?paid=done`; null for anything else. */
export function askedReturn(hash: string): string | null {
  const p = new URLSearchParams(hash.split('?')[1] ?? '');
  const checkout = p.get('checkout');
  if (checkout) return checkout === 'done' || checkout === 'cancelled' ? checkout : null;
  if (p.get('method') === 'done') return 'method';
  if (p.get('paid') === 'done') return 'paid';
  return null;
}

/** The return to show: what the address says, when this tab started a payment. */
export const returnOf = (hash: string, started: boolean): string | null => (started ? askedReturn(hash) : null);
