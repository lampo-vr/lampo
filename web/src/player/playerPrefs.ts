// The player's kept preferences (`vr.player`, the account's: lib/signedOut.ts clears them at sign-out). The safe zones
// and the phone view are two choices: `preset.<orientation>` is the zones drawn over the picture, `phoneApp` the app the
// phone view draws around it ('full' or an app's preset id). They used to be one — the phone's app was the vertical
// preset, and `zones` drew that preset's zones over the app on request — so prefs kept before the split are turned into
// the two once, keeping what the person saw (usePlayerPrefs.ts reads and writes them; this part is pure, for its test).
import type { Prefs } from '../lib/prefStore.ts';
import { presetById } from './zones.ts';

export const PLAYER_PREFS = 'vr.player';

/** The orientations whose preset could be an app: vertical videos, and square ones (presetsFor offers them the same). */
const APP_ORIENTS = ['vertical', 'square'] as const;
const isApp = (id: unknown) => !!presetById(id).app;

/**
 * What to write to prefs kept before the split (undefined drops a key), or null once they have a `phoneApp`.
 * - The phone view on with an app: the phone keeps that app; the zones stay on it only if they were shown over it
 *   (`zones`), else that orientation's zones go off — the app without the stripes, as before.
 * - The phone view off, or on at full height: nothing the person sees changes (the phone shows the full height).
 * A vertical video's choice decides the phone's app; a square one's only where no vertical one was ever made.
 */
export function upgradePlayerPrefs(p: Prefs): Prefs | null {
  if (p.phoneApp !== undefined) return null;
  const patch: Prefs = { phoneApp: 'full' };
  if (p.zones !== undefined) patch.zones = undefined;
  if (p.phone !== true) return patch;
  const shown = p['preset.vertical'] !== undefined ? p['preset.vertical'] : p['preset.square'];
  if (isApp(shown)) patch.phoneApp = String(shown);
  if (p.zones !== true) for (const o of APP_ORIENTS) if (isApp(p[`preset.${o}`])) patch[`preset.${o}`] = 'none';
  return patch;
}
