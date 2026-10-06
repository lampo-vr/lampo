// The mailer: a request hands a rendered message over and goes on (send() never waits and never throws); a small queue
// on disk sends it in the background, with retries and backoff, so a relay that is down for an hour loses nothing and a
// restart picks up where it was. Two transports:
//   log   every message is written to <cache>/outbox/ (JSON, the raw .eml and an .html preview) instead of being sent —
//         the default when no SMTP relay is configured, and what every test uses;
//   smtp  through VR_SMTP_URL (lib/mail/smtp.ts).
// Limits: per recipient (an address can't be flooded through "forgot password" or invites) and for the whole server
// (the relay's quota). Logs name recipients only by a keyed hash (addrHash) and never print a link or a token.
// The queue file holds each message sealed (AES-256-GCM, a key derived from the store's secret): a copy of the file
// alone gives no reset link away.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RateLimit } from '../rateLimit.ts';
import { withLock, writeAtomic } from '../store.ts';
import { type MailConfig, workspaceShare } from './config.ts';
import { type Address, type Composed, checkAddress, compose, type Inline } from './mime.ts';
import { describeTarget, parseSmtpUrl, SmtpError, sendSmtp } from './smtp.ts';

/** What the account flows send (lib/mail/templates.ts renders each). */
export type MailKind =
  | 'verify'
  | 'verify-change'
  | 'email-changed'
  | 'reset'
  | 'password-changed'
  | 'invite'
  | 'welcome'
  | 'new-sign-in'
  | 'account-removed'
  | 'account-disabled'
  | 'account-deleted'
  | 'workspace-suspended'
  | 'workspace-deleted'
  | 'signup-exists'
  | 'test'
  /** A message about a workspace in a module's own words (server/extension.ts `mail`): its plan, a trial. */
  | 'notice';

export interface MailMessage {
  kind: MailKind;
  to: string;
  lang: string;
  subject: string;
  text: string;
  html: string;
  /** Not sent after this (ms): a link that expired is not worth delivering. */
  expires?: number;
  /** The workspace whose people asked for it (an invite): counted against that workspace's share of the hour. */
  workspace?: string;
  /**
   * The account whose action sent it (an invite's inviter, an address change): counted against that account's share of
   * the hour, whichever workspace it works in — one account's own workspaces don't add up to more.
   */
  account?: string;
  /**
   * Who asked for it, signed out (the asking address as limits key it, `addressKey`: forgot password, a confirmation
   * asked again): one message of a kind per asker waits in the queue at a time, more are dropped (A13 VERIFY-4: one
   * address's 80 resets an hour held a real person's back past its link's life).
   */
  asker?: string;
}

/**
 * What lets a person in — a password reset, a sign-up's confirmation — goes first, and a part of the server's hour is
 * kept for it: invites and address changes queued by the hundred never hold one back past its link's life.
 */
const URGENT: ReadonlySet<MailKind> = new Set(['reset', 'verify']);
/**
 * A reset goes before everything, a sign-up's confirmation too, and a part of the hour is kept for resets alone: anyone
 * can sign up (a flood of confirmations to throwaway addresses), while a reset is someone locked out of their account,
 * its link alive an hour (A13 CLOUD-6: 80 confirmations held a reset back four hours).
 */
const lane = (kind: MailKind): number => (kind === 'reset' ? 0 : URGENT.has(kind) ? 1 : 2);

/** Ready for a transport: the message, composed. */
export interface Outgoing extends MailMessage {
  id: string;
  from: Address;
  composed: Composed;
}

export interface Transport {
  kind: 'log' | 'smtp';
  /** Where it delivers, for logs: the outbox, or smtp://host:port (never credentials). */
  where: string;
  deliver(m: Outgoing): Promise<void>;
}

/** The brand's icon, inline in every HTML message (cid:lampo-icon): no remote image, no tracking. */
export const ICON_CID = 'lampo-icon';
const ICON_FILE = new URL('./icon.png', import.meta.url);
let icon: Buffer | null = null;
export function iconInline(): Inline[] {
  try {
    icon ??= fs.readFileSync(ICON_FILE);
  } catch {
    return [];
  }
  return [{ cid: ICON_CID, type: 'image/png', name: 'lampo.png', data: icon }];
}

