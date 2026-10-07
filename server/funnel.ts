// Where the app counts the funnel's steps (lib/funnel.ts) and notices the one-time conversion moments (lib/moments.ts):
// one call at each source, after the thing happened, never in its way. A step counted for the first time learns the
// workspace's plan from the billing module a moment later (best effort); a moment that starts waiting is told to its
// person's open pages (SSE `moment`, their own streams only). Nothing here runs unless the server counts (a hosted server
// with a billing module): `countFunnel` sets that up once per app.
import { counting, countWhen, notePlan, recordStep } from '../lib/funnel.ts';
import { notice } from '../lib/moments.ts';
import { currentWorkspace } from '../lib/scope.ts';
import { listReviews, loadReview } from '../lib/store.ts';
import type { FunnelStep, PendingMoment } from '../lib/types.ts';
import type { ServerContext } from './context.ts';

/** This app counts while it is hosted and a billing module is loaded (it may be loaded after the app is made). */
export function countFunnel(ctx: Pick<ServerContext, 'hosted' | 'extension'>): void {
  countWhen(() => ctx.hosted && ctx.extension.billing);
}

/** The workspace work runs in, or null outside any (then nothing is counted). */
function here(): string | null {
  try {
    return currentWorkspace();
  } catch {
    return null;
  }
}

/**
 * A review link on the first run's sample, or on a folder that holds nothing else: the sample's playground, never the
 * workspace's first link (Get started points there) nor its first link opened.
 */
export function onSample(link: { slug?: string | null; folder?: string | null }): boolean {
  if (link.slug) return !!loadReview(link.slug)?.onboarding_sample;
  if (!link.folder) return false;
  const inside = listReviews().filter((r) => !r.archived && (r.folder === link.folder || r.folder?.startsWith(`${link.folder}/`)));
  return inside.length > 0 && inside.every((r) => r.onboarding_sample);
}

/** Counts a step for the workspace the request works in (its first time only), then notes its plan. */
export function countStep(ctx: Pick<ServerContext, 'extension'>, step: FunnelStep, workspace = here()): boolean {
  if (!workspace || !counting()) return false;
  const first = recordStep(workspace, step);
  if (first)
    void ctx.extension
      .entitlements(workspace)
      .then((e) => notePlan(workspace, step, (e as { plan?: unknown } | null)?.plan))
      .catch(() => {});
  return first;
}

/** A one-time moment starts waiting for `account` (the workspace's first): their open pages hear it. */
export function noticeMoment(
  ctx: Pick<ServerContext, 'hub'>,
  id: PendingMoment['id'],
  account: string | null | undefined,
  o: { slug?: string; link?: string } = {},
): void {
  if (account && notice(id, account, o)) ctx.hub.tell(account, 'moment', { id });
}
