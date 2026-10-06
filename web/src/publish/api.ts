// Publishing's server state (server/routes/publish.ts): a video's posts, the workspace's connections, a post's kit, and
// the writes. Edits to a draft show at once (optimistic) and go out a moment later, one at a time per post; the 'posts'
// and 'connections' events (api/live.ts) keep every screen in step, other tabs and the queue's progress included.
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type {
  ConnectionsResponse,
  KitInfo,
  PostFields,
  PostsResponse,
  PostView,
  PublishConfirm,
  PublishConnectionInfo,
  PublishPlatform,
} from '../../../lib/types.ts';
import { api, enc } from '../api/client.ts';
import { live } from '../api/live.ts';

export const publishKeys = {
  posts: (slug: string) => ['posts', slug] as const,
  connections: ['connections'] as const,
  kit: (id: string) => ['posts', 'kit', id] as const,
};

/** A video's posts, one per platform and final version (newest version first). */
export function usePosts(slug: string | null) {
  return useQuery({
    queryKey: publishKeys.posts(slug ?? ''),
    queryFn: () => api<PostsResponse>(`/api/review/${enc(slug ?? '')}/posts`),
    enabled: !!slug,
    // a post on its way changes by itself (the queue): the 'posts' event says so; this is the net under it
    refetchInterval: (q) => (q.state.data?.posts.some((p) => p.state === 'queued' || p.state === 'uploading') ? 4000 : false),
  });
}

/** The workspace's connections (no secret ever comes back). */
export function useConnections(enabled = true) {
  return useQuery({ queryKey: publishKeys.connections, queryFn: () => api<ConnectionsResponse>('/api/publish/connections'), enabled });
}

/** A post's kit, followed while it is being made. */
export function useKit(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: publishKeys.kit(id ?? ''),
    queryFn: () => api<KitInfo | { state: 'none'; files: [] }>(`/api/posts/${enc(id ?? '')}/kit`),
    enabled: !!id && enabled,
    refetchInterval: (q) => (q.state.data?.state === 'making' ? 1500 : false),
  });
}

const settle = (qc: QueryClient, slug: string) => {
  qc.invalidateQueries({ queryKey: publishKeys.posts(slug) });
  // the stage line ("Posted on YouTube") is the review's and the library entry's
  const l = live();
  if (l) l.review(slug);
};

/** Puts a post as the server answered it into the video's list (or adds it). */
function keep(qc: QueryClient, slug: string, post: PostView) {
  qc.setQueryData<PostsResponse>(publishKeys.posts(slug), (d) => {
    if (!d) return { posts: [post] };
    return d.posts.some((p) => p.id === post.id) ? { posts: d.posts.map((p) => (p.id === post.id ? post : p)) } : { posts: [post, ...d.posts] };
  });
}

/** What a field change looks like before the server answers (problems stay as they were until it does). */
function guessed(p: PostView, f: PostFields): PostView {
  return {
    ...p,
    ...(f.connection !== undefined ? { connection: f.connection } : {}),
    ...(f.account !== undefined ? { account: f.account } : {}),
    ...(f.title !== undefined ? { title: f.title } : {}),
    ...(f.description !== undefined ? { description: f.description } : {}),
    ...(f.tags !== undefined ? { tags: f.tags } : {}),
    ...(f.cover_frame !== undefined ? { cover_frame: f.cover_frame } : {}),
    ...(f.visibility !== undefined ? { visibility: f.visibility } : {}),
    ...(f.schedule_at !== undefined ? { schedule_at: f.schedule_at } : {}),
    ...(f.ai_generated !== undefined ? { ai_generated: f.ai_generated } : {}),
    ...(f.youtube ? { youtube: { ...p.youtube, ...f.youtube } } : {}),
    ...(f.instagram ? { instagram: { ...p.instagram, ...f.instagram } } : {}),
  };
}

