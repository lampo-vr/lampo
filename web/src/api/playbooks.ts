// Playbooks on the server (lib/playbooks.ts): one query per playbook, the list for badges, one suggestion; every
// write answers with the playbook as it now stands, which goes straight into the cache (the stream settles the rest).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteRef, Playbook, PlaybookProposalView, PlaybookRevision, PlaybookSkillView, PlaybookSummary, PlaybookView } from '../../../lib/types.ts';
import { api, enc } from './client.ts';
import { keys } from './queries.ts';

export const playbookKeys = {
  all: ['playbook'] as const,
  one: (scope: string) => ['playbook', 'scope', scope] as const,
  proposal: (id: string) => ['playbook', 'proposal', id] as const,
  list: ['playbooks'] as const,
};

export const usePlaybook = (scope: string, enabled = true) =>
  useQuery({ queryKey: playbookKeys.one(scope), queryFn: () => api<PlaybookView>(`/api/playbook?folder=${enc(scope)}`), enabled });

/** Every playbook with content or suggestions waiting (the folder tabs' badge). */
export const usePlaybooks = (enabled = true) =>
  useQuery({ queryKey: playbookKeys.list, queryFn: () => api<{ playbooks: PlaybookSummary[] }>('/api/playbooks'), enabled });

/** One skill as it applies to a playbook (its own or inherited), with its instructions. */
export const useSkill = (scope: string, name: string | null) =>
  useQuery({
    queryKey: ['playbook', 'skill', scope, name || ''],
    queryFn: () => api<PlaybookSkillView>(`/api/playbook/skill?folder=${enc(scope)}&name=${enc(name || '')}`),
    enabled: !!name,
  });

export const useProposal = (id: string | null) =>
  useQuery({ queryKey: playbookKeys.proposal(id || ''), queryFn: () => api<PlaybookProposalView>(`/api/playbook/proposals/${enc(id || '')}`), enabled: !!id });

/** A file as base64 (the API takes small files inline). */
export async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Saved = { rev: PlaybookRevision | null; playbook: Playbook };

export interface SkillBody {
  name: string;
  description: string;
  body: string;
  extra?: string;
  rename_from?: string;
  message?: string;
  base_rev?: number;
}

/** What people do to a playbook; each call puts the playbook it answers with into the cache. */
export function usePlaybookActions(scope: string) {
  const qc = useQueryClient();
  const keep = (out: Saved) => {
    qc.setQueryData<PlaybookView>(playbookKeys.one(scope), (v) => (v ? { ...v, playbook: out.playbook } : v));
    // What it inherits, the merged markdown and the stamp come with the next read.
    void qc.invalidateQueries({ queryKey: playbookKeys.all });
    void qc.invalidateQueries({ queryKey: playbookKeys.list });
    return out;
  };
  const decided = () => {
    void qc.invalidateQueries({ queryKey: playbookKeys.all });
    void qc.invalidateQueries({ queryKey: playbookKeys.list });
    void qc.invalidateQueries({ queryKey: keys.forYou });
  };
  return {
    writeText: (section: 'brief' | 'rules', content: string, o: { message?: string; base_rev?: number } = {}) =>
      api<Saved>('/api/playbook/text', { method: 'PUT', body: { folder: scope, section, content, ...o } }).then(keep),
    putSkill: (s: SkillBody) => api<Saved>('/api/playbook/skill', { method: 'PUT', body: { folder: scope, ...s } }).then(keep),
    importSkill: (markdown: string) => api<Saved>('/api/playbook/skill', { method: 'PUT', body: { folder: scope, markdown } }).then(keep),
    deleteSkill: (name: string) => api<Saved>(`/api/playbook/skill?folder=${enc(scope)}&name=${enc(name)}`, { method: 'DELETE' }).then(keep),
    addFile: async (skill: string, file: File) =>
      keep(await api<Saved>('/api/playbook/skill/files', { method: 'POST', body: { folder: scope, skill, name: file.name, data: await base64(file) } })),
    removeFile: (skill: string, name: string) =>
      api<Saved>(`/api/playbook/skill/files?folder=${enc(scope)}&skill=${enc(skill)}&name=${enc(name)}`, { method: 'DELETE' }).then(keep),
    addLink: (url: string, caption?: string) =>
      api<Saved & { ref: NoteRef }>('/api/playbook/refs', { method: 'POST', body: { folder: scope, kind: 'link', url, caption } }).then(keep),
    addImage: async (file: File, caption?: string) =>
      keep(
        await api<Saved & { ref: NoteRef }>('/api/playbook/refs', {
          method: 'POST',
          body: { folder: scope, kind: 'image', caption, data: await base64(file) },
        }),
      ),
    addFrame: (video: string, frame: number, v?: number, caption?: string) =>
      api<Saved & { ref: NoteRef }>('/api/playbook/refs', { method: 'POST', body: { folder: scope, kind: 'frame', video, frame, v, caption } }).then(keep),
    removeRef: (id: string) => api<Saved>(`/api/playbook/refs?folder=${enc(scope)}&id=${enc(id)}`, { method: 'DELETE' }).then(keep),
    // Refused (someone changed that section since it was made): the diff is read again against what it says now.
    accept: (id: string, message?: string) =>
      api(`/api/playbook/proposals/${enc(id)}/accept`, { method: 'POST', body: message ? { message } : {} }).then(decided, (e: unknown) => {
        decided();
        throw e;
      }),
    reject: (id: string, reason?: string) => api(`/api/playbook/proposals/${enc(id)}/reject`, { method: 'POST', body: reason ? { reason } : {} }).then(decided),
  };
}

/** Where a playbook's reference pictures are served. */
export const playbookRefUrl = (scope: string, file: string) => `/api/playbook/refs/${enc(file)}?folder=${enc(scope)}`;
/** Where a skill's file is downloaded. */
export const skillFileUrl = (scope: string, skill: string, name: string) =>
  `/api/playbook/skill/files?folder=${enc(scope)}&skill=${enc(skill)}&name=${enc(name)}`;
/** The page a playbook lives on: the House's in Settings, a folder's beside its videos. */
export const playbookHref = (scope: string) => (scope ? `#/playbook/${enc(scope)}` : '#/settings/playbook');
