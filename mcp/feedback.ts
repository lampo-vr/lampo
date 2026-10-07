// wait_for_feedback: the one live-feedback mechanism that works in every agent loop. Clients that follow
// `subscriptions/listen` also get resource-updated notifications (server/routes/mcp.ts), but many agents only call
// tools — so the tool long-polls until new human feedback arrives or the timeout passes, and hands back a cursor.
// An agent hears notes only while it waits (an MCP client acts when prompted): the app shows whether it does
// (`onWait`, server/agents.ts), and the first wait of an agent that starts listening hands over what came in for it
// meanwhile.
import fs from 'node:fs';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Backend } from '../lib/backend/types.ts';
import { isFeedback, shortEventLine } from '../lib/eventLine.ts';
import { PENDING_LINE, QUIET_STOP_MIN, STOP_LINE } from '../lib/handoff.ts';
import { forAgents } from '../lib/onboarding.ts';
import { slugify } from '../lib/paths.ts';
import { type Audience, publicMessage } from '../lib/publicError.ts';
import { Recent } from '../lib/rateLimit.ts';
import { matchesSession } from '../lib/sessions.ts';
import { instant, isAgent, isIdea, isRequired, keepLines, oneLine } from '../lib/time.ts';
import type { Comment, ReviewEvent } from '../lib/types.ts';
import { trimmed } from './lean.ts';
import { took } from './toolkit.ts';

/** Resolves after `ms`, or earlier when new events may exist (the HTTP server wakes waiters on every event). */
export type Wake = (ms: number, signal: AbortSignal) => Promise<void>;

const POLL_MS = 1000;
const PING_MS = 20_000;
/** Most clients give a tool 60 s by default (Codex: tool_timeout_sec); stay under it unless asked for more. */
export const DEFAULT_WAIT_S = 50;
export const MAX_WAIT_S = 300;
const MAX_EVENTS = 20;
const MAX_IMAGES = 4;

export const sleepWake: Wake = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * A position in the event log: the timestamp of the last event handed out plus how many events with exactly that
 * timestamp were already delivered (timestamps have one-second resolution, so several events can share one).
 */
export interface Cursor {
  at: number;
  seen: number;
}

export function parseCursor(since: string): Cursor {
  const [iso, n] = since.split('#');
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) throw new Error(`since must be a timestamp or a cursor from an earlier call, got "${since}"`);
  return { at, seen: Math.max(0, Number.parseInt(n || '0', 10) || 0) };
}

/** "From now on": timestamps have one-second resolution, so count what this second already holds instead of skipping it. */
export function nowCursor(events: ReviewEvent[], now = Date.now()): Cursor {
  const at = Math.floor(now / 1000) * 1000;
  return { at, seen: events.filter((e) => Date.parse(e.at) === at).length };
}

/**
 * Events after the cursor (oldest first, at most `limit`) and the cursor after the last of them: when more arrived
 * than one answer shows, the rest come with the next call instead of being skipped. A cursor counts every video's
 * events of its second (cursorAt): `events` are all of them, and `keep` picks what is handed out (one video's), so a
 * note on another video in the same second never takes the place of one on this.
 */
export function after(
  events: ReviewEvent[],
  c: Cursor,
  limit = Number.POSITIVE_INFINITY,
  keep: (e: ReviewEvent) => boolean = () => true,
): { fresh: ReviewEvent[]; next: string; more: boolean } {
  let skipped = 0;
  let more = false;
  const fresh: ReviewEvent[] = [];
  // where the next call starts: past every event looked at, handed out or not
  let at = c.at;
  let seen = c.seen;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t < c.at) continue;
    if (t === c.at && skipped < c.seen) {
      skipped++;
      continue;
    }
    if (keep(e)) {
      if (fresh.length >= limit) {
        more = true;
        break;
      }
      fresh.push(e);
    }
    if (t === at) seen++;
    else {
      at = t;
      seen = 1;
    }
  }
  return { fresh, next: `${new Date(at).toISOString()}#${seen}`, more };
}

