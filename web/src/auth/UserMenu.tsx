// The signed-in account in the top bar: the workspaces to switch between and making a new one (on a hosted server, for
// someone with more than one or who may make one: auth/Workspaces.tsx), Settings (⌘,), the operator pages for whoever
// runs the server, "Get started · 2 of 5" while the first run has steps open (it opens the steps at the sidebar's foot,
// or brings the card back where there is no sidebar; hidden or not), the connected agents, sign out, and a quick theme
// row.
// Everything else (profile, tokens, users) is a section of Settings. Signed in at the machine itself there is nobody to
// sign out as. The chip is the avatar alone (the name is its tooltip and the menu's label): one
// size before and after the server says who you are, so the top bar never shifts when it does.
import { useQueryClient } from '@tanstack/react-query';
import { resumable } from '../../../lib/onboarding.ts';
import { avatarSrc, useAuthStatus, useCan, useSignOut } from '../api/auth.ts';
import { useBilling } from '../api/queries.ts';
import { billingCode } from '../billing/code.ts';
import { useLoaded, usePainted } from '../lib/lazy.ts';
import type { SettingsSection } from '../lib/nav.ts';
import { toastError } from '../lib/toast.ts';
import { getStartedCode, useFirstRun } from '../onboarding/state.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Avatar } from '../ui/plain.tsx';
import { Menu, Tip } from '../ui/primitives.tsx';
import { useThemeChoice } from '../ui/themeChoice.ts';
// The workspaces to switch between and "New workspace…": their code loads only for someone with more than one or who
// may make one (auth/Workspaces.tsx).
import { workspacesCode } from './workspacesCode.ts';

import '../styles/account.css';
import { t } from '../i18n/index.ts';

const open = (section: SettingsSection | null) => {
  location.hash = section ? `#/settings/${section}` : '#/settings';
};

export function UserMenu() {
  const status = useAuthStatus().data;
  const user = status?.user;
  const atMachine = status?.via === 'local';
  const signOut = useSignOut();
  const allowed = useCan();
  const theme = useThemeChoice();
  const W = useLoaded(
    workspacesCode,
    status?.mode === 'server' && status.via === 'cookie' && ((status.workspaces?.length ?? 0) > 1 || !!status.workspace_create),
  );
  const qc = useQueryClient();
  // a trial's line and Billing (conversion/Trial.tsx), from the chunk the library loads anyway, once a plan is known here
  const billing = useBilling(false).data;
  const B = useLoaded(billingCode, usePainted(!!billing));
  const run = useFirstRun();
  const done = run.steps.filter((x) => x.done).length;
  // the steps at the sidebar's foot where it shows, else the card back above All videos (onboarding/Panel.tsx fromMenu)
  const getStarted = () =>
    getStartedCode
      .load()
      .then((m) => m.fromMenu(qc))
      .catch(toastError);
  // Not known yet: the same chip, idle (signed out, there is no top bar to put it in).
  if (!status)
    return (
      <button type="button" className="user-chip" disabled aria-label={t('Account')}>
        <Avatar name="" size={20} kind="person" />
        <I name="down" size={12} />
      </button>
    );
  if (!user) return null;
  return (
    <>
      <Menu
        sideOffset={6}
        trigger={
          <Tip content={user.name} side="bottom">
            <button type="button" className="user-chip" aria-label={t('Account: {name}', { name: user.name })}>
              <Avatar name={user.name} size={20} kind="person" src={avatarSrc(user.avatar)} />
              <I name="down" size={12} />
            </button>
          </Tip>
        }
        items={[
          ...(W ? W.workspaceEntries(status) : []),
          'sep',
          ...(B ? B.menuEntries(billing) : []),
          { label: t('Settings'), icon: 'settings', shortcut: '⌘,', onClick: () => open(null) },
          // the server's operator alone: the server says so in the status, so nobody else ever sees it, not even briefly
          status.operator && {
            label: t('Operator'),
            icon: 'chart',
            onClick: () => {
              location.hash = '#/operator/workspaces';
            },
          },
          resumable(run.o) && {
            label: t('Get started'),
            mark: <KeyGlyph shape="outline" size={10} />,
            shortcut: t('{done} of {n}', { done, n: run.steps.length }),
            onClick: getStarted,
          },
          allowed('agents') && { label: t('Connected agents'), icon: 'terminal', onClick: () => open('agents') },
          !atMachine && 'sep',
          !atMachine && { label: t('Sign out'), icon: 'signOut', onClick: () => signOut.mutateAsync(false).catch(toastError) },
          'sep',
          theme,
        ]}
      />
      {B && <B.MenuTrialCard billing={billing} />}
    </>
  );
}
