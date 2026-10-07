// Live updates. Browsers allow only 6 HTTP/1.1 connections per host, so only one tab holds the EventSource
// (whoever owns the 'vr-sse' Web Lock) and relays events to the other tabs over a BroadcastChannel.
// Server events mostly just say "this changed" (and for which video): live.ts fetches exactly that, once per burst.
// (live.ts binds itself to these events when it has loaded, right after the start: nothing of it is needed to paint.)

import { useEffect, useRef } from 'react';

const TYPES = [
  'library',
  'review',
  'analysis',
  'poster',
  'sprite',
  'sessions',
  'events',
  'diff',
  'qa',
  'qa-progress',
  'transcript',
  'event',
  'for-you',
  'playbook',
  'recording',
  'agent-runs',
  'agent-activity',
  'run',
  'drafts',
  'asks',
  'posts',
  'connections',
  'moment',
] as const;
export type EventType = (typeof TYPES)[number];
export interface EventData {
  slug?: string;
  v?: number;
  [k: string]: unknown;
}
type Listener = (d: EventData) => void;

const listeners = new Map<EventType, Set<Listener>>();
const dispatch = (type: EventType, data: EventData) => {
  for (const f of listeners.get(type) || []) f(data);
};
// Back after a gap: what the server said meanwhile is lost, so the screens ask again (live.ts). Told to every tab.
const RESYNC = 'resync';
const resyncs = new Set<() => void>();
const resync = () => {
  for (const f of resyncs) f();
};
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vr-events') : null;
if (channel)
  channel.onmessage = (e: MessageEvent<{ type: EventType | typeof RESYNC; data: EventData }>) =>
    e.data.type === RESYNC ? resync() : dispatch(e.data.type, e.data.data);
let es: EventSource | null = null;
let started = false;
let leader = false;
let again: ReturnType<typeof setTimeout> | null = null;
let wait = 1000;
let gap = false;

function openSource() {
  if (es) return;
  if (again) clearTimeout(again);
  again = null;
  const source = new EventSource('/api/events');
  es = source;
  source.onopen = () => {
    wait = 1000;
    if (!gap) return;
    gap = false;
    resync();
    channel?.postMessage({ type: RESYNC, data: {} });
  };
  // A dropped stream the browser opens again by itself; one refused with an error status — the server restarting
  // behind its proxy (a deploy), a 401 — it closes for good. That one is opened again here, later each time: a tab
  // left open across a deploy went deaf (a fix checked in another tab stayed in its inbox).
  source.onerror = () => {
    gap = true;
    if (source.readyState !== EventSource.CLOSED || es !== source) return;
    es = null;
    again = setTimeout(() => {
      again = null;
      if (leader) openSource();
    }, wait);
    wait = Math.min(wait * 2, 30_000);
  };
  for (const type of TYPES)
    source.addEventListener(type, (e) => {
      let d: EventData = {};
      try {
        d = JSON.parse((e as MessageEvent<string>).data || '{}');
      } catch {}
      dispatch(type, d);
      channel?.postMessage({ type, data: d });
    });
}

/**
 * Opens the stream (or joins the tab that holds it). Called by the auth gate once the app may talk to the server:
 * at once in local mode, after sign-in in server mode.
 */
export function startEvents() {
  if (started) return;
  started = true;
  const lead = () => {
    leader = true;
    openSource();
  };
  // The lock is held forever (the promise never settles): the next tab takes over when this one closes.
  if (navigator.locks && channel) navigator.locks.request('vr-sse', () => new Promise<void>(lead));
  else lead();
  window.addEventListener('pagehide', () => {
    es?.close();
    es = null;
  });
  window.addEventListener('pageshow', (e) => e.persisted && leader && openSource());
  // back online, or back to the tab: a stream waiting for its next try opens now
  const now = () => leader && !es && openSource();
  window.addEventListener('online', now);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && now());
}

/** After signing in: the stream refused earlier (or belongs to the old session) starts over. */
export function reconnectEvents() {
  if (!started) return startEvents();
  if (!leader) return;
  es?.close();
  es = null;
  openSource();
}

/** Called when the stream is back after a gap (in every tab): what changed meanwhile was never said. */
export function onResync(fn: () => void) {
  resyncs.add(fn);
  return () => {
    resyncs.delete(fn);
  };
}

export function on(type: EventType, fn: Listener) {
  const set = listeners.get(type) ?? new Set<Listener>();
  listeners.set(type, set);
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

export function useSSE(type: EventType, fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => on(type, (d) => ref.current(d)), [type]);
}
