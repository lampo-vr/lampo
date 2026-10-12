// Playbooks on the server (lib/playbooks.ts): one query per playbook, the list for badges, where they live. What
// people do to one (and a skill's own read) is api/playbookActions.ts: the playbook's pages ask for it, the library's
// first paint (the folder tabs' badges) doesn't.
import { type QueryClient, useQuery } from '@tanstack/react-query';
import type { PlaybookSummary, PlaybookView } from '../../../lib/types.ts';
import { api, enc } from './client.ts';

export const playbookKeys = {
  all: ['playbook'] as const,
  one: (scope: string) => ['playbook', 'scope', scope] as const,
  list: ['playbooks'] as const,
};

const playbookQuery = (scope: string) => ({ queryKey: playbookKeys.one(scope), queryFn: () => api<PlaybookView>(`/api/playbook?folder=${enc(scope)}`) });

export const usePlaybook = (scope: string, enabled = true) => useQuery({ ...playbookQuery(scope), enabled });

/** A folder's playbook asked for before its tab is opened (once the folder's page has painted): the tab opens drawn. */
export const prefetchPlaybook = (qc: QueryClient, scope: string) => void qc.prefetchQuery({ ...playbookQuery(scope), staleTime: 30_000 });

/** Every playbook with content or suggestions waiting (the folder tabs' badge). */
export const usePlaybooks = (enabled = true) =>
  useQuery({ queryKey: playbookKeys.list, queryFn: () => api<{ playbooks: PlaybookSummary[] }>('/api/playbooks'), enabled });

/** Where a playbook's reference pictures are served. */
export const playbookRefUrl = (scope: string, file: string) => `/api/playbook/refs/${enc(file)}?folder=${enc(scope)}`;
/** Where a skill's file is downloaded. */
export const skillFileUrl = (scope: string, skill: string, name: string) =>
  `/api/playbook/skill/files?folder=${enc(scope)}&skill=${enc(skill)}&name=${enc(name)}`;
/** The page a playbook lives on: the House's in Settings, a folder's beside its videos. */
export const playbookHref = (scope: string) => (scope ? `#/playbook/${enc(scope)}` : '#/settings/playbook');
