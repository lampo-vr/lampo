// What recorded feedback looks like (loaded with the recorder, on first use):
//   RecordBar  over the picture while recording — the red dot and the time, the microphone's level, the drawing tools,
//              pause, discard and Done (⇧R);
//   Drafts     in the notes panel once it has been heard — one card per thing said, on its frame or stretch, the text
//              editable (what was heard stays for agents), its clip to listen to, the spot or drawing, severity; join
//              one with the one before, delete one, discard the recording. Edits are kept on the server as you make them;
//              they go with every other note not sent yet (drafts/Unsent.tsx: Send all), in one batch, or one by one
//              (a card's own Send, ⌘↵ on the card).
import { useEffect, useRef, useState } from 'react';
import { formatRange } from '../../../../lib/range.ts';
import { SEVERITIES, timecode } from '../../../../lib/time.ts';
import { discardRecording, hearAgain, recordingAudio, saveDrafts } from '../../api/recordings.ts';
import type { Recording, RecordingDraft, Tool } from '../../api/types.ts';
import { perLang, t } from '../../i18n/index.ts';
import { severityLabel, tagLabel } from '../../i18n/terms.ts';
import { errorMessage, toast } from '../../lib/toast.ts';
import { AutoTextarea } from '../../ui/controls.tsx';
import { Spinner } from '../../ui/feedback.tsx';
import { I, type IconName } from '../../ui/icons.tsx';
import { KeyGlyph, SevMark } from '../../ui/KeyGlyph.tsx';
import { IconButton, Menu, Tip, useConfirm } from '../../ui/primitives.tsx';
import { SEND_ONE_KEYS, sendOneKey, useLeave } from '../drafts/card.ts';
import type { Going } from '../drafts/useUnsent.ts';
import { clearRangeHint, setRangeHint } from '../rangeHint.ts';
import type { RecordFeedback } from './useRecordFeedback.ts';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const TOOLS = perLang((): { id: Tool; icon: IconName; label: string }[] => [
  { id: 'none', icon: 'pointer', label: t('Point') },
  { id: 'box', icon: 'box', label: t('Box') },
  { id: 'arrow', icon: 'arrow', label: t('Arrow') },
  { id: 'freehand', icon: 'pen', label: t('Freehand') },
]);

export function RecordBar({ rec }: { rec: RecordFeedback }) {
  const time = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const [ask, confirmDialog] = useConfirm();
  // The time and the level are written into their elements: nothing here renders per frame.
  useEffect(() => {
    const tick = setInterval(() => {
      if (time.current && rec.recorder) time.current.textContent = clock(rec.recorder.seconds());
    }, 250);
    rec.level.current = (n) => meter.current?.style.setProperty('--lvl', n.toFixed(3));
    return () => {
      clearInterval(tick);
      rec.level.current = null;
    };
  }, [rec.recorder, rec.level]);
  const paused = rec.phase === 'paused';
  const saving = rec.phase === 'saving';
  const discard = async () => {
    rec.pause();
    const yes = await ask({
      title: t('Discard this recording?'),
      action: t('Discard'),
      danger: true,
      body: t('Nothing you said or drew in it becomes a note.'),
    });
    if (yes) rec.discard();
    else rec.resume();
  };
  return (
    <section className={`rec-bar${paused ? ' paused' : ''}`} aria-label={t('Recording feedback')} data-testid="rec-bar">
      <span className="rec-live">
        <span className="rec-dot" aria-hidden="true" />
        <span className="rec-word">{saving ? t('Sending…') : paused ? t('Paused') : t('Recording')}</span>
        <span className="rec-time" ref={time}>
          0:00
        </span>
      </span>
      <span className="rec-meter" ref={meter} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="rec-tools" role="toolbar" aria-label={t('Draw while you talk')}>
        {TOOLS().map((x) => (
          <IconButton
            key={x.id}
            className={`btn sm ghost icon-only${rec.tool === x.id ? ' on' : ''}`}
            label={x.label}
            icon={x.icon}
            size={15}
            aria-pressed={rec.tool === x.id}
            onClick={() => rec.setTool(x.id)}
            disabled={saving}
          />
        ))}
      </span>
      <span className="rec-actions">
        <IconButton
          className="btn sm ghost icon-only"
          label={paused ? t('Go on recording') : t('Pause the recording')}
          icon={paused ? 'mic' : 'pause'}
          size={15}
          onClick={paused ? rec.resume : rec.pause}
          disabled={saving}
          data-testid="rec-pause"
        />
        <IconButton className="btn sm ghost icon-only" label={t('Discard the recording')} icon="trash" size={15} onClick={discard} disabled={saving} />
        <button type="button" className="btn sm primary" onClick={rec.finish} disabled={saving} data-keys="⇧R" data-testid="rec-done">
          {saving ? <Spinner /> : <I name="check" size={14} />}
          {t('Done')}
        </button>
      </span>
      {confirmDialog}
    </section>
  );
}

