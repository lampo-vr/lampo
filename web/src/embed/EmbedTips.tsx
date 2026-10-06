// The player's tooltips: what the app's buttons already say (IconButton, Tip: ui/tip.tsx keeps each one's words and key
// on its element), shown above the control under the pointer or the keyboard's focus, in the tooltips' material. The
// app's own layer is Radix (ui/layers.tsx), far more than a player in someone else's page should load for a word or two.
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tipOf, tipTarget } from '../ui/tip.tsx';

interface Shown {
  content: ReactNode;
  shortcut?: string;
  /** Where its middle stands, and the top of what it names, in the player's pixels. */
  x: number;
  y: number;
}

/** After this long under the pointer (a keyboard's focus shows it at once). */
const DELAY = 450;

export function EmbedTips({ root }: { root: RefObject<HTMLElement | null> }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pressed: Element | null = null;
    const show = (target: EventTarget | null, wait: number) => {
      clearTimeout(timer);
      const at = tipTarget(target);
      const note = at && tipOf(at);
      if (!at || !note || !el.contains(at) || at === pressed) return setShown(null);
      timer = setTimeout(() => {
        const r = at.getBoundingClientRect();
        const frame = el.getBoundingClientRect();
        setShown({ content: note.content, shortcut: note.shortcut, x: r.left + r.width / 2 - frame.left, y: r.top - frame.top });
      }, wait);
    };
    const hide = () => {
      clearTimeout(timer);
      setShown(null);
    };
    const over = (e: PointerEvent) => e.pointerType === 'mouse' && show(e.target, DELAY);
    const out = (e: PointerEvent) => {
      if (!tipTarget(e.relatedTarget)) pressed = null;
      if (tipTarget(e.target) !== tipTarget(e.relatedTarget)) hide();
    };
    // a click is an answer: the tip stays away until the pointer leaves the control
    const down = (e: PointerEvent) => {
      pressed = tipTarget(e.target);
      hide();
    };
    const focus = (e: FocusEvent) => (e.target as Element | null)?.matches?.(':focus-visible') && show(e.target, 0);
    el.addEventListener('pointerover', over);
    el.addEventListener('pointerout', out);
    el.addEventListener('pointerdown', down);
    el.addEventListener('focusin', focus);
    el.addEventListener('focusout', hide);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('pointerover', over);
      el.removeEventListener('pointerout', out);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('focusin', focus);
      el.removeEventListener('focusout', hide);
    };
  }, [root]);
  // kept inside the frame: its middle over the control, pushed in from an edge (before it paints)
  useLayoutEffect(() => {
    const tip = box.current;
    const frame = root.current;
    if (!shown || !tip || !frame) return;
    const half = tip.offsetWidth / 2;
    const room = frame.clientWidth;
    setX(Math.max(half + 6, Math.min(room - half - 6, shown.x)));
  }, [shown, root]);
  if (!shown) return null;
  return (
    <div ref={box} className="em-tip" role="tooltip" style={{ left: x || shown.x, top: shown.y }}>
      {shown.content}
      {shown.shortcut && <kbd className="em-tip-key">{shown.shortcut}</kbd>}
    </div>
  );
}
