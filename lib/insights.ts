// Review analytics across the whole store. `board` is the Insights page, for one period, answering one question: why
// does a video take so many versions to approval, and what would cut that? Versions to approval (`toApproval`), what
// caused the rounds (`causes`), what came back as still wrong (`stillWrong`), how long a round takes and whom it
// waits on (`turnaround`), the agents right the first time (`agents`, `firstTime`) — from lib/insightsRounds.ts and
// lib/insightsFlow.ts — what waits now (`flow.stuck`) and the clients who watched (`watching`, handed in by the
// server: it reads the views and the links). `flow`'s hours, `repeats`, `speed`, `patterns` and `projects` stay for API
// users; so does `attention` (the inbox lists stalled videos, lib/foryou.ts, with `attentionOf` from here). The older
// all-time totals, tags, convergence and turnaround stay for the API too.
import { archivedIn } from './archived.ts';
import { agentKinds, agentsOf, flowOf, type LinkSpan, partyOf, repeatsOf, waitingSince } from './insightsFlow.ts';
import { causesOf, firstTimeOf, stillWrongOf, toApprovalOf, turnaroundOf } from './insightsRounds.ts';
import { slugify } from './paths.ts';
import { renderKey } from './renderKey.ts';
import { approvalsOf, isApprovedStage, stageOf } from './stage.ts';
import { compareTime, isRequired, noteKind, TAGS } from './time.ts';
import type {
  AgentKind,
  ArchivedProject,
  Comment,
  CommentStatus,
  Insights,
  InsightsAttention,
  InsightsBoard,
  InsightsExample,
  InsightsMetric,
  InsightsPeriod,
  InsightsProject,
  InsightsStuck,
  InsightsTopic,
  InsightsWaitingOn,
  InsightsWatching,
  Review,
  Severity,
  StageInfo,
} from './types.ts';

const DAY = 86_400_000;
/** Days per period; null = all time. */
export const PERIODS: Record<InsightsPeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };
export const DEFAULT_PERIOD: InsightsPeriod = '30d';
/** Data points each period needs before a trend means anything. */
export const MIN_POINTS = 5;
/** Topics are a pattern only when at least this share of the notes carries one. */
export const MIN_COVERAGE = 0.3;
/** Kinds of note, not what a note is about: never a topic. */
const KINDS = new Set(['idea', 'love-it']);
const TOPICS = TAGS.filter((t) => !KINDS.has(t));
/** Nothing happened on a video for this long: it needs a push. */
export const QUIET_HOURS = 48;
/** This many renders and still not approved. */
export const MANY_ROUNDS = 4;
/** This many fixes came back on one video and aren't settled yet. */
export const CAME_BACK = 2;
/** Sparkline buckets for all time: never finer than a week, never more than this many. */
const MAX_BUCKETS = 26;
const EXAMPLES = 3;
const ATTENTION_MAX = 8;
const EXAMPLE_CHARS = 280;
/** Hours to two decimals (36 s): agents often fix within minutes, and tenths of an hour made those zero. */
const HOUR_DIGITS = 2;

const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3600000;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, d = 1): number | null => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export interface InsightsOptions {
  /** The moment the period ends (tests pin it). */
  now?: number;
  /** The period the page shows. */
  period?: InsightsPeriod;
  /** Where a video stands with the server's context (review links, sessions); plain stageOf() without it. */
  stageFor?: (r: Review) => StageInfo;
  /** The viewer's offset from UTC in minutes, as `Date.getTimezoneOffset()` says it: sparkline buckets are their days. */
  tz?: number;
  /** The review links, for when videos waited on clients (made, revoked, what they cover). */
  links?: LinkSpan[];
  /** Who watched what between two moments (the server reads the views and the links: lib/insightsWatch.ts). */
  watching?: (from: number, to: number) => InsightsWatching;
  /** A playbook's rules with the ones it inherits ('' = the House's): whether a repeat is already a rule. */
  rulesFor?: (scope: string) => string;
  /** Agents connected now, by name: their kind, for agents no video is assigned to. */
  connected?: ReadonlyMap<string, AgentKind>;
  /**
   * The archived projects (lib/archived.ts): put away, so nothing of theirs is listed as waiting now (`attention`,
   * `stuck`); what happened in them still counts for the period.
   */
  archived?: Readonly<Record<string, ArchivedProject>>;
}

