// The Insights page's question: why does a video take so many versions to approval, and what would cut that? Fewer
// rounds are less of the reviewer's time and fewer agent tokens. Plain maths over reviews — no files, no Node — so the
// tests can feed it stores of any history (lib/insights.ts puts the answers on the board).
//
// A round is one full version to the next (a partial render is a quick check of a few shots, not a round). What caused
// it: the people's notes written since the version before, and the notes reopened as still wrong meanwhile — each
// with its topics (its tags; for a note without one, what its words suggest: lib/autotag.ts). A round with two topics
// counts for both, so the shares say "SFX came up before a third of the rounds", not a split that sums to 100 %.
import { autoTags } from './autotag.ts';
import { agentName, type LinkSpan, roundWaitsOf } from './insightsFlow.ts';
import { slugify } from './paths.ts';
import { compareTime, isAgent, noteKind } from './time.ts';
import type {
  AgentKind,
  Comment,
  InsightsAgent,
  InsightsBackNote,
  InsightsCause,
  InsightsCauses,
  InsightsFirstTime,
  InsightsStillWrong,
  InsightsToApproval,
  InsightsTurnaround,
  InsightsWaitingOn,
  Review,
  Severity,
} from './types.ts';

/** Versions to approval worth aiming for: the target line on the page. */
export const TARGET_VERSIONS = 3;
/** Approvals before the page speaks of a figure, and rounds that followed notes before it ranks their topics. */
export const MIN_APPROVALS = 3;
export const MIN_ROUNDS = 3;
/** The topic of notes that have none. */
export const UNTAGGED = 'untagged';
/** Kinds of note, not what a note is about: never a topic. */
const KINDS = new Set(['idea', 'love-it']);
const SEVERITIES: Severity[] = ['must', 'should', 'nice', 'idea'];
const PARTIES: InsightsWaitingOn[] = ['you', 'agents', 'client'];
const EXAMPLES = 2;
const EXAMPLE_CHARS = 200;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, d = 1): number | null => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const nameOf = (r: Review) => r.video.split('/').pop() || r.video;
const clip = (s: string) => (s.length > EXAMPLE_CHARS ? `${s.slice(0, EXAMPLE_CHARS - 1).trimEnd()}…` : s);
/** A video's project: its top-level folder ('' = none). */
export const projectOf = (r: Pick<Review, 'folder'>): string => (r.folder ? (r.folder.split('/')[0] as string) : '');

/** What a note is about: its tags that aren't a kind of note; a note without any, what its words suggest. */
export function topicsOf(c: Pick<Comment, 'tags' | 'text'>): string[] {
  const own = (c.tags || []).filter((t) => !KINDS.has(t));
  if (own.length) return own;
  return autoTags(c.text).filter((t) => !KINDS.has(t));
}

/** A round of one video and what came before it. */
export interface Round {
  /** The new version, and when it and the version before arrived (ms). */
  v: number;
  at: number;
  from: number;
  /** People's notes written since the version before, and notes reopened as still wrong meanwhile (each once). */
  notes: Comment[];
  /** Of them, the ones reopened. */
  back: Set<Comment>;
}

/** The rounds of one video that ended in [from, to). */
export function roundsOf(r: Review, from: number, to: number): Round[] {
  const full = r.versions.filter((v) => !v.part && v.registered).sort((a, b) => compareTime(a.registered, b.registered));
  const out: Round[] = [];
  const feedback = r.comments.filter((c) => noteKind(c) === 'feedback' && !isAgent(c.author));
  for (let i = 1; i < full.length; i++) {
    const at = Date.parse((full[i] as Review['versions'][number]).registered);
    if (!(at >= from && at < to)) continue;
    const prev = Date.parse((full[i - 1] as Review['versions'][number]).registered);
    const within = (s: string | null | undefined) => {
      const x = s ? Date.parse(s) : Number.NaN;
      return x > prev && x <= at;
    };
    const notes: Comment[] = [];
    const back = new Set<Comment>();
    for (const c of feedback) {
      const reopened = reopensOf(c).some((x) => within(x.at));
      if (reopened) back.add(c);
      if (reopened || within(c.created)) notes.push(c);
    }
    out.push({ v: (full[i] as Review['versions'][number]).v, at, from: prev, notes, back });
  }
  return out;
}

