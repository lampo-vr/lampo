// "For you": everything that waits for a person, across all videos — the inbox, and the bell's number. It agrees with
// the board's "Needs you" lane: every video whose newest render nobody has reviewed yet (a new video's V1, any new
// version) is listed as "To review", every fix waiting for a check as a fix to check.
// Work items leave when the work is done, never with "Got it": a question once answered, a fix once checked, a render
// to review once someone gives it a verdict or a note that asks for changes (lib/stage.ts moves it out of to_review) —
// or after REVIEW_WINDOW, when it has sat there for a month. Only what informs comes with a "Got it" (client notes,
// client approvals, agents' replies to your notes, renders with notes carried over); what someone dismissed is
// remembered per person in data/for-you.json, and a dismissal never hides a work item. Last and quieter, videos that
// stalled — waiting on an agent or a client, or on nobody, for too long (lib/insights.ts attentionOf): listed with a
// nudge, not counted in the bell's number.
// Agents' runs (lib/runs.ts), for people with the agents right: one that waits for a permission it was denied (`blocked`:
// the rule to copy, Send again, Stop — it leaves when the run goes on, is stopped or sent again) and one that failed
// (`failed`: why, Log, Try again — it leaves with Try again, or once the person opened it: dismissed without a "Got
// it"), both ahead of fixes to check; one gone quiet (`lost`) or sent and never picked up (`queued`, 10 min) is a
// stalled video with Nudge and Stop.
// "Later" puts any item aside for one person, work or not: until a time the browser picks (tomorrow 9:00 in their
// day) or until its video moves (a render, a note, a reply, a verdict), whichever comes first. A snoozed item is out of
// the list and out of the bell's number, sent apart as `later`; it changes nothing on the note or the video. Kept per
// person in data/for-you.json under "@snoozed" ({ [viewer]: { [item key]: { until, since } } }, `since` = the video's
// moves when it was put aside), next to the dismissals.
import fs from 'node:fs';
import path from 'node:path';
import { archivedIn } from './archived.ts';
import { shownAsks } from './asks.ts';
import { archivedNow } from './folderIds.ts';
import { attentionOf, lastActivity } from './insights.ts';
import { optionsSeen } from './options.ts';
import { dataDir, isoLocal, slugify } from './paths.ts';
import { can } from './permissions.ts';
import { pendingProposals, scopeLabel } from './playbooks.ts';
import { failedPosts } from './publish/posts.ts';
import { due, isAnswered, readRuns, settle, type StoredRun } from './runs.ts';
import { stageOf } from './stage.ts';
import { listReviews, readHistory, withLock, writeAtomic } from './store.ts';
import { compareTime, isAgent, isQuestion, isRequired } from './time.ts';
import type { Comment, ForYouCounts, ForYouItem, ForYouKind, ForYouResponse, ForYouRun, Review, ReviewEvent, Role, StageInfo } from './types.ts';

const FILE = (): string => path.join(dataDir(), 'for-you.json');
const LOCK_DIR = (): string => path.join(dataDir(), '.for-you');
const DAY = 24 * 3600 * 1000;
/** How long informational items stay when nobody dismisses them. */
const WINDOW: Partial<Record<ForYouKind, number>> = { approval: 14 * DAY, answer: 14 * DAY, version: 7 * DAY, blocked: 7 * DAY, failed: 7 * DAY };
/** A run sent and not picked up for this long is a stalled video. */
export const QUEUED_STALL = 10 * 60_000;
/** Dismissals older than this are dropped (their items have aged out long before). */
const KEEP_DISMISSED = 30 * DAY;
const ORDER: ForYouKind[] = ['question', 'blocked', 'failed', 'verify', 'review', 'post', 'client', 'playbook', 'approval', 'answer', 'version', 'stalled'];
/** A render waits for review this long before it drops off the list on its own. */
const REVIEW_WINDOW = 30 * DAY;
/** "Later" reaches this far at most. */
export const SNOOZE_MAX = 30 * DAY;
/** Where the snoozes live in for-you.json: never a viewer key (those are "owner" or account ids). */
const SNOOZED = '@snoozed';

