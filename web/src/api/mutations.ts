// Writes. The screen changes at once (optimistic, rolled back to the old data when the server says no), the answer
// replaces the guess, and live.ts then fetches exactly what changed — once, together with the server's own events about
// the same write (they arrive in the same moment; another tab may hold the event stream).
import { type QueryClient, type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { frameToTime, timecode } from '../../../lib/time.ts';
import { api, enc } from './client.ts';
import { live } from './live.ts';
import { keys } from './queries.ts';
import type {
  AgentRunInfo,
  Comment,
  FrameRange,
  LibraryResponse,
  PartRequest,
  Reply,
  ReviewResponse,
  SessionPick,
  Severity,
  Shape,
  ShareInfo,
  ShareInput,
  Status,
  TextEdit,
  VideoSummary,
  WebhookDelivery,
  WebhookFormat,
  WebhookInfo,
} from './types.ts';

function useInvalidate() {
  const qc = useQueryClient();
  return (...list: (readonly unknown[])[]) => Promise.all(list.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** After a write: this video's review and library entry follow (live.ts), or — without it — are refetched. */
export function useSettle() {
  const qc = useQueryClient();
  const inv = (...list: (readonly unknown[])[]) => {
    for (const queryKey of list) qc.invalidateQueries({ queryKey });
  };
  return {
    review: (slug: string) => {
      const l = live();
      if (l) l.review(slug);
      else inv(keys.review(slug), keys.library);
    },
    entry: (slug: string) => {
      const l = live();
      if (l) l.entry(slug);
      else inv(keys.library);
    },
    library: () => {
      const l = live();
      if (l) l.library();
      else inv(keys.library);
    },
  };
}

/**
 * An optimistic change to one cached query: running fetches of it are cancelled (they'd overwrite the guess), `change`
 * applies to what is there, and the returned undo puts the old data back.
 */
export async function guess<T>(qc: QueryClient, queryKey: QueryKey, change: (old: T) => T): Promise<() => void> {
  await qc.cancelQueries({ queryKey, exact: true });
  const before = qc.getQueryData<T>(queryKey);
  if (before !== undefined) qc.setQueryData<T>(queryKey, change(before));
  return () => {
    if (before !== undefined) qc.setQueryData(queryKey, before);
  };
}
const undoAll = (undo: (() => void)[] | undefined) => {
  for (const u of undo || []) u();
};

/** The library as it looks once `slug`'s entry changed (`null` takes it out). */
export const withEntry =
  (slug: string, change: (v: VideoSummary) => VideoSummary | null) =>
  (old: LibraryResponse): LibraryResponse => ({
    ...old,
    videos: old.videos.flatMap((v) => {
      if (v.slug !== slug) return [v];
      const next = change(v);
      return next ? [next] : [];
    }),
  });

export function useVideoActions() {
  const qc = useQueryClient();
  const settle = useSettle();
  const assign = useMutation({
    mutationFn: ({ slug, session }: { slug: string; session: SessionPick | null }) =>
      api(`/api/review/${enc(slug)}/session`, { method: 'PUT', body: session || {} }),
    onSettled: (_d, _e, { slug }) => settle.review(slug),
  });
  // Archiving (a video with notes) or removing it (without): off the list at once, back if the server says no.
  const remove = useMutation({
    mutationFn: (slug: string) => api<{ ok: boolean; archived: boolean }>(`/api/library/${enc(slug)}`, { method: 'DELETE' }),
    onMutate: async (slug: string) => [
      await guess<LibraryResponse>(
        qc,
        keys.library,
        withEntry(slug, (v) => (v.counts.total ? { ...v, archived: true } : null)),
      ),
    ],
    onError: (_e, _v, undo) => undoAll(undo),
    onSettled: (_d, _e, slug) => settle.entry(slug),
  });
  // Undo for an archive: the video is back in the library with its review.
  const restore = useMutation({
    mutationFn: (slug: string) => api(`/api/library/${enc(slug)}/restore`, { method: 'POST' }),
    onMutate: async (slug: string) => [
      await guess<LibraryResponse>(
        qc,
        keys.library,
        withEntry(slug, (v) => ({ ...v, archived: null })),
      ),
    ],
    onError: (_e, _v, undo) => undoAll(undo),
    onSettled: (_d, _e, slug) => settle.entry(slug),
  });
  const move = useMutation({
    mutationFn: ({ slug, folder }: { slug: string; folder: string | null }) => api(`/api/review/${enc(slug)}/folder`, { method: 'PUT', body: { folder } }),
    onMutate: async ({ slug, folder }: { slug: string; folder: string | null }) => [
      await guess<LibraryResponse>(qc, keys.library, (old) => ({
        folders: folder && !old.folders.includes(folder) ? [...old.folders, folder].sort() : old.folders,
        videos: old.videos.map((v) => (v.slug === slug ? { ...v, folder } : v)),
      })),
    ],
    onError: (_e, _v, undo) => undoAll(undo),
    onSettled: (_d, _e, { slug }) => settle.review(slug),
  });
  const autoSort = useMutation({
    mutationFn: () => api<{ moved: number }>('/api/folders/auto', { method: 'POST' }),
    onSettled: () => settle.library(),
  });
  return { assign, remove, restore, move, autoSort };
}

/** `folder` after renaming `from` to `to` (a folder's path starts with its parents, so the ones inside move along). */
const renamed = (folder: string | null, from: string, to: string): string | null =>
  folder === from ? to : folder?.startsWith(`${from}/`) ? `${to}${folder.slice(from.length)}` : folder;

export function useFolderActions() {
  const qc = useQueryClient();
  const settle = useSettle();
  const onError = (_e: unknown, _v: unknown, undo?: (() => void)[]) => undoAll(undo);
  const onSettled = () => settle.library();
  return {
    create: useMutation({
      mutationFn: (path: string) => api('/api/folders', { method: 'POST', body: { path } }),
      onMutate: async (path: string) => [
        await guess<LibraryResponse>(qc, keys.library, (old) => ({
          ...old,
          folders: old.folders.includes(path) ? old.folders : [...old.folders, path].sort(),
        })),
      ],
      onError,
      onSettled,
    }),
    rename: useMutation({
      mutationFn: (b: { from: string; to: string }) => api('/api/folders', { method: 'PATCH', body: b }),
      onMutate: async ({ from, to }: { from: string; to: string }) => [
        await guess<LibraryResponse>(qc, keys.library, (old) => ({
          folders: [...new Set(old.folders.map((f) => renamed(f, from, to) ?? f))].sort(),
          videos: old.videos.map((v) => (renamed(v.folder, from, to) === v.folder ? v : { ...v, folder: renamed(v.folder, from, to) })),
        })),
      ],
      onError,
      onSettled,
    }),
    // Where a removed folder's videos go is the server's call (its parent): only the folder leaves at once.
    remove: useMutation({
      mutationFn: (path: string) => api<{ parent: string | null }>(`/api/folders?path=${enc(path)}`, { method: 'DELETE' }),
      onMutate: async (path: string) => [
        await guess<LibraryResponse>(qc, keys.library, (old) => ({ ...old, folders: old.folders.filter((f) => f !== path && !f.startsWith(`${path}/`)) })),
      ],
      onError,
      onSettled,
    }),
  };
}

export interface NewComment {
  v: number;
  frame: number;
  range?: FrameRange | null;
  text?: string;
  tags?: string[];
  severity?: Severity;
  drawing?: Shape[];
  voiceId?: string | null;
  voiceTranscript?: string | null;
  /** Links and frames of renders that come with the note (web/src/refs/api.ts inlineBody); files follow. */
  refs?: Record<string, unknown>[];
  /** About the whole video. */
  scope?: 'video';
  /** The words said in the range, and what they should say instead (the transcript's "Change the words"). */
  text_edit?: TextEdit;
  /** The person allows a partial render of these shots (lib/part.ts). */
  part?: PartRequest;
}
export interface CommentPatch {
  status?: Status;
  note?: string;
  text?: string;
  /** What a note that changes the words asks them to say now (what was heard stays). */
  text_edit_to?: string;
  ack?: boolean;
  /** The fix preview a verdict refers to (verified on the preview only, until a render has the fix). */
  preview?: string;
}

/** New words for reply `n` of note `id`, written at `at`. */
export interface ReplyEdit {
  id: string;
  n: number;
  at: string;
  text: string;
}

/** A stand-in id until the server's note arrives (never sent anywhere). */
export const isDraftNote = (id: string) => id.startsWith('c_tmp');

/** The note as it will most likely come back, shown until the server's answer takes its place. */
function draftNote(r: ReviewResponse, body: NewComment): Comment {
  const ver = r.review.versions.find((x) => x.v === body.v) ?? r.review.versions.at(-1);
  const fps = ver?.fps || r.review.fps || 25;
  const frame = body.scope === 'video' ? 0 : body.frame;
  return {
    id: `c_tmp${Math.random().toString(16).slice(2, 8)}`,
    v: body.v,
    frame,
    timecode: timecode(frame, fps),
    t: frameToTime(frame, fps),
    range: body.range ?? null,
    text: (body.text || '').trim(),
    tags: body.tags || [],
    severity: body.severity || 'should',
    drawing: body.drawing || [],
    shots: null,
    voice: null,
    status: 'open',
    author: r.user,
    created: new Date().toISOString(),
    replies: [],
    ...(body.scope === 'video' ? { scope: 'video' as const } : {}),
    ...(body.text_edit && body.scope !== 'video' ? { text_edit: { from: body.text_edit.from.trim(), to: body.text_edit.to.trim() } } : {}),
    ...(body.part && body.scope !== 'video' ? { part: body.part } : {}),
  };
}

/** A note after `patch`, as the server will most likely have it (lib/store.ts updateComment). */
function patchedNote(c: Comment, patch: CommentPatch, by: string): Comment {
  const at = new Date().toISOString();
  const next: Comment = { ...c };
  if (patch.text !== undefined && patch.text !== c.text) Object.assign(next, { text: patch.text, edited: at });
  if (patch.text_edit_to !== undefined && c.text_edit && patch.text_edit_to.trim() !== c.text_edit.to)
    Object.assign(next, { text_edit: { ...c.text_edit, to: patch.text_edit_to.trim() }, edited: at });
  if (patch.status && patch.status !== c.status) {
    const reply: Reply = { by, text: (patch.note || '').trim(), status: patch.status, at };
    if (patch.preview) reply.preview = patch.preview;
    Object.assign(next, { status: patch.status, check_again: false, replies: [...c.replies, reply] });
  } else if (patch.note || patch.preview) {
    const reply: Reply = { by, text: (patch.note || '').trim(), at };
    if (patch.preview) reply.preview = patch.preview;
    Object.assign(next, { replies: [...c.replies, reply], ...(patch.ack ? { check_again: false } : {}) });
  } else if (patch.ack) next.check_again = false;
  return next;
}

const withNote =
  (id: string, change: (c: Comment) => Comment | null) =>
  (old: ReviewResponse): ReviewResponse => ({
    ...old,
    review: {
      ...old.review,
      comments: old.review.comments.flatMap((c) => {
        if (c.id !== id) return [c];
        const next = change(c);
        return next ? [next] : [];
      }),
    },
  });

export function useCommentActions(slug: string) {
  const qc = useQueryClient();
  const settle = useSettle();
  const key = keys.review(slug);
  const rollback = (_e: unknown, _v: unknown, undo?: (() => void)[]) => undoAll(undo);
  return {
    // The note is on the list at once; the server's copy (its id, its screenshots) takes its place.
    add: useMutation({
      mutationFn: (body: NewComment) => api<Comment>(`/api/review/${enc(slug)}/comments`, { method: 'POST', body }),
      onMutate: async (body: NewComment) => {
        let id = '';
        const undo = await guess<ReviewResponse>(qc, key, (old) => {
          const draft = draftNote(old, body);
          id = draft.id;
          return { ...old, review: { ...old.review, comments: [...old.review.comments, draft] } };
        });
        return { undo: [undo], id };
      },
      onSuccess: (created, _b, ctx) => qc.setQueryData<ReviewResponse>(key, (old) => (old && ctx?.id ? withNote(ctx.id, () => created)(old) : old)),
      onError: (_e, _v, ctx) => undoAll(ctx?.undo),
      onSettled: () => settle.review(slug),
    }),
    // Statuses, verdicts, replies, edits: the card shows the outcome at once.
    patch: useMutation({
      mutationFn: ({ id, ...body }: CommentPatch & { id: string }) => api<Comment>(`/api/comments/${id}`, { method: 'PATCH', body }),
      onMutate: async ({ id, ...body }: CommentPatch & { id: string }) => [
        await guess<ReviewResponse>(qc, key, (old) => withNote(id, (c) => patchedNote(c, body, old.user))(old)),
      ],
      onSuccess: (updated) => qc.setQueryData<ReviewResponse>(key, (old) => (old ? withNote(updated.id, () => updated)(old) : old)),
      onError: rollback,
      onSettled: () => settle.review(slug),
    }),
    // A reply's words, changed by its author: shown at once. `n` is its place in the thread as the card has it, `at`
    // when it was written (a thread that moved since answers 409: lib/store.ts replyAt).
    editReply: useMutation({
      mutationFn: ({ id, n, at, text }: ReplyEdit) => api<Comment>(`/api/comments/${id}/replies/${n}`, { method: 'PATCH', body: { at, text } }),
      onMutate: async ({ id, n, at, text }: ReplyEdit) => [
        await guess<ReviewResponse>(
          qc,
          key,
          withNote(id, (c) => ({
            ...c,
            replies: c.replies.map((r, i) => (i === n && r.at === at ? { ...r, text: text.trim(), edited: new Date().toISOString() } : r)),
          })),
        ),
      ],
      onSuccess: (updated) => qc.setQueryData<ReviewResponse>(key, (old) => (old ? withNote(updated.id, () => updated)(old) : old)),
      onError: rollback,
      onSettled: () => settle.review(slug),
    }),
    /** Takes a reply back, once its Undo is gone (CommentCard). Its place is looked up then: one above it may be gone. */
    removeReply: async (id: string, reply: Pick<Reply, 'by' | 'at'>) => {
      const c = qc.getQueryData<ReviewResponse>(key)?.review.comments.find((x) => x.id === id);
      const n = c ? c.replies.findIndex((r) => r.by === reply.by && r.at === reply.at) : -1;
      if (n < 0) return;
      const updated = await api<Comment>(`/api/comments/${id}/replies/${n}?at=${enc(reply.at)}`, { method: 'DELETE', keepalive: true });
      qc.setQueryData<ReviewResponse>(key, (old) => (old ? withNote(updated.id, () => updated)(old) : old));
      settle.review(slug);
    },
    remove: useMutation({
      mutationFn: (id: string) => api(`/api/comments/${id}`, { method: 'DELETE' }),
      onMutate: async (id: string) => [
        await guess<ReviewResponse>(
          qc,
          key,
          withNote(id, () => null),
        ),
      ],
      onError: rollback,
      onSettled: () => settle.review(slug),
    }),
  };
}

// Accepting a suggestion (it becomes a note) hides it at once (via review.qa_dismissed) and puts it back if the call
// fails. "That's intended" waits for its Undo instead (player/useQa.ts).
export function useQaActions(slug: string, v: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const settle = useSettle();
  const hide = async (key: string) => {
    await qc.cancelQueries({ queryKey: keys.review(slug) });
    const before = qc.getQueryData<ReviewResponse>(keys.review(slug));
    if (before)
      qc.setQueryData<ReviewResponse>(keys.review(slug), {
        ...before,
        review: { ...before.review, qa_dismissed: [...(before.review.qa_dismissed || []), key] },
      });
    return { before };
  };
  const restore = (_e: unknown, _k: unknown, ctx?: { before?: ReviewResponse }) => ctx?.before && qc.setQueryData(keys.review(slug), ctx.before);
  const done = () => settle.review(slug);
  return {
    accept: useMutation({
      mutationFn: (key: string) => api<Comment>(`/api/qa/${enc(slug)}/accept`, { method: 'POST', body: { key, v } }),
      onMutate: hide,
      onError: restore,
      onSettled: done,
    }),
    rerun: useMutation({
      mutationFn: () => api(`/api/qa/${enc(slug)}/${v}/rerun`, { method: 'POST' }),
      onMutate: () => qc.setQueryData(keys.qa(slug, v), { pending: true }),
      onSettled: () => invalidate(keys.qa(slug, v)),
    }),
  };
}

/** A request to the video's agent; `start` also starts it when it isn't running (on this machine only). */
export function useRequest(slug: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (r: string | { text: string; start?: boolean; part?: PartRequest }) =>
      api<{ ok: true; run?: AgentRunInfo | null }>(`/api/review/${enc(slug)}/request`, { method: 'POST', body: typeof r === 'string' ? { text: r } : r }),
    onSuccess: (d) => d.run && invalidate(['agent-runs']),
  });
}

/** Starts the video's agent without a new request (its question was just answered). */
export function useWakeAgent(slug: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (text?: string) => api<{ run: AgentRunInfo | null }>(`/api/review/${enc(slug)}/wake`, { method: 'POST', body: text ? { text } : {} }),
    onSuccess: () => invalidate(['agent-runs']),
  });
}