/** A note's reopenings as still wrong: each "open" reply after a fix, with the fix it undid (who made it). */
function reopensOf(c: Comment): { at: string; text: string | null; fixedBy: string | null }[] {
  const replies = [...(c.replies || [])].filter((x) => x.status).sort((a, b) => compareTime(a.at, b.at));
  const out: { at: string; text: string | null; fixedBy: string | null }[] = [];
  let fixedBy: string | null | undefined;
  for (const x of replies) {
    if (x.status === 'fixed') fixedBy = x.by ?? null;
    else if (x.status === 'open' && fixedBy !== undefined) {
      out.push({ at: x.at, text: x.text?.trim() || null, fixedBy });
      fixedBy = undefined;
    }
  }
  return out;
}

interface CausesTally {
  rounds: number;
  withNotes: number;
  untagged: number;
  severity: Record<Severity, number>;
  topics: Map<string, { rounds: number; notes: Set<Comment>; must: number; back: Set<Comment>; projects: Set<string>; examples: { c: Comment; r: Review }[] }>;
}

function tallyCauses(reviews: Review[], from: number, to: number): CausesTally {
  const out: CausesTally = { rounds: 0, withNotes: 0, untagged: 0, severity: { must: 0, should: 0, nice: 0, idea: 0 }, topics: new Map() };
  for (const r of reviews)
    for (const rd of roundsOf(r, from, to)) {
      out.rounds++;
      if (!rd.notes.length) continue;
      out.withNotes++;
      const worst = SEVERITIES.find((s) => rd.notes.some((c) => c.severity === s)) ?? 'should';
      out.severity[worst]++;
      const seen = new Set<string>();
      for (const c of rd.notes)
        for (const tag of topicsOf(c)) {
          let t = out.topics.get(tag);
          if (!t) {
            t = { rounds: 0, notes: new Set(), must: 0, back: new Set(), projects: new Set(), examples: [] };
            out.topics.set(tag, t);
          }
          if (!seen.has(tag)) {
            seen.add(tag);
            t.rounds++;
            t.projects.add(projectOf(r));
          }
          if (rd.back.has(c)) t.back.add(c);
          if (!t.notes.has(c)) {
            t.notes.add(c);
            if (c.severity === 'must') t.must++;
            t.examples.push({ c, r });
          }
        }
      if (!seen.size) out.untagged++;
    }
  return out;
}

const byRounds = (a: [string, { rounds: number; notes: Set<Comment> }], b: [string, { rounds: number; notes: Set<Comment> }]) =>
  b[1].rounds - a[1].rounds || b[1].notes.size - a[1].notes.size || a[0].localeCompare(b[0]);

/**
 * What caused the rounds that ended in [from, to): per topic, the rounds whose notes raised it, the notes, how many were
 * must-fix or came back, the playbook a rule would go into (the project when all its rounds were in one, else the
 * House) and whether a rule there (or above) says it already. `len`: the period's length, for the one before it.
 */
export function causesOf(
  reviews: Review[],
  from: number,
  to: number,
  rulesFor: (scope: string) => string = () => '',
  len: number | null = null,
): InsightsCauses {
  const now = tallyCauses(reviews, from, to);
  const topics: InsightsCause[] = [...now.topics.entries()].sort(byRounds).map(([tag, t]) => {
    const scope = t.projects.size === 1 ? ([...t.projects][0] as string) : '';
    const newest = [...t.examples].filter(({ c }) => c.text.trim()).sort((a, b) => compareTime(b.c.created, a.c.created));
    const picked: typeof newest = [];
    for (const x of newest) if (picked.length < EXAMPLES && !picked.some((p) => p.r === x.r)) picked.push(x);
    for (const x of newest) if (picked.length < EXAMPLES && !picked.includes(x)) picked.push(x);
    return {
      tag,
      rounds: t.rounds,
      share: now.withNotes ? Math.round((t.rounds / now.withNotes) * 100) / 100 : 0,
      notes: t.notes.size,
      must: t.must,
      back: t.back.size,
      scope,
      covered: rulesFor(scope).toLowerCase().includes(tag.toLowerCase()),
      examples: picked.map(({ c, r }) => ({ id: c.id, slug: slugify(r.video), video: nameOf(r), v: c.v, frame: c.frame, text: clip(c.text) })),
    };
  });
  let before: InsightsCauses['before'] = null;
  if (len != null) {
    const b = tallyCauses(reviews, from - len, from);
    const top = [...b.topics.entries()].sort(byRounds)[0];
    before = {
      rounds: b.rounds,
      withNotes: b.withNotes,
      top: top ? { tag: top[0], rounds: top[1].rounds, share: b.withNotes ? Math.round((top[1].rounds / b.withNotes) * 100) / 100 : 0 } : null,
    };
  }
  return { rounds: now.rounds, withNotes: now.withNotes, untagged: now.untagged, severity: now.severity, topics, minRounds: MIN_ROUNDS, before };
}