/** Videos listed as waiting longest now. */
const STUCK = 5;

/** A dated value: when it happened, and what it measured. */
interface Point {
  at: number;
  value: number;
}

/** Sparkline buckets for a period: days per bucket, and how many make the period. All time starts at the first data.
 * The board counts its own (`board`): whole days from the viewer's midnight back past the period's start. */
export function bucketsFor(period: InsightsPeriod, now: number, first: number | null): { bucketDays: number; count: number } {
  if (period === '7d') return { bucketDays: 1, count: 7 };
  if (period === '30d') return { bucketDays: 3, count: 10 };
  if (period === '90d') return { bucketDays: 7, count: 13 };
  const span = first == null ? 7 : Math.max(1, Math.ceil((now - first) / DAY));
  const bucketDays = Math.max(7, Math.ceil(span / MAX_BUCKETS));
  return { bucketDays, count: Math.max(1, Math.ceil(span / bucketDays)) };
}

/** The viewer's next midnight after `now` (`tz`: minutes behind UTC, `Date.getTimezoneOffset()`), in UTC ms. */
export function nextMidnight(now: number, tz = 0): number {
  const local = now - tz * 60_000;
  return (Math.floor(local / DAY) + 1) * DAY + tz * 60_000;
}

/** One number over [from, to), the same length before it, and its buckets: whole days ending at `sparkEnd`, each
 * clipped to the period (the first one starts where the period does). */
function metric(
  points: Point[],
  agg: (xs: number[]) => number | null,
  span: { from: number; to: number; len: number | null; sparkEnd: number },
  buckets: { bucketDays: number; count: number },
  digits: number,
): InsightsMetric {
  const inside = (a: number, b: number) => points.filter((p) => p.at >= a && p.at < b).map((p) => p.value);
  const now = inside(span.from, span.to);
  const value = round(agg(now), digits);
  const before = span.len == null ? null : inside(span.from - span.len, span.from);
  const beforeValue = before ? round(agg(before), digits) : null;
  const change =
    before && now.length >= MIN_POINTS && before.length >= MIN_POINTS && value != null && beforeValue ? round((value - beforeValue) / beforeValue, 2) : null;
  const size = buckets.bucketDays * DAY;
  const spark = Array.from({ length: buckets.count }, (_, i) => {
    const end = span.sparkEnd - (buckets.count - 1 - i) * size;
    return round(agg(inside(Math.max(span.from, end - size), Math.min(span.to, end))), digits);
  });
  return { value, n: now.length, before: before ? { value: beforeValue, n: before.length } : null, change, spark };
}

/** A note's first fix, and the first check after it. */
function fixOf(c: Comment): { fixAt: string; checkAt: string | null } | null {
  const fix = (c.replies || []).find((x) => x.status === 'fixed');
  if (!fix) return null;
  const check = (c.replies || []).find((x) => x.status === 'verified' && compareTime(x.at, fix.at) >= 0);
  return { fixAt: fix.at, checkAt: check?.at ?? null };
}
/** A fix that came back: the note was reopened after it. */
const cameBack = (c: Comment): boolean => {
  const fix = (c.replies || []).find((x) => x.status === 'fixed');
  return !!fix && (c.replies || []).some((x) => x.status === 'open' && compareTime(x.at, fix.at) >= 0);
};

/** The render a video was approved on and when: final → its mark; else the first approval of the approved version. */
function approval(r: Review, stage: StageInfo): { v: number; at: string } | null {
  if (!isApprovedStage(stage.stage)) return null;
  if (stage.final) return { v: stage.final.v, at: stage.final.at };
  const entry = approvalsOf(r).find((e) => e.status === 'approved' && e.v === stage.v);
  return entry ? { v: stage.v, at: entry.at } : { v: stage.v, at: r.versions.at(-1)?.registered ?? r.added };
}

