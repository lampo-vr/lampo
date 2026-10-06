// What a visitor of a review link does, and the name they go by (remembered in this browser, asked for once).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, enc } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import type { Approval, FrameRange, Shape } from '../api/types.ts';

const NAME = 'vr.guestName';

export function useGuestName(): [string, (n: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME) || '';
    } catch {
      return '';
    }
  });
  const save = (n: string) => {
    const v = n.trim().slice(0, 40);
    setName(v);
    try {
      if (v) localStorage.setItem(NAME, v);
      else localStorage.removeItem(NAME);
    } catch {}
  };
  return [name, save];
}

export interface NewNote {
  name: string;
  slug: string;
  v: number;
  frame: number;
  text: string;
  drawing: Shape[];
  idea?: boolean;
  /** A stretch of the video (frames of the version shown, both ends included). */
  range?: FrameRange;
  /** Links that come with the note (files follow through …/refs). */
  refs?: Record<string, unknown>[];
}

export function useGuestActions(token: string) {
  const qc = useQueryClient();
  // Everything behind this link: the link (counts in the room) and every review query.
  const refresh = () => qc.invalidateQueries({ queryKey: keys.guest(token) });
  const base = `/api/g/${token}`;
  return {
    refresh,
    note: useMutation({
      mutationFn: (b: NewNote) => api<{ id: string; timecode: string }>(`${base}/comments`, { method: 'POST', body: b }),
      onSettled: refresh,
    }),
    reply: useMutation({
      mutationFn: ({ id, ...b }: { id: string; name: string; text: string }) => api(`${base}/comments/${enc(id)}/replies`, { method: 'POST', body: b }),
      onSettled: refresh,
    }),
    check: useMutation({
      mutationFn: ({ id, ...b }: { id: string; name: string; verdict: 'confirm' | 'reopen'; text?: string }) =>
        api<{ status: string }>(`${base}/comments/${enc(id)}/check`, { method: 'POST', body: b }),
      onSettled: refresh,
    }),
    approve: useMutation({
      mutationFn: (b: { name: string; slug: string; v: number; status: 'approved' | 'changes'; note?: string }) =>
        api<{ approval: Approval | null }>(`${base}/approval`, { method: 'POST', body: b }),
      onSettled: refresh,
    }),
    unlock: useMutation({
      mutationFn: (password: string) => api(`${base}/unlock`, { method: 'POST', body: { password } }),
      onSuccess: refresh,
    }),
  };
}