/** The writes on a video's posts. */
export function usePostActions(slug: string) {
  const qc = useQueryClient();
  const done = (post: PostView) => {
    keep(qc, slug, post);
    settle(qc, slug);
    return post;
  };
  // One change on its way per post at a time; what is typed meanwhile is merged and goes next.
  const queues = useRef(new Map<string, { running: Promise<unknown> | null; waiting: PostFields | null }>()).current;
  const send = async (id: string): Promise<void> => {
    const q = queues.get(id);
    if (!q?.waiting) return;
    const body = q.waiting;
    q.waiting = null;
    q.running = api<PostView>(`/api/posts/${enc(id)}`, { method: 'PATCH', body })
      .then((p) => {
        // only the last answer wins over what is typed
        if (!queues.get(id)?.waiting) done(p);
      })
      .finally(() => {
        q.running = null;
        if (q.waiting) void send(id);
      });
    await q.running;
  };
  return {
    create: useMutation({
      mutationFn: (platform: PublishPlatform) => api<PostView>(`/api/review/${enc(slug)}/posts`, { method: 'POST', body: { platform } }),
      onSuccess: done,
    }),
    /** A change to a draft: on screen at once, on the server a moment later. */
    change(id: string, f: PostFields): Promise<void> {
      qc.setQueryData<PostsResponse>(publishKeys.posts(slug), (d) => d && { posts: d.posts.map((p) => (p.id === id ? guessed(p, f) : p)) });
      const q = queues.get(id) ?? { running: null, waiting: null };
      queues.set(id, q);
      q.waiting = {
        ...q.waiting,
        ...f,
        ...(f.youtube ? { youtube: { ...q.waiting?.youtube, ...f.youtube } } : {}),
        ...(f.instagram ? { instagram: { ...q.waiting?.instagram, ...f.instagram } } : {}),
      };
      if (q.running) return q.running.then(() => undefined);
      return send(id).catch((e) => {
        settle(qc, slug);
        throw e;
      });
    },
    /** What the person confirmed goes with it (the post's digest as they saw it: a change since answers 409, and the
     * post is read again); `again` only for one that went out before, behind its own confirm. */
    publish: useMutation({
      mutationFn: ({ id, confirm, again }: { id: string; confirm: PublishConfirm; again?: boolean }) =>
        api<PostView>(`/api/posts/${enc(id)}/publish`, { method: 'POST', body: { confirm, ...(again ? { again: true } : {}) } }),
      onSuccess: done,
      onError: () => settle(qc, slug),
    }),
    cancel: useMutation({ mutationFn: (id: string) => api<PostView>(`/api/posts/${enc(id)}/cancel`, { method: 'POST' }), onSuccess: done }),
    /** A failed post that never reached the platform is sent again; one that did (`remote_id`) is only asked about;
     * one sent without an answer goes again only with `again` (the person looked on the platform). */
    retry: useMutation({
      mutationFn: ({ id, again }: { id: string; again?: boolean }) =>
        api<PostView>(`/api/posts/${enc(id)}/retry`, { method: 'POST', ...(again ? { body: { again: true } } : {}) }),
      onSuccess: done,
      onError: () => settle(qc, slug),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/api/posts/${enc(id)}`, { method: 'DELETE' }),
      onSuccess: () => settle(qc, slug),
      onError: () => settle(qc, slug),
    }),
    /** The post as this tab knows it now (after the fields' writes answered): what a confirmation names. */
    current: (id: string): PostView | undefined => qc.getQueryData<PostsResponse>(publishKeys.posts(slug))?.posts.find((p) => p.id === id),
    kit: useMutation({
      mutationFn: (id: string) => api<KitInfo>(`/api/posts/${enc(id)}/kit`, { method: 'POST' }),
      onSuccess: (k, id) => qc.setQueryData(publishKeys.kit(id), k),
    }),
  };
}

/** A new connection: YouTube with its OAuth client, or Zernio with its key. */
export type NewConnection = { kind: 'youtube'; label?: string; client_id: string; client_secret: string } | { kind: 'zernio'; label?: string; api_key: string };

/** The writes on the workspace's connections. */
export function useConnectionActions() {
  const qc = useQueryClient();
  const put = (c: PublishConnectionInfo) => {
    qc.setQueryData<ConnectionsResponse>(publishKeys.connections, (d) =>
      d ? { ...d, connections: d.connections.some((x) => x.id === c.id) ? d.connections.map((x) => (x.id === c.id ? c : x)) : [...d.connections, c] } : d,
    );
    qc.invalidateQueries({ queryKey: publishKeys.connections });
    // the composers' choices and problems follow
    qc.invalidateQueries({ queryKey: ['posts'] });
    return c;
  };
  return {
    add: useMutation({ mutationFn: (b: NewConnection) => api<PublishConnectionInfo>('/api/publish/connections', { method: 'POST', body: b }), onSuccess: put }),
    change: useMutation({
      mutationFn: ({ id, ...b }: { id: string; label?: string; audited?: boolean; client_id?: string; client_secret?: string; api_key?: string }) =>
        api<PublishConnectionInfo>(`/api/publish/connections/${enc(id)}`, { method: 'PATCH', body: b }),
      onSuccess: put,
    }),
    check: useMutation({
      mutationFn: (id: string) => api<PublishConnectionInfo>(`/api/publish/connections/${enc(id)}/check`, { method: 'POST' }),
      onSuccess: put,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(`/api/publish/connections/${enc(id)}`, { method: 'DELETE' }),
      onSuccess: (_r, id) => {
        qc.setQueryData<ConnectionsResponse>(publishKeys.connections, (d) => d && { ...d, connections: d.connections.filter((c) => c.id !== id) });
        qc.invalidateQueries({ queryKey: publishKeys.connections });
        qc.invalidateQueries({ queryKey: ['posts'] });
      },
    }),
    /** Where the person signs in with Google for this connection (the page goes there). */
    authorize: useMutation({ mutationFn: (id: string) => api<{ url: string }>(`/api/publish/connections/${enc(id)}/authorize`, { method: 'POST' }) }),
  };
}
