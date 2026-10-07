// The item beside the inbox list, in a small frame-exact player that fills the pane: a head (the video, where it
// stands, "Open in player"), the picture on its dark stage, a timeline with the item's moment on it, play/pause, ±1
// frame, "play around it", sound; who did what, what was said, and the item's action. Two layouts by what the item is:
// - work on the picture (a render to review, a fix to check, a stalled video): the picture first — as large as the pane
//   allows in the render's own shape (a reel takes the height beside the text, a wide render the width above it) —
//   and the action always at the pane's bottom;
// - a conversation (a question, an agent's answer to your note, a client's note — isTalk): the words first at a
//   reading width, the choices and the answer right under them, the picture beside at a calmer size, on the moment the
//   words are about (their note's frame; a note about the whole video: the first timecode it names, else the poster's
//   frame). Timecodes in the words are links that seek the picture. No stage chip: it would describe the video, not
//   the item. An agent's work that needs you reads the same way: a permission it lacks with the exact rule to copy, a
//   failure with its error and the last lines it printed (sessions/RunNeeds.tsx).
// "Open in player" (O, a double-click on the picture, or ↵ on the open item in the list) takes the frame on screen to
// the full player.
// Keys while the preview is there: Space plays/pauses, ←/→ a frame, ⇧←/→ a second, O opens — never while typing.
import { useEffect, useRef, useState } from 'react';
import { drawingMarkup } from '../../../lib/drawing.ts';
import { undismissed } from '../../../lib/findings.ts';
import { partWhere } from '../../../lib/part.ts';
import { renderKey } from '../../../lib/renderKey.ts';
import { posterFrame, timecode, timecodesIn, timeToFrame } from '../../../lib/time.ts';
import type { StageInfo } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { useWakeAgent } from '../api/mutations.ts';
import { useInfo, useQaQuery, useReview } from '../api/queries.ts';
import { useRunDetail } from '../api/runQueries.ts';
import { spriteUrl, useSprite } from '../api/sprite.ts';
import type { Comment, ForYouItem, Review, ReviewResponse, Version, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago, bytes } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { OptionsAsk } from '../options/OptionsAsk.tsx';
import { fullSaid, seamSaid } from '../player/partWords.ts';
import { FailureLines, LastSteps, PermissionNeeds } from '../sessions/RunNeeds.tsx';
import { useWakeChoice, WakeAsk, type WakeChoice } from '../sessions/Wake.tsx';
import { useStageActions } from '../status/api.ts';
import { StatusPill } from '../status/StatusPill.tsx';
import { Choices } from '../ui/Choices.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Tip } from '../ui/primitives.tsx';
import { EmptyState } from '../ui/system.tsx';
import { TimecodeText } from '../ui/TimecodeText.tsx';
import { SayButton, withSaid } from '../ui/VoiceButton.tsx';
import { laterUntil } from './group.ts';
import {
  ChangedLabel,
  type InboxActions,
  isTalk,
  itemText,
  OPEN_PLAYER,
  openHref,
  PostRetry,
  RunActs,
  StalledActions,
  What,
  whenWords,
  who,
} from './items.tsx';
import { PlaybookPreview } from './PlaybookPreview.tsx';
import { PreviewLoading as Loading } from './PreviewPending.tsx';
import { Scrubber } from './Scrubber.tsx';
import { type PreviewPlayer, usePreviewPlayer } from './usePreviewPlayer.ts';

export interface PreviewProps {
  item: ForYouItem;
  actions: InboxActions;
  /** The item is done (answered, verified, approved…): the list moves on. */
  onDone: (key: string) => void;
  /** Back to the list (phone and tablet), or close the preview pane (desktop). None in the inbox view, where the
   * preview is part of the page. */
  onBack?: () => void;
  backLabel?: string;
}