/** When anything last happened on a video: a render, a note, a reply, a verdict, the final mark. */
export function lastActivity(r: Review): string | null {
  const times: string[] = [];
  for (const v of r.versions) if (v.registered) times.push(v.registered);
  for (const c of r.comments) {
    times.push(c.created);
    for (const x of c.replies || []) if (x.at) times.push(x.at);
  }
  for (const e of approvalsOf(r)) times.push(e.at);
  if (r.final?.at) times.push(r.final.at);
  return times.filter(Boolean).sort(compareTime).at(-1) ?? null;
}

const waitingOnOf = (s: StageInfo): InsightsWaitingOn =>
  s.next.kind === 'wait_client' ? 'client' : s.next.kind === 'wait_agent' || s.next.kind === 'fix' ? 'agents' : 'you';

/** Why a video needs a push now, the most pressing reason only; null when it doesn't (approved and final never do).
 * The inbox's stalled videos are these, minus fixes waiting for a check (the inbox lists those as fixes). */
export function attentionOf(r: Review, stage: StageInfo, now: number): InsightsAttention | null {
  if (isApprovedStage(stage.stage)) return null;
  const feedback = r.comments.filter((c) => noteKind(c) === 'feedback');
  const waiting = feedback.filter((c) => c.status === 'fixed');
  const unsettled = feedback.filter((c) => cameBack(c) && c.status !== 'verified' && c.status !== 'wontfix').length;
  const last = lastActivity(r);
  const waitingHours = round(last ? Math.max(0, (now - Date.parse(last)) / 3600000) : 0) as number;
  // a partial render is a quick check of a few shots, not another round (lib/part.ts)
  const rounds = r.versions.filter((v) => !v.part).length;
  const reason: InsightsAttention['reason'] | null = waiting.length
    ? 'fixes'
    : unsettled >= CAME_BACK
      ? 'reopened'
      : rounds >= MANY_ROUNDS
        ? 'rounds'
        : waitingHours >= QUIET_HOURS
          ? 'waiting'
          : null;
  if (!reason) return null;
  return {
    slug: slugify(r.video),
    video: r.video.split('/').pop() || r.video,
    folder: r.folder ?? null,
    hash: r.versions.length ? renderKey(r.versions[r.versions.length - 1]) : null,
    waitingOn: reason === 'fixes' ? 'you' : waitingOnOf(stage),
    reason,
    count: reason === 'fixes' ? waiting.length : reason === 'reopened' ? unsettled : reason === 'rounds' ? rounds : 0,
    waitingHours,
    verify: reason === 'fixes' ? ([...waiting].sort((a, b) => a.frame - b.frame)[0]?.id ?? null) : null,
    agent: r.session?.name ?? null,
  };
}

const REASON_ORDER: InsightsAttention['reason'][] = ['fixes', 'reopened', 'rounds', 'waiting'];
const WHO_ORDER: InsightsWaitingOn[] = ['you', 'agents', 'client'];