/** Fixes reopened as still wrong in [from, to), and fixes made in it. */
function tallyBack(reviews: Review[], from: number, to: number) {
  const inside = (at: string) => {
    const x = Date.parse(at);
    return x >= from && x < to;
  };
  let fixes = 0;
  const back: { c: Comment; r: Review; at: string; reason: string | null; agent: string | null }[] = [];
  for (const r of reviews)
    for (const c of r.comments) {
      if (noteKind(c) !== 'feedback') continue;
      for (const x of c.replies || []) if (x.status === 'fixed' && inside(x.at)) fixes++;
      for (const x of reopensOf(c))
        if (inside(x.at)) back.push({ c, r, at: x.at, reason: x.text, agent: x.fixedBy && isAgent(x.fixedBy) ? agentName(x.fixedBy) : null });
    }
  return { fixes, back };
}

/**
 * What came back in [from, to): every fix reopened as still wrong — the most expensive rounds —, by the note's topic
 * (with the agents whose fixes they were) and by agent (with its topics), each with its newest note.
 */
export function stillWrongOf(
  reviews: Review[],
  from: number,
  to: number,
  kinds: ReadonlyMap<string, AgentKind> = new Map(),
  len: number | null = null,
): InsightsStillWrong {
  const { fixes, back } = tallyBack(reviews, from, to);
  const newestFirst = [...back].sort((a, b) => compareTime(b.at, a.at));
  const noteOf = (x: (typeof back)[number]): InsightsBackNote => ({
    id: x.c.id,
    slug: slugify(x.r.video),
    video: nameOf(x.r),
    v: x.c.v,
    frame: x.c.frame,
    text: clip(x.c.text),
    reason: x.reason ? clip(x.reason) : null,
    at: x.at,
  });
  const kindOf = (name: string) => (kinds.has(name) ? { kind: kinds.get(name) as AgentKind } : {});
  const counted = <K extends string>(xs: K[]) => {
    const m = new Map<K, number>();
    for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const tags = (x: (typeof back)[number]) => {
    const t = topicsOf(x.c);
    return t.length ? t : [UNTAGGED];
  };
  const topics = counted(newestFirst.flatMap(tags)).map(([tag, n]) => {
    const mine = newestFirst.filter((x) => tags(x).includes(tag));
    return {
      tag,
      n,
      agents: counted(mine.flatMap((x) => (x.agent ? [x.agent] : []))).map(([name, k]) => ({ name, ...kindOf(name), n: k })),
      example: mine[0] ? noteOf(mine[0]) : null,
    };
  });
  const agents = counted(newestFirst.flatMap((x) => (x.agent ? [x.agent] : []))).map(([name, n]) => {
    const mine = newestFirst.filter((x) => x.agent === name);
    return { name, ...kindOf(name), n, topics: counted(mine.flatMap(tags)).map(([tag, k]) => ({ tag, n: k })), example: mine[0] ? noteOf(mine[0]) : null };
  });
  let before: InsightsStillWrong['before'] = null;
  if (len != null) {
    const b = tallyBack(reviews, from - len, from);
    before = { count: b.back.length, fixes: b.fixes };
  }
  return { count: back.length, fixes, topics, agents, before };
}

/** Full versions up to and including `v`: how many versions a video took to reach it. */
const versionsTo = (r: Review, v: number) => r.versions.filter((x) => !x.part && x.v <= v).length || 1;

/**
 * Versions to approval: of the videos approved in [from, to) (`approvals`: the version and moment each video stands
 * approved on), the mean and the median, per project, and the period before; the videos still open (moved in the
 * period, not approved) and the version they are on. `active`: when anything last happened on a video.
 */
export function toApprovalOf(
  reviews: Review[],
  approvals: ReadonlyMap<Review, { v: number; at: string } | null>,
  from: number,
  to: number,
  active: (r: Review) => string | null,
  len: number | null = null,
): InsightsToApproval {
  const inside = (at: string | null | undefined, a: number, b: number) => {
    const x = at ? Date.parse(at) : Number.NaN;
    return x >= a && x < b;
  };
  const approved = (a: number, b: number) =>
    reviews.flatMap((r) => {
      const x = approvals.get(r);
      return x && inside(x.at, a, b) ? [{ r, n: versionsTo(r, x.v) }] : [];
    });
  const now = approved(from, to);
  const open = reviews.filter((r) => !approvals.get(r) && r.versions.length && (len == null || inside(active(r), from, to)));
  const projects = new Map<string, { n: number[]; open: number[] }>();
  const of = (p: string) => {
    let x = projects.get(p);
    if (!x) {
      x = { n: [], open: [] };
      projects.set(p, x);
    }
    return x;
  };
  for (const x of now) of(projectOf(x.r)).n.push(x.n);
  for (const r of open) of(projectOf(r)).open.push(r.versions.filter((v) => !v.part).length || 1);
  const before = len == null ? null : approved(from - len, from).map((x) => x.n);
  const openCounts = open.map((r) => r.versions.filter((v) => !v.part).length || 1);
  return {
    mean: round(mean(now.map((x) => x.n))),
    median: round(median(now.map((x) => x.n))),
    n: now.length,
    before: before ? { mean: round(mean(before)), median: round(median(before)), n: before.length } : null,
    target: TARGET_VERSIONS,
    minApprovals: MIN_APPROVALS,
    projects: [...projects.entries()]
      .map(([project, x]) => ({
        project,
        mean: round(mean(x.n)),
        median: round(median(x.n)),
        n: x.n.length,
        open: x.open.length,
        openMean: round(mean(x.open)),
      }))
      .sort((a, b) => (b.mean ?? b.openMean ?? 0) - (a.mean ?? a.openMean ?? 0) || b.n - a.n || a.project.localeCompare(b.project)),
    open: { videos: open.length, mean: round(mean(openCounts)) },
  };
}

/** Rounds that ended in [from, to): the median hours per round, each party's median part and share of all the time. */
export function turnaroundOf(
  videos: { r: Review; slug: string }[],
  from: number,
  to: number,
  links: LinkSpan[] = [],
  len: number | null = null,
): InsightsTurnaround {
  const rounds = (a: number, b: number) => videos.flatMap(({ r, slug }) => roundWaitsOf(r, slug, a, b, links));
  const now = rounds(from, to);
  const all = now.reduce((s, x) => s + x.total, 0);
  const parties = {} as Record<InsightsWaitingOn, number | null>;
  const share = {} as Record<InsightsWaitingOn, number>;
  for (const p of PARTIES) {
    parties[p] = round(median(now.map((x) => x.hours[p])), 2);
    share[p] = all > 0 ? Math.round((now.reduce((s, x) => s + x.hours[p], 0) / all) * 100) / 100 : 0;
  }
  let before: InsightsTurnaround['before'] = null;
  if (len != null) {
    const b = rounds(from - len, from);
    before = { rounds: b.length, median: round(median(b.map((x) => x.total)), 2) };
  }
  return { rounds: now.length, median: round(median(now.map((x) => x.total)), 2), parties, share, before };
}

/** All agents' first fixes together: checked, right the first time, and the share (`before`: the period before's agents). */
export function firstTimeOf(agents: InsightsAgent[], before: InsightsAgent[] | null = null): InsightsFirstTime {
  const sum = (xs: InsightsAgent[]) => {
    const checked = xs.reduce((s, a) => s + a.checked, 0);
    const right = xs.reduce((s, a) => s + a.right, 0);
    return { checked, right, rate: checked ? Math.round((right / checked) * 100) / 100 : null };
  };
  return { ...sum(agents), before: before ? sum(before) : null };
}
