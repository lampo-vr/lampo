// Questions with options (lib/options.ts): one as the audition reads it (GET /api/asks/:id, a note's or a folder's),
// the folders' questions (GET /api/asks), and the answer. Only the options' own chunks import this: none of it is in
// the first paint.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AsksResponse, AskView, OptionAnswer } from '../../../lib/types.ts';
import { api, enc } from '../api/client.ts';
import { keys } from '../api/queries.ts';

/** Under 'asks': a live `asks` event or a folder's event refreshes all of them (api/live.ts). */
export const askKeys = {
  all: ['asks'] as const,
  one: (id: string) => ['asks', id] as const,
};

export const useAsk = (id: string) => useQuery({ queryKey: askKeys.one(id), queryFn: () => api<AskView>(`/api/asks/${enc(id)}`) });

/** The questions asked on folders before any render (the folder's pill). */
export const useFolderAsks = (enabled: boolean) => useQuery({ queryKey: askKeys.all, queryFn: () => api<AsksResponse>('/api/asks'), enabled });

/** The picks and the person's words: an answer like any other, so the agent's wait wakes at once. */
export function useAnswer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: OptionAnswer) => api<AskView>(`/api/asks/${enc(id)}/answer`, { method: 'POST', body: a }),
    onSuccess: (view) => {
      qc.setQueryData(askKeys.one(id), view);
      qc.invalidateQueries({ queryKey: askKeys.all });
      qc.invalidateQueries({ queryKey: keys.forYou });
      if (view.slug) qc.invalidateQueries({ queryKey: keys.review(view.slug) });
    },
  });
}
