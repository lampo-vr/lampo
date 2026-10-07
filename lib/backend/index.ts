// Which store `lampo` and the MCP server talk to: a hosted server after `lampo login` (or LAMPO_SERVER + LAMPO_TOKEN), else data/
// on this machine.
import { adoptOldCache, cacheRoot, readCredentials } from './credentials.ts';
import { createLocalBackend } from './local.ts';
import { createRemoteBackend } from './remote.ts';
import type { Backend } from './types.ts';

export type { Backend } from './types.ts';

export function openBackend(): Backend {
  const c = readCredentials();
  if (!c) return createLocalBackend();
  adoptOldCache();
  return createRemoteBackend(c, { cacheRoot: cacheRoot() });
}
