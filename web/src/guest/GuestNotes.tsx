// The side of a review a visitor writes in: the composer (its drawing tools are under the picture on a phone, on it
// elsewhere: DrawBar, GuestPlayer.tsx), the name they write under (asked when it is first needed), and the notes the
// link shows — rows and cards as the app shows them — with replies and the "fixed, please check" question.

import { forwardRef, useId, useRef, useState } from 'react';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import { timecode } from '../../../lib/time.ts';
import type { FrameRange, GuestNote, GuestPerms } from '../api/types.ts';
import { locale, perLang, t } from '../i18n/index.ts';
import { cardClick } from '../lib/a11y.ts';
import { ago } from '../lib/format.ts';
import { useTouch } from '../lib/media.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { DrawTool } from '../player/DrawBar.tsx';
import type { FrameStore } from '../player/frameStore.ts';
import { firstLine } from '../player/noteRows.ts';
import { RangeControl, RangeExtend, rangeItems, useFrameOnScreen } from '../player/RangeControl.tsx';
import { litHandlers } from '../player/rangeHint.ts';
import { guestRefs, splitRefs, type ViewRef } from '../refs/model.ts';
import { RefStrip } from '../refs/RefStrip.tsx';
import { AttachMenu, LinkField, PendingList, type PendingRefs } from '../refs/RefTools.tsx';
import { RefViewer } from '../refs/RefViewer.tsx';
import { Badge } from '../ui/Badge.tsx';
import { AutoTextarea, Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { SevMark } from '../ui/KeyGlyph.tsx';
import { IconButton, Menu, Modal } from '../ui/primitives.tsx';

/** The client's drawing tools, on the picture while paused (GuestPlayer.tsx → DrawBar); picking one again puts it away. */
export const GUEST_TOOLS = perLang((): DrawTool[] => [
  { id: 'box', icon: 'box', label: t('client::Box') },
  { id: 'arrow', icon: 'arrow', label: t('client::Arrow') },
  { id: 'freehand', icon: 'pen', label: t('client::Freehand') },
]);

interface ComposerProps {
  frame: number;
  fps: number;
  /** Frames in the render (a range stays inside it). */
  frames: number;
  /** The stretch the note is about, or null for one frame. */
  range: FrameRange | null;
  onRange: (r: FrameRange | null) => void;
  /** The frame on screen, live while it plays: what the range's actions name. */
  live?: FrameStore;
  /** Where "just this frame" takes the player. */
  onSeek?: (frame: number) => void;
  shapes: number;
  text: string;
  setText: (t: string) => void;
  idea: boolean;
  setIdea: (x: boolean) => void;
  /** Sends the note; `name` when it was just asked here. */
  onSend: (name?: string) => void;
  busy: boolean;
  /** Images, clips and links that go with the note. */
  pending: PendingRefs;
  /** No name yet and the visitor sent a note: the name is asked here, in the composer, and the note goes with it. */
  askName?: boolean;
  /** Who shared the link (the name ask says they read the notes). */
  sharer?: string;
}

export const GuestComposer = forwardRef<HTMLTextAreaElement, ComposerProps>(function GuestComposer(
  { frame, fps, frames, range, onRange, live, onSeek, shapes, text, setText, idea, setIdea, onSend, busy, pending, askName, sharer },
  ref,
) {
  const [linking, setLinking] = useState(false);
  // the section's menu names the frame on screen, live while it is open
  const [rangeOpen, setRangeOpen] = useState(false);
  const now = useFrameOnScreen(frame, live, rangeOpen);
  const touch = useTouch();
  const empty = !text.trim() && !shapes && !pending.refs.length;
  const [who, setWho] = useState('');
  const [missing, setMissing] = useState(false);
  const whoRef = useRef<HTMLInputElement>(null);
  const go = () => {
    if (busy || empty) return;
    if (!askName) return onSend();
    if (!who.trim()) {
      setMissing(true);
      whoRef.current?.focus();
      return;
    }
    onSend(who);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ sends from anywhere inside the composer
    <div
      className={`composer g-composer ${pending.dragging ? 'ref-drop' : ''}`}
      {...pending.drop}
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        go();
      }}
    >
      <div className="composer-head">
        {range ? (
          // a section: one chip, its menu moves its ends from the frame on screen (I / O) or takes the end off
          <Menu
            align="start"
            onOpenChange={setRangeOpen}
            trigger={
              <button type="button" className="composer-where" data-testid="composer-where" aria-label={t('client::Change the section')} {...litHandlers}>
                <RangeControl frame={frame} fps={fps} range={range} />
                <I name="down" size={12} className="composer-where-chev" />
              </button>
            }
            items={rangeItems({ now, range, fps, frames, onRange, onSeek, touch, client: true })}
          />
        ) : (
          <>
            <span {...litHandlers}>
              <RangeControl frame={frame} fps={fps} range={null} />
            </span>
            <RangeExtend frame={frame} live={live} fps={fps} frames={frames} onRange={onRange} client />
          </>
        )}
      </div>
      <div className="composer-write">
        <AutoTextarea
          ref={ref}
          rows={2}
          className="composer-text"
          aria-label={idea ? t('client::Your idea for this frame') : t('client::Your note for this frame')}
          placeholder={
            idea
              ? t('client::What could make this even better?')
              : range
                ? t('client::What should change in this section?')
                : t('client::What should change on this frame?')
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {shapes > 0 && (
        <div className="composer-picked">
          <span className="composer-hint">{t('client::{n} mark|{n} marks', { n: shapes })}</span>
        </div>
      )}
      {linking && <LinkField pending={pending} client onClose={() => setLinking(false)} />}
      <PendingList pending={pending} client disabled={busy} />
      {askName && (
        <NameField
          ref={whoRef}
          autoFocus
          value={who}
          onChange={(v) => {
            setWho(v);
            setMissing(false);
          }}
          missing={missing}
          sharer={sharer}
          onEnter={go}
        />
      )}
      <div className="composer-foot">
        <Menu
          align="start"
          trigger={
            <button
              type="button"
              className="btn sm ghost sev-pick"
              aria-label={t('client::Kind of note: {kind}', { kind: idea ? t('client::Idea') : t('client::Change') })}
            >
              <SevMark s={idea ? 'idea' : 'should'} />
              <span className="sev-word">{idea ? t('client::Idea') : t('client::Change')}</span>
              <I name="down" size={12} className="sev-chev" />
            </button>
          }
          items={[
            { label: t('client::Change'), mark: <SevMark s="should" />, checked: !idea, onClick: () => setIdea(false) },
            { label: t('client::Idea'), mark: <SevMark s="idea" />, checked: idea, onClick: () => setIdea(true) },
          ]}
        />
        <AttachMenu pending={pending} client disabled={busy} onLink={() => setLinking(true)} />
        <div className="composer-send">
          <button type="button" className="btn primary sm" onClick={go} disabled={busy || empty} data-keys="⌘↵">
            {busy && <Spinner />}
            {t('client::Add note')}
          </button>
        </div>
      </div>
    </div>
  );
});

