// What agents are doing, live: one small store per agent and video, fed by the calls the app serves itself (its MCP
// endpoint), by agents on this machine (`lampo`, the stdio MCP server: lib/activity.ts appends to a rolling file this
// tails), by agents of a hosted server (a batch now and then), and by the runs Lampo started (server/agentRuns.ts
// reads their output). Memory is bounded; nothing is written to the review; an SSE `agent-activity` (coalesced) tells
// the UI something moved. The agents spend no tokens on any of it.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ACTIVITY_FILE, type ActivityRecord } from '../lib/activity.ts';
import { agentName, isActivityKey, STATUS_CHARS } from '../lib/activityText.ts';
import { cutChars } from '../lib/names.ts';
import { currentWorkspace, isoLocal, slugify } from '../lib/paths.ts';
import { ERROR_MAX, redact } from '../lib/render/redact.ts';
import { cleanProgress, RUN_ID } from '../lib/runs.ts';
import * as store from '../lib/store.ts';
import { compareTime, oneLine } from '../lib/time.ts';
import type { AgentActivity, AgentActivityKind, AgentLive } from '../lib/types.ts';
import type { Broadcast } from './events.ts';

/** Lines kept per agent and video. */
const RECENT = 12;
/** Agent × video pairs kept (the least recently active go first). */
const MAX_KEYS = 300;
/** The same action again within this long updates the line instead of adding one. */
const MERGE_MS = 4000;
/** At most one `agent-activity` event per pair within this long. */
const EVENT_MS = 300;
/** How often the rolling file is looked at (fs.watch wakes it sooner where it works). */
const POLL_MS = 1000;

const KINDS = new Set<AgentActivityKind>([
  'read',
  'note',
  'fix',
  'reply',
  'ask',
  'upload',
  'render',
  'wait',
  'playbook',
  'status',
  'tool',
  'say',
  'run',
  'error',
]);

interface Pair {
  agent: string;
  slug: string | null;
  recent: AgentActivity[];
  updated: number;
  /** The workspace the activity happened in: it is shown there only. */
  ws: string;
}

export interface ActivityOptions {
  /** Each activity as recorded, its video found: the runs it joins (server/runs.ts). What it returns is a line for the
   * agent (the person stopped its work: lib/runs.ts stopLine), handed back by `record`. */
  onRecord?: (a: AgentActivity, from?: ActivityFrom) => string | null | undefined;
}

/** Who sent an activity, beyond the name it is listed under: the account (by id) whose token, app or session it came
 * with; none for this machine's own (`lampo`, the stdio MCP server, a run Lampo started here). Never shown. */
export interface ActivityFrom {
  account?: string;
}

export interface ActivityStore {
  /**
   * Records one activity; `video` (a slug, name or path) or a note id in `target` finds the video when `slug` isn't
   * given. Returns a line the agent's answer to this call ends with (the person stopped its work), once; else null.
   */
  record(a: ActivityRecord, from?: ActivityFrom): string | null;
  /** One video's agents — with what they did that named no video (a wait, the library), so the video's own agent
   * reads as one story; `agents` adds agents to include even before they touched the video. Without a slug, every
   * agent's latest, one each. */
  live(slug?: string | null, agents?: string[]): AgentLive[];
  /** Starts tailing the rolling file; returns the stop. */
  tail(file?: string): () => void;
}

/** A video named however the caller named it, as its slug (null when it isn't one we know). */
function slugFor(video: string | null | undefined): string | null {
  const v = (video || '').trim();
  if (!v) return null;
  // A slug as it is (loadReview checks it is one), a path on this machine, else a file name the library knows.
  try {
    if (store.loadReview(v)) return v;
    const s = slugify(v);
    if (store.loadReview(s)) return s;
  } catch {}
  const name = v.split('/').at(-1)?.toLowerCase();
  const hit = store.listReviews().find((r) => r.video.split('/').at(-1)?.toLowerCase() === name);
  return hit ? slugify(hit.video) : null;
}

const line = (s: unknown, max: number) => cutChars(oneLine(String(s ?? '')).trim(), max);

/** A template's fill-ins as sent: a few short one-line values (a file, a note id, a frame), nothing else; what looks like
 * a secret taken out (a command's words are one). */
function cleanVars(v: unknown): Record<string, string | number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v).slice(0, 6)) {
    if (!/^\w{1,20}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'string') out[k] = line(redact(x), 80);
  }
  return Object.keys(out).length ? out : undefined;
}

