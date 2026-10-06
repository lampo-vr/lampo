// Which store `vr` and the MCP server talk to: a hosted server after `vr login` (or VR_SERVER + VR_TOKEN), else data/
// on this machine.
import { cacheRoot, readCredentials } from './credentials.ts';
import { createLocalBackend } from './local.ts';
import { createRemoteBackend } from './remote.ts';
import type { Backend } from './types.ts';

export type { Backend } from './types.ts';

export function openBackend(): Backend {
  const c = readCredentials();
  return c ? createRemoteBackend(c, { cacheRoot: cacheRoot() }) : createLocalBackend();
}
