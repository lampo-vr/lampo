// What the operator's pages ask the server (server/routes/operator.ts): every workspace, one opened, a plan set by hand;
// every account, one opened, disabled or enabled. Nothing of it is kept in this browser (the query cache's persisted
// part is for the library's own: api/persist.ts CORE), and a change answers with what the page shows next.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OperatorAccount,
  OperatorAccounts,
  OperatorWorkspaceDetail,
  OperatorWorkspaces,
  PlanOverrideKind,
  WorkspaceDeletionPlan,
} from '../../../lib/types.ts';
import { ApiError, api } from '../api/client.ts';

export const opKeys = {
  workspaces: ['operator', 'workspaces'] as const,
  workspace: (id: string) => ['operator', 'workspace', id] as const,
  accounts: ['operator', 'accounts'] as const,
  account: (id: string) => ['operator', 'account', id] as const,
};

/** A refusal (no such page, no such id) is an answer: never asked again. */
const retry = (n: number, e: unknown) => !(e instanceof ApiError && e.status < 500) && n < 2;

/** Whether an answer means "there is no such page here" for this person (not the operator, or signed out). */
export const refused = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);

export const useOpWorkspaces = () =>
  useQuery({ queryKey: opKeys.workspaces, queryFn: () => api<OperatorWorkspaces>('/api/operator/workspaces'), retry, staleTime: 30_000 });

export const useOpWorkspace = (id: string) =>
  useQuery({
    queryKey: opKeys.workspace(id),
    queryFn: () => api<OperatorWorkspaceDetail>(`/api/operator/workspaces/${encodeURIComponent(id)}`),
    retry,
    staleTime: 15_000,
  });

export const useOpAccounts = () =>
  useQuery({ queryKey: opKeys.accounts, queryFn: () => api<OperatorAccounts>('/api/operator/accounts'), retry, staleTime: 30_000 });

export const useOpAccount = (id: string) =>
  useQuery({
    queryKey: opKeys.account(id),
    queryFn: async () => (await api<{ account: OperatorAccount }>(`/api/operator/accounts/${encodeURIComponent(id)}`)).account,
    retry,
    staleTime: 15_000,
  });

/** What the plan form sends: an override with its reason, or back to normal billing. */
export type PlanAsk = (PlanOverrideKind | { kind: 'normal' }) & { reason: string };

/** Sets a workspace's plan by hand; the answer is the workspace's page, and its row in the list follows. */
export function useSetPlan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ask: PlanAsk) => api<OperatorWorkspaceDetail>(`/api/operator/workspaces/${encodeURIComponent(id)}/plan`, { method: 'POST', body: ask }),
    onSuccess: (d) => {
      qc.setQueryData(opKeys.workspace(id), d);
      qc.setQueryData<OperatorWorkspaces>(
        opKeys.workspaces,
        (old) => old && { ...old, workspaces: old.workspaces.map((w) => (w.id === id ? d.workspace : w)) },
      );
    },
  });
}

/** Disables or enables an account; its row, its page and the members lists that show it follow. */
export function useAccess(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (disable: boolean) =>
      api<{ account: OperatorAccount }>(`/api/operator/accounts/${encodeURIComponent(id)}/${disable ? 'disable' : 'enable'}`, { method: 'POST', body: {} }),
    onSuccess: ({ account }) => {
      qc.setQueryData(opKeys.account(id), account);
      qc.setQueryData<OperatorAccounts>(opKeys.accounts, (old) => old && { accounts: old.accounts.map((a) => (a.id === id ? account : a)) });
      for (const w of account.workspaces) void qc.invalidateQueries({ queryKey: opKeys.workspace(w.id) });
      void qc.invalidateQueries({ queryKey: opKeys.workspaces });
    },
  });
}

/** What deleting a workspace takes with it, counted: asked when the dialog opens, never kept (it changes as people work). */
export const useDeletionPlan = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ['operator', 'deletion', id],
    queryFn: () => api<WorkspaceDeletionPlan>(`/api/operator/workspaces/${encodeURIComponent(id)}/deletion`),
    enabled,
    retry,
    staleTime: 0,
    gcTime: 0,
  });

/** Suspends a workspace (a reason) or lifts it (null); its page and its row follow. */
export function useSuspend(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string | null) =>
      api<OperatorWorkspaceDetail>(`/api/operator/workspaces/${encodeURIComponent(id)}/${reason === null ? 'unsuspend' : 'suspend'}`, {
        method: 'POST',
        body: reason === null ? {} : { reason },
      }),
    onSuccess: (d) => {
      qc.setQueryData(opKeys.workspace(id), d);
      qc.setQueryData<OperatorWorkspaces>(
        opKeys.workspaces,
        (old) => old && { ...old, workspaces: old.workspaces.map((w) => (w.id === id ? d.workspace : w)) },
      );
    },
  });
}

/** Deletes a workspace (its name typed, a reason): it leaves the list, its page and the accounts it took along. */
export function useDeleteWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ask: { name: string; reason: string }) =>
      api<{ deleted: { id: string; name: string }; accountsGone: number }>(`/api/operator/workspaces/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        body: ask,
      }),
    onSuccess: () => {
      qc.setQueryData<OperatorWorkspaces>(opKeys.workspaces, (old) => old && { ...old, workspaces: old.workspaces.filter((w) => w.id !== id) });
      qc.removeQueries({ queryKey: opKeys.workspace(id) });
      void qc.invalidateQueries({ queryKey: opKeys.accounts });
    },
  });
}