/** Who is asking: locally the machine's reviewer (key "owner"), on a server an account (its id, name and role). */
export interface ForYouViewer {
  key: string;
  name: string;
  role: Role;
  /** Their account: notes that record one (Comment.author_id) are theirs by it, not by name. */
  id?: string;
}

/**
 * The viewer for an account, the same for the inbox and the app badge. The machine's owner keeps the key "owner" they
 * had before the machine had accounts, so what they dismissed stays dismissed; `fallback` names them when there is no
 * account yet.
 */
/** `user.role` must be the role in the workspace asked about (a request's `req.auth.role`). */
export function viewerFor(user: { id: string; name: string; role: Role; local?: boolean } | null | undefined, fallback: string): ForYouViewer {
  if (!user || user.local) return { key: 'owner', name: user?.name || fallback, role: user?.role ?? 'owner', ...(user ? { id: user.id } : {}) };
  return { key: user.id, id: user.id, name: user.name, role: user.role };
}

/** One item put aside: until when, and the video's moves when it was (it comes back once they changed). */
export interface Snooze {
  until: string;
  since: number | null;
}
// for-you.json: { [viewer]: { [item key]: when it was dismissed }, "@snoozed": { [viewer]: { [item key]: Snooze } } }
type Stored = Record<string, unknown>;
function load(): Stored {
  try {
    const all = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return all && typeof all === 'object' ? (all as Stored) : {};
  } catch {
    return {};
  }
}
const save = (all: Stored) => {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeAtomic(FILE(), `${JSON.stringify(all, null, 2)}\n`);
};
const dismissedOf = (all: Stored, viewer: string): Record<string, string> =>
  viewer !== SNOOZED && all[viewer] && typeof all[viewer] === 'object' ? (all[viewer] as Record<string, string>) : {};
function snoozedOf(all: Stored, viewer: string): Record<string, Snooze> {
  const box = all[SNOOZED] as Record<string, Record<string, Snooze>> | undefined;
  return (box && typeof box === 'object' && box[viewer]) || {};
}

export function dismiss(viewer: string, keys: string[]): void {
  withLock(LOCK_DIR(), () => {
    const all = load();
    const mine = { ...dismissedOf(all, viewer) };
    const now = Date.now();
    for (const [k, at] of Object.entries(mine)) if (now - Date.parse(at) > KEEP_DISMISSED) delete mine[k];
    for (const k of keys.slice(0, 500)) mine[k] = isoLocal();
    all[viewer] = mine;
    save(all);
  });
}

/** How much has happened on a video: a render, a note, a reply, a verdict each move it on. */
const movesOf = (r: Review) => r.versions.length + r.comments.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0) + (r.approvals?.length ?? 0);

/**
 * Puts the items with these keys aside for `viewer` until `until` (an ISO time, at most SNOOZE_MAX ahead) or until their
 * video moves. Keys that aren't on the viewer's list now are ignored. Returns how many were put aside.
 */
export function snooze(viewer: ForYouViewer, keys: string[], until: string, opts: ForYouOptions = {}): number {
  const now = opts.now ?? Date.now();
  const listed = forYou(viewer, { ...opts, now, limit: undefined });
  const byKey = new Map([...listed.items, ...(listed.later ?? [])].map((i) => [i.key, i]));
  // what is still aside stays; what came back (its time, its video moved, or it is gone) is forgotten
  const aside = new Set((listed.later ?? []).map((i) => i.key));
  const reviews = new Map(listReviews().map((r) => [slugify(r.video), r]));
  let n = 0;
  withLock(LOCK_DIR(), () => {
    const all = load();
    const box = { ...((all[SNOOZED] as Record<string, Record<string, Snooze>> | undefined) ?? {}) };
    const mine: Record<string, Snooze> = {};
    for (const [k, z] of Object.entries(box[viewer.key] ?? {})) if (aside.has(k) && Date.parse(z.until) > now) mine[k] = z;
    for (const k of keys.slice(0, 500)) {
      const item = byKey.get(k);
      if (!item) continue;
      const r = item.slug ? reviews.get(item.slug) : undefined;
      mine[k] = { until, since: r ? movesOf(r) : null };
      n++;
    }
    box[viewer.key] = mine;
    all[SNOOZED] = box;
    save(all);
  });
  return n;
}

