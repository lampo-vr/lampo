// How the inbox reads — by video (the default) or by kind — remembered per device ("vr.inbox" `mode`). The list, the
// cards, the bell's popover and the phone's sheet all follow it.
import { useCallback } from 'react';
import { usePrefs } from '../lib/prefs.ts';
import type { InboxMode } from './group.ts';

const NO_TAB: readonly string[] = [];

export function useInboxMode(): [InboxMode, (m: InboxMode) => void] {
  const [prefs, setPref] = usePrefs('vr.inbox', NO_TAB);
  const set = useCallback((m: InboxMode) => setPref('mode', m), [setPref]);
  return [prefs.mode === 'kind' ? 'kind' : 'video', set];
}
