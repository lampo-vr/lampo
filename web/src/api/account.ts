// The email flows (server mode): sign-up, confirming an address, forgot password, a new address called off; and your
// data — exporting it, deleting your account or the workspace you own. Only the screens that use them load this
// (auth/AccountScreens.tsx, Settings → Profile and Workspace): none of it is in the first paint.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDeletionPlan, SignupPlan, WorkspaceDeletionPlan } from '../../../lib/types.ts';
import { planIn } from '../auth/signupLink.ts';
import { afterSignIn, afterSignOut, authKeys, pageLang } from './auth.ts';
import { ApiError, api } from './client.ts';
import type { AuthStatus, PublicUser, Role } from './types.ts';

/** The plan the website's sign-up link named (`?plan=`, in the address's query or the hash's): known ids only. */
export const signupPlan = (): SignupPlan | undefined => planIn(location.hash, location.search);

/** Sign-up answers the same for every address (`{ok: true}`) and signs nobody in: the emailed link does. */
export const useSignUp = () =>
  useMutation({
    mutationFn: (b: { name?: string; email: string; password?: string }) => {
      const plan = signupPlan();
      return api<{ ok: true }>('/api/auth/signup', { method: 'POST', body: { ...b, lang: pageLang(), ...(plan ? { plan } : {}) } });
    },
  });

/** A reset link to the address, if it has an account (the answer is the same either way). */
export const useForgot = () =>
  useMutation({ mutationFn: (email: string) => api<{ ok: true }>('/api/auth/forgot', { method: 'POST', body: { email, lang: pageLang() } }) });

/** The confirm link again: signed in, to your own unconfirmed or new address; signed out, for `email`. */
export const useResend = () =>
  useMutation({
    mutationFn: (email?: string) =>
      api<{ ok: true; to?: string }>('/api/auth/verify/resend', { method: 'POST', body: { ...(email ? { email } : {}), lang: pageLang() } }),
  });

/** What a reset link is for, before its form shows (the link isn't spent by looking). */
export const useResetPeek = (token: string) =>
  useQuery({
    queryKey: ['auth', 'reset', token] as const,
    queryFn: () => api<{ email: string; expires: string }>('/api/auth/reset/peek', { method: 'POST', body: { token } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { token: string; password: string }) => api<{ user: PublicUser }>('/api/auth/reset', { method: 'POST', body: b }),
    onSuccess: ({ user }) => afterSignIn(qc, { mode: 'server', setup: false, user, via: 'cookie' }),
  });
}

export interface VerifyResult {
  kind: 'confirmed' | 'changed';
  email: string;
  /** A sign-up was let in by this link. */
  released: boolean;
  /** This browser was signed in by it. */
  signedIn: boolean;
  user: PublicUser;
}

/**
 * What a held account's confirm page is told when it was opened anywhere but the browser that chose its password (a
 * 409, or a 403 for a wrong one): the masked address and what confirming would join.
 */
export interface VerifyAsks {
  state: 'password';
  email: string;
  joins: { workspace?: string; by: string; role: Role }[];
}

/** Confirming an address: the link alone, or — for a held account opened elsewhere — its password, or a new one. */
export function useVerifyLink() {
  const qc = useQueryClient();
  return useMutation({
    // the page's language: a new workspace's sample is written in it
    mutationFn: (b: { token: string; password?: string; new_password?: string }) =>
      api<VerifyResult>('/api/auth/verify', { method: 'POST', body: { ...b, lang: pageLang() } }),
    onSuccess: (r) => {
      if (r.signedIn) afterSignIn(qc, { mode: 'server', setup: false, user: r.user, via: 'cookie' });
      // Signed in here as that account already: its new address or confirmation shows at once.
      else qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s?.user?.id === r.user.id ? { ...s, user: r.user } : s));
    },
  });
}

/** A new address waiting for its link is dropped; the account keeps the one it has. */
export function useCancelEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ user: PublicUser }>('/api/auth/email/cancel', { method: 'POST' }),
    onSuccess: ({ user }) => qc.setQueryData<AuthStatus>(authKeys.status, (s) => (s ? { ...s, user } : s)),
  });
}

// ---------------------------------------------------------------- your data (A13 PEOPLE-1)

/** What deleting your account means: the workspaces that go with it, those you leave, those you must hand over first. */
export const useAccountDeletion = (enabled = true) =>
  useQuery({ queryKey: ['auth', 'me', 'deletion'], queryFn: () => api<AccountDeletionPlan>('/api/auth/me/deletion'), enabled, staleTime: 0 });

/** Deletes your account (your password, or a sign-in this moment): the server signs this browser out; so does the page. */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string | null) =>
      api<{ deleted: true; workspaces: number }>('/api/auth/me/delete', { method: 'POST', body: password === null ? { confirm: true } : { password } }),
    onSuccess: () => afterSignOut(qc),
  });
}

/** What deleting the workspace you work in takes with it (its owner asks). */
export const useWorkspaceDeletion = (enabled: boolean) =>
  useQuery({
    queryKey: ['auth', 'workspace', 'deletion'],
    queryFn: () => api<WorkspaceDeletionPlan>('/api/workspaces/current/deletion'),
    enabled,
    staleTime: 0,
  });

/**
 * Deletes the workspace you work in (its name typed): your account may have gone with it (you worked nowhere else: this
 * browser is signed out), else the page starts again in your next workspace.
 */
export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ deleted: true; account: boolean }>('/api/workspaces/current/delete', { method: 'POST', body: { name } }),
    onSuccess: async ({ account }) => {
      if (account) return afterSignOut(qc);
      const s = await api<AuthStatus>('/api/auth/status');
      const { arrive } = await import('../auth/Workspaces.tsx');
      if (s.user && s.workspace) await arrive(s.user.id, s.workspace.id);
    },
  });
}

/**
 * Your data as a zip, saved by the browser: fetched first, so a refusal (too many this hour) reads as a sentence instead
 * of a file of JSON.
 */
export async function exportMyData(): Promise<void> {
  const res = await fetch('/api/auth/me/export');
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error || `HTTP ${res.status}`, res.status, Number(res.headers.get('retry-after')) || null, {});
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'lampo-data.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