/** A clean activity from what a caller sent: known kind and template, one-line words, sane sizes. Null when it is
 * unusable. A failure (`error`) keeps up to ERROR_MAX characters of the tool's words, an agent's status its whole
 * sentence as kept (STATUS_CHARS: the Agent view shows it whole); every other line less. */
export function cleanActivity(a: ActivityRecord): (AgentActivity & { video?: string | null }) | null {
  const agent = agentName(a.agent);
  if (!agent || !KINDS.has(a.kind)) return null;
  const failure = a.kind === 'error';
  // whoever has the agents right reads it (the activity, a run's steps): what looks like a secret goes, from every
  // kind — a command it ran, what it said, a tool's last lines —, before anything is cut, whatever sent it
  const scrub = (x: unknown) => (typeof x === 'string' ? redact(x) : x);
  const text = line(scrub(a.text), failure ? ERROR_MAX : a.kind === 'status' ? STATUS_CHARS : 160);
  if (!text) return null;
  const target = typeof a.target === 'string' ? cutChars(a.target, 40) : null;
  const at = typeof a.at === 'string' && !Number.isNaN(Date.parse(a.at)) ? a.at : isoLocal();
  const pct = typeof a.pct === 'number' && Number.isFinite(a.pct) ? Math.max(0, Math.min(100, Math.round(a.pct))) : undefined;
  const key = isActivityKey(a.key) ? a.key : undefined;
  const vars = key ? cleanVars(a.vars) : undefined;
  const quote = key && typeof a.quote === 'string' ? line(scrub(a.quote), failure ? ERROR_MAX : 60) : '';
  const progress = cleanProgress(a.progress);
  return {
    at,
    agent,
    slug: typeof a.slug === 'string' ? a.slug : null,
    kind: a.kind,
    text,
    ...(key ? { key } : {}),
    ...(vars ? { vars } : {}),
    ...(quote ? { quote } : {}),
    target,
    ...(pct !== undefined ? { pct } : {}),
    ...(progress ? { progress } : {}),
    // which run it says it is from: a hint the runs check (server/runs.ts), never trusted as it is
    ...(typeof a.run === 'string' && RUN_ID.test(a.run) ? { run: a.run } : {}),
    ...(typeof a.video === 'string' ? { video: a.video.slice(0, 1024) } : {}),
  };
}