/** What one viewer put away or aside in the workspace running now (their account went: lib/erasure.ts). */
export function forgetViewer(key: string): boolean {
  if (key === SNOOZED || !fs.existsSync(FILE())) return false;
  return withLock(LOCK_DIR(), () => {
    const all = load();
    const box = { ...((all[SNOOZED] as Record<string, Record<string, Snooze>> | undefined) ?? {}) };
    if (!(key in all) && !(key in box)) return false;
    delete all[key];
    delete box[key];
    all[SNOOZED] = box;
    save(all);
    return true;
  });
}

/** Brings these items back at once. */
export function unsnooze(viewer: ForYouViewer, keys: string[]): void {
  withLock(LOCK_DIR(), () => {
    const all = load();
    const box = { ...((all[SNOOZED] as Record<string, Record<string, Snooze>> | undefined) ?? {}) };
    const mine = { ...(box[viewer.key] ?? {}) };
    for (const k of keys.slice(0, 500)) delete mine[k];
    box[viewer.key] = mine;
    all[SNOOZED] = box;
    save(all);
  });
}

const base = (r: Review) => path.basename(r.video);
const poster = (slug: string, v: number) => `/api/poster/${encodeURIComponent(slug)}.jpg?v=${v}`;
const marked = (slug: string, c: Comment) => (c.shots?.marked ? `/data/${encodeURIComponent(slug)}/${c.shots.marked}` : null);
const isClient = (by: string) => by.startsWith('guest:');
/** The person on the other side of an agent: a note that isn't an agent's or a client's is the reviewer's. */
const ownNote = (c: Comment, viewer: ForYouViewer, server: boolean) =>
  server ? (c.author_id ? c.author_id === viewer.id : c.author === viewer.name) : !isAgent(c.author) && !isClient(c.author);

function fromReviews(reviews: Review[], viewer: ForYouViewer): ForYouItem[] {
  const out: ForYouItem[] = [];
  for (const r of reviews) {
    const slug = slugify(r.video);
    const common = (c: Comment) => ({
      slug,
      video: base(r),
      folder: r.folder ?? null,
      id: c.id,
      frame: c.frame,
      timecode: c.timecode,
      marked: marked(slug, c),
      ...(c.scope === 'video' ? { whole: true } : {}),
    });
    for (const c of r.comments) {
      if (c.status === 'open' && isQuestion(c) && can(viewer.role, 'comment'))
        out.push({
          key: `q:${c.id}`,
          kind: 'question',
          at: c.created,
          ...common(c),
          v: c.v,
          text: c.text,
          ...(c.choices?.length ? { choices: c.choices } : {}),
          ...(c.options?.length ? { options: optionsSeen(c.options) } : {}),
          by: c.author,
          dismissible: false,
        });
      else if (c.status === 'fixed' && can(viewer.role, 'verify')) {
        const fix = [...(c.replies || [])].reverse().find((x) => x.status === 'fixed');
        out.push({
          key: `fix:${c.id}`,
          kind: 'verify',
          at: fix?.at || c.created,
          ...common(c),
          v: c.fixed_in_v ?? fix?.fixed_in_v ?? c.v,
          text: c.text,
          note: fix?.text || null,
          by: fix?.by || null,
          dismissible: false,
        });
      } else if (c.status === 'open' && isClient(c.author))
        out.push({ key: `client:${c.id}`, kind: 'client', at: c.created, ...common(c), v: c.v, text: c.text, by: c.author.slice(6), dismissible: true });
    }
  }
  return out;
}

