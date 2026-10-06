// The walkie-talkie on a touch screen: press and hold to talk, release to pin the note (T does the same on a
// keyboard). Browsers only hand out the microphone on https or localhost; on a plain-http LAN address we say so.

import { t } from '../i18n/index.ts';
import { toast } from '../lib/toast.ts';
import { IconButton } from '../ui/primitives.tsx';
import type { WalkieState } from './useWalkie.ts';

interface MicButtonProps {
  state: WalkieState | null;
  level: number;
  start: () => void;
  stop: () => void;
}

export function MicButton({ state, level, start, stop }: MicButtonProps) {
  const recording = state?.phase === 'rec';
  const busy = state?.phase === 'busy';
  const usable = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices;
  return (
    <IconButton
      className={`btn sm icon-only mic ${recording ? 'rec' : ''} ${busy ? 'busy' : ''}`}
      style={recording ? { boxShadow: `0 0 0 ${2 + Math.round(level * 14)}px var(--must-glow)` } : undefined}
      label={t('Hold to record a voice note')}
      tip={t('Hold to talk')}
      shortcut="hold T"
      icon="mic"
      size={17}
      disabled={busy}
      onPointerDown={(e) => {
        if (!usable) {
          toast(t('Voice notes need https or localhost: the browser keeps the microphone off on a plain http address.'), 'error');
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={() => usable && stop()}
      onPointerCancel={() => usable && stop()}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