// The version an item is about: the fix's render, the render to review, else the note's own version; the newest if
// that one isn't there any more.
function versionFor(item: ForYouItem, review: Review, note: Comment | undefined): Version {
  const want = item.v ?? note?.v;
  return review.versions.find((x) => x.v === want) || (review.versions.at(-1) as Version);
}

// Where the preview opens: the note's frame in the shown version (renders can change length or rate), like the player
// places notes. A note about the whole video has no frame of its own: the first timecode its words name, else — like an
// item without a note — the frame its poster shows, never frame 0 by default.
function frameIn(review: Review, note: Comment | undefined, ver: Version): number {
  if (!note) return posterFrame(ver);
  const own = review.versions.find((x) => x.v === note.v);
  const inShown = (f: number) => (!own || own.v === ver.v ? f : Math.min(ver.frames - 1, timeToFrame(f / own.fps, ver.fps)));
  if (note.scope === 'video') {
    const named = own ? timecodesIn(note.text, own.fps, own.frames)[0] : undefined;
    return named ? inShown(named.frame) : posterFrame(ver);
  }
  if (note.v === ver.v) return note.frame;
  return Math.min(ver.frames - 1, timeToFrame(own ? note.frame / own.fps : note.t, ver.fps));
}

export function Preview(props: PreviewProps) {
  // a playbook suggestion isn't about a video: its own preview (the diff and the decision)
  if (props.item.kind === 'playbook') return <PlaybookPreview {...props} />;
  // nor is a question asked on a folder before any render: its words and its options
  if (!props.item.slug) return <FolderAskPreview {...props} />;
  return <VideoPreview {...props} />;
}

/** A question an agent asked on a folder before the first version: who asks, what, and the way into its options. */
function FolderAskPreview(props: PreviewProps) {
  const { item, onBack, backLabel } = props;
  return (
    <section className="inbox-preview" aria-label={t('{video}: preview', { video: item.video })} data-testid="inbox-preview">
      <header className="inbox-pv-head">
        {onBack && <IconButton className="btn ghost icon-only" label={backLabel ?? t('Back to the inbox')} icon="back" size={17} onClick={onBack} />}
        <div className="inbox-pv-title grow">
          <b className="ellipsis">{item.video}</b>
          <span className="inbox-pv-sub">
            <span className="ellipsis">{t('Before the first version')}</span>
          </span>
        </div>
        <a className="btn sm inbox-open" href={`#/folder/${encodeURIComponent(item.folder ?? '')}`} data-testid="inbox-open-folder">
          <I name="folderOpen" size={14} /> {t('Open folder')}
        </a>
      </header>
      <div className="inbox-pv-main talk bare">
        <div className="inbox-pv-side">
          <div className="inbox-pv-body" data-testid="inbox-pv-body">
            <p className="inbox-pv-who">
              <span className="inbox-pv-what">
                <What item={item} />
              </span>
              <span className="inbox-pv-ago">{ago(item.at)}</span>
            </p>
            {item.text && <p className="inbox-pv-text">{item.text}</p>}
          </div>
          <div className="inbox-pv-act">
            <Act {...props} />
          </div>
        </div>
      </div>
    </section>
  );
}

function VideoPreview(props: PreviewProps) {
  const q = useReview(props.item.slug);
  if (q.error)
    return (
      <PreviewShell {...props}>
        <EmptyState art="error" size="sm" className="inbox-empty" title={t('This didn’t load')}>
          {q.error.message}
        </EmptyState>
      </PreviewShell>
    );
  if (!q.data)
    return (
      <PreviewShell {...props}>
        <Loading talk={isTalk(props.item)} />
      </PreviewShell>
    );
  return <Loaded {...props} review={q.data.review} media={q.data.media} summary={q.data.summary} />;
}