function fromEvents(events: ReviewEvent[], reviews: Map<string, Review>, viewer: ForYouViewer, server: boolean, now: number): ForYouItem[] {
  const out: ForYouItem[] = [];
  const recent = (e: ReviewEvent, kind: ForYouKind) => now - Date.parse(e.at) < (WINDOW[kind] || 0);
  const newestVersion = new Map<string, ReviewEvent>();
  for (const e of events) {
    const r = reviews.get(e.slug);
    if (!r) continue;
    if (e.type === 'approval' && isClient(e.by) && recent(e, 'approval'))
      out.push({
        key: `appr:${e.slug}:${e.at}`,
        kind: 'approval',
        at: e.at,
        slug: e.slug,
        video: base(r),
        folder: r.folder ?? null,
        v: e.v,
        text: e.text || '',
        by: e.by.slice(6),
        dismissible: true,
      });
    else if (e.type === 'reply' && isAgent(e.by) && e.id && recent(e, 'answer')) {
      const note = r.comments.find((c) => c.id === e.id);
      if (!note || !ownNote(note, viewer, server)) continue;
      out.push({
        key: `ans:${e.id}:${e.at}`,
        kind: 'answer',
        at: e.at,
        slug: e.slug,
        video: base(r),
        folder: r.folder ?? null,
        id: e.id,
        frame: note.frame,
        timecode: note.timecode,
        text: e.reply?.text || '',
        question: note.text,
        by: e.by,
        marked: marked(e.slug, note),
        ...(note.scope === 'video' ? { whole: true } : {}),
        dismissible: true,
      });
    } else if (e.type === 'version' && recent(e, 'version')) newestVersion.set(e.slug, e);
  }
  for (const [slug, e] of newestVersion) {
    const r = reviews.get(slug) as Review;
    const v = e.v ?? r.versions.at(-1)?.v ?? 1;
    // A render whose fixes are waiting shows up as those fixes; the version item is for renders without any.
    if (r.comments.some((c) => c.status === 'fixed' && (c.fixed_in_v ?? v) === v)) continue;
    // Only a render that hands you something is inbox-worthy: open notes carried over to be checked again. Renders to
    // review arrive as "To review", fixes as "Fixes to check"; a render that needs nothing from you isn't listed.
    const carried = r.comments.filter((c) => c.status === 'open' && c.carried_to === v && isRequired(c)).length;
    if (!carried) continue;
    const text = `${carried} open note${carried === 1 ? '' : 's'} carried over from V${v - 1} — check ${carried === 1 ? 'it' : 'them'} again`;
    out.push({
      key: `ver:${slug}:${v}`,
      kind: 'version',
      at: e.at,
      slug,
      video: base(r),
      folder: r.folder ?? null,
      v,
      text,
      poster: poster(slug, v),
      ...(r.versions.find((x) => x.v === v)?.part ? { part: true } : {}),
      dismissible: true,
    });
  }
  return out;
}

export interface ForYouOptions {
  server?: boolean;
  now?: number;
  /** At most that many items of each kind (the list is long only where nobody reads it all; counts stay whole). */
  limit?: number;
  /** Where a video stands with the server's context (review links, sessions), for whom a stalled video waits on. */
  stageFor?: (r: Review) => StageInfo;
}

