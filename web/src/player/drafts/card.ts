// What every draft card in "Not sent yet" shares, the notes you saved (Unsent.tsx) and your recordings' (RecordUI.tsx):
// its own Send's key, and the room it gives back when it has been sent. Small and light: the recorder's chunk imports
// it without the holding area's.
import { type KeyboardEvent, useLayoutEffect, useRef } from 'react';

/** The key that sends the draft the focus is in. */
export const SEND_ONE_KEYS = '⌘↵';

/**
 * ⌘↵ (not ⇧: that one is Send all's) on a draft card sends that draft, and the keyboard goes on to the next draft's
 * words (else the one before), so a list can be read and sent one by one; a menu or field that took the key keeps it.
 */
export function sendOneKey(e: KeyboardEvent, send: () => boolean, card: HTMLElement | null): void {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented || e.repeat) return;
  e.preventDefault();
  if (!send() || !card) return;
  const cards = [...(card.closest('.unsent')?.querySelectorAll<HTMLElement>('.draft:not([data-going])') ?? [])];
  const i = cards.indexOf(card);
  const next = cards[i + 1] ?? cards[i - 1];
  const text = next?.querySelector<HTMLTextAreaElement>('textarea');
  if (!next || !text) return;
  text.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

/**
 * A card (or the whole holding area) that was sent holds its height as a number while it leaves, so its motion
 * (record.css `draft-leave`) can close the room to nothing: a height of `auto` can't be animated everywhere yet.
 */
export function useLeave<T extends HTMLElement>(leaving: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (leaving) el.style.height = `${el.getBoundingClientRect().height}px`;
    else el.style.removeProperty('height');
  }, [leaving]);
  return ref;
}
