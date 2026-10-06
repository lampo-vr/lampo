// English or Deutsch, in Settings only: the app is English for everyone unless someone chooses German there. Signed in
// on a hosted server the choice is saved on the account too (AuthGate adopts it on other devices). Choosing switches in
// place: the other language's words load while the page stays, then every word changes in one render (i18n/index.ts).
import { useQueryClient } from '@tanstack/react-query';
import { authKeys, useUpdateMe } from '../api/auth.ts';
import type { AuthStatus, LangPref } from '../api/types.ts';
import { preloadLang, setLangPref, t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { toast } from '../lib/toast.ts';
import { ToggleGroup, ToggleItem } from './toggle.tsx';

// Each language in its own words: someone who can't read the current one still finds theirs.
const LANGS = [
  { value: 'en', label: 'English', short: 'EN' },
  { value: 'de', label: 'Deutsch', short: 'DE' },
] as const;

/** Picks a language for this device and, signed in, for the account; the page switches to it in place. */
export function useChooseLang() {
  const qc = useQueryClient();
  const update = useUpdateMe();
  return (p: LangPref) => {
    // The words switch once they are here — at once, mostly: the pointer on the switch already asked for them. If they
    // don't arrive (offline, a new build), the page and this device stay as they were; the account keeps the choice, so
    // the next start brings it.
    setLangPref(p).catch(() => toast(t('The other language didn’t load. Try again.'), 'error'));
    // Only a signed-in account has somewhere to keep it. Its copy in the cache says it at once (so does the status kept
    // for the next start), a status still on its way is dropped, and AuthGate waits for the save: nothing switches back.
    const user = qc.getQueryData<AuthStatus>(authKeys.status)?.user;
    if (!user || user.prefs?.lang === p) return;
    void qc.cancelQueries({ queryKey: authKeys.status });
    qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s?.user ? { ...s, user: { ...s.user, prefs: { ...s.user.prefs, lang: p } } } : s));
    // If the account can't store it now, this device keeps it and the next pick tries again.
    update.mutate({ prefs: { lang: p } });
  };
}

/** English · Deutsch, for Settings. */
export function LangSwitch({ className = '' }: { labels?: boolean; className?: string }) {
  const choose = useChooseLang();
  const value = useLang();
  return (
    <ToggleGroup
      className={`seg lang-switch ${className}`}
      value={value}
      onValueChange={(v) => v !== value && choose(v as LangPref)}
      aria-label={t('Language')}
    >
      {LANGS.map((o) => (
        <ToggleItem
          key={o.value}
          value={o.value}
          className={value === o.value ? 'on' : ''}
          aria-label={o.label}
          lang={o.value}
          // The words are on their way before the click: the switch is then instant.
          onPointerEnter={() => preloadLang(o.value)}
          onFocus={() => preloadLang(o.value)}
        >
          {o.label}
        </ToggleItem>
      ))}
    </ToggleGroup>
  );
}
