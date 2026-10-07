// Push notifications: subscriptions (one per device; on a server they belong to an account), what each device wants
// to hear about, and the notifier that turns review events into few, well-bundled notifications — a render with six
// fixes is one "V3 is ready — 6 fixes to check", not six pings. Fed from events.jsonl like the webhooks. People read
// these: the app's words (a version is "V3", a fix is checked), not the agents'.
//   data/push/vapid.json            the server's VAPID key pair, made once (0600)
//   data/push/subscriptions.json    {subs: {<id>: {endpoint, keys, user, name, created, last_ok, prefs}}} (0600)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND_NAME } from '../brand.ts';
import type { Resolver } from '../netguard.ts';
import { currentWorkspace, DATA, inWorkspace, isoLocal } from '../paths.ts';
import { DEFAULT_PREFS } from '../pushPrefs.ts';
import { RateLimit } from '../rateLimit.ts';
import { routeIn } from '../scope.ts';
import { withLock, writeAtomic } from '../store.ts';
import { isAgent, isQuestion } from '../time.ts';
import type { ActivityWords, PushPrefs, ReviewEvent } from '../types.ts';
import { generateVapidKeys, isPushEndpoint, PushRefused, type PushSubscriptionKeys, sendPush, type VapidKeys } from './webpush.ts';

export { DEFAULT_PREFS };

const DIR = path.join(DATA, 'push');
const VAPID_FILE = path.join(DIR, 'vapid.json');
const SUBS_FILE = path.join(DIR, 'subscriptions.json');
const LOCK_DIR = path.join(DATA, '.push');

export type PushCategory = keyof PushPrefs;

export interface StoredSub {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** The account (server mode); null on a local instance. */
  user: string | null;
  name: string;
  created: string;
  last_ok: string | null;
  prefs: PushPrefs;
}
interface SubsFile {
  subs: Record<string, StoredSub>;
}

