// What an agent is told when it hands work to the person (a render put up, a note fixed) and while it waits for their
// notes. An agent hears notes only while it waits in wait_for_feedback (an MCP client acts only when prompted; nothing
// can push into an idle one), so the hand-off itself says "wait now", with a cursor from that moment: nothing that
// comes in between is lost. People keep notes as drafts and send them together, so a wait that ends with nothing new
// is the normal case, and says so. Agent-facing lines: appended to answers, never reworded (AGENTS.md "What agents
// read"); each fits test/unit/token-budget.test.ts.
import { MCP_NAME } from './brand.ts';
import { isFeedback } from './eventLine.ts';
import type { ReviewEvent } from './types.ts';

/** The words every line here shares: notes come when the person sends them, together. */
const ON_SEND = "the person's notes arrive together when they press Send";

/**
 * A wait_for_feedback cursor for this moment (`<iso>#<seen>`): the second it is in, and how many people's events of that
 * second the log holds already (timestamps have one-second resolution). Counted over every video, as the wait the line
 * asks for listens: what came before is never handed out again, what comes after is never skipped.
 */
export function cursorAt(events: readonly ReviewEvent[], now: number): string {
  const at = Math.floor(now / 1000) * 1000;
  const seen = events.filter((e) => isFeedback(e) && Date.parse(e.at) === at).length;
  return `${new Date(at).toISOString()}#${seen}`;
}

/** The last line of an MCP answer that hands something to the person: wait now, from this moment. */
export const waitNowLine = (cursor: string): string => `Now call wait_for_feedback with since "${cursor}": ${ON_SEND}.`;

/**
 * The last line of an answer that leaves the agent nothing to do (a list with nothing open, a video's notes all
 * answered): the next step, so a read never ends the loop. Put up a version it has (V1 into an empty project), then wait.
 */
export const nothingWaitingLine = (cursor: string): string =>
  `Nothing waiting for you: put up any version you have, then call wait_for_feedback with since "${cursor}".`;

/** The same for `lampo`: its own way to wait (`lampo watch` follows from when it starts; it takes no cursor). */
export const WATCH_NOW_LINE = `Now listen with lampo watch (keep it running): ${ON_SEND}.`;

/** A fix handed over while more of the video's work is open: no waiting yet. */
export const stillOpenLine = (n: number): string => `${n} note${n === 1 ? '' : 's'} still open on this video.`;

/** A wait that ended with nothing new: the normal case while the person reviews. */
export const PENDING_LINE = `${ON_SEND.charAt(0).toUpperCase()}${ON_SEND.slice(1)}: call wait_for_feedback again now with this cursor.`;

/** After QUIET_STOP_MIN minutes of only that: stop, and tell the person how to start listening again. */
export const QUIET_STOP_MIN = 30;
export const STOP_LINE = `${QUIET_STOP_MIN} min with nothing new: stop waiting now. Tell the person you stopped listening; the watch prompt (/${MCP_NAME}:watch in Claude Code) starts you again.`;
