// Webhooks: Slack, Discord or any URL hears about client feedback as it happens, so nobody has to keep the app open.
// Hooks come from config.json ("webhooks"), VR_WEBHOOK_URL, or the Settings page (data/webhooks.json). Deliveries
// are fire-and-forget: 5 s timeout, 3 retries with backoff, failures logged and remembered for the Settings page,
// never thrown at the request that caused the event. On a hosted server they only go to public addresses (guard).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostOf, isBlockedAddress, pinnedLookup, publicAddress, type Resolver } from './netguard.ts';
import { currentWorkspace, DEFAULT_WORKSPACE, dataDir, isoLocal } from './paths.ts';
import { routeIn, wsKey } from './scope.ts';
import { withLock, writeAtomic } from './store.ts';
import type { EventType, ReviewEvent, WebhookConfig, WebhookDelivery, WebhookFormat, WebhookInfo } from './types.ts';

const FILE = (): string => path.join(dataDir(), 'webhooks.json');
const LOCK_DIR = (): string => path.join(dataDir(), '.webhooks');
export const FORMATS: WebhookFormat[] = ['json', 'slack', 'discord'];
/** What "client" covers: things people do through a review link. */
const CLIENT_TYPES: EventType[] = ['comment', 'reply', 'status', 'approval', 'download'];

interface StoredHook extends WebhookConfig {
  created: string;
  by: string;
}
interface HooksFile {
  hooks: Record<string, StoredHook>;
}

function loadStored(): HooksFile['hooks'] {
  try {
    return (JSON.parse(fs.readFileSync(FILE(), 'utf8')) as HooksFile).hooks || {};
  } catch {
    return {};
  }
}
const saveStored = (hooks: HooksFile['hooks']) => writeAtomic(FILE(), `${JSON.stringify({ hooks }, null, 2)}\n`);

export const isClientEvent = (e: ReviewEvent): boolean => e.by.startsWith('guest:') && CLIENT_TYPES.includes(e.type);

export function wants(hook: WebhookConfig, e: ReviewEvent): boolean {
  const events = hook.events?.length ? hook.events : ['client'];
  if (events.includes('all')) return true;
  if (events.includes('client') && isClientEvent(e)) return true;
  return events.includes(e.type);
}

const who = (by: string) => (by.startsWith('guest:') ? `${by.slice(6)} (client)` : by.startsWith('agent:') ? `${by.slice(6)} (agent)` : by);
const quote = (s: string | undefined, max = 280) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t ? `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”` : '';
};

/** One line a person can read in a chat channel. */
export function describe(e: ReviewEvent): string {
  const name = path.basename(e.video);
  const at = e.timecode ? ` at ${e.timecode}` : '';
  const v = e.v ? ` v${e.v}` : '';
  // a reply changed or taken back by its author (not the note itself)
  if (e.reply && e.type === 'edit') return `${who(e.by)} edited their reply on ${name}${at}: ${quote(e.reply.text)}`;
  if (e.reply && e.type === 'delete') return `${who(e.by)} deleted their reply on ${name}${at}`;
  switch (e.type) {
    case 'comment':
      return `${who(e.by)} left a note on ${name}${v}${at}: ${quote(e.text) || '(marked frame)'}`;
    case 'reply':
      return `${who(e.by)} replied on ${name}${at}: ${quote(e.reply?.text)}`;
    case 'status': {
      const verb =
        e.status === 'verified' ? 'confirmed the fix of' : e.status === 'open' ? 'reopened' : e.status === 'fixed' ? 'marked fixed' : `set ${e.status}`;
      const why = e.reply?.text ? ` (${quote(e.reply.text, 160)})` : '';
      return `${who(e.by)} ${verb} ${quote(e.text, 120) || e.id} on ${name}${at}${why}`;
    }
    case 'approval':
      return `${who(e.by)} on ${name}: ${e.text || 'approval'}`;
    case 'download':
      return `${who(e.by)} ${e.text || `downloaded ${name}`}`;
    case 'request':
      return `${who(e.by)} asked ${e.session ? `${e.session} ` : 'the agent '}on ${name}${v}: ${quote(e.text)}`;
    case 'post':
      return `${name}: ${e.text || 'a post'}`;
    case 'agent_run':
      return e.phase === 'started'
        ? `${who(e.by)} started ${e.session || 'the agent'} on ${name}${v}`
        : `${e.session || 'The agent'} ${e.phase === 'finished' ? `finished on ${name} (exit ${e.exit ?? '-'})` : `${e.phase} on ${name}`}`;
    default:
      return `${who(e.by)}: ${e.type} ${name}${v}${e.text ? ` ${quote(e.text)}` : ''}`;
  }
}

