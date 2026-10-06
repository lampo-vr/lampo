// References on notes (lib/refs.ts) as the UI shows them, the same for the owner's player and a client's review page:
// one view shape, built from a stored NoteRef (the owner's URLs) or from what a review link sends (its own URLs).
import { isOwner, type Owner } from '../../../lib/ownership.ts';
import { enc } from '../api/client.ts';
import type { GuestRef, NoteRef } from '../api/types.ts';

export interface ViewRef {
  id: string;
  kind: NoteRef['kind'];
  caption: string | null;
  by: string;
  /** Who may remove it here (the note's author, who added it, a client's own). */
  mine: boolean;
  /** image / clip: the file; image / clip / frame: the still (thumbnails, and what a frame shows). */
  src: string | null;
  still: string | null;
  /** A range's last frame. */
  end: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  url: string | null;
  site: string | null;
  /** frame: which render and where ("other.mp4 · V3 · 00:00:12"), and the player link (owner only). */
  where: string | null;
  open: string | null;
  goto: GotoFrame | null;
}

/** A frame reference opened in the player: through its address, or — when the player shows that video already, where
 * the same address would change nothing — as this window event the player answers by switching version and seeking. */
export const GOTO_FRAME = 'vr-goto-frame';
export interface GotoFrame {
  slug: string;
  v: number;
  frame: number;
}

const file = (slug: string, f: string | undefined) => (f ? `/api/refs/${enc(slug)}/${f}` : null);

/** The owner's view of a note's references: files from /api/refs, frames open in the player. */
export function ownerRefs(slug: string, refs: NoteRef[] | undefined, me: Owner | null): ViewRef[] {
  return (refs || []).map((r) => ({
    id: r.id,
    kind: r.kind,
    caption: r.caption ?? null,
    by: r.by,
    mine: isOwner(r.by, r.by_id, me),
    src: r.kind === 'image' || r.kind === 'clip' ? file(slug, r.file) : null,
    still: file(slug, r.still),
    end: file(slug, r.end),
    width: r.width ?? null,
    height: r.height ?? null,
    duration: r.duration ?? null,
    url: r.url ?? null,
    site: r.site ?? null,
    where: r.kind === 'frame' ? `${r.name} · V${r.v} · ${r.timecode}` : null,
    open: r.kind === 'frame' && r.video ? `#/v/${enc(r.video)}?v=${r.v}&f=${r.frame}` : null,
    goto: r.kind === 'frame' && r.video && r.v !== undefined && r.frame !== undefined ? { slug: r.video, v: r.v, frame: r.frame } : null,
  }));
}

/** A client's view: files through the review link, no player links. */
export function guestRefs(refs: GuestRef[] | undefined): ViewRef[] {
  return (refs || []).map((r) => ({
    id: r.id,
    kind: r.kind,
    caption: r.caption,
    by: r.by,
    mine: r.mine,
    src: r.src,
    still: r.still,
    end: null,
    width: r.width,
    height: r.height,
    duration: r.duration,
    url: r.url,
    site: r.site,
    where: r.kind === 'frame' ? `${r.name} · V${r.v} · ${r.timecode}` : null,
    open: null,
    goto: null,
  }));
}

/** The references that came with a reply, and those that belong to the note itself. */
export function splitRefs<T extends { id: string }>(refs: T[], replies: { refs?: string[] }[]): { own: T[]; byReply: (ids: string[] | undefined) => T[] } {
  const inReplies = new Set(replies.flatMap((r) => r.refs || []));
  return {
    own: refs.filter((r) => !inReplies.has(r.id)),
    byReply: (ids) => (ids?.length ? refs.filter((r) => ids.includes(r.id)) : []),
  };
}

// ---------------------------------------------------------------- what a composer holds before the note is saved

/** A reference picked in a composer, sent once the note exists (links and moments with it, files right after). */
export type PendingRef =
  | { key: string; kind: 'file'; file: File; caption: string; preview: string | null }
  | { key: string; kind: 'link'; url: string; caption: string }
  | { key: string; kind: 'frame'; video: string; v: number; frame: number; to_frame?: number; caption: string; label: string; still: string };

let seq = 0;
export const pendingKey = (): string => `p${++seq}`;

/** Only pictures and motion; anything else is refused before it is sent. */
export const acceptsFile = (f: File): boolean =>
  /^(image\/(png|jpe?g|webp|gif)|video\/)/.test(f.type) || /\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm|mkv)$/i.test(f.name);
