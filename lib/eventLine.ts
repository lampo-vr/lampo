// One line per review event, as `vr watch` prints it and the MCP tool `wait_for_feedback` returns it (there without
// the file paths: shortEventLine). Agents parse these lines, so the format stays stable.
import path from 'node:path';
import { partLine } from './part.ts';
import { describeRef } from './refLine.ts';
import { isAgent, isAnswer, noteLabel, oneLine } from './time.ts';
import type { EventType, ReviewEvent } from './types.ts';

/** Human feedback an agent should act on: what wakes `wait_for_feedback` (`ref`: a reference added to a note). */
export const FEEDBACK_TYPES: EventType[] = ['comment', 'reply', 'status', 'edit', 'assigned', 'approval', 'request', 'ref'];
/** What INBOX.md, `vr inbox` and GET /api/inbox list: the feedback, and new videos. */
export const INBOX_TYPES: EventType[] = [...FEEDBACK_TYPES, 'added'];
/** Everything `vr watch` follows (`preview`: a newer render compared with a fix preview the reviewer verified on; `ref`:
 * an image, clip, link or moment of a render added to a note; `agent_run`: Lampo started the assigned agent on the
 * machine for a request, or that run ended). */
export const WATCH_TYPES: EventType[] = [
  'comment',
  'reply',
  'status',
  'edit',
  'assigned',
  'version',
  'delete',
  'approval',
  'request',
  'preview',
  'ref',
  'agent_run',
];

/**
 * News for an agent: what a person did here. History another store's import appended (`imported`, docs/moving.md) is
 * never news, whatever its time: `wait_for_feedback`, INBOX.md, `vr://inbox` and `vr inbox` skip it, as the live
 * followers do (server/feed.ts, `vr watch`).
 */
export const isFeedback = (e: ReviewEvent): boolean => !e.imported && !isAgent(e.by) && FEEDBACK_TYPES.includes(e.type);
/** What the agents' inbox lists (INBOX.md, `vr://inbox`, `vr inbox`, GET /api/inbox): new feedback and new videos. */
export const isInboxEvent = (e: ReviewEvent): boolean => !e.imported && !isAgent(e.by) && INBOX_TYPES.includes(e.type);

const STATUS_LABEL: Record<string, string> = { verified: 'VERIFIED', open: 'REOPENED', wontfix: 'WONTFIX', fixed: 'FIXED' };

/**
 * The status word of a status event: verified on a fix preview (the fix exists only in the project so far), or a
 * newer render that doesn't match the preview a fix was verified on (the note is back to "check fixes").
 */
export function statusLabel(e: Pick<ReviewEvent, 'status' | 'by' | 'reply'>): string {
  if (e.status === 'verified' && e.reply?.preview) return 'VERIFIED ON A PREVIEW (the next render must contain it)';
  if (e.status === 'fixed' && e.reply?.preview && e.by === 'system') return 'CHECK AGAIN';
  return (e.status && STATUS_LABEL[e.status]) || e.status || '';
}
export const sev = (s: string | undefined): string => (s || '').toUpperCase();
export const tags = (t: string[] | undefined): string => (t?.length ? t.join(',') : '-');

// The watcher's own wall clock: a hosted server writes its offset (often UTC), the agent reads its local time.
function clock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at.slice(11, 19);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One event, one line: text in it (a note, a reply, a verdict) keeps to that line. */
export function eventLine(e: ReviewEvent): string {
  return oneLine(line(e, true));
}

/**
 * The same line without the file paths at its end (`marked:`, `range frames:`, `video:`), for a reader that gets them
 * another way: MCP wait_for_feedback (the pictures, one `video:` line per video, the events in structuredContent).
 */
export function shortEventLine(e: ReviewEvent): string {
  return oneLine(line(e, false));
}

// What a reply says: picks from a question's options are their own line (PICKED …, quoted inside), words are quoted.
const said = (e: ReviewEvent): string => (e.reply?.answer ? `${e.reply.text}` : `"${e.reply?.text}"`);
const options = (e: ReviewEvent): string => (e.options?.length ? ` · options: ${e.options.join(', ')} (the reviewer picks in Lampo)` : '');

/** A question asked on a folder before any render (lib/asks.ts): no video, no moment — the folder instead. */
function folderLine(e: ReviewEvent, t: string): string {
  const where = `${e.id} folder ${e.folder || '-'}`;
  switch (e.type) {
    case 'comment':
      return `[${t}] NEW QUESTION ${where} by ${e.by} — "${e.text}"${options(e)}`;
    case 'status':
      if (e.reply?.text) return `[${t}] ANSWERED ${where} by ${e.by} — ${said(e)} · on: "${e.text}"`;
      return `[${t}] ${statusLabel(e)} ${where} by ${e.by}`;
    case 'reply':
      return `[${t}] REPLY ${where} by ${e.by} — ${said(e)} · on: "${e.text}"`;
    case 'delete':
      return `[${t}] DELETED ${where} by ${e.by}`;
    default:
      return `[${t}] ${e.type.toUpperCase()} ${where}${e.text ? ` — ${e.text}` : ''}`;
  }
}

