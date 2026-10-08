// One video behind a review link, at parity with the main player where it matters to a client: frame-exact stepping
// and speed, drawing on the frame, notes with replies, "fixed, please check", approval, versions and downloads when
// the link allows them. Keyboard: Space plays, ←/→ steps a frame (Shift: 10), C writes a note, Esc drops the marks.
// On a phone it is an app's screen: one compact bar (the title, Approve, the rest behind ⋯) that stays at the top,
// the picture across the width with the drawing tools under it, one transport row, then the notes. A link that neither
// takes notes nor has any to show has no notes panel at all: the video gets the room, the foot goes under the dock.
// A link that shows every version compares two of them (GuestCompare.tsx; B, or Compare beside the version): the one
// on screen (A, what the notes and the verdict are about) and another as the reference, side by side or as a wipe.
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawingMarkup } from '../../../lib/drawing.ts';
import { timecode } from '../../../lib/time.ts';
import type { GuestFoot } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { useGuestWaveform } from '../api/queries.ts';
import type { FrameRange, GuestNote, GuestReview, GuestVideo, Shape, Tool, Version } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { useMedia, usePhone, useTouch } from '../lib/media.ts';
import { toast, toastError } from '../lib/toast.ts';
import { CompareBar } from '../player/CompareBar.tsx';
import { DrawBar } from '../player/DrawBar.tsx';
import { type FrameStore, useFrame, useFrameValue } from '../player/frameStore.ts';
import { groupStarts, noteAt } from '../player/noteRows.ts';
import Stage, { type Pane } from '../player/Stage.tsx';
import Timeline from '../player/Timeline.tsx';
import { RATES, usePlayback } from '../player/usePlayback.ts';
import type { AbState } from '../player/useVerify.ts';
import { inlineBody, removeRef, sendRef } from '../refs/api.ts';
import { usePendingRefs } from '../refs/RefTools.tsx';
import { Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { BrandMark, I } from '../ui/icons.tsx';
import { IconButton, Menu, type MenuEntry, Tip } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import { ThemeButton, useThemeChoice } from '../ui/ThemeSwitch.tsx';
import { type CompareState, canCompare, defaultB, GUEST_MODES, keepMode, startCompare, useCompareSide } from './GuestCompare.tsx';
import { GUEST_TOOLS, GuestComposer, GuestNoteCard, NameDialog } from './GuestNotes.tsx';
import { useGuestActions } from './guest.ts';
import { PoweredBy } from './PoweredBy.tsx';
import { useWatchReport } from './watch.ts';

/** On a phone the picture runs across the width with this much room around it (guest.css: --sp-2)… */
const PHONE_PAD = 8;
/** …and the drawing tools get a strip of their own under it, never over the picture (guest.css: --g-tools). */
const TOOLS_ROOM = 48;
/** Comparing, the compare bar holds the stage's top (guest.css: --g-cmp on a phone, where it is a row of its own)… */
const COMPARE_ROOM = 52;
/** …and two pictures side by side keep less room around each, so each is as large as it can be. */
const SIDE_PAD = 20;

interface Props {
  d: GuestReview;
  token: string;
  name: string;
  setName: (n: string) => void;
  /** Another version; `keep`: while comparing (a swap, another A), the frame on screen and the compare go along. */
  onVersion: (v: number | null, keep?: { frame: number; compare: CompareState | null }) => void;
  /** The compare open on this video (kept by Guest.tsx, so it outlives a switch of version), or null. */
  compare?: CompareState | null;
  onCompare?: (c: CompareState | null) => void;
  /** The frame to open on (after a swap). */
  startFrame?: number | null;
  onBack?: () => void;
  roomLabel?: string;
  /** A folder link's videos (for "2 of 3 reviewed" and the next one to review). */
  room?: { videos: GuestVideo[]; onOpen?: (slug: string) => void };
  /** The page's foot from the link's answer: the source offer, the operator's legal pages. */
  foot?: GuestFoot | null;
}

/** A video counts as reviewed once the visitor gave a verdict on the version the link shows now. */
const reviewed = (v: GuestVideo) => !!v.approval && v.approval.v === v.v;

export function GuestPlayer({
  d,
  token,
  name,
  setName,
  onVersion,
  compare = null,
  onCompare = () => {},
  startFrame = null,
  onBack,
  roomLabel,
  room,
  foot,
}: Props) {
  const { fps, frames: N, width: W, height: H } = d;
  // usePlayback wants a Version; a guest only knows what the link shows of it.
  const ver = useMemo(() => ({ v: d.v, fps, frames: N, width: W, height: H, duration: d.duration }) as Version, [d.v, fps, N, W, H, d.duration]);
  // B of a compare: only where the link shows every version (canCompare); the server refuses it anywhere else too
  const comparable = canCompare(d);
  // a kept compare whose B is on screen now (a reload opens the newest) or no longer shown takes the usual B instead
  const cmp =
    comparable && compare
      ? d.versions.some((x) => `v:${x.v}` === compare.key && x.v !== d.v)
        ? compare
        : { ...compare, key: `v:${defaultB(d, name)}` }
      : null;
  const other = useCompareSide(token, d, cmp);
  // `quiet`: while it plays, only what shows the frame renders per frame (the timecode, the playhead, the note at the
  // playhead: frameStore.ts), as in the team's player — the whole page did, 25 times a second (a phone's play stuttered)
  // …and a phone plays the copy made for it once it exists (lib/types.ts GuestReview `phoneMedia`)
  const pb = usePlayback({ ver, url: d.phoneMedia ?? d.media, startFrame: startFrame === null ? null : String(startFrame), b: other.b, quiet: true });
  // the frame the page last rendered: where playback stopped or a seek landed (the frame on screen is `pb.live`)
  const { frame } = pb;
  // How far this visitor watches, for the link's owner (coarse).
  useWatchReport({ token, slug: d.slug, v: d.v, video: pb.videoRef, playing: pb.playing, name });
  const wave = useGuestWaveform(d.waveform).data;
  const act = useGuestActions(token);
  const [tool, setTool] = useState<Tool>('none');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [text, setText] = useState('');
  const [idea, setIdea] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const perms = d.perms;
  const latest = d.v === d.latest;
  const phone = usePhone();
  const touch = useTouch();
  // where the timeline's zoom goes: beside the speed and the sound (a phone: the timeline's own row above the ruler)
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  const theme = useThemeChoice();
  const sharer = d.reviewer ?? undefined;

  // ---------------------------------------------------------------- compare
  const comparing = cmp !== null && other.bv !== null;
  const upright = useMedia('(max-width: 639px)');
  const toggleCompare = useCallback(() => onCompare(cmp ? null : startCompare(d, name)), [cmp, d, name, onCompare]);
  const setAb = (next: AbState) => {
    if (!next) return onCompare(null);
    if (next.mode !== cmp?.mode) keepMode(next.mode);
    onCompare(next);
  };
  /** Another version on screen; while comparing, the frame stays and B stays (or takes A's place when it is the one picked). */
  const showVersion = (x: number) => {
    if (x === d.v) return;
    const to = x === d.latest ? null : x;
    if (!cmp) return onVersion(to);
    pb.pause();
    onVersion(to, { frame: pb.frameRef.current, compare: x === other.bv ? { ...cmp, key: `v:${d.v}` } : cmp });
  };
  const swap = () => other.bv !== null && showVersion(other.bv);

  // The name is asked when it is first needed: in the composer when the first note is sent (askInline), in a small
  // dialog when Approve, a reply or a check needs it, or to change it (asking).
  const [askInline, setAskInline] = useState(false);
  const [asking, setAsking] = useState<{ run?: (who: string) => void; cancel?: () => void } | null>(null);
  /** Runs `fn` with the visitor's name, asking for it first when there is none yet. */
  const withName = <R,>(fn: (who: string) => Promise<R>): Promise<R> => {
    if (name.trim()) return fn(name.trim());
    return new Promise<R>((resolve, reject) =>
      setAsking({ run: (who) => fn(who).then(resolve, reject), cancel: () => reject(new Error(t('client::Please enter your name first'))) }),
    );
  };
  const pending = usePendingRefs(true);
  // The stretch a note is about: the timeline's in/out (drawn there or with "Add end"), cleared once the note is sent.
  const range = pb.inPt != null && pb.outPt != null ? { in: Math.min(pb.inPt, pb.outPt), out: Math.max(pb.inPt, pb.outPt) } : null;
  const { setIn, setOut } = pb;
  const setRange = useCallback(
    (r: FrameRange | null) => {
      setIn(r ? r.in : null);
      setOut(r ? r.out : null);
    },
    [setIn, setOut],
  );
  /** `given`: the name the composer just asked for (the visitor's first note). */
  const send = async (given?: string) => {
    if (!text.trim() && !shapes.length && !pending.refs.length) return;
    const who = given?.trim().slice(0, 40) || name.trim();
    if (!who) {
      setAskInline(true);
      return;
    }
    if (given) {
      setName(given);
      setAskInline(false);
    }
    try {
      const inline = pending.refs.map(inlineBody).filter((x): x is Record<string, unknown> => !!x);
      const c = await act.note.mutateAsync({
        name: who,
        slug: d.slug,
        v: d.v,
        // a range without a mark on the picture: the note sits on its first frame; else the frame on screen
        frame: range && !shapes.length ? range.in : pb.frameRef.current,
        ...(range ? { range } : {}),
        text,
        drawing: shapes,
        idea,
        ...(inline.length ? { refs: inline } : {}),
      });
      // Pictures and clips go up once the note exists; one that fails leaves the note as it is.
      const files = pending.refs.filter((p) => p.kind === 'file');
      for (const p of files)
        try {
          await sendRef({ kind: 'guest', token, comment: c.id, name: who }, p, { onProgress: (share) => pending.onProgress(p.key, share) });
        } catch (e) {
          toastError(e);
        }
      pending.clear();
      if (files.length) await act.refresh();
      toast(t('client::Note added at {timecode}', { timecode: c.timecode }), 'ok');
      setText('');
      setIdea(false);
      setShapes([]);
      setTool('none');
      setRange(null);
      setSelected(c.id);
    } catch (e) {
      toastError(e);
    }
  };
  // After a verdict: a thank-you under the top bar that says who hears about it and, in a room, what's next.
  const [thanks, setThanks] = useState<'approved' | 'changes' | null>(null);
  // "Change your answer": the two buttons come back next to the verdict.
  const [rethink, setRethink] = useState(false);
  const decide = (status: 'approved' | 'changes') => {
    if (name.trim()) return decideAs(name.trim(), status);
    // no name yet: asked first; closing the question decides nothing
    setAsking({ run: (who) => decideAs(who, status) });
  };
  const decideAs = async (who: string, status: 'approved' | 'changes') => {
    try {
      await act.approve.mutateAsync({ name: who, slug: d.slug, v: d.v, status });
      setThanks(status);
      setRethink(false);
    } catch (e) {
      // A newer render arrived while they watched: the page shows it now (refreshed after the answer), nothing recorded.
      if (e instanceof ApiError && e.status === 409 && typeof e.details.latest === 'number')
        toast(t('client::V{v} arrived while you were watching. Have a look at it first.', { v: e.details.latest }), 'info');
      else toastError(e);
    }
  };
  const others = room ? room.videos.filter((x) => x.slug !== d.slug) : [];
  const nextUp = others.find((x) => !reviewed(x)) || null;
  const done = room ? room.videos.filter((x) => (x.slug === d.slug ? !!thanks || (!!d.approval && d.approval.v === d.v) : reviewed(x))).length : 0;

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      // keys typed in a field, a menu or a dialog (the name's) are theirs: Esc there must not drop the marks
      if ((e.target as Element | null)?.closest?.('input, textarea, [role="menu"], [role="listbox"], [role="dialog"]')) return;
      if (e.key === ' ') {
        e.preventDefault();
        pb.playing ? pb.pause() : pb.play();
      } else if (e.key === 'ArrowLeft') pb.seek(pb.frameRef.current - (e.shiftKey ? 10 : 1));
      else if (e.key === 'ArrowRight') pb.seek(pb.frameRef.current + (e.shiftKey ? 10 : 1));
      else if ((e.key === 'c' || e.key === 'C') && perms.comment && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pb.pause();
        composer.current?.focus();
      } else if ((e.key === 'i' || e.key === 'o') && perms.comment && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // the section starts / ends on the frame on screen, as in the player (and the composer's "Start at" / "End at"):
        // an in after the out (or an out before the in) starts a new one
        const f = pb.frameRef.current;
        if (e.key === 'i') {
          if (pb.outPt != null && f > pb.outPt) pb.setOut(null);
          pb.setIn(f);
        } else {
          if (pb.inPt != null && f < pb.inPt) pb.setIn(null);
          pb.setOut(f);
        }
      } else if (e.key === 'Enter' && perms.comment && range && !e.metaKey && !e.ctrlKey && !(e.target as Element | null)?.closest?.('button, a[href]')) {
        // ↵ on a marked section: write the note on it
        e.preventDefault();
        pb.pause();
        composer.current?.focus();
      } else if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent('vr-zoom', { detail: e.shiftKey ? 'fit' : 'section' }));
      } else if ((e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent('vr-zoom', { detail: e.key === '0' ? 'fit' : e.key === '-' ? 'out' : 'in' }));
      } else if ((e.key === 'b' || e.key === 'B') && comparable && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleCompare();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        // (an Escape that closed a menu or popover is theirs: the drawing stays) — the marks and the section go; with
        // none, the compare closes: one thing per Esc
        if (cmp && tool === 'none' && !shapes.length && !range) return onCompare(null);
        setTool('none');
        setShapes([]);
        setRange(null);
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [pb, perms.comment, range, setRange, comparable, toggleCompare, cmp, tool, shapes.length, onCompare]);

  const notes = d.notes;
  // A note's marked frame has its own version's frame size. A newest-only link lists the shown version alone: an
  // older one's note takes the shown size, which the renders of one video keep.
  const shotSize = (c: GuestNote) => {
    const own = d.versions.find((x) => x.v === c.v);
    return own?.width && own.height ? { width: own.width, height: own.height } : { width: W, height: H };
  };
  // The notes panel is there for a link that takes notes, or shows some (read only); a watch-only link with nothing to
  // show has none.
  const notesPanel = perms.comment || notes.length > 0;
  // The line under the video's name: whose review it is (the link's own name, else the sharer's workspace, else who
  // shared it), the version and, in a room, how far the visitor got — never a role like "client".
  const whose = d.label || d.org || (d.reviewer ? t('client::Shared by {name}', { name: d.reviewer }) : '');
  const subtitle = [whose, `V${d.v}`, room ? t('client::{done} of {n} reviewed', { done, n: room.videos.length }) : ''].filter(Boolean).join(' · ');
  // Drawings of the notes on the paused frame; the selected one in full red.
  const marks = pb.playing
    ? ''
    : notes
        .filter((c) => c.drawing?.length && c.frameHere === frame && (c.status === 'open' || c.status === 'fixed' || c.id === selected))
        .map((c) => drawingMarkup(c.drawing, W, H, c.id === selected ? '#ff2d55' : 'rgba(255,45,85,0.75)'))
        .join('');
  // the list as the app's: a group header where the writer or the sitting changes, the note at the playhead marked
  // (held a second past its frame while playing)
  const starts = useMemo(() => groupStarts(notes), [notes]);
  const hold = pb.playing ? Math.round(fps) : 0;
  const here = useFrameValue(pb.live, (f) => noteAt(notes, f, hold) ?? null);
  const select = (id: string) => {
    const c = notes.find((x) => x.id === id);
    if (!c) return;
    setSelected(id);
    pb.seek(c.frameHere);
  };
  const approval = d.approval;
  const verdictShown = !!approval && !rethink;
  const canDecide = perms.approve && latest;
  const versionLabel = (v: number) => (v === d.latest ? t('client::V{v} · newest', { v }) : `V${v}`);
  const downloads: MenuEntry[] = [
    !!d.download.preview && {
      label: t('client::Preview V{v} (MP4)', { v: d.v }),
      icon: 'film',
      onClick: () => location.assign(d.download.preview as string),
    },
    !!d.download.original && {
      label: t('client::Original V{v}', { v: d.v }),
      icon: 'download',
      onClick: () => location.assign(d.download.original as string),
    },
  ];
  // Downloads are a button in the bar — on a phone too where nothing asks for a verdict there (a delivery: the download
  // is the point of the link); a phone's bar that holds Approve has them in ⋯.
  const downloadInBar = !!(d.download.preview || d.download.original) && (!phone || !canDecide);
  // A phone's bar holds the title and Approve; the rest — the other answer, versions, downloads, the theme — is here.
  const more: MenuEntry[] = [
    canDecide && !verdictShown && { label: t('client::Request changes'), icon: 'undo', onClick: () => decide('changes') },
    canDecide && verdictShown && { label: t('client::Change your answer'), icon: 'edit', onClick: () => setRethink(true) },
    'sep',
    d.versions.length > 1 && { heading: t('client::Version') },
    ...(d.versions.length > 1
      ? [...d.versions].reverse().map((x) => ({
          label: versionLabel(x.v),
          checked: x.v === d.v,
          onClick: () => showVersion(x.v),
        }))
      : []),
    comparable && { label: t('client::Compare versions'), icon: 'compare', checked: !!cmp, onClick: toggleCompare },
    'sep',
    ...(downloadInBar ? [] : downloads),
    'sep',
    theme,
  ];
  // What to do, said once: under the composer while the list is empty (a finger has no C key), not again above it.
  const kbd = (c: ReactNode) => <kbd>{c}</kbd>;
  const howTo = touch ? (
    d.reviewer ? (
      t('client::Pause where something should change and write it down. It goes straight to {name}.', { name: d.reviewer })
    ) : (
      t('client::Pause where something should change and write it down.')
    )
  ) : d.reviewer ? (
    <T
      k="client::Pause where something should change, press <0>C</0> and write it down. It goes straight to {name}."
      values={{ name: d.reviewer }}
      tags={[kbd]}
    />
  ) : (
    <T k="client::Pause where something should change, press <0>C</0> and write it down." tags={[kbd]} />
  );

  // Compare's pictures: A (the notes, the drawing, the verdict) and B, the reference, each named on its picture. Side by
  // side they stand in a row; on an upright phone two landscape pictures stand one above the other, each across the
  // width (guest.css sizes the stage for them: --g-across, --g-down).
  const side = comparing && cmp.mode === 'side';
  const stackable = upright && W >= H;
  const column = side && stackable;
  const bSize = other.b ?? { W, H };
  const tagA = comparing ? (
    <>
      <b>A</b>V{d.v}
    </>
  ) : undefined;
  const tagB = comparing ? (
    <>
      <b>B</b>V{other.bv}
      <i>{other.note ? t('client::getting ready') : t('client::reference')}</i>
    </>
  ) : undefined;
  const paneA: Pane = {
    key: 'g',
    src: pb.src,
    W,
    H,
    videoRef: pb.setVideo,
    marks,
    tag: tagA,
    draw:
      perms.comment && tool !== 'none' && !(phone && comparing)
        ? { tool, shapes, onAdd: (s) => setShapes((x) => [...x, s]) }
        : shapes.length
          ? { tool: 'none', shapes, onAdd: () => {} }
          : null,
  };
  if (comparing && cmp.mode === 'wipe')
    paneA.wipe = {
      src: other.b?.src ?? null,
      label: '',
      videoRef: pb.setB,
      mode: 'wipe',
      pos: cmp.pos,
      setPos: (pos) => onCompare({ ...cmp, pos }),
      blend: 'difference',
      opacity: 1,
      tag: tagB,
    };
  const panes: Pane[] = [paneA];
  if (side) panes.push({ key: `b-${other.bv}`, src: other.b?.src, W: bSize.W, H: bSize.H, videoRef: pb.setB, muted: true, tag: tagB, note: other.note });
  const compareBar = comparing && (
    <CompareBar
      ab={cmp}
      setAb={setAb}
      versions={d.versions}
      v={d.v}
      latestV={d.latest}
      // a phone's row has room for the numbers alone
      nameOf={phone ? (x) => `V${x}` : versionLabel}
      onPickA={showVersion}
      onSwap={swap}
      onClose={() => onCompare(null)}
      modes={GUEST_MODES}
      iconModes={phone}
      stacked={stackable}
      client
    />
  );

  return (
    <main
      className={`guest g-player ${perms.comment ? '' : 'view-only'} ${notesPanel ? '' : 'no-notes'}`}
      style={
        {
          '--ar': H / W,
          ...(comparing ? { '--g-across': side && !column ? 2 : 1, '--g-down': column ? 2 : 1 } : {}),
        } as CSSProperties
      }
      data-compare={comparing ? cmp.mode : undefined}
      data-testid="g-player"
    >
      <div className="topbar grain g-top">
        {onBack ? (
          <IconButton
            className="btn ghost icon-only"
            label={roomLabel ? t('client::Back to {room}', { room: roomLabel }) : t('client::Back to the room')}
            icon="back"
            onClick={onBack}
            side="bottom"
          />
        ) : (
          <BrandMark />
        )}
        <div className="p-title grow">
          <h1 className="ellipsis">{d.name}</h1>
          <span className="ellipsis" data-testid="g-subtitle">
            {subtitle}
            {!latest ? t('client:: · newest is V{latest}', { latest: d.latest }) : ''}
          </span>
        </div>
        <div className="g-top-acts">
          {!phone && <ThemeButton />}
          {!phone && d.versions.length > 1 && (
            <Select
              label={t('client::Version')}
              style={{ height: 28, fontSize: 12 }}
              value={String(d.v)}
              onChange={(v) => showVersion(Number(v))}
              options={[...d.versions].reverse().map((x) => ({ value: String(x.v), label: versionLabel(x.v) }))}
            />
          )}
          {!phone && comparable && (
            <Tip content={t('client::Compare two versions')} shortcut="B" side="bottom">
              <button
                type="button"
                className={`btn sm ${cmp ? 'on' : ''}`}
                onClick={toggleCompare}
                aria-pressed={!!cmp}
                aria-label={t('client::Compare')}
                data-testid="g-compare"
              >
                <I name="compare" size={14} /> <span className="g-hide-sm">{t('client::Compare')}</span>
              </button>
            </Tip>
          )}
          {downloadInBar && (
            <Menu
              trigger={
                <button type="button" className="btn sm" aria-label={t('client::Download')} data-testid="g-download">
                  <I name="download" size={14} /> <span className={phone ? '' : 'g-hide-sm'}>{t('client::Download')}</span>
                </button>
              }
              items={downloads}
            />
          )}
          {verdictShown ? (
            <span className="g-verdict" data-status={approval.status}>
              <I name={approval.status === 'approved' ? 'check' : 'undo'} size={14} />
              {phone
                ? approval.status === 'approved'
                  ? t('client::Approved')
                  : t('client::Changes requested')
                : approval.status === 'approved'
                  ? t('client::You approved V{v}', { v: approval.v })
                  : t('client::You asked for changes')}
              {!phone && canDecide && (
                <button type="button" className="g-verdict-change" onClick={() => setRethink(true)}>
                  {t('client::Change your answer')}
                </button>
              )}
            </span>
          ) : (
            canDecide && (
              <>
                {!phone && (
                  <button type="button" className="btn sm" onClick={() => decide('changes')} disabled={act.approve.isPending} data-testid="g-changes">
                    <I name="undo" size={14} /> <span className="g-hide-sm">{t('client::Request changes')}</span>
                  </button>
                )}
                <button type="button" className="btn sm primary" onClick={() => decide('approved')} disabled={act.approve.isPending} data-testid="g-approve">
                  <I name="check" size={14} /> {t('client::Approve')}
                </button>
              </>
            )
          )}
          {phone && (
            <Menu
              trigger={<IconButton className="btn ghost icon-only sm g-more" label={t('client::More')} icon="more" size={18} data-testid="g-more" />}
              items={more}
            />
          )}
        </div>
      </div>
      {thanks && (
        <div className="g-thanks" role="status" data-status={thanks}>
          <I name={thanks === 'approved' ? 'check' : 'undo'} size={16} />
          <span className="grow">
            {thanks === 'approved'
              ? d.reviewer
                ? t('client::Thanks, {name} — {sharer} has been told you approved V{v}.', { name, sharer: d.reviewer, v: d.v })
                : t('client::Thanks, {name} — the team has been told you approved V{v}.', { name, v: d.v })
              : d.reviewer
                ? t('client::Thanks, {name} — {sharer} sees your notes and will send a new version.', { name, sharer: d.reviewer })
                : t('client::Thanks, {name} — the team sees your notes and will send a new version.', { name })}
            {room && <span className="g-thanks-count"> {t('client::{done} of {n} reviewed.', { done, n: room.videos.length })}</span>}
          </span>
          {room?.onOpen && nextUp && (
            <button type="button" className="btn sm primary" onClick={() => room.onOpen?.(nextUp.slug)}>
              {t('client::Next: {name}', { name: nextUp.name })} <I name="right" size={14} />
            </button>
          )}
          {room && !nextUp && onBack && (
            <button type="button" className="btn sm" onClick={onBack}>
              {t('client::Back to all videos')}
            </button>
          )}
          <IconButton className="btn ghost sm icon-only" label={t('client::Close')} icon="x" size={14} onClick={() => setThanks(null)} />
        </div>
      )}
      <Stage
        preset={null}
        phone={null}
        pad={phone ? PHONE_PAD : side ? SIDE_PAD : undefined}
        reserveTop={comparing ? COMPARE_ROOM : 0}
        reserveBottom={phone && perms.comment && !comparing ? TOOLS_ROOM : 0}
        message={d.media ? null : d.preparing ? t('client::Getting the video ready…') : t('client::This version can’t be played right now.')}
        panes={panes}
        arrange={column ? 'column' : 'row'}
      />
      {/* the compare bar: over the top of the stage (a phone: the stage's first row) */}
      {compareBar && <div className="g-cmp-layer">{compareBar}</div>}
      {/* the drawing tools, for a link that takes notes: on the picture while it's paused; on a phone in their own strip
          under it, always there (a tool picked while it plays pauses it). Comparing, they stand over A and draw on it; a
          phone compares to look (its strip would lie under both pictures): × and they are back. */}
      {perms.comment && (phone ? !comparing : !pb.playing) && (
        <DrawBar
          tools={GUEST_TOOLS()}
          tool={tool}
          onTool={(x) => {
            if (pb.playing) pb.pause();
            setTool(tool === x ? 'none' : x);
          }}
          onUndo={() => setShapes((x) => x.slice(0, -1))}
          canUndo={shapes.length > 0}
          label={t('client::Mark the frame')}
          undoLabel={t('client::Undo last mark')}
          under={comparing && !phone}
        />
      )}
      <div className="dock grain">
        <div className="transport g-transport">
          <div className="group">
            <IconButton
              className="btn sm icon-only ghost"
              label={t('client::Previous frame')}
              tip={t('client::Previous frame (⇧ 10 back)')}
              shortcut="←"
              icon="stepBack"
              onClick={() => pb.seek(pb.frameRef.current - 1)}
            />
            <IconButton
              className={`playbtn ${pb.playing ? 'playing' : ''}`}
              label={pb.playing ? t('client::Pause') : t('client::Play')}
              shortcut="Space"
              icon={pb.playing ? 'pause' : 'play'}
              size={16}
              onClick={() => (pb.playing ? pb.pause() : pb.play())}
            />
            <IconButton
              className="btn sm icon-only ghost"
              label={t('client::Next frame')}
              tip={t('client::Next frame (⇧ 10 ahead)')}
              shortcut="→"
              icon="stepFwd"
              onClick={() => pb.seek(pb.frameRef.current + 1)}
            />
            <GuestTimecode live={pb.live} fps={fps} last={N - 1} />
          </div>
          <div className="group right">
            <Select
              label={t('client::Speed')}
              size="sm"
              value={String(pb.rate)}
              onChange={(r) => pb.setRate(Number(r))}
              options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
            />
            <IconButton
              className="btn sm icon-only ghost"
              label={pb.muted ? t('client::Unmute') : t('client::Mute')}
              icon={pb.muted ? 'mute' : 'volume'}
              onClick={() => pb.setMuted((m) => !m)}
              aria-pressed={pb.muted}
            />
            {!phone && (
              <>
                <div className="vsep" />
                <div className="tr-zoom-slot" ref={setZoomSlot} />
              </>
            )}
          </div>
        </div>
        <Timeline
          zoomAt={phone ? undefined : zoomSlot}
          frames={N}
          fps={fps}
          frame={frame}
          live={pb.live}
          onSeek={pb.seek}
          peaks={wave?.peaks}
          rms={wave?.rms}
          comments={notes.map((c) => ({
            id: c.id,
            status: c.status,
            author: `guest:${c.author}`,
            frameHere: c.frameHere,
            text: c.text,
            timecode: c.timecode,
            severity: c.idea ? 'idea' : 'should',
            rangeHere: c.rangeHere ?? null,
          }))}
          selected={selected}
          onSelect={(id) => {
            const c = notes.find((x) => x.id === id);
            if (c?.rangeHere) {
              setSelected(id);
              pb.playSegments([c.rangeHere]);
            } else select(id);
          }}
          inPt={pb.inPt}
          outPt={pb.outPt}
          onRange={
            perms.comment
              ? (r) => {
                  setRange(r);
                  pb.seek(r.in);
                  pb.pause();
                  composer.current?.focus();
                }
              : undefined
          }
          onRangeEdge={(edge, f) => (edge === 'in' ? pb.setIn(f) : pb.setOut(f))}
          // the composer is always there: a marked section is what the note being written is about
          writing={perms.comment && !!text.trim()}
          onMarkNote={
            perms.comment
              ? () => {
                  pb.pause();
                  composer.current?.focus();
                }
              : undefined
          }
          onMarkClear={() => setRange(null)}
          client
        />
      </div>
      {notesPanel ? (
        <div className="side grain">
          <div className="side-head g-side-head">
            <div className="g-notes-title">
              <h2>{t('client::Notes')}</h2>
              {notes.length > 0 && <span className="g-notes-count">{notes.length}</span>}
              <span className="grow" />
              {perms.comment && name && (
                <button
                  type="button"
                  className="g-who-btn"
                  onClick={() => setAsking({})}
                  aria-label={t('client::Writing as {name}. Change your name', { name })}
                  data-testid="g-who"
                >
                  <Avatar name={`guest:${name}`} size={20} kind="client" />
                  <span className="ellipsis">{name}</span>
                </button>
              )}
            </div>
            {!perms.comment && <div className="g-side-note">{t('client::Read only: this link doesn’t take new notes.')}</div>}
          </div>
          <div className="side-scroll">
            {perms.comment && (
              <GuestComposer
                ref={composer}
                frame={frame}
                fps={fps}
                frames={N}
                range={range}
                onRange={setRange}
                live={pb.live}
                onSeek={pb.seek}
                shapes={shapes.length}
                text={text}
                setText={setText}
                idea={idea}
                setIdea={setIdea}
                onSend={send}
                busy={act.note.isPending}
                pending={pending}
                askName={askInline && !name.trim()}
                sharer={sharer}
              />
            )}
            {notes.length ? (
              // a row each, the selected one open as its card, as in the app (NotesPanel.tsx)
              <div className="note-list">
                {notes.map((c) => (
                  <GuestNoteCard
                    key={c.id}
                    c={c}
                    v={d.v}
                    fps={fps}
                    shotSize={shotSize(c)}
                    onPlayRange={c.rangeHere ? () => c.rangeHere && pb.playSegments([c.rangeHere]) : undefined}
                    selected={selected === c.id}
                    here={here === c.id}
                    groupHead={starts.has(c.id)}
                    perms={perms}
                    onSelect={() => select(c.id)}
                    onReply={(text) => withName((who) => act.reply.mutateAsync({ id: c.id, name: who, text }))}
                    onRemoveRef={async (id) => {
                      await removeRef({ kind: 'guest', token, comment: c.id, name }, id);
                      await act.refresh();
                    }}
                    onCheck={(verdict, text) => withName((who) => act.check.mutateAsync({ id: c.id, name: who, verdict, text }))}
                  />
                ))}
              </div>
            ) : (
              // the composer above is the invitation: no "No notes yet" under it, just how it works, once
              <p className="g-howto" data-testid="g-notes-empty">
                {howTo}
              </p>
            )}
          </div>
          <PoweredBy foot={foot} />
        </div>
      ) : (
        <PoweredBy foot={foot} />
      )}
      {asking && (
        <NameDialog
          name={name}
          sharer={sharer}
          onClose={() => {
            asking.cancel?.();
            setAsking(null);
          }}
          onSave={(n) => {
            setName(n);
            setAsking(null);
            asking.run?.(n.trim().slice(0, 40));
          }}
        />
      )}
      {act.note.isPending && (
        <div className="g-sending">
          <Spinner /> {t('client::Saving the frame…')}
        </div>
      )}
    </main>
  );
}

/** The transport's timecode: the one part of the review page that follows playback frame by frame. */
function GuestTimecode({ live, fps, last }: { live: FrameStore; fps: number; last: number }) {
  const frame = useFrame(live);
  return (
    <div className="tc">
      <span className="main">{timecode(frame, fps)}</span>
      <span className="sub g-hide-sm">
        <span>
          F <b>{String(frame).padStart(4, '0')}</b> / {last}
        </span>
        <span>
          {Math.round(fps * 100) / 100} {t('client::FPS')}
        </span>
      </span>
    </div>
  );
}