// Slack mrkdwn needs &, < and > escaped; links are <url|label>.
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function payload(format: WebhookFormat, e: ReviewEvent, link: string): string {
  const text = describe(e);
  if (format === 'slack') return JSON.stringify({ text: `${slackEscape(text)} <${link}|Open>` });
  if (format === 'discord') return JSON.stringify({ content: `${text}\n${link}`, username: 'video-review', allowed_mentions: { parse: [] } });
  return JSON.stringify({ event: e, text, url: link });
}

/** X-VR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. The timestamp stops replays. */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300): boolean {
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header || '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, body, Number(m[1])).split('v1=')[1], 'hex');
  return crypto.timingSafeEqual(want, Buffer.from(m[2], 'hex'));
}

/** Only the host and the start of the path: webhook URLs often carry their secret in the path (Slack, Discord). */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 12 ? `${u.pathname.slice(0, 12)}…` : u.pathname;
    return `${u.protocol}//${u.host}${p}`;
  } catch {
    return 'invalid URL';
  }
}

export function checkHook(input: Partial<WebhookConfig>): WebhookConfig {
  let u: URL;
  try {
    u = new URL(String(input.url || ''));
  } catch {
    throw new Error('the webhook URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('webhook URLs must be http(s)');
  const format = input.format || 'json';
  if (!FORMATS.includes(format)) throw new Error(`format must be ${FORMATS.join(', ')}`);
  const events = (input.events || ['client']).map((x) => String(x).trim()).filter(Boolean);
  return {
    url: u.toString(),
    events: events.length ? events : ['client'],
    format,
    secret: input.secret || undefined,
    label: (input.label || '').slice(0, 80) || undefined,
  };
}

export type WebhookPatch = Partial<Omit<WebhookConfig, 'secret'>> & { secret?: string | null };

/**
 * Hosted servers send webhooks to public addresses only (SSRF): checked when a hook is saved, and again when it is
 * delivered, with the connection pinned to the checked address. `resolve` and `blocked` are for tests.
 */
export interface WebhookGuard {
  resolve?: Resolver;
  blocked?: (ip: string) => boolean;
}

/** An address a hook may not use: not worth retrying. */
class NotAllowed extends Error {}

/** POSTs to a guarded hook: connects to the address that passed the check, never follows a redirect. */
async function pinnedPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  guard: WebhookGuard,
): Promise<{ ok: boolean; status: number }> {
  const u = new URL(url);
  const host = hostOf(u);
  const addr = await publicAddress(host, guard.resolve, guard.blocked ?? isBlockedAddress).catch((e: Error) => {
    throw new NotAllowed(e.message);
  });
  const secure = u.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        host: addr.address,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { ...headers, Host: u.host, 'Content-Length': String(Buffer.byteLength(body)) },
        servername: secure && !net.isIP(host) ? host : undefined,
        lookup: pinnedLookup(addr),
        timeout: timeoutMs,
      } as https.RequestOptions,
      (res) => {
        const status = res.statusCode || 0;
        res.resume();
        res.on('end', () => resolve({ ok: status >= 200 && status < 300, status }));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end(body);
  });
}

