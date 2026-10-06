// Workspaces' writes and lists for the screens that change them (Settings → Workspace, the invite screen): switching
// with a pending state, making one, naming the current one, the list with what the person may do. A hosted server only.
// Switching itself (and what a switch does to this browser) is auth/Workspaces.tsx's, the switcher's.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { arrive, switchWorkspace } from '../auth/Workspaces.tsx';
import { authKeys, useAuthStatus } from './auth.ts';
import { api } from './client.ts';
import type { AuthStatus, MyWorkspace, WorkspacesResponse } from './types.ts';

export const workspacesKey = ['auth', 'workspaces'] as const;

/** The list with what this person may do (make one): Settings → Workspace. */
export const useWorkspaceList = (enabled = true) =>
  useQuery({ queryKey: workspacesKey, queryFn: () => api<WorkspacesResponse>('/api/workspaces'), enabled, staleTime: 30_000 });

/** Switching, as a mutation (a pending state for the button that asked). */
export function useSwitchWorkspace() {
  const status = useAuthStatus().data;
  return useMutation({
    mutationFn: async (id: string) => {
      if (status?.user) await switchWorkspace(id, status.user.id);
    },
  });
}

/** A new workspace, owned by the person; the session moves into it. */
export function useCreateWorkspace() {
  const status = useAuthStatus().data;
  return useMutation({
    mutationFn: (name: string) => api<{ workspace: MyWorkspace }>('/api/workspaces', { method: 'POST', body: { name } }),
    onSuccess: async ({ workspace }) => {
      if (status?.user) await arrive(status.user.id, workspace.id);
    },
  });
}

/** Naming the workspace one works in (owners and admins). */
export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ workspace: MyWorkspace }>('/api/workspaces/current', { method: 'PATCH', body: { name } }),
    onSuccess: ({ workspace }) => {
      qc.setQueryData<AuthStatus>(authKeys.status, (s) =>
        s ? { ...s, workspace, workspaces: s.workspaces?.map((w) => (w.id === workspace.id ? workspace : w)) } : s,
      );
      void qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}
