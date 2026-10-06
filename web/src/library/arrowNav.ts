// Arrow keys between the library's items (cards, rows, board cards: whatever carries `data-nav`), in any layout:
// left/right go to the previous/next item, up/down to the nearest item in the row above or below.
import type { KeyboardEvent } from 'react';

const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function below(items: HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | undefined {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best: HTMLElement | undefined;
  let score = Number.POSITIVE_INFINITY;
  for (const el of items) {
    const b = el.getBoundingClientRect();
    const dy = down ? b.top - r.bottom : r.top - b.bottom;
    if (dy < -1) continue;
    // The nearest row first, then the nearest column in it.
    const s = Math.round(dy) * 10_000 + Math.abs(b.left + b.width / 2 - cx);
    if (s < score) {
      score = s;
      best = el;
    }
  }
  return best;
}

export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  if (!KEYS.has(e.key) || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const from = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
  if (!from || !e.currentTarget.contains(from)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const i = items.indexOf(from);
  const to = e.key === 'ArrowLeft' ? items[i - 1] : e.key === 'ArrowRight' ? items[i + 1] : below(items, from, e.key === 'ArrowDown');
  if (!to) return;
  e.preventDefault();
  to.focus();
  to.scrollIntoView({ block: 'nearest' });
}
