// Accounts (server mode): who is signed in, signing in and out, the setup of the first account, the profile, API
// tokens, and — for admins — the other accounts. Local mode answers /api/auth/status with mode 'local' and none of
// the rest is used.

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext } from 'react';
import { type Action, can } from '../../../lib/permissions.ts';
import { currentLang } from '../i18n/index.ts';
import { chromeRole } from '../lib/chromeHint.ts';
import { forgetRecent } from '../lib/recent.ts';
import { forgetAccountStorage } from '../lib/signedOut.ts';
import { isAccountData } from './accountData.ts';
import { api } from './client.ts';
import { reconnectEvents } from './events.ts';
import { keys } from './queries.ts';
import type {
  AdminUser,
  AuthStatus,
  ConnectedAgent,
  InviteCreated,
  InvitePeek,
  OAuthRequestView,
  PublicApp,
  PublicInvite,
  PublicToken,
  PublicUser,
  Role,
  UserPrefsPatch,
} from './types.ts';

export const authKeys = {
  status: ['auth', 'status'] as const,
  tokens: ['auth', 'tokens'] as const,
  apps: ['auth', 'apps'] as const,
  adminApps: ['auth', 'admin-apps'] as const,
  users: ['auth', 'users'] as const,
  invites: ['auth', 'invites'] as const,
  invite: (token: string) => ['auth', 'invite', token] as const,
  oauth: (id: string) => ['auth', 'oauth', id] as const,
  agents: ['agents'] as const,
  people: ['auth', 'people'] as const,
};

/**
 * The team's profile pictures by the name notes carry: `avatarOf(name)` is the picture's URL or null (initials).
 * Signed-in people only (review links show initials).
 */
export function usePeople(): (name: string) => string | null {
  const signedIn = !!useAuthStatus().data?.user;
  const { data } = useQuery({
    queryKey: authKeys.people,
    queryFn: () => api<{ people: { name: string; avatar: string | null }[] }>('/api/people'),
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });
  return useCallback((name: string) => data?.people.find((p) => p.name === name)?.avatar ?? null, [data]);
}

/** The picture's URL for an account (as the API sends it: the stored file's name). */
export const avatarSrc = (file: string | null | undefined): string | null => (file ? `/api/avatars/${file}` : null);

/** Setting or removing your profile picture (sent inline, base64). */
export function useAvatar() {
  const qc = useQueryClient();
  const done = ({ user }: { user: PublicUser }) => {
    qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s ? { ...s, user } : s));
    qc.invalidateQueries({ queryKey: authKeys.people });
    qc.invalidateQueries({ queryKey: authKeys.users });
  };
  return {
    set: useMutation({ mutationFn: (data: string) => api<{ user: PublicUser }>('/api/auth/me/avatar', { method: 'PUT', body: { data } }), onSuccess: done }),
    remove: useMutation({ mutationFn: () => api<{ user: PublicUser }>('/api/auth/me/avatar', { method: 'DELETE' }), onSuccess: done }),
  };
}

export const authStatusQuery = { queryKey: authKeys.status, queryFn: () => api<AuthStatus>('/api/auth/status'), retry: 2, staleTime: 60_000 };
export const useAuthStatus = () => useQuery(authStatusQuery);

/** The signed-in account's role (on the person's own machine its owner is signed in automatically). */
export function useRole(): Role | null {
  return useAuthStatus().data?.user?.role ?? null;
}

/**
 * The role — or, before the server has answered, the one this browser saw last (lib/chromeHint.ts): for the chrome
 * that depends on it (Add video, the settings sections), so it is there from the first paint instead of popping in.
 */
export function useLikelyRole(): Role | null {
  const status = useAuthStatus().data;
  return status ? (status.user?.role ?? null) : chromeRole();
}

/**
 * Inside an archived project (lib/archived.ts) everything is read only: watching, downloading and restoring it are
 * what's left. A screen about one video or folder of it says so for everything it holds (the player: its value).
 */
export const ReadOnlyScope = createContext(false);
const READ_ONLY_MAY: ReadonlySet<Action> = new Set<Action>(['view', 'download', 'archive']);

/** What the current role may do (lib/permissions.ts; the server enforces the same table); `readOnly`: as ReadOnlyScope. */
export function useCan(readOnly = false): (action: Action) => boolean {
  const role = useRole();
  const frozen = useContext(ReadOnlyScope) || readOnly;
  return useCallback((action: Action) => can(role, action) && (!frozen || READ_ONLY_MAY.has(action)), [role, frozen]);
}

// Other tabs share the cookie: when one signs in or out, the others follow instead of showing stale screens.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vr-auth') : null;

