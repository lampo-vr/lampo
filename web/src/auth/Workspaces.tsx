// Workspaces in the app (a hosted server only; on a person's own machine there is one and none of this shows): where
// this session works and what else the person belongs to, from what /api/auth/status says; the account menu's
// switcher (loaded by auth/UserMenu.tsx only for someone with a second workspace or who may make one — everyone else
// never loads it); and
// switching. A switch belongs to the session (its cookie), so the whole browser moves: this tab starts again in the
// other workspace, the other tabs follow (the auth channel), and what this browser kept of the one before is let go
// (api/persistWrite.ts keeps per account and workspace), so it never paints for a moment. Making one is Settings →
// Workspace's dialog (NewWorkspace.tsx); "New workspace…" in the menu goes there.
import { tellWorkspaceChange, useAuthStatus } from '../api/auth.ts';
import { api } from '../api/client.ts';
import { ownerKey } from '../api/persist.ts';
import type { AuthStatus, MyWorkspace } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { MenuEntry } from '../ui/primitives.tsx';
import '../styles/workspaces.css';

export interface Workspaces {
  /** The workspace this session works in (null before the server answered, or signed out). */
  current: MyWorkspace | null;
  /** Every workspace the account belongs to. */
  list: MyWorkspace[];
  /** A hosted server, in the browser: workspaces are a thing here at all. */
  hosted: boolean;
  /** The switcher is worth showing: hosted and more than one workspace. */
  many: boolean;
  /** This person may make a new one here: the menu offers it, with one workspace too. */
  create: boolean;
}

const workspacesOf = (s: AuthStatus | undefined): Workspaces => {
  const list = s?.workspaces ?? [];
  const hosted = s?.mode === 'server' && s.via === 'cookie';
  return { current: s?.workspace ?? null, list, hosted, many: hosted && list.length > 1, create: hosted && !!s?.workspace_create };
};

export const useWorkspaces = (): Workspaces => workspacesOf(useAuthStatus().data);

/** A workspace's mark: its first letter on a quiet tile (the same in every list, so it can be found by eye). */
export function WorkspaceMark({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`ws-mark ${size}`} aria-hidden="true">
      {[...(name.trim() || '?')][0]?.toUpperCase()}
    </span>
  );
}

/** The session now works in `ws`: what this browser kept is let go, every tab starts again there, at the library. */
export async function arrive(userId: string, ws: string, { stay = false }: { stay?: boolean } = {}): Promise<void> {
  const { setPersistAccount } = await import('../api/persistWrite.ts');
  await setPersistAccount(ownerKey(userId, ws));
  tellWorkspaceChange();
  // `stay`: the page starts again where it is (a link followed into its workspace), else at the library
  if (!stay) location.hash = '#/';
  location.reload();
}

let following = '';
/**
 * A link that names another workspace than the session's (a notification, a chat message, an agent's link: lib/scope.ts
 * routeIn; App holds the screen meanwhile): one of the person's own — the session moves there and the page starts again
 * at the link —; any other is said, and the library opens instead (`done` lets App show it). A12 WS-11.
 */
export async function followLink(id: string, done: (w: null) => void): Promise<void> {
  if (following === id) return;
  following = id;
  try {
    // where the session works now, as the server says (what the page kept may not say it)
    const s = await api<AuthStatus>('/api/auth/status');
    const user = s.user;
    if (user && s.workspace?.id === id) {
      following = '';
      done(null);
      return;
    }
    if (user && s.workspaces?.some((w) => w.id === id)) {
      await api('/api/workspaces/switch', { method: 'POST', body: { id } });
      await arrive(user.id, id, { stay: true });
      return;
    }
  } catch {}
  following = '';
  toast(t('That link is for a workspace you’re not in.'), 'error');
  location.replace('#/');
  done(null);
}

/** Moves the session to another of the person's workspaces; the browser starts again there. */
export async function switchWorkspace(id: string, userId: string): Promise<void> {
  const { workspace } = await api<{ workspace: MyWorkspace }>('/api/workspaces/switch', { method: 'POST', body: { id } });
  await arrive(userId, workspace.id);
}

let wantNew = false;
/** "New workspace…": Settings → Workspace with its dialog open (already there: the page hears it). */
export function openNewWorkspace(): void {
  wantNew = true;
  if (location.hash === '#/settings/workspace') dispatchEvent(new Event('vr:new-workspace'));
  else location.hash = '#/settings/workspace';
}
/**
 * Whether "New workspace…" was asked for on the way here — kept until the dialog shows (`done`): the page may be drawn
 * more than once on arrival (its loading state, then itself).
 */
export const askedNewWorkspace = (done = false): boolean => {
  if (done) wantNew = false;
  return wantNew;
};

/**
 * The account menu's switcher: the person's workspaces (the current one ticked) and making a new one — for someone with
 * more than one, or who may make one (the owner of a server's only workspace found "New workspace" nowhere but at the
 * foot of Settings → Workspace).
 */
export function workspaceEntries(s: AuthStatus | undefined): MenuEntry[] {
  const w = workspacesOf(s);
  const user = s?.user;
  if (!(w.many || w.create) || !user) return [];
  return [
    { heading: t('Workspaces') },
    ...w.list.map((x) => ({
      label: x.name,
      mark: <WorkspaceMark name={x.name} />,
      checked: x.current,
      onClick: () => {
        if (!x.current) switchWorkspace(x.id, user.id).catch(toastError);
      },
    })),
    // only for whoever may make one (a member of two who may not was offered a dialog that refused)
    ...(w.create ? [{ label: t('New workspace…'), icon: 'plus' as const, onClick: openNewWorkspace }] : []),
  ];
}
