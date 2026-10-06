// The accounts a workspace publishes to (Settings → Publishing): YouTube through the person's own Google OAuth client,
// Instagram and Facebook through a unified posting API with their own key. Kept per workspace in
// data/publish/connections.json under one lock; the secrets (client secret, refresh and access tokens, API key) only
// sealed (lib/publish/seal.ts), never in an answer, an event or a log line — what anyone reads is `connectionInfo`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, isoLocal } from '../paths.ts';
import { withLock, writeAtomic } from '../store.ts';
import type { ConnectionKind, PublishAccount, PublishConnectionInfo, PublishPlatform } from '../types.ts';
import { keyHint, seal, unseal } from './seal.ts';

/** What a connection needs to act, sealed at rest. */
export interface YouTubeSecret {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
  /** When the access token runs out (ms since the epoch). */
  access_expires?: number;
}
export interface ZernioSecret {
  api_key: string;
}
export type ConnectionSecret = YouTubeSecret | ZernioSecret;

/** One connection as stored: what anyone may see, plus the sealed secret. */
export interface StoredConnection {
  id: string;
  kind: ConnectionKind;
  label: string;
  state: PublishConnectionInfo['state'];
  error?: string;
  accounts: PublishAccount[];
  key_hint: string;
  audited?: boolean;
  created: string;
  by: string;
  by_id?: string;
  checked?: string;
  sealed: string;
}

const dir = (): string => path.join(dataDir(), 'publish');
const FILE = (): string => path.join(dir(), 'connections.json');
const LOCK = (): string => path.join(dir(), '.connections');
/** Connections one workspace may keep. */
export const CONNECTIONS_MAX = 20;

/** Every connection of this workspace (none when there is no file; a file that can't be read throws). */
export function listConnections(): StoredConnection[] {
  let text: string;
  try {
    text = fs.readFileSync(FILE(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(text) as { connections?: StoredConnection[] };
  return Array.isArray(parsed?.connections) ? parsed.connections : [];
}

export const findConnection = (id: string | null | undefined): StoredConnection | null => (id ? (listConnections().find((c) => c.id === id) ?? null) : null);

function save(all: StoredConnection[]): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeAtomic(FILE(), `${JSON.stringify({ connections: all }, null, 2)}\n`);
  try {
    fs.chmodSync(FILE(), 0o600);
  } catch {}
}

/** The platforms a kind of connection posts to (Zernio: the ones its accounts are on). */
export function platformsOf(c: Pick<StoredConnection, 'kind' | 'accounts'>): PublishPlatform[] {
  if (c.kind === 'youtube') return ['youtube'];
  return [...new Set(c.accounts.map((a) => a.platform))];
}

/** Whether the platform or the posting API holds a scheduled post itself (YouTube's publishAt); Lampo sends the rest. */
export const holdsSchedule = (kind: ConnectionKind): boolean => kind === 'youtube';

/** A connection as anyone may see it: never its secret. `redirect` = the OAuth redirect URI for YouTube. */
export function connectionInfo(c: StoredConnection, redirect?: string): PublishConnectionInfo {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    state: c.state,
    ...(c.error ? { error: c.error } : {}),
    platforms: platformsOf(c),
    accounts: c.accounts,
    key_hint: c.key_hint,
    ...(c.kind === 'youtube' && redirect ? { redirect_uri: redirect } : {}),
    ...(c.kind === 'youtube' ? { audited: !!c.audited } : {}),
    holds_schedule: holdsSchedule(c.kind),
    created: c.created,
    by: c.by,
    ...(c.checked ? { checked: c.checked } : {}),
  };
}

/** The secret of a connection of this workspace; null when there is none or it doesn't open. */
export function secretOf<T extends ConnectionSecret>(c: StoredConnection): T | null {
  return unseal<T>(c.id, c.sealed);
}

export interface NewConnection {
  kind: ConnectionKind;
  label: string;
  secret: ConnectionSecret;
  by: string;
  by_id?: string;
}

export function addConnection(input: NewConnection): StoredConnection {
  const id = `pc_${crypto.randomBytes(6).toString('hex')}`;
  const hint = 'api_key' in input.secret ? keyHint(input.secret.api_key) : keyHint(input.secret.client_id);
  const c: StoredConnection = {
    id,
    kind: input.kind,
    label: input.label.trim().slice(0, 80) || (input.kind === 'youtube' ? 'YouTube' : 'Zernio'),
    state: input.kind === 'youtube' ? 'needs_auth' : 'error',
    accounts: [],
    key_hint: hint,
    created: isoLocal(),
    by: input.by,
    ...(input.by_id ? { by_id: input.by_id } : {}),
    sealed: seal(id, input.secret),
  };
  return withLock(LOCK(), () => {
    const all = listConnections();
    if (all.length >= CONNECTIONS_MAX) throw new Error(`a workspace keeps ${CONNECTIONS_MAX} connections at most: remove one first`);
    save([...all, c]);
    return c;
  });
}

export interface ConnectionChange {
  label?: string;
  audited?: boolean;
  state?: StoredConnection['state'];
  error?: string | null;
  accounts?: PublishAccount[];
  checked?: string;
  /** Replaces the secret (sealed again for this connection). */
  secret?: ConnectionSecret;
}

/** Changes one connection under the lock; throws when this workspace has none with that id. */
export function changeConnection(
  id: string,
  change: ConnectionChange | ((c: StoredConnection, secret: ConnectionSecret | null) => ConnectionChange),
): StoredConnection {
  return withLock(LOCK(), () => {
    const all = listConnections();
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error('no such connection');
    const ch = typeof change === 'function' ? change(c, secretOf(c)) : change;
    if (ch.label !== undefined) c.label = ch.label.trim().slice(0, 80) || c.label;
    if (ch.audited !== undefined) c.audited = ch.audited;
    if (ch.state) c.state = ch.state;
    if (ch.error === null) delete c.error;
    else if (ch.error !== undefined) c.error = ch.error;
    if (ch.accounts) c.accounts = ch.accounts;
    if (ch.checked) c.checked = ch.checked;
    if (ch.secret) {
      c.sealed = seal(c.id, ch.secret);
      c.key_hint = 'api_key' in ch.secret ? keyHint(ch.secret.api_key) : keyHint(ch.secret.client_id);
    }
    save(all);
    return c;
  });
}

/** Removes a connection and its secret; the posts that went through it keep their history. */
export function removeConnection(id: string): StoredConnection | null {
  return withLock(LOCK(), () => {
    const all = listConnections();
    const c = all.find((x) => x.id === id) ?? null;
    if (c) save(all.filter((x) => x.id !== id));
    return c;
  });
}
