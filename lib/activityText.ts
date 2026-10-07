// What an agent did through Lampo, in plain words: an MCP tool call or a `lampo` command becomes one activity line
// ("Reading note c_7f3a", "Fixed c_7f3a", "Waiting for your answer"). Browser-safe (no Node imports): the server
// records with it and the tests read it. Lampo learns this from the calls it serves anyway, so it costs the agent no
// tokens; nothing here asks an agent to report anything.
//
// Every line is a template from ACTIVITY_KEYS with its fill-ins, so the UI can say it in its own language
// (web/src/sessions/activityWords.ts must cover every key: the typecheck holds it to that).
import { cleanAgentName } from './names.ts';
import { oneLine } from './time.ts';
import type { ActivityWords, AgentActivityKind } from './types.ts';

export const ACTIVITY_KEYS = [
  // the calls agents make (MCP tools, lampo)
  'Looking through the library',
  'Reading the inbox',
  'Reading the open notes',
  'Reading note {id}',
  'Reading a note',
  'Looking at frame {frame}',
  'Looking at a frame',
  'Looking at the marked frames',
  'Opening the review',
  'Reading the transcript',
  'Comparing versions',
  'Reading the Auto-check',
  'Reading your taste',
  'Reading the playbook',
  'Reading the skill {name}',
  'Suggesting a playbook rule',
  'Waiting for your answer',
  'Watching for feedback',
  'Replied to {id}',
  'Replied to a note',
  'Asked a question',
  'Added a note',
  'Fixed {id}',
  'Fixed a note',
  'Left {id} as it is',
  'Left a note as it is',
  'Attached a fix preview to {id}',
  'Attached a fix preview',
  'Added a reference to {id}',
  'Added a reference',
  'Put a new version up for review',
  'Registering the new version',
  'Uploading a new version',
  'Uploading {name}',
  'Uploaded {name}',
  'Noted where the version came from',
  'Moved the video',
  'Drafted the {platform} post',
  'Drafted a post',
  'Reading the posts',
  'Looking for footage',
  'Rendering… {mb} MB, still growing',
  'Rendering a new version',
  // how a render through `lampo render` ended (lib/render/job.ts)
  'Rendered in {time}',
  'The render failed (exit {code})',
  // what a run Lampo started printed (lib/runStream.ts) and how it went (server/agentRuns.ts)
  'Editing {file}',
  'Writing {file}',
  'Reading {file}',
  'Running {command}',
  'Running a command',
  'Searching for {pattern}',
  'Searching the project',
  'Looking something up on the web',
  'Handing part of it to a helper',
  'Planning the next steps',
  'Using {tool}',
  'Thinking',
  'Finished',
  'Stopped with an error',
  'Started by Lampo',
  'Finished after {time}',
  'Stopped after {time}',
  'Stopped at the time limit',
  'Couldn’t start',
  // a permission a run Lampo started was denied (lib/runStream.ts): it needs the person
  'Needs permission to run {command}',
  'Needs permission to use {tool}',
  'Needs permission to edit files',
  // a person's words to the agent while it works ("Tell it…"), kept with its work (server/runs.ts)
  '{name} asked',
] as const;
export type ActivityKey = (typeof ACTIVITY_KEYS)[number];
const KEYS = new Set<string>(ACTIVITY_KEYS);
export const isActivityKey = (k: unknown): k is ActivityKey => typeof k === 'string' && KEYS.has(k);

export interface ActivityGuess extends ActivityWords {
  kind: AgentActivityKind;
  /** The video as the caller named it (a slug, a name or a path); the server resolves it. */
  video?: string | null;
  /** A note id or a version. */
  target?: string | null;
}

/** An agent's status (`set_status`, `lampo status`) as long as it is kept (lib/inputs.ts INPUT_LIMITS.status): its own
 * sentence, shown whole where there is room (the Agent view) and cut only by the places that have none. */
export const STATUS_CHARS = 200;

/** A short, single-line excerpt of what someone wrote (never the whole text). */
export const excerpt = (s: string | null | undefined, max = 48): string => {
  const t = oneLine(s || '').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** A template with its fill-ins, as the English line and the words the UI translates. */
export function words(key: ActivityKey, vars?: Record<string, string | number>, quote?: string | null): ActivityWords {
  const filled = key.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''));
  const q = quote ? excerpt(quote) : '';
  return { text: q ? `${filled} “${q}”` : filled, key, ...(vars ? { vars } : {}), ...(q ? { quote: q } : {}) };
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string | null => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null);
const num = (a: Args, k: string): number | null => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : null);
const noteId = (a: Args) => str(a, 'id') || str(a, 'note') || str(a, 'comment');
const isNote = (s: string | null): s is string => !!s && /^c_[0-9a-f]{4,}$/i.test(s);
/** "Reading note {id}" for a note id, the plain form for anything else. */
const aboutNote = (id: string | null, withId: ActivityKey, without: ActivityKey, quote?: string | null): ActivityWords =>
  id ? words(withId, { id: excerpt(id, 24) }, quote) : words(without, undefined, quote);