function board(
  live: Review[],
  stages: Map<Review, StageInfo>,
  approvals: Map<Review, { v: number; at: string } | null>,
  period: InsightsPeriod,
  now: number,
  tz: number,
  opts: InsightsOptions,
): InsightsBoard {
  const notes = live.flatMap((r) => r.comments.filter((c) => noteKind(c) === 'feedback').map((c) => ({ r, c })));
  const fixes = notes.flatMap(({ c }) => {
    const f = fixOf(c);
    return f ? [{ c, ...f }] : [];
  });
  const fixPoints: Point[] = fixes.map((f) => ({ at: Date.parse(f.fixAt), value: hours(f.c.created, f.fixAt) }));
  const checkPoints: Point[] = fixes.flatMap((f) => (f.checkAt ? [{ at: Date.parse(f.checkAt), value: hours(f.fixAt, f.checkAt) }] : []));
  const backPoints: Point[] = fixes.map((f) => ({ at: Date.parse(f.fixAt), value: cameBack(f.c) ? 1 : 0 }));
  const renderPoints: Point[] = live.flatMap((r) => {
    const a = approvals.get(r);
    return a ? [{ at: Date.parse(a.at), value: a.v }] : [];
  });

  const days = PERIODS[period];
  const all = [...fixPoints, ...checkPoints, ...renderPoints, ...notes.map(({ c }) => ({ at: Date.parse(c.created), value: 0 }))].map((p) => p.at);
  const first = all.length ? Math.min(...all) : null;
  const from = days == null ? (first ?? now) : now - days * DAY;
  const span = { from, to: now + 1, len: days == null ? null : days * DAY, sparkEnd: nextMidnight(now, tz) };
  // Whole days (bucketDays each) back from the viewer's next midnight until the period's start is covered: the first
  // and the last bucket are partly outside the period (clipped), so a 7-day period has 8 points.
  const bucketDays = bucketsFor(period, now, first).bucketDays;
  const buckets = { bucketDays, count: Math.max(1, Math.ceil((span.sparkEnd - span.from) / (bucketDays * DAY))) };
  const inPeriod = (at: string | null | undefined) => !!at && Date.parse(at) >= span.from && Date.parse(at) < span.to;

  const back = metric(backPoints, mean, span, buckets, 2);
  const backNow = backPoints.filter((p) => p.at >= span.from && p.at < span.to);

  // Patterns: the notes written in the period, what they're about (a topic is a tag that isn't a kind of note).
  const written = notes.filter(({ c }) => inPeriod(c.created));
  const topicsOf = (c: Comment) => (c.tags || []).filter((t) => TOPICS.includes(t));
  const tagged = written.filter(({ c }) => topicsOf(c).length > 0);
  const counts = new Map<string, number>();
  for (const { c } of tagged) for (const t of topicsOf(c)) counts.set(t, (counts.get(t) || 0) + 1);
  const covered = written.length > 0 && tagged.length / written.length >= MIN_COVERAGE;
  const shown = new Set<Comment>();
  const topics: InsightsTopic[] = covered
    ? [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag, n]) => {
          const withTag = tagged
            .filter(({ c }) => topicsOf(c).includes(tag) && c.text.trim() && !shown.has(c))
            .sort((a, b) => compareTime(b.c.created, a.c.created));
          const picked: typeof withTag = [];
          for (const x of withTag) if (picked.length < EXAMPLES && !picked.some((p) => p.r === x.r)) picked.push(x);
          for (const x of withTag) if (picked.length < EXAMPLES && !picked.includes(x)) picked.push(x);
          for (const x of picked) shown.add(x.c);
          const examples: InsightsExample[] = picked.map(({ r, c }) => ({
            id: c.id,
            slug: slugify(r.video),
            video: r.video.split('/').pop() || r.video,
            v: c.v,
            frame: c.frame,
            timecode: c.timecode,
            text: c.text.length > EXAMPLE_CHARS ? `${c.text.slice(0, EXAMPLE_CHARS - 1).trimEnd()}…` : c.text,
            created: c.created,
          }));
          return { tag, n, examples };
        })
    : [];
  const severity: Record<Severity, number> = { must: 0, should: 0, nice: 0, idea: 0 };
  for (const { c } of written) severity[c.severity] = (severity[c.severity] || 0) + 1;

  // Needs attention: right now, whatever the period (an archived project's videos wait for nobody).
  const unshut = live.filter((r) => !archivedIn(r.folder, opts.archived));
  const attention = unshut
    .map((r) => attentionOf(r, stages.get(r) as StageInfo, now))
    .filter((a): a is InsightsAttention => !!a)
    .sort(
      (a, b) =>
        WHO_ORDER.indexOf(a.waitingOn) - WHO_ORDER.indexOf(b.waitingOn) ||
        REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
        b.waitingHours - a.waitingHours,
    );

  const scopeOf = (r: Review) => (r.folder ? r.folder.split('/')[0] : r.project.split('/')[0] || 'Unsorted');
  const projects = new Map<string, InsightsProject>();
  for (const r of live) {
    const k = scopeOf(r);
    const p = projects.get(k) || { project: k, videos: 0, notes: 0, open: 0, renders: 0, approved: 0 };
    p.videos++;
    p.notes += r.comments.filter((c) => noteKind(c) === 'feedback' && inPeriod(c.created)).length;
    p.open += r.comments.filter((c) => c.status === 'open' && isRequired(c)).length;
    p.renders += r.versions.filter((v) => inPeriod(v.registered)).length;
    if (inPeriod(approvals.get(r)?.at)) p.approved++;
    projects.set(k, p);
  }

  // Where time goes, over the period; what waits longest, now.
  const links = opts.links ?? [];
  const slugs = live.map((r) => ({ r, slug: slugify(r.video) }));
  const flow = flowOf(slugs, span.from, now, links);
  const stuck: InsightsStuck[] = [];
  for (const { r, slug } of slugs) {
    const stage = stages.get(r) as StageInfo;
    const party = partyOf(stage.next.kind);
    if (!party || archivedIn(r.folder, opts.archived)) continue;
    const wait = waitingSince(r, slug, now, links);
    stuck.push({
      slug,
      video: r.video.split('/').pop() || r.video,
      folder: r.folder ?? null,
      hash: r.versions.length ? renderKey(r.versions[r.versions.length - 1] as Review['versions'][number]) : null,
      waitingOn: party,
      hours: round(Math.max(0, (now - (wait?.since ?? now)) / 3600000)) as number,
      label: stage.next.label,
      kind: stage.next.kind,
      agent: r.session?.name ?? null,
    });
  }
  const renders = metric(renderPoints, mean, span, buckets, 1);
  // Why so many rounds (lib/insightsRounds.ts): versions to approval, what caused the rounds, what came back, how long
  // a round takes and whom it waits on, and how often the agents' fixes are right the first time — each with the
  // period of the same length before it.
  const agents = agentsOf(live, span.from, span.to, opts.connected);
  const len = span.len;

  return {
    period,
    days,
    from: days == null && first == null ? null : new Date(span.from).toISOString(),
    bucketDays: buckets.bucketDays,
    sparkEnd: new Date(span.sparkEnd).toISOString(),
    minPoints: MIN_POINTS,
    speed: {
      fix: metric(fixPoints, median, span, buckets, HOUR_DIGITS),
      check: metric(checkPoints, median, span, buckets, HOUR_DIGITS),
      renders,
      cameBack: { ...back, count: backNow.filter((p) => p.value === 1).length, of: backNow.length },
    },
    attention: attention.slice(0, ATTENTION_MAX),
    attentionTotal: attention.length,
    patterns: { notes: written.length, tagged: tagged.length, minCoverage: MIN_COVERAGE, topics, severity },
    projects: [...projects.values()].sort((a, b) => b.notes - a.notes || b.open - a.open || a.project.localeCompare(b.project)),
    ...(opts.watching ? { watching: opts.watching(span.from, span.to) } : {}),
    flow: { ...flow, rounds: renders, stuck: stuck.sort((a, b) => b.hours - a.hours).slice(0, STUCK) },
    agents,
    repeats: repeatsOf(live, span.from, span.to, opts.rulesFor),
    toApproval: toApprovalOf(live, approvals, span.from, span.to, lastActivity, len),
    causes: causesOf(live, span.from, span.to, opts.rulesFor, len),
    stillWrong: stillWrongOf(live, span.from, span.to, agentKinds(live, opts.connected), len),
    turnaround: turnaroundOf(slugs, span.from, span.to, links, len),
    firstTime: firstTimeOf(agents, len == null ? null : agentsOf(live, span.from - len, span.from, opts.connected)),
  };
}

