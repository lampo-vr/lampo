// The first run's sample, in the library from the start: when an account starts its first run in a workspace of its
// own — the one an open sign-up's confirmation made for it, the server's first workspace its setup page gave its owner,
// the machine's store on its very first start — the sample (lib/sample.ts) is made in the background, in that workspace.
// Invited people find the workspace's own (they never make one). Nothing waits for it and nothing fails because of it:
// a sample that can't be made is logged, and "Try the sample" makes it on request as before.

import { slugify } from '../lib/paths.ts';
import { createSampleOnce, findSample } from '../lib/sample.ts';
import { inWorkspace } from '../lib/scope.ts';
import type { UserPrefs } from '../lib/types.ts';
import type { ServerContext } from './context.ts';

interface Starter {
  id: string;
  name: string;
  prefs?: UserPrefs;
}

/** Whether this instance hands new first runs a sample (config `onboarding` and `onboarding_sample`, both on by default). */
export const samplesOnFirstRun = (ctx: Pick<ServerContext, 'cfg'>): boolean => ctx.cfg.onboarding !== false && ctx.cfg.onboarding_sample !== false;

/**
 * Makes the sample for `user`'s first run in `workspace` (once; a workspace that has one keeps it). Only for an account
 * that has a first run (a new one): someone who already uses Lampo, or an instance with first runs off, gets nothing.
 * Returns the work (tests wait for it); callers don't.
 */
export function sampleForFirstRun(
  ctx: ServerContext,
  { workspace, user, lang: asked }: { workspace: string; user: Starter; lang?: string | null },
): Promise<void> | null {
  if (!samplesOnFirstRun(ctx) || !user.prefs?.onboarding) return null;
  // the account's language, else the one the page asked in (a sign-up's), else English
  const lang = (user.prefs.lang === 'de' || user.prefs.lang === 'en' ? user.prefs.lang : asked) === 'de' ? 'de' : 'en';
  return inWorkspace(workspace, () => {
    if (findSample()) return null;
    return ctx.inflight
      .track(createSampleOnce({ by: user.name, byId: user.id, lang }))
      .then(({ review, made }) => {
        // made by someone's "Try it with a sample" meanwhile: that one warms it up and tells the library
        if (!made) return;
        ctx.background.warm(review);
        ctx.broadcast('library', { slug: slugify(review.video) });
      })
      .catch((e: unknown) => console.error(`the first run's sample was not made: ${(e as Error).message}`));
  });
}
