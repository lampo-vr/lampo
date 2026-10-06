// What only informs (a reply to your note, a new version that is in, a client's note, an approval) is seen once it stayed
// open in the preview — opened by a click or the keys, not shown by itself on arrival — for a moment while the page was
// in view: it leaves the list when the preview moves on or closes,
// like mail that is read — no "Got it" needed. Skimming past with the keys sees nothing, and work (a question, a fix to
// check, a version to review) only leaves when it is done. A stalled video asks for a nudge, so it isn't "seen" either.
import { useEffect, useRef } from 'react';
import type { ForYouItem } from '../api/types.ts';
import { doneOf } from './group.ts';

/** How long an update stays open before it counts as seen. */
export const SEEN_MS = 1500;

export const informs = (i: ForYouItem): boolean => doneOf(i) === 'dismiss' && i.kind !== 'stalled';

/** Calls `seen(item)` when the open item changes (or the preview closes) after an update was open for SEEN_MS. */
export function useSeenWhenRead(open: ForYouItem | null, seen: (i: ForYouItem) => void): void {
  const cur = useRef<{ item: ForYouItem | null; seen: typeof seen }>({ item: open, seen });
  cur.current = { item: open, seen };
  const key = open && informs(open) ? open.key : null;
  useEffect(() => {
    const item = cur.current.item;
    if (!key || !item) return;
    let read = false;
    const timer = setTimeout(() => {
      read = document.visibilityState === 'visible';
    }, SEEN_MS);
    return () => {
      clearTimeout(timer);
      if (read) cur.current.seen(item);
    };
  }, [key]);
}
