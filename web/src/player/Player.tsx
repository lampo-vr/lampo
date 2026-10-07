// The review player: frame-exact video, timeline, notes. State lives in hooks (usePlayback, useDiff, useQa,
// useVerify, useWalkie, useShortcuts); this file wires them to the pieces on screen.

import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectOfFolder } from '../../../lib/archived.ts';
import { stretchOf } from '../../../lib/findings.ts';
import { isOwner } from '../../../lib/ownership.ts';
import { rangeOnGrid } from '../../../lib/range.ts';
import { renderKey } from '../../../lib/renderKey.ts';
import { SETUP_AGENT_LABELS } from '../../../lib/sampleLoop.ts';
import { approvalsOf, verdictOn } from '../../../lib/stage.ts';
import { isAgent, isQuestion, isRequired, timecode, timeToFrame } from '../../../lib/time.ts';
import { ReadOnlyScope, useAuthStatus, useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { useSSE } from '../api/events.ts';
import { type NewComment, useCommentActions } from '../api/mutations.ts';
import { keys, useAnalysis, useAudience, useInfo, useLibrary, useReview, useTracks, useWaveform } from '../api/queries.ts';
import { useRuns } from '../api/runs.ts';
import { spriteUrl, useSprite } from '../api/sprite.ts';
import type { ActivityWords, DraftsSent, FrameRange, LibraryResponse, PlacedComment, QaItem, ReviewResponse, Shape, Tool } from '../api/types.ts';
import { billingCode } from '../billing/code.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { clamp, fileName } from '../lib/format.ts';
import { useHiddenNotes } from '../lib/hidden.ts';
import { useStableCallback } from '../lib/hooks.ts';
import { loader, useLoaded, usePainted } from '../lib/lazy.ts';
import { usePhone } from '../lib/media.ts';
import { backToLibrary } from '../lib/nav.ts';
import { usePrefs } from '../lib/prefs.ts';
import { errorMessage, toast, toastError } from '../lib/toast.ts';
import { archivedCode, useHeldArchive } from '../library/archiving.ts';
import { inlineBody, sendRef } from '../refs/api.ts';
import { GOTO_FRAME, type GotoFrame } from '../refs/model.ts';
import { say } from '../sessions/activityWords.ts';
import { useListening, useListenNudge } from '../sessions/listening.tsx';
import { isOpen, type RunLike } from '../sessions/runWords.ts';
import { useWakeChoice } from '../sessions/Wake.tsx';
import { ShareModal } from '../share/ShareModal.tsx';
import { I } from '../ui/icons.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { AutoCheck, FINDING } from './AutoCheck.tsx';
import { type RangePlay, showSampleAgentAs } from './CommentCard.tsx';
import { CompareBar } from './CompareBar.tsx';
import { COMPOSER_TOOLS, Composer, type ComposerPayload, type SaveHow } from './Composer.tsx';
import { DockFoot } from './DockFoot.tsx';
import { DrawBar } from './DrawBar.tsx';
import type { DraftFocus } from './drafts/Unsent.tsx';
import { useUnsent } from './drafts/useUnsent.ts';
import { findingWords } from './findingWords.ts';
import { HelpModal } from './HelpModal.tsx';
import { MicButton } from './MicButton.tsx';
import { frameMarks } from './marks.ts';
import { type Filter, NotesPanel, type PanelView, type SheetState } from './NotesPanel.tsx';
import { noteAt, stepNote, tagCounts, withTag } from './noteRows.ts';
import { PhoneTools, PhoneTransport } from './PhoneDock.tsx';
import { PlayerLoading } from './PlayerLoading.tsx';
import { PlayerTopbar } from './PlayerTopbar.tsx';
import { patchOf } from './partWords.ts';
import { deviceById } from './phone/devices.ts';
import type { PhoneView } from './phone/view.ts';
import { pendingPreview, previewSource, previewUrl } from './previews.ts';
import { ReviewHud } from './ReviewHud.tsx';
import { RunStrip } from './RunStrip.tsx';
import { RecordButton } from './record/RecordButton.tsx';
import { recordUi, useRecordFeedback } from './record/useRecordFeedback.ts';
import Stage, { type Pane } from './Stage.tsx';
import Timeline from './Timeline.tsx';
import { Transport } from './Transport.tsx';
import { useDiff } from './useDiff.ts';
import { type BSource, RATES, usePlayback } from './usePlayback.ts';
import { useQa } from './useQa.ts';
import { useShortcuts } from './useShortcuts.ts';
import { useTeamWatch } from './useTeamWatch.ts';
import { type AbState, type CompareMode, compareState, useVerify } from './useVerify.ts';
import { useWalkie } from './useWalkie.ts';
import { VerifyPanel } from './VerifyPanel.tsx';
import { WalkieHud } from './WalkieHud.tsx';
import { orientOf, presetById, presetsFor } from './zones.ts';

/** The side panel's Agent view: loaded when it is first opened (or the strip is pointed at). */
const agentViewCode = loader(() => import('./AgentView.tsx'));
/** A day: how long work that ended badly (failed, stopped) stays on the strip. */
const DAY_MS = 24 * 3600_000;
/** "Not sent yet" in the notes panel: loaded once there is something to show in it. */
const unsentUi = loader(() => import('./drafts/Unsent.tsx'));
/** Publishing a final version (publish/Publishing.tsx): loaded when "Publish…" is chosen or the address asks for it. */
const publishUi = loader(() => import('../publish/Publishing.tsx'));

interface PlayerProps {
  slug: string;
  focus: string | null;
  startFrame: string | null;
  /** Open this version (?v=), e.g. from a frame reference. */
  startV?: string | null;
  /** Open verify mode at this note (?verify=<id>). */
  verifyAt?: string | null;
  /** Drawn before the server has said who you are (App's loading state): the player's loading layout, nothing asked. */
  pending?: boolean;
}

/** The sample's "That's the loop" (onboarding/LoopDone.tsx): loaded only while the sample is open. */
const loopDoneCode = loader(() => import('../onboarding/LoopDone.tsx'));

export default function Player({ slug, focus, startFrame, startV = null, verifyAt = null, pending = false }: PlayerProps) {
  const { data, error } = useReview(pending ? null : slug);
  const phone = usePhone();
  // The library already knows the video's shape: tablets size the stage by it while the review loads.
  const known = useQueryClient()
    .getQueryData<LibraryResponse>(keys.library)
    ?.videos.find((v) => v.slug === slug);
  if (error && !data)
    return (
      <div className="page">
        <div className="topbar">
          <button type="button" className="btn ghost sm" onClick={backToLibrary}>
            <I name="back" size={16} /> {t('Library')}
          </button>
        </div>
        <EmptyState
          art="error"
          titleAs="h2"
          title={t('This video can’t be opened')}
          action={
            <Button variant="primary" onClick={backToLibrary}>
              {t('Back to the library')}
            </Button>
          }
        >
          {error.message}
        </EmptyState>
      </div>
    );
  if (!data)
    return (
      <PlayerLoading slug={slug} phone={phone} ar={known?.width ? known.height / known.width : undefined} agent={!!known && (!!known.session || !!known.run)} />
    );
  return <PlayerView data={data} slug={slug} focus={focus} startFrame={startFrame} startV={startV} verifyAt={verifyAt} />;
}

/**
 * A post of this video changed (drafted, sending, out, failed: an upload tells every second or two): the composer's
 * posts and the stage line ("YouTube posted") follow, at once and then at most once a second. Here, not in api/live.ts:
 * only the player shows posts, and the first paint carries nothing of publishing.
 */
function usePostEvents(slug: string) {
  const qc = useQueryClient();
  const timer = useRef<{ t: ReturnType<typeof setTimeout>; again: boolean } | null>(null);
  useEffect(() => () => clearTimeout(timer.current?.t), []);
  useSSE('posts', (d) => {
    if (d.slug !== slug) return;
    if (timer.current) {
      timer.current.again = true;
      return;
    }
    const run = () => {
      qc.invalidateQueries({ queryKey: ['posts'] });
      qc.invalidateQueries({ queryKey: keys.review(slug), exact: true });
    };
    run();
    const t = setTimeout(() => {
      const again = timer.current?.again;
      timer.current = null;
      if (again) run();
    }, 1000);
    timer.current = { t, again: false };
  });
}

// The B side of an A/B comparison: another version of this video, or a sibling video from the same project.
function useBSource(ab: AbState, data: ReviewResponse): BSource | null {
  const other = ab?.key.startsWith('s:') ? ab.key.slice(2) : null;
  const sibling = useReview(other).data;
  if (!ab?.key) return null;
  if (ab.key.startsWith('v:')) {
    const bv = data.review.versions.find((x) => x.v === Number(ab.key.slice(2)));
    const url = bv && data.media[bv.v]?.url;
    return bv && url ? { src: url, W: bv.width, H: bv.height, fps: bv.fps, frames: bv.frames, label: `V${bv.v}` } : null;
  }
  if (!sibling) return null;
  const lv = sibling.review.versions[sibling.review.versions.length - 1];
  return { src: sibling.media[lv.v]?.url || null, W: lv.width, H: lv.height, fps: lv.fps, frames: lv.frames, label: sibling.summary.name };
}

// Words and segments from the project's timeline.json / words.json, in this version's frames.
function useProjectTracks(slug: string, fps: number) {
  const tracks = useTracks(slug);
  return useMemo(() => {
    const tf = tracks?.fps || fps;
    const words =
      tracks?.words?.map((w) => (w.seconds ? { w: w.w, in: w.in * fps, out: w.out * fps } : { w: w.w, in: (w.in / tf) * fps, out: (w.out / tf) * fps })) ??
      null;
    const segments = tracks?.segments?.map((s) => ({ ...s, in: (s.in / tf) * fps, out: (s.out / tf) * fps })) ?? null;
    return { tracks, words, segments };
  }, [tracks, fps]);
}

interface ComposerState {
  shapes: Shape[];
  tool: Tool;
  /** Words picked in the transcript: the note asks for them to be said differently. */
  words?: string;
  /** About the whole video: nothing to draw on, the drawing tools leave the picture. */
  whole?: boolean;
  /** Counts the asks for the text to take the focus again (a section drawn on the timeline while it is open). */
  focus?: number;
}

function PlayerView({
  data,
  slug,
  focus,
  startFrame,
  startV,
  verifyAt,
}: {
  data: ReviewResponse;
  slug: string;
  focus: string | null;
  startFrame: string | null;
  startV: string | null;
  verifyAt: string | null;
}) {
  const { review, media } = data;
  const info = useInfo();
  // A video in an archived project (lib/archived.ts) is read only here: watch, read, download — nothing new. Restored
  // (or archived) a moment ago in this tab, it is so at once (library/archiving.ts).
  const held = useHeldArchive(projectOfFolder(review.folder));
  const frozen = held === undefined ? !!data.summary.project_archived : !!held;
  const qc = useQueryClient();
  const allowed = useCan(frozen);
  const lang = useLang();
  // the first run's sample: its agent wears the name of the agent picked in the setup, and closing its loop says so
  const picked = useAuthStatus().data?.user?.prefs?.onboarding?.agent;
  const sampleAgent = data.summary.sample && picked ? SETUP_AGENT_LABELS[picked] : null;
  showSampleAgentAs(sampleAgent);
  const SampleEnd = useLoaded(loopDoneCode, !!data.summary.sample)?.default;
  // The first loop on a video of the workspace's own, while a trial runs (conversion/Value.tsx): never on the sample
  const Loop = useLoaded(billingCode, !!info?.billing && !data.summary.sample)?.LoopMoment;
  const latestV = review.versions[review.versions.length - 1].v;
  const [v, setV] = useState(() => review.versions.find((x) => String(x.v) === startV)?.v ?? latestV);
  const ver = review.versions.find((x) => x.v === v) || review.versions[review.versions.length - 1];
  const { fps, width: W, height: H, frames: N } = ver;
  const m = media[ver.v];

  const [prefs, setPref] = usePrefs('vr.player');
  const orient = orientOf(W, H);
  const presetList = presetsFor(W, H);
  const presetKey = `preset.${orient}`;
  const preset = presetById(presetList.some((p) => p.id === prefs[presetKey]) ? prefs[presetKey] : 'none');
  // The phone view: one choice — Off, Full height or an app, the app being the safe-zone preset (one pref, so the phone
  // and the safe zones never disagree) — on the phone picked last; V brings it back as it was.
  const model = deviceById(prefs.device);
  const device = prefs.phone ? model : null;
  const phoneView: PhoneView = {
    device,
    model,
    app: preset.app ? preset : null,
    apps: presetList.filter((p) => p.app),
    zones: prefs.zones === true,
    onView: (choice) => {
      if (choice === 'off') return setPref('phone', false);
      if (!prefs.phone) setPref('phone', true);
      if (choice !== 'full') setPref(presetKey, choice);
      else if (preset.app) setPref(presetKey, 'none');
    },
    onDevice: (id) => {
      setPref('device', id);
      if (!prefs.phone) setPref('phone', true);
    },
    onZones: () => setPref('zones', prefs.zones !== true),
  };

  const [ab, setAb] = useState<AbState>(null);
  const verifyActive = useRef(false);
  // Verify mode on a fix preview: side by side or a wipe between the render and the preview, and the wipe's position.
  const [previewView, setPreviewView] = useState<{ mode: 'side' | 'wipe'; pos: number }>({ mode: 'side', pos: 0.5 });
  const clipRef = useRef<HTMLVideoElement | null>(null);
  const b = useBSource(ab, data);
  // Quiet: while playing, only what shows the frame renders per frame (frameStore.ts), not the whole player.
  const pb = usePlayback({ ver, url: m?.url, startFrame, b, quiet: true });
  const { frame, frameRef, seek } = pb;
  // what the person watching plays, for Insights and the viewers chip (lib/views.ts); who watched, for the chip
  useTeamWatch(slug, ver.v, pb.videoRef, pb.playing);
  const audience = useAudience(slug, ver.v).data ?? null;
  const band = prefs.views === true && !!audience && audience.v === ver.v && audience.retention.length > 0;

  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [selected, setSelected] = useState<string | null>(focus || null);
  const [filter, setFilter] = useState<Filter>('active');
  // a tag picked in the filter row narrows the list, with the filter beside it; it belongs to its video
  const [tag, setTag] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a picked tag belongs to the video it was picked on
  useEffect(() => setTag(null), [slug]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // the publishing composer: open on a post (its id) or the first ("1"); the address can ask for it (?publish=, read here
  // rather than by the app's router: nothing of publishing in the first paint)
  const publishAt = new URLSearchParams(location.hash.split('?')[1] ?? '').get('publish');
  const [publishing, setPublishing] = useState<string | null>(publishAt);
  const [publishAsked, setPublishAsked] = useState(publishAt);
  if (publishAt !== publishAsked) {
    setPublishAsked(publishAt);
    if (publishAt) setPublishing(publishAt);
  }
  const Publishing = useLoaded(publishUi, !!publishing)?.default;
  usePostEvents(slug);
  const [help, setHelp] = useState(false);
  // Review mode: the open notes at the moment it started, in timeline order, and where we are.
  const [walk, setWalk] = useState<{ ids: string[]; i: number } | null>(null);
  const comments = useCommentActions(slug);
  const queryClient = useQueryClient();
  // Phones: notes in a bottom sheet, A/B and before/after stacked with a swipe between them.
  const phone = usePhone();
  const [sheet, setSheet] = useState<SheetState>('peek');
  // where the timeline's zoom goes: the transport row's slot (a phone: the timeline's own row above the ruler)
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  const [showB, setShowB] = useState(false);
  // Notes or the transcript. The transcript comes back only on the video it was open on, only while speech-to-text
  // runs, and never over open notes: a remembered tab must not hide another video's notes behind an empty panel.
  const speech = info ? (info.stt ? info.stt.backend !== 'off' && info.stt.available : info.whisper) : false;
  const [view, setViewState] = useState<PanelView>(() =>
    prefs.panel === slug && speech && !review.comments.some((c) => c.status === 'open' || c.status === 'fixed') ? 'transcript' : 'notes',
  );
  const setView = useCallback(
    (x: PanelView) => {
      setViewState(x);
      setPref('panel', x === 'transcript' ? slug : undefined);
    },
    [setPref, slug],
  );

  // new render arrived
  const prevLatest = useRef(latestV);
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to a new newest version only
  useEffect(() => {
    if (latestV === prevLatest.current) return;
    if (v === prevLatest.current && !composer) {
      setV(latestV);
      toast(t('New version: now showing V{latestV}', { latestV }), 'ok');
    } else toast(t('V{latestV} is available', { latestV }));
    prevLatest.current = latestV;
  }, [latestV]);

  // ---------------------------------------------------------------- derived data
  const wave = useWaveform(slug, ver.v).data;
  const analysis = useAnalysis(slug, ver.v).data;
  const { tracks, words, segments } = useProjectTracks(slug, fps);
  const { diff, pending: diffPending, changes } = useDiff(slug, ver.v);
  const qa = useQa({ slug, v: ver.v, fps, review, onAccepted: setSelected });
  // a diamond picked on the timeline opens Auto-check's findings, the same one again too (a new number each time)
  const [findingAsked, setFindingAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the findings' labels are words
  const findings = useMemo(
    () =>
      qa.suggestions?.map((x) => ({
        key: x.key,
        frame: x.frame,
        severity: x.severity,
        label: `${FINDING()[x.kind as keyof ReturnType<typeof FINDING>]?.label ?? x.kind}: ${findingWords(x, fps).what}`,
      })),
    [qa.suggestions, fps, lang],
  );
  const sprite = useSprite(ver.v === latestV && !phone && ver.hash ? spriteUrl(slug, renderKey(ver)) : null, slug, true);

  const toHere = useCallback(
    (cv: number, f: number) => {
      const other = review.versions.find((x) => x.v === cv);
      if (!other || cv === ver.v || other.fps === fps) return clamp(f, 0, N - 1);
      return clamp(timeToFrame(f / other.fps, fps), 0, N - 1);
    },
    [review.versions, ver.v, fps, N],
  );
  // Notes deleted a moment ago are gone from the screen while their Undo toast is up.
  const hidden = useHiddenNotes();
  const placed = useMemo(
    (): PlacedComment[] =>
      review.comments
        .filter((c) => !hidden.has(c.id))
        .map((c) => {
          const fh = toHere(c.v, c.frame);
          const own = review.versions.find((x) => x.v === c.v);
          return {
            ...c,
            frameHere: fh,
            timecodeHere: timecode(fh, fps),
            // through the end of its last frame, which at another frame rate may be more than that frame's start
            rangeHere: c.range ? rangeOnGrid(c.range, own?.fps || fps, fps, N) : null,
            ...(own?.width && own.height ? { shotSize: { width: own.width, height: own.height } } : {}),
          };
        }),
    [review.comments, review.versions, hidden, toHere, fps, N],
  );
  // "Mine": your own notes still in play; without accounts (local mode) that is everything the team wrote itself.
  const me = useAuthStatus().data?.user ?? null;
  const byStatus = useMemo(() => {
    const active = placed.filter((c) => c.status === 'open' || c.status === 'fixed');
    const closed = placed.filter((c) => c.status === 'verified' || c.status === 'wontfix');
    const questions = placed.filter((c) => c.status === 'open' && isQuestion(c));
    const mine = active.filter((c) => (me ? isOwner(c.author, c.author_id, me) : !isAgent(c.author) && !c.author.startsWith('guest:')));
    return { active, questions, mine, closed, all: placed };
  }, [placed, me]);
  // The tags of the notes in this filter with their counts; the picked one stays offered even where none has it, so
  // it can always be put down again.
  const tags = useMemo(() => {
    const counted = tagCounts(byStatus[filter]);
    return tag && !counted.some(([x]) => x === tag) ? [...counted, [tag, 0] as [string, number]] : counted;
  }, [byStatus, filter, tag]);
  // Notes about the whole video first (they have no moment), then in timeline order.
  const list = useMemo(
    () => withTag(byStatus[filter], tag).sort((a, b) => Number(b.scope === 'video') - Number(a.scope === 'video') || a.frameHere - b.frameHere),
    [byStatus, filter, tag],
  );
  const counts = useMemo(
    () => ({
      open: placed.filter((c) => c.status === 'open' && isRequired(c)).length,
      fixed: placed.filter((c) => c.status === 'fixed').length,
      active: byStatus.active.length,
      mine: byStatus.mine.length,
      closed: byStatus.closed.length,
      all: placed.length,
      questions: byStatus.questions.length,
    }),
    [placed, byStatus],
  );
  // The last question answered: back to the open notes (the Questions tab only exists while there are some).
  useEffect(() => {
    if (filter === 'questions' && !counts.questions) setFilter('active');
  }, [filter, counts.questions]);
  const seg = segments?.find((x) => frame >= x.in && frame < x.out);
  const srcMap =
    seg && Number.isFinite(seg.src)
      ? `${seg.id} @ ${((seg.src ?? 0) + ((frame - seg.in) / fps) * seg.speed).toFixed(2)}s${seg.speed !== 1 ? ` ×${seg.speed}` : ''}`
      : null;
  const freezes = analysis?.freezes?.ranges || [];
  // The timeline marks every hold; only those Auto-check lists as looking like a problem in the must colour — an end
  // card, a title or a pause stays quiet (and so does everything until the check has said).
  const flagged = useMemo(
    () =>
      (qa.suggestions || [])
        .filter((x) => x.kind === 'freeze' && (x.likely ? x.likely === 'problem' : x.severity !== 'nice'))
        .flatMap((x) => x.holds ?? (x.range ? [x.range] : [])),
    [qa.suggestions],
  );
  const freezeMarks = useMemo(() => freezes.map((r) => ({ ...r, quiet: !flagged.some((s) => s.in <= r.out && r.in <= s.out) })), [freezes, flagged]);

  // drawings visible on the current frame (paused)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the marks' labels are words
  const marks = useMemo(
    () => (pb.playing ? '' : frameMarks({ placed, frame, selected, W, H, diff, qaPick: qa.pick })),
    [placed, frame, pb.playing, selected, W, H, diff, qa.pick, lang],
  );

  // ---------------------------------------------------------------- A/B
  const siblings = (useLibrary(!!ab).data?.videos ?? []).filter((x) => x.slug !== slug && x.project === review.project);
  // Versions someone approved (team or client): the natural thing to compare a new render against.
  const approved = useMemo(() => {
    const history = approvalsOf(review);
    return new Set(
      review.versions
        .filter((x) => verdictOn(history, 'team', x.v)?.status === 'approved' || verdictOn(history, 'client', x.v)?.status === 'approved')
        .map((x) => x.v),
    );
  }, [review]);
  const toggleAb = useStableCallback(() => {
    if (ab) return setAb(null);
    const others = review.versions.filter((x) => x.v !== ver.v);
    const b = others.filter((x) => approved.has(x.v)).at(-1) || others.at(-1);
    setAb(compareState(b ? `v:${b.v}` : '', (prefs.compare as CompareMode) || 'side'));
  });
  // The mode you last compared in comes back next time (verify mode's side by side doesn't count).
  // biome-ignore lint/correctness/useExhaustiveDependencies: remember the mode when it changes
  useEffect(() => {
    if (ab && !verifyActive.current && ab.mode !== prefs.compare) setPref('compare', ab.mode);
  }, [ab?.mode]);
  const compareWith = useStableCallback((bv: number) => setAb(compareState(`v:${bv}`, (prefs.compare as CompareMode) || 'side')));
  const swapAb = ab?.key.startsWith('v:')
    ? () => {
        const bv = Number(ab.key.slice(2));
        setAb({ ...ab, key: `v:${ver.v}` });
        setV(bv);
      }
    : undefined;

  // ---------------------------------------------------------------- comments
  const openComposer = () => {
    if (frozen) return;
    pb.pause();
    setComposer((c) => c || { shapes: [], tool: 'box' });
    if (view === 'agent') setView('notes');
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
  };
  const range = pb.inPt != null && pb.outPt != null ? { in: Math.min(pb.inPt, pb.outPt), out: Math.max(pb.inPt, pb.outPt) } : null;
  // The range a note is being written about (the timeline's in/out). Drawn for the note, it goes with it: saved or
  // cancelled, the timeline's in/out are cleared again; in/out set with I/O before writing stay for looping.
  const rangeForNote = useRef(false);
  const setRange = (r: FrameRange | null, forNote = true) => {
    pb.setIn(r ? r.in : null);
    pb.setOut(r ? r.out : null);
    if (r && forNote) rangeForNote.current = true;
  };
  const dropNoteRange = () => {
    if (rangeForNote.current) setRange(null, false);
    rangeForNote.current = false;
  };
  // Drawn on the timeline: the note starts at the range's first frame, the composer opens for it (already open: its text
  // takes the focus again), ready to type — no C, no trip up to the composer.
  const onTimelineRange = (r: FrameRange) => {
    setRange(r);
    seek(r.in);
    if (composer) setComposer((c) => (c ? { ...c, focus: (c.focus ?? 0) + 1 } : c));
    else openComposer();
  };
  // I and O mark a section while playing or scrubbing, nothing opens: an in after the out (or an out before the in)
  // starts a new one, as in an editor. C or ↵ writes a note on it, Esc (or X) clears it.
  const markIn = (f: number) => {
    if (pb.outPt != null && f > pb.outPt) pb.setOut(null);
    pb.setIn(f);
  };
  const markOut = (f: number) => {
    if (pb.inPt != null && f < pb.inPt) pb.setIn(null);
    pb.setOut(f);
  };
  const clearMarks = () => {
    pb.setIn(null);
    pb.setOut(null);
  };
  // The zoom is remembered per video (vr.player `zoom`: the dozen videos looked at last).
  const zoomMemory = useMemo(() => {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(String(prefs.zoom || '{}'));
    } catch {}
    return {
      initial: saved[slug] ?? null,
      onChange: (view: readonly [number, number] | null) => {
        const was = JSON.stringify(saved[slug] ?? null);
        if (was === JSON.stringify(view)) return;
        const rest = Object.entries(saved).filter(([k]) => k !== slug);
        const next = Object.fromEntries(view ? [...rest.slice(-11), [slug, view]] : rest);
        setPref('zoom', Object.keys(next).length ? JSON.stringify(next) : undefined);
      },
    };
  }, [prefs.zoom, slug, setPref]);
  // Words picked in the transcript: a note about the frames they are heard on, asking for other words.
  const changeWords = useStableCallback((w: { text: string; range: FrameRange }) => {
    pb.pause();
    setRange(w.range);
    seek(w.range.in);
    setComposer({ shapes: [], tool: 'none', words: w.text });
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
  });
  // Hear it again: detected, or in a language picked because detection got it wrong.
  const rerunTranscript = useStableCallback(async (language?: string) => {
    try {
      await api(`/api/review/${enc(slug)}/transcript/rerun?v=${ver.v}${language ? `&language=${encodeURIComponent(language)}` : ''}`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: keys.transcript(slug, ver.v) });
    } catch (e) {
      toastError(e);
    }
  });
  const playWords = useStableCallback((r: FrameRange) => pb.playSegments([r]));
  // The transcript compares with the version in the compare bar, else with the one before.
  const compareV = ab?.key.startsWith('v:') ? Number(ab.key.slice(2)) : null;
  const trBase = compareV !== null && compareV !== ver.v ? compareV : (review.versions.filter((x) => x.v < ver.v).at(-1)?.v ?? null);
  const textEdits = useMemo(() => placed.filter((c) => c.text_edit), [placed]);
  // A partial render on screen: the stretch it patches on the timeline, and where its seam jumps (lib/part.ts).
  // biome-ignore lint/correctness/useExhaustiveDependencies: its label is words
  const patch = useMemo(() => {
    const p = patchOf(ver);
    return p && ver.part ? { ...p, label: t('patched in V{v}, the rest is V{w}', { v: ver.v, w: ver.part.of }) } : null;
  }, [ver, lang]);
  // Save keeps the note as a draft; Send sends it with every draft here (drafts/useUnsent.ts). A Send with nothing else
  // waiting and nothing to ask or start goes straight to the review, as notes always did: on screen at once.
  const saveComment = async ({ refs: picked, overall, onProgress, ...payload }: ComposerPayload, how: SaveHow) => {
    // whether the agent waited as this was sent (once it has the note, it works on it)
    const toAgent = waiting;
    const inline = picked.map(inlineBody).filter((x): x is Record<string, unknown> => !!x);
    const body: NewComment = {
      v: ver.v,
      // A range note without a drawing sits on its first frame; one drawn on sits where it was drawn (inside its range).
      frame: overall ? 0 : range && !composer?.shapes.length ? range.in : frame,
      range: overall ? null : range,
      drawing: overall ? [] : composer?.shapes || [],
      ...payload,
      ...(inline.length ? { refs: inline } : {}),
      ...(overall ? { scope: 'video' as const } : {}),
    };
    const alone = how === 'send' && !unsent.count && unsent.way() === 'send';
    const c = alone ? await comments.add.mutateAsync(body) : await unsent.save(body);
    // The range is the note's now.
    if (body.range) {
      rangeForNote.current = true;
      dropNoteRange();
    }
    // Files go up once the note exists (one-time upload URLs); a file that fails leaves the note as it is.
    const files = picked.filter((p) => p.kind === 'file');
    for (const p of files)
      try {
        await sendRef(alone ? { kind: 'owner', comment: c.id } : { kind: 'draft', slug, comment: c.id }, p, {
          onProgress: (share) => onProgress(p.key, share),
        });
      } catch (e) {
        toast(t('{name}: {error}', { name: p.kind === 'file' ? p.file.name : '', error: errorMessage(e) }), 'error');
      }
    if (files.length) await (alone ? queryClient.invalidateQueries({ queryKey: keys.review(slug) }) : unsent.refresh());
    setComposer(null);
    if (!alone) {
      if (how === 'send') await unsent.send();
      else toast(t('Saved as a draft: only you see it until you send it'), 'ok');
      return;
    }
    setSelected(c.id);
    setFilter((f) => (f === 'active' || f === 'mine' || f === 'all' ? f : 'active'));
    toast(
      toAgent ? t('{name} got your note|{name} got your {n} notes', { n: 1, name: toAgent }) : t('Sent {id} at {timecode}', { id: c.id, timecode: c.timecode }),
      'ok',
    );
  };
  const selectComment = useCallback(
    (c: PlacedComment) => {
      setSelected(c.id);
      seek(c.frameHere);
    },
    [seek],
  );
  // A frame reference to this video, opened from a note: its version, at its frame.
  useEffect(() => {
    const go = (e: Event) => {
      const to = (e as CustomEvent<GotoFrame>).detail;
      if (to.slug !== slug) return;
      if (review.versions.some((x) => x.v === to.v)) setV(to.v);
      seek(to.frame);
    };
    window.addEventListener(GOTO_FRAME, go);
    return () => window.removeEventListener(GOTO_FRAME, go);
  }, [slug, review.versions, seek]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the note in the URL, once
  useEffect(() => {
    if (!focus) return;
    const c = placed.find((x) => x.id === focus);
    if (c) {
      if (c.status === 'verified' || c.status === 'wontfix') setFilter('all');
      // With a frame in the URL too (the inbox preview's "Open in player"), the note opens and the frame stays.
      if (startFrame != null) setSelected(c.id);
      else selectComment(c);
    }
  }, []);
  const jumpComment = (dir: 1 | -1) => {
    // the notes as the list shows them (filter and tag), in timeline order
    const sorted = list.filter((c) => c.scope !== 'video');
    const at = frameRef.current;
    const c = dir > 0 ? sorted.find((x) => x.frameHere > at) : [...sorted].reverse().find((x) => x.frameHere < at);
    if (c) selectComment(c);
  };
  const walkTo = (ids: string[], i: number) => {
    const c = placed.find((x) => x.id === ids[i]);
    if (!c) return;
    pb.pause();
    setWalk({ ids, i });
    selectComment(c);
  };
  const stepReview = (dir: 1 | -1) => {
    if (verify.active) return;
    if (!walk) {
      const ids = byStatus.active
        .filter((c) => c.scope !== 'video')
        .sort((a, z) => a.frameHere - z.frameHere)
        .map((c) => c.id);
      if (!ids.length) return toast(t('No open notes to go through'));
      if (filter !== 'active' && filter !== 'all') setFilter('active');
      return walkTo(ids, dir > 0 ? 0 : ids.length - 1);
    }
    const i = walk.i + dir;
    if (i < 0) return;
    if (i >= walk.ids.length) {
      setWalk(null);
      return toast(t('Went through all {count} notes', { count: walk.ids.length }), 'ok');
    }
    walkTo(walk.ids, i);
  };
  const walkNote = walk ? placed.find((c) => c.id === walk.ids[walk.i]) : null;
  // ↑ / ↓: the note above or below the selected one in the list, opened there with the playhead on its frame — while the
  // list is what the panel shows (the transcript keeps its own keys)
  const stepList = (dir: 1 | -1) => {
    if (view !== 'notes') return false;
    const c = stepNote(list, selected, dir);
    if (c) selectComment(c);
    return true;
  };
  // A range note plays its range; a note on one frame, a moment around it.
  const playAround = (c: PlacedComment) =>
    pb.playSegments([c.rangeHere ?? { in: Math.max(0, c.frameHere - Math.round(fps)), out: Math.min(N - 1, c.frameHere + Math.round(fps * 2)) }]);
  // A range note's own buttons: play its range once, on repeat, or stop the repeat.
  const playRange = useStableCallback((c: PlacedComment, how: RangePlay) => {
    if (!c.rangeHere) return;
    if (how === 'stop') return pb.pause();
    setSelected(c.id);
    pb.playSegments([c.rangeHere], { loop: how === 'loop' });
  });

  // A finding shows itself: what moves (a freeze, a flash, black, the sound) plays from a moment before to a moment
  // after, so the stop and the start are seen; text is a spot on a still frame (its box shows on the paused frame).
  const showFinding = (x: QaItem, stretch?: FrameRange) => {
    qa.setPick(x);
    const s = stretch ?? stretchOf(x);
    if (!s) return;
    if (x.kind === 'typo' || x.kind === 'safe-zone') return seek(x.frame);
    pb.playSegments([{ in: Math.max(0, s.in - Math.round(fps * 0.75)), out: Math.min(N - 1, s.out + Math.round(fps * 0.5)) }]);
  };

  const nextFreeze = () => {
    const r = freezes.find((x) => x.in > frameRef.current) || freezes[0];
    if (r) {
      seek(r.in);
      pb.setIn(r.in);
      pb.setOut(r.out);
    }
  };

  // ---------------------------------------------------------------- what changed
  const jumpChange = (dir: 1 | -1) => {
    if (!changes.length)
      return toast(
        ver.v < 2 ? t('This is the first version') : diffPending ? t('Still comparing with the previous version…') : t('No changes since the previous version'),
      );
    const at = frameRef.current;
    const c = dir > 0 ? changes.find((r) => r.in > at) || changes[0] : [...changes].reverse().find((r) => r.in < at) || changes[changes.length - 1];
    seek(c.in);
  };
  const playChanges = () => {
    const pad = Math.round(fps * 0.6);
    const segs: { in: number; out: number }[] = [];
    for (const r of changes) {
      const a = Math.max(0, r.in - pad);
      const z = Math.min(N - 1, r.out + pad);
      const last = segs[segs.length - 1];
      if (last && a <= last.out) last.out = Math.max(last.out, z);
      else segs.push({ in: a, out: z });
    }
    pb.playSegments(segs);
  };

  // ---------------------------------------------------------------- verify mode
  const verify = useVerify({
    slug,
    review,
    placed,
    latestV,
    showLatest: () => setV(latestV),
    onStart: () => {
      setComposer(null);
      setFilter('active');
      // verify mode steps through notes: they show
      setView('notes');
      if (phone) {
        setSheet('half');
        setShowB(false);
      }
    },
    focus: selectComment,
    setAb,
  });
  verifyActive.current = verify.active;
  // The playhead reaching a note while paused — a step, a seek, playback stopping on it — opens it in the list, unless
  // the selected note is there too (two notes on one frame keep the one picked). Never while writing or checking.
  const listNow = useRef(list);
  listNow.current = list;
  // the frame the player opened on is where it starts, not a note it reached
  const openedOn = useRef<number | null>(frame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: where the playhead stops decides, not every change of the list
  useEffect(() => {
    if (openedOn.current === frame) return;
    openedOn.current = null;
    if (pb.playing || composer || verify.active) return;
    const at = noteAt(listNow.current, frame);
    if (!at || at === selected) return;
    const current = listNow.current.find((c) => c.id === selected);
    if (current && noteAt([current], frame)) return;
    setSelected(at);
  }, [frame, pb.playing]);
  // A fix made in the project and shown as a still or clip before any render has it: verify mode checks it against
  // the render on screen at the frame it was made for.
  const fixPreview = verify.active && verify.item ? pendingPreview(verify.item, latestV) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: land on the preview's frame when verify mode reaches it
  useEffect(() => {
    if (fixPreview) seek(fixPreview.frame);
  }, [fixPreview?.id]);
  // A clip plays along with the render from its first frame; paused, it shows the frame under the playhead.
  useEffect(() => {
    const el = clipRef.current;
    if (fixPreview?.kind !== 'clip' || !el) return;
    const cfps = fixPreview.fps || fps;
    const t = Math.max(0, (frame - fixPreview.frame) / fps + 0.5 / cfps);
    if (pb.playing) {
      if (el.paused) {
        el.currentTime = t;
        el.play().catch(() => {});
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - t) > 0.5 / cfps) el.currentTime = t;
    }
  }, [frame, pb.playing, fixPreview, fps]);
  const verifyOnPreview = async () => {
    const c = verify.item;
    if (!c || !fixPreview) return;
    try {
      // checked, it leaves the queue and check mode moves on by itself (useVerify reads the notes)
      await comments.patch.mutateAsync({ id: c.id, status: 'verified', preview: fixPreview.id });
      toast(t('Checked on the preview: the next version is compared with it'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  // The note in the URL, once. A review cached from an earlier look (the inbox's preview, an earlier visit) shows first
  // and may not know the fix yet: the fresh one it is refetched into gets a second try.
  const verifyTries = useRef(verifyAt ? 2 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tried when the queue changes (the review on screen, then the refetched one)
  useEffect(() => {
    if (!verifyAt || !verifyTries.current) return;
    verifyTries.current -= 1;
    if (!verify.queue.includes(verifyAt)) return;
    verifyTries.current = 0;
    verify.startAt(verifyAt);
  }, [verify.queue]);
  // Verify mode goes to its note's frame; a frame in the URL as well (the inbox preview's "Open in player", scrubbed
  // elsewhere) wins, once, right after it. This runs after useVerify's own effect in the same commit.
  const verifyFrame = useRef(verifyAt && startFrame != null ? Number.parseInt(startFrame, 10) : null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when verify mode has opened at the note
  useEffect(() => {
    if (!verify.active || verifyFrame.current == null || Number.isNaN(verifyFrame.current)) return;
    const f = verifyFrame.current;
    verifyFrame.current = null;
    seek(f);
  }, [verify.active]);

  // A link to this video while it is open (⌘K, the inbox's "Open in player", a notification) keeps the player and does
  // what the link says, as it does when a link opens the player: the version, the frame, the note, verify mode.
  const linked = useRef({ focus, startFrame, startV, verifyAt });
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the link changes, not when the review does
  useEffect(() => {
    const was = linked.current;
    if (was.focus === focus && was.startFrame === startFrame && was.startV === startV && was.verifyAt === verifyAt) return;
    linked.current = { focus, startFrame, startV, verifyAt };
    const to = review.versions.find((x) => String(x.v) === startV);
    if (to) setV(to.v);
    const c = focus ? placed.find((x) => x.id === focus) : null;
    if (c && (c.status === 'verified' || c.status === 'wontfix')) setFilter('all');
    const at = startFrame != null ? Number.parseInt(startFrame, 10) : null;
    if (verifyAt && verify.queue.includes(verifyAt)) {
      verifyFrame.current = at;
      verify.startAt(verifyAt);
    } else if (at != null && !Number.isNaN(at)) {
      seek(at);
      if (c) setSelected(c.id);
    } else if (c) selectComment(c);
  }, [focus, startFrame, startV, verifyAt]);

  // ---------------------------------------------------------------- walkie-talkie (hold T)
  const walkieContext = useCallback(
    () => ({ frame: frameRef.current, v: ver.v, playing: !!pb.videoRef.current && !pb.videoRef.current.paused }),
    [ver.v, frameRef, pb.videoRef],
  );
  const walkieSaved = useCallback(
    (c: { id: string; timecode: string }, audioOnly: boolean) => {
      setSelected(c.id);
      toast(
        audioOnly
          ? t('Pinned {id} at {timecode} (audio only)', { id: c.id, timecode: c.timecode })
          : t('Pinned {id} at {timecode}', { id: c.id, timecode: c.timecode }),
        'ok',
        {
          label: t('Undo'),
          onClick: () => comments.remove.mutate(c.id, { onError: toastError }),
        },
      );
    },
    [comments.remove],
  );
  const walkie = useWalkie({ slug, getContext: walkieContext, onSaved: walkieSaved });

  // ---------------------------------------------------------------- recorded feedback (⇧R)
  const recorder = useRecordFeedback({ slug, v: ver.v, fps, frames: pb.live, video: () => pb.videoRef.current, enabled: speech });
  const pendingRecordings = recorder.pending;
  const RecordUI = useLoaded(recordUi, recorder.phase !== 'idle' || pendingRecordings.length > 0);
  const [draftFocus, setDraftFocus] = useState<DraftFocus>(null);
  // Drafts to review: the notes show (not the transcript), and a peeking sheet opens.
  const hasDrafts = pendingRecordings.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when drafts appear, not on every change of the view
  useEffect(() => {
    if (!hasDrafts) return;
    if (view === 'transcript') setView('notes');
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
  }, [hasDrafts]);

  // ---------------------------------------------------------------- not sent yet (drafts/)
  // Notes saved as drafts and what recordings said go out together (Send, Send all); starting the agent for them
  // follows the person's choice, asked in the panel when they chose to be asked.
  const wake = useWakeChoice(review.session, data.summary.sessionActive, info?.home);
  // Notes for an agent that isn't listening wait until someone starts it: the first new one here says how, once.
  const listen = useListening(review.session, { active: data.summary.sessionActive, listening: data.summary.sessionListening });
  useListenNudge(slug, review.session, listen, data.summary.counts.open, allowed('agents') && data.summary.stage.stage !== 'final');
  // A video with an agent: notes are kept and go to it together (the agent starts on the first note it gets). The
  // composer's main action keeps a note, "Not sent yet" sends them all; replies and answers still go at once.
  const batch = !!review.session && data.summary.stage.stage !== 'final';
  // The agent waits for notes right now (wait_for_feedback): one quiet line says it gets them when they're sent.
  const waiting = batch && listen === 'listening' ? (review.session?.name ?? null) : null;

  // ---------------------------------------------------------------- the agent's work (runs)
  // The review's summary carries the brief the strip starts from (undefined: an older server, no runs there); the
  // whole runs — the plan for the note rows, the version picker's who-made-it — come after the first paint, at once
  // while work goes on (the rows' plan lines). SSE `run` keeps them current (api/live.ts).
  const brief = data.summary.run;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the review's answer came (the brief is as of then)
  const briefAt = useMemo(() => Date.now(), [data]);
  const painted = usePainted();
  const runsQ = useRuns(slug, brief !== undefined && (painted || (!!brief && isOpen(brief))));
  const runs = runsQ.runs;
  const newest: RunLike | null = runs?.[0] ?? brief ?? null;
  const asOf = runs ? runsQ.at : briefAt;
  // what the strip speaks of: work going on, work that ended badly today, or work done while its fixes wait
  const stripRun =
    newest &&
    (isOpen(newest) ||
      ((newest.state === 'failed' || newest.state === 'stopped') && Date.now() - Date.parse(newest.ended ?? newest.started) < DAY_MS) ||
      (newest.state === 'done' && verify.queue.length > 0))
      ? newest
      : null;
  // the slot is there from the first paint wherever the video has an agent (assigned, or at work on it)
  const hasAgent = !!review.session || !!brief;
  const reachable = listen === 'listening' || listen === 'working' || (listen === null && !!data.summary.sessionActive);
  const noteAtId = useCallback((id: string) => review.comments.find((c) => c.id === id)?.timecode ?? null, [review.comments]);
  const sayRun = useCallback((w: ActivityWords) => say(w, noteAtId), [noteAtId]);
  // the plan's lines on the note rows, while the work goes on; before the runs arrive, open notes keep their room
  const planRun = runs?.[0] && isOpen(runs[0]) ? runs[0] : null;
  const plans = useMemo(() => new Map((planRun?.plan ?? []).map((x) => [x.id, x])), [planRun]);
  const planPending = !runs && !!brief && isOpen(brief);
  const inHand = planRun?.plan.find((x) => x.state === 'doing')?.id ?? null;
  // the Agent view: its code when it is first opened, or as soon as the strip is pointed at
  const [warm, setWarm] = useState(false);
  const AgentUI = useLoaded(agentViewCode, view === 'agent' || warm);
  const [pickRun, setPickRun] = useState<string | null>(null);
  const draftsSent = useStableCallback((out: DraftsSent) => {
    setDraftFocus(null);
    setFilter((f) => (f === 'active' || f === 'mine' || f === 'all' ? f : 'active'));
    if (out.notes[0]) setSelected(out.notes[0].id);
  });
  const unsent = useUnsent({
    slug,
    enabled: allowed('comment'),
    recordings: pendingRecordings,
    wake,
    agent: review.session?.name ?? null,
    waiting: !!waiting,
    onSent: draftsSent,
  });
  const UnsentUI = useLoaded(unsentUi, unsent.drafts.length > 0 || !!unsent.asking || hasDrafts);
  // "Not sent yet" is on screen: its Send is the raised action (the composer's while a note is written).
  const unsentShown = !!UnsentUI && (unsent.drafts.length > 0 || !!unsent.asking || (unsent.recordings.length > 0 && !!RecordUI));
  // A recording's draft sent on its own (its card's Send): the same send with its id, as a typed draft's.
  const sendOneDraft = (id: string) => {
    if (unsent.sending || unsent.asking) return false;
    unsent.send(undefined, id);
    return true;
  };
  const showUnsent = () => {
    setView('notes');
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
    requestAnimationFrame(() => document.querySelector('[data-testid=unsent]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  // Opening a video with notes you didn't send: said once, quietly; they wait at the top of the notes.
  const reminded = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the first answer is here
  useEffect(() => {
    if (reminded.current || !unsent.loaded) return;
    reminded.current = true;
    if (unsent.count > 0)
      toast(
        t('{n} note on this video is not sent yet|{n} notes on this video are not sent yet', { n: unsent.count }),
        'info',
        { label: t('Show'), onClick: showUnsent },
        { duration: 8000 },
      );
  }, [unsent.loaded]);

  // ---------------------------------------------------------------- keyboard
  useShortcuts({
    escape: (typing, t) => {
      if (lightbox) return setLightbox(null);
      if (verify.active && !typing) return verify.exit();
      if (composer && !typing) {
        setComposer(null);
        return dropNoteRange();
      }
      if (typing) return t.blur();
      if (walk) return setWalk(null);
      if (ab) return setAb(null);
      // a section marked with I / O (or left from a cancelled note) goes
      if (pb.inPt != null || pb.outPt != null) return clearMarks();
      setSelected(null);
    },
    // ↵ on a marked section writes a note on it (like C)
    enter: () => range && !composer && !recorder.active && m?.ready && openComposer(),
    step: (n) => seek(frameRef.current + n),
    first: () => seek(0),
    last: () => seek(N - 1),
    togglePlay: () => (pb.playing || pb.revSpeed ? pb.pause() : pb.play()),
    pause: pb.pause,
    forward: () => {
      if (!pb.playing) return pb.play();
      const next = RATES[Math.min(RATES.length - 1, RATES.indexOf(pb.rate) + 1)] || 1;
      pb.setRate(pb.rate < 1 ? 1 : next);
    },
    reverse: () => pb.startReverse(pb.revSpeed ? Math.min(4, pb.revSpeed * 2) : 1),
    markIn: (jump) => (jump ? pb.inPt != null && seek(pb.inPt) : markIn(frameRef.current)),
    markOut: (jump) => (jump ? pb.outPt != null && seek(pb.outPt) : markOut(frameRef.current)),
    clearRange: clearMarks,
    toggleLoop: () => pb.setLoop((x) => !x),
    toggleMute: () => pb.setMuted((x) => !x),
    compose: () => !recorder.active && openComposer(),
    verify: frozen ? () => {} : verify.start,
    togglePhone: () => setPref('phone', !prefs.phone),
    change: jumpChange,
    talk: () => !frozen && !recorder.active && walkie.start(),
    record: () => (!frozen && speech && m?.ready && !composer ? recorder.toggle() : undefined),
    stopTalking: walkie.stop,
    cyclePreset: () => {
      const i = presetList.findIndex((p) => p.id === preset.id);
      setPref(presetKey, presetList[(i + 1) % presetList.length].id);
    },
    toggleAb,
    comment: jumpComment,
    note: stepList,
    review: stepReview,
    zoom: (to) => window.dispatchEvent(new CustomEvent('vr-zoom', { detail: to })),
    help: () => setHelp((x) => !x),
  });

  // ---------------------------------------------------------------- render
  const message = !m?.ready
    ? m?.busy
      ? t('The server is busy: this version can be played in a few minutes.')
      : m?.preparing
        ? t('Preparing a browser-playable copy of this version…')
        : m?.error || t('This version cannot be played.')
    : null;
  const verifying = verify.active && !!verify.item;
  const paneA: Pane = {
    key: `a-${ver.v}`,
    src: pb.src,
    W,
    H,
    videoRef: pb.setVideo,
    muted: pb.muted,
    marks,
    // The compare bar names both sides (A left, B right); verify mode and the phone's stacked panes label their own.
    label: ab && b ? (verifying ? t('After · V{v}', { v: ver.v }) : phone ? `V${ver.v}` : null) : null,
    draw: composer
      ? {
          tool: composer.tool,
          shapes: composer.shapes,
          onAdd: (s) => setComposer((c) => (c ? { ...c, shapes: [...c.shapes, s] } : c)),
        }
      : recorder.active
        ? // Recording: draw with its tools; what was drawn shows on its frame while paused there.
          { tool: recorder.tool, shapes: pb.playing ? [] : recorder.strokes.filter((x) => x.f === frame).map((x) => x.shape), onAdd: recorder.addStroke }
        : draftFocus && !pb.playing && frame === draftFocus.frame && draftFocus.drawing.length
          ? // A draft looked at: its drawing (or the ring of its spot) on its frame.
            { tool: 'none', shapes: draftFocus.drawing, onAdd: () => {} }
          : null,
  };
  if (ab && b && ab.mode !== 'side')
    paneA.wipe = {
      src: b.src,
      label: phone ? b.label : '',
      videoRef: pb.setB,
      mode: ab.mode,
      pos: ab.pos,
      setPos: (pos) => setAb((x) => (x ? { ...x, pos } : x)),
      blend: ab.blend,
      opacity: ab.opacity,
    };
  const panes: Pane[] = [paneA];
  if (ab && b && ab.mode === 'side') {
    const paneB: Pane = {
      key: `b-${ab.key}`,
      src: b.src,
      W: b.W,
      H: b.H,
      videoRef: pb.setB,
      muted: true,
      label: verifying ? t('Before · {label}', { label: b.label }) : phone ? b.label : null,
    };
    if (verifying) {
      paneB.marks = marks;
      panes.unshift(paneB); // before on the left, after on the right
    } else panes.push(paneB);
  }
  if (fixPreview) {
    // Before: the render at the preview's frame; after: the preview (stills stand, clips play along).
    const url = previewUrl(slug, fixPreview);
    const still = fixPreview.kind === 'still';
    const label = previewSource(fixPreview) ? `${t('Fix preview')} · ${previewSource(fixPreview)}` : t('Fix preview');
    panes.length = 0;
    paneA.label = t('Now · V{v}', { v: ver.v });
    paneA.wipe = undefined;
    panes.push(paneA);
    if (previewView.mode === 'wipe')
      paneA.wipe = {
        src: still ? null : url,
        image: still ? url : undefined,
        label,
        videoRef: clipRef,
        mode: 'wipe',
        pos: previewView.pos,
        setPos: (pos) => setPreviewView((x) => ({ ...x, pos })),
        blend: 'difference',
        opacity: 1,
      };
    else
      panes.push({
        key: `p-${fixPreview.id}`,
        src: still ? null : url,
        image: still ? url : undefined,
        W: fixPreview.width,
        H: fixPreview.height,
        videoRef: clipRef,
        muted: true,
        label,
      });
  }
  // Stacked on phones: after (the newest render, or the fix preview) shows by default; a swipe or the verify panel's
  // toggle shows before.
  const aIndex = fixPreview ? panes.length - 1 : panes.indexOf(paneA);
  const stack = phone && panes.length > 1 ? { show: showB ? 1 - aIndex : aIndex, onSwipe: () => setShowB((x) => !x) } : null;
  const onLightbox = useCallback((src: string) => setLightbox(src), []);
  const compareBar = ab && (
    <CompareBar
      ab={ab}
      setAb={setAb}
      versions={review.versions}
      v={ver.v}
      latestV={latestV}
      siblings={siblings}
      approved={approved}
      onSwap={swapAb}
      onClose={() => setAb(null)}
      inline={phone}
    />
  );
  const onShare = useCallback(() => setSharing(true), []);
  const onPublish = useCallback(() => setPublishing('1'), []);
  const closePublish = useCallback(() => {
    setPublishing(null);
    // the address no longer asks for it (a reload or Back won't open it again), and App's route forgets it too,
    // so the same ?publish= link opens it again
    if (/[?&]publish=/.test(location.hash)) {
      history.replaceState(history.state, '', location.hash.replace(/([?&])publish=[^&]*&?/, '$1').replace(/[?&]$/, ''));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, []);

  // ---------------------------------------------------------------- the strip and the Agent view
  const canSteer = allowed('agents');
  const canCheck = allowed('verify');
  const openAgent = useStableCallback(() => {
    if (phone) {
      setView('agent');
      setSheet((x) => (x === 'peek' ? 'half' : x));
      return;
    }
    setView(view === 'agent' ? 'notes' : 'agent');
  });
  // Answer: the question's note, open on its frame (its choices, or Compare and pick, one click away)
  const answer = useStableCallback((note: string | null) => {
    const c = note ? placed.find((x) => x.id === note) : null;
    setView('notes');
    if (c) {
      setFilter((f) => (c.status !== 'open' ? 'all' : f === 'questions' || f === 'active' || f === 'all' ? f : 'active'));
      selectComment(c);
    } else setFilter(counts.questions ? 'questions' : 'active');
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
  });
  // a plan's note: there on the timeline, picked in the list, the Agent view stays
  const showNote = useStableCallback((id: string) => {
    const c = placed.find((x) => x.id === id);
    if (c) selectComment(c);
  });
  const showSteps = useStableCallback((id: string) => {
    setPickRun(id);
    setView('agent');
    if (phone) setSheet((x) => (x === 'peek' ? 'half' : x));
  });
  const warmAgent = useCallback(() => setWarm(true), []);
  // a final video ships: its agent's idle line goes with the agent button (work still going on stays)
  const final = data.summary.stage.stage === 'final';
  const showStrip = hasAgent && (!final || !!stripRun);
  // the strip's raised button (Answer, Check fixes) is the panel's one: + Note steps down while it shows
  const stripPrimary =
    !!stripRun &&
    ((stripRun.state === 'needs_you' && stripRun.needs?.kind !== 'permission' && stripRun.needs?.kind !== 'sign_in') ||
      (stripRun.state === 'done' && verify.queue.length > 0 && canCheck));
  const strip = showStrip ? (
    <RunStrip
      slug={slug}
      run={stripRun}
      asOf={asOf}
      session={review.session}
      reachable={reachable}
      copyable={listen !== null}
      toCheck={verify.queue.length}
      nextV={latestV + 1}
      canSteer={canSteer}
      canCheck={canCheck}
      say={sayRun}
      onOpen={openAgent}
      onAnswer={answer}
      onCheck={verify.start}
      phone={phone}
      open={view === 'agent'}
      onWarm={warmAgent}
    />
  ) : null;
  const agentView =
    view === 'agent' && AgentUI ? (
      <AgentUI.AgentView
        slug={slug}
        runs={runs}
        current={stripRun}
        pick={pickRun}
        onPick={setPickRun}
        asOf={asOf}
        session={review.session}
        me={me?.name ?? null}
        notes={placed}
        latestV={latestV}
        canSteer={canSteer}
        reachable={reachable || (!!stripRun && isOpen(stripRun) && stripRun.state !== 'lost')}
        say={sayRun}
        onNote={showNote}
        onAnswer={answer}
      />
    ) : null;

  const verifyPanel = verify.active && verify.item && (
    <VerifyPanel
      item={verify.item}
      index={verify.index}
      total={verify.total}
      before={verify.before}
      after={latestV}
      busy={verify.busy}
      onVerify={() => verify.decide(true)}
      onReopen={(note) => verify.decide(false, note)}
      onSkip={verify.advance}
      onExit={verify.exit}
      preview={fixPreview ? { p: fixPreview, url: previewUrl(slug, fixPreview) } : null}
      onVerifyPreview={verifyOnPreview}
      previewMode={previewView.mode}
      onPreviewMode={phone ? undefined : (mode) => setPreviewView((x) => ({ ...x, mode }))}
      side={phone && stack ? (showB ? 'before' : 'after') : undefined}
      onSide={phone && stack ? (x) => setShowB(x === 'before') : undefined}
      fps={fps}
      onPlayRange={verify.item.rangeHere ? () => verify.item?.rangeHere && pb.playSegments([verify.item.rangeHere]) : undefined}
    />
  );
  return (
    // everything inside reads it: an archived project's video takes nothing new (api/auth.ts useCan)
    <ReadOnlyScope value={frozen}>
      <main className={phone ? `player phone-player ps-${sheet}` : 'player'} style={{ '--ar': H / W } as CSSProperties}>
        <PlayerTopbar
          phone={phone}
          data={data}
          v={ver.v}
          latestV={latestV}
          abOn={!!ab}
          approved={approved}
          home={info?.home}
          onVersion={setV}
          onToggleAb={toggleAb}
          onCompareWith={compareWith}
          strip={phone && ab && !verifying ? compareBar : null}
          onShare={onShare}
          onVerify={verify.start}
          onPublish={allowed('post') ? onPublish : undefined}
          frameNow={pb.live.get}
          runs={runs}
          run={stripRun}
          onSteps={showSteps}
          archived={
            frozen
              ? {
                  onRestore: allowed('archive')
                    ? () => void archivedCode.load().then((x) => x.restoreProject(qc, projectOfFolder(review.folder) as string), toastError)
                    : undefined,
                }
              : null
          }
        />

        <Stage
          panes={panes}
          preset={preset.id === 'none' ? null : preset}
          phone={device}
          zones={phoneView.zones}
          message={message}
          reserveBottom={verify.active && !phone ? 190 : 0}
          reserveTop={ab && !verifying && !phone ? 52 : 0}
          pad={phone ? 10 : undefined}
          stack={stack}
        />
        <div className="stage-overlay">
          <WalkieHud state={walkie.state} level={walkie.level} timecodeOf={(f) => timecode(f, fps)} />
          {/* the drawing tools sit on the picture while a note is written (not for the transcript's words, not about the
            whole video, not while it plays: a note's marks are on the paused frame) */}
          {composer && composer.words == null && !composer.whole && !pb.playing && !walkie.state && (
            <DrawBar
              tools={COMPOSER_TOOLS()}
              tool={composer.tool}
              onTool={(tool) => setComposer((c) => (c ? { ...c, tool } : c))}
              onUndo={() => setComposer((c) => (c ? { ...c, shapes: c.shapes.slice(0, -1) } : c))}
              canUndo={composer.shapes.length > 0}
              label={t('Drawing tool')}
              undoLabel={t('Undo last shape')}
              under={!!ab && !verifying && !phone}
            />
          )}
          {(recorder.active || recorder.phase === 'saving') && RecordUI && <RecordUI.RecordBar rec={recorder} />}
          {!phone && verifyPanel}
          {walk && walkNote && !verify.active && (
            <ReviewHud
              note={walkNote}
              index={walk.i}
              total={walk.ids.length}
              onPrev={() => stepReview(-1)}
              onNext={() => stepReview(1)}
              onPlay={() => playAround(walkNote)}
              onExit={() => setWalk(null)}
            />
          )}
          {ab && !verifying && !phone && compareBar}
          {Loop && !verify.active && <Loop slug={slug} toCheck={verify.queue.length} />}
          {stack && (
            <div className="stack-label badge">
              {panes[stack.show]?.label || ''} {t('· swipe')}
            </div>
          )}
        </div>

        {/* a phone: the strip above the dock, in a slot of its own (the sheet stays the notes' and the Agent view's) */}
        {phone && strip && <div className="run-slot">{strip}</div>}
        <div className="dock grain">
          {phone ? (
            <PhoneTransport pb={pb} fps={fps} N={N} />
          ) : (
            <Transport
              pb={pb}
              fps={fps}
              N={N}
              srcMap={srcMap}
              srcFile={tracks?.timeline ?? null}
              presets={presetList}
              preset={preset}
              onPreset={(id) => setPref(presetKey, id)}
              phone={phoneView}
              onIn={markIn}
              onOut={markOut}
              zoomSlot={setZoomSlot}
            />
          )}
          <Timeline
            zoomAt={phone ? undefined : zoomSlot}
            zoomTipWaits={verify.active || !!walk || recorder.active}
            frames={N}
            fps={fps}
            frame={frame}
            live={pb.live}
            onSeek={seek}
            inPt={pb.inPt}
            outPt={pb.outPt}
            peaks={wave?.peaks}
            rms={wave?.rms}
            comments={byStatus.all.filter((c) => c.scope !== 'video')}
            inHand={inHand}
            freezes={freezeMarks}
            words={phone ? null : words}
            segments={phone ? null : segments}
            selected={selected}
            changes={diff?.ranges}
            retimes={diff?.retimes}
            findings={findings}
            onPickFinding={(key) => {
              const x = qa.suggestions?.find((q) => q.key === key);
              if (x) {
                qa.setPick(x);
                seek(x.frame);
                setFindingAsked((n) => n + 1);
              }
            }}
            sprite={sprite}
            aspect={W / H}
            onRange={m?.ready && !frozen ? onTimelineRange : undefined}
            onRangeEdge={(edge, f) => (edge === 'in' ? pb.setIn(f) : pb.setOut(f))}
            writing={!!composer && !composer.whole}
            onMarkNote={m?.ready && !recorder.active && !frozen ? openComposer : undefined}
            onMarkClear={() => {
              clearMarks();
              rangeForNote.current = false;
            }}
            zoomMemory={zoomMemory}
            views={band && audience ? audience : null}
            patch={patch}
            onSelect={(id) => {
              // A range note's bar plays its range (from in, stopping on out); a point note is a place to go to.
              const c = placed.find((x) => x.id === id);
              if (c?.rangeHere) playRange(c, 'once');
              else if (c) selectComment(c);
            }}
          />
          {phone && <PhoneTools pb={pb} fps={fps} presets={presetList} preset={preset} onPreset={(id) => setPref(presetKey, id)} phone={phoneView} />}
          <DockFoot
            analysis={analysis}
            wave={wave}
            freezes={freezes}
            flaggedFreezes={qa.suggestions && !qa.pending ? freezeMarks.filter((r) => !r.quiet).length : null}
            v={ver.v}
            diff={diff}
            diffPending={diffPending}
            onNextFreeze={nextFreeze}
            onNextChange={() => jumpChange(1)}
            onPlayChanges={playChanges}
            onHelp={() => setHelp(true)}
            audience={audience}
            band={prefs.views === true}
            onBand={() => setPref('views', prefs.views !== true)}
            readOnly={frozen}
          />
        </div>

        <NotesPanel
          slug={slug}
          videoName={fileName(review.video)}
          v={ver.v}
          latestV={latestV}
          frame={frame}
          live={pb.live}
          filter={filter}
          setFilter={setFilter}
          counts={counts}
          list={list}
          selected={selected}
          onSelect={selectComment}
          playing={pb.playing}
          tags={tags}
          tag={tag}
          setTag={setTag}
          onLightbox={onLightbox}
          fps={fps}
          onPlayRange={playRange}
          rangeLoop={pb.rangeLoop}
          canCompose={!composer && !!m?.ready && !recorder.active}
          readOnly={frozen}
          quietNew={(unsentShown && unsent.count > 0) || stripPrimary}
          strip={phone ? null : strip}
          agentTab={showStrip || runs?.length ? { live: !!stripRun && isOpen(stripRun) && stripRun.state !== 'needs_you' && stripRun.state !== 'lost' } : null}
          agentView={agentView}
          plans={plans}
          planName={planRun?.agent.name ?? brief?.agent.name ?? review.session?.name ?? ''}
          planPending={planPending}
          verifyInStrip={stripRun?.state === 'done' && verify.queue.length > 0 && canCheck && showStrip}
          onCompose={openComposer}
          verifyCount={frozen ? 0 : verify.queue.length}
          verifying={verify.active}
          onVerify={verify.start}
          onReview={() => (walk ? setWalk(null) : stepReview(1))}
          reviewing={!!walk}
          sheet={
            phone
              ? {
                  state: sheet,
                  setState: setSheet,
                  mic: frozen ? null : <MicButton state={walkie.state} level={walkie.level} start={walkie.start} stop={walkie.stop} />,
                }
              : undefined
          }
          top={phone ? verifyPanel : undefined}
          view={view}
          setView={setView}
          transcript={{
            base: trBase,
            onSeek: seek,
            onPlay: playWords,
            onChangeWords: m?.ready && !frozen ? changeWords : undefined,
            onRerun: allowed('qa') ? rerunTranscript : undefined,
            edits: textEdits,
          }}
          autoCheck={
            <AutoCheck
              slug={slug}
              v={ver.v}
              fps={fps}
              aspect={W / H}
              items={qa.suggestions}
              pending={qa.pending}
              failed={qa.failed}
              progress={qa.progress}
              language={qa.language}
              spelling={qa.spelling}
              timecodeOf={(f) => timecode(f, fps)}
              active={qa.pick?.key}
              asked={findingAsked}
              onPlay={showFinding}
              onAccept={frozen ? undefined : qa.accept}
              onIntended={allowed('qa') ? qa.intended : undefined}
              onRerun={allowed('qa') ? qa.rerun : undefined}
            />
          }
          record={frozen ? null : <RecordButton rec={recorder} speech={speech} ready={!!m?.ready && !composer} compact />}
          recording={
            UnsentUI && unsentShown ? (
              <UnsentUI.Unsent
                slug={slug}
                fps={fps}
                v={ver.v}
                unsent={unsent}
                agent={review.session?.name ?? null}
                folder={wake.folder}
                onSeek={seek}
                onFocus={setDraftFocus}
                composing={!!composer}
                batch={batch}
                waiting={!!waiting}
                recordings={
                  RecordUI
                    ? unsent.recordings.map((rec) => (
                        <RecordUI.Drafts
                          key={rec.id}
                          slug={slug}
                          rec={rec}
                          fps={fps}
                          onSeek={seek}
                          onFocus={setDraftFocus}
                          register={unsent.register}
                          sending={unsent.sending}
                          going={unsent.going}
                          onSend={sendOneDraft}
                        />
                      ))
                    : null
                }
              />
            ) : null
          }
          composer={
            composer && (
              <Composer
                // other words picked: a composer for them
                key={composer.words ?? ''}
                words={composer.words ?? null}
                frame={frame}
                fps={fps}
                frames={N}
                range={range}
                onRange={(r) => setRange(r)}
                live={pb.live}
                onSeek={seek}
                shapeCount={composer.shapes.length}
                onClear={() => setComposer((c) => (c ? { ...c, shapes: [] } : c))}
                onWhole={(whole) => setComposer((c) => (c ? { ...c, whole } : c))}
                onCancel={() => {
                  setComposer(null);
                  dropNoteRange();
                }}
                onSave={saveComment}
                unsent={unsent.count}
                batch={batch}
                waiting={waiting}
                whisper={info?.whisper}
                video={{ slug, name: fileName(review.video) }}
                v={ver.v}
                focusKey={composer.focus ?? 0}
              />
            )
          }
        />

        {sharing && <ShareModal slug={slug} name={fileName(review.video)} onClose={() => setSharing(false)} />}
        {publishing && Publishing && <Publishing data={data} focus={publishing} live={pb.live} onClose={closePublish} />}
        {lightbox && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: click anywhere to close; Esc closes it too (useShortcuts)
          // biome-ignore lint/a11y/noStaticElementInteractions: see above
          <div className="backdrop" onClick={() => setLightbox(null)}>
            <img className="lightbox" src={lightbox} alt="" />
          </div>
        )}
        {help && <HelpModal onClose={() => setHelp(false)} />}
        {SampleEnd && <SampleEnd review={review} me={me?.name ?? ''} agent={sampleAgent} />}
      </main>
    </ReadOnlyScope>
  );
}
