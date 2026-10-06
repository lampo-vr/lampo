// Settings — the same on a hosted server and on the person's own machine: your profile and password, the look, how
// agents connect and which are connected, your API tokens, voice notes (the languages you speak), and — for owners and
// admins — the accounts, notifications and Auto-check; what this instance is at the end. A section shows when the
// role may use it.
import { type ComponentType, Suspense, useCallback, useEffect, useRef } from 'react';
import { type Action, can } from '../../../lib/permissions.ts';
import { useAuthStatus, useLikelyRole } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { UserMenu } from '../auth/UserMenu.tsx';
import { useWorkspaces } from '../auth/Workspaces.tsx';
import { perLang, t } from '../i18n/index.ts';
import { InboxBell } from '../inbox/InboxBell.tsx';
import { useScrollEdges } from '../lib/hooks.ts';
import { loader, screen, useLoaded } from '../lib/lazy.ts';
import { backToLibrary, type SettingsSection } from '../lib/nav.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { About } from './About.tsx';
import { Agents } from './Agents.tsx';
import { Appearance } from './Appearance.tsx';
import { Billing } from './Billing.tsx';
import { Checks } from './Checks.tsx';
import { Links } from './Links.tsx';
import { Mcp } from './Mcp.tsx';
import { Notifications } from './Notifications.tsx';
import { HousePlaybook } from './Playbook.tsx';
import { Profile } from './Profile.tsx';
import { Card } from './parts.tsx';
import { Speech } from './Speech.tsx';
import { Tokens } from './Tokens.tsx';
import { Users } from './Users.tsx';
import { Workspace } from './Workspace.tsx';
import '../styles/settings.css';

interface Section {
  id: SettingsSection;
  label: string;
  icon: IconName;
  /** The action a role must have to see it (lib/permissions.ts). */
  need?: Action;
  /** Only on a hosted server, in the browser (workspaces: the app on a person's own machine has one). */
  hosted?: boolean;
  /** Only where a billing provider runs (/api/info `billing`). */
  billing?: boolean;
}

const SECTIONS = perLang((): Section[] => [
  { id: 'profile', label: t('Profile'), icon: 'user' },
  { id: 'appearance', label: t('Appearance'), icon: 'sun' },
  { id: 'mcp', label: t('Connect an agent'), icon: 'terminal', need: 'agents' },
  { id: 'agents', label: t('Connected agents'), icon: 'spark', need: 'agents' },
  { id: 'tokens', label: t('API tokens'), icon: 'key' },
  { id: 'links', label: t('Review links'), icon: 'link', need: 'share' },
  { id: 'publishing', label: t('Publishing'), icon: 'upload', need: 'publish' },
  { id: 'workspace', label: t('Workspace'), icon: 'layers', hosted: true },
  { id: 'billing', label: t('Billing'), icon: 'billing', hosted: true, billing: true },
  { id: 'users', label: t('Users'), icon: 'shield', need: 'admin' },
  { id: 'notifications', label: t('Notifications'), icon: 'bell', need: 'view' },
  { id: 'playbook', label: t('Playbook'), icon: 'playbook', need: 'view' },
  { id: 'speech', label: t('Voice notes'), icon: 'mic', need: 'comment' },
  { id: 'checks', label: t('Auto-check'), icon: 'autoCheck', need: 'admin' },
  { id: 'about', label: t('About'), icon: 'info' },
]);

// Publishing's page comes with the composer's code (marks, words, its stylesheet): its own chunk, asked for when the
// section opens, so nothing of publishing rides along with Settings or the start's preload list.
const publishingPage = loader(() => import('./Publishing.tsx'));
function PublishingPage() {
  const Page = useLoaded(publishingPage)?.Publishing;
  if (Page) return <Page />;
  return (
    <>
      <header className="set-head">
        <h1>{t('Publishing')}</h1>
        <p>{t('Post final versions to YouTube, Instagram and Facebook from Lampo. Agents may draft posts; only people publish them.')}</p>
      </header>
      <Card title={t('Connections')} lede={t('Where this workspace’s posts go. Each one uses your own app or key: nothing goes through Lampo’s.')}>
        <SkeletonRegion label={t('Loading the connections')}>
          <RowsSkeleton n={2} thumb={false} />
        </SkeletonRegion>
      </Card>
    </>
  );
}

const PAGES: Record<SettingsSection, ComponentType> = {
  profile: Profile,
  tokens: Tokens,
  links: Links,
  publishing: PublishingPage,
  agents: Agents,
  users: Users,
  workspace: Workspace,
  billing: Billing,
  notifications: Notifications,
  playbook: HousePlaybook,
  appearance: Appearance,
  speech: Speech,
  checks: Checks,
  mcp: Mcp,
  about: About,
};

