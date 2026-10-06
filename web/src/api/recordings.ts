// Recorded feedback (server/routes/recordings.ts): a person's recordings of this video that wait to be sent, made in two
// steps (the event log, then the audio), their drafts saved as they are edited, sent as notes or discarded.
import { useQuery } from '@tanstack/react-query';
import { api, enc } from './client.ts';
import { keys } from './queries.ts';
import type { Recording, RecordingDraft, RecordingEvent, RecordingSent, RecordingsResponse } from './types.ts';

const base = (slug: string) => `/api/review/${enc(slug)}/recordings`;

/** The recordings of this video waiting for you (a `recording` event says when one changes). */
export const useRecordings = (slug: string, enabled = true) =>
  useQuery({ queryKey: keys.recordings(slug), queryFn: () => api<RecordingsResponse>(base(slug)), enabled, staleTime: 5000 });

export async function uploadRecording(slug: string, v: number, take: { duration: number; events: RecordingEvent[]; audio: Blob }): Promise<Recording> {
  const rec = await api<Recording>(base(slug), { method: 'POST', body: { v, duration: take.duration, events: take.events } });
  return api<Recording>(`${base(slug)}/${rec.id}/audio`, { method: 'PUT', raw: take.audio });
}

export const saveDrafts = (slug: string, id: string, drafts: RecordingDraft[]) => api<Recording>(`${base(slug)}/${id}`, { method: 'PATCH', body: { drafts } });
export const sendRecording = (slug: string, id: string) => api<RecordingSent>(`${base(slug)}/${id}/send`, { method: 'POST', body: {} });
export const discardRecording = (slug: string, id: string) => api(`${base(slug)}/${id}`, { method: 'DELETE' });
export const hearAgain = (slug: string, id: string) => api<Recording>(`${base(slug)}/${id}/hear`, { method: 'POST' });
export const recordingAudio = (slug: string, id: string) => `${base(slug)}/${id}/audio`;
