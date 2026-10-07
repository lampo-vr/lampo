// Hash routes:  #/v/<slug>?c=&f=&v=  player · #/print/<slug> · #/ #/inbox #/unsorted #/insights #/archived
// #/folder/<path> #/playbook/<path>[?tab=…] #/session/<name>  library views (old addresses: #/for-you and #/verify open
// #/inbox, #/open opens All videos on the Being fixed lane) · #/status (where every video stands) · #/settings[/<section>] · #/invite/<token> ·
// #/signup · #/forgot · #/reset/<token> · #/verify/<token> (what emailed links open, server mode) · #/oauth/<request> and
// #/oauth/error?error=…  (an app asking to connect, server mode) · #/welcome[/<step>] (a new account's setup) ·
// #/operator/funnel|workspaces[/<id>]|accounts[/<id>] (the server's operator) · #/styleguide (dev and test builds) ·
// /g/<token>  client link (real paths, served by the server)
import { enc } from '../api/client.ts';
import type { LibraryView } from './folders.ts';

export { crumbs, type LibraryView, leaf, within } from './folders.ts';

/** Server mode: profile · tokens · agents · users · notifications (+ speech and Auto-check for admins). Local mode:
 * appearance · speech · checks · mcp · about. */
export const SETTINGS_SECTIONS = [
  'profile',
  'tokens',
  'links',
  'publishing',
  'agents',
  'workspace',
  'billing',
  'users',
  'notifications',
  'playbook',
  'appearance',
  'speech',
  'checks',
  'mcp',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** What /oauth/authorize may say went wrong (server/routes/oauth.ts): the error page shows its own words for each. */
export const OAUTH_ERROR_CODES = ['invalid_client', 'invalid_request', 'slow_down', 'unsupported_response_type', 'invalid_target', 'invalid_scope'] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export type Route =
  | { name: 'guest'; token: string }
  | { name: 'invite'; token: string }
  | { name: 'signup' }
  | { name: 'forgot' }
  | { name: 'reset'; token: string }
  | { name: 'verify'; token: string }
  | { name: 'oauth'; request: string }
  | { name: 'oauth-error'; error: OAuthErrorCode }
  /** `section` null: the first one this mode has (`#/settings`). `operator`: the server's operator's pages
   * (`#/operator/…`, which page is web/src/operator/Operator.tsx's to read), asked for from Settings' chunk. */
  | { name: 'settings'; section: SettingsSection | 'operator' | null }
  | { name: 'print'; slug: string }
  | { name: 'player'; slug: string; c: string | null; f: string | null; v: string | null; verify: string | null }
  | { name: 'status' }
  /** A new account's setup (onboarding/Setup.tsx): Welcome, or one of its steps. */
  | { name: 'welcome'; step: string | null }
  | { name: 'styleguide' }
  | { name: 'library'; view: LibraryView };

/** A path segment from the hash, decoded; a malformed escape (a folder named "100%") is taken as written instead of
 * throwing before the app's first render. */
export const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const OLD_INBOX = /^#\/(for-you|verify)\/?$/;
const OLD_OPEN = /^#\/open\/?$/;

export function parseRoute(hash: string, pathname: string): Route {
  const g = /^\/g\/([A-Za-z0-9_-]+)/.exec(pathname);
  if (g) return { name: 'guest', token: g[1] };
  // old addresses: the inbox's old page and the fixes to check (links in older notifications, bookmarks) are the
  // inbox now; the open notes are All videos on the Being fixed lane (App sets the lane)
  if (OLD_INBOX.test(hash)) return { name: 'library', view: { kind: 'inbox' } };
  if (OLD_OPEN.test(hash)) return { name: 'library', view: { kind: 'all' } };
  if (/^#\/status\/?$/.test(hash)) return { name: 'status' };
  if (/^#\/styleguide\/?$/.test(hash)) return { name: 'styleguide' };
  const wl = /^#\/welcome(?:\/([a-z]+))?\/?$/.exec(hash);
  if (wl) return { name: 'welcome', step: wl[1] ?? null };
  const inv = /^#\/invite\/(inv_[A-Za-z0-9_-]+)$/.exec(hash);
  if (inv) return { name: 'invite', token: inv[1] };
  // What an email's link opens; the token stays in the fragment and the page posts it.
  if (/^#\/signup\/?$/.test(hash)) return { name: 'signup' };
  if (/^#\/forgot\/?$/.test(hash)) return { name: 'forgot' };
  const rt = /^#\/reset\/(rt_[A-Za-z0-9_-]+)$/.exec(hash);
  if (rt) return { name: 'reset', token: rt[1] };
  const vt = /^#\/verify\/(vt_[A-Za-z0-9_-]+)$/.exec(hash);
  if (vt) return { name: 'verify', token: vt[1] };
  const oe = /^#\/oauth\/error(?:\?(.*))?$/.exec(hash);
  if (oe) {
    // A code of the server's set and nothing else: anyone can send a link to this page, so no word of it is theirs.
    const code = new URLSearchParams(oe[1] || '').get('error');
    return { name: 'oauth-error', error: (OAUTH_ERROR_CODES as readonly string[]).includes(code || '') ? (code as OAuthErrorCode) : 'invalid_request' };
  }
  const oa = /^#\/oauth\/([A-Za-z0-9_-]{16,64})$/.exec(hash);
  if (oa) return { name: 'oauth', request: oa[1] };
  // a section may carry a query for the page (the House playbook's ?tab=suggestions, ?rule=<topic> from Insights)
  // Settings → Billing's checkout is a step of its own (#/settings/billing/checkout?plan=…): the page reads the rest; so
  // is its cancellation (#/settings/billing/cancel, § 312k BGB)
  const st = /^#\/settings(?:\/([a-z]+))?(?:\/(checkout|cancel)(?=$|\?))?(?:\?.*)?$/.exec(hash);
  if (st && (!st[1] || (SETTINGS_SECTIONS as readonly string[]).includes(st[1])) && (!st[2] || st[1] === 'billing'))
    return { name: 'settings', section: (st[1] as SettingsSection) ?? null };
  if (/^#\/operator(\/(funnel|workspaces|accounts)(\/[\w-]+)?)?\/?$/.test(hash)) return { name: 'settings', section: 'operator' };
  const pr = /^#\/print\/(.+)$/.exec(hash);
  if (pr) return { name: 'print', slug: decoded(pr[1]) };
  const m = /^#\/v\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (m) {
    const q = new URLSearchParams(m[2] || '');
    return { name: 'player', slug: decoded(m[1]), c: q.get('c'), f: q.get('f'), v: q.get('v'), verify: q.get('verify') };
  }
  const f = /^#\/folder\/(.+)$/.exec(hash);
  if (f) return { name: 'library', view: { kind: 'folder', id: decoded(f[1]) } };
  const pb = /^#\/playbook\/([^?]+)(?:\?.*)?$/.exec(hash);
  if (pb) return { name: 'library', view: { kind: 'playbook', id: decoded(pb[1]) } };
  const s = /^#\/session\/(.+)$/.exec(hash);
  if (s) return { name: 'library', view: { kind: 'session', id: decoded(s[1]) } };
  const k = /^#\/(inbox|unsorted|insights|archived)$/.exec(hash);
  return { name: 'library', view: { kind: k ? (k[1] as 'inbox' | 'unsorted' | 'insights' | 'archived') : 'all' } };
}

/**
 * A link from outside the app (a notification, a chat message, an agent) names its workspace (`w=`, lib/scope.ts
 * routeIn): taken off the address before any route is read, and followed once the person is signed in (App).
 */
export function takeWorkspace(): string | null {
  const m = /[?&]w=(w1|w_[a-z0-9]{12})(?=&|$)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(
    history.state,
    '',
    location.hash
      .replace(m[0], m[0][0] === '?' ? '?' : '')
      .replace('?&', '?')
      .replace(/\?$/, '') || '#/',
  );
  return m[1] as string;
}

/** An old address that now shows the Being fixed lane of All videos (the sidebar's "Open notes" before). */
export const isOldOpenNotes = (hash: string): boolean => OLD_OPEN.test(hash);
/** The address a route is known by: the inbox's old page (#/for-you) and "To verify" (#/verify) are the inbox view
 * now, "Open notes" (#/open) is All videos. */
export const canonicalHash = (hash: string): string | null => (OLD_INBOX.test(hash) ? '#/inbox' : OLD_OPEN.test(hash) ? '#/' : null);

export const go = (slug: string | null, query?: string) => {
  location.hash = slug ? `#/v/${enc(slug)}${query ? `?${query}` : ''}` : '#/';
};

export const viewHash = (v: LibraryView) =>
  v.kind === 'folder'
    ? `#/folder/${enc(v.id)}`
    : v.kind === 'playbook'
      ? `#/playbook/${enc(v.id)}`
      : v.kind === 'session'
        ? `#/session/${enc(v.id)}`
        : v.kind === 'all'
          ? '#/'
          : `#/${v.kind}`;
export const goView = (v: LibraryView) => {
  location.hash = viewHash(v);
};

const LAST = 'vr.lastLibrary';
export const rememberLibrary = () => {
  try {
    sessionStorage.setItem(LAST, location.hash || '#/');
  } catch {}
};
export const backToLibrary = () => {
  let h = '#/';
  try {
    h = sessionStorage.getItem(LAST) || '#/';
  } catch {}
  location.hash = h;
};
