// One note in the sidebar. At rest a row — its timecode, its severity as a keyframe glyph, the first line, and a picture
// only under the pointer — under a group header when someone else wrote it, or in another sitting (noteRows.ts). The
// selected note opens in place into the card: who wrote it and when, what it is, the thread under it (replies as
// messages, status changes as activity lines) and the actions that move it through open → fixed → verified. The same
// <article> either way, so what holds it (a suite, the focus) keeps holding it as it opens.

import { useQueryClient } from '@tanstack/react-query';
import { memo, type ReactNode, useEffect, useId, useState } from 'react';
import { optionsSeen } from '../../../lib/options.ts';
import { changeableReply, isOwner } from '../../../lib/ownership.ts';
import { formatSeconds, rangeSeconds, rangeTimecodes } from '../../../lib/range.ts';
import { clipBounds } from '../../../lib/recording.ts';
import { isSampleAgent } from '../../../lib/sampleLoop.ts';
import { isAgent, isClient, type NoteLook, noteKind } from '../../../lib/time.ts';
import { useAuthStatus, useCan, usePeople } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { type CommentPatch, useCommentActions } from '../api/mutations.ts';
import { keys } from '../api/queries.ts';
import type { FixPreview, OptionGroup, PlacedComment, Reply, RunPlanItem, TextEdit } from '../api/types.ts';
import { locale, perLang, t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { severityLabel, tagLabel } from '../i18n/terms.ts';
import { cardClick } from '../lib/a11y.ts';
import { ago } from '../lib/format.ts';
import { hideNote, hideReply, replyKey, showNote, showReply, useHiddenReplies } from '../lib/hidden.ts';
import { copyText, later, toast, toastError } from '../lib/toast.ts';
import { OptionsAsk, Picked } from '../options/OptionsAsk.tsx';
import { captionRef, removeRef, sendRef } from '../refs/api.ts';
import { GOTO_FRAME, type GotoFrame, ownerRefs, splitRefs, type ViewRef } from '../refs/model.ts';
import { RefStrip } from '../refs/RefStrip.tsx';
import { RefTools, usePendingRefs } from '../refs/RefTools.tsx';
import { RefViewer } from '../refs/RefViewer.tsx';
import { planSaid } from '../sessions/runWords.ts';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { Choices } from '../ui/Choices.tsx';
import { AutoTextarea, Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { KIND_SHAPE } from '../ui/glyphs.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph, SevMark } from '../ui/KeyGlyph.tsx';
import { ContextMenu, IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { TimecodeText } from '../ui/TimecodeText.tsx';
import { SayButton, withSaid } from '../ui/VoiceButton.tsx';
import { CheckDecision, ClientReads } from './CheckDecision.tsx';
import { checkVerdict, waitsForCheck } from './fixCheck.ts';
import { firstLine } from './noteRows.ts';
import { previewSource, previewState, previewUrl } from './previews.ts';
import { clearRangeHint, setRangeHint } from './rangeHint.ts';
import { VoiceClip } from './VoiceClip.tsx';
import '../styles/range.css';

/** "guest:Mia" → "Mia", "agent:launch-edit" → "launch-edit". */
/** The sample's agent shows as the agent the person picked in the setup (the player says which while the sample is open). */
let sampleAgentAs: string | null = null;
export const showSampleAgentAs = (name: string | null) => {
  sampleAgentAs = name;
};
export const displayName = (by: string) => (sampleAgentAs && isSampleAgent(by) ? sampleAgentAs : by.replace(/^(guest|agent):/, ''));
const roleOf = (by: string) => (isAgent(by) ? 'agent' : by.startsWith('guest:') ? 'client' : null);

// What a note is, as one calm label: feedback shows its severity, other notes their kind.
const KIND = perLang(
  (): Record<Exclude<NoteLook, 'feedback'>, [string, Tone]> => ({
    question: [t('Question'), 'claude'],
    info: [t('Info'), 'neutral'],
    agent: [t('Agent note'), 'claude'],
  }),
);

// A reply that changes the status is an activity line; the words for it (questions are "answered", not "verified").
function activity(r: Reply, asks: boolean): { icon: IconName; verb: string; tone: string } | null {
  if (!r.status) return null;
  if (r.status === 'fixed')
    return {
      icon: 'fixed',
      verb: r.preview ? t('fixed it in the project') : r.fixed_in_v ? t('fixed it in V{fixed_in_v}', { fixed_in_v: r.fixed_in_v }) : t('marked it fixed'),
      tone: 'ok',
    };
  if (r.status === 'verified')
    return asks
      ? { icon: 'reply', verb: 'answered', tone: 'claude' }
      : { icon: 'verified', verb: r.preview ? t('checked it on the preview') : t('checked the fix'), tone: 'ok' };
  if (r.status === 'wontfix') return { icon: 'wontfix', verb: t("won't fix it"), tone: 'muted' };
  return { icon: 'reopen', verb: t('reopened it'), tone: 'should' };
}

function When({ at }: { at: string }) {
  return (
    <time className="when" dateTime={at} title={new Date(at).toLocaleString(locale())}>
      {ago(at)}
    </time>
  );
}

/** A fix preview in the thread: the still (or clip) and what became of it. */
function PreviewChip({ p, slug, onLightbox }: { p: FixPreview; slug: string; onLightbox: (src: string) => void }) {
  const url = previewUrl(slug, p);
  const state = previewState(p);
  const source = previewSource(p);
  return (
    <div className="pv" data-testid="fix-preview">
      {p.kind === 'still' ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: enlarging is a mouse shortcut; verify mode shows it large too
        <img className="pv-thumb" src={url} alt={t('Fix preview')} loading="lazy" onClick={() => onLightbox(url)} />
      ) : (
        <video className="pv-thumb" src={url} muted playsInline preload="metadata" />
      )}
      <span className="pv-meta">
        <span>
          {p.kind === 'clip' ? t('Clip of the fix') : t('Still of the fix')}
          {source ? ` · ${source}` : ''}
        </span>
        <Badge size="sm" tone={state.tone}>
          {state.text}
        </Badge>
      </span>
    </div>
  );
}

/** What you may do with a reply: change its words, also take it back, or nothing (someone else's, or a status change). */
type ReplyRights = 'edit' | 'all' | null;

/** Replies under a note, oldest first: messages with their author, status changes as one line each. Your own plain
 * replies have a ⋯ to edit them in place or take them back. */
function Thread({
  noteId,
  replies,
  asks,
  previews,
  slug,
  onLightbox,
  refsOf,
  onOpenRef,
  options,
  rights,
  editing,
  editor,
  onEdit,
  onDelete,
}: {
  noteId: string;
  replies: Reply[];
  asks: boolean;
  /** A question's options: a reply that picked from them says the picks in words. */
  options?: OptionGroup[];
  previews?: FixPreview[];
  slug: string;
  onLightbox: (src: string) => void;
  /** The references that came with a reply. */
  refsOf: (ids: string[] | undefined) => ViewRef[];
  onOpenRef: (r: ViewRef) => void;
  rights: (r: Reply) => ReplyRights;
  /** The reply being edited (its author and time), and its editor in place of its words. */
  editing: { by: string; at: string } | null;
  editor: ReactNode;
  onEdit: (r: Reply) => void;
  onDelete: (r: Reply) => void;
}) {
  const avatarOf = usePeople();
  const [all, setAll] = useState(false);
  // a reply deleted a moment ago is gone while its Undo is up
  const gone = useHiddenReplies();
  const visible = gone.size ? replies.filter((r) => !gone.has(replyKey(noteId, r))) : replies;
  const hidden = all ? 0 : Math.max(0, visible.length - 4);
  const shown = visible.slice(hidden);
  return (
    <div className="thread">
      {hidden > 0 && (
        <button type="button" className="thread-more" onClick={() => setAll(true)}>
          {t('{n} earlier reply|{n} earlier replies', { n: hidden })}
        </button>
      )}
      {shown.map((r) => {
        const act = activity(r, asks);
        return act ? (
          <div key={`${r.by}:${r.at}`} className={`act act-${act.tone}`}>
            <div className="act-line">
              <I name={act.icon} size={13} />
              <span>
                <b>{displayName(r.by)}</b> {act.verb}
              </span>
              <When at={r.at} />
            </div>
            {r.answer && options ? (
              <p className="act-text">
                <Picked options={options} answer={r.answer} />
              </p>
            ) : (
              r.text && <p className="act-text">{r.text}</p>
            )}
            {r.preview && r.status === 'fixed' && previews?.some((p) => p.id === r.preview) && (
              <PreviewChip p={previews.find((p) => p.id === r.preview) as FixPreview} slug={slug} onLightbox={onLightbox} />
            )}
            <RefStrip refs={refsOf(r.refs)} onOpen={onOpenRef} />
          </div>
        ) : (
          <Message
            key={`${r.by}:${r.at}`}
            r={r}
            avatar={avatarOf(r.by)}
            rights={rights(r)}
            editor={editing?.by === r.by && editing.at === r.at ? editor : null}
            onEdit={onEdit}
            onDelete={onDelete}
          >
            <p>{r.answer && options ? <Picked options={options} answer={r.answer} /> : r.text}</p>
            <RefStrip refs={refsOf(r.refs)} onOpen={onOpenRef} />
          </Message>
        );
      })}
    </div>
  );
}

/** One message in a thread: who, when, whether its author changed it since, its words — or, being edited, its editor. */
function Message({
  r,
  avatar,
  rights,
  editor,
  onEdit,
  onDelete,
  children,
}: {
  r: Reply;
  avatar: string | null | undefined;
  rights: ReplyRights;
  editor: ReactNode;
  onEdit: (r: Reply) => void;
  onDelete: (r: Reply) => void;
  children: ReactNode;
}) {
  return (
    <div className={`msg${rights ? ' own' : ''}`} data-testid="reply">
      <Avatar name={r.by} size={20} src={avatar} />
      <div className="msg-body">
        <div className="msg-who">
          <b>{displayName(r.by)}</b>
          <When at={r.at} />
          {r.edited && (
            <span className="msg-edited" title={new Date(r.edited).toLocaleString(locale())}>
              {t('edited')}
            </span>
          )}
          {rights && !editor && (
            <Menu
              sideOffset={2}
              trigger={<IconButton className="btn sm ghost icon-only msg-tools" label={t('Your reply: edit or delete')} icon="more" size={14} />}
              items={[
                { label: t('Edit reply'), icon: 'edit', onClick: () => onEdit(r) },
                rights === 'all' && { label: t('Delete reply'), icon: 'trash', danger: true, onClick: () => onDelete(r) },
              ]}
            />
          )}
        </div>
        {editor ?? children}
      </div>
    </div>
  );
}

type Mode = 'reply' | 'wontfix' | 'reopen';
const PLACEHOLDER = perLang(
  (): Record<Mode, string> => ({
    reply: t('Reply…'),
    wontfix: t('Why not? (required)'),
    reopen: t('What is still wrong? (optional)'),
  }),
);
const SUBMIT = perLang((): Record<Mode, string> => ({ reply: t('Reply'), wontfix: t('Won’t fix'), reopen: t('Reopen') }));

/** The client's name when a client wrote the note, else null. */
export const clientOf = (author: string): string | null => (isClient(author) ? displayName(author) : null);

/** Inline editor: grows with the text, ⌘↵ saves, Esc cancels. `onSay`: a voice button whose words join the text (a
 * reason for "Still wrong"). `client`: the note's client, who sees what is written here. `alt`: a second way to send
 * the same words, beside the first (a reply on a fix to check: "Send and reopen"); ⌘↵ stays the first. */
function Editor({
  value,
  onChange,
  onSubmit,
  onCancel,
  onSay,
  placeholder,
  submit,
  busy,
  label,
  className = '',
  client = null,
  alt,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onSay?: (said: string) => void;
  placeholder?: string;
  submit: string;
  busy: boolean;
  label: string;
  className?: string;
  client?: string | null;
  alt?: { label: string; onClick: () => void };
}) {
  // while the microphone is live or the words are being heard, the text isn't complete yet
  const [held, setHeld] = useState(false);
  const send = () => !held && onSubmit();
  const empty = !value.trim();
  return (
    <div className={`note-editor ${className}`}>
      <AutoTextarea
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSubmit={send}
        onCancel={onCancel}
      />
      <ClientReads name={client} />
      <div className={`note-editor-foot${alt ? ' choice' : ''}`}>
        {/* one way to say it: ⌘↵ is drawn on the button it presses (Esc is the Cancel beside it), never also in a line
            of its own before them */}
        {onSay && <SayButton onSaid={onSay} onHold={setHeld} />}
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          {t('Cancel')}
        </button>
        {alt && (
          <button type="button" className="btn sm" onClick={alt.onClick} disabled={busy || held || empty} data-testid="send-reopen">
            {alt.label}
          </button>
        )}
        <button
          type="button"
          className="btn sm primary"
          onClick={send}
          disabled={busy || held || (!!alt && empty)}
          data-keys="⌘↵"
          data-testid={alt ? 'send-reply' : undefined}
        >
          {busy && <Spinner />}
          {submit}
        </button>
      </div>
    </div>
  );
}

/** A note that changes the words: what is heard, struck, and what it should say (or that the words go). `inline`: in a
 * row's line (a button holds no paragraph). */
export function WordsChange({ edit, inline = false }: { edit: TextEdit; inline?: boolean }) {
  const Line = inline ? 'span' : 'p';
  return (
    <Line className="c-edit" data-testid="text-edit">
      <span className="sr-only">{t('Change the words:')} </span>
      <del className="c-edit-from">{edit.from}</del>
      <span className="c-edit-arrow" aria-hidden="true">
        →
      </span>
      {edit.to ? <ins className="c-edit-to">{edit.to}</ins> : <span className="c-edit-cut">{t('cut these words')}</span>}
    </Line>
  );
}

/** A range note's buttons: play it once, on repeat, or stop the repeat. */
export type RangePlay = 'once' | 'loop' | 'stop';

interface CommentCardProps {
  c: PlacedComment;
  slug: string;
  videoName: string;
  currentV: number;
  /** The newest version: a fix is checked on it (fixCheck.ts checkVerdict). */
  latestV: number;
  here: boolean;
  /** The selected note: open as the card (one at a time); every other note is a row. */
  selected: boolean;
  /** The row starts a group: who wrote it and when, said above it (noteRows.ts groupStarts). */
  groupHead?: boolean;
  onSelect: (c: PlacedComment) => void;
  onLightbox: (src: string) => void;
  /** A range note: the video's frame rate (its duration), playing its range (loop: on repeat), and whether it is. */
  fps?: number;
  onPlayRange?: (c: PlacedComment, how: RangePlay) => void;
  looping?: boolean;
  /** Check mode is on: its card over the picture (VerifyPanel.tsx) is where a fix is decided, so this card says where
   * the note stands without asking the same question again. */
  checkMode?: boolean;
  /** Its place in the agent's plan while work goes on (a line under the row; its room is kept from the start, empty
   * until the agent reaches it), and the agent's name for it. */
  plan?: RunPlanItem;
  planName?: string;
}

// Memoised: the player re-renders on every frame during playback, the cards only when their own props change.
/** A recorded note's clip, in seconds (the stretch the server cut for it). */
const clipSeconds = (r: { t0: number; t1: number }) => {
  const { from, to } = clipBounds(r.t0, r.t1);
  return to - from;
};

export const CommentCard = memo(function CommentCard({
  c,
  slug,
  videoName,
  currentV,
  latestV,
  here,
  selected,
  groupHead = false,
  onSelect,
  onLightbox,
  fps,
  onPlayRange,
  looping,
  checkMode = false,
  plan,
  planName = '',
}: CommentCardProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const [mode, setMode] = useState<Mode | null>(null);
  // the row's picture: asked for only once the pointer (or the focus) is on the row
  const [peek, setPeek] = useState(false);
  const avatarOf = usePeople();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // A note that changes the words: what they should say now (what was heard stays).
  const [say, setSay] = useState('');
  const sayId = useId();
  const [answer, setAnswer] = useState('');
  const [viewing, setViewing] = useState<ViewRef | null>(null);
  const pending = usePendingRefs();
  const look = noteKind(c);
  // An agent's question (or a kind-less note agents wrote before kinds existed) waits for the reviewer's answer.
  const asks = look === 'question' || look === 'agent';
  const feedback = look === 'feedback';
  const actions = useCommentActions(slug);
  const allowed = useCan();
  const me = useAuthStatus().data?.user ?? null;
  // Your own notes are yours to change; someone else's need the edit-notes right (reviewers don't have it). Nothing
  // changes in an archived project (`comment` is no one's there: api/auth.ts ReadOnlyScope).
  const may = allowed('comment');
  const mine = may && (allowed('edit-notes') || isOwner(c.author, c.author_id, me));
  const busy = actions.patch.isPending;
  const closed = c.status === 'verified' || c.status === 'wontfix';
  const role = roleOf(c.author);
  // The fix is in a render ("Fixed · V4"), or so far only in the project, shown on a preview ("Fixed · preview").
  const lastFix = c.replies?.findLast((r) => r.status === 'fixed');
  // A fix waiting to be checked: one decision row (Looks right · Still wrong, check mode's own), a plain reply below it.
  const checking = waitsForCheck(c) && !asks;
  // Still wrong's reason is being given (CheckDecision); `reason` starts it with what was typed as a reply.
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  // Your own reply being edited in place: which (its author and time) and its words so far.
  const [replyDraft, setReplyDraft] = useState<{ by: string; at: string; text: string } | null>(null);
  // Settled anywhere else — check mode's card, someone else, an agent — the card shows it at once and asks nothing it
  // no longer can: an open reason goes. A reply being written stays (its second way to send goes with the fix to check).
  const settled = `${c.status}:${!!c.check_again}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when where the note stands changes, not on every render
  useEffect(() => {
    if (actions.patch.isPending) return;
    setReopening(false);
    setMode((m) => (m === 'reply' ? m : null));
  }, [settled]);

  const patch = async (body: CommentPatch, msg?: string): Promise<boolean> => {
    try {
      await actions.patch.mutateAsync({ id: c.id, ...body });
      setMode(null);
      setEditing(false);
      setReopening(false);
      setDraft('');
      if (msg) toast(msg, 'ok');
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  const open = (m: Mode) => {
    setEditing(false);
    setReopening(false);
    setReplyDraft(null);
    setDraft('');
    setMode(m);
  };
  // the verdict on a fix to check, as check mode sends it (fixCheck.ts)
  const decide = (ok: boolean, why?: string) =>
    patch(checkVerdict(c, ok, why, latestV), ok ? t('Looks right') : c.status === 'fixed' ? t('Reopened') : t('Kept open'));
  const submitMode = () => {
    // a reply on a fix to check leaves it waiting, and says so: reopening is the other button
    if (mode === 'reply') return draft.trim() && patch({ note: draft }, checking ? t('Reply added · the fix still waits to be checked') : t('Reply added'));
    if (mode === 'wontfix') return draft.trim() ? patch({ status: 'wontfix', note: draft }, t('Marked won’t fix')) : toast(t('Give a short reason'), 'error');
    if (mode === 'reopen') return patch({ status: 'open', note: draft }, t('Reopened'));
  };
  // Still wrong while a reply is being written: its words become the reason, nothing typed is lost
  const startReason = (on: boolean) => {
    if (on) {
      setReason(mode === 'reply' ? draft : '');
      if (mode === 'reply') setMode(null);
      setReplyDraft(null);
    }
    setReopening(on);
  };

  // Your own plain replies: their words change in place, or they're taken back (with Undo, sent once it's gone).
  const replyRights = (r: Reply) => (isOwner(r.by, r.by_id, me) && changeableReply(r) ? (changeableReply(r, true) ? 'all' : 'edit') : null);
  const editReply = (r: Reply) => {
    setMode(null);
    setEditing(false);
    setReopening(false);
    setReplyDraft({ by: r.by, at: r.at, text: r.text || '' });
  };
  const saveReply = async () => {
    if (!replyDraft) return;
    const n = c.replies.findIndex((r) => r.by === replyDraft.by && r.at === replyDraft.at);
    const r = c.replies[n];
    const text = replyDraft.text.trim();
    if (!r) return setReplyDraft(null);
    if (!text) return toast(t('A reply needs words: delete it instead'), 'error');
    if (text === (r.text || '').trim()) return setReplyDraft(null);
    try {
      await actions.editReply.mutateAsync({ id: c.id, n, at: r.at, text });
      setReplyDraft(null);
      toast(t('Reply updated'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const deleteReply = (r: Reply) => {
    const key = replyKey(c.id, r);
    later({
      message: t('Reply deleted'),
      apply: () => hideReply(key),
      revert: () => showReply(key),
      commit: async () => {
        await actions.removeReply(c.id, r);
        showReply(key);
      },
    });
  };
  // References on the note: its own row (edit mode: remove, caption, add more), and those that came with replies.
  const views = ownerRefs(slug, c.refs, me);
  const { own, byReply } = splitRefs(views, c.replies || []);
  const refreshRefs = () => qc.invalidateQueries({ queryKey: keys.review(slug) });
  const refAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshRefs();
    } catch (e) {
      toastError(e);
    }
  };
  const saveEdit = async () => {
    const files = pending.refs;
    for (const p of files)
      try {
        await sendRef({ kind: 'owner', comment: c.id }, p, { onProgress: (share) => pending.onProgress(p.key, share) });
      } catch (e) {
        toastError(e);
      }
    if (files.length) {
      pending.clear();
      await refreshRefs();
    }
    const body: CommentPatch = {};
    if (draft.trim() && draft !== c.text) body.text = draft;
    if (c.text_edit && say.trim() !== c.text_edit.to) body.text_edit_to = say.trim();
    return Object.keys(body).length ? patch(body, t('Updated')) : setEditing(false);
  };
  const sendAnswer = async () => {
    if (!answer.trim()) return;
    if (await patch({ status: 'verified', note: answer.trim() }, t('Answered — {name} gets it', { name: displayName(c.author) }))) setAnswer('');
  };
  // Deleting takes the note off the screen at once; the server hears of it when the Undo toast is gone.
  const qc = useQueryClient();
  const remove = () =>
    later({
      message: t('Deleted {id}', { id: c.id }),
      apply: () => hideNote(c.id),
      revert: () => showNote(c.id),
      commit: async () => {
        await api(`/api/comments/${c.id}`, { method: 'DELETE', keepalive: true });
        await Promise.all([qc.invalidateQueries({ queryKey: keys.review(slug) }), qc.invalidateQueries({ queryKey: keys.library })]);
        showNote(c.id);
      },
    });
  const items: MenuEntry[] = [
    mine && {
      label: t('Edit text'),
      icon: 'edit',
      onClick: () => {
        setMode(null);
        setDraft(c.text);
        setSay(c.text_edit?.to ?? '');
        setEditing(true);
      },
    },
    may && { label: t('Reply'), icon: 'reply', onClick: () => open('reply') },
    c.status === 'open' &&
      feedback &&
      allowed('resolve') && { label: c.severity === 'idea' ? t('Not now…') : t("Won't fix…"), icon: 'wontfix', onClick: () => open('wontfix') },
    closed && may && { label: t('Reopen…'), icon: 'reopen', onClick: () => open('reopen') },
    'sep',
    { label: t('Copy note id'), icon: 'copy', onClick: async () => (await copyText(c.id)) && toast(t('{id} copied', { id: c.id }), 'ok') },
    {
      label: t('Copy link'),
      icon: 'link',
      onClick: async () => (await copyText(`${location.origin}/#/v/${enc(slug)}?c=${c.id}`)) && toast(t('Link copied'), 'ok'),
    },
    'sep',
    mine && { label: t('Delete'), icon: 'trash', danger: true, onClick: remove },
  ];
  const shot = (f: string) => `/data/${enc(slug)}/${f}`;
  const marked = c.shots?.marked;
  const [kindLabel, kindTone] = feedback ? [severityLabel(c.severity), c.severity as Tone] : KIND()[look as Exclude<NoteLook, 'feedback'>];
  const state = closed ? 'closed' : c.status === 'fixed' ? 'fixed' : 'open';

  // The button that moves an info note on; a fix to check has its decision row, everything else is in the ⋯ menu.
  const workflow =
    c.status === 'open' && look === 'info' && allowed('verify') ? (
      <button type="button" className="btn sm ok" onClick={() => patch({ status: 'verified' }, t('Noted'))} disabled={busy}>
        <I name="check" size={14} /> {t('Got it')}
      </button>
    ) : null;

  // A reply, an edit or an answer being written keeps its card open: picking another note never throws words away.
  const opened = selected || !!mode || editing || reopening || !!replyDraft || !!answer.trim() || pending.refs.length > 0;
  if (!opened) {
    const glyph = feedback ? (
      <SevMark s={c.severity} size={10} />
    ) : (
      <KeyGlyph shape={KIND_SHAPE[look as keyof typeof KIND_SHAPE]} size={10} className={`nr-kind nr-${look}`} />
    );
    // what a row says besides its words: where it stands when that is news (fixed, carried over, closed, a question)
    const status =
      c.status === 'fixed'
        ? t('Fixed')
        : c.status === 'verified'
          ? asks
            ? t('Answered')
            : t('Checked')
          : c.status === 'wontfix'
            ? t("Won't fix")
            : c.check_again
              ? t('Check again')
              : asks
                ? t('Question')
                : null;
    const said = (c.replies || []).filter((r) => !r.status).length;
    const ghost = c.rangeHere && c.scope !== 'video' ? c.rangeHere : null;
    const planLine = plan ? planSaid(plan, planName, latestV) : null;
    const show = () => {
      setPeek(true);
      if (ghost) setRangeHint({ ghost });
    };
    const hide = () => {
      if (ghost) setRangeHint({ ghost: null });
    };
    return (
      <ContextMenu items={items}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row's button is the keyboard's way in; a click on its group header picks it too */}
        <article
          onClick={cardClick(() => onSelect(c), '.nr')}
          className={`note note-row ${state} ${here ? 'here' : ''}`}
          data-kind={look}
          data-severity={feedback ? c.severity : undefined}
          data-note={c.id}
          aria-label={t('{kindLabel} note at {timecodeHere}', { kindLabel, timecodeHere: c.timecodeHere })}
        >
          {groupHead && (
            <div className="note-group">
              <Avatar name={c.author} size={20} src={avatarOf(c.author)} />
              <b className="ellipsis">{displayName(c.author)}</b>
              {role && <span className="note-role">{role}</span>}
              <span className="note-group-dot" aria-hidden="true">
                ·
              </span>
              <When at={c.created} />
            </div>
          )}
          <button
            type="button"
            className={plan ? 'nr planned' : 'nr'}
            onClick={() => onSelect(c)}
            onPointerEnter={show}
            onPointerLeave={hide}
            onFocus={() => setPeek(true)}
            onBlur={() => clearRangeHint()}
            aria-expanded={false}
            data-testid="note-row"
          >
            <span className="c-id" hidden>
              {c.id}
            </span>
            <span className={`nr-tc ${c.scope === 'video' ? 'overall' : ''}`}>{c.scope === 'video' ? t('Whole video') : c.timecodeHere}</span>
            <span className="nr-kg">
              {glyph}
              <span className="sr-only">{kindLabel}</span>
            </span>
            <span className="nr-text">
              {c.text_edit ? <WordsChange edit={c.text_edit} inline /> : c.text ? firstLine(c.text) : <span className="muted">{t('(marked frame)')}</span>}
            </span>
            {(status || said > 0 || c.v !== currentV || !!ghost) && (
              <span className="nr-meta">
                {ghost && fps && <span className="nr-len">{formatSeconds(rangeSeconds(ghost, fps))}</span>}
                {c.v !== currentV && <span className="nr-v">V{c.v}</span>}
                {said > 0 && (
                  <span className="nr-said" title={t('{n} reply|{n} replies', { n: said })}>
                    <I name="reply" size={12} />
                    {said}
                  </span>
                )}
                {status && <span className={`nr-state nr-${c.status}${c.check_again && c.status === 'open' ? ' again' : ''}`}>{status}</span>}
              </span>
            )}
            {plan && (
              <span className="nr-plan" data-testid="note-plan" data-state={plan.state}>
                {planLine && (
                  <>
                    <KeyGlyph shape={planLine.shape} className={`nav-kg run-kg ${planLine.tone}`} />
                    <span className="nr-plan-words">{planLine.words}</span>
                  </>
                )}
              </span>
            )}
            {peek && marked && <img className="nr-thumb" src={shot(marked)} alt="" decoding="async" />}
          </button>
        </article>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu items={items}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click anywhere on the card selects it; the timecode is the keyboard's way in, [ and ] move between notes */}
      <article
        className={`comment note ${state} active ${here ? 'here' : ''}`}
        data-note={c.id}
        data-kind={look}
        data-severity={feedback ? c.severity : undefined}
        aria-label={t('{kindLabel} note at {timecodeHere}', { kindLabel, timecodeHere: c.timecodeHere })}
        onClick={cardClick(
          () => onSelect(c),
          '.note-tools, .note-editor, .c-edit-say, .note-answer, .c-actions, .check-decision, .verify-reason, .msg-tools, .c-thumb, .thread-more, audio, .note-range .icon-only',
        )}
      >
        <header className="note-head">
          <Avatar name={c.author} size={24} src={avatarOf(c.author)} />
          <div className="note-who">
            <b className="ellipsis">{displayName(c.author)}</b>
            {role && <span className="note-role">{role}</span>}
            <When at={c.created} />
          </div>
          <div className="note-tools">
            {/* the id is for scripts and suites; people copy it from ⋯ */}
            <span className="c-id" hidden>
              {c.id}
            </span>
            <IconButton className="btn sm ghost icon-only" label={t('Reply')} icon="reply" size={14} onClick={() => open('reply')} />
            <Menu
              sideOffset={2}
              trigger={<IconButton className="btn sm ghost icon-only" label={t('Actions for {id}', { id: c.id })} icon="more" size={15} />}
              items={items}
            />
          </div>
        </header>

        <div className="note-meta">
          {c.scope === 'video' ? (
            <span className="c-tc overall">{t('Whole video')}</span>
          ) : c.rangeHere && fps ? (
            <span className="note-range">
              <button
                type="button"
                className="c-tc range"
                onClick={() => onSelect(c)}
                aria-label={t('Go to {timecodeHere}', { timecodeHere: c.timecodeHere })}
                data-testid="note-range"
              >
                {rangeTimecodes(c.rangeHere, fps)}
                <span className="note-range-len">{formatSeconds(rangeSeconds(c.rangeHere, fps))}</span>
              </button>
              {onPlayRange && (
                <>
                  <IconButton
                    className="btn sm ghost icon-only"
                    label={t('Play the range')}
                    icon="play"
                    size={12}
                    onClick={() => onPlayRange(c, 'once')}
                    data-testid="range-play"
                  />
                  <IconButton
                    className={`btn sm ghost icon-only ${looping ? 'on' : ''}`}
                    label={looping ? t('Stop the loop') : t('Play the range on repeat')}
                    icon="loop"
                    size={13}
                    onClick={() => onPlayRange(c, looping ? 'stop' : 'loop')}
                    aria-pressed={!!looping}
                    data-testid="range-loop"
                  />
                </>
              )}
            </span>
          ) : (
            <button type="button" className="c-tc" onClick={() => onSelect(c)} aria-label={t('Go to {timecodeHere}', { timecodeHere: c.timecodeHere })}>
              {c.timecodeHere}
            </button>
          )}
          <Badge size="sm" tone={kindTone}>
            {kindLabel}
          </Badge>
          {/* where the note stands right after what it is: when the row wraps, the tags go to the next line, not the state */}
          {c.status === 'fixed' && (
            <Badge size="sm" tone="ok" className="note-state">
              {t('Fixed')}
              {lastFix?.preview ? t(' · preview') : lastFix?.fixed_in_v ? ` · V${lastFix.fixed_in_v}` : ''}
            </Badge>
          )}
          {c.status === 'verified' && (
            <Badge
              size="sm"
              tone="ok"
              className="note-state"
              title={c.verified_on ? t('No version has the fix yet: the next one is checked against the preview') : undefined}
            >
              {asks ? t('Answered') : c.verified_on ? t('Checked on the preview') : t('Checked')}
            </Badge>
          )}
          {c.status === 'wontfix' && (
            <Badge size="sm" className="note-state">
              {t("Won't fix")}
            </Badge>
          )}
          {c.tags?.map((tag) => (
            <span key={tag} className="note-tag">
              {tag === 'love-it' && <I name="heart" size={11} />}
              {tagLabel(tag)}
            </span>
          ))}
          {c.v !== currentV && <span className="note-tag mono">V{c.v}</span>}
        </div>

        {c.check_again && c.status === 'open' && (
          <div className="note-flag">
            <I name="eye" size={13} /> {t('Carried over to V{carried_to}: check it again', { carried_to: c.carried_to })}
          </div>
        )}

        {c.text_edit && !editing && <WordsChange edit={c.text_edit} />}
        {c.text_edit && editing && (
          <div className="c-edit-say">
            <label htmlFor={sayId}>{t('Instead of “{from}”, say', { from: c.text_edit.from })}</label>
            <AutoTextarea
              id={sayId}
              value={say}
              onChange={(e) => setSay(e.target.value)}
              onCancel={() => setEditing(false)}
              placeholder={t('Nothing (cut these words)')}
            />
          </div>
        )}
        <div className="note-body">
          {editing ? (
            <Editor
              className="note-edit"
              label={t('Note text')}
              value={draft}
              onChange={setDraft}
              onSubmit={saveEdit}
              onCancel={() => setEditing(false)}
              submit={t('Save')}
              busy={busy}
            />
          ) : c.text ? (
            <p className="c-text">
              {/* timecodes in the words seek the player (to the note's version, where they were written) */}
              <TimecodeText
                text={c.text}
                fps={fps}
                href={(frame) => `#/v/${enc(slug)}?v=${c.v}&f=${frame}`}
                onSeek={(frame) => window.dispatchEvent(new CustomEvent<GotoFrame>(GOTO_FRAME, { detail: { slug, v: c.v, frame } }))}
              />
            </p>
          ) : c.text_edit ? null : (
            <p className="c-text muted">{t('(marked frame)')}</p>
          )}
          {marked && !editing && (
            // its frame's size keeps its room before it arrives: the thread and "Reply…" under it don't jump when it does
            // biome-ignore lint/a11y/useKeyWithClickEvents: enlarging the thumbnail is a mouse shortcut; the marked frame is also a file agents read
            <img
              className="c-thumb"
              src={shot(marked)}
              alt={t('Marked frame')}
              loading="lazy"
              width={c.shotSize?.width}
              height={c.shotSize?.height}
              onClick={() => onLightbox(shot(marked))}
            />
          )}
        </div>
        <RefStrip
          refs={editing ? own.map((r) => ({ ...r, mine: true })) : own}
          onOpen={setViewing}
          editing={editing}
          onRemove={(r) => refAction(() => removeRef({ kind: 'owner', comment: c.id }, r.id))}
          onCaption={(r, caption) => refAction(() => captionRef(c.id, r.id, caption))}
        />
        {editing && <RefTools pending={pending} video={{ slug, name: videoName }} />}
        {viewing && <RefViewer r={viewing} onClose={() => setViewing(null)} />}
        {c.voice?.file && <VoiceClip src={shot(c.voice.file)} seconds={c.recording ? clipSeconds(c.recording) : null} />}

        {c.replies?.length > 0 && (
          <Thread
            noteId={c.id}
            rights={replyRights}
            editing={replyDraft}
            editor={
              replyDraft && (
                <Editor
                  className="reply-edit"
                  label={t('Your reply')}
                  value={replyDraft.text}
                  onChange={(text) => setReplyDraft((d) => d && { ...d, text })}
                  onSubmit={saveReply}
                  onCancel={() => setReplyDraft(null)}
                  submit={t('Save')}
                  busy={actions.editReply.isPending}
                />
              )
            }
            onEdit={editReply}
            onDelete={deleteReply}
            replies={c.replies}
            asks={asks}
            previews={c.previews}
            slug={slug}
            onLightbox={onLightbox}
            refsOf={byReply}
            onOpenRef={setViewing}
            options={c.options}
          />
        )}

        {asks && c.options?.length && !mode ? (
          // Options to audition before the render: their own view, the picks an answer like any other.
          <div className="note-answer">
            <OptionsAsk id={c.id} text={c.text} by={c.author} groups={optionsSeen(c.options)} answered={c.status !== 'open'} />
          </div>
        ) : null}
        {asks && c.status === 'open' && !mode && !c.options?.length && may && (
          <div className="note-answer">
            {c.choices?.length ? (
              <Choices
                choices={c.choices}
                name={displayName(c.author)}
                busy={busy}
                onPick={(choice) => patch({ status: 'verified', note: choice }, t('Answered — {name} gets it', { name: displayName(c.author) }))}
              />
            ) : null}
            <AutoTextarea
              aria-label={t('Answer {displayName}', { displayName: displayName(c.author) })}
              placeholder={t('Answer {displayName}…', { displayName: displayName(c.author) })}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onSubmit={sendAnswer}
            />
            <div className="note-editor-foot">
              <button type="button" className="btn sm ghost" onClick={() => patch({ status: 'verified' }, t('Closed'))} disabled={busy}>
                {t('Close without answer')}
              </button>
              <button type="button" className="btn sm primary" onClick={sendAnswer} disabled={busy || !answer.trim()}>
                {busy ? <Spinner /> : <I name="reply" size={14} />} {t('Answer')}
              </button>
            </div>
          </div>
        )}

        {checking && !editing && !checkMode && may && (
          <CheckDecision
            id={c.id}
            small
            fixed={c.status === 'fixed'}
            busy={busy}
            onRight={() => decide(true)}
            onWrong={(why) => decide(false, why)}
            reopening={reopening}
            onReopening={startReason}
            initial={reason}
            client={clientOf(c.author)}
          />
        )}
        {mode ? (
          <Editor
            label={mode === 'reply' && checking ? t('Reply without changing the status') : SUBMIT()[mode]}
            placeholder={mode === 'reply' && checking ? t('Reply without changing the status') : PLACEHOLDER()[mode]}
            value={draft}
            onChange={setDraft}
            onSubmit={submitMode}
            onCancel={() => setMode(null)}
            onSay={mode === 'reopen' ? (said) => setDraft((d) => withSaid(d, said)) : undefined}
            submit={mode === 'reply' && checking ? t('Send as reply') : SUBMIT()[mode]}
            busy={busy}
            client={clientOf(c.author)}
            // on a fix to check, the words can also go as its reopen reason: which one is said on the buttons
            alt={
              mode === 'reply' && checking
                ? { label: c.status === 'fixed' ? t('Send and reopen') : t('Send as still wrong'), onClick: () => decide(false, draft) }
                : undefined
            }
          />
        ) : (
          !editing &&
          !reopening &&
          (workflow || (selected && !asks && may)) && (
            <div className={`c-actions${checking ? ' c-reply' : ''}`}>
              {workflow}
              {selected && !asks && may && (
                <button type="button" className="reply-stub" onClick={() => open('reply')}>
                  {checking ? t('Reply without changing the status…') : t('Reply…')}
                </button>
              )}
            </div>
          )
        )}
      </article>
    </ContextMenu>
  );
});