export interface FeedbackOptions {
  backend: Backend;
  wake?: Wake;
  preview: (file: string, width: number) => Promise<CallToolResult['content'][number]>;
  /** A note's marked frame cropped to its drawing, with its label; nothing for a note without a drawing. */
  drawn?: (id: string) => Promise<CallToolResult['content']>;
  allowed: boolean;
  /** How events leave the server (hosted: screenshot paths become URLs); images are read from the real paths first. */
  publicEvent?: (e: ReviewEvent) => ReviewEvent;
  /** The wait as live activity, told when it starts (it shows while it waits). */
  activity?: (args: Record<string, unknown>, ctx: ServerContext) => void;
  /**
   * A place among the waits the server holds (a cap per caller and per workspace): the release, or why there is none
   * (said as the answer at once). Absent: no cap (stdio: one agent, its own process).
   */
  hold?: Hold;
  /** Whether the caller would still get in: asked before every answer with events (a removed member hears nothing). */
  stillAllowed?: () => boolean;
  /** Who reads its errors (lib/publicError.ts); anyone but the machine's own agent unless said. */
  audience?: Audience;
  /** The agent waiting, as videos are assigned to it (toolkit.ts meOf): what waits for it comes with its first wait. */
  me?: () => { name: string | null; sessionId: string | null } | null;
  /** What it was told of already. */
  told?: Told;
  /** A wait started (the app shows the agent listening): the release, told whether it handed something out. */
  onWait?: () => (o?: { handed?: boolean }) => void;
  /** How long this agent has heard only "no new feedback" in a row: after QUIET.stopMs it is told to stop. */
  quiet?: Quiet;
  /** One line when a wait starts and one when it ends: how long, how it ended (never what it handed out). */
  log?: (line: string) => void;
  /** The wait handed over work on these videos (new feedback, what waited for it): the agent's runs there begin. */
  handed?: (slugs: string[], ctx: ServerContext) => void;
}

const GONE = 'your access ended (the token was revoked, or the account left this workspace or was disabled)';

/** Takes a wait's place: the release, or the sentence saying why not. */
export type Hold = () => (() => void) | string;

/**
 * What an agent was told of already, per video: until when (ms) — by a wait that handed out the video's events or
 * what waited for it, or by reading its open notes. A first wait hands over only what came after.
 */
export interface Told {
  at(slug: string): number;
  mark(slug: string, at: number): void;
}

/** One agent's Told in a map shared by many (bounded: forgetting means telling once more). */
export function toldIn(map: Recent<number>, agent: string): Told {
  const key = (slug: string) => `${agent}\u0000${slug}`;
  return {
    at: (slug) => map.get(key(slug)) ?? 0,
    mark: (slug, at) => {
      if (Number.isFinite(at) && at > (map.get(key(slug)) ?? 0)) map.set(key(slug), at);
    },
  };
}

/** A Told for one agent alone (stdio: the process is the agent). */
export const ownTold = (): Told => toldIn(new Recent<number>(5000), '');

/**
 * An agent that hears only "no new feedback" for `stopMs` in a row is told to stop waiting and say so: nobody is
 * reviewing, and its client runs on (tokens, a turn every 50 s) for nothing. A pause of more than `gapMs` between two
 * waits (it worked on something else, or stopped and was started again) begins the count again.
 */
export const QUIET = { stopMs: QUIET_STOP_MIN * 60_000, gapMs: 2 * 60_000 };

/** One agent's run of waits that ended with nothing new (a clock of its own, for tests). */
export interface Quiet {
  now(): number;
  /** A wait that began at `from` ended with nothing new: true when that is all it heard for QUIET.stopMs (the run then ends). */
  nothing(from: number): boolean;
  /** A wait handed something out: the run ends. */
  something(): void;
}

/** A run of nothing: when it began, and when its last wait ended. */
export interface QuietRun {
  since: number;
  last: number;
}

/** One agent's Quiet in a map shared by many (bounded: forgetting one only starts its count again). */
export function quietIn(map: Recent<QuietRun>, agent: string, now: () => number = Date.now): Quiet {
  return {
    now,
    nothing(from) {
      const t = now();
      const run = map.get(agent);
      const since = run && from - run.last <= QUIET.gapMs ? run.since : from;
      if (t - since >= QUIET.stopMs) {
        map.delete(agent);
        return true;
      }
      map.set(agent, { since, last: t });
      return false;
    },
    something: () => map.delete(agent),
  };
}

