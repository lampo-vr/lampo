// Which workspace the code running now works for (lib/workspaces.ts). A request, and every job, timer and stream it
// starts, carries its workspace through AsyncLocalStorage; paths, caches and live updates ask `currentWorkspace()`.
// Work that runs outside any workspace (start-up, the machine's file watchers) belongs to workspace #1 while that is
// the only one: on a person's own machine, and on a hosted server until a second team arrives. From then on such work
// is refused instead: a bug must never read or write another team's store by falling back to the first one.
// The core lives in lib/paths.ts (a leaf module: it resolves every path through it); this is its public face.
import { AsyncResource } from 'node:async_hooks';
import { currentWorkspace, severalWorkspaces } from './paths.ts';

export {
  currentWorkspace,
  DEFAULT_WORKSPACE,
  enterProcessWorkspace,
  explicitWorkspace,
  inWorkspace,
  NoWorkspaceError,
  setStrictWorkspaces,
  severalWorkspaces,
  WORKSPACE_ID,
} from './paths.ts';

/**
 * fn bound to the workspace it was created in. For work queued now and run later from somewhere else (a job queue's
 * loop, a listener): without it the work would run for whichever workspace happened to drive the queue.
 */
// biome-ignore lint/suspicious/noExplicitAny: binds any function shape
export const boundToWorkspace = <F extends (...args: any[]) => any>(fn: F): F => AsyncResource.bind(fn) as F;

/**
 * An in-memory key for the workspace running now: maps and sets keyed by a slug, a render's hash or a token must
 * never be shared by two workspaces (two teams can upload the same file under the same name).
 */
export const wsKey = (key: string): string => `${currentWorkspace()}\u0000${key}`;

/** The workspace a `wsKey` key was made in ('' for a key that isn't one): what a shared memory is fair between. */
export const workspaceOfKey = (key: string): string => {
  const end = key.indexOf('\u0000');
  return end < 0 ? '' : key.slice(0, end);
};

/**
 * An app route that leaves the server — a notification's, a chat message's, an agent's link (`#/v/<slug>?c=…`) — with
 * the workspace it belongs to (`w=<id>`), when there is more than one: the same name can be another team's video, and
 * the app opens a link in the workspace it names (web/src/lib/nav.ts takeWorkspace). Unchanged with one workspace.
 */
export function routeIn(route: string, ws: string = currentWorkspace()): string {
  if (!severalWorkspaces()) return route;
  return `${route}${route.includes('?') ? '&' : '?'}w=${ws}`;
}
