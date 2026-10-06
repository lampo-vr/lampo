// Notes and replies deleted a moment ago: off the screen at once, deleted on the server only when their Undo toast is
// gone (later() in lib/toast.ts). Views that list them leave these out.
import { useSyncExternalStore } from 'react';

function hiddenSet() {
  let hidden: ReadonlySet<string> = new Set();
  const subs = new Set<() => void>();
  const set = (next: Set<string>) => {
    hidden = next;
    for (const f of subs) f();
  };
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  };
  return {
    hide: (key: string) => set(new Set(hidden).add(key)),
    show: (key: string) => {
      const next = new Set(hidden);
      next.delete(key);
      set(next);
    },
    use: () => useSyncExternalStore(subscribe, () => hidden),
  };
}

const notes = hiddenSet();
export const hideNote = notes.hide;
export const showNote = notes.show;
export const useHiddenNotes = notes.use;

/** A reply by its note, author and time (replies have no ids: lib/store.ts replyAt). */
export const replyKey = (noteId: string, r: { by: string; at: string }) => `${noteId} ${r.by} ${r.at}`;
const replies = hiddenSet();
export const hideReply = replies.hide;
export const showReply = replies.show;
export const useHiddenReplies = replies.use;