/**
 * `pending`: drawn before the server has said who you are (App's loading state). Until then the sections are the ones
 * this browser saw last and the section's title stands at once, so the page is the same page when the answer comes.
 */
// The server's operator's pages (#/operator/funnel · workspaces · accounts, web/src/operator/): a chunk of their own,
// asked for from here, so the first paint carries nothing of them.
const operatorCode = loader(() => import('../operator/Operator.tsx'));
const Operator = screen(operatorCode);

export default function Settings({ section }: { section: SettingsSection | 'operator' | null; pending?: boolean }) {
  if (section === 'operator')
    return (
      <Suspense fallback={null}>
        <Operator />
      </Suspense>
    );
  return <Sections section={section} />;
}

function Sections({ section }: { section: SettingsSection | null }) {
  const user = useAuthStatus().data?.user;
  const info = useInfo();
  const role = useLikelyRole();
  const { hosted } = useWorkspaces();
  const shown = SECTIONS().filter((s) => !!role && (!s.need || can(role, s.need)) && (!s.hosted || hosted) && (!s.billing || !!info?.billing));
  const first = shown[0]?.id;
  const current = shown.find((s) => s.id === section)?.id ?? first;
  const Page = current ? PAGES[current] : null;
  // Narrow screens: the sections are a row that scrolls sideways — soft edges where there is more, and the open one
  // brought into view (a section at the far end was otherwise off-screen when its page opened).
  const [edgesRef, edges] = useScrollEdges<HTMLElement>();
  const nav = useRef<HTMLElement | null>(null);
  const navRef = useCallback(
    (el: HTMLElement | null) => {
      nav.current = el;
      edgesRef(el);
    },
    [edgesRef],
  );
  useEffect(() => {
    const on = current ? nav.current?.querySelector<HTMLElement>('a.on') : null;
    const box = nav.current;
    if (on && box && box.scrollWidth > box.clientWidth) box.scrollTo({ left: on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2 });
  }, [current]);
  return (
    <div className="page">
      <div className="topbar grain">
        <IconButton className="btn ghost sm icon-only" label={t('Back to the library')} icon="back" size={17} onClick={backToLibrary} side="bottom" />
        {/* where this instance runs is About's to say, not the title's */}
        <div className="p-title grow">
          <b>{t('Settings')}</b>
        </div>
        {/* inbox */}
        <InboxBell />
        <UserMenu />
      </div>
      <div className="settings grain">
        <nav className={`set-nav ${edges}`} ref={navRef} aria-label={t('Settings')}>
          {shown.map((s) => (
            <a
              key={s.id}
              href={s.id === first ? '#/settings' : `#/settings/${s.id}`}
              className={current === s.id ? 'on' : ''}
              aria-current={current === s.id ? 'page' : undefined}
            >
              <I name={s.icon} size={16} />
              {s.label}
            </a>
          ))}
          {info && (
            <div className="set-server">
              <div>
                <span>{t('version')}</span>
                <span>{info?.version || '…'}</span>
              </div>
              <div>
                <span>{t('storage')}</span>
                <span>{info?.features.storage || '…'}</span>
              </div>
              <div>
                <span>{t('uploads')}</span>
                <span>≤ {info ? t('{x} GB', { x: Math.round(info.features.upload_max_bytes / 1e9) }) : '…'}</span>
              </div>
              <div>
                <span>{t('licence')}</span>
                <span>
                  {info?.source_url ? (
                    <a href={info.source_url} target="_blank" rel="noreferrer" data-testid="source-link">
                      {t('AGPL-3.0 · source')}
                    </a>
                  ) : (
                    t('AGPL-3.0')
                  )}
                  {' · '}
                  <a href="/third-party-licenses.txt" target="_blank" rel="noreferrer" data-testid="nav-notices">
                    {t('notices')}
                  </a>
                </span>
              </div>
            </div>
          )}
        </nav>
        <main className="set-main">
          <div className={`set-inner ${current === 'playbook' ? 'wide' : current === 'billing' ? 'bill-col' : ''}`} key={current}>
            {info && user && Page ? (
              <Page />
            ) : (
              current && (
                <SkeletonRegion label={t('Loading')}>
                  <header className="set-head">
                    <h1>{SECTIONS().find((s) => s.id === current)?.label}</h1>
                    <p>
                      <SkLine w="60%" />
                    </p>
                  </header>
                </SkeletonRegion>
              )
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