export function createActivityStore(broadcast: Broadcast, { onRecord }: ActivityOptions = {}): ActivityStore {
  const pairs = new Map<string, Pair>();
  const pending = new Map<string, NodeJS.Timeout>();
  // Per workspace: two teams' agents may share a name and their videos a slug.
  const key = (agent: string, slug: string | null, ws = currentWorkspace()) => `${ws}\u0000${agent}\n${slug ?? ''}`;

  const announce = (p: Pair) => {
    const k = key(p.agent, p.slug, p.ws);
    if (pending.has(k)) return;
    pending.set(
      k,
      setTimeout(() => {
        pending.delete(k);
        broadcast('agent-activity', { agent: p.agent, slug: p.slug });
      }, EVENT_MS),
    );
  };

  function record(input: ActivityRecord, from?: ActivityFrom): string | null {
    const a = cleanActivity(input);
    if (!a) return null;
    let slug = a.slug;
    if (!slug && a.video) slug = slugFor(a.video);
    if (!slug && a.target && /^c_[0-9a-f]+$/i.test(a.target)) slug = store.findComment(a.target)?.slug ?? null;
    const { video: _, ...rest } = a;
    const entry: AgentActivity = { ...rest, slug, target: a.target ?? null };
    const ws = currentWorkspace();
    const k = key(entry.agent, slug, ws);
    let p = pairs.get(k);
    if (!p) {
      // Room first: the pair that has been quiet longest goes (never the one about to be filled) — in this workspace,
      // so one busy team never pushes out another's; and across all of them past a hard cap.
      const own = [...pairs].filter(([, q]) => q.ws === ws);
      for (const scope of [own.length >= MAX_KEYS ? own : [], pairs.size >= MAX_KEYS * 20 ? [...pairs] : []]) {
        let oldest: string | null = null;
        let when = Number.POSITIVE_INFINITY;
        for (const [k2, q] of scope)
          if (q.updated < when) {
            when = q.updated;
            oldest = k2;
          }
        if (oldest !== null) pairs.delete(oldest);
      }
      p = { agent: entry.agent, slug, recent: [], updated: 0, ws };
      pairs.set(k, p);
    }
    const last = p.recent[0];
    const now = Date.parse(entry.at) || Date.now();
    // A wait that keeps being asked for is one wait, a render still growing or an upload going on is one line that
    // moves; the same action again soon is the same line, newer — also when a run's output and the call it made both
    // tell it (the call's kind says more than the run's "tool").
    const progress =
      entry.kind === 'render' || (entry.kind === 'upload' && ((entry.pct !== undefined && last?.pct !== undefined) || (!!entry.progress && !!last?.progress)));
    const same = !!last && last.text === entry.text && now - (Date.parse(last.at) || 0) < MERGE_MS;
    if (last && ((last.kind === entry.kind && (entry.kind === 'wait' || progress)) || same)) {
      p.recent[0] = { ...entry, kind: entry.kind === 'tool' ? last.kind : entry.kind };
      if (entry.kind === 'wait' && last.kind === 'wait') p.recent[0].since = last.since || last.at;
    } else {
      p.recent.unshift(entry);
      if (p.recent.length > RECENT) p.recent.length = RECENT;
    }
    p.updated = now;
    announce(p);
    return onRecord?.(entry, from) ?? null;
  }

  function live(slug?: string | null, agents: string[] = []): AgentLive[] {
    const out: AgentLive[] = [];
    const ws = currentWorkspace();
    const mine = [...pairs.values()].filter((p) => p.ws === ws);
    const view = (p: Pair): AgentLive => ({
      agent: p.agent,
      slug: p.slug,
      current: p.recent[0] ?? null,
      recent: p.recent.slice(),
      updated: p.recent[0]?.at ?? isoLocal(),
    });
    if (slug) {
      const names = new Set(agents);
      for (const p of mine) if (p.slug === slug) names.add(p.agent);
      for (const name of names) {
        const own = pairs.get(key(name, slug, ws));
        const loose = pairs.get(key(name, null, ws));
        const recent = [...(own?.recent ?? []), ...(loose?.recent ?? [])].sort((x, y) => compareTime(y.at, x.at)).slice(0, RECENT);
        if (recent.length) out.push({ agent: name, slug, current: recent[0], recent, updated: recent[0].at });
      }
    } else {
      // One line per agent: its latest, wherever it was.
      const best = new Map<string, Pair>();
      for (const p of mine) {
        const b = best.get(p.agent);
        if (!b || p.updated > b.updated) best.set(p.agent, p);
      }
      for (const p of best.values()) out.push({ ...view(p), recent: p.recent.slice(0, 1) });
    }
    return out.sort((a, b) => compareTime(b.updated, a.updated));
  }

  function tail(file = ACTIVITY_FILE): () => void {
    // Start at the end: what agents did before the app started is history, not "now".
    let offset = 0;
    let ino = 0;
    try {
      const st = fs.statSync(file);
      offset = st.size;
      ino = st.ino;
    } catch {}
    let partial = '';
    // A read can end inside a character: the decoder keeps its first bytes for the next one.
    let text = new StringDecoder('utf8');
    let busy = false;
    /** Records the whole lines in bytes [from, to) of `f` (at most 256 KB a look; the rest next time). */
    const take = (f: string, from: number, to: number): number => {
      const len = Math.min(to - from, 256 * 1024);
      if (len <= 0) return from;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(f, 'r');
      try {
        fs.readSync(fd, buf, 0, len, from);
      } finally {
        fs.closeSync(fd);
      }
      const lines = (partial + text.write(buf)).split('\n');
      partial = lines.pop() ?? '';
      if (partial.length > 64 * 1024) partial = '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          record(JSON.parse(l) as ActivityRecord);
        } catch {}
      }
      return from + len;
    };
    const read = () => {
      if (busy) return;
      busy = true;
      try {
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          // Gone (or not there yet): whatever comes next is a new file, read from its start.
          offset = 0;
          ino = 0;
          return;
        }
        if (st.ino !== ino || st.size < offset) {
          // Rotated (lib/activity.ts renames it to .1): first what was added to the old one since the last look.
          try {
            const old = fs.statSync(`${file}.1`);
            if (ino && old.ino === ino) while (offset < old.size) offset = take(`${file}.1`, offset, old.size);
          } catch {}
          offset = 0;
          ino = st.ino;
          partial = '';
          text = new StringDecoder('utf8');
        }
        offset = take(file, offset, st.size);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(read, POLL_MS);
    timer.unref();
    let watcher: fs.FSWatcher | null = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {}
    try {
      watcher = fs.watch(file, () => read());
    } catch {}
    return () => {
      clearInterval(timer);
      watcher?.close();
    };
  }

  return { record, live, tail };
}
