// The Insights page's answers about the loop itself (lib/insights.ts board): whom videos waited on and for how long,
// how each agent's fixes hold up, and what feedback keeps coming back. Plain maths over reviews — no files, no Node —
// so the tests can feed it stores of any history.
//
// Where time goes: a video's history is replayed — at every moment something happened (a version, a note, a reply, a
// verdict, a review link made or revoked) its stage is worked out again from what existed then (`asOf`), and the time
// until the next moment goes to whoever the stage's next step waits for (`partyOf`). Approved work that nobody has to
// move ("Send to the client", "Mark final", "Done") waits for no one.
import { agentKindOfRef } from './agentKind.ts';
import { approvalsOf, stageOf } from './stage.ts';
import { compareTime, isAgent, isQuestion, noteKind } from './time.ts';
import type { AgentKind, Comment, InsightsAgent, InsightsRepeat, InsightsWaitingOn, NextStepKind, Review, StageInfo } from './types.ts';

const HOUR = 3_600_000;
const PARTIES: InsightsWaitingOn[] = ['you', 'agents', 'client'];

/** Whom a next step waits for; null when nothing in the loop is pending. */
export function partyOf(next: NextStepKind): InsightsWaitingOn | null {
  if (next === 'review' || next === 'carry' || next === 'verify' || next === 'assign' || next === 'reopen') return 'you';
  if (next === 'fix' || next === 'wait_agent') return 'agents';
  if (next === 'wait_client') return 'client';
  return null;
}

/** A review link as the history needs it: what it covers and when it stood. */
export interface LinkSpan {
  slug?: string;
  folder?: string;
  created: string;
  revoked?: string;
}

const within = (folder: string | null | undefined, root: string) => !!folder && (folder === root || folder.startsWith(`${root}/`));
const covering = (r: Pick<Review, 'video' | 'folder'>, slug: string, links: LinkSpan[]) =>
  links.filter((l) => (l.folder ? within(r.folder, l.folder) : l.slug === slug));

type Stageable = Pick<Review, 'versions' | 'comments' | 'approval' | 'approvals' | 'final' | 'agent_status' | 'session'>;

/** The review as it stood at `t`: the versions, notes, replies and verdicts that existed then, each note's status as its
 * replies had set it. The assigned agent is today's (assignments keep no history). */
export function asOf(r: Review, t: number): Stageable {
  const by = (at: string | null | undefined) => !!at && Date.parse(at) <= t;
  const comments: Comment[] = [];
  for (const c of r.comments) {
    if (!by(c.created)) continue;
    const replies = (c.replies || []).filter((x) => by(x.at));
    const status = [...replies].reverse().find((x) => x.status)?.status ?? 'open';
    comments.push({ ...c, replies, status });
  }
  return {
    versions: r.versions.filter((v, i) => (v.registered ? by(v.registered) : i === 0)),
    comments,
    approvals: approvalsOf(r).filter((e) => by(e.at)),
    approval: undefined,
    final: r.final && by(r.final.at) ? r.final : undefined,
    agent_status: undefined,
    session: r.session,
  };
}

/** Every moment something happened on a video (and to the links covering it), oldest first. */
function momentsOf(r: Review, links: LinkSpan[]): number[] {
  const out: string[] = [r.added];
  for (const v of r.versions) if (v.registered) out.push(v.registered);
  for (const c of r.comments) {
    out.push(c.created);
    for (const x of c.replies || []) if (x.status && x.at) out.push(x.at);
  }
  for (const e of approvalsOf(r)) out.push(e.at);
  if (r.final?.at) out.push(r.final.at);
  for (const l of links) {
    out.push(l.created);
    if (l.revoked) out.push(l.revoked);
  }
  return [...new Set(out.filter(Boolean).map((s) => Date.parse(s)))].filter(Number.isFinite).sort((a, b) => a - b);
}

/** The stage a video had at `t`, with the review links that covered it then. */
function stageAt(r: Review, slug: string, t: number, links: LinkSpan[]): StageInfo {
  const linked = covering(r, slug, links).some((l) => Date.parse(l.created) <= t && (!l.revoked || Date.parse(l.revoked) > t));
  return stageOf(asOf(r, t), { linked, now: t });
}

/** Hours one video waited on each party between `from` and `to`. */
export function waitsOf(r: Review, slug: string, from: number, to: number, links: LinkSpan[] = []): Record<InsightsWaitingOn, number> {
  const out: Record<InsightsWaitingOn, number> = { you: 0, agents: 0, client: 0 };
  const mine = covering(r, slug, links);
  const moments = momentsOf(r, mine);
  const born = moments[0] ?? to;
  let t = Math.max(from, born);
  if (t >= to) return out;
  const cuts = [...moments.filter((m) => m > t && m < to), to];
  for (const next of cuts) {
    const party = partyOf(stageAt(r, slug, t, mine).next.kind);
    if (party) out[party] += (next - t) / HOUR;
    t = next;
  }
  return out;
}

