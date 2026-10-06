import type { KeyboardEvent, MouseEvent } from 'react';

// Click handler for a card that holds its own controls: ignores clicks that start in those controls, and clicks
// from portalled menus and dialogs (React bubbles their events through the component tree; the DOM does not).
export function cardClick(fn: (e: MouseEvent<HTMLElement>) => void, controls: string) {
  return (e: MouseEvent<HTMLElement>) => {
    const t = e.target as Element;
    if (!e.currentTarget.contains(t)) return;
    const hit = t.closest(controls);
    if (hit && e.currentTarget.contains(hit)) return;
    fn(e);
  };
}

// Keyboard activation for a focusable card: Enter for link-like cards, Enter or Space for button-like ones.
export function onActivate(fn: () => void, keys: string[] = ['Enter']) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !keys.includes(e.key)) return;
    e.preventDefault();
    fn();
  };
}
