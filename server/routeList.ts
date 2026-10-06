// Every route an Express app answers, read from its router stack: [METHOD, path pattern]. Express 5 keeps routes on
// router layers; nested routers (app.use(router)) have their own stack. `all` routes come back as '*'. Pattern routes
// (a RegExp: the app shell's fallback) are left out: they have no path to fill in. Used where the app refuses an
// extension module's route that is its own (server/app.ts) and by the route walk (test/unit/route-walk.test.ts).
// Type imports only: a test may import it before its store is set up.
import type { Express } from 'express';

interface Layer {
  name?: string;
  route?: { path: string | string[] | RegExp; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  /** Express's own layers: mounted at the root (`app.use(fn)`), not under a path. */
  slash?: boolean;
}

/**
 * The app's routes. A router mounted under a path (`app.use('/x', router)`) is refused: Express keeps its routes
 * without that path and no longer has it as text, so '/y' would be listed for what answers '/x/y' — a module route
 * there would slip past the check that refuses the app's own routes, and the route walk would ask the wrong path
 * (sweep 2 SW-6). Every router goes at the root with its full paths, as server/app.ts mounts them.
 */
export function registeredRoutes(app: Express): [string, string][] {
  const found: [string, string][] = [];
  const walk = (stack: Layer[]) => {
    for (const l of stack) {
      if (l.route) {
        for (const p of [l.route.path].flat()) {
          if (typeof p !== 'string') continue;
          for (const [m, on] of Object.entries(l.route.methods)) if (on) found.push([m === '_all' ? '*' : m.toUpperCase(), p]);
        }
      } else if (l.handle?.stack) {
        if (l.slash === false)
          throw new Error(
            `a router mounted under a path (${l.name ?? 'a router'}): its routes can't be read with their paths; mount it at the root with full paths`,
          );
        walk(l.handle.stack);
      }
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack);
  return found;
}

/** A route pattern as the routers match it: exactly, case-sensitive, `:name` one segment, `{*name}` the rest. */
export const routeMatcher = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{\*[a-z]+\}/gi, '.+')
      .replace(/:[a-z]+/gi, '[^/]+')}$`,
  );

/** The registered route that answers `method path` (a GET route answers HEAD too), or null. */
export function routeFor(routes: [string, string][], method: string, path: string): [string, string] | null {
  return routes.find(([m, p]) => (m === '*' || m === method || (m === 'GET' && method === 'HEAD')) && (p === path || routeMatcher(p).test(path))) ?? null;
}
