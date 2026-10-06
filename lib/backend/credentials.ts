// `vr login` remembers the server and an API token here (0600). VR_SERVER + VR_TOKEN in the environment win, so
// an agent or CI job can point at a server without touching the file; VR_REMOTE=0 forces the local store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Credentials {
  server: string;
  token: string;
  /** Id of the token on the server, so `vr logout` can revoke it. */
  token_id?: string;
  user?: { name: string; email: string; role: string };
  saved?: string;
}

const home = os.homedir();
export const configDir = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'video-review');
export const credentialsFile = (): string => path.join(configDir(), 'credentials.json');
/** Downloaded screenshots, frames and taste files of remote reviews. */
export const cacheRoot = (): string => path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'video-review');

export function readCredentials(): Credentials | null {
  if (process.env.VR_REMOTE === '0') return null;
  if (process.env.VR_SERVER && process.env.VR_TOKEN) return { server: process.env.VR_SERVER, token: process.env.VR_TOKEN };
  try {
    const c = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')) as Credentials;
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

export function clearCredentials(): boolean {
  try {
    fs.rmSync(credentialsFile());
    return true;
  } catch {
    return false;
  }
}
