// The phone player's room (mobile.css "player"): the picture, the dock and the notes sheet share one screen. Two things
// change that room from outside the layout: the on-screen keyboard, and the sheet's own motion between peek, half and
// full, which hides or brings back the rows above it.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMedia } from '../lib/media.ts';

/** How much the visible area must lose to be a keyboard, not a browser bar sliding away. */
const KEYBOARD_PX = 120;

/** A phone held sideways (lib/media.ts PHONE's second half, turned): the player is a page that scrolls (mobile.css
 * "landscape phones"), which the browser scrolls to a field itself, and has no sheet that moves. */
const SIDEWAYS = '(max-height: 480px) and (hover: none) and (pointer: coarse) and (orientation: landscape)';
export const useSideways = () => useMedia(SIDEWAYS);

/**
 * Whether the on-screen keyboard is up, and while it is, the visible area as CSS variables on the document (`--vv-h`,
 * `--vv-top`, in px): the phone player fits itself into them (mobile.css `.phone-player.kb`). A keyboard shrinks the
 * visual viewport and leaves the page's layout as it was (iOS Safari, Chrome on Android): what sat at the bottom — the
 * composer's text and Send — was under it, and the browser panned the page to the field. Where a browser shrinks the
 * page instead (Firefox on Android), the window gets shorter than it was at this width. Zoomed in (a pinch), nothing is a
 * keyboard. The variables are written on every move without a render; only up and down render.
 */
export function useKeyboard(on: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!on || !vv) {
      setUp(false);
      return;
    }
    let width = 0;
    let tallest = 0;
    let shown = false;
    const read = () => {
      // a turn of the phone: its height is measured afresh
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = 0;
      }
      tallest = Math.max(tallest, window.innerHeight, vv.height);
      const zoomed = Math.abs(vv.scale - 1) > 0.01;
      const now = !zoomed && vv.height < tallest - KEYBOARD_PX;
      if (now) {
        root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
        root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
      }
      if (now !== shown) {
        shown = now;
        setUp(now);
        // the field being typed in stays in view in the room that is left
        if (now) requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' }));
      }
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    window.addEventListener('resize', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-top');
    };
  }, [on]);
  return on && up;
}

/**
 * The sheet takes room from the picture, never covers it: opening it hides the rows above it (half the secondary ones,
 * full the dock), closing brings them back. Those rows go at once while the sheet's height moves, so the picture first
 * jumped by their height and then moved the other way (opening: it grew 45 px, then shrank). Each time `state` changes,
 * the sheet starts its move at the height that keeps the picture where it was, so its own motion is the only one. The
 * picture is the stage less what it keeps free (`kept`: a phone's drawing strip, which comes with the composer).
 */
export function useStillPicture(main: RefObject<HTMLElement | null>, state: string, on: boolean, kept: number) {
  const keptNow = useRef(kept);
  keptNow.current = kept;
  // the picture's room before the change: what a ResizeObserver last saw, read before it hears of the change
  const before = useRef<number | null>(null);
  useEffect(() => {
    const stage = on ? main.current?.querySelector<HTMLElement>(':scope > .stage') : null;
    if (!stage) return;
    const read = () => {
      before.current = stage.getBoundingClientRect().height - keptNow.current;
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [main, on]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the room changes (state), with the DOM it changed
  useLayoutEffect(() => {
    const el = main.current;
    const stage = el?.querySelector<HTMLElement>(':scope > .stage');
    const sheet = el?.querySelector<HTMLElement>(':scope > .nsheet');
    const was = before.current;
    if (!on || !stage || !sheet || was === null) return;
    // reduced motion: nothing moves, the room changes at once
    if (Number.parseFloat(getComputedStyle(sheet).transitionDuration) === 0) return;
    const jump = stage.getBoundingClientRect().height - kept - was;
    if (Math.abs(jump) < 1) return;
    const from = sheet.getBoundingClientRect().height + jump;
    sheet.style.transition = 'none';
    sheet.style.height = `${Math.max(0, from)}px`;
    void sheet.offsetHeight;
    sheet.style.transition = '';
    sheet.style.height = '';
  }, [state, on]);
}
