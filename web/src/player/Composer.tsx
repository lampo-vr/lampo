// Writing a note on the paused frame (or about the whole video), like a message: where it is (the head: one chip, the
// frame or the section with its length; its menu — this frame/section or the whole video, the section's ends from the
// frame on screen (I / O), only its first frame — and, for a frame, the quiet "→ 00:13:03" that makes it a section;
// RangeControl.tsx), the text as the hero, what is picked as small chips under it, and one
// quiet toolbar — severity, tags (or "#" in the text), the paperclip, voice — and the two ways out: Save (⌘S) keeps
// the note as a draft only you see, Send (⌘↵, as before) sends it with every draft you kept here ("Send 3"). On a video
// with an agent (`batch`) the main action is Save (⌘↵): the agent starts on the first note it gets, so notes are kept
// and go together from "not sent yet" (drafts/Unsent.tsx); Send (⇧⌘↵) still sends this one with them now. The
// drawing tools are on the picture (DrawBar.tsx, the player's), not here. Cancel is the card's × (Esc). 1–4 set the
// severity while you aren't typing.
import { useEffect, useId, useRef, useState } from 'react';
import { partWhere } from '../../../lib/part.ts';
import { SEVERITIES, TAGS } from '../../../lib/time.ts';
import { usePartSuggestion } from '../api/queries.ts';
import type { FrameRange, PartRequest, Severity, TextEdit } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { severityLabel, tagLabel } from '../i18n/terms.ts';
import { useTouch } from '../lib/media.ts';
import { errorMessage, toast } from '../lib/toast.ts';
import type { PendingRef } from '../refs/model.ts';
import { AttachMenu, LinkField, PendingList, usePendingRefs } from '../refs/RefTools.tsx';
import { AutoTextarea } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { SevMark } from '../ui/KeyGlyph.tsx';
import { IconButton, Menu, Tip } from '../ui/primitives.tsx';
import { useVoice, VoiceButton, withSaid } from '../ui/VoiceButton.tsx';
import type { DrawTool } from './DrawBar.tsx';
import type { FrameStore } from './frameStore.ts';
import { dropHash, type HashWord, hashAt, matchTags, takeHashtags } from './hashtags.ts';
import { RangeControl, RangeExtend, rangeItems, useFrameOnScreen } from './RangeControl.tsx';
import { litHandlers } from './rangeHint.ts';
import { SttProgress } from './SttProgress.tsx';

export interface ComposerPayload {
  text: string;
  tags: string[];
  severity: Severity;
  voiceId?: string;
  voiceTranscript: string | null;
  /** About the whole video, not this frame. */
  overall: boolean;
  /** References picked in the composer: links and frames go with the note, files right after it. */
  refs: PendingRef[];
  onProgress: (key: string, share: number) => void;
  /** The words heard in the range and what they should say instead (started from the transcript). */
  text_edit?: TextEdit;
  /** The person allows a partial render of these shots (the where-menu's "Quick check", lib/part.ts). */
  part?: PartRequest;
}

interface ComposerProps {
  frame: number;
  fps: number;
  /** Frames in the render (a range stays inside it). */
  frames: number;
  /** The stretch the note is about (the timeline's in/out), or null for one frame. */
  range: FrameRange | null;
  onRange: (r: FrameRange | null) => void;
  /** The frame on screen, live while it plays: what the range's actions name. */
  live?: FrameStore;
  /** Where "only the first frame" takes the player. */
  onSeek?: (frame: number) => void;
  shapeCount: number;
  onClear: () => void;
  /** The note is about the whole video (nothing to draw on): the player hides its drawing tools. */
  onWhole?: (whole: boolean) => void;
  onCancel: () => void;
  /** `draft`: keep it, not sent (Save); `send`: send it with every draft of yours on this video (Send). */
  onSave: (p: ComposerPayload, how: SaveHow) => Promise<void>;
  /** Your other notes on this video that aren't sent yet: Send sends them too ("Send 3"). */
  unsent?: number;
  /** The video has an agent: Save is the main action (⌘↵), Send the quiet one (⇧⌘↵). */
  batch?: boolean;
  /** The agent waits for notes now (its name): said under the buttons. */
  waiting?: string | null;
  whisper?: boolean;
  /** The note's video, where "Frame from a video…" starts. */
  video: { slug: string; name: string };
  /** Words picked in the transcript: the note asks for them to be said differently. */
  words?: string | null;
  /** The version the note is on: a partial render's stretch is snapped to its shots. */
  v?: number;
  /** Changes when the text should take the focus again (a section drawn on the timeline while writing). */
  focusKey?: number;
}

