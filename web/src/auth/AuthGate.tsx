// Before the app talks to the server: local mode goes straight in; a hosted server shows setup (no account yet) or
// sign-in. A 401 later (session expired, signed out elsewhere) brings sign-in back over the same route, so after
// signing in you are where you were.
import { useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useRef } from 'react';
import { isGated } from '../../../lib/gate.ts';
import { afterSignOut, authKeys, bindAuthChannel, SAVING_ME, useAuthStatus } from '../api/auth.ts';
import { UNAUTHORIZED } from '../api/client.ts';
import { startEvents } from '../api/events.ts';
import { keptFromBefore } from '../api/persist.ts';
import type { AuthStatus } from '../api/types.ts';
import { langPref, setLangPref, t } from '../i18n/index.ts';
import { rememberRole } from '../lib/chromeHint.ts';
import { setThemePref } from '../lib/theme.ts';
import { Button, EmptyState } from '../ui/system.tsx';

// Only a hosted server ever needs these screens; local mode never downloads them.
const SignInScreen = lazy(() => import('./AuthScreens.tsx').then((m) => ({ default: m.SignInScreen })));
const SetupScreen = lazy(() => import('./AuthScreens.tsx').then((m) => ({ default: m.SetupScreen })));
// A sign-up waiting for its address to be confirmed: "Check your inbox" (the server lets it reach nothing else).
const HeldScreen = lazy(() => import('./AccountScreens.tsx').then((m) => ({ default: m.HeldScreen })));

// The sign-in screen's code is on its way: an empty page (it is quick, and a skeleton of the app would be a lie).
const waiting = <div className="page" />;

/** `loading`: what shows until the server says who you are (the skeleton of the screen you are going to). */
export function AuthGate({ children, loading = waiting }: { children: ReactNode; loading?: ReactNode }) {
  const qc = useQueryClient();
  const { data, error, refetch, dataUpdatedAt } = useAuthStatus();
  const lost = useRef(false);
  useEffect(() => bindAuthChannel(qc), [qc]);
  // The server is out of reach (restarting, the network gone): ask again every few seconds, so the page comes back
  // by itself; "Try again" only asks sooner.
  useEffect(() => {
    if (!error) return;
    const id = setInterval(() => refetch(), 4000);
    return () => clearInterval(id);
  }, [error, refetch]);
  useEffect(() => {
    const signedOut = () => {
      const s = qc.getQueryData<AuthStatus>(authKeys.status);
      // Signed in automatically at the machine itself: a 401 there is a real error, not a lost session.
      if (!s?.user || s.via === 'local') return;
      lost.current = true;
      // The session ended elsewhere (signed out everywhere, a new password, run out): nothing of the account stays in
      // this browser either — its kept data, its Recent, the other tabs' screens.
      afterSignOut(qc);
    };
    window.addEventListener(UNAUTHORIZED, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED, signedOut);
  }, [qc]);
  // The account's theme and language win over this device's: they are the choice the person made last, wherever they
  // made it. Followed when the account's choice changes, as the server says it now: a status kept from an earlier visit
  // (api/persist.ts) can predate a choice made here since — following it would switch the page back, then forward again
  // when the server answers — and so can one answered while this device's own choice is being saved. (Read as it
  // renders: a status that arrives renders this again, and the save's own answer is the last to arrive.)
  const saving = qc.isMutating({ mutationKey: SAVING_ME }) > 0;
  const heard = !!data && !saving && !keptFromBefore(dataUpdatedAt);
  const accountTheme = data?.user?.prefs?.theme;
  const accountLang = data?.user?.prefs?.lang;
  const followed = useRef<{ theme?: string; lang?: string }>({});
  useEffect(() => {
    if (!heard) return;
    if (accountTheme && accountTheme !== followed.current.theme) setThemePref(accountTheme);
    // The language switches in place (i18n/index.ts); a failed load leaves the page as it is, the next start tries again.
    if (accountLang && accountLang !== followed.current.lang && accountLang !== langPref()) setLangPref(accountLang).catch(() => {});
    followed.current = { theme: accountTheme, lang: accountLang };
  }, [heard, accountTheme, accountLang]);
  // Remembered for the next first paint (lib/chromeHint.ts), with whether the first run shows.
  const role = data?.user?.role;
  const firstRun = !!data?.user?.prefs?.onboarding && !data.user.prefs.onboarding.hidden;
  useEffect(() => {
    if (role) rememberRole(role, firstRun);
  }, [role, firstRun]);
  const held = isGated(data?.user);
  const allowed = !!data?.user && !held;
  useEffect(() => {
    if (allowed) startEvents();
  }, [allowed]);

  if (error)
    return (
      <main className="app-down">
        <EmptyState
          art="error"
          titleAs="h1"
          title={t('The server doesn’t answer')}
          action={
            <Button variant="primary" icon="refresh" onClick={() => refetch()}>
              {t('Try again')}
            </Button>
          }
        >
          {t('Lampo keeps trying on its own; this page comes back by itself when the server does.')}
        </EmptyState>
      </main>
    );
  if (!data) return loading;
  if (allowed) return children;
  return <Suspense fallback={waiting}>{held ? <HeldScreen /> : data.setup ? <SetupScreen /> : <SignInScreen resumed={lost.current} />}</Suspense>;
}
