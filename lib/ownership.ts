// Whose a note, a reference or an upload is: the account recorded with it (author_id, by_id, added_by_id), or — for
// records from before accounts were recorded, and local writes — the name. A rename keeps what is yours; a new account
// with a removed person's name gets none of it. Browser-safe: the server's rules and the UI's buttons use the same one.
export interface Owner {
  name?: string | null;
  id?: string | null;
}

export const isOwner = (name: string | undefined, id: string | undefined, me: Owner | null | undefined): boolean =>
  id ? !!me?.id && me.id === id : !!name && !!me?.name && name === me.name;

/** What decides whether a reply can still change (Reply in lib/types.ts). */
export interface ReplyShape {
  status?: string | null;
  answer?: unknown;
  preview?: string | null;
  fixed_in_v?: number | null;
  refs?: string[] | null;
}

/**
 * A reply its author may still change: plain words. A status change (a fix, a reopen, a verdict), picks from a
 * question's options and a fix preview stay as they happened — agents acted on them. `remove`: deleting it, which a
 * reply that brought references can't (they stay on the note, and the reply says why they're there).
 */
export const changeableReply = (r: ReplyShape, remove = false): boolean =>
  !r.status && !r.answer && !r.preview && r.fixed_in_v == null && !(remove && r.refs?.length);
