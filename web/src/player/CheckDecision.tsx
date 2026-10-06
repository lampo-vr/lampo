// The decision on a fix to check — Looks right · Still wrong, and the reason (typed or said) opening in its place —
// shared by check mode's card (VerifyPanel.tsx) and the note's card in the panel (CommentCard.tsx): one component, so
// both ask the same and send the same (fixCheck.ts checkVerdict). Only one asks at a time: while check mode runs, its
// card over the picture does, and the note's card in the panel shows where the note stands.

import { type ReactNode, useState } from 'react';
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { Kbd } from '../ui/primitives.tsx';
import { SayButton, withSaid } from '../ui/VoiceButton.tsx';

/** On a client's note, what the team writes on it — a reply, a reason — is shown to the client through every review link
 * that shows the note (A12 GUEST-7): said where it is written. */
export function ClientReads({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <p className="client-reads" data-testid="client-reads">
      <I name="eye" size={12} /> {t('{name} can see this on the review link.', { name })}
    </p>
  );
}

export function CheckDecision({
  id,
  fixed,
  busy,
  onRight,
  onWrong,
  reopening,
  onReopening,
  client,
  keys = false,
  small = false,
  rightLabel,
  initial = '',
  children,
}: {
  /** The note: a new one starts a new reason. */
  id: string;
  /** Marked fixed (Still wrong reopens it), else carried to a new version (Still wrong keeps it open). */
  fixed: boolean;
  busy: boolean;
  onRight: () => void;
  onWrong: (reason: string) => void;
  /** The reason is being given (check mode's N opens it too). */
  reopening: boolean;
  onReopening: (on: boolean) => void;
  /** The note's client, who sees the reason (A12 GUEST-7). */
  client: string | null;
  /** Check mode: the keys on the buttons (Y, N). */
  keys?: boolean;
  /** The note's card: the panel's smaller buttons. */
  small?: boolean;
  rightLabel?: string;
  /** Words to start the reason with (a reply that was being written). */
  initial?: string;
  /** More at the row's end (check mode's Skip). */
  children?: ReactNode;
}) {
  const sm = small ? ' sm' : '';
  if (reopening)
    return (
      <StillWrong key={id} fixed={fixed} busy={busy} onSend={onWrong} onCancel={() => onReopening(false)} client={client} initial={initial} small={small} />
    );
  return (
    <div className="verify-actions check-decision" data-testid="check-decision">
      <button type="button" className={`btn ok${sm}`} onClick={onRight} disabled={busy}>
        <I name="check" size={small ? 14 : 15} /> {rightLabel ?? t('Looks right')} {keys && <Kbd>Y</Kbd>}
      </button>
      <button type="button" className={`btn${sm}`} onClick={() => onReopening(true)} disabled={busy}>
        <I name="x" size={small ? 13 : 14} /> {t('Still wrong')} {keys && <Kbd>N</Kbd>}
      </button>
      {children}
    </div>
  );
}

/** Why it is still wrong, typed or said (the words land in the field to edit), then back to the agent. */
function StillWrong({
  fixed,
  busy,
  onSend,
  onCancel,
  client,
  initial,
  small,
}: {
  fixed: boolean;
  busy: boolean;
  onSend: (reason: string) => void;
  onCancel: () => void;
  client: string | null;
  initial: string;
  small: boolean;
}) {
  const [note, setNote] = useState(initial);
  // while the microphone is live or the words are being heard, the reason isn't complete yet
  const [held, setHeld] = useState(false);
  const send = () => !held && !busy && onSend(note);
  return (
    <>
      <div className={`verify-actions verify-reason${small ? ' sm' : ''}`} data-testid="verify-reason">
        <input
          className="input grow"
          autoFocus
          placeholder={fixed ? t('What is still wrong? (optional) · Enter reopens') : t('What is still wrong? (optional) · Enter keeps it open')}
          aria-label={t('What is still wrong')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
            if (e.key === 'Escape') {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <SayButton onSaid={(said) => setNote((x) => withSaid(x, said))} onHold={setHeld} />
        <button type="button" className="btn sm" onClick={send} disabled={busy || held}>
          {fixed ? t('Reopen') : t('Keep open')}
        </button>
      </div>
      <ClientReads name={client} />
    </>
  );
}
