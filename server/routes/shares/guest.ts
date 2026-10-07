// The visitor's side of a review link (/api/g/…): the link and its videos, the password, visits and views, and
// everything a visitor writes (notes, replies, fix checks, verdicts). Each write becomes a normal event by
// "guest:<name>", so INBOX.md, `lampo watch`, agents and webhooks see client feedback like any other.

import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { dataDir, reviewDir, slugify } from '../../../lib/paths.ts';
import { frameInRange, normalizeRange } from '../../../lib/range.ts';
import { RateLimit, Recent } from '../../../lib/rateLimit.ts';
import { discardRefs, inlineRefs, REF_LIMITS, type RefRequest } from '../../../lib/refs.ts';
import { currentWorkspace, DEFAULT_WORKSPACE } from '../../../lib/scope.ts';
import {
  checkPassword,
  covers,
  guestId,
  guestLabel,
  guestName,
  isExpired,
  isUnlocked,
  knowsVisitor,
  noteShotShown,
  recordView,
  recordVisit,
  recordWatch,
  resolveShare,
  reviewsOf,
  SHARE_LIMITS,
  settingsOf,
  shareId,
  sharerName,
  unlockCookieName,
  unlockValue,
  visibleNotes,
  visitorKey,
  visitorReplies,
} from '../../../lib/shares.ts';
import { shotsOrLater } from '../../../lib/shots.ts';
import { SPRITE_VERSION } from '../../../lib/sprite.ts';
import * as store from '../../../lib/store.ts';
import { isAgent } from '../../../lib/time.ts';
import { TEXT_EDIT_MAX } from '../../../lib/transcript.ts';
import type {
  Comment,
  FrameRange,
  GuestCompareResponse,
  GuestLinkResponse,
  GuestRef,
  GuestReviewResponse,
  GuestVideo,
  NoteRef,
  Review,
  ShareWithToken,
  Version,
} from '../../../lib/types.ts';
import { MAX_PLAYS_PER_REPORT, PARTS, SEEN_PATTERN } from '../../../lib/watch.ts';
import { getWorkspace, workspaceNamed } from '../../../lib/workspaces.ts';
import type { ServerContext } from '../../context.ts';
import { countStep, noticeMoment, onSample } from '../../funnel.ts';
import { metaOf, sanitizeDrawing, versionBytes } from '../../helpers.ts';
import { body, commentId, fail, failFrom, parse, query, router, VersionQuery } from '../../http.ts';
import { freeBytes } from '../../ready.ts';
import { addInlineRef, attachInline, refOfFile, sendRefFile } from '../refs.ts';
import { shotsToFollow } from '../review.ts';
import {
  badgeShown,
  changed,
  clientVerdict,
  ipOf,
  isTeam as isTeamOf,
  keptInMemory,
  link,
  may,
  open,
  perms,
  sameSite,
  target,
  tooMany,
  version,
} from './access.ts';

const Name = z.string().max(200).optional();
const refCaption = z.string().max(REF_LIMITS.caption).optional();
/** A link, or a moment of a video this link covers (named by the id the link gave it). */
const GuestInlineRef = z.union([
  z.object({ kind: z.literal('link'), url: z.string().min(1).max(REF_LIMITS.url), caption: refCaption }).strict(),
  z
    .object({
      kind: z.literal('frame'),
      video: z.string().min(1).max(600),
      v: z.number().int().positive().optional(),
      frame: z.number().int().min(0),
      to_frame: z.number().int().min(0).optional(),
      caption: refCaption,
    })
    .strict(),
]);
const GuestComment = z.object({
  name: Name,
  /** The video's id within the link (a slug from before ids is accepted too). */
  slug: z.string().max(600).optional(),
  v: z.number().int().positive().optional(),
  frame: z.number().optional(),
  text: z.string().max(20000).optional(),
  drawing: z.array(z.unknown()).max(200).optional(),
  /** "Just an idea" instead of a change request: optional for the editor, never counted as open work. */
  idea: z.boolean().optional(),
  /** Links and moments of videos this link covers that come with the note (files follow through …/refs). */
  refs: z.array(GuestInlineRef).max(8).optional(),
  /** About the whole video. */
  scope: z.enum(['video']).optional(),
  /** A stretch of the video (frames of the version shown, both ends included). */
  range: z.object({ in: z.number(), out: z.number() }).nullish(),
  /** A change to what is said (picked in the transcript): the words as heard and as they should be. */
  text_edit: z.object({ from: z.string().trim().min(1).max(TEXT_EDIT_MAX), to: z.string().max(TEXT_EDIT_MAX) }).optional(),
});
const GuestReply = z.object({ name: Name, text: z.string().min(1).max(5000) });
const GuestRefBody = z.union([
  GuestInlineRef.options[0].extend({ name: Name, note: z.string().max(5000).optional() }),
  GuestInlineRef.options[1].extend({ name: Name, note: z.string().max(5000).optional() }),
  z
    .object({
      kind: z.enum(['file', 'image', 'clip']),
      caption: refCaption,
      name: Name,
      note: z.string().max(5000).optional(),
      data: z
        .string()
        .max(Math.ceil(REF_LIMITS.inlineBytes / 3) * 4 + 4)
        .optional(),
    })
    .strict(),
]);
const GuestCheck = z.object({ name: Name, verdict: z.enum(['confirm', 'reopen']), text: z.string().max(5000).optional() });
const GuestApproval = z.object({
  name: Name,
  slug: z.string().max(600).optional(),
  /** The version on the client's screen: a verdict is about what they watched. */
  v: z.number().int().positive(),
  status: z.enum(['approved', 'changes']).optional(),
  note: z.string().max(5000).optional(),
});
const Unlock = z.object({ password: z.string().max(200) });
/** The random id a guest page keeps in its browser (web/src/guest/watch.ts): what tells visitors apart, never an address. */
const VisitorId = z.string().regex(/^[A-Za-z0-9_-]{12,40}$/);
/** A visit; `slug` + `v`: a video of the link the visitor started watching there (an embed counts its view on the first
 * play, not when the page around it loads). */