/** A recipient as logs may name it: 10 hex characters of an HMAC with the store's secret (stable, not reversible). */
export const addrHash = (secret: Buffer, address: string) =>
  crypto.createHmac('sha256', secret).update(`mail\n${address.trim().toLowerCase()}`).digest('hex').slice(0, 10);

/** Addresses no relay can deliver to: the machine owner's starting address, reserved names. */
export const undeliverable = (address: string) => /@([^@]*\.)?(localhost|invalid|local)$/i.test(address.trim());

// ---------------------------------------------------------------- transports

const OUTBOX_KEEP = 300;

/**
 * The log transport: one message = `<when>-<n>-<kind>-<id>.json` (+ `.eml`, `.html`), named so they sort in the order
 * they were written; the newest OUTBOX_KEEP are kept.
 */
let written = 0;
export function logTransport(dir: string): Transport {
  return {
    kind: 'log',
    where: dir,
    async deliver(m) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
      const base = path.join(dir, `${stamp}-${String(written++ % 10000).padStart(4, '0')}-${m.kind}-${m.id}`);
      const record = {
        id: m.id,
        kind: m.kind,
        lang: m.lang,
        to: m.to,
        from: m.composed.headers.From,
        subject: m.subject,
        headers: m.composed.headers,
        text: m.text,
        html: m.html,
        at: new Date().toISOString(),
      };
      // They hold live links: readable by the server's user only.
      fs.writeFileSync(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      fs.writeFileSync(`${base}.eml`, m.composed.raw, { mode: 0o600 });
      // A preview a browser opens: the inline icon as a data: URI.
      const img = iconInline()[0];
      const html = img ? m.html.split(`cid:${ICON_CID}`).join(`data:image/png;base64,${img.data.toString('base64')}`) : m.html;
      fs.writeFileSync(`${base}.html`, html, { mode: 0o600 });
      prune(dir);
    },
  };
}

function prune(dir: string): void {
  const json = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of json.slice(0, Math.max(0, json.length - OUTBOX_KEEP))) {
    const stem = f.slice(0, -5);
    for (const ext of ['.json', '.eml', '.html']) fs.rmSync(path.join(dir, stem + ext), { force: true });
  }
}

