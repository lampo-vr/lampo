// Whether the inbox is open and which item is in its preview. Kept outside the bell: a top bar that swaps its layout
// at the phone breakpoint (a resized window, a turned tablet) mounts a new bell, and the inbox stays where it was.
import { useSyncExternalStore } from 'react';

export interface InboxState {
  open: boolean;
  picked: string | null;
}

let state: InboxState = { open: false, picked: null };
const subs = new Set<() => void>();

export function setInbox(next: Partial<InboxState>) {
  state = { ...state, ...next };
  // Opened again, it starts from the list.
  if (!state.open) state.picked = null;
  for (const f of subs) f();
}

// Anything that navigates (a link in the inbox, the browser's back button) puts it away.
window.addEventListener('hashchange', () => {
  if (state.open) setInbox({ open: false });
});

export function useInbox(): InboxState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
    () => state,
  );
}
