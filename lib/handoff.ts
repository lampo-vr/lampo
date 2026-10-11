// What an agent is told when it hands work to the person (a render put up, a note fixed) and while it waits for their
// notes. An agent hears notes only while it waits in wait_for_feedback (an MCP client acts only when prompted; nothing
// can push into an idle one), so the hand-off itself says "wait now", with a cursor from that moment: nothing that
// comes in between is lost. People keep notes as drafts and send them together, so a wait that ends with nothing new
// is the normal case, and says so. Agent-facing lines: appended to answers, never reworded (.claude/rules/agent-text.md,
// "What agents read"); each fits test/unit/token-budget.test.ts.
import { BRAND_NAME, MCP_NAME } from './brand.ts';
import { isFeedback } from './eventLine.ts';
import { fixBase, fixWaits, inPart } from './handover.ts';
import { isAgent, isRequired } from './time.ts';
import type { Comment, Review, ReviewEvent } from './types.ts';

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

/**
 * A version put up while the video's notes are still open (neither marked nor answered): marking what it fixed comes
 * first, the wait after the last mark (its answer says so). A fix marked before the version rode with it already
 * (lib/store.ts registerVersion). `how`: the way this agent marks one (`mark_fixed`, `lampo fix <id>`).
 */
export const markWhatItFixedLine = (n: number, how: string): string =>
  `${n} note${n === 1 ? '' : 's'} still open on this video: mark what this version fixed (${how}).`;

/** After a hand-back with no note left to work but fixes marked before their version: the version is next, not the wait. */
export const putUpNextLine = (n: number): string =>
  `${n} fix${n === 1 ? '' : 'es'} marked before ${n === 1 ? 'its' : 'their'} version: put the version up now; its answer says when to wait.`;

/** A wait that ended with nothing new: the normal case while the person reviews. */
export const PENDING_LINE = `${ON_SEND.charAt(0).toUpperCase()}${ON_SEND.slice(1)}: call wait_for_feedback again now with this cursor.`;

/** After QUIET_STOP_MIN minutes of only that: stop, and tell the person how to start listening again. */
export const QUIET_STOP_MIN = 30;
export const STOP_LINE = `${QUIET_STOP_MIN} min with nothing new: stop waiting now. Tell the person you stopped listening; the watch prompt (/${MCP_NAME}:watch in Claude Code) starts you again.`;
/**
 * A chat app (Claude, ChatGPT, Cowork) limits a turn, and every wait is a call in it: after CHAT_QUIET_WAITS waits in a
 * row with nothing new (about ten minutes at the 50 s default, near a chat app's own wait loop) the agent stops while
 * it still can say so, instead of being cut off mid-wait with the person's answer coming in Lampo to nobody.
 */
export const CHAT_QUIET_WAITS = 12;
/** What a chat agent says last when it stops waiting: one line that sends the person to the app and back. */
export const CHAT_WAIT_WORDS = `"I'm waiting for your answer in ${BRAND_NAME} — answer there, then tell me 'go on' here."`;
/** The same for a chat client: no command or other app to name; "go on" in the chat sets it waiting again. */
export const CHAT_STOP_LINE = `Nothing new for a while: stop waiting now, and end your turn with only this line to the person: ${CHAT_WAIT_WORDS}`;

/** Whether an answer's last line is the wait-now line: the agent handed the next step to the person (server/agents.ts). */
export const endsWaitNow = (text: string): boolean => /(^|\n)Now call wait_for_feedback with since "[^"\n]+": [^\n]*$/.test(text);

/**
 * The notes an agent still has to work on a video: open ones to fix whose last reply isn't an agent's. A note it
 * answered with a reply (a question, a why) waits for the person, so it isn't work left: after its last such answer it
 * waits. (One an agent wrote, as feedback on footage it reviewed, is work like a person's until someone answers it.)
 * A fix marked before its version is no work left either: it rides with the next version (lib/handover.ts).
 */
export function workLeft(comments: readonly Comment[]): number {
  return comments.filter((c) => c.status === 'open' && !fixWaits(c) && isRequired(c) && !isAgent(c.replies?.at(-1)?.by)).length;
}

/** Fixes marked before their version (lib/handover.ts fixWaits): the agent's next version takes them along. */
export const riding = (comments: readonly Comment[]): number => comments.filter(fixWaits).length;

/**
 * After a version is put up: the notes it may have fixed that nobody marked or answered yet — those older than it (a
 * note written on it, or found still wrong in it, is about it), and a part's only inside its stretch. While there are
 * any, its answer says to mark them (`markWhatItFixedLine`), not to wait.
 */
export function unmarkedAfter(review: Pick<Review, 'comments' | 'versions'>, part?: { at: number; frames: number } | null): number {
  const newest = review.versions.at(-1)?.v ?? 0;
  return workLeft(review.comments.filter((c) => fixBase(review.versions, c) < newest && (!part || inPart(c, part))));
}