export function insights(reviews: Review[], opts: InsightsOptions = {}): Insights {
  const now = opts.now ?? Date.now();
  const stageFor = opts.stageFor ?? ((r: Review) => stageOf(r));
  const live = reviews.filter((r) => !r.archived);
  const stages = new Map(live.map((r) => [r, stageFor(r)]));
  // Every number about notes is about feedback: an agent's questions and FYIs aren't work items, and counting them
  // made statuses outnumber notes ("27 notes · 32 verified") and skewed turnaround and reopen rate.
  const feedback = live.flatMap((r) => r.comments.filter((c) => noteKind(c) === 'feedback'));

  const tagCounts: Record<string, number> = Object.fromEntries(TAGS.map((t) => [t, 0]));
  let untagged = 0;
  for (const c of feedback) {
    if (!c.tags?.length) untagged++;
    for (const t of c.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const tags = Object.entries(tagCounts)
    .map(([tag, n]) => ({ tag, n }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (untagged) tags.push({ tag: 'untagged', n: untagged });

  const severity: Record<Severity, number> = { must: 0, should: 0, nice: 0, idea: 0 };
  for (const c of feedback) severity[c.severity] = (severity[c.severity] || 0) + 1;
  const status: Record<CommentStatus, number> = { open: 0, fixed: 0, verified: 0, wontfix: 0 };
  for (const c of feedback) status[c.status] = (status[c.status] || 0) + 1;

  // Convergence: notes made on render #k, averaged over videos that reached render #k.
  const perRender: Insights['perRender'] = [];
  for (let k = 1; k <= 12; k++) {
    const vids = live.filter((r) => r.versions.some((v) => v.v === k));
    if (!vids.length) break;
    const n = vids.reduce((s, r) => s + r.comments.filter((c) => c.v === k && noteKind(c) === 'feedback').length, 0);
    perRender.push({ render: k, videos: vids.length, avg: round(n / vids.length) });
  }

  // Turnaround, all time: note → marked fixed (the agent), fixed → verified (the reviewer).
  const fixes = feedback.map((c) => ({ c, f: fixOf(c) })).filter((x): x is { c: Comment; f: NonNullable<ReturnType<typeof fixOf>> } => !!x.f);
  const reopened = feedback.filter(cameBack).length;

  // Approved = the newest version stands approved (team, client) or the video is final (lib/stage.ts).
  const approvals = new Map(live.map((r) => [r, approval(r, stages.get(r) as StageInfo)]));
  const approved = live.filter((r) => approvals.get(r));
  const scopeOf = (r: Review) => (r.folder ? r.folder.split('/')[0] : r.project.split('/')[0] || 'Unsorted');
  const projects = new Map<string, Omit<Insights['projects'][number], 'rendersPerVideo'>>();
  for (const r of live) {
    const k = scopeOf(r);
    const p = projects.get(k) || { project: k, videos: 0, notes: 0, open: 0, renders: 0, approved: 0 };
    p.videos++;
    p.notes += r.comments.filter((c) => noteKind(c) === 'feedback').length;
    p.open += r.comments.filter((c) => c.status === 'open' && isRequired(c)).length;
    p.renders += r.versions.length;
    if (approvals.get(r)) p.approved++;
    projects.set(k, p);
  }

  const renders = live.reduce((s, r) => s + r.versions.length, 0);
  return {
    totals: {
      videos: live.length,
      notes: feedback.length,
      renders,
      rendersPerVideo: round(live.length ? renders / live.length : null),
      approved: approved.length,
      rendersToApproval: round(approved.length ? approved.reduce((s, r) => s + (approvals.get(r)?.v ?? 0), 0) / approved.length : null),
    },
    tags,
    severity,
    status,
    perRender,
    turnaround: {
      fixHours: round(median(fixes.map(({ c, f }) => hours(c.created, f.fixAt))), HOUR_DIGITS),
      verifyHours: round(median(fixes.flatMap(({ f }) => (f.checkAt ? [hours(f.fixAt, f.checkAt)] : []))), HOUR_DIGITS),
      fixed: fixes.length,
      reopenRate: fixes.length ? round(reopened / fixes.length, 2) : null,
    },
    projects: [...projects.values()].map((p) => ({ ...p, rendersPerVideo: round(p.renders / p.videos) })).sort((a, b) => b.notes - a.notes),
    board: board(live, stages, approvals, opts.period ?? DEFAULT_PERIOD, now, opts.tz ?? 0, opts),
  };
}
