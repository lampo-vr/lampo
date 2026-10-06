// Stripe's elements on the billing pages (the checkout step, a new card, an open invoice), each in a box that keeps
// the element's exact room while it loads: slots of label and field, measured against real Stripe.js with our
// appearance (billing/stripe.ts), share one grid cell with the element's frame, so nothing moves when it arrives.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import type { StripeElement } from './stripe.ts';
import '../styles/checkout.css';

/** What one of Stripe's fields looks like while it loads: its label and its box, at the field's height. */
export interface Slot {
  label: string;
  /** Two boxes side by side (expiry + security code; the tax ID's type + number). */
  pair?: string;
  /** The pair stacks in a narrow box (Stripe's tax ID does below 450 px; the card's expiry and code never). */
  stack?: boolean;
}
/** Stripe's elements as they first draw (measured against real Stripe.js with our appearance): the room they get. */
// the address starts as one search field ("Address"); the rest unfolds once an address is picked or typed
export const ADDRESS: Slot[] = [{ label: 'Full name' }, { label: 'Country or region' }, { label: 'Address' }];
export const TAX_ID: Slot[] = [{ label: 'Business name' }, { label: 'Tax ID type', pair: 'VAT number', stack: true }];
export const CARD: Slot[] = [{ label: 'Card number' }, { label: 'Expiration date', pair: 'Security code' }];

/** Words for the slots' labels (Stripe's own come in its locale; these only hold the room until then). */
const slotWord = (w: string): string =>
  ({
    'Full name': t('Full name'),
    'Country or region': t('Country or region'),
    Address: t('Address'),
    'Business name': t('Business name'),
    'Tax ID type': t('Tax ID type'),
    'VAT number': t('VAT number'),
    'Card number': t('Card number'),
    'Expiration date': t('Expiration date'),
    'Security code': t('Security code'),
  })[w] ?? w;

function SlotField({ label }: { label: string }) {
  return (
    <span className="co-slot-f">
      <span className="co-slot-l">{slotWord(label)}</span>
      <span className="sk co-slot-box" />
    </span>
  );
}

/**
 * One of Stripe's elements, mounted into its own box, with its room held until it says it is ready: the slots and the
 * frame share one grid cell, so the box is as tall as the taller of the two and nothing below moves when the frame
 * arrives at the slots' height.
 */
export function Element({
  el,
  ready,
  slots,
  testid,
  terms,
}: {
  el: StripeElement | null;
  ready: boolean;
  slots: Slot[];
  testid: string;
  /** Stripe's terms line under the card: two lines on a checkout (three below 450 px), three on a setup or payment. */
  terms?: 'checkout' | 'intent';
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el && box.current) el.mount(box.current);
  }, [el]);
  // Stripe says ready a moment before its frame has its final height (the tax ID's rows dip, then grow back; real
  // Stripe.js resized again 240 ms later): the slots keep the room, unseen, until the frame has held one size for half
  // a second (two and a half at most)
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = box.current;
    if (!ready || !frame) return setSettled(false);
    let quiet = setTimeout(() => setSettled(true), 500);
    const atMost = setTimeout(() => setSettled(true), 2500);
    const watch = new ResizeObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(() => setSettled(true), 500);
    });
    watch.observe(frame);
    return () => {
      clearTimeout(quiet);
      clearTimeout(atMost);
      watch.disconnect();
    };
  }, [ready]);
  return (
    <div className={`co-el ${ready ? 'ready' : ''} ${ready && settled ? 'settled' : ''}`}>
      {!(ready && settled) && (
        <div className="co-slots" aria-hidden="true">
          {slots.map((s) =>
            s.pair ? (
              <span className={`co-slot-2 ${s.stack ? 'stack' : ''}`} key={s.label}>
                <SlotField label={s.label} />
                <SlotField label={s.pair} />
              </span>
            ) : (
              <SlotField key={s.label} label={s.label} />
            ),
          )}
          {terms && <span className={`sk co-slot-terms ${terms}`} />}
        </div>
      )}
      <div ref={box} className="co-el-frame" data-testid={testid} />
    </div>
  );
}