/** A Quiet for one agent alone (stdio: the process is the agent). */
export const ownQuiet = (now?: () => number): Quiet => quietIn(new Recent<QuietRun>(1), '', now);

/** When a person last changed a note (written, edited, answered, given a reference): an agent's own reply is no news to it. */
function peopleChangedAt(c: Comment): number {
  const times = [c.created, c.edited, ...(c.replies || []).filter((r) => !isAgent(r.by)).map((r) => r.at), ...(c.refs || []).map((r) => r.at)];
  return Math.max(0, ...times.map(instant).filter(Number.isFinite));
}

export function registerFeedback(server: McpServer, o: FeedbackOptions): void {
  const b = o.backend;
  const wake = o.wake || sleepWake;
  // A server that wakes waits on every event (`wake`) needs no polling: the log is looked at again on an event, and
  // once a while as a safety net. Polling stays for stdio, where nothing else tells.
  const step = o.wake ? PING_MS : POLL_MS;
  server.registerTool(
    'wait_for_feedback',
    {
      title: 'Wait for new human feedback',
      description: `Blocks until a person leaves new feedback (notes, replies, verdicts, requests, references; optionally on one video) or timeout_s passes (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}; raise your client's tool timeout for long waits). Returns only what is new, new notes' drawings as cropped frames, and a cursor: pass it as since next time (without since: what waits for you, then from now on). Call it again after each answer: only while you wait do you hear new notes.`,
      inputSchema: trimmed(
        z.object({
          video: z.string().optional(),
          since: z.string().optional(),
          timeout_s: z.number().int().min(0).max(MAX_WAIT_S).optional(),
          images: z.enum(['drawn', 'all', 'none']).optional().describe('drawn (default): new notes with a drawing; all: every new note'),
        }),
      ),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ video, since, timeout_s = DEFAULT_WAIT_S, images = 'drawn' }, ctx: ServerContext) => {
      if (!o.allowed) return { content: [{ type: 'text', text: 'Error: your role may not read feedback' }], isError: true };
      const started = Date.now();
      const quietFrom = o.quiet?.now() ?? 0;
      let release: (() => void) | null = null;
      let listening: ((x?: { handed?: boolean }) => void) | null = null;
      // How the wait ended, for the log: never what it handed out.
      let outcome = 'error';
      try {
        const slug = video ? (await b.resolve(video)).slug : null;
        const held = o.hold?.();
        if (typeof held === 'string') {
          outcome = 'refused';
          return { content: [{ type: 'text', text: `Error: ${held}` }], isError: true };
        }
        release = held ?? null;
        o.activity?.({ video: slug }, ctx);
        o.log?.(`wait_for_feedback start timeout_s=${timeout_s}${since ? '' : ' first'}`);
        listening = o.onWait?.() ?? null;
        // Only what is new since the cursor's second (a hosted server sends that much, not its whole recent log). Every
        // video's: the cursor counts them all (after's `keep` picks this video's).
        const feedback = async (from: Cursor) => (await b.events(2000, { since: new Date(from.at - 1000).toISOString() })).filter(isFeedback);
        const ours = (e: ReviewEvent) => !slug || e.slug === slug;
        // Without a cursor the agent just started to listen: what was assigned to it and came in while it didn't (an MCP
        // client acts only when prompted) is handed over at once, each thing once (`told`), then it waits as usual.
        if (!since) {
          const backlog = await waitingFor(slug, async () => {
            const t = Date.now();
            const c = nowCursor(await feedback({ at: Math.floor(t / 1000) * 1000, seen: 0 }), t);
            return `${new Date(c.at).toISOString()}#${c.seen}`;
          });
          if (backlog) {
            outcome = `waiting ${backlog.count}`;
            listening?.({ handed: true });
            listening = null;
            o.quiet?.something();
            o.handed?.(backlog.slugs, ctx);
            return backlog.result;
          }
        }
        const now = Date.now();
        const first = since ? null : await feedback({ at: Math.floor(now / 1000) * 1000, seen: 0 });
        const cursor = first ? nowCursor(first, now) : parseCursor(since as string);
        // what the cursor was made from is the first look too
        let read: ReviewEvent[] | null = first;
        const deadline = Date.now() + timeout_s * 1000;
        const progressToken = ctx.mcpReq._meta?.progressToken;
        let lastPing = Date.now();
        for (;;) {
          if (o.stillAllowed && !o.stillAllowed()) {
            outcome = 'access ended';
            return { content: [{ type: 'text', text: `Error: ${GONE}` }], isError: true };
          }
          const { fresh, next, more } = after(read ?? (await feedback(cursor)), cursor, MAX_EVENTS, ours);
          read = null;
          if (fresh.length) {
            outcome = `${fresh.length} event${fresh.length === 1 ? '' : 's'}`;
            listening?.({ handed: true });
            listening = null;
            for (const e of fresh) if (e.slug) o.told?.mark(e.slug, Date.parse(e.at));
            o.quiet?.something();
            o.handed?.([...new Set(fresh.map((e) => e.slug).filter(Boolean))], ctx);
            return await result(fresh, next, more, images);
          }
          const left = deadline - Date.now();
          if (left <= 0 || ctx.mcpReq.signal.aborted) {
            outcome = ctx.mcpReq.signal.aborted ? 'cancelled' : 'timeout';
            // What is going on, after the two lines agents parse: the person sends notes together (Send), so call again
            // now — or, after QUIET.stopMs of only this (a cancelled wait isn't heard, so it doesn't count), stop.
            const stop = !ctx.mcpReq.signal.aborted && !!o.quiet?.nothing(quietFrom);
            if (stop) outcome = 'timeout, told to stop';
            return {
              content: [{ type: 'text', text: `No new feedback in ${timeout_s} s.\ncursor: ${next}\n${stop ? STOP_LINE : PENDING_LINE}` }],
              structuredContent: { events: [], cursor: next, ...(stop ? { stop: true } : {}) },
            };
          }
          await wake(Math.min(left, step), ctx.mcpReq.signal);
          // Keep long waits alive through proxies; a client that asked for progress also sees it tick.
          if (progressToken !== undefined && Date.now() - lastPing >= PING_MS) {
            lastPing = Date.now();
            const waited = Math.round((Date.now() - (deadline - timeout_s * 1000)) / 1000);
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: waited, total: timeout_s } }).catch(() => {});
          }
        }
      } catch (e) {
        return {
          content: [{ type: 'text', text: keepLines(`Error: ${publicMessage(e, o.audience ?? 'other', { status: 400, where: 'mcp wait_for_feedback' })}`) }],
          isError: true,
        };
      } finally {
        release?.();
        listening?.();
        o.log?.(`wait_for_feedback ${outcome} ${took(started)}`);
      }
    },
  );

  /**
   * What waits for this agent already: videos assigned to it with open work or ideas, or a request, it hasn't been told
   * of (`told`: by a wait, or by reading the notes) — one line each, and the cursor from now. Null when there is none,
   * or when nobody can tell who this agent is.
   */
  async function waitingFor(slug: string | null, cursorNow: () => Promise<string>): Promise<{ count: number; slugs: string[]; result: CallToolResult } | null> {
    const me = o.me?.();
    if (!me || (!me.name && !me.sessionId)) return null;
    const mine = forAgents(await b.listReviews()).filter(
      (r) => !r.archived && matchesSession(r.session, me) && (!slug || slugify(r.video) === slug) && b.stage(r).stage !== 'final',
    );
    if (!mine.length) return null;
    const told = (s: string) => o.told?.at(s) ?? 0;
    const asked = (await b.events(500)).filter((e) => e.type === 'request' && isFeedback(e) && e.slug);
    const lines: string[] = [];
    const waiting: { video: string; open: number; requests: number }[] = [];
    const slugs: string[] = [];
    let count = 0;
    for (const r of mine) {
      const s = slugify(r.video);
      // Requests since it was the agent's (events have whole seconds: one in the assignment's second counts) and since
      // it was last told of this video.
      const assigned = Math.floor((Date.parse(r.session?.assigned || '') || 0) / 1000) * 1000;
      const open = r.comments.filter((c) => c.status === 'open' && (isRequired(c) || isIdea(c)));
      // A person's last word on it (a reply of the agent's own is no news to it).
      const fresh = open.filter((c) => peopleChangedAt(c) > told(s));
      const requests = asked.filter((e) => e.slug === s && Date.parse(e.at) >= assigned && Date.parse(e.at) > told(s));
      if (!fresh.length && !requests.length) continue;
      lines.push(
        oneLine(
          `video: ${r.video} · ${open.length} open note${open.length === 1 ? '' : 's'}${requests.length ? ` · ${requests.length} request${requests.length === 1 ? '' : 's'}` : ''}`,
        ),
        ...requests.slice(-3).map(shortEventLine),
      );
      waiting.push({ video: r.video, open: open.length, requests: requests.length });
      slugs.push(s);
      count += open.length + requests.length;
      o.told?.mark(s, Date.now());
    }
    if (!lines.length) return null;
    const at = await cursorNow();
    return {
      count,
      slugs,
      result: {
        content: [
          {
            type: 'text',
            text: keepLines(
              `Waiting for you (assigned to you, came in while you weren't listening):\n${lines.join('\n')}\nRead the notes with get_open_notes, work them, then wait again with this cursor.\ncursor: ${at}`,
            ),
          },
        ],
        structuredContent: { events: [], cursor: at, waiting },
      },
    };
  }

  // Which playbooks apply to the videos the new feedback is on: one line per folder, so the fix follows them too.
  async function playbookLines(events: ReviewEvent[]): Promise<string> {
    const folders = new Set<string>();
    for (const slug of new Set(events.map((e) => e.slug).filter(Boolean)))
      folders.add(
        await b
          .review(slug)
          .then((r) => r.folder || '')
          .catch(() => ''),
      );
    const lines: string[] = [];
    for (const f of folders) {
      const stamp = await b.playbookStamp(f || null).catch(() => []);
      if (stamp.length)
        lines.push(oneLine(`playbook for ${f || 'Unsorted videos'}: ${stamp.map((s) => `${s.scope || 'House'} r${s.rev}`).join(' · ')} (get_playbook)`));
    }
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  // The lines without file paths: each video's path once, the pictures attached, the full events in structuredContent.
  async function result(events: ReviewEvent[], cursor: string, more: boolean, mode: 'drawn' | 'all' | 'none'): Promise<CallToolResult> {
    const shown = events;
    const outward = shown.map(o.publicEvent || ((e) => e));
    // A file name is someone's (an upload's, a file on the machine): one line each, whatever it holds.
    const videos = [...new Set(outward.map((e) => e.video).filter(Boolean))].map((v) => oneLine(`video: ${v}`));
    const content: CallToolResult['content'] = [
      {
        type: 'text',
        text: keepLines(
          `${events.length} new:\n${outward.map(shortEventLine).join('\n')}${more ? '\n(more are waiting: call again with this cursor, right away)' : ''}\n${videos.join('\n')}${await playbookLines(shown)}\ncursor: ${cursor}`,
        ),
      },
    ];
    let images = 0;
    let unseen = 0;
    for (const e of shown) {
      if (mode === 'none' || e.type !== 'comment' || !e.id || images >= MAX_IMAGES) continue;
      if (mode === 'drawn' && o.drawn) {
        const pic = await o.drawn(e.id).catch(() => []);
        if (pic.length) images++;
        else unseen++;
        content.push(...pic);
        continue;
      }
      const f = e.shots?.marked;
      if (!f || !fs.existsSync(f)) continue;
      content.push({ type: 'text', text: oneLine(`${e.id} · ${e.timecode} · marked frame`) });
      content.push(await o.preview(f, 540));
      images++;
    }
    if (unseen && content[0].type === 'text') content[0].text += '\n(a note without a drawing comes without a picture: get_note <id> shows its frame)';
    return { content, structuredContent: { events: outward, cursor, more } };
  }
}
