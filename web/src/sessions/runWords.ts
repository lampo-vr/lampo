// What an agent's work on a video says in full: the player's run strip, the Agent view, a note's plan line, the version
// picker's who-made-it. Built on runState.ts (the state, its glyph and a word or two, which the library's first paint
// carries); this part rides with the player. One value from the server in the person's words — never an id, and no
// noun for the work itself: the words say what is happening ("fixing 3 of 6", "rendering V4 · 42 %"), history is named
// by its version ("V4 · Claude Code · 12 min · 5 fixed"). What an agent did in its own terms (a step, an error, a
// permission) is said by the caller's `say` (sessions/activityWords.ts), else left out.
import type { ActivityWords, RunPlanItem, RunProgress } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago, pct, secsWords } from '../lib/format.ts';
import type { Shape } from '../ui/glyphs.ts';
import { edgeOf, fixing, LOOK, type Phase, phaseOf, progressOf, type RunLike, type Tone } from './runState.ts';

export { isOpen, phaseOf, planCounts, type RunLike, runShort } from './runState.ts';

/** What the person can do from the line (gated by the caller: Stop, Try again and Nudge need the agents right). */
export type RunAction = 'answer' | 'check' | 'log' | 'retry' | 'nudge' | 'stop' | 'cancel' | 'again' | 'copy' | 'allow';

export interface RunSaid {
  phase: Phase;
  shape: Shape;
  tone: Tone;
  /** The agent's name when the line starts with it (shown strong); null when the name is inside the words. */
  name: string | null;
  /** The rest of the line (after the name), or all of it. */
  words: string;
  /** What is never cut: a percentage, a clock. */
  figure: string | null;
  /** 0–1: the 2 px edge while a render or an upload says how far it is. */
  edge: number | null;
  /** What the line offers, the first the raised one where it is Answer or Check fixes. */
  actions: RunAction[];
}

/** An agent's own words in the UI's language (activityWords.ts `say`); absent where they aren't loaded. */
export type Say = (w: ActivityWords) => string;

export interface SayOptions {
  /** Now, in ms (a test sets it; the strip ticks it). */
  now?: number;
  /** When the server's answer came: `worked_s` grows from then while the agent works. */
  asOf?: number;
  /** The version a render will become when the progress doesn't say. */
  nextV?: number;
  say?: Say;
  /** Fixes waiting to be checked on the video (done offers Check fixes only while there are some). */
  toCheck?: number;
}

