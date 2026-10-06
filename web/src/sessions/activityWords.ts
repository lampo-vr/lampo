// What an agent is doing, in the UI's language. The server sends each activity line as a template of
// lib/activityText.ts with its fill-ins; every template has its words here (a Record over all keys: a new template
// without them is a type error). Lines without a template are an agent's own words and stay as they are.
import { type ActivityKey, isActivityKey } from '../../../lib/activityText.ts';
import type { ActivityWords } from '../api/types.ts';
import { type Params, t } from '../i18n/index.ts';

const WORDS: Record<ActivityKey, (v: Params) => string> = {
  'Looking through the library': () => t('Looking through the library'),
  'Reading the inbox': () => t('Reading the inbox'),
  'Reading the open notes': () => t('Reading the open notes'),
  'Reading note {id}': (v) => t('Reading note {id}', v),
  'Reading a note': () => t('Reading a note'),
  'Looking at frame {frame}': (v) => t('Looking at frame {frame}', v),
  'Looking at a frame': () => t('Looking at a frame'),
  'Looking at the marked frames': () => t('Looking at the marked frames'),
  'Opening the review': () => t('Opening the review'),
  'Reading the transcript': () => t('Reading the transcript'),
  'Comparing versions': () => t('Comparing versions'),
  'Reading the Auto-check': () => t('Reading the Auto-check'),
  'Reading your taste': () => t('Reading your taste'),
  'Reading the playbook': () => t('Reading the playbook'),
  'Reading the skill {name}': (v) => t('Reading the skill {name}', v),
  'Suggesting a playbook rule': () => t('Suggesting a playbook rule'),
  'Waiting for your answer': () => t('Waiting for your answer'),
  'Watching for feedback': () => t('Watching for feedback'),
  'Replied to {id}': (v) => t('Replied to {id}', v),
  'Replied to a note': () => t('Replied to a note'),
  'Asked a question': () => t('Asked a question'),
  'Added a note': () => t('Added a note'),
  'Fixed {id}': (v) => t('Fixed {id}', v),
  'Fixed a note': () => t('Fixed a note'),
  'Left {id} as it is': (v) => t('Left {id} as it is', v),
  'Left a note as it is': () => t('Left a note as it is'),
  'Attached a fix preview to {id}': (v) => t('Attached a fix preview to {id}', v),
  'Attached a fix preview': () => t('Attached a fix preview'),
  'Added a reference to {id}': (v) => t('Added a reference to {id}', v),
  'Added a reference': () => t('Added a reference'),
  'Put a new version up for review': () => t('Put a new version up for review'),
  'Registering the new version': () => t('Registering the new version'),
  'Uploading a new version': () => t('Uploading a new version'),
  'Uploading {name}': (v) => t('Uploading {name}', v),
  'Uploaded {name}': (v) => t('Uploaded {name}', v),
  'Noted where the version came from': () => t('Noted where the version came from'),
  'Moved the video': () => t('Moved the video'),
  'Drafted the {platform} post': (v) => t('Drafted the {platform} post', v),
  'Drafted a post': () => t('Drafted a post'),
  'Reading the posts': () => t('Reading the posts'),
  'Looking for footage': () => t('Looking for footage'),
  'Rendering… {mb} MB, still growing': (v) => t('Rendering… {mb} MB, still growing', v),
  'Rendering a new version': () => t('Rendering a new version'),
  'Editing {file}': (v) => t('Editing {file}', v),
  'Writing {file}': (v) => t('Writing {file}', v),
  'Reading {file}': (v) => t('Reading {file}', v),
  'Running {command}': (v) => t('Running {command}', v),
  'Running a command': () => t('Running a command'),
  'Searching for {pattern}': (v) => t('Searching for {pattern}', v),
  'Searching the project': () => t('Searching the project'),
  'Looking something up on the web': () => t('Looking something up on the web'),
  'Handing part of it to a helper': () => t('Handing part of it to a helper'),
  'Planning the next steps': () => t('Planning the next steps'),
  'Using {tool}': (v) => t('Using {tool}', v),
  Thinking: () => t('Thinking'),
  Finished: () => t('Finished'),
  'Stopped with an error': () => t('Stopped with an error'),
  'Started by Lampo': () => t('Started by Lampo'),
  'Finished after {time}': (v) => t('Finished after {time}', v),
  'Stopped after {time}': (v) => t('Stopped after {time}', v),
  'Stopped at the time limit': () => t('Stopped at the time limit'),
  'Couldn’t start': () => t('Couldn’t start'),
};

/** A note's moment for its id (`00:15:08`), where the video's notes are at hand; null when it isn't one of them. */
export type NoteAt = (id: string) => string | null;

// A note id is the agent's handle, never a person's: they know a note by its moment, else it is "a note".
const BY_NOTE: Partial<Record<ActivityKey, { at: (tc: string) => string; none: ActivityKey }>> = {
  'Reading note {id}': { at: (tc) => t('Reading the note at {tc}', { tc }), none: 'Reading a note' },
  'Replied to {id}': { at: (tc) => t('Replied to the note at {tc}', { tc }), none: 'Replied to a note' },
  'Fixed {id}': { at: (tc) => t('Fixed the note at {tc}', { tc }), none: 'Fixed a note' },
  'Left {id} as it is': { at: (tc) => t('Left the note at {tc} as it is', { tc }), none: 'Left a note as it is' },
  'Attached a fix preview to {id}': { at: (tc) => t('Attached a fix preview to the note at {tc}', { tc }), none: 'Attached a fix preview' },
  'Added a reference to {id}': { at: (tc) => t('Added a reference to the note at {tc}', { tc }), none: 'Added a reference' },
};

/** The words of one activity line (without the quote that may follow them), never a note's id. */
export function phrase(w: ActivityWords, noteAt?: NoteAt): string {
  if (!isActivityKey(w.key)) return w.text;
  const note = BY_NOTE[w.key];
  if (note) {
    const id = w.vars?.id;
    const tc = id === undefined ? null : (noteAt?.(String(id)) ?? null);
    return tc ? note.at(tc) : WORDS[note.none]({});
  }
  return WORDS[w.key](w.vars ?? {});
}

/** Someone's words as the server cut them (48 characters), cut back to a whole word. */
export function atWord(quote: string): string {
  if (!quote.endsWith('…')) return quote;
  const body = quote.slice(0, -1);
  const space = body.lastIndexOf(' ');
  return `${(space > 12 ? body.slice(0, space) : body).replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** The whole line, with someone's own words after it in quotes; a fix is told by what it changed. */
export function say(w: ActivityWords, noteAt?: NoteAt): string {
  if (!w.quote) return phrase(w, noteAt);
  const quote = atWord(w.quote);
  if (w.key === 'Fixed {id}') return t('Fixed “{quote}”', { quote });
  return `${phrase(w, noteAt)} ${t('“{quote}”', { quote })}`;
}
