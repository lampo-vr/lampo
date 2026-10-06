// Notes not sent yet (server/routes/drafts.ts): yours only, kept on the server until you send them — one batch with
// everything else you kept on the video, and what your recordings said. A change is told to your own tabs only (the
// `drafts` event, api/live.ts).
import { useQuery } from '@tanstack/react-query';
import { api, enc } from './client.ts';
import type { NewComment } from './mutations.ts';
import { keys } from './queries.ts';
import type { Comment, DraftsResponse, DraftsSent, Severity, UnsentResponse } from './types.ts';

const base = (slug: string) => `/api/review/${enc(slug)}/drafts`;

/** Your drafts on this video, oldest first. */
export const useDrafts = (slug: string, enabled = true) =>
  useQuery({ queryKey: keys.drafts(slug), queryFn: () => api<DraftsResponse>(base(slug)), enabled, staleTime: 5000 });

/** How many notes you haven't sent, per video (drafts and what your recordings said). */
export const useUnsent = (enabled = true) => useQuery({ queryKey: keys.unsent, queryFn: () => api<UnsentResponse>('/api/drafts'), enabled, staleTime: 5000 });

export const saveDraft = (slug: string, body: NewComment) => api<Comment>(base(slug), { method: 'POST', body });

export interface DraftPatch {
  text?: string;
  tags?: string[];
  severity?: Severity;
}
export const editDraft = (slug: string, id: string, patch: DraftPatch) => api<Comment>(`${base(slug)}/${id}`, { method: 'PATCH', body: patch });
export const deleteDraft = (slug: string, id: string) => api(`${base(slug)}/${id}`, { method: 'DELETE' });

/**
 * Everything you kept on the video, and your recordings' drafts, as one batch — or only the drafts named (`ids`) and
 * the recordings' drafts named (`recordings`: a list; true = all of them, the default); `start` also starts its agent.
 */
export const sendDrafts = (slug: string, o: { ids?: string[]; recordings?: boolean | string[]; start?: boolean } = {}) =>
  api<DraftsSent>(`${base(slug)}/send`, {
    method: 'POST',
    body: { recordings: o.recordings ?? true, ...(o.ids ? { ids: o.ids } : {}), ...(o.start ? { start: true } : {}) },
  });

/** A draft's screenshot or voice note (its author's only). */
export const draftFile = (slug: string, id: string, file: string) => `${base(slug)}/${id}/${file}`;