function PreviewShell({
  item,
  onBack,
  backLabel,
  children,
  stage,
  href,
  root,
}: PreviewProps & { children: React.ReactNode; stage?: StageInfo; href?: string; root?: React.Ref<HTMLElement> }) {
  return (
    <section ref={root} className="inbox-preview" aria-label={t('{video}: preview', { video: item.video })} data-testid="inbox-preview">
      <header className="inbox-pv-head">
        {onBack && <IconButton className="btn ghost icon-only" label={backLabel ?? t('Back to the inbox')} icon="back" size={17} onClick={onBack} />}
        <div className="inbox-pv-title grow">
          <b className="ellipsis">{item.video}</b>
          <span className="inbox-pv-sub">
            <span className="ellipsis">{item.folder || t('No project')}</span>
            {stage && <StatusPill info={stage} size="sm" />}
          </span>
        </div>
        {/* the way on, not the item's action: a plain button, its key in the tooltip */}
        <Tip content={t('The full player, at the frame on screen')} shortcut="O">
          <a className="btn sm inbox-open" href={href ?? openHref(item)} data-testid="inbox-open-player">
            <I name="expand" size={14} /> {t('Open in player')}
          </a>
        </Tip>
      </header>
      {children}
    </section>
  );
}

const typing = (el: Element | null) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * The preview's keys. In the bell's popover or sheet they belong to it (the page under it keeps its own); in the inbox
 * view they are the page's, unless something else is open over it (a menu, a dialog — the bell's popover too).
 */
function usePreviewKeys(root: React.RefObject<HTMLElement | null>, pv: PreviewPlayer, fps: number, open: () => void) {
  const live = useRef({ pv, fps, open });
  live.current = { pv, fps, open };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const pop = el.closest('[data-testid="inbox"]');
    const scope: HTMLElement | Window = (pop as HTMLElement | null) ?? window;
    const mine = (target: Element | null) =>
      pop ? true : !target?.closest?.('[role=dialog], [role=menu], [role=listbox]:not([data-testid="inbox-list"]), [data-radix-popper-content-wrapper]');
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      const target = k.target instanceof Element ? k.target : null;
      if (k.defaultPrevented || k.metaKey || k.ctrlKey || k.altKey || typing(target) || !mine(target)) return;
      const { pv, fps, open } = live.current;
      if (k.key === ' ') {
        // a focused button or link does what Space does to it
        if (target?.closest('button, a[href], [role=button]')) return;
        k.preventDefault();
        pv.toggle();
      } else if (k.key === 'ArrowLeft' || k.key === 'ArrowRight') {
        if (target?.closest('[role=slider], [role=tablist], [role=radiogroup]')) return;
        k.preventDefault();
        pv.step((k.key === 'ArrowLeft' ? -1 : 1) * (k.shiftKey ? Math.round(fps) : 1));
      } else if (k.key === 'o' || k.key === 'O') {
        k.preventDefault();
        open();
      }
    };
    // ↵ on the open item in the list (InboxRows): the list asks, the preview knows the frame
    const onOpen = (e: Event) => {
      if (mine(e.target instanceof Element ? e.target : null)) live.current.open();
    };
    scope.addEventListener('keydown', onKey);
    scope.addEventListener(OPEN_PLAYER, onOpen);
    return () => {
      scope.removeEventListener('keydown', onKey);
      scope.removeEventListener(OPEN_PLAYER, onOpen);
    };
  }, [root]);
}

