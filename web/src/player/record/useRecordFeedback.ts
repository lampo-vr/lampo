// Recorded feedback in the player: start (⇧R or the Record button), talk, point and draw while the video plays; Done
// sends the audio and the event log to the server, which hears it and makes draft notes (the notes panel shows them
// until they are sent). The recorder and its UI are loaded on first use (lib/lazy.ts): nothing of it is in the player's
// first paint. Leaving the player while recording finishes it (its drafts wait for you); closing the tab asks first.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keys } from '../../api/queries.ts';
import { uploadRecording, useRecordings } from '../../api/recordings.ts';
import type { Recording, Shape, Tool } from '../../api/types.ts';
import { t } from '../../i18n/index.ts';
import { loader } from '../../lib/lazy.ts';
import { errorMessage, toast } from '../../lib/toast.ts';
import type { FrameStore } from '../frameStore.ts';
import type { Recorder } from './recorder.ts';

export const recorderCode = loader(() => import('./recorder.ts'));
export const recordUi = loader(() => import('./RecordUI.tsx'));

export type RecordPhase = 'idle' | 'starting' | 'rec' | 'paused' | 'saving';

export interface Stroke {
  f: number;
  shape: Shape;
}

export interface RecordFeedback {
  phase: RecordPhase;
  /** Recording or paused: the bar over the picture shows. */
  active: boolean;
  recorder: Recorder | null;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Shapes drawn while recording (shown on their frame while paused there). */
  strokes: Stroke[];
  addStroke: (shape: Shape) => void;
  start: () => void;
  finish: () => void;
  pause: () => void;
  resume: () => void;
  discard: () => void;
  toggle: () => void;
  /** Where the bar's level meter listens (set by the bar; the recorder calls it, no React renders). */
  level: { current: ((n: number) => void) | null };
  /** This video's recordings waiting for you: being heard, or drafts to review. */
  pending: Recording[];
}

interface Options {
  slug: string;
  v: number;
  fps: number;
  frames: FrameStore;
  video: () => HTMLVideoElement | null;
  /** Speech-to-text runs on this server (recording needs it). */
  enabled: boolean;
}

export function useRecordFeedback({ slug, v, fps, frames, video, enabled }: Options): RecordFeedback {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<RecordPhase>('idle');
  const [tool, setTool] = useState<Tool>('none');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const rec = useRef<Recorder | null>(null);
  const level = useRef<((n: number) => void) | null>(null);
  const active = phase === 'rec' || phase === 'paused';
  const pending = useRecordings(slug, enabled).data?.recordings ?? [];

  const done = useCallback(() => {
    rec.current = null;
    setStrokes([]);
    setTool('none');
    setPhase('idle');
  }, []);

  // Finishing: the audio and the log go up; the server hears them and the drafts appear in the notes panel.
  const upload = useCallback(
    async (r: Recorder, take?: { v: number; slug: string }) => {
      const to = take ?? { v, slug };
      const result = await r.stop();
      const drew = result.events.some((e) => e.k === 'stroke');
      if (result.duration < 1 && !drew) return toast(t('That was too short to hear. Press ⇧R and talk while you watch.'));
      // Speech models invent sentences for silence: a recording nobody spoke into is only worth its drawings.
      if (result.peak < 0.02 && !drew) return toast(t("Didn't hear anything. Check the microphone and record again."), 'error');
      await uploadRecording(to.slug, to.v, result);
      await qc.invalidateQueries({ queryKey: keys.recordings(to.slug) });
    },
    [qc, slug, v],
  );

  const start = useCallback(async () => {
    if (rec.current || phase !== 'idle') return;
    if (!navigator.mediaDevices || !window.isSecureContext)
      return toast(t('Recording needs the microphone, which this page may not use (open it over https or on this machine).'), 'error');
    setPhase('starting');
    try {
      const mod = await recorderCode.load();
      rec.current = await mod.startRecorder({
        frames,
        video,
        fps,
        onLevel: (n) => level.current?.(n),
        onLimit: () => finishRef.current(),
      });
      setPhase('rec');
    } catch (e) {
      rec.current = null;
      setPhase('idle');
      toast(t('Microphone: {errorMessage}', { errorMessage: errorMessage(e) }), 'error');
    }
  }, [phase, frames, video, fps]);

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r) return;
    setPhase('saving');
    try {
      await upload(r);
    } catch (e) {
      toast(t('The recording could not be sent: {errorMessage}', { errorMessage: errorMessage(e) }), 'error');
    } finally {
      done();
    }
  }, [upload, done]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const discard = useCallback(() => {
    rec.current?.discard();
    done();
  }, [done]);

  const pause = useCallback(() => {
    rec.current?.pause();
    setPhase((p) => (p === 'rec' ? 'paused' : p));
  }, []);
  const resume = useCallback(() => {
    rec.current?.resume();
    setPhase((p) => (p === 'paused' ? 'rec' : p));
  }, []);

  const addStroke = useCallback(
    (shape: Shape) => {
      const f = frames.get();
      rec.current?.stroke(shape, f);
      setStrokes((s) => [...s, { f, shape }]);
    },
    [frames],
  );

  // Another version on screen: what was said so far belongs to the version it was said about.
  const madeOn = useRef({ slug, v });
  useEffect(() => {
    if (!active) madeOn.current = { slug, v };
    else if (madeOn.current.v !== v || madeOn.current.slug !== slug) finishRef.current();
  }, [slug, v, active]);

  // Closing the tab while recording asks first; leaving the player finishes the recording on the way out.
  useEffect(() => {
    if (!active) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [active]);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(
    () => () => {
      const r = rec.current;
      rec.current = null;
      if (r) uploadRef.current(r, madeOn.current).catch(() => {});
    },
    [],
  );

  const toggle = useCallback(() => {
    if (phase === 'idle') start();
    else if (phase === 'rec' || phase === 'paused') finish();
  }, [phase, start, finish]);

  return { phase, active, recorder: rec.current, tool, setTool, strokes, addStroke, start, finish, pause, resume, discard, toggle, level, pending };
}
