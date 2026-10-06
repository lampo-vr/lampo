// An Embed link's player (/e/<token>, web/embed.html): the video alone, in a frame on someone else's site. The app's
// own playback (player/usePlayback.ts: seeks to the middle of a frame, the frame on screen from the video's frame
// callback) behind a bar of the app's controls — play, a frame back and on, the timecode with frames, sound, captions,
// full screen, the Lampo mark — that steps aside while the film plays. Keys as in the player: Space or K, J K L, ← → a
// frame (⇧ ten), M, F, C. No notes, no names, no sign-in and nothing kept in the browser: no cookie, no storage.
// It rests on the poster's frame (sharp, the same picture the poster shows) until it is played, from its start.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_NAME, SITE_URL } from '../../../lib/brand.ts';
import { posterFrame, timecode } from '../../../lib/time.ts';
import type { Chapter, EmbedResponse } from '../../../lib/types.ts';
import type { Version } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { beacon, useWatchReport } from '../lib/watchReport.ts';
import { type FrameStore, useFrame } from '../player/frameStore.ts';
import { RATES, usePlayback } from '../player/usePlayback.ts';
import { Spinner } from '../ui/feedback.tsx';
import { BrandMark, I } from '../ui/icons.tsx';
import { IconButton, Tip } from '../ui/tip.tsx';
import { EmbedTips } from './EmbedTips.tsx';
import type { EmbedOptions } from './options.ts';
import { chapterAt, Scrubber } from './Scrubber.tsx';

/** How long the bar stays after the pointer last moved while the film plays. */
const IDLE_MS = 2500;

type Got = { state: 'loading' } | { state: 'gone' } | { state: 'ready'; d: EmbedResponse };