/** A new session: everything cached under the old one (or none) is refetched, and the event stream reconnects. */
export function afterSignIn(qc: QueryClient, status: AuthStatus, tell = true) {
  qc.setQueryData(authKeys.status, status);
  qc.removeQueries({ predicate: (q) => isAccountData(q.queryKey) });
  reconnectEvents();
  if (tell) channel?.postMessage('signed-in');
}

export function afterSignOut(qc: QueryClient, tell = true) {
  qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s ? { ...s, user: null, via: null } : s));
  qc.removeQueries({ predicate: (q) => isAccountData(q.queryKey) });
  // Nothing of the account stays in this browser (api/persistWrite.ts, the sidebar's Recent, folder and video names in
  // the screens' remembered state: lib/signedOut.ts).
  void import('./persistWrite.ts').then((m) => m.forgetPersisted());
  forgetRecent();
  forgetAccountStorage(localStorage);
  forgetAccountStorage(sessionStorage);
  if (tell) channel?.postMessage('signed-out');
}

/** This browser's session moved to another workspace (api/workspaces.ts): the other tabs start again there too. */
export const tellWorkspaceChange = () => channel?.postMessage('workspace');

export function bindAuthChannel(qc: QueryClient) {
  if (!channel) return;
  channel.onmessage = async (e: MessageEvent<string>) => {
    if (e.data === 'signed-out') afterSignOut(qc, false);
    if (e.data === 'signed-in') afterSignIn(qc, await api<AuthStatus>('/api/auth/status'), false);
    if (e.data === 'workspace') {
      location.hash = '#/';
      location.reload();
    }
  };
}

/** What signing in, setting up and taking an invite answer: the account, and where the session works (hosted). */
type SignedIn = { user: PublicUser } & Pick<AuthStatus, 'workspace' | 'workspaces'>;
const signedInStatus = ({ user, workspace, workspaces }: SignedIn): AuthStatus => ({
  mode: 'server',
  setup: false,
  user,
  via: 'cookie',
  ...(workspace ? { workspace } : {}),
  ...(workspaces ? { workspaces } : {}),
});

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { email: string; password: string }) => api<SignedIn>('/api/auth/login', { method: 'POST', body: b }),
    onSuccess: (r) => afterSignIn(qc, signedInStatus(r)),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { token: string; name: string; email: string; password: string }) => api<SignedIn>('/api/auth/setup', { method: 'POST', body: b }),
    onSuccess: (r) => afterSignIn(qc, signedInStatus(r)),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (everywhere: boolean) => {
      // This device stops getting the account's notifications (they carry the notes' text): unsubscribed while still
      // signed in, so the server forgets the device too. It never stands in the way of signing out.
      await import('../pwa/push.ts').then((m) => m.disablePush()).catch(() => {});
      return api(everywhere ? '/api/auth/logout-everywhere' : '/api/auth/logout', { method: 'POST' });
    },
    onSettled: () => afterSignOut(qc),
  });
}

/** The key of saving the account (useUpdateMe): while one is on its way, AuthGate holds off following the account's
 * theme and language (a status answered meanwhile may still say the choice before). */
export const SAVING_ME = ['auth', 'me'] as const;

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SAVING_ME,
    mutationFn: (b: { name?: string; email?: string; password?: string; current_password?: string; prefs?: UserPrefsPatch }) =>
      api<{ user: PublicUser }>('/api/auth/me', { method: 'PATCH', body: b.email !== undefined ? { ...b, lang: pageLang() } : b }),
    onSuccess: ({ user }) => {
      qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s ? { ...s, user } : s));
      qc.invalidateQueries({ queryKey: keys.info });
    },
  });
}

// ---------------------------------------------------------------- API tokens

export const useTokens = () => useQuery({ queryKey: authKeys.tokens, queryFn: () => api<{ tokens: PublicToken[] }>('/api/auth/tokens') });

export function useTokenActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: authKeys.tokens });
  return {
    create: useMutation({
      /** `days`: when it stops working; none works until revoked. */
      mutationFn: ({ name, days }: { name: string; days?: number }) =>
        api<{ token: string; info: PublicToken }>('/api/auth/tokens', { method: 'POST', body: { name, ...(days ? { days } : {}) } }),
      onSuccess: done,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onMutate: (id: string) => qc.setQueryData<{ tokens: PublicToken[] }>(authKeys.tokens, (d) => (d ? { tokens: d.tokens.filter((t) => t.id !== id) } : d)),
      onSettled: done,
    }),
  };
}

// ---------------------------------------------------------------- apps connected through OAuth (hosted MCP)

export const useApps = () => useQuery({ queryKey: authKeys.apps, queryFn: () => api<{ apps: PublicApp[] }>('/api/auth/apps') });
export const useAdminApps = (enabled: boolean) =>
  useQuery({ queryKey: authKeys.adminApps, queryFn: () => api<{ apps: PublicApp[] }>('/api/admin/apps'), enabled });

