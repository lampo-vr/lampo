// `vr.player` as the player reads it (playerPrefs.ts): prefs kept before the safe zones and the phone view were two
// choices read as their upgrade at once, and are written so.
import { useEffect } from 'react';
import { usePrefs } from '../lib/prefs.ts';
import { PLAYER_PREFS, upgradePlayerPrefs } from './playerPrefs.ts';

export function usePlayerPrefs() {
  const [kept, setPref] = usePrefs(PLAYER_PREFS);
  useEffect(() => {
    const patch = upgradePlayerPrefs(kept);
    if (patch) for (const [k, v] of Object.entries(patch)) setPref(k, v);
  }, [kept, setPref]);
  const patch = upgradePlayerPrefs(kept);
  return [patch ? { ...kept, ...patch } : kept, setPref] as const;
}
