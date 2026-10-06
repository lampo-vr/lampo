// Sending references (lib/refs.ts): links and moments as JSON; files through a one-time upload URL (one PUT, with
// progress), for the owner's notes and for a client's through their review link.
import { api, enc } from '../api/client.ts';
import type { NoteRef } from '../api/types.ts';
import type { PendingRef } from './model.ts';

/** Where a note's references go: the owner's API, or a review link (with the visitor's name). */
export type RefTarget =
  | { kind: 'owner'; comment: string }
  | { kind: 'guest'; token: string; comment: string; name: string }
  /** One of your drafts on this video (api/drafts.ts). */
  | { kind: 'draft'; slug: string; comment: string };

const endpoint = (t: RefTarget) =>
  t.kind === 'owner'
    ? `/api/comments/${t.comment}/refs`
    : t.kind === 'draft'
      ? `/api/review/${enc(t.slug)}/drafts/${t.comment}/refs`
      : `/api/g/${enc(t.token)}/comments/${t.comment}/refs`;
const named = (t: RefTarget, body: Record<string, unknown>) => (t.kind === 'guest' ? { ...body, name: t.name } : body);

/** A link or a moment to add as JSON (the body a note creation takes, too). */
export function inlineBody(p: PendingRef): Record<string, unknown> | null {
  if (p.kind === 'link') return { kind: 'link', url: p.url, ...(p.caption ? { caption: p.caption } : {}) };
  if (p.kind === 'frame')
    return {
      kind: 'frame',
      video: p.video,
      v: p.v,
      frame: p.frame,
      ...(p.to_frame !== undefined ? { to_frame: p.to_frame } : {}),
      ...(p.caption ? { caption: p.caption } : {}),
    };
  return null;
}

// PUT with upload progress (fetch has none); the URL is made relative to this page, which may be reached under another
// name than the server's public URL (a tunnel, a proxy).
function put(url: string, file: File, onProgress?: (share: number) => void): Promise<{ ref: NoteRef }> {
  const path = new URL(url, location.href).pathname;
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', path);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = async () => {
      let out: { ref?: NoteRef; error?: string; pending?: boolean } = {};
      try {
        out = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 400) return reject(new Error(out.error || `upload failed (${x.status})`));
      // Long clips are processed after the upload: the same URL answers once they're done.
      for (let i = 0; out.pending && i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const again = await fetch(path);
        out = await again.json().catch(() => ({}));
        if (again.status === 422) return reject(new Error(out.error || 'the file was refused'));
      }
      out.ref ? resolve({ ref: out.ref }) : reject(new Error(out.error || 'the server is still working on it'));
    };
    x.onerror = () => reject(new Error('the upload broke off'));
    x.send(file);
  });
}

/** Adds one reference to an existing note; `note` makes it a reply. */
export async function sendRef(t: RefTarget, p: PendingRef, o: { note?: string; onProgress?: (share: number) => void } = {}): Promise<NoteRef | null> {
  const note = o.note ? { note: o.note } : {};
  const inline = inlineBody(p);
  if (inline) return (await api<{ ref: NoteRef }>(endpoint(t), { method: 'POST', body: named(t, { ...inline, ...note }) })).ref;
  if (p.kind !== 'file') return null;
  const { upload } = await api<{ upload: { url: string } }>(endpoint(t), {
    method: 'POST',
    body: named(t, { kind: 'file', ...(p.caption ? { caption: p.caption } : {}), ...note }),
  });
  return (await put(upload.url, p.file, o.onProgress)).ref;
}

export const removeRef = (t: RefTarget, id: string) => api(`${endpoint(t)}/${id}`, { method: 'DELETE' });
export const captionRef = (comment: string, id: string, caption: string) => api(`/api/comments/${comment}/refs/${id}`, { method: 'PATCH', body: { caption } });
