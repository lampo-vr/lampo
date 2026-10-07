// Starting an agent that isn't running, on the person's own machine: the parts that decide what runs, kept pure so
// they can be tested without starting anything (and browser-safe: the agent menu asks wakeBlocker too). The process
// itself is server/agentRuns.ts.
//
// Only Claude Code sessions can be woken, by resuming the assigned session in print mode in its own directory:
//   claude --resume <session id> --print --output-format stream-json --verbose "<prompt>"
// No permission flags of any kind: the run does what the person's own Claude Code settings allow, nothing more.
import { agentKindOfRef } from './agentKind.ts';
import { oneLine } from './time.ts';
import type { AssignedSession, WakePref } from './types.ts';

/** How long a run may take before it is stopped (LAMPO_AGENT_RUN_TIMEOUT, seconds, overrides it: server/agentRuns.ts). */
export const RUN_TIMEOUT_MS = 30 * 60_000;
/** Starts per session within RUN_RATE_WINDOW_MS. */
export const RUN_RATE_MAX = 5;
export const RUN_RATE_WINDOW_MS = 10 * 60_000;
/** Longest request text passed on (the rest is cut, with an ellipsis). */
export const PROMPT_TEXT_MAX = 2000;
/** The default when the person hasn't chosen: ask each time. */
export const WAKE_DEFAULT: WakePref = 'ask';

/** Claude Code session ids are UUIDs; anything else is refused before it gets near an argument list. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s: string | null | undefined): s is string => !!s && SESSION_ID.test(s);

/** Flags that would widen what the run may do. They are never passed; the test suite checks the list stays clean. */
export const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--permission-prompts'];

/**
 * The arguments for one run (an array, never a shell string). `--output-format stream-json` needs `--verbose` with
 * `--print`; the prompt is the last, positional argument and always starts with "Lampo:", never with a dash.
 */
export function claudeRunArgs(sessionId: string, prompt: string): string[] {
  if (!isSessionId(sessionId)) throw new Error('not a Claude Code session id');
  if (!prompt.startsWith('Lampo:')) throw new Error('the prompt comes from wakePrompt()');
  return ['--resume', sessionId, '--print', '--output-format', 'stream-json', '--verbose', prompt];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The one prompt a run starts with. Everything people wrote goes through oneLine() and is length-limited. */
export function wakePrompt(o: { who: string; video: string; slug: string; v: number | null | undefined; text: string }): string {
  const text = clip(oneLine(o.text).trim(), PROMPT_TEXT_MAX) || 'Look at the new feedback.';
  return oneLine(
    `Lampo: ${clip(o.who, 80)} asks about ${clip(o.video, 200)} (${clip(o.slug, 200)}${o.v ? `, V${o.v}` : ''}): ${text}${/[.!?…]$/.test(text) ? '' : '.'} Read the open notes with lampo (the command or the MCP server) and act on them.`,
  );
}

/** Why a session can't be started from here, or null when it can (the caller checks the machine and the request). */
export function wakeBlocker(session: Pick<AssignedSession, 'name' | 'id' | 'cwd' | 'agent'> | null | undefined): string | null {
  if (!session) return 'no agent is assigned to this video';
  if (agentKindOfRef(session) !== 'claude-code') return 'only Claude Code sessions can be started from Lampo';
  if (!isSessionId(session.id)) return 'the assigned session has no Claude Code session id';
  if (!session.cwd) return 'the assigned session has no working directory';
  return null;
}