function Loaded(props: PreviewProps & { review: Review; media: ReviewResponse['media']; summary?: VideoSummary }) {
  const { item, review, media, summary } = props;
  const note = item.id ? review.comments.find((c) => c.id === item.id) : undefined;
  const ver = versionFor(item, review, note);
  const newest = (review.versions.at(-1) as Version).v === ver.v;
  const src = media[ver.v]?.url || null;
  const start = frameIn(review, note, ver);
  const pv = usePreviewPlayer({ fps: ver.fps, frames: ver.frames, frame: start });
  const sprite = useSprite(newest && ver.hash ? spriteUrl(item.slug, renderKey(ver)) : null, item.slug, true);
  const [marks, setMarks] = useState(true);
  const root = useRef<HTMLElement>(null);
  const talk = isTalk(item);
  // Marks are in the note's own video pixels: only drawn where that picture is the one on screen.
  const own = !!note && note.v === ver.v;
  const drawing = own && note?.drawing?.length ? note.drawing : null;
  const W = ver.width;
  const H = ver.height;
  const still = item.marked || item.poster || null;
  // While it plays, the counter runs with the picture; resting, it names the frame it rests on.
  const at = pv.playing && pv.shown != null ? pv.shown : pv.frame;
  const href = openHref(item, { v: ver.v, f: at, newest });
  const open = () => {
    location.hash = openHref(item, { v: ver.v, f: pv.current(), newest });
  };
  usePreviewKeys(root, pv, ver.fps, open);
  // A stalled video or a render to review isn't about one moment, nor is a note about the whole video, nor an agent's
  // work: no mark.
  const moment =
    item.kind === 'stalled' || item.kind === 'review' || item.kind === 'post' || item.run || note?.scope === 'video'
      ? null
      : { frame: start, range: own ? note?.range : null, kind: item.kind };
  const text = itemText(item);
  // What was said, its timecodes seeking the picture (they name frames of the note's version, the one shown).
  const said = text ? (
    <TimecodeText text={text} fps={ver.fps} frames={ver.frames} href={(f) => openHref(item, { v: ver.v, f, newest })} onSeek={pv.seek} />
  ) : null;
  // Whether the agent that asks gets an answer now: known when it is the video's assigned agent.
  const agent = item.kind === 'question' && review.session && who(item.by) === review.session.name ? (summary?.sessionActive ? 'running' : 'waiting') : null;
  // …and whether answering can start it on this machine (Settings → Connect an agent says whether to ask first).
  const home = useInfo()?.home;
  const wake = useWakeChoice(agent === 'waiting' ? review.session : null, summary?.sessionActive ?? null, home);
  const player = (
    <div className="inbox-player">
      <div className="inbox-stage-box">
        <div className="inbox-stage">
          {/* a click plays or pauses, a double-click opens the full player (the keyboard has Space and O) */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the picture's pointer shortcuts; the buttons below and the keys do the same */}
          <div className="inbox-stage-hit" onClick={pv.toggle} onDoubleClick={open} data-testid="inbox-stage">
            {src ? (
              // biome-ignore lint/a11y/useMediaCaption: a render under review has no caption track; the note beside it is the text
              <video ref={pv.setVideo} src={src} playsInline preload="auto" data-testid="inbox-video" data-frame={pv.frame} data-shown={pv.shown ?? ''} />
            ) : (
              still && <img src={still} alt="" />
            )}
            {src && still && !pv.presented && !pv.playing && <img className="inbox-still" src={still} alt="" aria-hidden="true" />}
            {drawing && marks && !pv.playing && (
              <svg
                className="inbox-marks"
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: markup comes from lib/drawing (numbers only), as in the player
                dangerouslySetInnerHTML={{ __html: drawingMarkup(drawing, W, H) }}
              />
            )}
          </div>
          <IconButton
            className="btn sm icon-only inbox-stage-open"
            label={t('Open in player')}
            tip={t('The full player, at this frame')}
            shortcut="O"
            icon="expand"
            size={15}
            onClick={open}
            data-testid="inbox-stage-open"
          />
        </div>
      </div>
      <Scrubber frames={ver.frames} fps={ver.fps} at={at} mark={moment} sprite={sprite} width={W} height={H} onSeek={pv.seek} />
      <div className="inbox-transport">
        <IconButton className="btn ghost sm icon-only" label={t('Previous frame')} shortcut="←" icon="stepBack" onClick={() => pv.step(-1)} />
        <IconButton
          className="btn sm icon-only inbox-play"
          label={pv.playing ? t('Pause') : t('Play')}
          shortcut="Space"
          icon={pv.playing ? 'pause' : 'play'}
          onClick={pv.toggle}
          disabled={!src}
          data-testid="inbox-play"
        />
        <IconButton className="btn ghost sm icon-only" label={t('Next frame')} shortcut="→" icon="stepFwd" onClick={() => pv.step(1)} />
        <span className="mono inbox-tc" data-testid="inbox-tc">
          {timecode(at, ver.fps)} · F{String(at).padStart(4, '0')}
          <span className="inbox-tc-v"> · V{ver.v}</span>
        </span>
        <span className="grow" />
        <Tip content={t('1.5 s before to 1.5 s after, then back on the frame')}>
          <button type="button" className="btn ghost sm inbox-around" onClick={pv.playAround} disabled={!src}>
            <I name="loop" size={14} /> <span className="inbox-around-word">{t('Play around it')}</span>
          </button>
        </Tip>
        {drawing && (
          <Tip content={t("Show the note's marks")}>
            <button type="button" className={`btn ghost sm ${marks ? 'on' : ''}`} onClick={() => setMarks((m) => !m)} aria-pressed={marks}>
              <I name="box" size={14} /> <span className="inbox-around-word">{t('Marks')}</span>
            </button>
          </Tip>
        )}
        <IconButton
          className="btn ghost sm icon-only"
          label={pv.muted ? t('Sound on') : t('Mute')}
          icon={pv.muted ? 'mute' : 'volume'}
          onClick={() => pv.setMuted(!pv.muted)}
          data-testid="inbox-mute"
        />
      </div>
    </div>
  );
  const whoLine = (
    <p className="inbox-pv-who">
      <span className="inbox-pv-what">
        <What item={item} />
      </span>
      <span className="inbox-pv-ago">{ago(item.at)}</span>
    </p>
  );
  // the thread's last words — not under a fix (its Changed line says it) or a reply (it is the text above)
  const thread =
    note && note.replies.length > 0 && item.kind !== 'verify' && item.kind !== 'answer' ? (
      <ul className="inbox-replies">
        {note.replies.slice(-3).map((r) => (
          <li key={`${r.by}-${r.at}`}>
            <b>{who(r.by)}</b> {r.text}
          </li>
        ))}
      </ul>
    ) : null;
  // One layout for every kind: the picture on top in a band of one height, then who did what and what was said, the
  // item's action at the pane's bottom — a question's choices and answer included (inbox.css).
  return (
    <PreviewShell {...props} stage={talk ? undefined : summary?.stage} href={href} root={root}>
      <div className="inbox-pv-main" style={{ '--ar': W / H } as React.CSSProperties}>
        {player}
        <div className="inbox-pv-side">
          <div className="inbox-pv-body" data-testid="inbox-pv-body">
            {whoLine}
            {item.kind === 'answer' && item.question && <p className="inbox-pv-quote">{t('on “{question}”', { question: item.question })}</p>}
            {item.kind === 'review' ? (
              <RenderFacts item={item} review={review} ver={ver} />
            ) : item.run ? (
              <RunFacts item={item} />
            ) : (
              <>
                {said && <p className="inbox-pv-text">{said}</p>}
                {item.kind === 'verify' && item.note && (
                  <p className="inbox-pv-changed">
                    <ChangedLabel note={item.note} className="inbox-pv-changed-h" />
                    {item.note}
                  </p>
                )}
                {thread}
              </>
            )}
          </div>
          <div className="inbox-pv-act">{talk ? <Act {...props} choices={note?.choices ?? item.choices} agent={agent} wake={wake} /> : <Act {...props} />}</div>
        </div>
      </div>
    </PreviewShell>
  );
}

/**
 * An agent's work that needs you, in the preview: a permission it lacks (what for, the rule to copy, where it goes), a
 * failure (its error, the tool's last lines, the steps before), or one gone quiet (what it did last).
 */
function RunFacts({ item }: { item: ForYouItem }) {
  const r = item.run;
  const detail = useRunDetail(r?.id ?? null, !!r && item.kind !== 'blocked');
  if (!r) return null;
  if (item.kind === 'blocked') return <PermissionNeeds run={r} />;
  if (item.kind === 'failed') return <FailureLines run={r} steps={detail?.steps} />;
  return (
    <>
      <p className="inbox-pv-text">{itemText(item)}</p>
      <LastSteps steps={detail?.steps} />
    </>
  );
}

const duration = (s: number) => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m ? `${m}:${String(Math.floor(rest)).padStart(2, '0')}` : `${rest < 10 ? rest.toFixed(1) : Math.round(rest)} s`;
};

