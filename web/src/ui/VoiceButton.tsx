// The voice button: record from the microphone, and the server hears it (POST /api/voice: the speech engine and the
// speaker's languages from Settings → Speech) — the words land in the text to edit before sending. The composer keeps
// the clip as the note's voice note; a reason ("Still wrong") keeps the words only: replies have no voice notes.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { useInfo } from '../api/queries.ts';
import type { VoiceResult } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useStableCallback } from '../lib/hooks.ts';
import { errorMessage, toast } from '../lib/toast.ts';
import { Spinner } from './feedback.tsx';
import { I } from './icons.tsx';
import { IconButton } from './primitives.tsx';

/** A clip heard (its id waits in the server's cache until a note keeps it), or one being heard. */
export type VoiceClip = { busy: true } | { busy?: false; id: string; transcript: string | null } | null;

/** Appends what was said to what is written. */
export const withSaid = (text: string, said: string): string => (text.trim() ? `${text.trim()} ${said}` : said);

/**
 * Recording and hearing one clip. `onSaid` gets the words as heard (nothing when the server has no speech-to-text);
 * leaving while recording stops the microphone and sends nothing.
 */
export function useVoice(onSaid: (said: string) => void) {
  const [clip, setClip] = useState<VoiceClip>(null);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const gone = useRef(false);
  const said = useStableCallback(onSaid);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (rec.current?.state === 'recording') rec.current.stop();
    };
  }, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        for (const tr of stream.getTracks()) tr.stop();
        if (gone.current) return;
        setClip({ busy: true });
        try {
          const res = await api<VoiceResult>('/api/voice', { method: 'POST', raw: new Blob(chunks, { type: mr.mimeType }) });
          if (gone.current) return;
          setClip({ id: res.id, transcript: res.transcript });
          if (res.transcript) said(res.transcript);
          else if (!res.whisper) toast(t('Voice note attached. No speech-to-text available, so no transcript.'), 'info');
          else toast(t('No words heard in that recording.'), 'info');
        } catch (e) {
          setClip(null);
          toast(errorMessage(e), 'error');
        }
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
    } catch (e) {
      toast(t('Microphone: {errorMessage}', { errorMessage: errorMessage(e) }), 'error');
    }
  };
  const stop = () => {
    rec.current?.stop();
    setRecording(false);
  };

  return {
    clip,
    /** Forget the clip (the composer's chip takes the voice note off). */
    clear: () => setClip(null),
    recording,
    busy: !!clip?.busy,
    /** The heard clip's id, for a note to keep. */
    id: clip && !clip.busy ? clip.id : undefined,
    start,
    stop,
    /** The browser lets this page use a microphone (a secure page with media devices). */
    canRecord: typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices,
  };
}

export type Voice = ReturnType<typeof useVoice>;

/**
 * The microphone as an icon button: record, stop, a spinner while the words are heard. `words`: only where the words
 * are all that is kept (a reason) — then it shows only when this server turns speech into text.
 */
export function VoiceButton({
  voice,
  label,
  tip,
  again,
  words = false,
  className = 'btn sm ghost icon-only',
}: {
  voice: Voice;
  /** The button's name at rest, and its tooltip. */
  label: string;
  tip: string;
  /** The name once a clip was heard (record it again); the resting name when absent. */
  again?: string;
  words?: boolean;
  className?: string;
}) {
  const info = useInfo();
  if (!voice.canRecord || (words && !info?.whisper)) return null;
  const { recording, busy } = voice;
  return (
    <IconButton
      className={`${className} voice-btn ${recording ? 'on' : ''}`}
      label={recording ? t('Stop recording') : busy ? t('Transcribing…') : (voice.id && again) || label}
      tip={recording ? t('Stop recording') : tip}
      onClick={recording ? voice.stop : voice.start}
      disabled={busy}
      aria-pressed={recording}
      data-testid="voice"
    >
      {busy ? <Spinner /> : <I name={recording ? 'stop' : 'mic'} size={15} className={recording ? 'rec' : ''} />}
    </IconButton>
  );
}

/**
 * The voice button of a reason ("Still wrong"): what is said is added to the text, to edit before sending; the clip
 * itself isn't kept (replies have no voice notes). `onHold` hears while it records or the words are being heard, so
 * the form can wait for them. Shows only where this server turns speech into text.
 */
export function SayButton({
  onSaid,
  onHold,
  label = t('Say what is still wrong'),
  tip = t('Say it: the words land in the text, to edit before you send them'),
  className,
}: {
  onSaid: (said: string) => void;
  onHold?: (held: boolean) => void;
  label?: string;
  tip?: string;
  className?: string;
}) {
  const voice = useVoice(onSaid);
  const held = voice.recording || voice.busy;
  const hold = useStableCallback((h: boolean) => onHold?.(h));
  useEffect(() => {
    hold(held);
  }, [held, hold]);
  return <VoiceButton voice={voice} words label={label} tip={tip} className={className} />;
}
