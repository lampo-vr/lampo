// What a review link lets a request reach. The token is the only credential, so every guest route goes through
// these: the link is valid and not expired, unlocked when it has a password, names only videos it covers (by the
// ids it gave them), shows only the versions it allows, and lets visitors comment or approve only when it says so.
import type { Request } from 'express';
import { addressKey, type RateLimit, type Recent } from '../../../lib/rateLimit.ts';
import { currentWorkspace } from '../../../lib/scope.ts';
import { covers, isExpired, isUnlocked, resolveShare, settingsOf, sharerName, slugOfGuestId, visibleVerdicts } from '../../../lib/shares.ts';
import { verdictOn } from '../../../lib/stage.ts';
import * as store from '../../../lib/store.ts';
import type { Approval, GuestPerms, Review, ShareWithToken, Version } from '../../../lib/types.ts';
import { badgeHidden, roleIn } from '../../../lib/workspaces.ts';
import { tunnelVisitor } from '../../auth.ts';
import type { ServerContext } from '../../context.ts';
import { fail } from '../../http.ts';

/**
 * The visitor's address, for per-address limits and counts. Through the machine's tunnel every visitor arrives from
 * loopback, so there Cloudflare's header tells them apart (`app.locals.tunnel`: the tunnel capability, server/app.ts).
 * An IPv6 visitor counts as their /64 (`addressKey`): one connection holds that many addresses.
 */
export const ipOf = (req: Request): string => addressKey((req.app?.locals.tunnel === true && tunnelVisitor(req)) || req.ip || req.socket.remoteAddress || '?');
export const tooMany = (message: string, retryAfter: number) => Object.assign(fail(429, message), { retryAfter });

/**
 * What a review link's routes keep in memory, keyed by what visitors send (addresses, made-up ids, links): every map
 * is bounded — a `Recent` or a `RateLimit`, never a bare Map. Listed per app so a test can hold them to it
 * (test/unit/share-bounds.test.ts).
 */
export const guestMemory = new WeakMap<ServerContext, Record<string, Recent<unknown> | RateLimit>>();
export const keptInMemory = (ctx: ServerContext, maps: Record<string, Recent<unknown> | RateLimit>): void => {
  guestMemory.set(ctx, { ...guestMemory.get(ctx), ...maps });
};

/** Tells open pages that a review (and so the library) changed. */
export function changed(ctx: ServerContext, slug?: string): void {
  if (slug) ctx.broadcast('review', { slug });
  ctx.broadcast('library', slug ? { slug } : {});
}

/** The link a request names: 404 unknown or revoked, 410 expired. */
export function link(req: Request<{ token: string }>): ShareWithToken {
  const share = resolveShare(req.params.token);
  if (!share) throw fail(404, 'This review link is not valid any more.');
  if (isExpired(share))
    throw fail(410, `This review link expired on ${new Date(share.expires as string).toLocaleDateString('en-GB', { dateStyle: 'long' })}.`, {
      // whom to ask for a new one (the page says so); the link was valid once, so this names nobody new
      by: sharerName(share),
      expired: share.expires,
    });
  return share;
}

/** The link, when this browser may use it (a password link needs the unlock cookie). */
export function open(req: Request<{ token: string }>): ShareWithToken {
  const share = link(req);
  if (!isUnlocked(share, req.headers.cookie)) throw fail(401, 'This review link needs a password.');
  return share;
}

/**
 * An Embed link (lib/shares.ts `embed`), as its player and oEmbed reach it: 404 for any other link — a review link's
 * token opens no player on someone else's site — and for one with a password (never made so: nobody in a frame could
 * type it), 410 once it expired. Cookies never count here: the player in its frame has none.
 */
export function embedOf(token: unknown): ShareWithToken {
  const share = resolveShare(token);
  if (!share?.embed || share.password || share.folder) throw fail(404, 'This video isn’t available.');
  if (isExpired(share)) throw fail(410, 'This video isn’t available any more.');
  return share;
}

/**
 * "Powered by Lampo" (the guest pages' foot, the embed's mark) unless the link's workspace hid it on a plan that may
 * (A13 CLOUD-7): the billing provider is asked only when its admins did, so a link of a workspace that never touched it
 * costs nothing more. A visitor's page never fails on billing: whatever goes wrong there shows the badge.
 */
export async function badgeShown(ctx: ServerContext): Promise<boolean> {
  const ws = currentWorkspace();
  if (!badgeHidden(ws)) return true;
  return !(await ctx.extension.badgeOptional(ws).catch(() => false));
}

/**
 * The team opening its own link to check it is not the client: a signed-in member of the link's workspace, or the owner
 * at the machine the app runs on. Such visits aren't counted, so "opened" in the stats and the stage means a visitor
 * (someone signed in to another workspace is a visitor here like anyone).
 */
export function isTeam(ctx: ServerContext, req: Request): boolean {
  const a = ctx.identify(req);
  return !!a && (!a.user || !!roleIn(currentWorkspace(), a.user.id));
}

/** Writes come from the guest page itself: a foreign page can't post notes in a visitor's name. */
export function sameSite(req: Request): void {
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== req.headers.host) throw fail(403, 'bad origin');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'bad origin');
}

/** The review a request names (by the id the link gave it): the link's own video, or one the folder link covers. */
export function target(share: ShareWithToken, id?: string): Review {
  const named = id ? slugOfGuestId(share, id) : null;
  const s = share.folder ? named : share.slug;
  if (!s || (!share.folder && id && named !== share.slug)) throw fail(404, 'This video is not part of this link.');
  const review = store.loadReview(s);
  if (!review || !covers(share, review) || !review.versions.length) throw fail(404, 'This video is not part of this link.');
  return review;
}

/** The version a request asks for: the newest by default; older ones only when the link shows every version. */
export function version(share: ShareWithToken, review: Review, v: unknown): Version {
  const latest = review.versions.at(-1) as Version;
  if (v === undefined || v === null || v === '') return latest;
  const ver = review.versions.find((x) => x.v === Number(v));
  if (!ver) throw fail(404, 'unknown version');
  if (ver.v !== latest.v && settingsOf(share).versions !== 'all') throw fail(403, 'This link shows only the newest version.');
  return ver;
}

export const perms = (share: ShareWithToken): GuestPerms => {
  const { expires: _e, ...p } = settingsOf(share);
  return p;
};

export const may = (share: ShareWithToken, what: 'comment' | 'approve'): void => {
  if (!settingsOf(share)[what]) throw fail(403, what === 'comment' ? 'This link is for watching only.' : 'This link does not ask for an approval.');
};

// What a client sees as "approved": the clients' own verdict on that version, never the team's (a team approval must
// not hide the client's buttons) — and on a link that shows its own notes, only a verdict given through it
// (visibleVerdicts): another client's name, words and decision are theirs, and "You asked for changes" would be a lie.
export function clientVerdict(review: Review, v: number, share: ShareWithToken): Approval | null {
  const e = verdictOn(visibleVerdicts(share, review), 'client', v);
  return e && e.status !== 'withdrawn' ? { status: e.status, v: e.v, by: e.by, at: e.at, note: e.note } : null;
}
