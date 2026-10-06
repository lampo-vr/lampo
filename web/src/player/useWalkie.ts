// Walkie-talkie: hold a key and talk. The note is pinned to the frame where you started (a range if the video kept
// playing), transcribed on the server and auto-tagged.
import { useCallback, useRef, useState } from 'react';
import { autoSeverity, autoTags } from '../../../lib/autotag.ts';
import { api, enc } from '../api/client.ts';
import type { Comment, VoiceResult } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { errorMessage, toast } from '../lib/toast.ts';

export interface WalkieContext {
  frame: number;
  v: number;
  playing: boolean;
}
export interface WalkieState {
  phase: 'rec' | 'busy';
  frame: number;
}

interface Recording {
  mr: MediaRecorder;
  stream: MediaStream;
  ac: AudioContext;
  stopMeter: () => void;
  ctx: WalkieContext;
  chunks: Blob[];
  peak: { max: number };
  t0: number;
}

interface WalkieOptions {
  slug: string;
  getContext: () => WalkieContext;
  onSaved: (c: Comment, audioOnly: boolean) => void;
}

export function useWalkie({ slug, getContext, onSaved }: WalkieOptions) {
  const rec = useRef<Recording | { pending: true } | null>(null);
  const [state, setState] = useState<WalkieState | null>(null);
  const [level, setLevel] = useState(0);

  const start = useCallback(async () => {
    if (rec.current || !navigator.mediaDevices || !window.isSecureContext) return;
    const ctx = getContext();
    rec.current = { pending: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!rec.current) {
        // T was released while the browser was still asking for the microphone (first use).
        for (const t of stream.getTracks()) t.stop();
        return toast(t('Microphone ready. Hold T again while you talk.'));
      }
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const ac = new AudioContext();
      const an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf = 0;
      const peak = { max: 0 };
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let m = 0;
        for (const v of buf) m = Math.max(m, Math.abs(v - 128));
        peak.max = Math.max(peak.max, m / 128);
        setLevel(m / 128);
        raf = requestAnimationFrame(tick);
      };
      tick();
      rec.current = { mr, stream, ac, stopMeter: () => cancelAnimationFrame(raf), ctx, chunks, peak, t0: performance.now() };
      mr.start();
      setState({ phase: 'rec', frame: ctx.frame });
    } catch (e) {
      rec.current = null;
      toast(t('Microphone: {errorMessage}', { errorMessage: errorMessage(e) }), 'error');
    }
  }, [getContext]);

  const stop = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    if (!r || 'pending' in r) return;
    const end = getContext();
    await new Promise((res) => {
      r.mr.onstop = res;
      r.mr.stop();
    });
    for (const t of r.stream.getTracks()) t.stop();
    r.stopMeter();
    r.ac.close();
    if (performance.now() - r.t0 < 450) return setState(null); // a tap, not a note
    if (r.peak.max < 0.03) {
      // Speech models invent sentences for silence; don't pin one.
      setState(null);
      return toast(t("Didn't hear anything. Check the microphone and hold T while you talk."), 'error');
    }
    setState({ phase: 'busy', frame: r.ctx.frame });
    try {
      const voice = await api<VoiceResult>('/api/voice', { method: 'POST', raw: new Blob(r.chunks, { type: r.mr.mimeType }) });
      const text = voice.transcript || '';
      const range = r.ctx.playing && end.frame > r.ctx.frame + 3 ? { in: r.ctx.frame, out: end.frame } : null;
      const c = await api<Comment>(`/api/review/${enc(slug)}/comments`, {
        method: 'POST',
        body: {
          v: r.ctx.v,
          frame: r.ctx.frame,
          range,
          text,
          tags: autoTags(text),
          severity: autoSeverity(text),
          voiceId: voice.id,
          voiceTranscript: voice.transcript ?? null,
        },
      });
      onSaved(c, !voice.whisper);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    setState(null);
  }, [getContext, onSaved, slug]);

  return { state, level, start, stop };
}