/** What the outbox holds, oldest first (tests, `vr admin mail-test`, the docs' recipe). */
export function readOutbox(dir: string): (MailMessage & { id: string; at: string; headers: Record<string, string> })[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function smtpTransport(url: string, helo: string): Transport {
  const target = parseSmtpUrl(url);
  return {
    kind: 'smtp',
    where: describeTarget(target),
    async deliver(m) {
      await sendSmtp(target, { from: m.from.address, to: m.to, raw: m.composed.raw, helo });
    },
  };
}

// ---------------------------------------------------------------- the queue

interface Entry {
  id: string;
  kind: MailKind;
  /** addrHash of the recipient: what the logs and the per-recipient limits go by. */
  to: string;
  /** The message, sealed. */
  sealed: string;
  attempts: number;
  /** When it is due (ms). */
  next: number;
  created: number;
  expires?: number;
  /** The keyed hash of who asked for it (MailMessage.asker), when someone signed out did. */
  asker?: string;
  /** The last error, for `vr admin mail-test` and diagnostics (no address in it). */
  error?: string;
}

/** Waits before each new try: half a minute, then longer, up to eight hours; about 16 hours in all. */
export const BACKOFF_MS = [30e3, 2 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 4 * 3600e3, 8 * 3600e3];

export interface MailerOptions {
  config: MailConfig;
  /** Where queue.json lives (data/mail). */
  dir: string;
  /** The log transport's folder (cache/outbox). */
  outbox: string;
  /** The sender. */
  from: Address;
  /** Our name: EHLO and Message-IDs (the public URL's host). */
  host: string;
  /** The store's secret: seals queued messages and keys the hashes in logs. */
  secret: () => Buffer;
  /** Where log lines go (console.log). */
  log?: (line: string) => void;
  /** Tests: another transport (a relay that fails), another clock. */
  transport?: Transport;
  now?: () => number;
  /** Per recipient: at most this many an hour and a day. */
  perRecipient?: { hour: number; day: number };
}

export interface Mailer {
  readonly transport: 'log' | 'smtp';
  /** Where it delivers: the outbox folder, or smtp://host:port (never credentials). */
  readonly where: string;
  /** The outbox the log transport writes to. */
  readonly outbox: string;
  /**
   * Queues a message and returns at once. False when it was dropped (undeliverable, over the recipient's limit, over its
   * workspace's share of the hour).
   */
  send(m: MailMessage): boolean;
  /**
   * Whether a message of `kind` asked for by `asker` waits in the queue (send() drops another): asked before a link is
   * made for one, so a newer link never replaces the one already mailed without being sent itself.
   */
  askerWaits(kind: MailKind, asker: string): boolean;
  /** Seconds until `workspace` may send again; 0 while its share of the hour has room. */
  workspaceWait(workspace: string): number;
  /** Seconds until `account` may send again (its share of the hour, across its workspaces); 0 while it has room. */
  accountWait(account: string): number;
  /** One workspace's share of the hourly budget. */
  readonly workspaceShare: number;
  /**
   * Runs `work` (what decides and queues mail for an address) `ms` from now: an answer that must not tell whether an
   * address has an account leaves before it, and the work never follows the answer at once (A12 INV-REV-8). flush()
   * waits for it.
   */
  later(work: () => void, ms: number): void;
  /** Sends what is due now and resolves when that is done (the timer does this by itself; tests await it). */
  flush(): Promise<void>;
  /** Messages waiting (due now or later). */
  waiting(): number;
  /** The hash logs use for this address. */
  hash(address: string): string;
  stop(): void;
}

export function createMailer(o: MailerOptions): Mailer {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const transport = o.transport ?? (o.config.transport === 'smtp' && o.config.smtp_url ? smtpTransport(o.config.smtp_url, o.host) : logTransport(o.outbox));
  const file = path.join(o.dir, 'queue.json');
  const hash = (a: string) => addrHash(o.secret(), a);
  const per = o.perRecipient ?? { hour: 8, day: 30 };
  const hourly = new RateLimit(per.hour, 3600e3, { now });
  const daily = new RateLimit(per.day, 86400e3, { now });
  const server = new RateLimit(o.config.per_hour, 3600e3, { now });
  // Each workspace's own share of the hour (what its admins' invites take): one team can't use up the server's budget
  // and hold back everyone else's resets and confirmations.
  const share = workspaceShare(o.config);
  const perWorkspace = new RateLimit(share, 3600e3, { now });
  const perAccount = new RateLimit(share, 3600e3, { now });
  // Everything but the urgent lane (resets, confirmations) gets at most three quarters of the server's hour, and so does
  // everything but resets: the last quarter is theirs.
  const threeQuarters = Math.max(1, o.config.per_hour - Math.max(1, Math.floor(o.config.per_hour / 4)));
  const bulk = new RateLimit(threeQuarters, 3600e3, { now });
  const notResets = new RateLimit(threeQuarters, 3600e3, { now });

  const key = () => crypto.createHmac('sha256', o.secret()).update('video-review mail queue').digest();
  const seal = (m: MailMessage) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(JSON.stringify(m), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
  };
  const unseal = (s: string): MailMessage | null => {
    try {
      const [iv, tag, body] = s.split('.').map((x) => Buffer.from(x, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', key(), iv as Buffer);
      d.setAuthTag(tag as Buffer);
      return JSON.parse(Buffer.concat([d.update(body as Buffer), d.final()]).toString('utf8')) as MailMessage;
    } catch {
      return null;
    }
  };

  const load = (): Entry[] => {
    try {
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: Entry[] }).entries ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log(`mail: the queue file is unreadable, starting a new one (${(e as Error).message})`);
      return [];
    }
  };
  const change = <T>(fn: (entries: Entry[]) => T | Entry[]): void => {
    fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    withLock(o.dir, () => {
      const entries = load();
      const out = fn(entries);
      writeAtomic(file, `${JSON.stringify({ entries: Array.isArray(out) ? out : entries }, null, 2)}\n`);
      fs.chmodSync(file, 0o600);
    });
  };
  const remove = (id: string) => change((all) => all.filter((x) => x.id !== id));

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const due = load().reduce((m, e) => Math.min(m, e.next), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(due)) return;
    timer = setTimeout(() => void flush(), Math.max(0, due - now()));
    // A queued message never keeps the process alive (tests, `vr`): the server's process is alive anyway.
    timer.unref();
  };

  const drop = (e: Entry, why: string) => {
    remove(e.id);
    log(`mail: dropped ${e.kind} to ${e.to}: ${why}`);
  };
  /** Hands one message to the transport: true when it went out (what the hour counts), false when dropped or to retry. */
  async function sendOne(e: Entry): Promise<boolean> {
    const m = unseal(e.sealed);
    if (!m) {
      drop(e, 'it can no longer be read (the store secret changed?)');
      return false;
    }
    if (m.expires && m.expires <= now()) {
      drop(e, 'its link expired before it could be sent');
      return false;
    }
    try {
      const composed = compose({ from: o.from, to: m.to, subject: m.subject, text: m.text, html: m.html, lang: m.lang, inline: iconInline(), host: o.host });
      await transport.deliver({ ...m, id: e.id, from: o.from, composed });
      remove(e.id);
      log(`mail: sent ${e.kind} to ${e.to} (${transport.kind}${e.attempts ? `, try ${e.attempts + 1}` : ''})`);
      return true;
    } catch (err) {
      const permanent = err instanceof SmtpError && err.permanent;
      const reason = scrub((err as Error).message, m.to);
      const attempts = e.attempts + 1;
      if (permanent || attempts > BACKOFF_MS.length) {
        drop(e, `${permanent ? 'refused' : `gave up after ${attempts} tries`}: ${reason}`);
        return false;
      }
      const next = now() + (BACKOFF_MS[attempts - 1] as number);
      change((all) => {
        const x = all.find((y) => y.id === e.id);
        if (x) Object.assign(x, { attempts, next, error: reason });
      });
      log(`mail: ${e.kind} to ${e.to} not sent (try ${attempts}), again in ${Math.round((next - now()) / 60e3) || 1} min: ${reason}`);
      return false;
    }
  }

  async function run(): Promise<void> {
    do {
      again = false;
      // Resets first, then confirmations, then the rest; in each lane by when it is due.
      const due = load()
        .filter((e) => e.next <= now())
        .sort((a, b) => lane(a.kind) - lane(b.kind) || a.next - b.next);
      // The server's own cap: what is over it waits for the window instead of being dropped; the rest of the hour beyond
      // the bulk share is the urgent lane's, and beyond what all but resets may take, the resets'. Only mail that went
      // out counts toward the hour (A13 VERIFY-4): an expired link is dropped before it is held or counted.
      const held = new Map<string, number>();
      for (const e of due) {
        if (stopped) return;
        if (e.expires && e.expires <= now()) {
          drop(e, 'its link expired before it could be sent');
          continue;
        }
        const urgent = URGENT.has(e.kind);
        const reset = e.kind === 'reset';
        const wait = !server.allows('all')
          ? server.retryAfter('all')
          : !reset && !notResets.allows('all')
            ? notResets.retryAfter('all')
            : !urgent && !bulk.allows('all')
              ? bulk.retryAfter('all')
              : 0;
        if (wait) {
          held.set(e.id, now() + wait * 1000);
          continue;
        }
        if (!(await sendOne(e))) continue;
        server.hit('all');
        if (!reset) notResets.hit('all');
        if (!urgent) bulk.hit('all');
      }
      if (held.size) {
        change((all) => {
          for (const x of all) {
            const until = held.get(x.id);
            if (until) x.next = until;
          }
        });
        log(`mail: the server's limit (${o.config.per_hour} an hour) is reached; ${held.size} waiting`);
      }
    } while (again && !stopped);
  }

  // Work that runs a while after an answer (later): flush() waits for it, stop() lets it go.
  const deferred = new Map<NodeJS.Timeout, () => void>();
  const settle = async () => {
    while (deferred.size) await new Promise<void>((r) => setTimeout(r, 10));
  };
  function flush(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = settle()
      .then(run)
      .catch((e) => log(`mail: the queue stopped: ${(e as Error).message}`))
      .finally(() => {
        running = null;
        schedule();
      });
    return running;
  }

  // Whatever waited from before a restart goes out (or waits for its time).
  schedule();

  // The queue keeps who asked only as a keyed hash.
  const askerHash = (asker: string) => hash(`asker\n${asker}`);
  const askerWaits = (kind: MailKind, asker: string) => {
    const a = askerHash(asker);
    return load().some((e) => e.asker === a && e.kind === kind);
  };

  return {
    transport: transport.kind,
    where: transport.where,
    outbox: o.outbox,
    hash,
    askerWaits,
    workspaceShare: share,
    workspaceWait: (ws) => perWorkspace.retryAfter(ws),
    accountWait: (id) => perAccount.retryAfter(id),
    send(m) {
      try {
        const to = m.to.trim();
        const h = hash(to);
        try {
          checkAddress(to);
        } catch {
          log(`mail: not sending ${m.kind} to ${h}: not an email address`);
          return false;
        }
        if (undeliverable(to)) {
          log(`mail: not sending ${m.kind} to ${h}: the address can't receive mail`);
          return false;
        }
        if (hourly.retryAfter(h) || daily.retryAfter(h)) {
          log(`mail: not sending ${m.kind} to ${h}: too many messages to this address`);
          return false;
        }
        if (m.workspace && !perWorkspace.allows(m.workspace)) {
          log(`mail: not sending ${m.kind} to ${h}: its workspace has sent its ${share} for this hour`);
          return false;
        }
        if (m.account && !perAccount.allows(m.account)) {
          log(`mail: not sending ${m.kind} to ${h}: the account that asked has sent its ${share} for this hour`);
          return false;
        }
        // one of a kind per asking address waits at a time: a flood from one address takes one place in its lane
        const asker = m.asker ? askerHash(m.asker) : undefined;
        if (m.asker && askerWaits(m.kind, m.asker)) {
          log(`mail: not sending ${m.kind} to ${h}: one asked from the same address is waiting`);
          return false;
        }
        hourly.hit(h);
        daily.hit(h);
        if (m.workspace) perWorkspace.hit(m.workspace);
        if (m.account) perAccount.hit(m.account);
        const id = `m_${crypto.randomBytes(6).toString('hex')}`;
        const t = now();
        const { asker: _asker, ...kept } = m;
        change((all) => {
          all.push({
            id,
            kind: m.kind,
            to: h,
            sealed: seal({ ...kept, to }),
            attempts: 0,
            next: t,
            created: t,
            ...(m.expires ? { expires: m.expires } : {}),
            ...(asker ? { asker } : {}),
          });
        });
        log(`mail: queued ${m.kind} to ${h}`);
        queueMicrotask(() => void flush());
        return true;
      } catch (e) {
        log(`mail: could not queue ${m.kind}: ${(e as Error).message}`);
        return false;
      }
    },
    flush,
    later(work, ms) {
      const t = setTimeout(() => {
        deferred.delete(t);
        try {
          work();
        } catch (e) {
          log(`mail: ${(e as Error).message}`);
        }
      }, ms);
      t.unref?.();
      deferred.set(t, work);
    },
    waiting: () => load().length,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const t of deferred.keys()) clearTimeout(t);
      deferred.clear();
    },
  };
}

/** An error as logs may show it: no address, nothing that looks like a token. */
function scrub(message: string, address: string): string {
  return message
    .split(address)
    .join('recipient')
    .replace(/[^\s<>@]+@[^\s<>@]+/g, '<address>')
    .replace(/\b(?:vt|rt|inv|vr)_[\w-]{8,}/g, '<token>')
    .slice(0, 200);
}