/** Stops a run Lampo started (the whole process group). */
export function useStopRun() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<{ run: AgentRunInfo }>(`/api/agent-runs/${enc(id)}/stop`, { method: 'POST' }),
    onSettled: () => invalidate(['agent-runs']),
  });
}

/** Revoking any review link by its token (Settings → Review links): every link list refreshes. */
export function useRevokeLink() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (token: string) => api(`/api/shares/${token}`, { method: 'DELETE' }), onSettled: () => invalidate(['shares']) });
}

/** Review links for a video or a folder. Any change refreshes every link list (a folder link also shows on its videos). */
export function useShareActions(target: { slug: string } | { folder: string }) {
  const invalidate = useInvalidate();
  const lists = ['shares'] as const;
  const createUrl = 'slug' in target ? `/api/review/${enc(target.slug)}/shares` : '/api/folder-shares';
  const extra = 'slug' in target ? {} : { folder: target.folder };
  return {
    create: useMutation({
      mutationFn: (input: ShareInput) => api<ShareInfo>(createUrl, { method: 'POST', body: { ...extra, ...input } }),
      onSettled: () => invalidate(lists),
    }),
    update: useMutation({
      mutationFn: ({ token, input }: { token: string; input: ShareInput }) => api<ShareInfo>(`/api/shares/${token}`, { method: 'PATCH', body: input }),
      onSettled: () => invalidate(lists),
    }),
    revoke: useMutation({ mutationFn: (token: string) => api(`/api/shares/${token}`, { method: 'DELETE' }), onSettled: () => invalidate(lists) }),
    startTunnel: useMutation({ mutationFn: () => api('/api/tunnel/start', { method: 'POST' }), onSettled: () => invalidate(keys.tunnel, lists) }),
    stopTunnel: useMutation({ mutationFn: () => api('/api/tunnel/stop', { method: 'POST' }), onSettled: () => invalidate(keys.tunnel, lists) }),
  };
}

export interface WebhookForm {
  url?: string;
  label?: string;
  format?: WebhookFormat;
  events?: string[];
  secret?: string | null;
}

export function useWebhookActions() {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.webhooks);
  return {
    add: useMutation({ mutationFn: (b: WebhookForm) => api<WebhookInfo>('/api/admin/webhooks', { method: 'POST', body: b }), onSettled: done }),
    update: useMutation({
      mutationFn: ({ id, ...b }: WebhookForm & { id: string }) => api<WebhookInfo>(`/api/admin/webhooks/${id}`, { method: 'PATCH', body: b }),
      onSettled: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api(`/api/admin/webhooks/${id}`, { method: 'DELETE' }), onSettled: done }),
    test: useMutation({ mutationFn: (id: string) => api<WebhookDelivery>(`/api/admin/webhooks/${id}/test`, { method: 'POST' }), onSettled: done }),
  };
}
