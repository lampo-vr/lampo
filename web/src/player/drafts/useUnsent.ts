// What you haven't sent on this video: the notes you saved as drafts (the composer's Save) and what your recordings
// said, counted together, and the ways to send them — Send in the composer and Send all in the panel take everything
// as one batch, a draft's own Send takes just that one (one batch of one). When the video's agent could be started
// from here, sending follows your choice (Settings → Connect an agent): start it once for the batch, ask first (the
// panel's "Not sent yet" asks), or only send. A draft that was sent leaves the holding area with a motion (leaving.ts).
// Lives in the player's own chunk; the section that shows the drafts (Unsent.tsx) is loaded once there is one.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { deleteDraft as removeDraft, saveDraft, sendDrafts, useDrafts } from '../../api/drafts.ts';
import type { NewComment } from '../../api/mutations.ts';
import { keys } from '../../api/queries.ts';
import type { Comment, DraftsSent, Recording } from '../../api/types.ts';
import { t } from '../../i18n/index.ts';
import { toast, toastError } from '../../lib/toast.ts';
import type { WakeChoice } from '../../sessions/Wake.tsx';
import { inPlace, LEAVE_MS, recordingsLeaving, withLeaving } from './leaving.ts';

const heard = (r: Recording) => r.state === 'ready' || r.state === 'failed';
const said = (d: Recording['drafts'][number]) => !!d.text.trim() || d.drawing.length > 0;

/** Drafts from a recording that would be sent: heard, and with something said or drawn (none of `except`). */
export const sendableOf = (recordings: Recording[], except?: ReadonlySet<string>): number =>
  recordings.filter(heard).reduce((n, r) => n + r.drafts.filter((d) => said(d) && !except?.has(d.id)).length, 0);

export type SendWay = 'send' | 'start' | 'ask';

/** Where a draft is on its way out: being sent now, or sent and leaving the holding area. */
export type Going = 'sending' | 'leaving' | null;

export interface Unsent {
  /**
   * Your drafts on this video, oldest first (the ones being deleted are gone already; the ones being sent or just sent
   * stay until they have left).
   */
  drafts: Comment[];
  /** Your recordings waiting to be sent, their drafts being sent or just sent still in place. */
  recordings: Recording[];
  /** Everything a send takes: the drafts and your recordings' drafts. */
  count: number;
  /** The first answer has come (a count of 0 before it means nothing yet). */
  loaded: boolean;
  sending: boolean;
  /** What is being sent is everything (Send all, the composer's Send), not one draft. */
  sendingAll: boolean;
  /** A draft's way out (a note's id or a recording draft's): being sent, leaving, or null while it waits. */
  going: (id: string) => Going;
  /** A send waits for "Send and start" or "Only send": of everything (`one: null`) or of one draft. */
  asking: { one: string | null } | null;
  /** What a send does now, without asking (the agent can't be started here, or the person chose). */
  way: () => SendWay;
  /** Save: keeps the note as a draft. */
  save: (body: NewComment) => Promise<Comment>;
  /**
   * Send / Send all: everything not sent, in one batch — or only `one` draft (a note's id or a recording draft's);
   * `how` answers the question. Null when it asks first.
   */
  send: (how?: 'start' | 'send', one?: string | null) => Promise<DraftsSent | null>;
  cancelAsk: () => void;
  /** An edit not saved yet (a card's text): saved before a send. Returns the unregister. */
  register: (flush: () => Promise<unknown>) => () => void;
  /** Takes a draft off the list while its Undo is up; `back` puts it back. */
  hide: (id: string) => void;
  back: (id: string) => void;
  remove: (id: string) => Promise<void>;
  /** Asks for the drafts and counts again (a reference added or taken off). */
  refresh: () => Promise<unknown>;
}

interface Options {
  slug: string;
  /** People who comment have drafts (never a reader, never a review link). */
  enabled: boolean;
  recordings: Recording[];
  wake: WakeChoice;
  /** The video's agent (its name, for the toast). */
  agent: string | null;
  /** It waits for notes now (wait_for_feedback): the toast says it got them. */
  waiting?: boolean;
  /** The notes went out: the player shows them. */
  onSent?: (out: DraftsSent) => void;
}

const NONE: ReadonlySet<string> = new Set();