/** 0:12 · 6:12 · 1:02:09 — a clock that counts while something goes on. */
export function clock(s: number): string {
  const n = Math.max(0, Math.floor(s));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const ss = String(n % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Seconds the agent worked, counting on from the answer while it still works (time it waits for you doesn't count). */
export function workedNow(r: RunLike, now: number, asOf?: number): number {
  const going = r.state === 'working' || r.state === 'starting';
  return r.worked_s + (going && asOf ? Math.max(0, (now - asOf) / 1000) : 0);
}

const since = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, (now - Date.parse(iso)) / 1000) : 0);

/** A render's stage ("Bundling", "Rendering 42 %", "Encoding", "Uploading 80 %", "Checking V4"), about its version. */
function stageWords(p: RunProgress, v: number | null): string {
  const stage = ['bundling', 'rendering', 'encoding', 'uploading', 'checking'].includes(p.stage)
    ? p.stage
    : p.what === 'upload'
      ? 'uploading'
      : p.what === 'check'
        ? 'checking'
        : 'rendering';
  const of = { v: `V${v}` };
  if (stage === 'bundling') return v ? t('bundling {v}', of) : t('bundling the next version');
  if (stage === 'encoding') return v ? t('encoding {v}', of) : t('encoding the next version');
  if (stage === 'uploading') return v ? t('uploading {v}', of) : t('uploading the next version');
  if (stage === 'checking') return v ? t('checking {v}', of) : t('checking the next version');
  return v ? t('rendering {v}', of) : t('rendering the next version');
}

/** A line for what the agent is doing now: its step, or what it said, quoted. A step older than a minute and a half
 * (an agent Lampo only hears through its calls) says it is the last thing known, and how long ago. */
function nowWords(r: RunLike, o: SayOptions, now: number): string | null {
  const n = r.now;
  if (!n || !o.say || n.type === 'progress') return null;
  const words = n.type === 'thought' ? t('“{quote}”', { quote: o.say(n) }) : o.say(n);
  return since(n.at, now) > 90 ? t('last: {step} · {ago}', { step: words, ago: ago(n.at) }) : words;
}

/** What one run says, for the strip and the cards. */
export function runSaid(r: RunLike, o: SayOptions = {}): RunSaid {
  const now = o.now ?? Date.now();
  const name = r.agent.name;
  const phase = phaseOf(r);
  const line = (x: Pick<RunSaid, 'name' | 'words'> & Partial<Pick<RunSaid, 'edge' | 'figure' | 'actions'>>): RunSaid => ({
    phase,
    ...LOOK[phase],
    edge: null,
    figure: null,
    actions: [],
    ...x,
  });
  switch (phase) {
    case 'queued':
      return line({
        name: null,
        words: t('Sent to {name} · waiting for it to start', { name }),
        figure: clock(since(r.started, now)),
        actions: ['cancel'],
      });
    case 'starting': {
      const s = since(r.started, now);
      const where = r.agent.runner ? t('Starting {name} on {computer}', { name, computer: r.agent.runner }) : t('Starting {name}', { name });
      return line({
        name: null,
        words: s > 30 ? `${where} · ${t('still starting')}` : where,
        figure: clock(s),
        actions: ['stop'],
      });
    }
    case 'working': {
      const step = nowWords(r, o, now);
      return line({
        name,
        words: step ? `${fixing(r)} · ${step}` : fixing(r),
        figure: clock(workedNow(r, now, o.asOf)),
        actions: ['stop'],
      });
    }
    case 'rendering':
    case 'uploading':
    case 'checking': {
      const p = progressOf(r) as RunProgress;
      const v = p.v ?? o.nextV ?? null;
      const left = p.eta_s != null && p.eta_s > 0 ? ` · ${t('about {time} left', { time: secsWords(p.eta_s) })}` : '';
      return line({
        name,
        words: `${stageWords(p, v)}${left}`,
        figure: p.pct != null ? pct(p.pct / 100) : clock(workedNow(r, now, o.asOf)),
        edge: edgeOf(r),
        actions: phase === 'uploading' ? [] : ['stop'],
      });
    }
    case 'needs_you': {
      const k = r.needs?.kind ?? 'question';
      const what =
        k === 'options'
          ? t('needs you · options to pick')
          : k === 'permission'
            ? r.needs?.text && o.say
              ? t('needs permission · {what}', { what: o.say(r.needs.text) })
              : t('needs permission')
            : k === 'sign_in'
              ? t('needs you to sign in')
              : t('needs you · a question');
      return line({ name, words: what, actions: [k === 'permission' || k === 'sign_in' ? 'allow' : 'answer'] });
    }
    case 'done': {
      const res = r.result;
      const parts = [
        res?.fixed ? t('{n} fixed', { n: res.fixed }) : null,
        res?.asked ? t('{n} asked', { n: res.asked }) : null,
        res?.wontfix ? t('{n} left as is', { n: res.wontfix }) : null,
        r.worked_s >= 1 ? secsWords(r.worked_s) : null,
      ].filter(Boolean);
      const head = res?.v ? t('V{v} is ready', { v: res.v }) : t('{name} is done', { name });
      return line({
        name: null,
        words: [head, ...parts].join(' · '),
        actions: o.toCheck ? ['check'] : [],
      });
    }
    case 'failed': {
      const why = r.error && o.say ? o.say(r.error) : null;
      return line({ name, words: why ? `${t('stopped')} · ${why}` : t('stopped'), actions: ['log', 'retry'] });
    }
    case 'stopped':
      return line({
        name: null,
        words: t('Stopped after {time}', { time: secsWords(Math.max(1, r.worked_s)) }),
        actions: ['again'],
      });
    case 'lost':
      return line({
        name: null,
        words: t('No word from {name} for {time}', { name, time: secsWords(Math.max(60, since('seen' in r ? r.seen : (r.now?.at ?? r.started), now))) }),
        actions: ['nudge', 'stop'],
      });
    default:
      return line({ name, words: '' });
  }
}

/** The agent with no work going on this video: it hears notes when you send them, or it isn't running. */
export function idleSaid(name: string, reachable: boolean, canCopy: boolean): RunSaid {
  return reachable
    ? { phase: 'ready', ...LOOK.ready, name, words: t('ready · gets your notes when you send'), figure: null, edge: null, actions: [] }
    : {
        phase: 'unreachable',
        ...LOOK.unreachable,
        name: null,
        words: t('{name} isn’t running · start it', { name }),
        figure: null,
        edge: null,
        actions: canCopy ? ['copy'] : [],
      };
}

/** A note's line under its row while it is in a run's plan: nothing before the agent reaches it. */
export function planSaid(p: RunPlanItem, name: string, latestV: number): { shape: Shape; tone: Tone; words: string } | null {
  switch (p.state) {
    case 'doing':
      return { shape: 'ease', tone: 'live', words: t('{name} is on it', { name }) };
    case 'fixed':
      return p.v
        ? p.v <= latestV
          ? { shape: 'half', tone: 'ok', words: t('fixed in V{v} · check it', { v: p.v }) }
          : { shape: 'half', tone: 'ok', words: t('fixed · in V{v}', { v: p.v }) }
        : { shape: 'half', tone: 'ok', words: t('fixed · the version is coming') };
    case 'asked':
      return { shape: 'diamond', tone: 'ask', words: t('asked you') };
    case 'wontfix':
      return { shape: 'hold', tone: 'quiet', words: t('left as it is') };
    case 'replied':
      return { shape: 'diamond', tone: 'quiet', words: t('replied') };
    default:
      return p.added ? { shape: 'outline', tone: 'quiet', words: t('added while it works') } : null;
  }
}

/** A version an agent made, in a line (the version picker, the Agent view's history): "Claude Code · 12 min · 5 fixed". */
export function madeBy(r: RunLike): string {
  const res = r.result;
  return [
    r.agent.name,
    r.worked_s >= 1 ? secsWords(r.worked_s) : null,
    res?.fixed ? t('{n} fixed', { n: res.fixed }) : null,
    res?.asked ? t('{n} asked', { n: res.asked }) : null,
    res?.wontfix ? t('{n} left as is', { n: res.wontfix }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
