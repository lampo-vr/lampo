// "Not sent yet" at the top of the notes panel: the notes you saved and what your recordings said, one family of
// drafts — each a hollow keyframe (not set yet) on a card you can still change, with its own Send (⌘↵ on the card) —
// in one quiet holding area under a head that counts them and sends them all as one batch (Send N, ⇧⌘↵). The head
// stays pinned at the top of the notes while you scroll through the drafts, until the area has scrolled past. Nobody
// else sees any of it. Loaded once there is something in it (lib/lazy.ts); useUnsent.ts holds the state and the
// sending.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { formatRange } from '../../../../lib/range.ts';
import { SEVERITIES } from '../../../../lib/time.ts';
import { useAuthStatus } from '../../api/auth.ts';
import { draftFile, editDraft } from '../../api/drafts.ts';
import type { Comment, Shape } from '../../api/types.ts';
import { t } from '../../i18n/index.ts';
import { T } from '../../i18n/T.tsx';
import { severityLabel, tagLabel } from '../../i18n/terms.ts';
import { later, toastError } from '../../lib/toast.ts';
import { removeRef } from '../../refs/api.ts';
import { ownerRefs, type ViewRef } from '../../refs/model.ts';
import { RefStrip } from '../../refs/RefStrip.tsx';
import { RefViewer } from '../../refs/RefViewer.tsx';
import { WakeAsk } from '../../sessions/Wake.tsx';
import { AutoTextarea } from '../../ui/controls.tsx';
import { Spinner } from '../../ui/feedback.tsx';
import { I } from '../../ui/icons.tsx';
import { KeyGlyph, SevMark } from '../../ui/KeyGlyph.tsx';
import { IconButton, Menu, Tip } from '../../ui/primitives.tsx';
import { WordsChange } from '../CommentCard.tsx';
import { clearRangeHint, setRangeHint } from '../rangeHint.ts';
import { VoiceClip } from '../VoiceClip.tsx';
import { SEND_ONE_KEYS, sendOneKey, useLeave } from './card.ts';
import type { Going, Unsent as UnsentState } from './useUnsent.ts';

/** What a draft looked at shows on the picture: its drawing on its frame. */
export type DraftFocus = { frame: number; drawing: Shape[] } | null;

interface UnsentProps {
  slug: string;
  fps: number;
  /** The version on screen (a draft written on another one says which). */
  v: number;
  unsent: UnsentState;
  /** The video's agent and the folder it would start in (the question before a send that could start it). */
  agent: string | null;
  folder: string;
  onSeek: (frame: number) => void;
  onFocus: (d: DraftFocus) => void;
  /** Your recordings' drafts (RecordUI.Drafts), after the notes you saved. */
  recordings?: ReactNode;
  /** A note is being written: the composer's Send ("Send N + 1") is the one primary, so Send all steps down. */
  composing?: boolean;
  /** The video has an agent and notes go to it together from here: Send all names it ("Send 3 to …"). */
  batch?: boolean;
  /** The agent waits for notes now: said under the head (the composer says it while a note is written). */
  waiting?: boolean;
}

/** The key that sends everything not sent, from anywhere in the player (the composer's own ⌘↵ sends it all too). */
const SEND_ALL_KEYS = '⇧⌘↵';