/** A round of one video: from a full version to the next (a partial render is a quick check, not a round). */
export interface RoundWait {
  /** When the round began (the version before) and ended (the new version), in ms. */
  from: number;
  at: number;
  /** Hours the round took, and the hours it waited on each party meanwhile (approved work waits for no one). */
  total: number;
  hours: Record<InsightsWaitingOn, number>;
}

/** The rounds of one video that ended in [from, to), each with whom it waited on: one replay of its history. */
export function roundWaitsOf(r: Review, slug: string, from: number, to: number, links: LinkSpan[] = []): RoundWait[] {
  const full = r.versions
    .filter((v) => !v.part && v.registered)
    .map((v) => Date.parse(v.registered))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spans: [number, number][] = [];
  for (let i = 1; i < full.length; i++) {
    const b = full[i] as number;
    if (b >= from && b < to) spans.push([full[i - 1] as number, b]);
  }
  if (!spans.length) return [];
  const mine = covering(r, slug, links);
  const moments = momentsOf(r, mine);
  return spans.map(([a, b]) => {
    const hours: Record<InsightsWaitingOn, number> = { you: 0, agents: 0, client: 0 };
    let t = a;
    for (const next of [...moments.filter((m) => m > a && m < b), b]) {
      const party = partyOf(stageAt(r, slug, t, mine).next.kind);
      if (party) hours[party] += (next - t) / HOUR;
      t = next;
    }
    return { from: a, at: b, total: (b - a) / HOUR, hours };
  });
}

/** Since when a video has waited on the party it waits on now (its last change of hands), or null when nothing waits. */
export function waitingSince(r: Review, slug: string, now: number, links: LinkSpan[] = []): { party: InsightsWaitingOn; since: number } | null {
  const mine = covering(r, slug, links);
  const party = partyOf(stageAt(r, slug, now, mine).next.kind);
  if (!party) return null;
  const moments = momentsOf(r, mine).filter((m) => m <= now);
  let since = moments[0] ?? now;
  for (let i = moments.length - 1; i >= 0; i--) {
    const m = moments[i] as number;
    // the state just before this moment: another party (or nobody) had it, so the wait began here
    if (i === 0 || partyOf(stageAt(r, slug, m - 1, mine).next.kind) !== party) {
      since = m;
      break;
    }
  }
  return { party, since };
}

export interface FlowTotals {
  hours: Record<InsightsWaitingOn, number>;
  videos: Record<InsightsWaitingOn, number>;
  perVideo: Record<InsightsWaitingOn, number | null>;
}

/** Whom the videos waited on between `from` and `to`, all together. */
export function flowOf(reviews: { r: Review; slug: string }[], from: number, to: number, links: LinkSpan[] = []): FlowTotals {
  const hours: Record<InsightsWaitingOn, number> = { you: 0, agents: 0, client: 0 };
  const videos: Record<InsightsWaitingOn, number> = { you: 0, agents: 0, client: 0 };
  for (const { r, slug } of reviews) {
    const w = waitsOf(r, slug, from, to, links);
    for (const p of PARTIES)
      if (w[p] > 0) {
        hours[p] += w[p];
        videos[p]++;
      }
  }
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    hours: { you: round(hours.you), agents: round(hours.agents), client: round(hours.client) },
    videos,
    perVideo: {
      you: videos.you ? round(hours.you / videos.you) : null,
      agents: videos.agents ? round(hours.agents / videos.agents) : null,
      client: videos.client ? round(hours.client / videos.client) : null,
    },
  };
}

// ---------------------------------------------------------------- agents

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** "agent:launch-edit" → "launch-edit". */
export const agentName = (by: string): string => by.replace(/^agent:?/, '') || 'agent';

/**
 * How each agent's work holds up over [from, to): the fixes it made, of the notes it fixed first in the period how many
 * looked right when checked without a "still wrong" before, the median time from a note (or its reopening) to the fix,
 * the questions it asked, and the topics that came back most.
 */
/** Each agent's kind (the mark beside its name): a video's assignment says it (the newest assignment wins), else an
 * agent connected under that name. */
export function agentKinds(reviews: Review[], connected: ReadonlyMap<string, AgentKind> = new Map()): Map<string, AgentKind> {
  const kinds = new Map(connected);
  for (const r of [...reviews].sort((a, b) => compareTime(a.session?.assigned ?? '', b.session?.assigned ?? '')))
    if (r.session?.name) kinds.set(r.session.name, agentKindOfRef(r.session));
  return kinds;
}