interface DraftsProps {
  slug: string;
  rec: Recording;
  fps: number;
  onSeek: (frame: number) => void;
  /** The draft looked at: its drawing shows on its frame, its stretch on the timeline. */
  onFocus: (d: RecordingDraft | null) => void;
  /** Edits not saved yet are saved before a send (drafts/useUnsent.ts); returns the unregister. */
  register: (flush: () => Promise<unknown>) => () => void;
  /** Something not sent (these drafts, or another) is being sent. */
  sending: boolean;
  /** A draft's way out (drafts/useUnsent.ts): being sent, or sent and leaving the holding area. */
  going?: (id: string) => Going;
  /** Sends one draft alone (its card's Send, ⌘↵ on the card); false when it can't go now. */
  onSend?: (id: string) => boolean;
}

export function Drafts({ slug, rec, fps, onSeek, onFocus, register, sending, going, onSend }: DraftsProps) {
  const [drafts, setDrafts] = useState<RecordingDraft[]>(rec.drafts);
  const current = useRef(drafts);
  current.current = drafts;
  const [ask, confirmDialog] = useConfirm();
  // The server's copy wins until you edit; after that your edits are the copy (saved a moment after each).
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A draft sent on its own is never saved back with the rest (that would make it a draft again): the ones seen
  // leaving are left out of every save, and, while you edit, a draft the server no longer has is let go of.
  const sent = useRef(new Set<string>());
  for (const d of drafts) if (going?.(d.id) === 'leaving') sent.current.add(d.id);
  useEffect(() => {
    if (!dirty.current) setDrafts(rec.drafts);
    else setDrafts((cur) => (cur.every((d) => rec.drafts.some((x) => x.id === d.id)) ? cur : cur.filter((d) => rec.drafts.some((x) => x.id === d.id))));
  }, [rec.drafts]);
  const flush = async (list: RecordingDraft[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await saveDrafts(
      slug,
      rec.id,
      list.filter((d) => !sent.current.has(d.id)),
    );
    dirty.current = false;
  };
  const edit = (next: RecordingDraft[]) => {
    dirty.current = true;
    setDrafts(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flush(next).catch((e) => toast(errorMessage(e), 'error')), 700);
  };
  useEffect(() => () => onFocus(null), [onFocus]);
  // A send (Send all, or Send in the composer) takes the drafts as edited: saved first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush reads the latest drafts through the ref
  useEffect(() => register(async () => dirty.current && flush(current.current)), [register]);

  // One shared player for the clips: from a little before the first word to a little after the last.
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = (d: RecordingDraft) => {
    const el = audio.current;
    if (!el) return;
    if (playing === d.id) {
      el.pause();
      return setPlaying(null);
    }
    el.currentTime = Math.max(0, d.t0 - 0.2);
    el.dataset.until = String(d.t1 + 0.3);
    setPlaying(d.id);
    el.play().catch(() => setPlaying(null));
  };

  const hearing = rec.state === 'uploading' || rec.state === 'hearing';
  const discard = async () => {
    const yes = await ask({
      title: t('Discard this recording?'),
      action: t('Discard'),
      danger: true,
      body: t('Its drafts are not sent: nothing you said in it becomes a note.'),
    });
    if (!yes) return;
    try {
      await discardRecording(slug, rec.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const retry = async () => {
    try {
      await hearAgain(slug, rec.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  // Sent ones leave (drafts/leaving.ts): the head counts the rest at once; the last one sent takes the group with it.
  const waiting = drafts.filter((d) => going?.(d.id) !== 'leaving').length;
  const gone = drafts.length > 0 && !waiting;
  const ref = useLeave<HTMLElement>(gone);
  const head = hearing
    ? t('Hearing what you said…')
    : rec.state === 'failed'
      ? t('Couldn’t hear it')
      : t('{n} draft from your recording|{n} drafts from your recording', { n: waiting || drafts.length });

  return (
    <section
      ref={ref}
      className="drafts"
      aria-label={t('Recorded feedback')}
      aria-busy={hearing}
      data-testid="drafts"
      data-state={rec.state}
      data-going={gone ? 'leaving' : undefined}
    >
      <div className="drafts-head">
        <span className="rec-dot still" aria-hidden="true" />
        <b className="grow">{head}</b>
        <span className="drafts-len">{clock(rec.duration)}</span>
        {!hearing && (
          <button type="button" className="btn sm ghost drafts-discard" onClick={discard} disabled={sending}>
            {t('Discard')}
          </button>
        )}
      </div>
      {hearing && (
        <p className="drafts-note busy">
          <Spinner />
          <span>{t('Each thing you said becomes a note on the frame that was on screen.')}</span>
        </p>
      )}
      {rec.state === 'failed' && (
        <p className="drafts-note">
          {t('The recording is kept: {error}', { error: rec.error || t('the speech engine did not answer') })}
          <button type="button" className="btn sm" onClick={retry}>
            {t('Hear it again')}
          </button>
        </p>
      )}
      {rec.state === 'ready' && rec.silent && !drafts.length && <p className="drafts-note">{t('Heard nothing: check the microphone and record again.')}</p>}
      {/* biome-ignore lint/a11y/useMediaCaption: the clips are what the reviewer said; their words are the draft's text */}
      <audio
        ref={audio}
        src={recordingAudio(slug, rec.id)}
        preload="none"
        onTimeUpdate={(e) => {
          const until = Number(e.currentTarget.dataset.until || 0);
          if (until && e.currentTarget.currentTime >= until) {
            e.currentTarget.pause();
            setPlaying(null);
          }
        }}
        onPause={() => setPlaying(null)}
      />
      {drafts.map((d, i) => (
        <DraftCard
          key={d.id}
          d={d}
          fps={fps}
          going={going?.(d.id) ?? null}
          sending={sending}
          onSend={onSend && (() => onSend(d.id))}
          playing={playing === d.id}
          onPlay={() => play(d)}
          onSeek={() => {
            onSeek(d.frame);
            onFocus(d);
          }}
          onFocus={onFocus}
          onChange={(next) => edit(drafts.map((x) => (x.id === d.id ? next : x)))}
          onDelete={() => edit(drafts.filter((x) => x.id !== d.id))}
          onJoin={
            i > 0
              ? () => {
                  const prev = drafts[i - 1];
                  const joined = joinDrafts(prev, d);
                  edit(drafts.filter((x) => x.id !== d.id).map((x) => (x.id === prev.id ? joined : x)));
                }
              : undefined
          }
        />
      ))}
      {confirmDialog}
    </section>
  );
}

/** Two drafts as one: the words in order, a range over both, both drawings. */
function joinDrafts(a: RecordingDraft, b: RecordingDraft): RecordingDraft {
  const lo = Math.min(a.range?.in ?? a.frame, b.range?.in ?? b.frame);
  const hi = Math.max(a.range?.out ?? a.frame, b.range?.out ?? b.frame);
  const text = [a.text, b.text]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ');
  return {
    ...a,
    frame: a.drawing.length ? a.frame : b.drawing.length ? b.frame : lo,
    range: hi > lo ? { in: lo, out: hi } : null,
    text,
    heard: [a.heard, b.heard].filter(Boolean).join(' '),
    tags: [...new Set([...a.tags, ...b.tags])],
    drawing: [...a.drawing, ...b.drawing],
    t0: Math.min(a.t0, b.t0),
    t1: Math.max(a.t1, b.t1),
    severity: SEVERITIES[Math.min(SEVERITIES.indexOf(a.severity), SEVERITIES.indexOf(b.severity))],
  };
}

interface DraftCardProps {
  d: RecordingDraft;
  fps: number;
  /** On its way out: being sent, or sent and leaving. */
  going: Going;
  /** Something not sent is on its way. */
  sending: boolean;
  /** Sends this draft alone; false when it can't go now. */
  onSend?: () => boolean;
  playing: boolean;
  onPlay: () => void;
  onSeek: () => void;
  onFocus: (d: RecordingDraft | null) => void;
  onChange: (d: RecordingDraft) => void;
  onDelete: () => void;
  onJoin?: () => void;
}

function DraftCard({ d, fps, going, sending, onSend, playing, onPlay, onSeek, onFocus, onChange, onDelete, onJoin }: DraftCardProps) {
  const where = d.range ? formatRange(d.range, fps) : timecode(d.frame, fps);
  const look = () => {
    onFocus(d);
    setRangeHint({ ghost: d.range ?? { in: d.frame, out: d.frame } });
  };
  const away = () => clearRangeHint();
  // nothing said and nothing drawn: nothing to send (a send would only drop it)
  const empty = !d.text.trim() && !d.drawing.length;
  const send = () => !going && !empty && !!onSend?.();
  const ref = useLeave<HTMLElement>(going === 'leaving');
  return (
    <article
      ref={ref}
      className="draft"
      data-testid="draft"
      data-frame={d.frame}
      data-going={going ?? undefined}
      aria-busy={going === 'sending'}
      onPointerEnter={look}
      onPointerLeave={away}
      onFocus={look}
      onBlur={away}
      onKeyDown={(e) => onSend && sendOneKey(e, send, ref.current)}
    >
      <div className="draft-head">
        {/* not set yet: a hollow keyframe, as on every note not sent (drafts/Unsent.tsx); the hourglass while it goes,
            set as it leaves */}
        <KeyGlyph shape={going === 'leaving' ? 'diamond' : going === 'sending' ? 'ease' : 'outline'} className="draft-kg" />
        <Tip content={t('Go to this moment')}>
          <button type="button" className={`c-tc draft-where${d.range ? ' range' : ''}`} onClick={onSeek} data-testid="draft-where">
            {where}
          </button>
        </Tip>
        {d.spot && (
          <span className="draft-mark" title={t('You pointed here while you said it')}>
            <I name="eye" size={12} /> {t('Spot')}
          </span>
        )}
        {!d.spot && d.drawing.length > 0 && (
          <span className="draft-mark">
            <I name="pen" size={12} /> {t('{n} mark|{n} marks', { n: d.drawing.length })}
          </span>
        )}
        <span className="grow" />
        {d.t1 > d.t0 && (
          <IconButton
            className="btn sm ghost icon-only"
            label={playing ? t('Stop') : t('Listen to what you said')}
            icon={playing ? 'stop' : 'play'}
            size={13}
            onClick={onPlay}
          />
        )}
      </div>
      <AutoTextarea
        className="draft-text"
        value={d.text}
        placeholder={d.drawing.length ? t('What should change here? (the drawing says where)') : t('What should change here?')}
        onChange={(e) => onChange({ ...d, text: e.target.value })}
        aria-label={t('Note at {where}', { where })}
        disabled={!!going}
        // another draft on its way: hold still a moment (an edit then would race the send), keeping the focus
        readOnly={sending}
      />
      {d.heard && d.heard !== d.text.trim() && (
        <p className="draft-heard">
          <I name="mic" size={11} /> {d.heard}
        </p>
      )}
      <div className="draft-foot">
        <Menu
          align="start"
          trigger={
            <button type="button" className="btn sm ghost sev-pick" aria-label={t('Severity: {severity}', { severity: severityLabel(d.severity) })}>
              <SevMark s={d.severity} />
              <span className="sev-word">{severityLabel(d.severity)}</span>
              <I name="down" size={12} className="sev-chev" />
            </button>
          }
          items={SEVERITIES.map((s) => ({
            label: severityLabel(s),
            mark: <SevMark s={s} />,
            checked: d.severity === s,
            onClick: () => onChange({ ...d, severity: s }),
          }))}
        />
        {d.tags.map((tag) => (
          <span key={tag} className="chip draft-tag">
            <I name="tag" size={11} />
            {tagLabel(tag)}
          </span>
        ))}
        <span className="grow" />
        {onJoin && (
          <IconButton className="btn sm ghost icon-only" label={t('Join with the draft before')} icon="sortAsc" size={14} onClick={onJoin} disabled={!!going} />
        )}
        <IconButton className="btn sm ghost icon-only" label={t('Delete this draft')} icon="trash" size={14} onClick={onDelete} disabled={!!going} />
        {/* Send at the foot's end, as on a note you saved and in the composer */}
        {onSend && (
          <IconButton
            className="btn sm ghost icon-only draft-send"
            label={t('Send this note')}
            tip={t('Send this note now, without the others')}
            shortcut={SEND_ONE_KEYS}
            icon="send"
            size={14}
            onClick={send}
            disabled={!!going || empty}
            data-testid="draft-send"
          />
        )}
      </div>
    </article>
  );
}