const Visit = z.object({ name: Name, visitor: VisitorId.optional(), slug: z.string().min(1).max(600).optional(), v: z.number().int().positive().optional() });
/** How much of one video played since the last report (lib/watch.ts). */
const Progress = z
  .object({
    visitor: VisitorId,
    /** The video's id within the link. */
    slug: z.string().min(1).max(600),
    v: z.number().int().positive(),
    seen: z.string().regex(SEEN_PATTERN),
    /** How often each hundredth played since the last report (players from before send none). */
    plays: z.array(z.number().int().min(0).max(MAX_PLAYS_PER_REPORT)).length(PARTS).optional(),
    secs: z.number().min(0).max(3600),
    name: Name,
  })
  .strict();

const HALF_HOUR = 30 * 60_000;

export function guestRoutes(ctx: ServerContext): Router {
  const r = router();
  const { cfg, playback } = ctx;
  // What one visitor (link + address) may write: a few a minute, tried or not, so a flood slows only its sender…
  const notesPerVisitor = new RateLimit(30, 60_000);
  // …and in a day only what landed counts: the visitor's own share first, the link's (whoever the visitors are) above
  // it, so what one link adds to the store is bounded and nobody can spend a client's share with refused requests.
  const writesPerVisitorDay = new RateLimit(SHARE_LIMITS.guestWritesPerDay, 24 * 3600_000);
  const writesPerLinkDay = new RateLimit(SHARE_LIMITS.guestWritesPerLinkDay, 24 * 3600_000);
  // A verdict is an event, a webhook and a push each: per visitor (link + address) a few a minute, so a flood slows only
  // its sender and never the client from elsewhere, and a few dozen a day (A13 LINK-1: 4,800 in four hours landed).
  const verdictsPerVisitor = new RateLimit(20, 60_000);
  const verdictsPerVisitorDay = new RateLimit(SHARE_LIMITS.guestVerdictsPerDay, 24 * 3600_000);
  /**
   * Before a note, reply, reference or verdict through the link: refused past the minute's rate or the day's share
   * (429). Returns what to call once the write landed — only then is it counted for the day.
   */
  const mayWrite = (share: ShareWithToken, req: Request, kind: 'note' | 'verdict' = 'note'): (() => void) => {
    const who = `${share.token}|${ipOf(req)}`;
    if (kind === 'verdict') {
      if (!verdictsPerVisitor.take(who)) throw tooMany('Too many decisions in a minute, please wait a moment.', verdictsPerVisitor.retryAfter(who));
      if (!verdictsPerVisitorDay.allows(who))
        throw tooMany('You have sent all the decisions this link takes from you today. Please try again tomorrow.', verdictsPerVisitorDay.retryAfter(who));
    } else if (!notesPerVisitor.take(who)) throw tooMany('Too many notes in a minute, please wait a moment.', notesPerVisitor.retryAfter(who));
    if (!writesPerVisitorDay.allows(who))
      throw tooMany('You have added all the notes this link takes from you today. Please try again tomorrow.', writesPerVisitorDay.retryAfter(who));
    if (!writesPerLinkDay.allows(share.token))
      throw tooMany('This link has taken all the notes it can for today. Please try again tomorrow.', writesPerLinkDay.retryAfter(share.token));
    return () => {
      if (kind === 'verdict') verdictsPerVisitorDay.hit(who);
      writesPerVisitorDay.hit(who);
      writesPerLinkDay.hit(share.token);
    };
  };
  // A note's screenshots are full-size pictures (two for a drawn 4K frame are ~30 MB): none when the disk is down to
  // its reserve (LAMPO_MIN_FREE), which keeps it for renders and the store.
  const roomForNotes = () => {
    const free = freeBytes(dataDir());
    if (free !== null && free < (cfg.min_free_bytes ?? 0) + 64e6) throw fail(507, 'The server has no room for new notes right now. Please try again later.');
  };
  // Visitor ids are made up by the page, so anyone can bring new ones: per link and address, only so many an hour.
  const newVisitors = new RateLimit(SHARE_LIMITS.newVisitorsPerHour, 3600_000);
  /** Whether this visitor may be kept apart on the link: one it knows, or a new one within the address's share. */
  const mayKeep = (share: ShareWithToken, req: Request, visitor: string) =>
    knowsVisitor(share.token, visitor) || newVisitors.take(`${share.token}|${ipOf(req)}`);
  // A visit is a change to the link's stats: people make a few a minute.
  // Per link and address (through the machine's tunnel, the visitor's address as Cloudflare names it: ipOf).
  const visitsPerAddress = new RateLimit(60, 60_000);
  // Password guesses: a few per visitor (link + address), a few more per address across links, and a ceiling per link
  // that takes many addresses to reach, so strangers with the URL can't easily keep the client out, and a link can't
  // be guessed faster than 100 tries an hour however many addresses try.
  const guessesPerVisitor = new RateLimit(5, 10 * 60_000);
  const guessesPerAddress = new RateLimit(20, 10 * 60_000);
  const guessesPerLink = new RateLimit(100, 60 * 60_000);
  // Keyed by what visitors send (addresses, made-up ids): each keeps the latest 10,000 and forgets the rest.
  const visits = new Recent<number>();
  const views = new Recent<number>();
  // The name a visitor gave on a link (sent with the visit, a note or a verdict), so a view can say who looked.
  const names = new Recent<string>();
  // Whose team visitors are told a link is from: on a server with several workspaces, the link's own (another team's
  // clients never read workspace #1's name); the server's name (org_name, LAMPO_ORG_NAME) is workspace #1's, the
  // operator's own team, as in the account mails (server/accountMail.ts).
  // A sign-up's workspace starts out named after its owner, a person's name: until someone names it, visitors read no
  // team name — the link names its sharer — rather than a person's name passed off as a team's (workspaceNamed).
  const orgOf = (): string | null => {
    const ws = currentWorkspace();
    if (ws === DEFAULT_WORKSPACE) return cfg.org_name || null;
    return workspaceNamed(ws) ? getWorkspace(ws)?.name || null : null;
  };
  /**
   * Whose link it is, as its visitors read it: its name, who shared it, the team. An embed's token is in other sites'
   * pages for anyone to read, so whichever of these routes it asks (its watch page's), it names nobody.
   */
  const whose = (share: ShareWithToken): Pick<GuestLinkResponse, 'label' | 'reviewer' | 'org'> =>
    share.embed ? { label: '', reviewer: null, org: null } : { label: guestLabel(share), reviewer: sharerName(share), org: orgOf() };
  // the team opening its own link to check it isn't counted (access.ts)
  const isTeam = (req: Request) => isTeamOf(ctx, req);
  // An embed's visits are anonymous: its token sits in other sites' pages, so a name sent with it is anyone's to make up,
  // and the owner's link activity and Insights would show it as a viewer's.
  const nameOf = (share: ShareWithToken, sent: string | undefined): string | undefined => (sent && !share.embed ? guestName(sent) : undefined);
  const remember = (share: ShareWithToken, req: Request, name: string | undefined) => {
    if (name && name !== 'client' && !share.embed) names.set(`${share.token}|${ipOf(req)}`, name);
  };
  /**
   * A visitor opened one video of the link at `ver` (its page, or an embed's first play): counted once per address,
   * video and version every half hour, never for the team's own previews. Open pages hear of it at once — an embed's at
   * most once a minute (announce): a page on a busy site brings visitors all day, and every open player refetches.
   */
  const viewed = (share: ShareWithToken, req: Request, review: Review, ver: Version) => {
    if (isTeam(req)) return;
    const slug = slugify(review.video);
    const key = `${share.token}|${ipOf(req)}|${slug}|${ver.v}`;
    if (Date.now() - (views.get(key) || 0) <= HALF_HOUR) return;
    views.set(key, Date.now());
    recordView(share.token, slug, ver.v, names.get(`${share.token}|${ipOf(req)}`));
    if (share.embed) announce(share, slug);
    else changed(ctx, slug);
  };

  // ---------------------------------------------------------------- the link itself

  // Folder names are often client and project names: a visitor learns no folder above what the link shares (A12
  // GUEST-13). A folder link says its own name and where each video sits below it; a video link names none.
  const ownName = (share: ShareWithToken): string | null => (share.folder ? share.folder.split('/').pop() || null : null);
  const placeBelow = (share: ShareWithToken, review: Review): string | null =>
    share.folder && review.folder?.startsWith(`${share.folder}/`) ? review.folder.slice(share.folder.length + 1) : null;

  function guestVideo(share: ShareWithToken, review: Review): GuestVideo {
    const id = guestId(share, slugify(review.video));
    const ver = review.versions.at(-1) as Version;
    const notes = visibleNotes(share, review);
    return {
      slug: id,
      name: path.basename(review.video),
      folder: placeBelow(share, review),
      v: ver.v,
      duration: ver.duration,
      width: ver.width,
      height: ver.height,
      poster: `/api/g/${share.token}/poster/${id}?v=${ver.v}`,
      sprite: `/api/g/${share.token}/sprite/${id}?v=${ver.v}&s=${SPRITE_VERSION}`,
      approval: clientVerdict(review, ver.v, share),
      notes: notes.length,
      open: notes.filter((c) => c.status === 'open').length,
      check: notes.filter((c) => c.status === 'fixed').length,
      // when the team last changed it: an embed doesn't say (whose)
      ...(share.embed ? {} : { updated: review.updated || ver.registered }),
    };
  }

  r.get('/api/g/:token', async (req, res) => {
    const share = link(req);
    const locked = !isUnlocked(share, req.headers.cookie);
    const badge = await badgeShown(ctx);
    const out: GuestLinkResponse = {
      ...whose(share),
      kind: share.folder ? 'folder' : 'video',
      // nothing of what it shares before the password (docs/sharing.md), its folder's name included
      folder: locked ? null : ownName(share),
      locked,
      expires: share.expires || null,
      perms: perms(share),
      videos: locked
        ? []
        : reviewsOf(share)
            .filter((rv) => rv.versions.length)
            .map((rv) => guestVideo(share, rv)),
      // AGPL-3.0 §13: whoever uses the instance over the network is offered its source; clients too, password or not.
      source: cfg.source_url,
      badge,
      // who runs this server and what it does with a visitor's name (A13 CLOUD-1): password or not
      imprint_url: cfg.imprint_url,
      privacy_url: cfg.privacy_url,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  r.post('/api/g/:token/unlock', express.json(), async (req, res) => {
    sameSite(req);
    const share = link(req);
    const ip = ipOf(req);
    const who = `${share.token}|${ip}`;
    if (!guessesPerVisitor.take(who)) throw tooMany('Too many tries. Please wait a few minutes.', guessesPerVisitor.retryAfter(who));
    if (!guessesPerAddress.take(ip)) throw tooMany('Too many tries. Please wait a few minutes.', guessesPerAddress.retryAfter(ip));
    if (!guessesPerLink.take(share.token)) throw tooMany('Too many tries on this link. Please wait a few minutes.', guessesPerLink.retryAfter(share.token));
    if (!share.password || !(await checkPassword(body(Unlock, req).password, share.password))) throw fail(403, 'That password is not right.');
    const secure = cfg.public_url?.startsWith('https:') || req.secure;
    res.setHeader(
      'Set-Cookie',
      `${unlockCookieName(share)}=${unlockValue(share)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    res.json({ ok: true });
  });

  // Counted once per visitor and half hour, so reloads and tabs don't inflate it.
  r.post('/api/g/:token/visit', express.json(), (req, res) => {
    sameSite(req);
    const share = open(req);
    const from = `${share.token}|${ipOf(req)}`;
    if (!visitsPerAddress.take(from)) throw tooMany('Too many visits in a minute.', visitsPerAddress.retryAfter(from));
    const b = body(Visit, req);
    // the video it names is one the link covers, at a version it shows (checked before anything is counted)
    const watching = b.slug ? target(share, b.slug) : null;
    const at = watching ? version(share, watching, b.v) : null;
    if (isTeam(req)) {
      res.json({ ok: true });
      return;
    }
    const id = b.visitor ? visitorKey(share, b.visitor) : undefined;
    // A visitor id past the address's share of new ones: the visit counts, nobody new is kept apart.
    const visitor = id && mayKeep(share, req, id) ? id : undefined;
    const key = `${share.token}|${visitor || ipOf(req)}`;
    const fresh = Date.now() - (visits.get(key) || 0) > HALF_HOUR;
    if (fresh) visits.set(key, Date.now());
    const name = nameOf(share, b.name);
    remember(share, req, name);
    // A folder link's room is a visit of its own; on a video link the video's view says it (recordView).
    const act = fresh && share.folder ? { kind: 'open' as const, name } : undefined;
    if (fresh || name) recordVisit(share.token, { open: fresh, name, visitor, act });
    // the workspace's first review link opened by a visitor (never the team's own preview, nor one on the sample): the funnel's step, and a
    // moment for whoever made the link — named by the link's name alone, never by who opened it
    if (fresh && !onSample(share)) {
      countStep(ctx, 'link_opened_first');
      noticeMoment(ctx, 'link_open', share.by_id, { link: share.label, slug: share.slug });
    }
    if (watching && at) viewed(share, req, watching, at);
    res.json({ ok: true });
  });

  // How far a visitor watched: the guest player reports which hundredths of the version played, every 15 s while it
  // plays and when it stops (web/src/guest/watch.ts). Nothing for the team's own previews or browsers that ask not to
  // be tracked; a report is small, validated, and a visitor can't send more than a few a minute.
  const reportsPerVisitor = new RateLimit(12, 60_000);
  const reportsPerAddress = new RateLimit(240, 60_000);
  const announced = new Recent<number>();
  /** Open pages hear that a video's link activity changed, at most once a minute per link and video. */
  const announce = (share: ShareWithToken, slug: string) => {
    const k = `${share.token}|${slug}`;
    if (Date.now() - (announced.get(k) || 0) <= 60_000) return;
    announced.set(k, Date.now());
    changed(ctx, slug);
  };
  keptInMemory(ctx, {
    notesPerVisitor,
    writesPerVisitorDay,
    writesPerLinkDay,
    newVisitors,
    verdictsPerVisitor,
    verdictsPerVisitorDay,
    visitsPerAddress,
    guessesPerVisitor,
    guessesPerAddress,
    guessesPerLink,
    visits,
    views,
    names,
    reportsPerVisitor,
    reportsPerAddress,
    announced,
  });
  r.post('/api/g/:token/progress', express.json({ limit: '4kb' }), (req, res) => {
    sameSite(req);
    const share = open(req);
    const b = body(Progress, req);
    if (isTeam(req)) {
      res.status(204).end();
      return;
    }
    const who = `${share.token}|${b.visitor}`;
    if (!reportsPerVisitor.take(who)) throw tooMany('Too many reports.', reportsPerVisitor.retryAfter(who));
    const ip = ipOf(req);
    if (!reportsPerAddress.take(ip)) throw tooMany('Too many reports.', reportsPerAddress.retryAfter(ip));
    const review = target(share, b.slug);
    const ver = version(share, review, b.v);
    const slug = slugify(review.video);
    const name = nameOf(share, b.name) ?? null;
    const visitor = visitorKey(share, b.visitor);
    if (!mayKeep(share, req, visitor)) throw tooMany('Too many reports.', newVisitors.retryAfter(`${share.token}|${ipOf(req)}`));
    recordWatch(share.token, slug, visitor, {
      v: ver.v,
      seen: b.seen,
      plays: b.plays,
      secs: b.secs,
      name: name === 'client' ? null : name,
    });
    // Open pages learn about it (the card's "80 % watched"), at most once a minute per video.
    announce(share, slug);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- one video

  /** A moment of a video through this link: one it covers (named by the id it gave it), at a version it shows — a
   * still of an older render is that render, so a newest-only link doesn't hand one out. */
  const linkMoment = <T extends { video: string; v?: number }>(share: ShareWithToken, x: T): T => {
    const review = target(share, x.video);
    if (x.v !== undefined) version(share, review, x.v);
    return { ...x, video: slugify(review.video) };
  };

  // Who added a reference, as the client sees them; agents are "the editor".
  const refBy = (by: string) => (isAgent(by) ? 'editor' : by.replace(/^guest:/, ''));

  /** A frame reference's version is one this link shows: a newest-only link refuses older versions, so it doesn't hand
   * out their stills either, whichever link's note brought the moment in (A12 GUEST-12). */
  const versionShown = (share: ShareWithToken, other: Review, r: NoteRef): boolean =>
    r.v === undefined || settingsOf(share).versions === 'all' || r.v === other.versions.at(-1)?.v;
  /** A frame reference whose picture this link may serve (references of other kinds: always). */
  const pictureShown = (share: ShareWithToken, r: NoteRef): boolean => {
    if (r.kind !== 'frame') return true;
    const other = r.video ? store.loadReview(r.video) : null;
    return !!other && versionShown(share, other, r);
  };

  /** A reference as this link shows it, or null: agents' refs stay internal, and so do moments of videos it doesn't cover. */
  function guestRef(share: ShareWithToken, gid: string, r: NoteRef): GuestRef | null {
    if (isAgent(r.by)) return null;
    let video: string | null = null;
    let picture = true;
    if (r.kind === 'frame') {
      const other = r.video ? store.loadReview(r.video) : null;
      if (!other || !covers(share, other)) return null;
      video = guestId(share, r.video as string);
      picture = versionShown(share, other, r);
    }
    const file = (f?: string) => (f ? `/api/g/${share.token}/refs/${gid}/${f}` : null);
    const moment = r.kind === 'frame';
    return {
      id: r.id,
      kind: r.kind,
      caption: r.caption ?? null,
      by: refBy(r.by),
      mine: !!r.share && r.share === shareId(share),
      src: r.kind === 'image' || r.kind === 'clip' ? file(r.file) : null,
      still: picture ? file(r.still) : null,
      width: r.width ?? null,
      height: r.height ?? null,
      duration: r.duration ?? null,
      url: r.url ?? null,
      site: r.site ?? null,
      video,
      name: moment ? (r.name ?? null) : null,
      v: moment ? (r.v ?? null) : null,
      frame: moment ? (r.frame ?? null) : null,
      to_frame: moment ? (r.to_frame ?? null) : null,
      timecode: moment ? (r.timecode ?? null) : null,
      fps: moment ? (r.fps ?? null) : null,
    };
  }
  const guestRefs = (share: ShareWithToken, review: Review, c: Comment): GuestRef[] => {
    const gid = guestId(share, slugify(review.video));
    return (c.refs || []).map((r) => guestRef(share, gid, r)).filter((r): r is GuestRef => !!r);
  };

  function guestNote(share: ShareWithToken, review: Review, ver: Version, c: Comment) {
    const id = guestId(share, slugify(review.video));
    const refs = guestRefs(share, review, c);
    const replyShown = visitorReplies(share, review);
    return {
      id: c.id,
      v: c.v,
      frame: c.frame,
      frameHere: store.frameIn(review, c, ver.v),
      ...(c.range ? { range: c.range, rangeHere: store.rangeIn(review, c, ver.v) } : {}),
      timecode: c.timecode,
      text: c.text,
      author: c.author.slice(6),
      status: c.status,
      idea: c.severity === 'idea',
      fixed_in_v: c.fixed_in_v ?? null,
      created: c.created,
      drawing: c.drawing,
      marked: c.shots?.marked && noteShotShown(share, review, c) ? `/data/g/${share.token}/${id}/${c.shots.marked}` : null,
      mine: c.share === shareId(share),
      // Agents answer as "the editor"; their questions stay internal, their status changes are shown. A visitor's reply
      // is for the visitors of the link it came through, as their notes are (visitorReplies).
      replies: (c.replies || [])
        .filter((rp) => (!isAgent(rp.by) || rp.status) && replyShown(rp))
        .map((rp) => ({
          by: isAgent(rp.by) ? 'editor' : rp.by.replace(/^guest:/, ''),
          text: rp.text,
          status: rp.status,
          at: rp.at,
          ...(rp.refs?.length ? { refs: rp.refs.filter((x) => refs.some((g) => g.id === x)) } : {}),
        })),
      ...(refs.length ? { refs } : {}),
      ...(c.scope ? { scope: c.scope } : {}),
      ...(c.text_edit ? { text_edit: c.text_edit } : {}),
    };
  }

  function guestReview(share: ShareWithToken, review: Review, ver: Version): GuestReviewResponse {
    const id = guestId(share, slugify(review.video));
    const latest = review.versions.at(-1) as Version;
    const p = perms(share);
    const dl = (kind: string) => `/api/g/${share.token}/download/${id}/v${ver.v}?kind=${kind}`;
    // What the player plays (see ./media.ts): a copy unless the link offers the original; none while it's being made.
    const play = p.download === 'original' ? playback.playable(review, ver) : playback.preview(review, ver);
    return {
      ...whose(share),
      slug: id,
      name: path.basename(review.video),
      v: ver.v,
      latest: latest.v,
      fps: ver.fps,
      width: ver.width,
      height: ver.height,
      frames: ver.frames,
      duration: ver.duration,
      media: play.ready ? `/media/g/${share.token}/${id}/v${ver.v}${playback.mediaQuery(ver, play)}` : null,
      ...(play.preparing ? { preparing: true } : {}),
      ...(play.busy ? { busy: true } : {}),
      waveform: `/api/g/${share.token}/waveform/${id}?v=${ver.v}`,
      approval: clientVerdict(review, ver.v, share),
      perms: p,
      // each with its frame size only (a note's marked frame keeps its room on the page), never a file, hash or path;
      // when it came, except to an embed (when the team last worked on it: like its video's `updated`)
      versions: (p.versions === 'all' ? review.versions : [ver]).map((x) => ({
        v: x.v,
        ...(share.embed ? {} : { registered: x.registered }),
        ...(x.width && x.height ? { width: x.width, height: x.height } : {}),
      })),
      download: { preview: p.download !== 'off' ? dl('preview') : null, original: p.download === 'original' ? dl('original') : null },
      notes: visibleNotes(share, review)
        .map((c) => guestNote(share, review, ver, c))
        .sort((a, b) => a.frameHere - b.frameHere),
    };
  }

  r.get('/api/g/:token/review/:slug', (req, res) => {
    const share = open(req);
    const review = target(share, req.params.slug);
    const ver = version(share, review, query(VersionQuery, req).v);
    res.setHeader('Cache-Control', 'no-store');
    res.json(guestReview(share, review, ver));
    // Which videos the client actually looked at, and which version (lib/stageContext.ts: shared is not seen).
    viewed(share, req, review, ver);
  });

  // The other side of a compare (web/src/guest/GuestCompare.tsx): another version of the video, played beside the one
  // on screen. Only links that show every version have it — a newest-only link never hands out another version's
  // media —, and it says only what a player needs (no notes, no verdict, no downloads). A reference isn't a visit:
  // nothing is recorded, so the link's views and "opened the newest" stay what the visitor opened.
  r.get('/api/g/:token/review/:slug/compare', (req, res) => {
    const share = open(req);
    if (settingsOf(share).versions !== 'all') throw fail(403, 'This link shows only the newest version.');
    const review = target(share, req.params.slug);
    const asked = query(VersionQuery, req).v;
    if (asked === undefined) throw fail(400, 'Which version?');
    const ver = version(share, review, asked);
    const id = guestId(share, slugify(review.video));
    const p = perms(share);
    const play = p.download === 'original' ? playback.playable(review, ver) : playback.preview(review, ver);
    const out: GuestCompareResponse = {
      v: ver.v,
      fps: ver.fps,
      frames: ver.frames,
      width: ver.width,
      height: ver.height,
      media: play.ready ? `/media/g/${share.token}/${id}/v${ver.v}${playback.mediaQuery(ver, play)}` : null,
      ...(play.preparing ? { preparing: true } : {}),
      ...(play.busy ? { busy: true } : {}),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  // What is said in the version shown: only on links that take notes (a change to the words is a note), without the
  // render's hash or the engines that heard it (repairs name them too).
  r.get('/api/g/:token/review/:slug/transcript', (req, res) => {
    const share = open(req);
    may(share, 'comment');
    const review = target(share, req.params.slug);
    const ver = version(share, review, query(VersionQuery, req).v);
    const a = ctx.background.startTranscript(review, ver.v);
    res.setHeader('Cache-Control', 'no-store');
    if (a.state !== 'ready') return void res.json(a.state === 'failed' || a.state === 'off' ? { state: a.state, v: a.v } : a);
    const { hash: _hash, engine: _engine, repairs: _repairs, ...transcript } = a.transcript;
    res.json({ state: 'ready', v: a.v, transcript });
  });

  // ---------------------------------------------------------------- writes

  r.post('/api/g/:token/comments', express.json({ limit: '1mb' }), async (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'comment');
    const landed = mayWrite(share, req);
    const b = body(GuestComment, req);
    const review = target(share, b.slug);
    const ver = version(share, review, b.v);
    const slug = slugify(review.video);
    // review.json is read and written whole on every change: what a link can add to one video is bounded. Its own
    // notes only: one link at its limit (a holder writing for days) closes no other link to the video.
    const here = shareId(share);
    if (review.comments.filter((c) => c.share === here && c.author?.startsWith('guest:')).length >= SHARE_LIMITS.guestNotesPerVideo)
      throw fail(409, 'This video has taken all the notes it can through this review link. Please tell the person who shared it.');
    roomForNotes();
    const text = (b.text || '').trim().slice(0, 2000);
    const overall = b.scope === 'video';
    const drawing = overall ? [] : sanitizeDrawing(b.drawing, ver);
    if (!text && !drawing.length && !b.refs?.length && !b.text_edit) throw fail(400, 'Write something or mark the frame.');
    let range: FrameRange | null = null;
    try {
      range = overall ? null : normalizeRange(b.range, ver.frames);
    } catch (e) {
      throw failFrom(400, e);
    }
    const frame = overall ? 0 : frameInRange(Math.max(0, Math.min(ver.frames - 1, Math.round(b.frame || 0))), range);
    const id = store.reservedCommentId();
    const name = guestName(b.name);
    const request: RefRequest = { by: `guest:${name}`, share: shareId(share) };
    // Moments of other videos: only ones this link covers, named by the ids it gave them, at versions it shows.
    const inputs = (b.refs || []).map((x) => (x.kind === 'frame' ? linkMoment(share, x) : x));
    let refs: NoteRef[] = [];
    try {
      refs = inputs.length ? await ctx.inflight.track(inlineRefs(slug, inputs, request)) : [];
    } catch (e) {
      throw failFrom(422, e);
    }
    // with the on-demand gate full the note goes without its screenshots, and they follow (never a 503 for them)
    const shots = overall
      ? undefined
      : await shotsOrLater({ file: await versionBytes(review, ver), frame, meta: metaOf(review, ver), drawing, dir: reviewDir(slug), id, range });
    let c: Comment;
    try {
      c = store.addComment(slug, {
        id,
        v: ver.v,
        frame,
        range,
        text,
        tags: [],
        severity: b.idea ? 'idea' : 'should',
        drawing,
        author: `guest:${name}`,
        shots,
        share: shareId(share),
        refs,
        ...(overall ? { scope: 'video' as const } : {}),
        ...(b.text_edit && !overall ? { text_edit: b.text_edit } : {}),
      });
    } catch (e) {
      await discardRefs(slug, refs);
      throw e;
    }
    landed();
    shotsToFollow(ctx, slug, [c]);
    recordVisit(share.token, { name, act: { kind: 'note', name, slug, v: ver.v, ...(b.idea ? { detail: 'idea' } : {}) } });
    remember(share, req, name);
    changed(ctx, slug);
    res.json({ id: c.id, timecode: c.timecode });
  });

  /** A note this link shows, for a write about it. */
  function visibleNote(share: ShareWithToken, id: string): { review: Review; comment: Comment } {
    const hit = store.findComment(id);
    if (!hit || !covers(share, hit.review) || !visibleNotes(share, hit.review).some((c) => c.id === id)) throw fail(404, 'no such note');
    return { review: hit.review, comment: hit.comment };
  }

  r.post('/api/g/:token/comments/:id/replies', express.json(), (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'comment');
    const landed = mayWrite(share, req);
    const id = parse(commentId, req.params.id, 'note id');
    const { review } = visibleNote(share, id);
    const b = body(GuestReply, req);
    const name = guestName(b.name);
    store.updateComment(id, { note: b.text.trim().slice(0, 2000), by: `guest:${name}`, share: shareId(share) });
    landed();
    recordVisit(share.token, { name, act: { kind: 'reply', name, slug: slugify(review.video) } });
    remember(share, req, name);
    changed(ctx, slugify(review.video));
    res.json({ ok: true });
  });

  // References: an image, a clip, a link or a moment of a video this link covers — on the visitor's own note, or with a
  // reply on any note the link shows. Files come inline or through a one-time upload URL.
  r.post('/api/g/:token/comments/:id/refs', express.json({ limit: '12mb' }), async (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'comment');
    const landed = mayWrite(share, req);
    roomForNotes();
    const id = parse(commentId, req.params.id, 'note id');
    const { review, comment } = visibleNote(share, id);
    const b = body(GuestRefBody, req);
    const name = guestName(b.name);
    const said = b.note?.trim().slice(0, 2000) || undefined;
    if (!said && comment.share !== shareId(share)) throw fail(403, 'Add your reference with a reply: say what it is for.');
    const slug = slugify(review.video);
    const request: RefRequest = { caption: b.caption, by: `guest:${name}`, note: said, share: shareId(share) };
    // The answer is the reference as this link shows it: never the note (agents' replies) or the owner's slugs.
    const gid = guestId(share, slug);
    const shown = (ref: NoteRef) => ({ ref: guestRef(share, gid, ref) });
    let out: unknown;
    if (b.kind === 'link' || b.kind === 'frame') {
      const input = b.kind === 'frame' ? linkMoment(share, b) : b;
      const { name: _n, note: _t, ...ref } = input;
      try {
        out = shown(await ctx.inflight.track(addInlineRef(slug, id, ref, request)));
      } catch (e) {
        throw failFrom(422, e);
      }
    } else {
      const kind = b.kind === 'file' ? undefined : b.kind;
      if ((comment.refs?.length || 0) >= store.REFS_PER_NOTE) throw fail(422, `A note carries at most ${store.REFS_PER_NOTE} references.`);
      if (!b.data) {
        const passwordAsked = share.password_v || 0;
        // Without a public URL, a path: the page resolves it on the host it came in on (the machine's tunnel is https
        // outside and plain http here, so an absolute URL built from this request would be wrong there).
        out = {
          upload: ctx.uploadTickets.issueRef(
            { comment: id, request: { caption: b.caption, note: said, kind, share: shareId(share) } },
            request.by,
            cfg.public_url || null,
            {
              // The file arrives later: a link revoked, expired or made watch-only in between takes nothing, nor one whose
              // password was set or changed since (the visitor would have to know it now)
              check: () => {
                const now = resolveShare(share.token);
                if (!now || isExpired(now) || !perms(now).comment) throw fail(410, 'This review link is not valid any more.');
                if ((now.password_v || 0) !== passwordAsked) throw fail(401, 'This review link asks for its password now: open it again.');
              },
              // a visitor holds only so many open at once, and the link's visitors together (server/uploadTickets.ts)
              owner: `guest:${share.token}|${ipOf(req)}`,
              pool: `link:${share.token}`,
              // The file landed: only now does it count for the day (a URL nobody uses spends nobody's share).
              present: (r) => {
                landed();
                return shown(r.ref);
              },
            },
          ),
        };
      } else {
        out = shown((await ctx.inflight.track(attachInline(id, b.data, { ...request, kind }))).ref);
        landed();
      }
    }
    if (b.kind === 'link' || b.kind === 'frame') landed();
    recordVisit(share.token, { name });
    remember(share, req, name);
    changed(ctx, slug);
    res.json(out);
  });

  r.delete('/api/g/:token/comments/:id/refs/:ref', (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'comment');
    const id = parse(commentId, req.params.id, 'note id');
    const { review, comment } = visibleNote(share, id);
    const ref = comment.refs?.find((x) => x.id === req.params.ref);
    if (!ref) throw fail(404, 'no such reference');
    if (ref.share !== shareId(share)) throw fail(403, 'Only references added through this link can be removed here.');
    store.removeRef(id, ref.id, ref.by);
    changed(ctx, slugify(review.video));
    res.json({ ok: true });
  });

  r.get('/api/g/:token/refs/:id/:file', async (req, res) => {
    const share = open(req);
    const review = target(share, req.params.id);
    const gid = guestId(share, slugify(review.video));
    // Only files of references this link shows (not agents', not moments of videos it doesn't cover, not the stills of
    // versions it doesn't show).
    const shown = visibleNotes(share, review).flatMap((c) => (c.refs || []).filter((x) => guestRef(share, gid, x) && pictureShown(share, x)));
    if (!refOfFile(shown, req.params.file)) throw fail(404, 'not found');
    await sendRefFile(req, res, slugify(review.video), req.params.file);
  });

  // "Fixed in v3, please check": the client confirms (verified) or reopens it, optionally saying why.
  r.post('/api/g/:token/comments/:id/check', express.json(), (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'comment');
    const id = parse(commentId, req.params.id, 'note id');
    const { review, comment } = visibleNote(share, id);
    if (comment.status !== 'fixed') throw fail(409, 'This note is not waiting for a check.');
    const b = body(GuestCheck, req);
    const name = guestName(b.name);
    store.updateComment(id, {
      status: b.verdict === 'confirm' ? 'verified' : 'open',
      note: (b.text || '').trim().slice(0, 2000),
      by: `guest:${name}`,
      share: shareId(share),
    });
    recordVisit(share.token, { name, act: { kind: 'check', name, slug: slugify(review.video), detail: b.verdict } });
    remember(share, req, name);
    changed(ctx, slugify(review.video));
    // a fix checked through a link counts for the funnel too (the loop's moment is for a person of the workspace)
    if (b.verdict === 'confirm' && comment.kind !== 'question' && !review.onboarding_sample) countStep(ctx, 'fix_checked_first');
    res.json({ ok: true, status: b.verdict === 'confirm' ? 'verified' : 'open' });
  });

  r.post('/api/g/:token/approval', express.json(), (req, res) => {
    sameSite(req);
    const share = open(req);
    may(share, 'approve');
    const b = body(GuestApproval, req);
    const review = target(share, b.slug);
    const slug = slugify(review.video);
    const landed = mayWrite(share, req, 'verdict');
    const ver = review.versions.at(-1) as Version;
    // A render that arrived since the page opened isn't approved unseen: the page shows it first.
    if (b.v !== ver.v) throw fail(409, `V${ver.v} arrived since this page opened: please have a look at it first.`, { latest: ver.v });
    const name = guestName(b.name);
    // The same verdict again (a double click, a retry) is the one that stands, not a new one in the history.
    const standing = clientVerdict(review, ver.v, share);
    const status = b.status === 'changes' ? 'changes' : 'approved';
    if (standing && standing.status === status && standing.by === `guest:${name}` && (standing.note || '') === (b.note || '').slice(0, 500)) {
      res.json({ approval: standing });
      return;
    }
    const approval = store.setApproval(
      slug,
      { status: b.status === 'changes' ? 'changes' : 'approved', note: (b.note || '').slice(0, 500), v: ver.v },
      `guest:${name}`,
      { party: 'client', share: shareId(share), keep: SHARE_LIMITS.guestVerdictsKept },
    );
    landed();
    recordVisit(share.token, { name, act: { kind: 'approval', name, slug, v: ver.v, detail: b.status === 'changes' ? 'changes' : 'approved' } });
    remember(share, req, name);
    changed(ctx, slug);
    res.json({ approval });
  });

  return r;
}
