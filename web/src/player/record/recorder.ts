// Recording feedback in the browser: the microphone (MediaRecorder, like voice notes) and, on the audio's own clock,
// what happened on screen — the frame (from the frame store: exact when paused, every FRAME_SAMPLE s while playing),
// play/pause, jumps, the pointer over the picture (every POINTER_SAMPLE s while it is there, also at rest: resting is
// pointing), clicks, and the shapes drawn. lib/recording.ts turns it into drafts on the server. Loaded on first use.
import { FRAME_SAMPLE, POINTER_SAMPLE, RECORDING_MAX_EVENTS, RECORDING_MAX_SECONDS } from '../../../../lib/recording.ts';
import type { RecordingEvent, Shape } from '../../api/types.ts';
import type { FrameStore } from '../frameStore.ts';

export interface RecorderOptions {
  frames: FrameStore;
  /** The main picture's video element (the one whose frames the store reports). */
  video: () => HTMLVideoElement | null;
  fps: number;
  /** The microphone's level, 0–1, a few dozen times a second (for a meter; no React state). */
  onLevel?: (level: number) => void;
  /** The ten minutes are up. */
  onLimit?: () => void;
}

export interface RecordingResult {
  audio: Blob;
  duration: number;
  events: RecordingEvent[];
  /** The loudest moment, 0–1: a microphone that heard nothing is worth saying so. */
  peak: number;
}

export interface Recorder {
  readonly paused: boolean;
  /** Seconds recorded so far (paused stretches don't count). */
  seconds(): number;
  pause(): void;
  resume(): void;
  /** A shape drawn on frame f while recording. */
  stroke(shape: Shape, f: number): void;
  stop(): Promise<RecordingResult>;
  discard(): void;
}

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** An event before it has its second on the clock. */
type Unstamped<T> = T extends unknown ? Omit<T, 't'> & { t?: number } : never;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export async function startRecorder(o: RecorderOptions): Promise<Recorder> {
  // Echo cancellation: the video's own sound, playing through the speakers, is not what was said.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const type = TYPES.find((x) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(x));
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // the meter
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  let peak = 0;
  let raf = 0;
  const meter = () => {
    an.getByteTimeDomainData(buf);
    let m = 0;
    for (const v of buf) m = Math.max(m, Math.abs(v - 128));
    const level = m / 128;
    if (!paused) peak = Math.max(peak, level);
    o.onLevel?.(paused ? 0 : level);
    raf = requestAnimationFrame(meter);
  };

  // the clock: the audio's seconds (a paused recording stops it)
  let started = 0;
  let paused = false;
  let pausedAt = 0;
  let pausedFor = 0;
  const now = () => ((paused ? pausedAt : performance.now()) - started - pausedFor) / 1000;

  const events: RecordingEvent[] = [];
  const log = (e: Unstamped<RecordingEvent>) => {
    if (paused || events.length >= RECORDING_MAX_EVENTS) return;
    events.push({ ...e, t: round3(e.t ?? Math.max(0, now())) } as RecordingEvent);
  };

  const video = o.video();
  const playing = () => !!video && !video.paused;

  // The frame on screen: every change while paused (stepping is precise), sampled while it plays.
  let lastFrameAt = -1;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const logFrame = () => {
    trailing = null;
    lastFrameAt = now();
    log({ k: 'frame', f: o.frames.get() });
  };
  const unsubscribe = o.frames.subscribe(() => {
    if (!playing()) return logFrame();
    if (now() - lastFrameAt >= FRAME_SAMPLE) return logFrame();
    trailing ??= setTimeout(logFrame, FRAME_SAMPLE * 1000);
  });
  // A jump (a click on the timeline, a note, ⇧→ ten frames and more than a second) splits what is said there; stepping
  // frame by frame doesn't.
  const onSeeking = () => {
    if (!video) return;
    const to = Math.floor(video.currentTime * o.fps);
    if (Math.abs(to - o.frames.get()) > o.fps) log({ k: 'seek', f: to });
  };
  const onPlay = () => log({ k: 'play' });
  const onPause = () => {
    log({ k: 'pause' });
    logFrame();
  };
  video?.addEventListener('seeking', onSeeking);
  video?.addEventListener('play', onPlay);
  video?.addEventListener('pause', onPause);

  // The pointer over the picture: its box is the video's (`.vbox` holds exactly the picture).
  let px = -1;
  let py = -1;
  const where = (x: number, y: number): [number, number] | null => {
    const box = video?.closest('.vbox')?.getBoundingClientRect();
    if (!box?.width || !box.height) return null;
    const nx = (x - box.left) / box.width;
    const ny = (y - box.top) / box.height;
    return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? [clamp01(nx), clamp01(ny)] : null;
  };
  const onMove = (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const at = where(e.clientX, e.clientY);
    if (at) log({ k: 'click', x: round3(at[0]), y: round3(at[1]) });
  };
  const onLeave = () => {
    px = -1;
  };
  const sample = setInterval(() => {
    if (px < 0) return;
    const at = where(px, py);
    if (at) log({ k: 'pointer', x: round3(at[0]), y: round3(at[1]) });
  }, POINTER_SAMPLE * 1000);
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);

  const limit = setInterval(() => {
    if (now() >= RECORDING_MAX_SECONDS) o.onLimit?.();
  }, 500);

  const cleanup = () => {
    unsubscribe();
    if (trailing) clearTimeout(trailing);
    clearInterval(sample);
    clearInterval(limit);
    video?.removeEventListener('seeking', onSeeking);
    video?.removeEventListener('play', onPlay);
    video?.removeEventListener('pause', onPause);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerdown', onDown, { capture: true });
    document.documentElement.removeEventListener('pointerleave', onLeave);
    cancelAnimationFrame(raf);
    for (const tr of stream.getTracks()) tr.stop();
    ac.close().catch(() => {});
  };

  await new Promise<void>((resolve) => {
    mr.onstart = () => resolve();
    // one-second slices: a long recording never waits in one piece
    mr.start(1000);
  });
  started = performance.now();
  log({ t: 0, k: 'frame', f: o.frames.get() });
  if (playing()) log({ t: 0, k: 'play' });
  meter();

  const resume = () => {
    if (!paused) return;
    pausedFor += performance.now() - pausedAt;
    paused = false;
    mr.resume();
    // where things stand now, on the clock that goes on
    log({ k: 'frame', f: o.frames.get() });
    log({ k: playing() ? 'play' : 'pause' });
  };

  return {
    get paused() {
      return paused;
    },
    seconds: () => Math.max(0, now()),
    pause() {
      if (paused || mr.state !== 'recording') return;
      logFrame();
      mr.pause();
      pausedAt = performance.now();
      paused = true;
    },
    resume,
    stroke(shape, f) {
      log({ k: 'stroke', f, shape });
    },
    async stop() {
      resume();
      logFrame();
      const duration = round3(now());
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        if (mr.state === 'inactive') resolve();
        else mr.stop();
      });
      cleanup();
      return { audio: new Blob(chunks, { type: mr.mimeType || type || 'audio/webm' }), duration, events, peak };
    },
    discard() {
      mr.onstop = null;
      if (mr.state !== 'inactive') mr.stop();
      cleanup();
    },
  };
}