export function Unsent({ slug, fps, v, unsent, agent, folder, onSeek, onFocus, recordings, composing = false, batch = false, waiting = false }: UnsentProps) {
  const { drafts, count, sending, sendingAll, asking } = unsent;
  useEffect(() => () => onFocus(null), [onFocus]);
  // Pinned: the head (and the question a Send asked) stays at the top of the notes while the drafts scroll under it.
  // Pinned = pushed down from its place (the pin marks the area's top): measured on any scroll — the notes list's, or
  // the page's where the page scrolls (stacked under the picture) — so it holds whichever box scrolls.
  const pin = useRef<HTMLSpanElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const a = pin.current?.getBoundingClientRect();
      const b = top.current?.getBoundingClientRect();
      if (a && b) setStuck(b.top - a.top > 0.5);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    later();
    window.addEventListener('scroll', later, { capture: true, passive: true });
    window.addEventListener('resize', later);
    // the area growing or shrinking under a pinned head (a draft sent, a question asked) moves it too
    const ro = new ResizeObserver(later);
    if (pin.current?.parentElement) ro.observe(pin.current.parentElement);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', later, { capture: true });
      window.removeEventListener('resize', later);
    };
  }, []);
  // ⇧⌘↵ sends everything from anywhere in the player but a dialog, a menu or the composer (which sends it all itself).
  const sendAll = useRef(() => {});
  sendAll.current = () => {
    if (!composing && count && !sending && !asking) unsent.send();
  };
  useEffect(() => {
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.defaultPrevented || e.repeat) return;
      if (e.target instanceof Element && e.target.closest('[role=dialog],[role=menu],[role=listbox],.composer')) return;
      e.preventDefault();
      sendAll.current();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
  // Everything sent: the whole holding area leaves with the cards' motion.
  const all = [...drafts.map((d) => d.id), ...unsent.recordings.flatMap((r) => r.drafts.map((d) => d.id))];
  const leaving = all.length > 0 && !asking && all.every((id) => unsent.going(id) === 'leaving');
  const ref = useLeave<HTMLElement>(leaving);
  const asked = asking?.one ? quoteOf(unsent, asking.one) : undefined;
  const toAgent = batch && agent ? agent : null;
  // One line under the head: the agent waiting for these, else who sees them (nobody but you). While a note is written
  // the composer says the agent waits, and this keeps the privacy line.
  const quietLine = waiting && toAgent && !composing ? 'waiting' : 'private';
  return (
    <section
      ref={ref}
      className="unsent"
      aria-labelledby="unsent-title"
      aria-busy={sendingAll}
      data-testid="unsent"
      data-count={count}
      data-going={leaving ? 'leaving' : undefined}
    >
      <span ref={pin} className="unsent-pin" aria-hidden="true" />
      <div ref={top} className="unsent-top" data-stuck={stuck || undefined}>
        <header className="unsent-head">
          <KeyGlyph shape={sendingAll ? 'ease' : 'outline'} className="unsent-kg" />
          {/* to an agent, the release carries the count ("Send 3 to …"): the title doesn't say it twice */}
          <h3 className="unsent-title" id="unsent-title">
            {t('Not sent yet')}
            {!toAgent && (
              <>
                {' · '}
                <span className="unsent-n">{count}</span>
              </>
            )}
          </h3>
          <span className="grow" />
          {/* The composer's Send in the holding area's words: the brand's raised primary, its count and its key. While a
              note is written, the composer's Send ("Send N + 1") sends these too and is the one primary: this steps
              down to a plain button (same place, same words, no key), for sending these without the note. */}
          {/* To an agent, the words name it and its key is in the tooltip: a cap beside the name wouldn't fit a narrow
              panel (in German not even a wide one). */}
          <Tip
            content={
              composing
                ? t('Sends this one without the note you’re writing|Sends these {n} without the note you’re writing', { n: count })
                : count > 1
                  ? t('Sends all {n} notes not sent yet, in one batch', { n: count })
                  : toAgent
                    ? t('Send it now')
                    : null
            }
            shortcut={toAgent && !composing ? SEND_ALL_KEYS : undefined}
          >
            <button
              type="button"
              className={composing ? 'btn sm unsent-send' : 'btn sm primary unsent-send'}
              onClick={() => unsent.send()}
              disabled={sending || !!asking || !count}
              data-keys={composing || toAgent ? undefined : SEND_ALL_KEYS}
              data-testid="drafts-send"
            >
              {sendingAll && <Spinner />}
              {toAgent ? (
                // only the agent's name gives way where the panel is narrow (a hosted agent's is "Claude Code · Olivia …")
                <span className="unsent-send-label">
                  {count > 1 ? (
                    <T k="Send {n} to {name}" values={{ n: count, name: <span className="unsent-agent">{toAgent}</span> }} />
                  ) : (
                    <T k="Send to {name}" values={{ name: <span className="unsent-agent">{toAgent}</span> }} />
                  )}
                </span>
              ) : count > 1 ? (
                t('Send {n}', { n: count })
              ) : (
                t('Send')
              )}
            </button>
          </Tip>
        </header>
        {/* The agent waits: one quiet line says so, in the privacy line's place (while a note is written, the composer
            says it). */}
        {quietLine === 'waiting' && (
          <p className="unsent-note" data-testid="agent-waiting">
            {t('{name} is waiting · gets your notes when you send', { name: agent })}
          </p>
        )}
        {asking && agent && (
          <WakeAsk
            notes
            name={agent}
            folder={folder}
            quote={asked}
            busy={sending}
            onStart={() => unsent.send('start', asking.one)}
            onSend={() => unsent.send('send', asking.one)}
          />
        )}
      </div>
      {quietLine === 'private' && <p className="unsent-note">{t('Only you see these until you send them.')}</p>}
      {drafts.map((d) => (
        <NoteDraft key={d.id} slug={slug} d={d} fps={fps} v={v} unsent={unsent} going={unsent.going(d.id)} onSeek={onSeek} onFocus={onFocus} />
      ))}
      {recordings}
    </section>
  );
}

