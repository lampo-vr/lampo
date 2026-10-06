// The theme choice without its switch: the account menu's group and the palette's command need only this, so the
// library's first paint doesn't carry the switch (ThemeSwitch.tsx, which re-exports these).
import { useQueryClient } from '@tanstack/react-query';
import { authKeys, useUpdateMe } from '../api/auth.ts';
import type { AuthStatus } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { setThemePref, type ThemePref, useThemePref } from '../lib/theme.ts';
import type { IconName } from './icons.tsx';
import type { MenuChoice } from './primitives.tsx';

export const OPTIONS = perLang((): { value: ThemePref; label: string; icon: IconName }[] => [
  { value: 'light', label: t('Light'), icon: 'sun' },
  { value: 'dark', label: t('Dark'), icon: 'moon' },
  { value: 'system', label: t('System'), icon: 'system' },
]);

/** Picks a theme for this device and, signed in, for the account (the switch, the menu, the command palette). */
export function useChooseTheme() {
  const qc = useQueryClient();
  const update = useUpdateMe();
  return (p: ThemePref) => {
    setThemePref(p);
    // Only a signed-in account has somewhere to keep it; guest pages never load the account at all.
    const user = qc.getQueryData<AuthStatus>(authKeys.status)?.user;
    if (!user || user.prefs?.theme === p) return;
    qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s?.user ? { ...s, user: { ...s.user, prefs: { ...s.user.prefs, theme: p } } } : s));
    // The device already shows the choice; if the account can't store it now, the next pick tries again.
    update.mutate({ prefs: { theme: p } });
  };
}

/** The same choice as radio items inside a Menu (an entry of its items); the menu stays open to show the result. */
export function useThemeChoice(): MenuChoice {
  const pref = useThemePref();
  const choose = useChooseTheme();
  return { choice: { label: t('Theme'), value: pref, options: OPTIONS(), onChange: (v) => choose(v as ThemePref) } };
}
