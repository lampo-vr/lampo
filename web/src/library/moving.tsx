// Moving a video to another lane (a drag on the board, ⌥← / ⌥→ on a card, or "Move to" in its menu): the move shows at
// once, asks what it must (the app's Confirm for a final mark, a reopening or approving over open must-fix notes; a
// sentence for the agent when changes are requested with nothing open), then waits behind an Undo toast and only goes
// to the server once the toast is gone (lib/toast.ts `later`, as the inbox does): an undone move never reaches an
// agent. The writes are the player's own (status/api.ts `stageCalls`); the rules are library/moves.ts. Loaded on the
// first move (moved.ts `moveCode`): the library's first paint carries none of it.
import type { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Action } from '../../../lib/permissions.ts';
import type { StageInfo } from '../../../lib/types.ts';
import { type useSettle, withEntry } from '../api/mutations.ts';
import { keys } from '../api/queries.ts';
import type { LibraryResponse, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { type Deferred, later } from '../lib/toast.ts';
import { stageCalls } from '../status/api.ts';
import { laneLabel } from '../status/stageText.ts';
import { AutoTextarea } from '../ui/controls.tsx';
import { Confirm, Modal } from '../ui/primitives.tsx';
import type { LaneId } from './model.ts';
import { type Ask, currentAsk, setAsk, setLanded, showMoved, useMoveState } from './moved.ts';
import { compose } from './moveSteps.ts';
import { planMove, type Step, stageAfter } from './moves.ts';

/** A move that decides what its card shows until it is done (sent, undone or called off). */
interface Owner {
  stage: StageInfo;
  done: boolean;
}

interface Waiting {
  /** Where the video stood before the moves still waiting. */
  base: VideoSummary;
  steps: Step[];
  owner: Owner;
  deferred: Deferred | null;
}

// Per video: the move waiting behind its toast (one at a time: a newer one takes its writes along), the move whose
// stage the card shows, and the writes on their way (sent in order).
const waiting = new Map<string, Waiting>();
const owners = new Map<string, Owner>();
const sending = new Map<string, Promise<unknown>>();

/** `o` shows its stage on the card; returns the move that did before. */
function claim(slug: string, o: Owner): Owner | undefined {
  const before = owners.get(slug);
  owners.set(slug, o);
  showMoved(slug, o.stage);
  return before;
}

/** `o` is done: the card shows what the move before it shows, if that one is still on its way, else the server's. */
function release(slug: string, o: Owner, back?: Owner) {
  o.done = true;
  if (owners.get(slug) !== o) return;
  if (back && !back.done) {
    owners.set(slug, back);
    showMoved(slug, back.stage);
  } else {
    owners.delete(slug);
    showMoved(slug, null);
  }
}

/** A move still waiting for its toast goes to the server now (the video is being opened). */
export function sendMoveNow(slug: string) {
  waiting.get(slug)?.deferred?.flush();
}

async function send(slug: string, steps: Step[]) {
  const calls = stageCalls(slug, { keepalive: true });
  for (const s of steps) {
    if (s.kind === 'reopen') await calls.reopen();
    // the person said yes to marking it final over open notes (the move's Confirm names them)
    else if (s.kind === 'final') await calls.final({ v: s.v, confirm: true });
    else await calls.verdict({ status: s.kind === 'approve' ? 'approved' : s.kind === 'changes' ? 'changes' : null, v: s.v, note: s.note });
  }
}

/** Sends after whatever this video still has on its way, so the server gets the writes in the order they were made. */
function sendInOrder(slug: string, steps: Step[]): Promise<unknown> {
  const before = sending.get(slug) ?? Promise.resolve();
  const run = before.catch(() => {}).then(() => send(slug, steps));
  sending.set(slug, run);
  run.finally(() => sending.get(slug) === run && sending.delete(slug)).catch(() => {});
  return run;
}

function ask(a: Omit<Ask, 'answer'>): Promise<{ yes: boolean; note?: string }> {
  // one question at a time: one still open (a card's sentence field) is answered "no" first
  currentAsk()?.answer(false);
  return new Promise((resolve) =>
    setAsk({
      ...a,
      answer: (yes, note) => {
        if (currentAsk()?.slug === a.slug) setAsk(null);
        resolve({ yes, note });
      },
    }),
  );
}

/** The card in its lane, for the keyboard and the menu: the move took it out from under the focus. */
function refocus(slug: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.bcard[data-slug="${CSS.escape(slug)}"]`);
    if (!el || el.contains(document.activeElement)) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

export interface MoveDeps {
  qc: QueryClient;
  settle: ReturnType<typeof useSettle>;
  can: (a: Action) => boolean;
  by: string;
}

export interface MoveHow {
  /** The sentence for the agent is asked on the card (the board), else in a small dialog. */
  inPlace?: boolean;
  /** The focus goes back to the card once it has moved (keys, the menu). */
  focus?: boolean;
}

// Reopening leaves a YouTube schedule live: YouTube holds the upload and makes it public at its time (publish/held.ts
// says the same in the player). Written here, not imported: the board's moves would carry publishing's chunk along.
const youtubeHeld = (s: StageInfo): boolean => !!s.published?.posts.some((p) => p.platform === 'youtube' && p.state === 'scheduled');
const heldWords = (): string => t('YouTube holds its scheduled upload itself: it still goes public at its time unless you take it back in YouTube Studio.');

export async function move(d: MoveDeps, shown: VideoSummary, to: LaneId, how: MoveHow): Promise<void> {
  const slug = shown.slug;
  const m = planMove(shown, to, d.can, { by: d.by });
  if (!m) return;
  // Where it lands: from where it stood before a move still waiting, with that move's writes and this one's.
  const landing = (steps: Step[]) => {
    const w = waiting.get(slug);
    const base = w?.base ?? shown;
    const all = compose(base, [...(w?.steps ?? []), ...steps]);
    return { w, base, all, stage: stageAfter(base, all, { by: d.by }) };
  };
  const me: Owner = { stage: landing(m.steps).stage, done: false };
  const before = claim(slug, me);
  setLanded(slug);
  if (how.focus) refocus(slug);
  const callOff = () => {
    release(slug, me, before);
    if (how.focus) refocus(slug);
  };
  const held = m.confirm === 'reopen' && youtubeHeld(shown.stage);
  if (m.confirm && !(await ask({ slug, name: shown.name, move: m, kind: 'confirm', inPlace: !!how.inPlace, held })).yes) return callOff();
  let steps = m.steps;
  if (m.note) {
    const a = await ask({ slug, name: shown.name, move: m, kind: 'note', inPlace: !!how.inPlace });
    if (!a.yes) return callOff();
    steps = steps.map((s) => (s.kind === 'changes' ? { ...s, note: a.note } : s));
  }
  if (me.done) return;
  if (how.focus) refocus(slug);
  // A move still waiting goes along with this one (its toast goes); one sent meanwhile already stands where this
  // move started.
  const { w: prior, base, all, stage } = landing(steps);
  if (prior) {
    prior.deferred?.drop();
    prior.owner.done = true;
    waiting.delete(slug);
  }
  // dragged back to where it stood: nothing to send
  if (!all.length) return release(slug, me);
  me.stage = stage;
  if (owners.get(slug) === me) showMoved(slug, stage);
  const w: Waiting = { base, steps: all, owner: me, deferred: null };
  waiting.set(slug, w);
  w.deferred = later({
    message: t('{name} → {lane}', { name: shown.name, lane: laneLabel(to) }),
    apply: () => {},
    revert: () => {
      if (waiting.get(slug) === w) waiting.delete(slug);
      release(slug, me);
    },
    commit: async () => {
      if (waiting.get(slug) === w) waiting.delete(slug);
      try {
        await sendInOrder(slug, all);
      } finally {
        d.settle.review(slug);
      }
      // the library takes the stage the server is about to confirm, so nothing flickers back in between
      d.qc.setQueryData<LibraryResponse>(keys.library, (data) => data && withEntry(slug, (v) => ({ ...v, stage }))(data));
      release(slug, me);
    },
  });
}

/** The Confirm's words: the question names the video, one sentence says what follows. */
function confirmWords(a: Ask): { title: string; body: string; action: string } {
  const m = a.move;
  const name = a.name;
  if (m.confirm === 'final')
    return {
      title: t('Mark “{name}” V{v} final?', { name, v: m.v }),
      body: m.open
        ? t(
            '{n} required note is still open on this video. Final means this version ships: agents fix nothing more until someone reopens it.|{n} required notes are still open on this video. Final means this version ships: agents fix nothing more until someone reopens it.',
            { n: m.open },
          )
        : t('Final means this version ships: agents fix nothing more until someone reopens it.'),
      action: t('Mark final'),
    };
  if (m.confirm === 'reopen') {
    const f = m.steps.find((s) => s.kind === 'reopen')?.v ?? m.v;
    const has = (k: Step['kind']) => m.steps.some((s) => s.kind === k);
    const said = has('approve')
      ? t('V{f} stops being the version that ships, and V{v} is approved instead.', { f, v: m.v })
      : has('changes')
        ? t('V{f} stops being the version that ships, and changes are requested on it.', { f })
        : m.to === 'needs_you'
          ? t('V{f} stops being the version that ships and goes back to review.', { f })
          : t('V{f} stays approved but stops being the version that ships: agents may work on it again.', { f });
    return { title: t('Reopen “{name}”?', { name }), body: a.held ? `${said} ${heldWords()}` : said, action: t('Reopen') };
  }
  return {
    title: t('Approve “{name}” anyway?', { name }),
    body: t('{n} must-fix note is still open on V{v}.|{n} must-fix notes are still open on V{v}.', { n: m.musts, v: m.v }),
    action: t('Approve V{v}', { v: m.v }),
  };
}

/** A move's questions that aren't asked on a card: its Confirm, and the sentence where the card isn't on the board. */
export function MoveAsks() {
  const { ask: a } = useMoveState();
  if (!a) return null;
  if (a.kind === 'confirm') {
    const w = confirmWords(a);
    return <Confirm title={w.title} action={w.action} onConfirm={() => a.answer(true)} onClose={() => a.answer(false)} body={w.body} />;
  }
  if (a.inPlace) return null;
  return <NoteDialog a={a} />;
}

const NOTE_MAX = 2000;
const noteWords = (a: Ask) => ({
  placeholder: t('What should change? The agent reads this'),
  label: t('What should change on {name}', { name: a.name }),
  send: a.move.steps.some((s) => s.kind === 'reopen') ? t('Reopen and request changes') : t('Request changes'),
});

/** The sentence for the agent, said on the card in its new lane (like the inbox's "Still wrong"): ↵ sends, Esc calls the
 * move off. */
export function MoveNote({ a }: { a: Ask }) {
  const [text, setText] = useState('');
  const w = noteWords(a);
  return (
    <form
      className="bcard-ask"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          a.answer(false);
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) a.answer(true, text.trim());
      }}
      data-testid="move-note"
    >
      <AutoTextarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // one sentence: ↵ sends it (⇧↵ breaks the line)
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (text.trim()) a.answer(true, text.trim());
        }}
        placeholder={w.placeholder}
        aria-label={w.label}
        maxLength={NOTE_MAX}
      />
      <div className="bcard-ask-acts">
        <button type="button" className="btn ghost sm" onClick={() => a.answer(false)}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn sm" disabled={!text.trim()}>
          {w.send}
        </button>
      </div>
    </form>
  );
}

/** The same sentence, asked in a small dialog where the card isn't on the board (the grid, the list). */
function NoteDialog({ a }: { a: Ask }) {
  const [text, setText] = useState('');
  const w = noteWords(a);
  const send = () => text.trim() && a.answer(true, text.trim());
  return (
    <Modal
      title={t('Request changes on “{name}”', { name: a.name })}
      onClose={() => a.answer(false)}
      width={440}
      foot={
        <>
          <button type="button" className="btn ghost" onClick={() => a.answer(false)}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={send} disabled={!text.trim()} data-testid="move-note-send">
            {w.send}
          </button>
        </>
      }
    >
      <input
        className="input"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={w.placeholder}
        aria-label={w.label}
        maxLength={NOTE_MAX}
        data-testid="move-note-dialog"
      />
    </Modal>
  );
}
