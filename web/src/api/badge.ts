// "Powered by Lampo" on the workspace's review links (A13 CLOUD-7): whether they show it, whether its admins hid it, and
// whether its plan may (a paid one). Settings → Review links changes it; the link-opened moment (conversion/Value.tsx)
// says what visitors see. A module of its own, so the moment's chunk takes nothing of the workspace switcher with it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BadgeSetting } from '../../../lib/types.ts';
import { api } from './client.ts';

const badgeKey = ['workspace', 'badge'] as const;

export const useBadge = (enabled = true) =>
  useQuery({ queryKey: badgeKey, queryFn: () => api<BadgeSetting>('/api/workspaces/current/badge'), enabled, staleTime: 30_000 });

/** Hides the badge or shows it again (owners and admins, on a plan that may): the switch moves at once, back on a refusal. */
export function useSetBadge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hidden: boolean) => api<BadgeSetting>('/api/workspaces/current/badge', { method: 'PUT', body: { hidden } }),
    onMutate: (hidden) => {
      const before = qc.getQueryData<BadgeSetting>(badgeKey);
      if (before) qc.setQueryData<BadgeSetting>(badgeKey, { ...before, hidden, shown: !(hidden && before.may) });
      return { before };
    },
    onError: (_e, _hidden, c) => {
      if (c?.before) qc.setQueryData(badgeKey, c.before);
    },
    onSuccess: (now) => qc.setQueryData(badgeKey, now),
  });
}