/** What the question quotes when it asks about one draft: its words (none: nothing to quote). */
function quoteOf(unsent: UnsentState, id: string): string | undefined {
  const d = unsent.drafts.find((x) => x.id === id) ?? unsent.recordings.flatMap((r) => r.drafts).find((x) => x.id === id);
  return d?.text.trim() || undefined;
}

interface NoteDraftProps {
  slug: string;
  d: Comment;
  fps: number;
  v: number;
  unsent: UnsentState;
  /** On its way out: being sent, or sent and leaving. */
  going: Going;
  onSeek: (frame: number) => void;
  onFocus: (d: DraftFocus) => void;
}

/**
 * A note you saved: where it is, its words (changed in place, kept as you type), its marks, severity and tags — and
 * its own Send (⌘↵ while the focus is in it), which sends just this one, a batch of one.
 */
function NoteDraft({ slug, d, fps, v, unsent, going, onSeek, onFocus }: NoteDraftProps) {
  const { sending } = unsent;
  const me = useAuthStatus().data?.user ?? null;
  const [text, setText] = useState(d.text);
  const [viewing, setViewing] = useState<ViewRef | null>(null);
  // Typing is saved a moment after it stops (and before any send); the server's copy wins until you type.
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!dirty.current) setText(d.text);
  }, [d.text]);
  const { register } = unsent;
  useEffect(() => {
    const flush = async () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!dirty.current) return;
      dirty.current = false;
      await editDraft(slug, d.id, { text: latest.current });
    };
    const off = register(flush);
    return () => {
      off();
      flush().catch(() => {});
    };
  }, [register, slug, d.id]);
  const type = (next: string) => {
    setText(next);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      dirty.current = false;
      editDraft(slug, d.id, { text: latest.current }).catch(toastError);
    }, 700);
  };
  const [severity, setSeverity] = useState(d.severity);
  useEffect(() => setSeverity(d.severity), [d.severity]);
  const pickSeverity = (s: typeof severity) => {
    setSeverity(s);
    editDraft(slug, d.id, { severity: s }).catch((e) => {
      setSeverity(d.severity);
      toastError(e);
    });
  };

  const where = d.scope === 'video' ? t('Whole video') : d.range ? formatRange(d.range, fps) : d.timecode;
  const look = () => {
    if (d.scope === 'video') return;
    onFocus({ frame: d.frame, drawing: d.drawing });
    setRangeHint({ ghost: d.range ?? { in: d.frame, out: d.frame } });
  };
  const away = () => clearRangeHint();
  const remove = () =>
    later({
      message: t('Deleted the draft'),
      apply: () => unsent.hide(d.id),
      revert: () => unsent.back(d.id),
      commit: async () => {
        await unsent.remove(d.id);
        unsent.back(d.id);
      },
    });
  const refs = ownerRefs(slug, d.refs, me).map((r) => ({ ...r, mine: true }));
  const feedback = (d.kind ?? 'feedback') === 'feedback';
  // a note with nothing left in it (its words taken out, no drawing, voice, reference or words change) sends nothing
  const empty = !text.trim() && !d.drawing.length && !d.voice && !d.refs?.length && !d.text_edit;
  const send = () => {
    if (sending || unsent.asking || going || empty) return false;
    unsent.send(undefined, d.id);
    return true;
  };
  const ref = useLeave<HTMLElement>(going === 'leaving');
  return (
    <article
      ref={ref}
      className="draft note-draft"
      data-testid="note-draft"
      data-frame={d.frame}
      data-id={d.id}
      data-going={going ?? undefined}
      aria-busy={going === 'sending'}
      onPointerEnter={look}
      onPointerLeave={away}
      onFocus={look}
      onBlur={away}
      onKeyDown={(e) => sendOneKey(e, send, ref.current)}
    >
      <div className="draft-head">
        {/* hollow while it waits, the hourglass while it goes, set (solid) as it leaves */}
        <KeyGlyph shape={going === 'leaving' ? 'diamond' : going === 'sending' ? 'ease' : 'outline'} className="draft-kg" />
        {d.scope === 'video' ? (
          <span className="c-tc overall draft-where">{where}</span>
        ) : (
          <Tip content={t('Go to this moment')}>
            <button
              type="button"
              className={`c-tc draft-where${d.range ? ' range' : ''}`}
              onClick={() => {
                onSeek(d.frame);
                look();
              }}
            >
              {where}
            </button>
          </Tip>
        )}
        {d.v !== v && <span className="note-tag mono">V{d.v}</span>}
        {d.drawing.length > 0 && (
          <span className="draft-mark">
            <I name="pen" size={12} /> {t('{n} mark|{n} marks', { n: d.drawing.length })}
          </span>
        )}
      </div>
      {d.text_edit && <WordsChange edit={d.text_edit} />}
      <AutoTextarea
        className="draft-text"
        value={text}
        placeholder={d.drawing.length ? t('What should change here? (the drawing says where)') : t('What should change here?')}
        onChange={(e) => type(e.target.value)}
        aria-label={t('Note at {where}', { where })}
        disabled={!!going}
        // another draft on its way: hold still a moment (an edit then would race the send), keeping the focus
        readOnly={sending}
      />
      {d.voice?.file && <VoiceClip src={draftFile(slug, d.id, d.voice.file)} />}
      <RefStrip
        refs={refs}
        onOpen={setViewing}
        editing
        onRemove={(r) =>
          removeRef({ kind: 'draft', slug, comment: d.id }, r.id)
            .then(() => unsent.refresh())
            .catch(toastError)
        }
      />
      {viewing && <RefViewer r={viewing} onClose={() => setViewing(null)} />}
      <div className="draft-foot">
        {feedback && (
          <Menu
            align="start"
            trigger={
              <button type="button" className="btn sm ghost sev-pick" aria-label={t('Severity: {severity}', { severity: severityLabel(severity) })}>
                <SevMark s={severity} />
                <span className="sev-word">{severityLabel(severity)}</span>
                <I name="down" size={12} className="sev-chev" />
              </button>
            }
            items={SEVERITIES.map((s) => ({
              label: severityLabel(s),
              mark: <SevMark s={s} />,
              checked: severity === s,
              onClick: () => pickSeverity(s),
            }))}
          />
        )}
        {d.tags.map((tag) => (
          <span key={tag} className="chip draft-tag">
            <I name={tag === 'love-it' ? 'heart' : 'tag'} size={11} />
            {tagLabel(tag)}
          </span>
        ))}
        {/* the card's way out, where the composer has its own: delete, then Send at the foot's end */}
        <span className="grow" />
        <IconButton className="btn sm ghost icon-only" label={t('Delete this draft')} icon="trash" size={14} onClick={remove} disabled={sending || !!going} />
        <IconButton
          className="btn sm ghost icon-only draft-send"
          label={t('Send this note')}
          tip={t('Send this note now, without the others')}
          shortcut={SEND_ONE_KEYS}
          icon="send"
          size={14}
          onClick={send}
          disabled={sending || !!unsent.asking || !!going || empty}
          data-testid="draft-send"
        />
      </div>
    </article>
  );
}