/** The server's VAPID keys: made on first use and kept, so subscriptions survive restarts. */
export function vapidKeys(): VapidKeys {
  try {
    return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as VapidKeys;
  } catch {}
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(VAPID_FILE, `${JSON.stringify({ ...generateVapidKeys(), created: isoLocal() }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch {}
  return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as VapidKeys;
}

function load(): SubsFile['subs'] {
  try {
    return (JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) as SubsFile).subs || {};
  } catch {
    return {};
  }
}
function save(subs: SubsFile['subs']): void {
  fs.mkdirSync(DIR, { recursive: true });
  writeAtomic(SUBS_FILE, `${JSON.stringify({ subs }, null, 2)}\n`);
  fs.chmodSync(SUBS_FILE, 0o600);
}
const idOf = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('base64url').slice(0, 16);

export interface SubscribeInput {
  endpoint: string;
  keys: PushSubscriptionKeys;
  user: string | null;
  name?: string;
  prefs?: Partial<PushPrefs>;
}

/** Adds (or refreshes) a device. The endpoint must belong to a browser push service. */
export function subscribe(input: SubscribeInput, extraHosts: string[] = []): { id: string; sub: StoredSub } {
  if (!isPushEndpoint(input.endpoint, extraHosts)) throw new Error('not a push service this server delivers to');
  if (Buffer.from(input.keys.p256dh, 'base64url').length !== 65 || Buffer.from(input.keys.auth, 'base64url').length !== 16)
    throw new Error('the subscription keys are malformed');
  const id = idOf(input.endpoint);
  return withLock(LOCK_DIR, () => {
    const subs = load();
    const cur = subs[id];
    const sub: StoredSub = {
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      user: input.user,
      name: (input.name || cur?.name || 'This device').slice(0, 60),
      created: cur?.created || isoLocal(),
      last_ok: cur?.last_ok || null,
      prefs: { ...DEFAULT_PREFS, ...(cur?.user === input.user ? cur.prefs : {}), ...input.prefs },
    };
    subs[id] = sub;
    save(subs);
    return { id, sub };
  });
}

export function findSub(endpoint: string, user: string | null): { id: string; sub: StoredSub } | null {
  const id = idOf(endpoint);
  const sub = load()[id];
  return sub && sub.user === user ? { id, sub } : null;
}

export function updatePrefs(endpoint: string, user: string | null, prefs: Partial<PushPrefs>): StoredSub | null {
  return withLock(LOCK_DIR, () => {
    const subs = load();
    const id = idOf(endpoint);
    if (!subs[id] || subs[id].user !== user) return null;
    subs[id] = { ...subs[id], prefs: { ...subs[id].prefs, ...prefs } };
    save(subs);
    return subs[id];
  });
}

export function unsubscribe(endpoint: string, user: string | null): boolean {
  return withLock(LOCK_DIR, () => {
    const subs = load();
    const id = idOf(endpoint);
    if (!subs[id] || subs[id].user !== user) return false;
    delete subs[id];
    save(subs);
    return true;
  });
}

/**
 * Every device of an account stops hearing from this server (sign out everywhere, a password reset): a lost or shared
 * phone mustn't keep showing note texts on its lock screen after the person cut its session off.
 */
export function forgetDevicesOf(user: string): number {
  if (!fs.existsSync(SUBS_FILE)) return 0;
  return withLock(LOCK_DIR, () => {
    const subs = load();
    let n = 0;
    for (const [id, s] of Object.entries(subs))
      if (s.user === user) {
        delete subs[id];
        n++;
      }
    if (n) save(subs);
    return n;
  });
}

export const listSubs = (): [string, StoredSub][] => Object.entries(load());
export const countSubs = (user: string | null): number => listSubs().filter(([, s]) => s.user === user).length;

function patchSub(id: string, fn: (s: StoredSub) => StoredSub | null): void {
  withLock(LOCK_DIR, () => {
    const subs = load();
    if (!subs[id]) return;
    const next = fn(subs[id]);
    if (next) subs[id] = next;
    else delete subs[id];
    save(subs);
  });
}

// ---------------------------------------------------------------- the notifier

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered at once even on a device saving power (a question; an agent waiting for your OK). */
  urgent?: boolean;
  /** Where tapping it goes (an app route like #/v/<slug>?c=<note>). */
  url: string;
  /** Same tag = the newer notification replaces the older one on the device. */
  tag: string;
  category: PushCategory;
  /** Who caused it: nobody is told about their own actions. */
  authors: string[];
}

/** Local mode's `eligible`: the one person on this machine isn't told what they did themselves. */
export const notFrom =
  (name: string) =>
  (_sub: StoredSub, msg: PushMessage): boolean =>
    !msg.authors.every((a) => a === name);

type Bucket = 'question' | 'release' | 'client' | 'answer' | 'post' | 'agent' | 'quiet';

/**
 * What an agent's run gives people a ping for (server/runs.ts tells it): it failed, it waits for a permission it was
 * denied, or there has been no word from it for 30 min. Never that it started, renders or got on: that is the app's to
 * show, not a reason to reach for the phone.
 */
export interface RunNotice {
  kind: 'failed' | 'permission' | 'quiet';
  slug: string;
  /** The video's file name. */
  video: string;
  agent: string;
  run: string;
  /** failed: why (Run.error); permission: what it needs (Run.needs.text). */
  words?: ActivityWords;
  /** permission: the rule that would allow it. */
  allow?: string;
  /** quiet: minutes without a word. */
  minutes?: number;
}
const CLIENT_TYPES = new Set(['comment', 'reply', 'status', 'approval', 'download']);

/** Which bundle an event joins, or null when it isn't worth a notification. */
export function bucketOf(e: ReviewEvent): Bucket | null {
  if (e.by.startsWith('guest:') && CLIENT_TYPES.has(e.type)) return 'client';
  if (e.type === 'comment' && isAgent(e.by) && isQuestion({ kind: e.kind, author: e.by })) return 'question';
  if ((e.type === 'status' && e.status === 'fixed') || e.type === 'version') return 'release';
  if (e.type === 'reply' && isAgent(e.by)) return 'answer';
  // a post that went out (or will, at its time) or failed: the person who published it wants to know
  if (e.type === 'post' && (e.post?.state === 'posted' || e.post?.state === 'scheduled' || e.post?.state === 'failed')) return 'post';
  return null;
}

const name = (e: ReviewEvent) => path.basename(e.video);
const who = (by: string) => by.replace(/^(agent|guest):/, '');
const quote = (s: string | undefined, max = 140) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t ? `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”` : '';
};
// Folder-wide events (a client downloading a whole room) have no video: they open the folder.
const noteUrl = (e: ReviewEvent) =>
  e.slug ? `#/v/${encodeURIComponent(e.slug)}${e.id ? `?c=${e.id}` : ''}` : `#/folder/${encodeURIComponent(e.folder || '')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where what a tool printed (oneLine joins its lines with ↵) says what went wrong: the last line that names an error,
 * else its last line (a stack's frame says less than the message above it). */
function lastLine(s: string | undefined): string {
  const lines = (s || '')
    .split(' ↵ ')
    .map((l) => l.trim())
    .filter(Boolean);
  return [...lines].reverse().find((l) => SAYS_ERROR.test(l)) ?? lines.at(-1) ?? '';
}
const SAYS_ERROR = /\b(error|failed|fatal|cannot|can[’']t|could not|couldn[’']t|not found|missing|denied|invalid|exception)\b/i;
const RENDER_TOOL = /\b(remotion|ffmpeg|aerender|blender)\b|^vr render\b/;

/** What a run waits for the person's OK to do, in a few words: "render promo.mp4", "run npm test on promo.mp4". */
function purpose(n: RunNotice): string {
  const v = n.words?.vars ?? {};
  switch (n.words?.key) {
    case 'Needs permission to run {command}': {
      const command = String(v.command ?? '');
      return RENDER_TOOL.test(command) ? `render ${n.video}` : `run ${command} on ${n.video}`;
    }
    case 'Needs permission to use {tool}':
      return `use ${v.tool} on ${n.video}`;
    case 'Needs permission to edit files':
      return `edit files for ${n.video}`;
    default:
      return `go on with ${n.video}`;
  }
}

/** One notification for an agent's runs on one video (the most pressing: a permission, a failure, then quiet). */
export function runMessage(list: RunNotice[]): PushMessage {
  const newest = (k: RunNotice['kind']) => [...list].reverse().find((x) => x.kind === k);
  const n = (newest('permission') ?? newest('failed') ?? newest('quiet')) as RunNotice;
  const who = n.agent;
  const file = n.video;
  const base = { url: '#/inbox', authors: [`agent:${who}`] };
  if (n.kind === 'permission')
    return {
      ...base,
      title: `${who} is waiting for your OK to ${purpose(n)}`,
      body: n.allow ? `Allow ${n.allow} in its settings, then send it again.` : 'See what it needs in the inbox.',
      tag: `run:${n.slug}`,
      category: 'agents',
      urgent: true,
    };
  if (n.kind === 'failed') {
    const w = n.words;
    const said = lastLine(w?.quote);
    const quoted = said ? quote(said) : '';
    const title =
      w?.key === 'The render failed (exit {code})'
        ? `${who} stopped — the render of ${file} failed`
        : w?.key === 'Stopped at the time limit'
          ? `${who} stopped — ${file} hit the time limit`
          : w?.key === 'Couldn’t start'
            ? `${who} couldn’t start on ${file}`
            : `${who} stopped — an error on ${file}`;
    const body =
      quoted ||
      (w?.key === 'The render failed (exit {code})'
        ? `Exit ${w.vars?.code ?? '?'}. Try again from the inbox.`
        : w?.key
          ? 'Try again from the inbox.'
          : quote(w?.text) || 'Try again from the inbox.');
    return { ...base, title, body, tag: `run:${n.slug}`, category: 'agents' };
  }
  return {
    ...base,
    title: `No word from ${who} on ${file} for ${n.minutes ?? 30} min`,
    body: 'Nudge it or stop it from the inbox.',
    tag: `quiet:${n.slug}`,
    category: 'quiet',
  };
}

/** One notification for a bundle of events about one video. */
export function message(bucket: Bucket, events: ReviewEvent[]): PushMessage {
  const first = events[0];
  const file = name(first);
  const authors = [...new Set(events.map((e) => e.by))];
  if (bucket === 'question') {
    const n = events.length;
    return {
      title: n === 1 ? `${who(first.by)} asks about ${file}` : `${n} questions on ${file}`,
      body: `${quote(first.text) || 'A question on a frame'}${n > 1 ? ` and ${plural(n - 1, 'more')}` : ''}`,
      url: n === 1 ? noteUrl(first) : '#/inbox',
      tag: `q:${first.slug}`,
      category: 'questions',
      authors,
    };
  }
  if (bucket === 'release') {
    const fixes = events.filter((e) => e.type === 'status');
    const version = [...events].reverse().find((e) => e.type === 'version');
    const v = version?.v ?? Math.max(...fixes.map((e) => e.reply?.fixed_in_v ?? e.v ?? 1));
    if (fixes.length)
      return {
        title: `${file} V${v} is ready`,
        body: `${plural(fixes.length, 'fix', 'fixes')} to check${fixes.length === 1 && fixes[0].text ? `: ${quote(fixes[0].text, 100)}` : ''}`,
        url: `#/v/${encodeURIComponent(first.slug)}?verify=${fixes[0].id}`,
        tag: `rel:${first.slug}`,
        category: 'fixes',
        authors,
      };
    return {
      title: `${file}: V${v} is in`,
      body: 'A new render is ready to watch.',
      url: noteUrl({ ...first, id: undefined }),
      tag: `rel:${first.slug}`,
      category: 'versions',
      authors,
    };
  }
  if (bucket === 'client') {
    const people = [...new Set(events.map((e) => who(e.by)))].join(', ');
    const approval = [...events].reverse().find((e) => e.type === 'approval');
    const download = [...events].reverse().find((e) => e.type === 'download');
    const notes = events.filter((e) => e.type === 'comment');
    const body = approval
      ? approval.text || 'Approval'
      : download && !notes.length
        ? `${who(download.by)} ${download.text || 'downloaded it'}`
        : notes.length === 1
          ? quote(notes[0].text) || 'A note on a frame'
          : notes.length
            ? `${plural(notes.length, 'new note')}`
            : quote(events.at(-1)?.reply?.text) || 'Activity on the review link';
    return {
      title: `${people} on ${file}`,
      body,
      url: notes.length === 1 && !approval ? noteUrl(notes[0]) : noteUrl({ ...first, id: undefined }),
      tag: `cl:${first.slug || first.folder}`,
      category: 'clients',
      authors,
    };
  }
  if (bucket === 'post') {
    const last = events.at(-1) as ReviewEvent;
    const p = last.post;
    const where = p ? ({ youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' } as const)[p.platform] : 'the platform';
    return {
      title:
        p?.state === 'failed' ? `${file}: the ${where} post failed` : p?.state === 'scheduled' ? `${file} is scheduled on ${where}` : `${file} is on ${where}`,
      body: p?.state === 'failed' ? p.error || 'It failed.' : p?.url || last.text || '',
      url: `#/v/${encodeURIComponent(first.slug)}?publish=${p?.id ?? ''}`,
      tag: `post:${p?.id ?? first.slug}`,
      category: 'posts',
      // the queue tells it (`system`): the person who published hears of it too
      authors,
    };
  }
  return {
    title: `${who(first.by)} replied on ${file}`,
    body: quote(events.at(-1)?.reply?.text) || 'A reply to your note',
    url: noteUrl(events.at(-1) as ReviewEvent),
    tag: `ans:${first.slug}`,
    category: 'answers',
    authors,
  };
}

export interface PushOptions {
  /** VAPID contact (mailto: or https:). */
  subject: string;
  /** May this device be told? (server mode: the account's role; nobody hears about their own actions.) */
  eligible?: (sub: StoredSub, msg: PushMessage) => boolean;
  /** The app badge number for this device's person ("For you" total). */
  count?: (sub: StoredSub) => number;
  fetchImpl?: typeof fetch;
  /** Quiet time per bundle before it goes out (each new event restarts it, up to maxWaitMs). */
  windows?: Partial<Record<Bucket, number>>;
  maxWaitMs?: number;
  retryDelayMs?: number;
  /** Extra push service hosts (tests). */
  extraHosts?: string[];
  /** How push services' names are resolved (tests): every address must be public. */
  resolve?: Resolver;
  log?: (msg: string) => void;
  /** How many notifications one device gets of a category within a minute (tests lower them). */
  perDevice?: Partial<Record<PushCategory, number>> & { other?: number };
}

export interface Push {
  handle(e: ReviewEvent): void;
  /** An agent's run failed, waits for a permission or went quiet (server/runs.ts): bundled per video like the rest. */
  run(n: RunNotice): void;
  /** Sends every waiting bundle now (tests, shutdown). */
  flush(): void;
  /** Resolves when every send started so far has finished. */
  idle(): Promise<void>;
  /** A sample notification to one device. */
  test(endpoint: string, user: string | null): Promise<boolean>;
}

const WINDOWS: Record<Bucket, number> = { question: 4000, release: 20_000, client: 30_000, answer: 8000, post: 2000, agent: 3000, quiet: 3000 };

/**
 * One device hears at most this many notifications of a category within a minute, however many videos and agents the
 * news is about: a phone that buzzes every few seconds is one nobody keeps notifications on for. Agents' work least,
 * since anyone who may post an agent's activity can make it fail.
 */
const PER_DEVICE: Partial<Record<PushCategory, number>> & { other: number } = { agents: 3, quiet: 3, other: 20 };

export function createPush(o: PushOptions): Push {
  const log = o.log || ((m: string) => console.error(m));
  const windows = { ...WINDOWS, ...o.windows };
  const maxWait = o.maxWaitMs ?? 120_000;
  const retryDelay = o.retryDelayMs ?? 5000;
  // Bundles per workspace (its events only, never mixed with another's video of the same name), sent in it.
  const waiting = new Map<string, { bucket: Bucket; events: ReviewEvent[]; runs: RunNotice[]; first: number; timer: NodeJS.Timeout; ws: string }>();
  // per device and category, within a minute (keyed by the subscription's id: as many keys as devices)
  const perDevice = { ...PER_DEVICE, ...o.perDevice };
  const limits = new Map<string, RateLimit>();
  const limitOf = (category: PushCategory): RateLimit => {
    const max = perDevice[category] ?? perDevice.other;
    let l = limits.get(category);
    if (!l) {
      l = new RateLimit(max, 60_000, { maxKeys: 100_000 });
      limits.set(category, l);
    }
    return l;
  };
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  async function deliver(id: string, sub: StoredSub, payload: object, topic: string, urgency: 'normal' | 'high'): Promise<boolean> {
    const body = JSON.stringify({ ...payload, count: o.count ? o.count(sub) : undefined });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryDelay));
      try {
        const res = await sendPush(sub.endpoint, sub.keys, body, {
          vapid: vapidKeys(),
          subject: o.subject,
          topic,
          urgency,
          fetchImpl: o.fetchImpl,
          resolve: o.resolve,
        });
        if (res.ok) {
          patchSub(id, (s) => ({ ...s, last_ok: isoLocal() }));
          return true;
        }
        if (res.gone) {
          patchSub(id, () => null);
          return false;
        }
        if (res.status !== 429 && res.status < 500) {
          log(`push to ${sub.name}: HTTP ${res.status}`);
          return false;
        }
      } catch (e) {
        // A push service whose name now resolves into a private network: said once, not asked again; the device stays
        // (the name may resolve elsewhere tomorrow).
        if (e instanceof PushRefused) {
          log(`push to ${sub.name}: refused, ${e.message}`);
          return false;
        }
        if (attempt) log(`push to ${sub.name}: ${(e as Error).message}`);
      }
    }
    return false;
  }

  function send(msg: PushMessage) {
    const topic = `vr${crypto.createHash('sha256').update(msg.tag).digest('base64url').slice(0, 28)}`;
    const payload = { title: msg.title, body: msg.body, url: msg.url, tag: msg.tag };
    for (const [id, sub] of listSubs()) {
      // a subscription from before a category existed hears it (posts: on unless turned off)
      if (!(sub.prefs[msg.category] ?? DEFAULT_PREFS[msg.category])) continue;
      if (o.eligible && !o.eligible(sub, msg)) continue;
      if (!limitOf(msg.category).take(id)) continue;
      track(deliver(id, sub, payload, topic, msg.category === 'questions' || msg.urgent ? 'high' : 'normal'));
    }
  }

  function release(key: string) {
    const b = waiting.get(key);
    if (!b) return;
    waiting.delete(key);
    clearTimeout(b.timer);
    try {
      inWorkspace(b.ws, () => {
        const m = b.runs.length ? runMessage(b.runs) : message(b.bucket, b.events);
        // Tapping it opens the workspace it is about (A12 WS-11).
        send({ ...m, url: routeIn(m.url, b.ws) });
      });
    } catch (e) {
      log(`push: ${(e as Error).message}`);
    }
  }

  /** Joins the bundle of `bucket` for this video (in the workspace running now); its quiet time starts again. */
  function queue(bucket: Bucket, about: string, add: (entry: { events: ReviewEvent[]; runs: RunNotice[] }) => void) {
    const ws = currentWorkspace();
    const key = `${ws}\u0000${bucket}:${about}`;
    const now = Date.now();
    const b = waiting.get(key);
    if (b) clearTimeout(b.timer);
    const entry = b || { bucket, events: [], runs: [], first: now, timer: undefined as unknown as NodeJS.Timeout, ws };
    add(entry);
    const wait = Math.max(0, Math.min(windows[bucket], entry.first + maxWait - now));
    entry.timer = setTimeout(() => release(key), wait);
    entry.timer.unref?.();
    waiting.set(key, entry);
  }

  return {
    handle(e) {
      const bucket = bucketOf(e);
      if (!bucket || !listSubs().length) return;
      queue(bucket, e.slug || `folder:${e.folder}`, (x) => x.events.push(e));
    },
    run(n) {
      if (!listSubs().length) return;
      queue(n.kind === 'quiet' ? 'quiet' : 'agent', n.slug, (x) => x.runs.push(n));
    },
    flush() {
      for (const key of [...waiting.keys()]) release(key);
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
    async test(endpoint, user) {
      const hit = findSub(endpoint, user);
      if (!hit) throw new Error('this device is not subscribed');
      const payload = {
        title: 'Notifications are on',
        body: `This is how ${BRAND_NAME} tells you when something needs you.`,
        url: '#/inbox',
        tag: 'vr:test',
      };
      return track(deliver(hit.id, hit.sub, payload, 'vrtest', 'normal'));
    },
  };
}