export function forYou(viewer: ForYouViewer, { server = false, now = Date.now(), limit, stageFor }: ForYouOptions = {}): ForYouResponse {
  if (!can(viewer.role, 'view')) return { items: [], counts: emptyCounts() };
  // an archived project's work is put away with it (lib/archived.ts): none of it waits for anyone
  const shut = archivedNow();
  const reviews = listReviews().filter((r) => !r.archived && !archivedIn(r.folder, shut));
  const bySlug = new Map(reviews.map((r) => [slugify(r.video), r]));
  const stored = load();
  const dismissed = dismissedOf(stored, viewer.key);
  const snoozed = snoozedOf(stored, viewer.key);
  const toReview = can(viewer.role, 'approve') ? toReviewItems(reviews, now) : [];
  // A render waiting for review says more than "v3 is in": that one replaces the plain new-render item.
  const reviewing = new Set(toReview.map((i) => `${i.slug}:${i.v}`));
  const listed = [
    ...fromReviews(reviews, viewer),
    ...toReview,
    ...(can(viewer.role, 'playbook') ? playbookItems() : []),
    ...(can(viewer.role, 'comment') ? askItems() : []),
    ...(can(viewer.role, 'publish') ? postItems() : []),
    ...(can(viewer.role, 'agents') ? runItems(reviews, now) : []),
    // what happened, a moved store's history included (docs/moving.md: the Inbox reads it as what happened)
    ...fromEvents(readHistory({ limit: 3000 }), bySlug, viewer, server, now).filter((i) => i.kind !== 'version' || !reviewing.has(`${i.slug}:${i.v}`)),
  ].filter((i) => !(i.dismissible && dismissed[i.key]) && !archivedIn(i.folder, shut));
  // A video the list already shows (a fix to check, a question…, an agent gone quiet) isn't listed again as stalled.
  const shown = new Set(listed.map((i) => i.slug));
  const stalled = can(viewer.role, 'approve') ? stalledItems(reviews, stageFor ?? ((r) => stageOf(r, { now })), now).filter((i) => !shown.has(i.slug)) : [];
  const all = [...listed, ...stalled.filter((i) => !dismissed[i.key])].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.kind === 'stalled' ? 0 : compareTime(b.at, a.at)),
  );
  // Put aside ("Later"): out of the list and the number until its time, or until its video moved since.
  const aside = (i: ForYouItem): Snooze | null => {
    const z = snoozed[i.key];
    if (!z || !(Date.parse(z.until) > now)) return null;
    const r = i.slug ? bySlug.get(i.slug) : undefined;
    return r && z.since !== null && movesOf(r) !== z.since ? null : z;
  };
  const items: ForYouItem[] = [];
  const later: ForYouItem[] = [];
  let wake: string | undefined;
  for (const i of all) {
    const z = aside(i);
    if (!z) items.push(i);
    else {
      later.push({ ...i, snoozed: z.until });
      if (!wake || compareTime(z.until, wake) < 0) wake = z.until;
    }
  }
  const counts = emptyCounts();
  for (const i of items) {
    counts[i.kind]++;
    if (i.kind !== 'stalled') counts.total++;
  }
  counts.later = later.length;
  const extra = later.length ? { later, ...(wake ? { wake } : {}) } : {};
  if (limit === undefined || ORDER.every((k) => counts[k] <= limit)) return { items, counts, ...extra };
  const taken = emptyCounts();
  return { items: items.filter((i) => ++taken[i.kind] <= limit), counts, truncated: true, ...extra };
}

const emptyCounts = (): ForYouCounts => ({
  question: 0,
  verify: 0,
  review: 0,
  client: 0,
  playbook: 0,
  approval: 0,
  answer: 0,
  version: 0,
  stalled: 0,
  post: 0,
  blocked: 0,
  failed: 0,
  total: 0,
});

/** A run as an inbox item carries it: who, where it stands, why, and what it last did. */
function runOf(r: StoredRun): ForYouRun {
  return {
    id: r.id,
    agent: r.agent.name,
    kind: r.agent.kind,
    state: r.state,
    delivery: r.delivery,
    started: r.started,
    ended: r.ended,
    seen: r.seen,
    ...(r.error ? { error: r.error } : {}),
    ...(r.needs ? { needs: r.needs } : {}),
    ...(r.now ? { now: { text: r.now.text, ...(r.now.key ? { key: r.now.key } : {}), ...(r.now.vars ? { vars: r.now.vars } : {}), ...(r.now.quote ? { quote: r.now.quote } : {}) } } : {}),
    ...(r.log ? { log: true } : {}),
    planned: r.plan.length,
    answered: r.plan.filter(isAnswered).length,
  };
}