/** Who reads what a visitor writes, said wherever the name is asked (A12-D4): the team, and anyone with this link or
 * another that shows all client notes. */
const nameWhy = (sharer?: string) =>
  sharer
    ? t(
        'client::So {name} knows who wrote each note. The team sees your notes, and so does anyone with this link or another that shows the notes from all links.',
        {
          name: sharer,
        },
      )
    : t(
        'client::So the team knows who wrote each note. They see your notes, and so does anyone with this link or another that shows the notes from all links.',
      );

interface NameFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** Sent without one: said under the field. */
  missing: boolean;
  sharer?: string;
  /** ↵ in the field: what the button next to it does (send the note, save the name). */
  onEnter: () => void;
  /** Inside a dialog that asks the question in its title. */
  bare?: boolean;
  autoFocus?: boolean;
}

/** The name a visitor writes under, in one column on one edge: the question, who reads it and why, the field. */
const NameField = forwardRef<HTMLInputElement, NameFieldProps>(function NameField({ value, onChange, missing, sharer, onEnter, bare, autoFocus }, ref) {
  const id = useId();
  return (
    <div className="g-name" data-testid="g-name">
      {!bare && (
        <label className="g-name-q" htmlFor={id}>
          {t('client::What’s your name?')}
        </label>
      )}
      <p className="g-name-why">{nameWhy(sharer)}</p>
      <input
        ref={ref}
        id={id}
        className="input"
        placeholder={t('client::Your name')}
        aria-label={t('client::Your name')}
        aria-invalid={missing}
        value={value}
        maxLength={40}
        autoComplete="name"
        enterKeyHint={bare ? 'done' : 'send'}
        // asked because the visitor just acted (a note sent, Approve): they type here next
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onEnter();
        }}
      />
      {missing && (
        <p className="g-name-hint" role="alert">
          {t('client::Your name first, so your notes aren’t anonymous.')}
        </p>
      )}
    </div>
  );
});

