// Media queries as React state. The layout breakpoints live here and in styles/mobile.css, and must agree:
//   phone   < 640 px wide, or a landscape phone (short and touch-only)
//   tablet  640–1024 px
//   desktop above; its DOM and CSS never change for the phone layout.
import { useSyncExternalStore } from 'react';

export const PHONE = '(max-width: 639px), (max-height: 480px) and (hover: none) and (pointer: coarse)';
export const TOUCH = '(hover: none) and (pointer: coarse)';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The phone layout: compact header, bottom sheet for notes, thumb-sized transport. */
export const usePhone = () => useMedia(PHONE);
/** A finger, not a mouse: bigger hit areas, no hover-only controls. */
export const useTouch = () => useMedia(TOUCH);
