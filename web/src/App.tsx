import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAuthStatus } from './api/auth.ts';
import { useForYou } from './api/queries.ts';
import { AuthGate } from './auth/AuthGate.tsx';
import { workspacesCode } from './auth/workspacesCode.ts';
import { loader, screen, useIdle, useLoaded } from './lib/lazy.ts';
import { canonicalHash, isOldOpenNotes, parseRoute, type Route, rememberLibrary, takeWorkspace } from './lib/nav.ts';
import { storePref } from './lib/prefs.ts';
import { rememberOpened } from './lib/recent.ts';
import { transitionTo } from './lib/transition.ts';
import { LIBRARY_PER_TAB, LIBRARY_PREFS } from './library/model.ts';
import { PaletteHost } from './palette/PaletteHost.tsx';
import { setBadge } from './pwa/register.ts';
import { Shell } from './ui/shell.tsx';

// Each screen is its own chunk: a client opening a share link never downloads the owner's app, and the library
// shows before the player code has arrived (it is prefetched right after). A screen whose code is here renders at
// once (lib/lazy.ts): boot.tsx waits for the route's chunk before the first render, so the first paint is the screen.
const playerCode = loader(() => import('./player/Player.tsx'));
// (the library with the board's code when the board is its layout, the files' when it opens on them: Library.tsx firstChunks)
const libraryCode = loader(() => import('./library/Library.tsx').then((m) => m.firstChunks.then(() => m)));
const guestCode = loader(() => import('./guest/Guest.tsx'));
const Library = screen(libraryCode);
const Player = screen(playerCode);
const Guest = screen(guestCode);
// A new account's setup (#/welcome): its own chunk, like the screens an emailed link opens (the library sends a new
// account there first: Library.tsx).
const setupCode = loader(() => import('./onboarding/Setup.tsx'));
const Setup = screen(setupCode);
const InviteScreen = lazy(() => import('./auth/AuthScreens.tsx').then((m) => ({ default: m.InviteScreen })));
const ConsentScreen = lazy(() => import('./auth/AuthScreens.tsx').then((m) => ({ default: m.ConsentScreen })));
const OAuthErrorScreen = lazy(() => import('./auth/AuthScreens.tsx').then((m) => ({ default: m.OAuthErrorScreen })));
// What an emailed link (or "Forgot password?", "Create an account") opens: its own chunk, asked for only on these routes.
const accountCode = loader(() => import('./auth/AccountScreens.tsx'));
type Account = Awaited<ReturnType<typeof accountCode.load>>;
const accountScreen = <P extends object>(pick: (m: Account) => ComponentType<P>) =>
  screen(loader<{ default: ComponentType<P> }>(() => accountCode.load().then((m) => ({ default: pick(m) }))));
const SignUpScreen = accountScreen((m) => m.SignUpScreen);
const ForgotScreen = accountScreen((m) => m.ForgotScreen);
const ResetScreen = accountScreen((m) => m.ResetScreen);
const VerifyScreen = accountScreen((m) => m.VerifyScreen);
const PrintView = lazy(() => import('./share/PrintView.tsx'));
const Settings = lazy(() => import('./settings/Settings.tsx'));
const uploadTrayCode = loader(() => import('./uploads/UploadTray.tsx'));
// Dev and test builds only: a production build (LAMPO_STYLEGUIDE=0) drops the chunk altogether.
const Styleguide = __STYLEGUIDE__ ? lazy(() => import('./styleguide/Styleguide.tsx')) : null;

/** The code of the screen this start opens, asked for before the first render (boot.tsx) while the kept data loads;
 * the promise settles when it is here (or failed to come). */
export function preloadScreen(route: Route): Promise<unknown> {
  const code =
    route.name === 'library'
      ? libraryCode
      : route.name === 'player'
        ? playerCode
        : route.name === 'guest'
          ? guestCode
          : route.name === 'welcome'
            ? setupCode
            : null;
  return code ? code.load().catch(() => {}) : Promise.resolve();
}

// The app icon shows how much waits in the inbox (installed apps; kept current by the event stream).
function AppBadge() {
  const total = useForYou().data?.counts.total;
  useEffect(() => {
    if (total !== undefined) setBadge(total);
  }, [total]);
  return null;
}

// What the player opens goes first in the sidebar's Recent (lib/recent.ts): inside the gate, so only once someone is
// signed in; client links are another route and never get here.
function RememberOpened({ slug }: { slug: string }) {
  useEffect(() => rememberOpened(slug), [slug]);
  return null;
}

// Uploads keep going (and stay visible) while you move between screens. The tray's code comes after the first paint.
function ServerTray() {
  const UploadTray = useLoaded(uploadTrayCode, useIdle())?.default;
  return UploadTray ? <UploadTray /> : null;
}

// A link that names its workspace (a notification, a chat message, an agent's link): taken off the address before boot
// reads the route (it imports this module first), followed once signed in (InWorkspace).
const linked = takeWorkspace();

/** The screen waits while the session is in another workspace than the link's (Workspaces.tsx followLink). */
function InWorkspace({ id, loading, done, children }: { id: string | null; loading: ReactNode; done: (w: null) => void; children: ReactNode }) {
  const s = useAuthStatus().data;
  // (a status kept from a sign-in may not say where the session works: then the server is asked)
  const here = !id || !s?.user || s.workspace?.id === id;
  useEffect(() => {
    if (!here && id) void workspacesCode.load().then((m) => m.followLink(id, done));
  }, [here, id, done]);
  return here ? children : loading;
}

