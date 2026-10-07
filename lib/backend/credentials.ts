// `lampo login` remembers the server and an API token here (0600). LAMPO_SERVER + LAMPO_TOKEN in the environment win
// (or the older VR_ spelling), so an agent or CI job can point at a server without touching the file; LAMPO_REMOTE=0
// forces the local store. The folders are named lampo; before the command was `lampo` they were video-review, and a
// login or a cache there is still read while the new folder has none (and never written).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../env.ts';

export interface Credentials {
  server: string;
  token: string;
  /** Id of the token on the server, so `lampo logout` can revoke it. */
  token_id?: string;
  user?: { name: string; email: string; role: string };
  saved?: string;
}

const home = os.homedir();
const configHome = (): string => process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const cacheHome = (): string => process.env.XDG_CACHE_HOME || path.join(home, '.cache');
/** The folder the name had before the command was `lampo`. */
const OLD_NAME = 'video-review';

export const configDir = (): string => path.join(configHome(), 'lampo');
export const credentialsFile = (): string => path.join(configDir(), 'credentials.json');
/** Where an older `lampo login` saved it: read while credentialsFile() isn't there, never written. */
export const oldCredentialsFile = (): string => path.join(configHome(), OLD_NAME, 'credentials.json');
/** Downloaded screenshots, frames and taste files of remote reviews. */
export const cacheRoot = (): string => path.join(cacheHome(), 'lampo');
/** The cache an older `vr` kept: only its unfinished uploads are carried over (adoptOldCache), never written. */
export const oldCacheRoot = (): string => path.join(cacheHome(), OLD_NAME);

/** The saved login to read: this one's, else the one an older `lampo login` saved. */
function savedLogin(): string {
  const now = credentialsFile();
  if (fs.existsSync(now)) return now;
  const old = oldCredentialsFile();
  return fs.existsSync(old) ? old : now;
}

/**
 * A cache made before the command was `lampo`, while the new one isn't there yet: what an unfinished upload needs to
 * go on (tus's list of them) comes along into the new one. Screenshots and frames are fetched again when asked for.
 */
export function adoptOldCache(root = cacheRoot(), old = oldCacheRoot()): void {
  if (fs.existsSync(root)) return;
  const uploads = path.join(old, 'uploads.json');
  try {
    const text = fs.readFileSync(uploads, 'utf8');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'uploads.json'), text, { mode: 0o600 });
  } catch {}
}

export function readCredentials(): Credentials | null {
  if (settings.LAMPO_REMOTE === '0') return null;
  if (settings.LAMPO_SERVER && settings.LAMPO_TOKEN) return { server: settings.LAMPO_SERVER, token: settings.LAMPO_TOKEN };
  try {
    const c = JSON.parse(fs.readFileSync(savedLogin(), 'utf8')) as Credentials;
    return c.server && c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveCredentials(c: Credentials): string {
  const file = credentialsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Forgets the saved login: the older place's too, or reading it would keep this machine signed in. */
export function clearCredentials(): boolean {
  let cleared = false;
  for (const file of [credentialsFile(), oldCredentialsFile()])
    try {
      fs.rmSync(file);
      cleared = true;
    } catch {}
  return cleared;
}