/**
 * Agents' runs that need the person: per video and agent, its newest run — a newer one (Try again, a new Send) takes an
 * older failure or block off the list. Time's moves are seen as of `now` (a run gone quiet), never written here.
 */
function runItems(reviews: Review[], now: number): ForYouItem[] {
  const out: ForYouItem[] = [];
  for (const r of reviews) {
    if (r.onboarding_sample) continue;
    const slug = slugify(r.video);
    let runs: readonly StoredRun[];
    try {
      runs = readRuns(slug);
    } catch {
      continue;
    }
    if (!runs.length) continue;
    const newest = new Map<string, StoredRun>();
    for (const x of runs) {
      const b = newest.get(x.agent.name);
      if (!b || compareTime(x.started, b.started) >= 0) newest.set(x.agent.name, x);
    }
    const v = r.versions.at(-1)?.v ?? 1;
    const common = { slug, video: base(r), folder: r.folder ?? null, v, poster: poster(slug, v) };
    for (let run of newest.values()) {
      if (due(run, now)) {
        run = structuredClone(run);
        settle(run, now);
      }
      const since = (iso: string | null) => (iso ? now - Date.parse(iso) : 0);
      if (run.state === 'needs_you' && run.needs?.kind === 'permission' && since(run.ended ?? run.seen) < (WINDOW.blocked ?? 0))
        out.push({ key: `blocked:${run.id}`, kind: 'blocked', at: run.seen, ...common, text: run.needs.text?.text ?? '', by: `agent:${run.agent.name}`, run: runOf(run), dismissible: false });
      else if (run.state === 'failed' && since(run.ended) < (WINDOW.failed ?? 0))
        out.push({
          key: `failed:${run.id}`,
          kind: 'failed',
          at: run.ended ?? run.seen,
          ...common,
          text: run.error?.text ?? '',
          by: `agent:${run.agent.name}`,
          run: runOf(run),
          // it leaves once the person opened it (or with Try again): no "Got it" (web/src/inbox/group.ts doneOf)
          dismissible: true,
        });
      else if (run.state === 'lost' || (run.state === 'queued' && since(run.started) >= QUEUED_STALL)) {
        const lost = run.state === 'lost';
        out.push({
          key: `${lost ? 'lost' : 'queued'}:${run.id}`,
          kind: 'stalled',
          at: lost ? run.seen : run.started,
          ...common,
          waitingOn: 'agents',
          reason: lost ? 'lost' : 'queued',
          waitingHours: Math.round((since(lost ? run.seen : run.started) / 3_600_000) * 100) / 100,
          agent: run.agent.name,
          by: `agent:${run.agent.name}`,
          run: runOf(run),
          dismissible: false,
        });
      }
    }
  }
  return out;
}

// Posts that failed (lib/publish/posts.ts): the person who may publish tries again, edits it or takes it back — work,
// so it leaves when that is done, never with "Got it". The key carries when it failed: a post that fails again is new.
function postItems(): ForYouItem[] {
  return failedPosts().map(({ post: p, review: r, account }) => ({
    key: `post:${p.id}:${p.updated}`,
    kind: 'post',
    at: p.updated,
    slug: p.slug,
    video: base(r),
    folder: r.folder ?? null,
    v: p.v,
    text: p.error ?? 'It failed.',
    poster: poster(p.slug, p.v),
    by: p.published_by ?? null,
    post: { id: p.id, platform: p.platform, account, error: p.error ?? 'It failed.', state: p.state, ...(p.remote_id ? { remote: true } : {}) },
    dismissible: false,
  }));
}