export default function App() {
  const [wanted, setWanted] = useState(linked);
  const [route, setRoute] = useState(() => parseRoute(location.hash, location.pathname));
  const current = useRef(route);
  const parsedFrom = useRef(location.hash);
  useEffect(() => {
    const f = () => {
      const w = takeWorkspace();
      if (w) setWanted(w);
      parsedFrom.current = location.hash;
      const next = parseRoute(location.hash, location.pathname);
      const prev = current.current;
      current.current = next;
      // The new screen must be on the page when the transition takes its "after" picture: render it synchronously.
      transitionTo(prev, next, () => flushSync(() => setRoute(next)));
    };
    window.addEventListener('hashchange', f);
    // a screen that moved the address in its first render (the library sending a new account to its setup) did so
    // before this listener was here
    if (location.hash !== parsedFrom.current) f();
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    // An old address (a notification sent before the inbox view, a bookmark) shows under the one the page has now.
    const canonical = canonicalHash(location.hash);
    // "Open notes" was a sidebar view: its videos are the ones being fixed, All videos on that lane
    if (isOldOpenNotes(location.hash)) storePref(LIBRARY_PREFS, 'lane', 'fixing', LIBRARY_PER_TAB);
    if (canonical) history.replaceState(history.state, '', canonical);
    if (route.name === 'library') rememberLibrary();
    // The status overview became the library's board: old links open it there.
    if (route.name === 'status') {
      storePref(LIBRARY_PREFS, 'layout', 'board');
      location.replace('#/');
    }
    if (route.name === 'styleguide' && !Styleguide) location.replace('#/');
  }, [route]);
  // The screen you most likely go to next is fetched once the browser is idle: the player from the library, and back.
  useEffect(() => {
    const next = route.name === 'library' ? playerCode : route.name === 'player' ? libraryCode : null;
    if (!next) return;
    const load = () => void next.load().catch(() => {});
    // Safari has no requestIdleCallback: a moment after the screen settled will do.
    if (typeof requestIdleCallback !== 'function') {
      const t = setTimeout(load, 800);
      return () => clearTimeout(t);
    }
    const id = requestIdleCallback(load);
    return () => cancelIdleCallback(id);
  }, [route.name]);
  const fallback = skeletonFor(route);
  return (
    <Shell>
      {route.name === 'styleguide' ? (
        // Shows the building blocks only, no data: no sign-in.
        Styleguide && (
          <Suspense fallback={null}>
            <Styleguide />
          </Suspense>
        )
      ) : route.name === 'guest' ? (
        // Client links never need an account: they carry their own token.
        <Suspense fallback={fallback}>
          <Guest token={route.token} />
        </Suspense>
      ) : route.name === 'invite' ? (
        // An invite is how someone without an account gets one: it can't sit behind the sign-in screen.
        <Suspense fallback={fallback}>
          <InviteScreen token={route.token} />
        </Suspense>
      ) : route.name === 'signup' || route.name === 'forgot' || route.name === 'reset' || route.name === 'verify' ? (
        // So are the screens an email's link opens, and the ways to one from the sign-in screen.
        <Suspense fallback={fallback}>
          {route.name === 'signup' ? (
            <SignUpScreen />
          ) : route.name === 'forgot' ? (
            <ForgotScreen />
          ) : route.name === 'reset' ? (
            <ResetScreen key={route.token} token={route.token} />
          ) : (
            <VerifyScreen key={route.token} token={route.token} />
          )}
        </Suspense>
      ) : route.name === 'oauth-error' ? (
        <Suspense fallback={fallback}>
          <OAuthErrorScreen error={route.error} />
        </Suspense>
      ) : route.name === 'oauth' ? (
        // An app asking to connect: sign in first if needed (the gate), then decide.
        <AuthGate loading={fallback}>
          <Suspense fallback={fallback}>
            <ConsentScreen request={route.request} />
          </Suspense>
        </AuthGate>
      ) : (
        <AuthGate loading={fallback}>
          <InWorkspace id={wanted} loading={fallback} done={setWanted}>
            <Signed route={route} fallback={fallback} />
            {route.name !== 'print' && <ServerTray />}
            {route.name !== 'print' && <PaletteHost />}
            <AppBadge />
            {route.name === 'player' && <RememberOpened slug={route.slug} />}
          </InWorkspace>
        </AuthGate>
      )}
    </Shell>
  );
}

/** The screens behind the sign-in: the setup (a new account's), the library, the player, Settings. */
function Signed({ route, fallback }: { route: Route; fallback: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      {route.name === 'welcome' ? (
        <Setup step={route.step} />
      ) : route.name === 'print' ? (
        <PrintView slug={route.slug} />
      ) : route.name === 'player' ? (
        <Player key={route.slug} slug={route.slug} focus={route.c} startFrame={route.f} startV={route.v} verifyAt={route.verify} atAgent={route.agent} />
      ) : route.name === 'settings' ? (
        <Settings section={route.section} />
      ) : route.name === 'library' ? (
        <Library view={route.view} />
      ) : null}
    </Suspense>
  );
}

// Until the server has said who you are, the screen you are going to draws itself in its loading state (`pending`: it
// asks for nothing yet) — the same page the real one then takes over, so nothing moves between the two. While a
// screen's code is on its way there is nothing (a quick moment; a stand-in drawn by other code would be a lie).
function skeletonFor(route: Route) {
  const page =
    route.name === 'library' ? (
      <Library view={route.view} pending />
    ) : route.name === 'player' ? (
      <Player slug={route.slug} focus={null} startFrame={null} pending />
    ) : route.name === 'settings' ? (
      <Settings section={route.section} pending />
    ) : null;
  return page && <Suspense fallback={null}>{page}</Suspense>;
}