export function agentsOf(reviews: Review[], from: number, to: number, connected: ReadonlyMap<string, AgentKind> = new Map()): InsightsAgent[] {
  const kinds = agentKinds(reviews, connected);
  const inside = (at: string) => {
    const x = Date.parse(at);
    return x >= from && x < to;
  };
  const acc = new Map<string, { fixes: number; checked: number; right: number; hours: number[]; questions: number; wrong: Map<string, number> }>();
  const of = (name: string) => {
    let a = acc.get(name);
    if (!a) {
      a = { fixes: 0, checked: 0, right: 0, hours: [], questions: 0, wrong: new Map() };
      acc.set(name, a);
    }
    return a;
  };
  for (const r of reviews)
    for (const c of r.comments) {
      if (isAgent(c.author) && isQuestion(c) && inside(c.created)) of(agentName(c.author)).questions++;
      if (noteKind(c) !== 'feedback') continue;
      const replies = [...(c.replies || [])].filter((x) => x.status).sort((a, b) => compareTime(a.at, b.at));
      let start = c.created;
      let firstFix = -1;
      replies.forEach((x, i) => {
        if (x.status === 'open') start = x.at;
        if (x.status !== 'fixed' || !isAgent(x.by)) return;
        if (firstFix < 0) firstFix = i;
        if (!inside(x.at)) return;
        const a = of(agentName(x.by));
        a.fixes++;
        a.hours.push(Math.max(0, (Date.parse(x.at) - Date.parse(start)) / HOUR));
      });
      if (firstFix < 0) continue;
      const fix = replies[firstFix];
      if (!fix || !inside(fix.at)) continue;
      const verdict = replies.slice(firstFix + 1).find((x) => x.status === 'verified' || x.status === 'open');
      if (!verdict) continue;
      const a = of(agentName(fix.by));
      a.checked++;
      if (verdict.status === 'verified') a.right++;
      else for (const tag of c.tags || []) a.wrong.set(tag, (a.wrong.get(tag) || 0) + 1);
    }
  return [...acc.entries()]
    .filter(([, a]) => a.fixes || a.questions)
    .map(([name, a]) => ({
      name,
      ...(kinds.has(name) ? { kind: kinds.get(name) } : {}),
      fixes: a.fixes,
      checked: a.checked,
      right: a.right,
      rate: a.checked ? Math.round((a.right / a.checked) * 100) / 100 : null,
      fixHours: (() => {
        const m = median(a.hours);
        return m == null ? null : Math.round(m * 100) / 100;
      })(),
      questions: a.questions,
      wrongTopics: [...a.wrong.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([tag, n]) => ({ tag, n })),
    }))
    .sort((x, y) => y.fixes - x.fixes || y.questions - x.questions || x.name.localeCompare(y.name));
}

// ---------------------------------------------------------------- repeats

/** Tags that are a kind of note, not what it is about. */
const KINDS = new Set(['love-it', 'idea']);

/**
 * What people keep asking for across videos in [from, to): a topic (a tag) on at least `min` notes by people (not agents,
 * not clients), with the playbook a rule would go into — the project when every note is in one, else the House — and
 * whether that playbook (or one above it) already says it (`rulesFor` gives its rules, inherited ones included).
 */
export function repeatsOf(reviews: Review[], from: number, to: number, rulesFor: (scope: string) => string = () => '', min = 3): InsightsRepeat[] {
  const groups = new Map<string, { c: Comment; r: Review }[]>();
  for (const r of reviews)
    for (const c of r.comments) {
      const at = Date.parse(c.created);
      if (at < from || at >= to || isAgent(c.author) || c.author.startsWith('guest:') || noteKind(c) !== 'feedback') continue;
      for (const tag of c.tags || []) if (!KINDS.has(tag)) groups.set(tag, [...(groups.get(tag) || []), { c, r }]);
    }
  const top = (r: Review) => (r.folder ? r.folder.split('/')[0] : '') as string;
  return [...groups.entries()]
    .filter(([, list]) => list.length >= min)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([tag, list]) => {
      const projects = new Set(list.map(({ r }) => top(r)));
      const scope = projects.size === 1 ? ([...projects][0] as string) : '';
      const newest = [...list].sort((a, b) => compareTime(b.c.created, a.c.created));
      const seen = new Set<Review>();
      const examples: InsightsRepeat['examples'] = [];
      for (const { c, r } of newest) {
        if (examples.length >= 3 || seen.has(r) || !c.text.trim()) continue;
        seen.add(r);
        examples.push({ id: c.id, text: c.text.length > 200 ? `${c.text.slice(0, 199).trimEnd()}…` : c.text, video: r.video.split('/').pop() || r.video });
      }
      return {
        tag,
        count: list.length,
        videos: new Set(list.map(({ r }) => r)).size,
        scope,
        covered: rulesFor(scope).toLowerCase().includes(tag.toLowerCase()),
        examples,
      };
    });
}