export interface WebhookOptions {
  /** config.json "webhooks" (ids cfg_0, cfg_1, …). */
  config?: WebhookConfig[];
  /** VR_WEBHOOK_URL & co (id env). */
  env?: WebhookConfig | null;
  /** Where a link in a message points (public URL, or this machine). */
  baseUrl: string;
  /** Turns server paths in events into URLs (server mode). */
  publicEvent?: (e: ReviewEvent) => ReviewEvent;
  fetchImpl?: typeof fetch;
  /** Public addresses only (server mode); null or absent: any address (local mode). */
  guard?: WebhookGuard | null;
  /**
   * The instance opted in to private addresses (VR_WEBHOOK_ALLOW_PRIVATE: an internal chat server): for workspace #1's
   * hooks only, the operator's own team. Every other workspace's stay on public addresses — whoever runs one may be
   * anyone, and the opt-in would hand them the operator's network (A12 WS-9).
   */
  allowPrivate?: boolean;
  /** Waits before each retry (default 1 s, 4 s, 16 s). */
  retryDelays?: number[];
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface Webhooks {
  handle(e: ReviewEvent): void;
  /** Throws (with a reason) when this instance may not send to the URL's host: before a hook is saved. */
  checkTarget(url: string): Promise<void>;
  list(): WebhookInfo[];
  add(input: Partial<WebhookConfig>, by: string): WebhookInfo;
  /** An empty secret keeps the current one, null removes it. */
  update(id: string, input: WebhookPatch): WebhookInfo;
  remove(id: string): boolean;
  /** Sends a sample event to one hook and waits for the result. */
  test(id: string): Promise<WebhookDelivery>;
  /** Resolves when every delivery started so far has finished (tests). */
  idle(): Promise<void>;
}

/** VR_WEBHOOK_URL, VR_WEBHOOK_FORMAT, VR_WEBHOOK_SECRET, VR_WEBHOOK_EVENTS (comma-separated). */
export function envHook(env: NodeJS.ProcessEnv = process.env): WebhookConfig | null {
  if (!env.VR_WEBHOOK_URL) return null;
  return checkHook({
    url: env.VR_WEBHOOK_URL,
    format: (env.VR_WEBHOOK_FORMAT as WebhookFormat) || 'json',
    secret: env.VR_WEBHOOK_SECRET,
    events: env.VR_WEBHOOK_EVENTS ? env.VR_WEBHOOK_EVENTS.split(',') : undefined,
  });
}

export function createWebhooks(o: WebhookOptions): Webhooks {
  const doFetch = o.fetchImpl || fetch;
  const delays = o.retryDelays || [1000, 4000, 16000];
  const timeout = o.timeoutMs ?? 5000;
  const log = o.log || ((m: string) => console.error(m));
  // The last delivery per hook, per workspace (stored hooks' ids are only unique in theirs).
  const lastOf = new Map<string, WebhookDelivery>();
  const last = {
    get: (id: string) => lastOf.get(wsKey(id)),
    set: (id: string, d: WebhookDelivery) => lastOf.set(wsKey(id), d),
    delete: (id: string) => lastOf.delete(wsKey(id)),
  };
  const inflight = new Set<Promise<unknown>>();
  // The guard for the workspace this runs in (a hook is saved, tested and delivered in its own).
  const guardHere = (): WebhookGuard | null => (o.guard && !(o.allowPrivate && currentWorkspace() === DEFAULT_WORKSPACE) ? o.guard : null);

  function all(): { id: string; hook: WebhookConfig; source: WebhookInfo['source'] }[] {
    const out: { id: string; hook: WebhookConfig; source: WebhookInfo['source'] }[] = [];
    // config.json's and the environment's hooks are the instance's: they hear workspace #1 (the operator's own team),
    // never another team's workspace; each workspace's own are in its webhooks.json.
    if (currentWorkspace() !== DEFAULT_WORKSPACE) {
      for (const [id, h] of Object.entries(loadStored())) out.push({ id, hook: h, source: 'settings' });
      return out;
    }
    (o.config || []).forEach((h, i) => {
      try {
        out.push({ id: `cfg_${i}`, hook: checkHook(h), source: 'config' });
      } catch (e) {
        log(`webhook ${i} in config.json ignored: ${(e as Error).message}`);
      }
    });
    if (o.env) out.push({ id: 'env', hook: o.env, source: 'env' });
    for (const [id, h] of Object.entries(loadStored())) out.push({ id, hook: h, source: 'settings' });
    return out;
  }

  const info = (id: string, hook: WebhookConfig, source: WebhookInfo['source']): WebhookInfo => ({
    id,
    label: hook.label || maskUrl(hook.url),
    url: maskUrl(hook.url),
    events: hook.events?.length ? hook.events : ['client'],
    format: hook.format || 'json',
    secret: !!hook.secret,
    source,
    last: last.get(id) || null,
  });

  // The link in the message opens the workspace the event is about (A12 WS-11).
  const linkFor = (e: ReviewEvent) =>
    `${o.baseUrl.replace(/\/+$/, '')}/${routeIn(e.slug ? `#/v/${encodeURIComponent(e.slug)}${e.id ? `?c=${e.id}` : ''}` : `#/folder/${encodeURIComponent(e.folder || '')}`)}`;
  // Screenshot URLs are only useful absolute; local paths never leave the machine in a chat message.
  function outward(e: ReviewEvent): ReviewEvent {
    const pub = o.publicEvent ? o.publicEvent(e) : e;
    if (!pub.shots) return pub;
    const abs = (s: string | null) => (s?.startsWith('/data/') ? `${o.baseUrl.replace(/\/+$/, '')}${s}` : s);
    return {
      ...pub,
      shots: { clean: abs(pub.shots.clean), marked: abs(pub.shots.marked), ...(pub.shots.range ? { range: abs(pub.shots.range) } : {}) },
    };
  }

  async function deliver(id: string, hook: WebhookConfig, e: ReviewEvent): Promise<WebhookDelivery> {
    const guard = guardHere();
    const ev = outward(e);
    const body = payload(hook.format || 'json', ev, linkFor(e));
    const delivery = crypto.randomUUID();
    let result: WebhookDelivery = { at: isoLocal(), event: e.type, ok: false, status: null, attempts: 0 };
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt) await sleep(delays[attempt - 1]);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'video-review-webhooks',
        'X-VR-Event': e.type,
        'X-VR-Delivery': delivery,
      };
      if (hook.secret) headers['X-VR-Signature'] = sign(hook.secret, body);
      try {
        const res = guard
          ? await pinnedPost(hook.url, headers, body, timeout, guard)
          : await doFetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout), redirect: 'error' });
        result = { at: isoLocal(), event: e.type, ok: res.ok, status: res.status, attempts: attempt + 1 };
        if (res.ok) break;
        result.error = `HTTP ${res.status}`;
        // Retrying a request the receiver refuses (bad URL, bad payload) only repeats the refusal.
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        result = {
          at: isoLocal(),
          event: e.type,
          ok: false,
          status: null,
          attempts: attempt + 1,
          error: (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message,
        };
        if (err instanceof NotAllowed) break;
      }
    }
    last.set(id, result);
    if (!result.ok) log(`webhook ${info(id, hook, 'config').label}: ${result.error} after ${result.attempts} attempt(s)`);
    return result;
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  }

  return {
    handle(e) {
      for (const { id, hook } of all()) if (wants(hook, e)) track(deliver(id, hook, e)).catch(() => {});
    },
    async checkTarget(url) {
      const guard = guardHere();
      if (!guard) return;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return; // checkHook says what's wrong with it
      }
      await publicAddress(hostOf(u), guard.resolve, guard.blocked ?? isBlockedAddress);
    },
    list: () => all().map(({ id, hook, source }) => info(id, hook, source)),
    add(input, by) {
      const hook = checkHook(input);
      const id = `wh_${crypto.randomBytes(5).toString('hex')}`;
      withLock(LOCK_DIR(), () => saveStored({ ...loadStored(), [id]: { ...hook, created: isoLocal(), by } }));
      return info(id, hook, 'settings');
    },
    update(id, input) {
      return withLock(LOCK_DIR(), () => {
        const hooks = loadStored();
        const cur = hooks[id];
        if (!cur) throw new Error('only webhooks made in Settings can be changed here');
        const secret = input.secret === undefined || input.secret === '' ? cur.secret : input.secret || undefined;
        const hook = checkHook({ ...cur, ...input, secret });
        hooks[id] = { ...cur, ...hook };
        saveStored(hooks);
        return info(id, hooks[id], 'settings');
      });
    },
    remove(id) {
      return withLock(LOCK_DIR(), () => {
        const hooks = loadStored();
        if (!hooks[id]) return false;
        delete hooks[id];
        saveStored(hooks);
        last.delete(id);
        return true;
      });
    },
    async test(id) {
      const hit = all().find((h) => h.id === id);
      if (!hit) throw new Error('no such webhook');
      const sample: ReviewEvent = {
        at: isoLocal(),
        type: 'comment',
        by: 'guest:Test client',
        video: '/example/launch-film.mp4',
        slug: 'example',
        session: null,
        id: 'c_test00',
        v: 2,
        frame: 120,
        timecode: '00:05:00',
        text: 'This is a test from video-review: the logo could come in a little later.',
      };
      return track(deliver(id, hit.hook, sample));
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