/**
 * What a render to review brings, instead of saying twice that it waits: a new video — who put it up, the render
 * itself, what Auto-check found —; a new version — what changed since the one before it (fixes in it, notes carried
 * over — an older approval is the status chip's to say), then the same.
 */
function RenderFacts({ item, review, ver }: { item: ForYouItem; review: Review; ver: Version }) {
  const qa = useQaQuery(item.slug, ver.v);
  const first = ver.v <= 1 || review.versions.length <= 1;
  const by = ver.by || (first ? review.added_by : null);
  const fixed = review.comments.filter((c) => c.fixed_in_v === ver.v && (c.status === 'fixed' || c.status === 'verified')).length;
  const carried = review.comments.filter((c) => c.carried_to === ver.v && c.status === 'open').length;
  const since: string[] = [];
  if (!first) {
    if (fixed) since.push(t('{n} fix in it|{n} fixes in it', { n: fixed }));
    if (carried) since.push(t('{n} note carried over|{n} notes carried over', { n: carried }));
    // an older approval is the status chip's to say ("To review · V1 approved"), not said twice here
  }
  // a partial render says what it patches and how its seams fit; a full render after approved parts, whether it matches
  const seam = ver.part ? seamSaid(ver.part, ver.fps) : null;
  const parts = fullSaid(review.versions, ver.v);
  // what Auto-check found and nobody put away (the same stretch dismissed in an earlier version stays away)
  const found = qa.data?.items ? undismissed(qa.data.items, review, ver.fps) : undefined;
  const check = qa.data?.pending
    ? t('Looking at it…')
    : qa.data?.failed
      ? t('Couldn’t read this version')
      : found
        ? found.length
          ? t('{n} thing to look at|{n} things to look at', { n: found.length })
          : t('Nothing found')
        : null;
  return (
    <div className="inbox-pv-render" data-testid="inbox-pv-render">
      <dl className="inbox-pv-facts">
        {by && (
          <div>
            <dt>{t('From')}</dt>
            <dd>{who(by)}</dd>
          </div>
        )}
        {!first && (
          <div>
            <dt>{t('Since V{v}', { v: ver.v - 1 })}</dt>
            <dd>{since.length ? since.join(' · ') : t('a new version, no notes on it yet')}</dd>
          </div>
        )}
        {ver.part && (
          <div data-testid="inbox-pv-part">
            <dt>{t('Part')}</dt>
            <dd>
              {t('{stretch} rendered into V{v}', { stretch: partWhere(ver.part, ver.fps), v: ver.part.of })}
              {seam && <span className={seam.ok ? '' : 'ask'}> · {seam.text}</span>}
            </dd>
          </div>
        )}
        {parts.length > 0 && (
          <div>
            <dt>{t('Parts')}</dt>
            <dd>
              {parts.map((s) => (
                <span key={s.text} className={s.ok ? '' : 'ask'}>
                  {s.text}{' '}
                </span>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('File')}</dt>
          <dd className="num">
            {duration(ver.duration)} · {ver.width}×{ver.height} · {Math.round(ver.fps * 100) / 100} fps{ver.size ? ` · ${bytes(ver.size)}` : ''}
          </dd>
        </div>
        {check && (
          <div>
            <dt>{t('Auto-check')}</dt>
            <dd>{check}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// The item's own action: at the bottom of the pane for work on the picture, right under the words in a conversation.
// A question: the answers the agent offers (one click sends one), the field for anything else, and whether the agent
// gets it now — `agent` when it is the video's assigned agent, running or not.
function Act({ item, actions, onDone, choices, agent, wake }: PreviewProps & { choices?: string[]; agent?: 'running' | 'waiting' | null; wake?: WakeChoice }) {
  const [text, setText] = useState('');
  const [still, setStill] = useState(false);
  // while the microphone is live or the words are being heard, a reason isn't complete yet
  const [held, setHeld] = useState(false);
  // An answer waiting for "Send and start" or "Only send" (the agent isn't running and the person asked to be asked).
  const [pending, setPending] = useState<string | null>(null);
  const stage = useStageActions(item.slug);
  const wakeAgent = useWakeAgent(item.slug);
  // the raw log of work this machine started is read on the machine itself
  const via = useAuthStatus().data?.via;
  const canWake = !!useInfo()?.capabilities?.wakeAgents;
  const machine = via === 'local' && canWake;
  const done = async (p: Promise<boolean>) => {
    if (await p) onDone(item.key);
  };
  // "Later" for any item: off the list at once, back tomorrow at 9:00 or once its video moves (with Undo)
  const later = (
    <IconButton
      className="btn ghost sm icon-only"
      label={t('Later')}
      tip={t('Later: back {when}, or once its video moves', { when: whenWords(laterUntil()) })}
      shortcut="H"
      icon="clock"
      size={14}
      onClick={() => {
        actions.later([item]);
        onDone(item.key);
      }}
      data-testid="inbox-pv-later"
    />
  );
  // The answer; with "start", the agent is started to read it (agent-facing words stay English).
  const answer = async (a: string, how?: 'start' | 'send') => {
    const way = how ?? (!wake?.possible || wake.pref === 'send' ? 'send' : wake.pref === 'start' ? 'start' : 'ask');
    if (way === 'ask') return setPending(a);
    const ok = await actions.answer(item, a);
    if (ok && way === 'start')
      wakeAgent
        .mutateAsync(`Your question on ${item.video} was answered: "${a}". Read the answer and go on.`)
        .then((r) => r.run && toast(t('Started {name} to read your answer', { name: who(item.by) }), 'ok'))
        .catch(toastError);
    if (ok) onDone(item.key);
  };
  if (item.kind === 'question' && pending !== null)
    return (
      <div className="inbox-act">
        <WakeAsk
          name={who(item.by)}
          folder={wake?.folder ?? ''}
          quote={pending}
          busy={wakeAgent.isPending}
          onStart={() => answer(pending, 'start')}
          onSend={() => answer(pending, 'send')}
        />
      </div>
    );
  // Options to audition: their own view; the picks are the answer (Later and Done stay here).
  if (item.kind === 'question' && item.options?.length)
    return (
      <div className="inbox-act">
        <OptionsAsk id={item.id as string} text={item.text ?? ''} by={item.by ?? ''} groups={item.options} size="md" onSent={() => onDone(item.key)} />
        <div className="inbox-act-row">
          {agent && (
            <span className="inbox-act-status" data-testid="inbox-agent-state">
              <KeyGlyph shape={agent === 'running' ? 'ease' : 'outline'} className={`nav-kg ${agent === 'running' ? 'live' : ''}`} />
              {agent === 'running' ? t('Running · gets it now') : t('Not running · gets it when it starts')}
            </span>
          )}
          {later}
          <Tip content={t('Close it without an answer')} shortcut="E">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                actions.done(item);
                onDone(item.key);
              }}
              data-testid="inbox-pv-done"
            >
              {t('Done')}
            </button>
          </Tip>
        </div>
      </div>
    );
  if (item.kind === 'question')
    return (
      <form
        className="inbox-act"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) answer(text.trim());
        }}
      >
        {choices?.length ? <Choices choices={choices} name={who(item.by)} onPick={(c) => answer(c)} /> : null}
        <textarea
          className="textarea inbox-answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={t('Answer {name}…', { name: who(item.by) })}
          rows={2}
          aria-label={t('Answer {who}', { who: who(item.by) })}
        />
        <div className="inbox-act-row">
          {agent && (
            <span className="inbox-act-status" data-testid="inbox-agent-state">
              <KeyGlyph shape={agent === 'running' ? 'ease' : 'outline'} className={`nav-kg ${agent === 'running' ? 'live' : ''}`} />
              {agent === 'running' ? t('Running · gets it now') : t('Not running · gets it when it starts')}
            </span>
          )}
          {later}
          <Tip content={t('Close it without an answer')} shortcut="E">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                actions.done(item);
                onDone(item.key);
              }}
              data-testid="inbox-pv-done"
            >
              {t('Done')}
            </button>
          </Tip>
          <button type="submit" className="btn primary sm" disabled={!text.trim()} data-keys="⌘↵">
            <I name="reply" size={14} /> {t('Answer')}
          </button>
        </div>
      </form>
    );
  if (item.kind === 'verify')
    return still ? (
      <form
        className="inbox-act"
        onSubmit={(e) => {
          e.preventDefault();
          if (!held) done(actions.stillWrong(item, text.trim()));
        }}
        data-testid="inbox-pv-reason"
      >
        <textarea
          className="textarea inbox-answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('What is still wrong? (optional)')}
          rows={2}
          aria-label={t('What is still wrong')}
        />
        <div className="inbox-act-row">
          {/* typed or said: the words land in the text above, to edit before it goes back */}
          <SayButton onSaid={(said) => setText((x) => withSaid(x, said))} onHold={setHeld} />
          <button type="button" className="btn ghost sm" onClick={() => setStill(false)}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn sm" disabled={held}>
            {t('Keep it open')}
          </button>
        </div>
      </form>
    ) : (
      <div className="inbox-act-row">
        {later}
        <button type="button" className="btn ghost sm" onClick={() => setStill(true)}>
          {t('Still wrong')}
        </button>
        <a className="btn ghost sm" href={openHref(item)}>
          {t('Compare')}
        </a>
        <button type="button" className="btn primary sm" onClick={() => done(actions.verify(item))}>
          <I name="check" size={14} /> {t('Looks right')}
        </button>
      </div>
    );
  if (item.kind === 'stalled')
    return (
      <div className="inbox-act-row">
        {later}
        <StalledActions item={item} actions={actions} done={done} />
      </div>
    );
  if (item.run)
    return (
      <div className="inbox-act-row">
        {later}
        <RunActs item={item} actions={actions} done={done} log={machine} />
      </div>
    );
  if (item.kind === 'post')
    return (
      <div className="inbox-act-row">
        {later}
        <a className={actions.canRetry ? 'btn ghost sm' : 'btn primary sm'} href={openHref(item)} data-testid="inbox-post-open">
          {t('Open the post')}
        </a>
        <PostRetry item={item} actions={actions} done={done} />
      </div>
    );
  if (item.kind === 'review' && item.v)
    return (
      <div className="inbox-act-row">
        {later}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            done(
              actions.act(
                item,
                () => stage.verdict.mutateAsync({ status: 'changes', v: item.v as number }),
                t('Changes requested on V{v}', { v: item.v ?? '' }),
              ),
            )
          }
        >
          {t('Request changes')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          onClick={() =>
            done(actions.act(item, () => stage.verdict.mutateAsync({ status: 'approved', v: item.v as number }), t('Approved V{v}', { v: item.v ?? '' })))
          }
        >
          <I name="check" size={14} /> {t('Approve V{v}', { v: item.v })}
        </button>
      </div>
    );
  return (
    <div className="inbox-act-row">
      {later}
      <button type="button" className="btn primary sm" onClick={() => done(actions.gotIt(item))}>
        <I name="check" size={14} /> {item.kind === 'client' ? t('Seen') : t('Got it')}
      </button>
    </div>
  );
}