/** The name, asked by an action that needs one (Approve, a reply, a check) or changed from the notes' head: a small
 * dialog, a sheet on phones. The first note asks in the composer instead, where the visitor is already typing. */
export function NameDialog({ name, sharer, onSave, onClose }: { name: string; sharer?: string; onSave: (n: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(name);
  const [missing, setMissing] = useState(false);
  const save = () => {
    if (!draft.trim()) return setMissing(true);
    onSave(draft);
  };
  return (
    <Modal
      title={name ? t('client::Your name') : t('client::What’s your name?')}
      onClose={onClose}
      width={420}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            {t('client::Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={save} data-testid="g-name-save">
            {t('client::Continue')}
          </button>
        </>
      }
    >
      <NameField
        bare
        autoFocus
        value={draft}
        onChange={(v) => {
          setDraft(v);
          setMissing(false);
        }}
        missing={missing}
        sharer={sharer}
        onEnter={save}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------- a note, as the app shows one
// The same anatomy as the app's (player/CommentCard.tsx, notes.css): at rest a row — the timecode, the kind as a
// keyframe glyph, the first line, where it stands when that is news, the picture under the pointer — under a group
// header where someone else wrote it or wrote it at another sitting; opened (the selected note, or one that waits for
// the visitor's check) the card: who and when, Reply; the timecode, its kind, its version and where it stands; the words
// and the marked frame; the thread (replies as messages, status changes as one line each); the decision on a fix (Looks
// right · Still wrong, together); Reply… In the visitors' words; nothing a visitor can't do (editing, won't fix, ids).

/** What a status change in the thread says happened, in the visitors' words. */
function activity(status: string, fixedIn: number | null): { icon: IconName; verb: string; tone: string } {
  if (status === 'fixed') return { icon: 'fixed', verb: fixedIn ? t('client::fixed it in V{v}', { v: fixedIn }) : t('client::marked it fixed'), tone: 'ok' };
  if (status === 'verified') return { icon: 'verified', verb: t('client::checked the fix'), tone: 'ok' };
  if (status === 'wontfix') return { icon: 'wontfix', verb: t('client::won’t change it'), tone: 'muted' };
  return { icon: 'reopen', verb: t('client::reopened it'), tone: 'should' };
}

/** Who wrote a reply, as the link names them: an agent is "the editor" (the server's word, said in the page's language). */
const shownBy = (by: string) => (by === 'editor' ? t('client::Editor') : by);

function When({ at }: { at: string }) {
  return (
    <time className="when" dateTime={at} title={new Date(at).toLocaleString(locale())}>
      {ago(at)}
    </time>
  );
}

interface NoteProps {
  c: GuestNote;
  /** The version on screen. */
  v: number;
  /** The video's frame rate (timecodes, a section's length). */
  fps: number;
  /** A range note: plays its stretch. */
  onPlayRange?: () => void;
  /** The frame size of the note's version, which its marked frame has. */
  shotSize?: { width: number; height: number };
  selected: boolean;
  /** The note the playhead is at. */
  here?: boolean;
  /** The row starts a group: who wrote it and when, said above it (player/noteRows.ts groupStarts). */
  groupHead?: boolean;
  perms: GuestPerms;
  onSelect: () => void;
  onReply: (text: string) => Promise<unknown>;
  onCheck: (verdict: 'confirm' | 'reopen', text?: string) => Promise<unknown>;
  /** Removes a reference the visitor added through this link. */
  onRemoveRef: (id: string) => Promise<unknown>;
}

export function GuestNoteCard({
  c,
  v,
  fps,
  shotSize,
  selected,
  here = false,
  groupHead = false,
  perms,
  onSelect,
  onReply,
  onCheck,
  onRemoveRef,
  onPlayRange,
}: NoteProps) {
  const [mode, setMode] = useState<'reply' | 'reopen' | null>(null);
  const [viewing, setViewing] = useState<ViewRef | null>(null);
  const [peek, setPeek] = useState(false);
  const { own, byReply } = splitRefs(guestRefs(c.refs), c.replies);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'ok');
      setMode(null);
      setText('');
    } catch (e) {
      toastError(e);
    }
    setBusy(false);
  };
  const closed = c.status === 'verified' || c.status === 'wontfix';
  const state = closed ? 'closed' : c.status === 'fixed' ? 'fixed' : 'open';
  // a fix waiting for the visitor's check is open as its card: the decision is one tap, never behind the row
  const checking = perms.comment && c.status === 'fixed';
  const opened = selected || checking || !!mode || !!text.trim();
  const tc = c.scope === 'video' ? t('client::Whole video') : timecode(c.frameHere, fps);
  const kind = c.idea ? t('client::Idea') : t('client::Change');
  const status =
    c.status === 'fixed'
      ? c.fixed_in_v
        ? t('client::Fixed · V{v}', { v: c.fixed_in_v })
        : t('client::Fixed')
      : c.status === 'verified'
        ? t('client::Checked')
        : c.status === 'wontfix'
          ? t('client::Won’t change')
          : null;
  const author = `guest:${c.author}`;
  const group = groupHead && (
    <div className="note-group">
      <Avatar name={author} size={20} />
      <b className="ellipsis">{c.author}</b>
      <span className="note-group-dot" aria-hidden="true">
        ·
      </span>
      <When at={c.created} />
    </div>
  );

  if (!opened) {
    const said = c.replies.filter((r) => !r.status).length;
    const ghost = c.rangeHere && c.scope !== 'video' ? c.rangeHere : null;
    return (
      <article
        className={`note note-row g-note ${state} ${here ? 'here' : ''}`}
        data-note={c.id}
        data-kind="feedback"
        data-severity={c.idea ? 'idea' : 'should'}
      >
        {group}
        <button
          type="button"
          className="nr"
          onClick={onSelect}
          onPointerEnter={() => setPeek(true)}
          onFocus={() => setPeek(true)}
          aria-expanded={false}
          aria-label={t('client::{kind} at {timecode}: {text}', { kind, timecode: tc, text: firstLine(c.text) || t('client::(marked area)') })}
          data-testid="note-row"
        >
          <span className={`nr-tc ${c.scope === 'video' ? 'overall' : ''}`}>{tc}</span>
          <span className="nr-kg">
            <SevMark s={c.idea ? 'idea' : 'should'} size={10} />
          </span>
          <span className="nr-text">
            {c.text_edit ? (
              <span className="c-edit">
                <del className="c-edit-from">{c.text_edit.from}</del> → <ins className="c-edit-to">{c.text_edit.to}</ins>
              </span>
            ) : c.text ? (
              firstLine(c.text)
            ) : (
              <span className="muted">{t('client::(marked area)')}</span>
            )}
          </span>
          {(status || said > 0 || c.v !== v || !!ghost) && (
            <span className="nr-meta">
              {ghost && <span className="nr-len">{formatSeconds(rangeSeconds(ghost, fps))}</span>}
              {c.v !== v && <span className="nr-v">V{c.v}</span>}
              {said > 0 && (
                <span className="nr-said" title={t('client::{n} reply|{n} replies', { n: said })}>
                  <I name="reply" size={12} />
                  {said}
                </span>
              )}
              {status && <span className={`nr-state nr-${c.status}`}>{status}</span>}
            </span>
          )}
          {peek && c.marked && <img className="nr-thumb" src={c.marked} alt="" decoding="async" />}
        </button>
      </article>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the card goes to its frame; the timecode is the keyboard's way there
    <article
      className={`comment note g-note ${state} ${selected ? 'active' : ''} ${here ? 'here' : ''}`}
      data-note={c.id}
      data-kind="feedback"
      data-severity={c.idea ? 'idea' : 'should'}
      onClick={cardClick(onSelect, '.note-tools, .note-editor, .g-check, .c-thumb, .c-actions, .ref-strip, .note-range .icon-only, button, a, audio')}
    >
      {group}
      <header className="note-head">
        <Avatar name={author} size={24} />
        <div className="note-who">
          <b className="ellipsis">{c.author}</b>
          <When at={c.created} />
        </div>
        {perms.comment && (
          <div className="note-tools">
            <IconButton
              className="btn sm ghost icon-only"
              label={t('client::Reply')}
              icon="reply"
              size={14}
              onClick={() => setMode('reply')}
              data-testid="g-reply"
            />
          </div>
        )}
      </header>

      <div className="note-meta">
        {c.scope === 'video' ? (
          <span className="c-tc overall">{tc}</span>
        ) : c.rangeHere ? (
          <span className="note-range">
            <button
              type="button"
              className="c-tc range"
              onClick={onSelect}
              aria-label={t('client::Go to {timecode}', { timecode: tc })}
              data-testid="note-range"
            >
              {rangeTimecodes(c.rangeHere, fps)}
              <span className="note-range-len">{formatSeconds(rangeSeconds(c.rangeHere, fps))}</span>
            </button>
            {onPlayRange && (
              <IconButton className="btn sm ghost icon-only" label={t('client::Play this stretch')} icon="play" size={12} onClick={onPlayRange} />
            )}
          </span>
        ) : (
          <button type="button" className="c-tc" onClick={onSelect} aria-label={t('client::Go to {timecode}', { timecode: tc })}>
            {tc}
          </button>
        )}
        <Badge size="sm" tone={c.idea ? 'idea' : 'should'}>
          {kind}
        </Badge>
        {c.v !== v && <span className="note-tag mono">V{c.v}</span>}
        {status && (
          <Badge size="sm" tone={closed && c.status === 'wontfix' ? 'neutral' : 'ok'} className="note-state">
            {status}
          </Badge>
        )}
      </div>

      {c.text_edit && (
        <p className="c-edit">
          <del className="c-edit-from">{c.text_edit.from}</del>
          <span className="c-edit-arrow" aria-hidden="true">
            →
          </span>
          <ins className="c-edit-to">{c.text_edit.to}</ins>
        </p>
      )}
      <div className="note-body">
        {c.text ? <p className="c-text">{c.text}</p> : c.text_edit ? null : <p className="c-text muted">{t('client::(marked area)')}</p>}
        {/* its frame's size keeps its room before it arrives: the decision and Reply… under it don't jump when it does */}
        {c.marked && <img className="c-thumb" src={c.marked} alt={t('client::Marked frame')} width={shotSize?.width} height={shotSize?.height} />}
      </div>
      <RefStrip refs={own} onOpen={setViewing} client editing={perms.comment} onRemove={(r) => onRemoveRef(r.id)} />
      {viewing && <RefViewer r={viewing} client onClose={() => setViewing(null)} />}

      {c.replies.length > 0 && (
        <div className="thread">
          {c.replies.map((r, i) => {
            const by = shownBy(r.by);
            if (r.status) {
              // the fix's version goes with the last "fixed" in the thread (the one the note's state says)
              const last = c.replies.findLastIndex((x) => x.status === 'fixed') === i;
              const act = activity(r.status, last ? c.fixed_in_v : null);
              return (
                <div key={`${r.by}:${r.at}`} className={`act act-${act.tone}`} data-testid="reply">
                  <div className="act-line">
                    <I name={act.icon} size={13} />
                    <span>
                      <b>{by}</b> {act.verb}
                    </span>
                    <When at={r.at} />
                  </div>
                  {r.text && <p className="act-text">{r.text}</p>}
                  <RefStrip refs={byReply(r.refs)} onOpen={setViewing} client />
                </div>
              );
            }
            return (
              <div key={`${r.by}:${r.at}`} className="msg" data-testid="reply">
                <Avatar name={by} size={20} />
                <div className="msg-body">
                  <div className="msg-who">
                    <b>{by}</b>
                    <When at={r.at} />
                  </div>
                  <p>{r.text}</p>
                  <RefStrip refs={byReply(r.refs)} onOpen={setViewing} client />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {checking && mode !== 'reopen' && (
        // the visitor's one decision on a fix: the question on its line, both answers together under it
        <div className="g-check" data-testid="g-check">
          <p className="g-check-q">
            {c.fixed_in_v ? t('client::Fixed in V{v}. Does it look right now?', { v: c.fixed_in_v }) : t('client::Fixed. Does it look right now?')}
          </p>
          <div className="verify-actions check-decision">
            <button type="button" className="btn sm ok" disabled={busy} onClick={() => run(() => onCheck('confirm'), t('client::Thanks, marked as done'))}>
              <I name="check" size={14} /> {t('client::Looks right')}
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => setMode('reopen')}>
              <I name="x" size={13} /> {t('client::Still wrong')}
            </button>
          </div>
        </div>
      )}
      {perms.comment && mode ? (
        <div className="note-editor">
          <AutoTextarea
            autoFocus
            aria-label={mode === 'reopen' ? t('client::What is still not right') : t('client::Your reply')}
            placeholder={mode === 'reopen' ? t('client::What is still not right? (optional)') : t('client::Your reply…')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onSubmit={() =>
              mode === 'reopen'
                ? run(() => onCheck('reopen', text), t('client::Sent back to the editor'))
                : text.trim() && run(() => onReply(text), t('client::Reply sent'))
            }
            onCancel={() => setMode(null)}
          />
          <div className="note-editor-foot">
            <button type="button" className="btn sm ghost" onClick={() => setMode(null)}>
              {t('client::Cancel')}
            </button>
            {mode === 'reopen' ? (
              <button
                type="button"
                className="btn sm primary"
                disabled={busy}
                onClick={() => run(() => onCheck('reopen', text), t('client::Sent back to the editor'))}
              >
                {busy && <Spinner />} {t('client::Reopen')}
              </button>
            ) : (
              <button
                type="button"
                className="btn sm primary"
                disabled={busy || !text.trim()}
                onClick={() => run(() => onReply(text), t('client::Reply sent'))}
              >
                {busy && <Spinner />} {t('client::Reply')}
              </button>
            )}
          </div>
        </div>
      ) : (
        perms.comment &&
        selected && (
          <div className="c-actions">
            <button type="button" className="reply-stub" onClick={() => setMode('reply')}>
              {t('client::Reply…')}
            </button>
          </div>
        )
      )}
    </article>
  );
}