export function useUnsent({ slug, enabled, recordings, wake, agent, waiting = false, onSent }: Options): Unsent {
  const qc = useQueryClient();
  // Whether the agent waited when a send began: once it has the notes it is working, no longer waiting.
  const waitingNow = useRef(waiting);
  waitingNow.current = waiting;
  const query = useDrafts(slug, enabled);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NONE);
  // What a send takes is read when it happens (the composer saves, then sends, before this renders again).
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  const recordingsNow = useRef(recordings);
  recordingsNow.current = recordings;
  // Sent, and leaving: the lists as they stood when they went (`before`), so they keep their places while they leave.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE);
  const leavingNow = useRef(leaving);
  leavingNow.current = leaving;
  const [before, setBefore] = useState<{ drafts: Comment[]; recordings: Recording[] }>({ drafts: [], recordings: [] });
  const beforeNow = useRef(before);
  beforeNow.current = before;
  // In flight: the drafts a send took, and whether it took everything.
  const [out, setOut] = useState<{ ids: ReadonlySet<string>; all: boolean } | null>(null);
  // Until its answer the ones it took keep their places (`inPlace`); `out` lasts longer, while the lists are asked again.
  const [holding, setHolding] = useState<ReadonlySet<string>>(NONE);
  const [asking, setAsking] = useState<{ one: string | null } | null>(null);
  const flushers = useRef(new Set<() => Promise<unknown>>());

  const live = useMemo(() => (query.data?.drafts ?? []).filter((d) => !hidden.has(d.id)), [query.data, hidden]);
  const held = useMemo(() => inPlace(leaving, holding), [leaving, holding]);
  const drafts = useMemo(() => withLeaving(before.drafts, live, held), [before.drafts, live, held]);
  const shownRecordings = useMemo(() => recordingsLeaving(before.recordings, recordings, held), [before.recordings, recordings, held]);
  // As shown: one being sent counts until it leaves, however soon the list drops it.
  const count = drafts.filter((d) => !leaving.has(d.id)).length + sendableOf(shownRecordings, leaving);

  const refresh = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.drafts(slug) }),
        qc.invalidateQueries({ queryKey: keys.recordings(slug) }),
        qc.invalidateQueries({ queryKey: keys.unsent }),
      ]),
    [qc, slug],
  );

  const way = (): SendWay => (!wake.possible || wake.pref === 'send' ? 'send' : wake.pref === 'start' ? 'start' : 'ask');
  // A question that no longer applies (the agent was unassigned, or started meanwhile) goes: nothing waits on it.
  const askable = way() === 'ask';
  useEffect(() => {
    if (!askable) setAsking(null);
  }, [askable]);

  const save = async (body: NewComment) => {
    const c = await saveDraft(slug, body);
    qc.setQueryData(keys.drafts(slug), (old: { drafts: Comment[] } | undefined) => ({ drafts: [...(old?.drafts ?? []).filter((d) => d.id !== c.id), c] }));
    qc.invalidateQueries({ queryKey: keys.unsent });
    return c;
  };

  /** The lists as they are on screen this moment (`before`): the ones `keep` names stay where they stood. */
  const hold = (kept: Comment[], keep: ReadonlySet<string>) => {
    const was = beforeNow.current;
    const next = { drafts: withLeaving(was.drafts, kept, keep), recordings: recordingsLeaving(was.recordings, recordingsNow.current, keep) };
    beforeNow.current = next;
    setBefore(next);
  };
  /** The sent ones go with their motion: in place a moment (`before`), then off the list. */
  const leave = (ids: string[], kept: Comment[], taken: ReadonlySet<string>) => {
    if (!ids.length) return;
    const now = leavingNow.current;
    // a draft still leaving from an earlier send stays, and so does one this send took that the list dropped already
    hold(kept, inPlace(now, taken));
    const going = new Set([...now, ...ids]);
    leavingNow.current = going;
    setLeaving(going);
  };
  // They go once their motion has been on screen its whole length: timed from the render that shows them leaving (a
  // busy page may render late; timed from the answer, they could go before they were ever seen leaving).
  useEffect(() => {
    if (!leaving.size) return;
    const gone = leaving;
    const t = setTimeout(
      () =>
        setLeaving((s) => {
          const n = new Set([...s].filter((id) => !gone.has(id)));
          return n.size ? n : NONE;
        }),
      LEAVE_MS,
    );
    return () => clearTimeout(t);
  }, [leaving]);

  const send = async (how?: 'start' | 'send', one?: string | null): Promise<DraftsSent | null> => {
    const w = how ?? way();
    if (w === 'ask') {
      setAsking({ one: one ?? null });
      return null;
    }
    setAsking(null);
    const toWaiting = waitingNow.current;
    const kept0 = qc.getQueryData<{ drafts: Comment[] }>(keys.drafts(slug))?.drafts ?? [];
    // One draft: a note you saved, or one of a recording's (by its id). Everything: the notes on screen and every
    // recording's drafts with something in them.
    const note = one ? kept0.some((d) => d.id === one) : false;
    const spoken = recordingsNow.current.filter(heard).flatMap((r) => r.drafts.filter(said).map((d) => d.id));
    const taking = one
      ? new Set([one])
      : new Set([...kept0.filter((d) => !hiddenNow.current.has(d.id) && !leavingNow.current.has(d.id)).map((d) => d.id), ...spoken]);
    setOut({ ids: taking, all: !one });
    setHolding(taking);
    hold(kept0, inPlace(leavingNow.current, taking));
    try {
      await Promise.all([...flushers.current].map((f) => f()));
      // The drafts on screen: one deleted a moment ago (its Undo still up) stays behind.
      const kept = qc.getQueryData<{ drafts: Comment[] }>(keys.drafts(slug))?.drafts ?? [];
      const ids = one ? (note ? [one] : []) : kept.filter((d) => !hiddenNow.current.has(d.id)).map((d) => d.id);
      const sent = await sendDrafts(slug, { ids, recordings: one ? (note ? false : [one]) : true, start: w === 'start' });
      // what leaves: the notes (one write: all or none), and the recording drafts that went (all, unless some stayed)
      const spokenOut = one ? (note ? [] : sent.notes.length ? [one] : []) : sent.left ? [] : spoken;
      // On screen as leaving before they are off the list: the list's own update reaches the page on a schedule of its
      // own, and seen first it took every card off (and the whole holding area with the last ones) for a moment, to put
      // them back leaving.
      flushSync(() => {
        leave([...ids, ...spokenOut], kept, taking);
        setHolding(NONE);
      });
      qc.setQueryData(keys.drafts(slug), { drafts: kept.filter((d) => !ids.includes(d.id)) });
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: keys.review(slug) }), qc.invalidateQueries({ queryKey: keys.library })]);
      if (sent.error) toast(t('{n} note could not be sent: {error}|{n} notes could not be sent: {error}', { n: sent.left || 1, error: sent.error }), 'error');
      if (sent.notes.length) {
        const n = sent.notes.length;
        toast(
          sent.run && agent
            ? t('Sent {n} note and started {name}|Sent {n} notes and started {name}', { n, name: agent })
            : toWaiting && agent
              ? t('{name} got your note|{name} got your {n} notes', { n, name: agent })
              : n === 1
                ? t('Sent {id} at {timecode}', { id: sent.notes[0].id, timecode: sent.notes[0].timecode })
                : t('Sent {n} notes', { n }),
          'ok',
        );
        onSent?.(sent);
      }
      return sent;
    } catch (e) {
      toastError(e);
      return null;
    } finally {
      setOut(null);
      setHolding(NONE);
    }
  };

  const register = useCallback((flush: () => Promise<unknown>) => {
    flushers.current.add(flush);
    return () => {
      flushers.current.delete(flush);
    };
  }, []);

  const hide = useCallback((id: string) => setHidden((s) => new Set(s).add(id)), []);
  const back = useCallback(
    (id: string) =>
      setHidden((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      }),
    [],
  );
  const remove = useCallback(
    async (id: string) => {
      await removeDraft(slug, id);
      qc.setQueryData(keys.drafts(slug), (old: { drafts: Comment[] } | undefined) => ({ drafts: (old?.drafts ?? []).filter((d) => d.id !== id) }));
      qc.invalidateQueries({ queryKey: keys.unsent });
    },
    [qc, slug],
  );

  return {
    drafts,
    recordings: shownRecordings,
    count,
    loaded: !enabled || query.isFetched,
    sending: !!out,
    sendingAll: !!out?.all,
    going: (id) => (leaving.has(id) ? 'leaving' : out?.ids.has(id) ? 'sending' : null),
    asking: askable ? asking : null,
    way,
    save,
    send,
    cancelAsk: () => setAsking(null),
    register,
    hide,
    back,
    remove,
    refresh,
  };
}