/** The link's player data: asked again while its copy is being made, and when the media stops working (`again`). */
function useEmbed(token: string | null): [Got, () => void] {
  const [got, setGot] = useState<Got>(token ? { state: 'loading' } : { state: 'gone' });
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is the ask to load it again
  useEffect(() => {
    if (!token) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/g/${token}/embed`, { cache: 'no-store' });
        if (!live) return;
        // an unknown, revoked, expired or other kind of link: the frame says the video isn't there, never why
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return setGot({ state: 'gone' });
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as EmbedResponse;
        setGot({ state: 'ready', d });
        if (!d.media && d.preparing) timer = setTimeout(load, d.busy ? 15_000 : 5000);
      } catch {
        // the server out of reach for a moment: ask again, the frame stays as it is
        if (live) timer = setTimeout(load, 10_000);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [token, asked]);
  return [got, useCallback(() => setAsked((n) => n + 1), [])];
}

/** A random id for this page's visit only (kept nowhere): the server keeps a key made from it, never an address. */
function visitId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function Embed({ token, options }: { token: string | null; options: EmbedOptions }) {
  const [got, again] = useEmbed(token);
  useEffect(() => {
    if (got.state === 'ready') document.title = got.d.title;
  }, [got]);
  if (got.state === 'gone' || !token)
    return (
      <div className="em em-gone" data-testid="em-gone">
        <I name="unlink" size={20} />
        <span>{t('client::This video isn’t available')}</span>
      </div>
    );
  if (got.state === 'loading') return <div className="em" data-state="loading" aria-busy="true" />;
  return <Player d={got.d} token={token} options={options} again={again} />;
}

function Player({ d, token, options, again }: { d: EmbedResponse; token: string; options: EmbedOptions; again: () => void }) {
  const ver = useMemo(
    () => ({ v: d.v, fps: d.fps, frames: d.frames, width: d.width, height: d.height, duration: d.duration }) as Version,
    [d.v, d.fps, d.frames, d.width, d.height, d.duration],
  );
  // before its first play it rests on the poster's frame (a film's first frame is often black); an autoplay starts at 0
  const rest = options.autoplay ? 0 : posterFrame(ver);
  const pb = usePlayback({ ver, url: d.media, startFrame: String(rest), b: null, quiet: true });
  const root = useRef<HTMLDivElement>(null);
  const [video, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const { setVideo } = pb;
  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      setVideo(el);
      setVideoEl(el);
    },
    [setVideo],
  );
  const [started, setStarted] = useState(false);
  const [visitor] = useState(visitId);

  // ---------------------------------------------------------------- what a visit counts
  // The visit (the link's opens, the video's view) on the first play: the page an embed sits on loads it for every
  // visitor of that page, watching or not. Then how far it plays, like any link's visitor (lib/watchReport.ts).
  const counted = useRef(false);
  useEffect(() => {
    if (!pb.playing) return;
    setStarted(true);
    if (counted.current) return;
    counted.current = true;
    fetch(`/api/g/${token}/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor, slug: d.slug, v: d.v }),
    }).catch(() => {});
  }, [pb.playing, token, visitor, d.slug, d.v]);
  useWatchReport({
    video: pb.videoRef,
    playing: pb.playing,
    about: JSON.stringify([token, d.slug, d.v]),
    on: true,
    send: (r, about) => {
      const [tk, slug, v] = JSON.parse(about) as [string, string, number];
      beacon(`/api/g/${tk}/progress`, { visitor, slug, v, ...r });
    },
  });

  // ---------------------------------------------------------------- playing
  const { play, pause, seek, frameRef, setMuted, setLoop, startReverse, setRate } = pb;
  /** Plays; the first time from the start (it rested on the poster's frame). */
  const start = useCallback(() => {
    if (!started) {
      setStarted(true);
      if (frameRef.current !== 0 && frameRef.current === rest) seek(0);
    }
    play();
  }, [started, frameRef, rest, seek, play]);
  // whether it plays, from the element itself: a key pressed again before the render its first one caused still knows
  const running = () => !!pb.revSpeed || (!!pb.videoRef.current && !pb.videoRef.current.paused);
  const toggle = () => (running() ? pause() : start());
  const step = (n: number) => {
    setStarted(true);
    seek(frameRef.current + n);
  };
  useEffect(() => setLoop(options.loop), [options.loop, setLoop]);
  // muted before it is asked to play: browsers let only a silent video start by itself
  useEffect(() => {
    if (!options.muted) return;
    if (video) video.muted = true;
    setMuted(true);
  }, [options.muted, video, setMuted]);
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!options.autoplay || !video || !d.media || autoplayed.current) return;
    autoplayed.current = true;
    video.muted = true;
    setStarted(true);
    play();
  }, [options.autoplay, video, d.media, play]);
  // a source that stays broken (the link revoked or expired while it played, after recover.ts tried again): ask
  useEffect(() => {
    if (!video) return;
    const f = () => again();
    video.addEventListener('error', f);
    return () => video.removeEventListener('error', f);
  }, [video, again]);

  // ---------------------------------------------------------------- the bar
  const [awake, setAwake] = useState(false);
  const [within, setWithin] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setAwake(false), IDLE_MS);
  }, []);
  useEffect(() => () => clearTimeout(idle.current), []);
  const playingOn = pb.playing || !!pb.revSpeed;
  // up while it rests, while the pointer moves, while a control of it has the keyboard's focus or a drag goes on; before
  // the first play only the big play button shows (and the bar, for the keyboard, once Tab reaches it)
  const bar = options.controls && (within || scrubbing || (started && (!playingOn || awake)));
  const scrubbed = useRef(false);
  const onScrub = (active: boolean) => {
    setScrubbing(active);
    // a drag pauses the film to show its frames; it plays on after one that began while it played
    if (active) scrubbed.current = playingOn;
    else if (scrubbed.current) play();
  };

  // ---------------------------------------------------------------- full screen, captions, sound
  const [full, setFull] = useState(false);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  type Fullscreen = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  // the frame's own full screen (the site allowed it: allowfullscreen), else an iPhone's own player's
  const canFull = document.fullscreenEnabled || !!(video as Fullscreen | null)?.webkitEnterFullscreen;
  const toggleFull = () => {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    if (document.fullscreenEnabled && root.current) return void root.current.requestFullscreen().catch(() => {});
    (video as Fullscreen | null)?.webkitEnterFullscreen?.();
  };
  const track = useRef<HTMLTrackElement>(null);
  const [captions, setCaptions] = useState(false);
  const [cue, setCue] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the track element comes with the captions
  useEffect(() => {
    const tt = track.current?.track;
    if (!tt) return;
    // loaded and followed, drawn by the player itself (above the bar, in the app's type), never by the browser
    tt.mode = 'hidden';
    const f = () => setCue([...(tt.activeCues ?? [])].map((c) => (c as VTTCue).text).join('\n'));
    tt.addEventListener('cuechange', f);
    return () => tt.removeEventListener('cuechange', f);
  }, [d.captions]);
  const toggleMute = () => setMuted((m) => !m);

  // ---------------------------------------------------------------- keys (as in the player)
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const target = e.target as Element | null;
    // a focused control answers Space and ↵ itself
    if ((e.key === ' ' || e.key === 'Enter') && target?.closest?.('button, a[href]')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => {
      e.preventDefault();
      if (options.controls) wake();
    };
    if (k === ' ' || k === 'k') {
      done();
      if (k === 'k') pause();
      else toggle();
    } else if (k === 'l') {
      done();
      if (!running() || pb.revSpeed) start();
      else setRate(pb.rate < 1 ? 1 : RATES[Math.min(RATES.length - 1, RATES.indexOf(pb.rate) + 1)] || 1);
    } else if (k === 'j') {
      done();
      setStarted(true);
      startReverse(pb.revSpeed ? Math.min(4, pb.revSpeed * 2) : 1);
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      done();
      step((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
    } else if (k === 'Home' || k === 'End') {
      done();
      setStarted(true);
      seek(k === 'Home' ? 0 : d.frames - 1);
    } else if (k === 'm') {
      done();
      toggleMute();
    } else if (k === 'f' && canFull) {
      done();
      toggleFull();
    } else if (k === 'c' && d.captions) {
      done();
      setCaptions((x) => !x);
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  // A press on the picture: the mouse plays or pauses (twice: full screen); a finger brings the bar up first.
  const pressed = useRef<string>('mouse');
  const onPicture = () => {
    if (pressed.current !== 'mouse' && options.controls && !bar && started) return wake();
    toggle();
    if (options.controls) wake();
  };

  const showBig = options.controls && !started && !pb.playing;
  const aspect = d.width / d.height || 16 / 9;
  return (
    <div
      ref={root}
      className="em"
      data-bar={bar ? 'shown' : 'hidden'}
      data-idle={playingOn && !bar ? '' : undefined}
      data-full={full ? '' : undefined}
      data-testid="em-player"
      onPointerMove={(e) => e.pointerType === 'mouse' && options.controls && wake()}
      onPointerLeave={() => setAwake(false)}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: its captions come with it when its version has them (a transcript) */}
      <video ref={videoRef} className="em-video" src={pb.src ?? undefined} poster={d.poster} preload="metadata" playsInline aria-label={d.title}>
        {d.captions && <track ref={track} kind="captions" src={d.captions} srcLang={d.captions_lang ?? undefined} label={t('client::Captions')} />}
      </video>
      <div
        className="em-surface"
        aria-hidden="true"
        onPointerDown={(e) => {
          pressed.current = e.pointerType;
        }}
        onClick={onPicture}
        onDoubleClick={() => canFull && pressed.current === 'mouse' && toggleFull()}
      />
      {!d.media && (
        <div className="em-wait" role="status">
          {d.preparing ? <Spinner /> : null}
          <span>{d.preparing ? t('client::Getting the video ready…') : t('client::This version can’t be played right now.')}</span>
        </div>
      )}
      {captions && cue && (
        <div className="em-cue" data-testid="em-cue">
          {cue}
        </div>
      )}
      {showBig && d.media && (
        <IconButton className="playbtn em-big" label={t('client::Play')} shortcut="Space" icon="play" size={20} onClick={start} data-testid="em-big-play" />
      )}
      {options.controls && (
        <>
          <div className="em-shade" aria-hidden="true" />
          {/* hidden, it stays in the tab order: the keyboard's focus brings it up */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: focus inside it holds it up; its controls are the controls */}
          <div
            className="em-bar"
            data-testid="em-bar"
            onFocus={(e) => setWithin(e.target.matches(':focus-visible'))}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setWithin(false)}
          >
            <Scrubber
              frames={d.frames}
              fps={d.fps}
              live={pb.live}
              chapters={d.chapters}
              sprite={d.sprite}
              aspect={aspect}
              video={video}
              onSeek={(f) => {
                setStarted(true);
                seek(f);
              }}
              onScrub={onScrub}
              label={t('client::Timeline')}
            />
            <div className="em-row">
              <IconButton
                className="playbtn em-play"
                label={playingOn ? t('client::Pause') : t('client::Play')}
                shortcut="Space"
                icon={playingOn ? 'pause' : 'play'}
                size={14}
                onClick={toggle}
                data-testid="em-play"
              />
              <IconButton
                className="btn ghost icon-only em-btn em-step"
                label={t('client::Previous frame')}
                tip={t('client::Previous frame (⇧ 10 back)')}
                shortcut="←"
                icon="stepBack"
                onClick={() => step(-1)}
              />
              <IconButton
                className="btn ghost icon-only em-btn em-step"
                label={t('client::Next frame')}
                tip={t('client::Next frame (⇧ 10 ahead)')}
                shortcut="→"
                icon="stepFwd"
                onClick={() => step(1)}
              />
              <Clock live={pb.live} fps={d.fps} frames={d.frames} chapters={d.chapters} rate={pb.revSpeed ? -pb.revSpeed : pb.rate} />
              <IconButton
                className="btn ghost icon-only em-btn"
                label={pb.muted ? t('client::Unmute') : t('client::Mute')}
                shortcut="M"
                icon={pb.muted ? 'mute' : 'volume'}
                onClick={toggleMute}
                aria-pressed={pb.muted}
                data-testid="em-mute"
              />
              {d.captions && (
                <IconButton
                  className={`btn ghost icon-only em-btn ${captions ? 'em-on' : ''}`}
                  label={t('client::Captions')}
                  shortcut="C"
                  icon="captions"
                  onClick={() => setCaptions((x) => !x)}
                  aria-pressed={captions}
                  data-testid="em-captions"
                />
              )}
              {canFull && (
                <IconButton
                  className="btn ghost icon-only em-btn"
                  label={full ? t('client::Exit full screen') : t('client::Full screen')}
                  shortcut="F"
                  icon={full ? 'fullscreenExit' : 'fullscreen'}
                  onClick={toggleFull}
                  data-testid="em-full"
                />
              )}
              {d.badge && <Mark />}
            </div>
          </div>
        </>
      )}
      {!options.controls && d.badge && (
        <div className="em-corner">
          <Mark />
        </div>
      )}
      <EmbedTips root={root} />
    </div>
  );
}

/** The Lampo mark: where the player comes from (hidden while the workspace hides its badge, on a plan that may). */
function Mark() {
  return (
    <Tip content={t('client::Powered by {brand}', { brand: BRAND_NAME })}>
      <a className="em-mark" href={SITE_URL} target="_blank" rel="noopener noreferrer" aria-label={BRAND_NAME} data-testid="em-mark">
        <BrandMark size={18} />
      </a>
    </Tip>
  );
}

/** The timecode with frames as the app shows it, the last frame's beside it, the chapter it is in, and the speed when
 * it isn't 1×. Renders on every frame while the film plays (frameStore.ts), alone. */
function Clock({ live, fps, frames, chapters, rate }: { live: FrameStore; fps: number; frames: number; chapters: Chapter[]; rate: number }) {
  const f = useFrame(live);
  const chapter = chapterAt(chapters, f);
  return (
    <div className="em-clock" data-testid="em-clock">
      <span className="em-time">
        <span data-testid="em-tc">{timecode(f, fps)}</span>
        <span className="em-total"> / {timecode(frames - 1, fps)}</span>
      </span>
      {rate !== 1 && <span className="em-rate">{rate < 0 ? `◀ ${-rate}×` : `${rate}×`}</span>}
      {chapter && <span className="em-chapter">{chapter.title}</span>}
    </div>
  );
}