export function useAppActions() {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: authKeys.apps });
    qc.invalidateQueries({ queryKey: authKeys.adminApps });
  };
  return {
    revoke: useMutation({
      mutationFn: ({ id, admin }: { id: string; admin?: boolean }) =>
        api(`/api/${admin ? 'admin' : 'auth'}/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onSettled: done,
    }),
  };
}

/** The consent screen's request (an app asking to connect). Under 'auth' so signing in doesn't drop it. */
export const useOAuthRequest = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: authKeys.oauth(id),
    queryFn: () => api<OAuthRequestView>(`/api/oauth/requests/${encodeURIComponent(id)}`),
    enabled,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** `workspace`: the one the screen named; the server grants only that one (a switch in another tab meanwhile: 409). */
export const useOAuthDecision = (id: string) =>
  useMutation({
    mutationFn: ({ allow, workspace }: { allow: boolean; workspace?: string }) =>
      api<{ redirect: string }>(`/api/oauth/requests/${encodeURIComponent(id)}`, { method: 'POST', body: { allow, ...(workspace ? { workspace } : {}) } }),
  });

// ---------------------------------------------------------------- accounts (owners and admins)

export const useUsers = (enabled: boolean) => useQuery({ queryKey: authKeys.users, queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users'), enabled });

export interface UserPatch {
  name?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
}

export function useUserActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: authKeys.users });
  return {
    // On a server with workspaces the answer is an invite to the address (it makes no account for someone else).
    create: useMutation({
      mutationFn: (b: { name: string; email: string; role: Role; password: string }) =>
        api<{ user?: PublicUser; invite?: PublicInvite; sent?: boolean }>('/api/admin/users', { method: 'POST', body: { ...b, lang: pageLang() } }),
      onSuccess: () => {
        done();
        qc.invalidateQueries({ queryKey: authKeys.invites });
      },
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UserPatch }) =>
        api<{ user: PublicUser }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onSuccess: done,
    }),
  };
}

// ---------------------------------------------------------------- invites

export const useInvites = (enabled: boolean) =>
  useQuery({ queryKey: authKeys.invites, queryFn: () => api<{ invites: PublicInvite[] }>('/api/admin/invites'), enabled });

export function useInviteActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: authKeys.invites });
  return {
    create: useMutation({
      /** `send`: email it to `email` too, in the language of this page. */
      mutationFn: (b: { role: Role; name?: string; email?: string; days?: number; send?: boolean }) =>
        api<InviteCreated>('/api/admin/invites', { method: 'POST', body: { ...b, ...(b.send ? { lang: pageLang() } : {}) } }),
      onSuccess: done,
    }),
    /** Email a pending invite (again) to its address. */
    send: useMutation({
      mutationFn: (id: string) =>
        api<{ invite: PublicInvite }>(`/api/admin/invites/${encodeURIComponent(id)}/send`, { method: 'POST', body: { lang: pageLang() } }),
      onSuccess: done,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api(`/api/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      onSuccess: done,
    }),
  };
}

// ---------------------------------------------------------------- email: sign-up, confirming an address, forgot password

/** The language emails asked for from this page speak (unless the account chose one). */
export const pageLang = (): 'en' | 'de' => (currentLang() === 'de' ? 'de' : 'en');

export const inviteLink = (id: string) => api<{ url: string }>(`/api/admin/invites/${encodeURIComponent(id)}/link`).then((r) => r.url);

// Under 'auth': signing in drops every other cached query, and the screen must not ask again for a used invite.
export const usePeekInvite = (token: string) =>
  useQuery({
    queryKey: authKeys.invite(token),
    queryFn: () => api<InvitePeek>('/api/auth/invite/peek', { method: 'POST', body: { token } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * Taking an invite. On a server with workspaces the link proves no inbox (whoever made the invite holds it too): unless
 * the address's account gave its own password, the answer is `{held: true}` — nobody signed in, the link mailed to the
 * address is the way in.
 */
export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { token: string; name: string; email: string; password: string }) =>
      api<SignedIn | { held: true }>('/api/auth/invite/accept', { method: 'POST', body: { ...b, lang: pageLang() } }),
    onSuccess: (r) => {
      if ('held' in r) return;
      // Into the library first, so the invite screen doesn't flash "already signed in".
      location.hash = '#/';
      afterSignIn(qc, signedInStatus(r));
    },
  });
}

// ---------------------------------------------------------------- connected agents (vr watch)

/**
 * `poll`: ask more often, e.g. while a page waits for an agent to connect (new agents, and an agent that starts or stops
 * listening, also arrive over SSE as `sessions`). `enabled`: only where an answer is shown.
 */
export const useAgents = (poll = 30_000, enabled = true) =>
  useQuery({ queryKey: authKeys.agents, queryFn: () => api<{ agents: ConnectedAgent[] }>('/api/agents'), refetchInterval: poll, enabled });