const guess = (kind: AgentActivityKind, w: ActivityWords, more: { video?: string | null; target?: string | null } = {}): ActivityGuess => ({
  kind,
  ...w,
  ...more,
});

// Brand names, the same in every language.
const PLATFORM_WORD: Record<string, string> = {
  youtube: 'YouTube',
  yt: 'YouTube',
  instagram: 'Instagram',
  ig: 'Instagram',
  facebook: 'Facebook',
  fb: 'Facebook',
};

/** An MCP tool call (the tool's name and its arguments) as an activity, or null for calls not worth a line. */
export function toolActivity(tool: string, args: Args = {}): ActivityGuess | null {
  const video = str(args, 'video') || str(args, 'slug');
  const id = noteId(args);
  switch (tool) {
    case 'list_videos':
    case 'list_folders':
      return guess('read', words('Looking through the library'));
    case 'get_open_notes':
      return guess('read', words('Reading the open notes'), { video });
    case 'get_note':
      return guess('read', aboutNote(id, 'Reading note {id}', 'Reading a note'), { target: id });
    case 'get_frame': {
      const f = num(args, 'frame');
      return guess('read', f !== null ? words('Looking at frame {frame}', { frame: f }) : words('Looking at a frame'), { video });
    }
    case 'show_review':
      return guess('read', words('Opening the review'), { video });
    case 'get_transcript':
      return guess('read', words('Reading the transcript'), { video });
    case 'find_footage':
      return guess('read', words('Looking for footage', undefined, str(args, 'query')));
    case 'get_taste':
      return guess('playbook', words('Reading your taste'), { video });
    case 'get_playbook':
      return guess('playbook', words('Reading the playbook'), { video });
    case 'get_skill': {
      const name = excerpt(str(args, 'name'), 32);
      return guess('playbook', name ? words('Reading the skill {name}', { name }) : words('Reading the playbook'), { video });
    }
    case 'propose_playbook_change':
      return guess('playbook', words('Suggesting a playbook rule'), { video });
    case 'wait_for_feedback':
      return guess('wait', words('Waiting for your answer'), { video });
    case 'reply':
      return guess('reply', aboutNote(id, 'Replied to {id}', 'Replied to a note', str(args, 'text')), { target: id });
    case 'add_note': {
      const ask = str(args, 'kind') === 'question' || (!str(args, 'kind') && !str(args, 'severity'));
      return guess(ask ? 'ask' : 'note', words(ask ? 'Asked a question' : 'Added a note', undefined, str(args, 'text')), { video });
    }
    case 'ask_options':
      return guess('ask', words('Asked a question', undefined, str(args, 'text')), { video });
    case 'mark_fixed':
      return guess('fix', aboutNote(id, 'Fixed {id}', 'Fixed a note', str(args, 'note')), { target: id });
    case 'wont_fix':
      return guess('reply', aboutNote(id, 'Left {id} as it is', 'Left a note as it is', str(args, 'reason')), { target: id });
    case 'attach_preview':
      return guess('fix', aboutNote(id, 'Attached a fix preview to {id}', 'Attached a fix preview'), { target: id });
    case 'attach_reference':
      return guess('note', aboutNote(id, 'Added a reference to {id}', 'Added a reference'), { target: id });
    case 'track_video':
      return guess('upload', words('Put a new version up for review'), { video: video || str(args, 'path') });
    case 'request_upload': {
      const name = excerpt(str(args, 'filename'), 40);
      return guess('upload', name ? words('Uploading {name}', { name }) : words('Uploading a new version'), { video });
    }
    case 'set_render_source':
      return guess('upload', words('Noted where the version came from'), { video });
    case 'move_video':
      return guess('tool', words('Moved the video'), { video });
    case 'draft_post': {
      const p = PLATFORM_WORD[String(args.platform ?? '').toLowerCase()];
      return guess('tool', p ? words('Drafted the {platform} post', { platform: p }) : words('Drafted a post'), { video });
    }
    case 'get_posts':
      return guess('read', words('Reading the posts'), { video });
    case 'set_status': {
      // The agent's own words: shown as they are, whole.
      const t = excerpt(str(args, 'text'), STATUS_CHARS);
      return t ? { kind: 'status', text: t, video } : null;
    }
    default:
      return null;
  }
}

