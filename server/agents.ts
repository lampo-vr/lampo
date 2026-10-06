// Agents that connected — `vr watch` in a Claude Code session, any MCP client over /mcp (Codex, Cursor, ChatGPT,
// Claude …) — announce themselves every 30 s. On a hosted server this is the list a video can be handed to (it can't
// see anyone's Claude Code sessions); on the person's own machine it complements `claude agents`.
// And whether each one hears new notes: an MCP client acts only when prompted, so it hears them only while it sits in
// wait_for_feedback (each open wait is told here); `vr watch` follows them by nature. That is what the app shows where
// a video is assigned, so nobody writes notes to an agent that won't look.
import { cleanAgentName, cleanFolderLine } from '../lib/names.ts';
import { isoLocal } from '../lib/paths.ts';
import { boundToWorkspace, currentWorkspace } from '../lib/scope.ts';
import type { AgentListenState, ClaudeSession, ConnectedAgent } from '../lib/types.ts';
import type { Broadcast } from './events.ts';

const TTL = 90_000;
/**
 * `betweenMs`: after a wait whose time ran out the agent still listens while it calls the next one. `workingMs`: after
 * a wait that handed it notes, it works on them this long at most before it reads as idle (unless it waits again).
 * Tests lower them.
 */
export const LISTEN_TIMES = { betweenMs: 20_000, workingMs: 10 * 60_000 };

export interface AgentRegistry {
  /** `listens`: it follows new notes by itself while it is listed (`vr watch`). */
  heartbeat(a: Omit<ConnectedAgent, 'last_seen' | 'state' | 'listened'>, o?: { listens?: boolean }): void;
  /**
   * An agent of this workspace started waiting for feedback (wait_for_feedback): the release, called when the wait
   * ends — `handed`: it returned something to work on.
   */
  wait(sessionId: string): (o?: { handed?: boolean }) => void;
  list(): ConnectedAgent[];
  /** The same agents in the shape of `claude agents` sessions, for the session picker. */
  sessions(): ClaudeSession[];
}

interface Waits {
  open: number;
  /** When the last wait ended (0: none yet), and whether it handed out something to work on. */
  ended: number;
  handed: boolean;
}

export function createAgentRegistry(broadcast: Broadcast): AgentRegistry {
  // Per workspace: an agent connected with a token (or app) of one workspace is listed in that one only — its name,
  // folder and host are nobody else's business.
  const agents = new Map<string, ConnectedAgent & { at: number; ws: string; listens: boolean }>();
  // Open and recent waits by agent, apart from the list: a wait outlives the heartbeats' TTL.
  const waits = new Map<string, Waits>();
  const stateOf = (key: string, listens: boolean, now: number): { state: AgentListenState; listened: string | null } => {
    const w = waits.get(key);
    if (w?.open) return { state: 'listening', listened: isoLocal(new Date(now)) };
    const listened = w?.ended ? isoLocal(new Date(w.ended)) : null;
    if (listens) return { state: 'listening', listened: isoLocal(new Date(now)) };
    if (w?.ended && w.handed && now - w.ended < LISTEN_TIMES.workingMs) return { state: 'working', listened };
    if (w?.ended && now - w.ended < LISTEN_TIMES.betweenMs) return { state: 'listening', listened };
    return { state: 'idle', listened };
  };
  const live = () => {
    const now = Date.now();
    const ws = currentWorkspace();
    for (const [id, a] of agents) if (now - a.at > TTL && !waits.get(id)?.open) agents.delete(id);
    for (const [id, w] of waits) if (!w.open && now - w.ended > LISTEN_TIMES.workingMs && !agents.has(id)) waits.delete(id);
    return [...agents.entries()].filter(([, a]) => a.ws === ws).map(([key, { ws: _ws, listens, ...a }]) => ({ ...a, ...stateOf(key, listens, now) }));
  };
  // A change of state is news for the pickers and chips (the list itself is asked for again on `sessions`).
  const told = new Map<string, AgentListenState>();
  const tell = (key: string) => {
    const a = agents.get(key);
    if (!a) return;
    const now = stateOf(key, a.listens, Date.now()).state;
    if (told.get(key) === now) return;
    told.set(key, now);
    if (told.size > 10_000) told.delete(told.keys().next().value as string);
    broadcast('sessions');
  };
  return {
    heartbeat(input, { listens = false } = {}) {
      // What an agent says of itself, over HTTP or as an MCP client: one line each, short (A12-D3).
      const a = {
        ...input,
        session_id: cleanAgentName(input.session_id, 200) || 'agent',
        name: cleanAgentName(input.name) || 'agent',
        cwd: input.cwd ? cleanFolderLine(input.cwd) || null : null,
        host: input.host ? cleanAgentName(input.host, 200) || null : null,
      };
      const ws = currentWorkspace();
      const key = `${ws}\u0000${a.session_id}`;
      const known = agents.has(key);
      agents.set(key, { ...a, last_seen: isoLocal(), at: Date.now(), ws, listens: listens || !!agents.get(key)?.listens });
      if (!known) broadcast('sessions');
      tell(key);
    },
    wait(sessionId) {
      const key = `${currentWorkspace()}\u0000${cleanAgentName(sessionId, 200) || 'agent'}`;
      const w = waits.get(key) ?? { open: 0, ended: 0, handed: false };
      w.open++;
      waits.set(key, w);
      tell(key);
      let done = false;
      return ({ handed = false } = {}) => {
        if (done) return;
        done = true;
        w.open = Math.max(0, w.open - 1);
        w.ended = Date.now();
        w.handed = handed;
        tell(key);
        // When the pause between two waits (or the time to work on what it got) has passed without a new one: say so.
        setTimeout(
          boundToWorkspace(() => tell(key)),
          (handed ? LISTEN_TIMES.workingMs : LISTEN_TIMES.betweenMs) + 50,
        ).unref();
      };
    },
    list: () => live().map(({ at: _at, ...a }) => a),
    sessions: () =>
      live().map((a) => ({
        name: a.name,
        sessionId: a.session_id,
        pid: null,
        cwd: a.cwd,
        kind: 'connected',
        status: a.state,
        startedAt: a.at,
        agent: a.kind ?? 'cli',
      })),
  };
}