export type SaveHow = 'draft' | 'send';

/** The owner's drawing tools, shown on the picture while a note is written (Player.tsx → DrawBar). */
export const COMPOSER_TOOLS = perLang((): DrawTool[] => [
  { id: 'none', icon: 'pointer', label: t('No drawing') },
  { id: 'box', icon: 'box', label: t('Box') },
  { id: 'arrow', icon: 'arrow', label: t('Arrow') },
  { id: 'freehand', icon: 'pen', label: t('Freehand') },
]);

const isTyping = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);

export function Composer({
  frame,
  fps,
  frames,
  range,
  onRange,
  live,
  onSeek,
  shapeCount,
  onClear,
  onWhole,
  onCancel,
  onSave,
  unsent = 0,
  batch = false,
  waiting = null,
  whisper,
  video,
  words = null,
  v = 0,
  focusKey = 0,
}: ComposerProps) {
  const [text, setText] = useState('');
  // What the picked words should say: starts as what is heard, selected, so typing replaces it and ← keeps most of it.
  const [say, setSay] = useState(words ?? '');
  const sayRef = useRef<HTMLTextAreaElement>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [severity, setSeverity] = useState<Severity>('should');
  // what is said lands in the text, editable; the clip goes with the note as its voice note
  const voice = useVoice((said) => setText((x) => withSaid(x, said)));
  const [saving, setSaving] = useState<SaveHow | null>(null);
  const [overall, setOverallState] = useState(false);
  const setOverall = (x: boolean) => {
    setOverallState(x);
    onWhole?.(x);
  };
  const [linking, setLinking] = useState(false);
  // "Quick check: render only this part": opt-in, the stretch snapped to the version's shots (asked for once the
  // where-menu opens), following the frame or range while it is on.
  const [whereOpen, setWhereOpen] = useState(false);
  // what the where-menu's "End at …" / "Start at …" name: the frame on screen, live while the menu is open
  const now = useFrameOnScreen(frame, live, whereOpen);
  const [partOn, setPartOn] = useState(false);
  const span = range ?? { in: frame, out: frame };
  const suggestion = usePartSuggestion(video.slug, v, span.in, span.out, (whereOpen || partOn) && words === null && !overall).data;
  const suggested = suggestion && 'part' in suggestion ? suggestion : null;
  const part = partOn && !overall ? (suggested && !suggested.whole ? suggested.part : { in: span.in, out: span.out }) : undefined;
  const id = useId();
  const pending = usePendingRefs();
  const ta = useRef<HTMLTextAreaElement>(null);
  // A keyboard types right away; a touch screen would throw up its keyboard over the picture you want to draw on.
  const touch = useTouch();
  // Focus when the composer opens, and again when a section is drawn on the timeline while it is open: ready to type.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening and on each new ask
  useEffect(() => {
    if (touch) return;
    if (words !== null) {
      sayRef.current?.focus();
      sayRef.current?.select();
    } else ta.current?.focus();
  }, [focusKey]);

  // 1–4: the severity, while you aren't typing (a note may well start with "2 frames too early").
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const n = '1234'.indexOf(e.key);
      if (n < 0 || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (isTyping(el) || el?.closest('[role=dialog]')) return;
      e.preventDefault();
      setSeverity(SEVERITIES[n]);
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // "#" in the text: the tags that fit the word being typed, under the text
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [shut, setShut] = useState<number | null>(null);
  const [hi, setHi] = useState(0);
  const hash: HashWord | null = focused ? hashAt(text, caret) : null;
  const offers = hash && hash.start !== shut ? matchTags(TAGS, hash.query, tagLabel).slice(0, 6) : [];
  const offered = offers[Math.min(hi, offers.length - 1)];
  const pickTag = (tag: string) => {
    if (!hash) return;
    const next = dropHash(text, hash);
    setText(next.text);
    setTags((xs) => (xs.includes(tag) ? xs : [...xs, tag]));
    setCaret(next.caret);
    requestAnimationFrame(() => ta.current?.setSelectionRange(next.caret, next.caret));
  };

  const voiceId = voice.id;
  const toggleTag = (x: string) => setTags((xs) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]));
  // An empty "say instead" asks for the words to go; the same words again ask for nothing.
  const edit = words !== null && say.trim() !== words.trim() ? { from: words, to: say.trim() } : undefined;
  const blank = !text.trim() && !tags.length && !shapeCount && !voice.clip && !pending.refs.length && !edit;
  const save = async (how: SaveHow) => {
    if (saving) return;
    const typed = takeHashtags(text, TAGS, tagLabel);
    if (words !== null && !edit && !typed.text.trim()) return toast(t('Type what should be said instead'), 'error');
    if (!typed.text.trim() && !shapeCount && !voiceId && !pending.refs.length && !edit)
      return toast(t('Write something, draw on the frame or record a voice note'), 'error');
    setSaving(how);
    try {
      await onSave(
        {
          text: typed.text,
          tags: [...tags, ...typed.tags.filter((x) => !tags.includes(x))],
          severity,
          voiceId,
          voiceTranscript: voice.clip && !voice.clip.busy ? voice.clip.transcript : null,
          overall: overall && words === null,
          refs: pending.refs,
          onProgress: pending.onProgress,
          ...(edit ? { text_edit: edit } : {}),
          ...(part && words === null ? { part } : {}),
        },
        how,
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
      setSaving(null);
    }
  };

  const { recording, busy } = voice;
  const chips = tags.length > 0 || shapeCount > 0 || !!voiceId;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ sends (saves on an agent's video, ⇧⌘↵ sends), ⌘S saves and Esc cancels from anywhere inside the composer
    <div
      className={`composer ${pending.dragging ? 'ref-drop' : ''}`}
      {...pending.drop}
      onKeyDown={(e) => {
        // a menu, the frame picker or a field that handled the key (Radix marks it) keeps it
        if (e.defaultPrevented) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save(batch && !e.shiftKey ? 'draft' : 'send');
        } else if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
          // the browser's "Save page" never: here ⌘S keeps the note, like saving a document
          e.preventDefault();
          save('draft');
        } else if (e.key === 'Escape' && blank) {
          // nothing written yet: nothing to lose. A written note leaves the field first (the player's Esc), then closes.
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <IconButton className="btn sm ghost icon-only composer-close" label={t('Cancel')} shortcut="Esc" icon="x" size={15} onClick={onCancel} />
      <div className="composer-head">
        {words === null ? (
          <Menu
            align="start"
            onOpenChange={setWhereOpen}
            trigger={
              <Tip content={range ? t('This section: move its ends, or the whole video') : t('This frame, or the whole video')}>
                <button type="button" className="composer-where" data-testid="composer-where" {...litHandlers}>
                  {overall ? (
                    <span className="c-tc">{t('Whole video')}</span>
                  ) : (
                    // no "F120 · V2" beside it: the transport shows the frame, the version picker the version
                    <RangeControl frame={frame} fps={fps} range={range} />
                  )}
                  {part && (
                    <span className="c-part" data-testid="composer-part">
                      <I name="layers" size={12} />
                      {t('part')}
                    </span>
                  )}
                  <I name="down" size={12} className="composer-where-chev" />
                </button>
              </Tip>
            }
            items={[
              { label: range ? t('This section') : t('This frame'), checked: !overall, onClick: () => setOverall(false) },
              { label: t('About the whole video'), checked: overall, onClick: () => setOverall(true) },
              'sep',
              // the head's × is Cancel: moving the section's ends and taking its end off live here, each naming its frame
              ...(range && !overall ? rangeItems({ now, range, fps, frames, onRange, onSeek, touch }) : []),
              'sep',
              // opt-in: an agent may render only these shots (never the default; lib/part.ts)
              !overall &&
                v > 0 &&
                !(suggestion && 'none' in suggestion) && {
                  label: !suggested
                    ? t('Quick check: render only this part (finding the shots…)')
                    : suggested.whole
                      ? t('Quick check: the whole video is one shot')
                      : t('Quick check: render only this part ({stretch})', {
                          stretch: partWhere({ at: suggested.part.in, frames: suggested.part.out - suggested.part.in + 1 }, fps),
                        }),
                  icon: 'layers' as const,
                  checked: partOn,
                  disabled: !partOn && (!suggested || suggested.whole),
                  onClick: () => setPartOn((x) => !x),
                },
            ]}
          />
        ) : (
          <span {...litHandlers}>
            <RangeControl frame={frame} fps={fps} range={range} />
          </span>
        )}
        {/* one frame: the quiet way to make it a section. The words picked in the transcript decide the section; a note
            about the whole video has none */}
        {!overall && words === null && !range && <RangeExtend frame={frame} live={live} fps={fps} frames={frames} onRange={onRange} />}
      </div>
      {words !== null && (
        <fieldset className="cw" data-testid="change-words">
          <legend className="cw-title">{t('Change the words')}</legend>
          <span className="cw-label">{t('Heard')}</span>
          <q className="cw-from">{words}</q>
          <label className="cw-label" htmlFor={`${id}-say`}>
            {t('Say')}
          </label>
          <AutoTextarea
            ref={sayRef}
            id={`${id}-say`}
            className="cw-to"
            value={say}
            onChange={(e) => setSay(e.target.value)}
            onKeyDown={(e) => {
              // one line of words: ↵ goes on to why (⌘↵ still saves, from the composer)
              if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              ta.current?.focus();
            }}
            placeholder={t('Nothing (cut these words)')}
          />
        </fieldset>
      )}
      <div className="composer-write">
        <AutoTextarea
          ref={ta}
          rows={2}
          className="composer-text"
          aria-label={words !== null ? t('Why (optional)') : t('Your note for this frame')}
          placeholder={
            words !== null
              ? t('Why? (optional)')
              : overall
                ? t('What should change overall?')
                : range
                  ? t('What should change in this section?')
                  : t('What should change on this frame?')
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setHi(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          role={offers.length ? 'combobox' : undefined}
          aria-expanded={offers.length ? true : undefined}
          aria-autocomplete={offers.length ? 'list' : undefined}
          aria-controls={offers.length ? `${id}-tags` : undefined}
          aria-activedescendant={offered ? `${id}-tag-${offered}` : undefined}
          onKeyDown={(e) => {
            if (!offers.length || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = offers.length;
              setHi((i) => (Math.min(i, n - 1) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && offered) {
              e.preventDefault();
              pickTag(offered);
            } else if (e.key === 'Escape') {
              // the suggestions go; the note stays
              e.preventDefault();
              setShut(hash?.start ?? null);
            }
          }}
        />
        {offers.length > 0 && (
          <div className="tag-suggest" role="listbox" id={`${id}-tags`} aria-label={t('Tags')} data-testid="tag-suggest">
            {offers.map((tag) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are the text field's (↑ ↓ ↵ Tab Esc), as in any combobox
              <div
                key={tag}
                id={`${id}-tag-${tag}`}
                role="option"
                tabIndex={-1}
                aria-selected={tag === offered}
                // the text field keeps the focus (and its caret)
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pickTag(tag)}
                onPointerEnter={() => setHi(offers.indexOf(tag))}
              >
                <I name={tag === 'love-it' ? 'heart' : 'tag'} size={13} />
                <span className="grow">{tagLabel(tag)}</span>
                {tags.includes(tag) && <I name="check" size={13} />}
              </div>
            ))}
          </div>
        )}
      </div>
      {chips && (
        <div className="composer-picked">
          {tags.map((tag) => (
            <button
              type="button"
              key={tag}
              className={`chip ${tag === 'love-it' ? 'love' : ''}`}
              onClick={() => toggleTag(tag)}
              aria-label={t('Remove the tag {tag}', { tag: tagLabel(tag) })}
              data-testid="tag-chip"
            >
              <I name={tag === 'love-it' ? 'heart' : 'tag'} size={12} />
              {tagLabel(tag)}
              <I name="x" size={11} className="chip-x" />
            </button>
          ))}
          {voiceId && (
            <button type="button" className="chip" onClick={voice.clear} aria-label={t('Remove the voice note')} data-testid="voice-chip">
              <I name="mic" size={12} />
              {t('Voice note')}
              <I name="x" size={11} className="chip-x" />
            </button>
          )}
          {shapeCount > 0 && (
            <Tip content={t('Clear the marks')}>
              <button type="button" className="chip" onClick={onClear} data-testid="marks-chip">
                <I name="edit" size={12} />
                {t('{n} mark|{n} marks', { n: shapeCount })}
                <I name="x" size={11} className="chip-x" />
              </button>
            </Tip>
          )}
        </div>
      )}
      {linking && <LinkField pending={pending} onClose={() => setLinking(false)} />}
      <PendingList pending={pending} disabled={!!saving} />
      <SttProgress active={busy} />
      <div className="composer-foot">
        <Menu
          align="start"
          trigger={
            <Tip content={t('Severity')} shortcut="1–4">
              <button type="button" className="btn sm ghost sev-pick" aria-label={t('Severity: {severity}', { severity: severityLabel(severity) })}>
                <SevMark s={severity} />
                <span className="sev-word">{severityLabel(severity)}</span>
                <I name="down" size={12} className="sev-chev" />
              </button>
            </Tip>
          }
          items={SEVERITIES.map((s, i) => ({
            label: severityLabel(s),
            mark: <SevMark s={s} />,
            shortcut: String(i + 1),
            checked: severity === s,
            onClick: () => setSeverity(s),
          }))}
        />
        <Menu
          align="start"
          trigger={<IconButton className="btn sm ghost icon-only" label={t('Tags')} tip={t('Tags · or type # in the note')} icon="tag" size={15} />}
          items={TAGS.map((tag) => ({
            label: tagLabel(tag),
            icon: tag === 'love-it' ? ('heart' as const) : undefined,
            checked: tags.includes(tag),
            keep: true,
            onClick: () => toggleTag(tag),
          }))}
        />
        <AttachMenu pending={pending} video={video} disabled={!!saving} onLink={() => setLinking(true)} />
        <VoiceButton
          voice={voice}
          label={t('Voice note')}
          again={t('Record the voice note again')}
          tip={whisper ? t('Voice note, transcribed on this server') : t('Voice note (no speech-to-text available: audio only)')}
        />
        {/* The main action at the end, raised, with ⌘↵; the other quiet beside it. On an agent's video they trade places:
            Save keeps the note with the others, Send (⇧⌘↵) sends it and them now. */}
        <div className="composer-send">
          {batch ? (
            <>
              <Tip content={unsent ? t('Sends this note and {n} more not sent yet', { n: unsent }) : t('Send it now')} shortcut="⇧⌘↵">
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => save('send')}
                  disabled={!!saving || recording || busy}
                  data-testid="composer-send"
                >
                  {saving === 'send' && <Spinner />}
                  {unsent ? t('Send {n}', { n: unsent + 1 }) : t('Send')}
                </button>
              </Tip>
              <Tip content={t('Keep it as a draft: only you see it until you send it')}>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => save('draft')}
                  disabled={!!saving || recording || busy}
                  data-keys="⌘↵"
                  data-testid="composer-save"
                >
                  {saving === 'draft' && <Spinner />}
                  {t('Save')}
                </button>
              </Tip>
            </>
          ) : (
            <>
              <Tip content={t('Keep it as a draft: only you see it until you send it')} shortcut="⌘S">
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => save('draft')}
                  disabled={!!saving || recording || busy}
                  data-testid="composer-save"
                >
                  {saving === 'draft' && <Spinner />}
                  {t('Save')}
                </button>
              </Tip>
              <Tip content={unsent ? t('Sends this note and {n} more not sent yet', { n: unsent }) : null}>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => save('send')}
                  disabled={!!saving || recording || busy}
                  data-keys="⌘↵"
                  data-testid="composer-send"
                >
                  {saving === 'send' && <Spinner />}
                  {unsent ? t('Send {n}', { n: unsent + 1 }) : t('Send')}
                </button>
              </Tip>
            </>
          )}
        </div>
        {waiting && (
          <p className="composer-hint composer-wait" data-testid="agent-waiting">
            {t('{name} is waiting · gets your notes when you send', { name: waiting })}
          </p>
        )}
      </div>
    </div>
  );
}
