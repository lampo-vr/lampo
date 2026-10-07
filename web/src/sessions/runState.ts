// Where an agent's work on a video stands, in the fewest words: the state (design §5.2) with its keyframe glyph, a word
// or two ("rendering · 42 %", "needs you"), and how far a render is. Light, for the library's first paint (the cards'
// line, the sidebar's Agents rows); the player's strip says it in full (runWords.ts). One value from the server
// (lib/types.ts Run, or the cards' RunBrief) — never an id, and no noun for the work itself.
import type { ActivityWords, Run, RunBrief, RunProgress, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { pct } from '../lib/format.ts';
import type { Shape } from '../ui/glyphs.ts';

/** A run as the card has it, or whole. */
export type RunLike = RunBrief | Run;

/** The states of the experience (design §5.2): the run's own, with its progress told apart. */
export type Phase =
  | 'queued'
  | 'starting'
  | 'working'
  | 'rendering'
  | 'uploading'
  | 'checking'
  | 'needs_you'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'lost'
  // no run going: the agent is there and hears notes, or it isn't running
  | 'ready'
  | 'unreachable';

/** How a line looks: the glyph's colour (never the brand orange; working wears the agents' terracotta as today). */
export type Tone = 'live' | 'ask' | 'ok' | 'err' | 'warn' | 'quiet';

/** Each state's keyframe: ⧗ on it (turning), ◇ waiting, ◈ fixed and not checked, ◆ decided, ▢ nothing moves. */
export const LOOK: Record<Phase, { shape: Shape; tone: Tone }> = {
  queued: { shape: 'outline', tone: 'quiet' },
  starting: { shape: 'ease', tone: 'live' },
  working: { shape: 'ease', tone: 'live' },
  rendering: { shape: 'ease', tone: 'live' },
  uploading: { shape: 'ease', tone: 'live' },
  checking: { shape: 'ease', tone: 'live' },
  needs_you: { shape: 'diamond', tone: 'ask' },
  done: { shape: 'half', tone: 'ok' },
  failed: { shape: 'hold', tone: 'err' },
  stopped: { shape: 'hold', tone: 'quiet' },
  lost: { shape: 'outline', tone: 'warn' },
  ready: { shape: 'outline', tone: 'quiet' },
  unreachable: { shape: 'outline', tone: 'quiet' },
};

/** Still going (the server ends it: done, failed, stopped). */
export const isOpen = (r: RunLike): boolean => r.ended == null && r.state !== 'done' && r.state !== 'failed' && r.state !== 'stopped';

/** The run a card speaks of: one going on, one that ended badly (failed, stopped) or waiting for the person (needs you),
 * or one done while its fixes wait to be checked. Older servers send no `run` (undefined): their cards keep today's line. */
export function cardRun(v: Pick<VideoSummary, 'run' | 'stage'>): RunLike | null {
  const r = v.run;
  if (!r) return null;
  if (isOpen(r) || r.state === 'failed' || r.state === 'stopped' || r.state === 'needs_you') return r;
  return r.state === 'done' && v.stage.stage === 'check_fixes' ? r : null;
}

/** The progress shown: only while the agent works. */
export const progressOf = (r: RunLike): RunProgress | null => (r.state === 'working' && r.progress ? r.progress : null);

/** 0–1 while a render or an upload says how far it is; null otherwise. */
export function edgeOf(r: RunLike): number | null {
  const p = progressOf(r);
  return p?.pct != null ? Math.max(0, Math.min(1, p.pct / 100)) : null;
}

/** "42 %" while a render or an upload says how far it is (the part of a line that is never cut). */
export function pctOf(r: RunLike): string | null {
  const p = progressOf(r);
  return p?.pct != null ? pct(p.pct / 100) : null;
}

export function phaseOf(r: RunLike): Phase {
  const p = progressOf(r);
  if (p) return p.what === 'upload' ? 'uploading' : p.what === 'check' ? 'checking' : 'rendering';
  return r.state;
}

/** The plan in counts: sent, answered (fixed, asked, left, replied) and in hand. */
export function planCounts(r: RunLike): { total: number; answered: number; doing: number } {
  if ('plan' in r) {
    const answered = r.plan.filter((p) => p.state !== 'todo' && p.state !== 'doing').length;
    return { total: r.plan.length, answered, doing: r.plan.filter((p) => p.state === 'doing').length };
  }
  return { total: r.planned, answered: r.answered, doing: 0 };
}

/** "fixing 3 of 6": the note it is on, counted from the ones done (one in hand when nothing says which). */
export function fixing(r: RunLike): string {
  const { total, answered, doing } = planCounts(r);
  if (!total) return t('working');
  if (answered >= total) return t('wrapping up · {n} of {n} done', { n: total });
  return t('fixing {n} of {total}', { n: Math.min(total, answered + Math.max(1, doing)), total });
}

/** A word or two for where it stands ("rendering", "needs you", "V4 is ready"); `stateWords` adds the version a render
 * is of where nothing beside it says so. The percentage goes beside it (pctOf), never inside, so it is never cut. */
export function runShort(r: RunLike): string {
  switch (phaseOf(r)) {
    case 'queued':
      return t('sent');
    case 'starting':
      return t('starting');
    case 'rendering':
      return t('rendering');
    case 'uploading':
      return t('uploading');
    case 'checking':
      return t('checking');
    case 'needs_you':
      return t('needs you');
    case 'done':
      return r.result?.v ? t('V{v} is ready', { v: r.result.v }) : t('done');
    case 'failed':
      return t('failed');
    case 'stopped':
      return t('stopped');
    case 'lost':
      return t('no word');
    default:
      return fixing(r);
  }
}

/** The word or two and how far it is, for one line that has no room for more: "rendering 42 %". */
export const shortLine = (r: RunLike): string => [runShort(r), pctOf(r)].filter(Boolean).join(' ');

/** The word or two with the version a render, an upload or a check is of, where its progress says which: "rendering
 * V4". In Lampo's words whatever the agent wrote: its "rendering v4 (…)" is its own sentence, never the state. */
export function stateWords(r: RunLike): string {
  const v = progressOf(r)?.v;
  if (v) {
    const phase = phaseOf(r);
    if (phase === 'rendering') return t('rendering {v}', { v: `V${v}` });
    if (phase === 'uploading') return t('uploading {v}', { v: `V${v}` });
    if (phase === 'checking') return t('checking {v}', { v: `V${v}` });
  }
  return runShort(r);
}

/**
 * What it did in its own words: its step while it works (what it said, quoted), why it failed. `say` puts a step in the
 * UI's language; without it (its words not loaded yet) only what the agent wrote itself, which needs none of ours.
 */
export function ownWords(r: RunLike, say?: (w: ActivityWords) => string): string | null {
  const phase = phaseOf(r);
  const n = r.now;
  if (phase === 'working' && n && n.type !== 'progress') {
    if (n.type === 'thought') return t('“{quote}”', { quote: say ? say(n) : n.text });
    return say ? say(n) : null;
  }
  if (phase === 'failed' && r.error) return say ? say(r.error) : r.error.key ? null : r.error.text;
  return null;
}

/**
 * A tight place's words — the agent button, a poster's chip, the sidebar's rows: the state in a word or two and the
 * figure beside it, never cut ("rendering V4" · "42%"). Never a step or the agent's own sentence: those are the strip's
 * and the board's, and whole in the place's title (`fullWords`).
 */
export const tightOf = (r: RunLike): { words: string; figure: string | null } => ({ words: stateWords(r), figure: pctOf(r) });

/** Everything a line about it says, for a title or an accessible name: the state, its own words, how far. */
export const fullWords = (r: RunLike, say?: (w: ActivityWords) => string): string => [stateWords(r), ownWords(r, say), pctOf(r)].filter(Boolean).join(' · ');

/** Which of an agent's runs speaks for it in one place (the sidebar): what needs the person first, then work going on. */
const URGENCY: Record<Phase, number> = {
  needs_you: 0,
  failed: 1,
  lost: 2,
  rendering: 3,
  uploading: 3,
  checking: 3,
  working: 4,
  starting: 5,
  queued: 6,
  done: 7,
  stopped: 8,
  ready: 9,
  unreachable: 9,
};
export function mostUrgent<T extends RunLike>(runs: T[]): T | null {
  let best: T | null = null;
  for (const r of runs) if (!best || URGENCY[phaseOf(r)] < URGENCY[phaseOf(best)]) best = r;
  return best;
}
