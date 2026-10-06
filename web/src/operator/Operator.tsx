// The operator's pages (#/operator/funnel · /workspaces[/<id>] · /accounts[/<id>]): how sign-ups become paying
// workspaces, every workspace on the server with its plan, every account. One frame — Settings' layout, its section list
// the tab line (Funnel · Workspaces · Accounts), a row of tabs on a narrow screen — around the page the address names.
// Only the server's operator sees it (/api/auth/status says `operator`, the server holds every route to the same rule);
// anyone else reads that there is no such page, without the frame ever showing. A chunk of its own from Settings, so
// nothing of it is in the first paint; its styles come with it (operator.css).
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuthStatus } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { useScrollEdges } from '../lib/hooks.ts';
import { backToLibrary } from '../lib/nav.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { AccountPage, AccountsPage } from './Accounts.tsx';
import { FunnelPage } from './Funnel.tsx';
import { WorkspacePage, WorkspacesPage } from './Workspaces.tsx';
import '../styles/settings.css';
import '../styles/operator.css';

export type OperatorPage = { kind: 'funnel' } | { kind: 'workspaces'; id: string | null } | { kind: 'accounts'; id: string | null };

/** The page an address names (nav.ts sends every #/operator… here). */
export function pageOf(hash: string): OperatorPage {
  const m = /^#\/operator(?:\/(funnel|workspaces|accounts)(?:\/([A-Za-z0-9_-]{1,64}))?)?\/?$/.exec(hash);
  const kind = m?.[1];
  if (kind === 'workspaces' || kind === 'accounts') return { kind, id: m?.[2] ?? null };
  return { kind: 'funnel' };
}

const onHash = (cb: () => void) => {
  addEventListener('hashchange', cb);
  return () => removeEventListener('hashchange', cb);
};
const useHash = () => useSyncExternalStore(onHash, () => location.hash);

const TABS = (): { kind: OperatorPage['kind']; label: string; icon: IconName }[] => [
  { kind: 'funnel', label: t('Funnel'), icon: 'chart' },
  { kind: 'workspaces', label: t('Workspaces'), icon: 'layers' },
  { kind: 'accounts', label: t('Accounts'), icon: 'users' },
];

/** The top bar every state of the pages shares. */
function TopBar({ who }: { who: boolean }) {
  return (
    <div className="topbar grain">
      <IconButton className="btn ghost sm icon-only" label={t('Back to the library')} icon="back" size={17} onClick={backToLibrary} side="bottom" />
      <div className="p-title grow">{who && <b>{t('Operator')}</b>}</div>
      {who && (
        <span className="op-who">
          <KeyGlyph shape="hold" size={9} />
          {t('Only you see this · {host}', { host: location.host })}
        </span>
      )}
    </div>
  );
}

/** Anyone but the operator: no such page here, like any address the app doesn't know. */
export function Missing() {
  return (
    <div className="page" data-testid="op-missing">
      <TopBar who={false} />
      <main className="op-missing">
        <EmptyState
          art="error"
          titleAs="h1"
          title={t('There’s no page here')}
          action={
            <Button variant="primary" onClick={backToLibrary}>
              {t('Back to the library')}
            </Button>
          }
        >
          {t('The address may be mistyped, or this page is for someone else.')}
        </EmptyState>
      </main>
    </div>
  );
}

/** Each list keeps where it was scrolled to while one of its pages is open, and goes back there. */
const kept: Record<string, number> = {};

function Frame({ page, children }: { page: OperatorPage; children: ReactNode }) {
  const info = useInfo();
  let host = '';
  try {
    host = info?.public_url ? new URL(info.public_url).host : '';
  } catch {}
  const [edgesRef, edges] = useScrollEdges<HTMLElement>();
  const main = useRef<HTMLElement | null>(null);
  const at = `${page.kind}:${'id' in page ? (page.id ?? '') : ''}`;
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    el.scrollTop = kept[at] ?? 0;
    const keep = () => {
      kept[at] = el.scrollTop;
    };
    el.addEventListener('scroll', keep, { passive: true });
    return () => el.removeEventListener('scroll', keep);
  }, [at]);
  return (
    <div className="page">
      <TopBar who />
      <div className="settings op-shell grain">
        <nav className={`set-nav ${edges}`} ref={edgesRef} aria-label={t('Operator')}>
          {TABS().map((tab) => (
            <a
              key={tab.kind}
              href={`#/operator/${tab.kind}`}
              className={page.kind === tab.kind ? 'on' : ''}
              aria-current={page.kind === tab.kind ? 'page' : undefined}
              data-testid={`op-tab-${tab.kind}`}
            >
              <I name={tab.icon} size={16} />
              {tab.label}
            </a>
          ))}
          <div className="set-server">
            {host && (
              <div>
                <span>{t('server')}</span>
                <span>{host}</span>
              </div>
            )}
            {page.kind === 'funnel' && (
              <div>
                <span>{t('events')}</span>
                <span>{t('first-party')}</span>
              </div>
            )}
          </div>
        </nav>
        <main className="set-main" ref={main}>
          {/* lists take the room their columns need; a page of cards keeps Settings' measure */}
          <div className={`set-inner op-page ${page.kind === 'funnel' ? '' : 'id' in page && page.id ? 'op-narrow' : 'op-wide'}`} key={at}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function Operator() {
  useLang();
  const status = useAuthStatus().data;
  const page = pageOf(useHash());
  // Who is asking, before anything else: a stranger never sees the frame, not even while the page loads.
  if (!status)
    return (
      <div className="page" aria-busy="true">
        <TopBar who={false} />
      </div>
    );
  if (!status.operator) return <Missing />;
  return (
    <Frame page={page}>
      {page.kind === 'funnel' ? (
        <FunnelPage />
      ) : page.kind === 'workspaces' ? (
        page.id ? (
          <WorkspacePage id={page.id} />
        ) : (
          <WorkspacesPage />
        )
      ) : page.id ? (
        <AccountPage id={page.id} />
      ) : (
        <AccountsPage />
      )}
    </Frame>
  );
}