// Videos that stalled: fixes keep coming back, many renders without approval, or nothing happened for a while —
// waiting on an agent, a client, or on nobody (`waitingOn: 'you'`). Fixes waiting for a check are the list's own
// items. The key carries when the video last moved: "Got it" hides it until something happens and it stalls again.
// Longest-waiting first within the reasons' order.
function stalledItems(reviews: Review[], stageFor: (r: Review) => StageInfo, now: number): ForYouItem[] {
  const out: (ForYouItem & { hours: number; rank: number })[] = [];
  for (const r of reviews) {
    const stage = stageFor(r);
    // A render waiting for your review or a fix to check is the list's own item (To review, Fixes to check) — or, once
    // you said "Got it", nothing: it never comes back relabelled as stalled "waiting on you".
    if (stage.next.kind === 'review' || stage.next.kind === 'verify' || stage.next.kind === 'carry') continue;
    const a = attentionOf(r, stage, now);
    if (!a || a.reason === 'fixes') continue;
    const last = lastActivity(r) ?? r.added;
    const v = r.versions.at(-1)?.v ?? 1;
    // times are to the second: the count of what happened tells a note added in the same second apart too
    const moves = movesOf(r);
    out.push({
      key: `stall:${a.slug}:${a.reason}:${last}:${moves}`,
      kind: 'stalled',
      at: last,
      slug: a.slug,
      video: a.video,
      folder: a.folder,
      v,
      poster: poster(a.slug, v),
      waitingOn: a.waitingOn,
      reason: a.reason,
      count: a.count,
      waitingHours: a.waitingHours,
      agent: a.agent,
      dismissible: true,
      hours: a.waitingHours,
      rank: STALL_ORDER.indexOf(a.reason),
    });
  }
  return out.sort((a, b) => a.rank - b.rank || b.hours - a.hours).map(({ hours: _h, rank: _r, ...i }) => i);
}
const STALL_ORDER = ['reopened', 'rounds', 'waiting'];

// Questions asked on folders before any render (lib/asks.ts): questions like a note's, about no video; they leave once
// answered or closed.
function askItems(): ForYouItem[] {
  return shownAsks()
    .filter((a) => a.status === 'open')
    .map((a) => ({
      key: `q:${a.id}`,
      kind: 'question',
      at: a.created,
      slug: '',
      video: a.folder.split('/').pop() || a.folder,
      folder: a.folder || null,
      id: a.id,
      text: a.text,
      options: optionsSeen(a.options),
      by: a.author,
      whole: true,
      dismissible: false,
    }));
}

// Suggestions for a playbook, waiting for someone who may edit it: they leave once accepted or rejected.
function playbookItems(): ForYouItem[] {
  return pendingProposals().map((p) => ({
    key: `pb:${p.id}`,
    kind: 'playbook',
    at: p.at,
    slug: '',
    video: scopeLabel(p.scope),
    folder: p.scope || null,
    text: p.reason,
    by: p.by,
    scope: p.scope,
    proposal: p.id,
    section: p.section,
    dismissible: false,
  }));
}

// Videos whose newest render nobody has reviewed yet (lib/stage.ts: to_review), including "V6 approved · V7 new".
function toReviewItems(reviews: Review[], now: number): ForYouItem[] {
  const out: ForYouItem[] = [];
  for (const r of reviews) {
    const latest = r.versions.at(-1);
    if (!latest || now - Date.parse(latest.registered) > REVIEW_WINDOW) continue;
    const stage = stageOf(r, { now });
    if (stage.stage !== 'to_review') continue;
    out.push({
      key: `rev:${slugify(r.video)}:${latest.v}`,
      kind: 'review',
      at: latest.registered,
      slug: slugify(r.video),
      video: base(r),
      folder: r.folder ?? null,
      v: latest.v,
      text: stage.detail,
      poster: poster(slugify(r.video), latest.v),
      ...(latest.part ? { part: true } : {}),
      // it leaves with a verdict (or notes that ask for changes), like the video leaves "Needs you" on the board
      dismissible: false,
    });
  }
  return out;
}