function line(e: ReviewEvent, paths: boolean): string {
  const t = clock(e.at);
  // A folder's question: `folder` is '' once its project was deleted (it waits on no folder), still not a video's.
  if (!e.slug && typeof e.folder === 'string' && e.id) return folderLine(e, t);
  const name = path.basename(e.video);
  const to = e.session ? ` →${e.session}` : '';
  const vid = paths ? ` · video: ${e.video}` : '';
  const shots = paths ? ` · marked: ${e.shots?.marked}${e.shots?.range ? ` · range frames: ${e.shots.range}` : ''}` : '';
  switch (e.type) {
    case 'comment':
      return `[${t}] NEW ${noteLabel(e)} [${tags(e.tags)}] ${e.id} ${e.timecode} f${e.frame}${e.range ? ` (${e.range.in}-${e.range.out})` : ''} v${e.v} ${name}${to} — "${e.text || '(drawing only)'}"${e.range_at ? ` · range ${e.range_at}` : ''}${e.scope === 'video' ? ' · overall: about the whole video, not frame 0' : ''}${e.text_edit ? ` · CHANGE WORDS "${e.text_edit.from}" → "${e.text_edit.to}"` : ''}${e.part ? ` · ${partLine(e.part)}` : ''}${e.refs ? ` · ${e.refs} reference${e.refs === 1 ? '' : 's'} (see the note)` : ''}${options(e)}${shots}${vid}`;
    case 'ref':
      return `[${t}] REFERENCE ${e.id} ${e.timecode} ${name}${to} by ${e.by} — ${e.ref ? describeRef(e.ref) : 'added'} · on: "${e.text}"${vid}`;
    case 'status':
      if (isAnswer(e)) return `[${t}] ANSWERED ${e.id} ${e.timecode} ${name}${to} by ${e.by} — ${said(e)} · on: "${e.text}"${vid}`;
      return `[${t}] ${statusLabel(e)} ${e.id} ${e.timecode} ${name}${to} by ${e.by}${e.reply?.text ? ` — "${e.reply.text}"` : ''}${vid}`;
    case 'preview':
      return `[${t}] PREVIEW CONFIRMED ${e.id} ${e.timecode} ${name}${to} — "${e.reply?.text}"${vid}`;
    case 'reply':
      return `[${t}] REPLY ${e.id} ${e.timecode} ${name}${to} by ${e.by} — ${said(e)}${e.reply?.refs?.length ? ` + ${e.reply.refs.length} reference${e.reply.refs.length === 1 ? '' : 's'}` : ''} · on: "${e.text}"${vid}`;
    case 'edit':
      // a reply's author changed its words: the reply as it reads now, and the note it is on
      if (e.reply) return `[${t}] EDITED REPLY ${e.id} ${e.timecode} ${name}${to} by ${e.by} — now: "${e.reply.text}" · on: "${e.text}"${vid}`;
      return `[${t}] EDITED ${e.id} ${e.timecode} ${name}${to} — now: "${e.text}"${e.text_edit ? ` · CHANGE WORDS "${e.text_edit.from}" → "${e.text_edit.to}"` : ''} ${noteLabel(e)} [${tags(e.tags)}]${vid}`;
    case 'delete':
      // a reply taken back by its author (the note stays): which one by its time, not its words again
      if (e.reply) return `[${t}] DELETED REPLY ${e.id} ${e.timecode} ${name}${to} by ${e.by} — their reply of ${clock(e.reply.at)} · on: "${e.text}"`;
      return `[${t}] DELETED ${e.id} ${e.timecode} ${name}${to} by ${e.by}`;
    case 'request':
      return `[${t}] REQUEST ${name}${to} v${e.v} from ${e.by} — "${e.text}"${vid}`;
    case 'approval':
      return `[${t}] ${e.text} ${name}${to} by ${e.by}${vid}`;
    case 'agent_run':
      return e.phase === 'started'
        ? `[${t}] AGENT RUN STARTED ${e.session || '-'} ${name} v${e.v} by ${e.by} · run ${e.run}${vid}`
        : `[${t}] AGENT RUN ${(e.phase || 'finished').toUpperCase()} ${e.session || '-'} exit ${e.exit ?? '-'} ${name} · run ${e.run}${vid}`;
    default:
      return `[${t}] ${e.type.toUpperCase()} ${name}${to}${e.text ? ` — ${e.text}` : ''}${vid}`;
  }
}