/** A `lampo` command (its name and parsed arguments) as an activity, or null. */
export function cliActivity(cmd: string, positional: string[] = [], flags: Args = {}): ActivityGuess | null {
  const first = positional[0] ?? null;
  const note = isNote(first) ? first : null;
  switch (cmd) {
    case 'ls':
    case 'folders':
      return guess('read', words('Looking through the library'));
    case 'inbox':
      return guess('read', words('Reading the inbox'));
    case 'open':
    case 'prompt':
      return guess('read', words('Reading the open notes'), { video: first });
    case 'show':
      return guess('read', aboutNote(note, 'Reading note {id}', 'Reading a note'), { target: note });
    case 'shots':
      return guess('read', words('Looking at the marked frames'), { video: first });
    case 'transcript':
      return guess('read', words('Reading the transcript'), { video: first });
    case 'footage':
      return first === 'find' || first === 'sheet'
        ? guess('read', words('Looking for footage', undefined, first === 'find' ? (positional[1] ?? null) : null))
        : null;
    case 'diff':
      return guess('read', words('Comparing versions'), { video: first });
    case 'qa':
      return guess('read', words('Reading the Auto-check'), { video: first });
    case 'taste':
      return guess('playbook', words('Reading your taste'), { video: first });
    case 'playbook':
      return guess('playbook', words(first === 'propose' ? 'Suggesting a playbook rule' : 'Reading the playbook'), { video: positional[1] ?? first });
    case 'post': {
      if (first !== 'draft') return guess('read', words('Reading the posts'), { video: positional[1] ?? null });
      const p = PLATFORM_WORD[String(flags.platform ?? '').toLowerCase()];
      return guess('tool', p ? words('Drafted the {platform} post', { platform: p }) : words('Drafted a post'), { video: positional[1] ?? null });
    }
    case 'watch':
      return guess('wait', words('Watching for feedback'));
    case 'fix':
      return note ? guess('fix', words('Fixed {id}', { id: note }, str(flags, 'note')), { target: note }) : null;
    case 'wontfix':
      return note ? guess('reply', words('Left {id} as it is', { id: note }), { target: note }) : null;
    case 'reply':
      return note ? guess('reply', words('Replied to {id}', { id: note }, positional.slice(1).join(' ') || null), { target: note }) : null;
    case 'ask':
      return guess('ask', words('Asked a question', undefined, str(flags, 'text')), { video: first });
    case 'add':
      return guess(
        str(flags, 'kind') === 'feedback' ? 'note' : 'ask',
        words(str(flags, 'kind') === 'feedback' ? 'Added a note' : 'Asked a question', undefined, positional.slice(1).join(' ') || null),
        {
          video: first,
        },
      );
    case 'push':
      return guess('upload', words('Uploading a new version'), { video: str(flags, 'to') });
    case 'track':
      return guess('upload', words('Put a new version up for review'), { video: first });
    case 'sync':
      return guess('upload', words('Registering the new version'), { video: first });
    case 'preview':
      return note ? guess('fix', words('Attached a fix preview to {id}', { id: note }), { target: note }) : null;
    case 'ref':
      return guess('note', aboutNote(note, 'Added a reference to {id}', 'Added a reference'), { target: note });
    case 'source':
      return guess('upload', words('Noted where the version came from'), { video: first });
    case 'status': {
      const t = excerpt(positional.slice(1).join(' '), STATUS_CHARS);
      return t ? { kind: 'status', text: t, video: first } : null;
    }
    default:
      return null;
  }
}

/** "agent:reel-cut" → "reel-cut" (the UI's name for an agent). */
export const agentName = (by: string | null | undefined): string | null => cleanAgentName((by || '').replace(/^agent:/, '')) || null;

/**
 * An account's name as it follows an agent's (`claude-code · Sam`): one short line, and never the separator itself — an
 * account named "Eve · Sam" (from before such names were refused) reads "Eve - Sam", never as Sam's.
 */
export const accountTag = (account: string): string => cleanAgentName(account.replace(/[·•∙⋅‧・]/g, '-'), 40);

/**
 * An agent's name with whose it is — `name · account`, how a connected agent of another person is listed — so what one
 * account says its agent did never shows under another's (A12 AGENT-10). A name that already ends with it stays as it
 * is; a long one is cut before the account, never the account off its end.
 */
export function ownedAgentName(name: string | null | undefined, account: string): string | null {
  const base = agentName(name);
  const who = accountTag(account);
  if (!base || !who) return base;
  const tail = ` · ${who}`;
  if (base.endsWith(tail)) return base;
  return `${cleanAgentName(base, 80 - tail.length) || 'agent'}${tail}`;
}
