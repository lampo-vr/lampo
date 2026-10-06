// "Send it again" under a "Check your inbox": a sign-up's, a reset's, an invite taken on a server with workspaces.
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { pad } from '../lib/format.ts';
import { useCooldown } from '../lib/hooks.ts';
import { StatusLine } from '../ui/Entrance.tsx';
import { AltButton, ErrorLine } from '../ui/EntryForm.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';

const tooMany = (e: unknown) => e instanceof ApiError && e.status === 429;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Send it again" with a minute's wait after each send (the server limits it too): the wait counts down on the button,
 * and what happened is said once, politely. While it waits the button says so to assistive tech and takes no press,
 * but keeps the focus it had (disabled, it dropped the keyboard's focus to the page).
 */
export function SendAgain({ send, label = t('Send it again') }: { send: () => Promise<unknown>; label?: string }) {
  const wait = useCooldown();
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const off = state === 'busy' || wait.left > 0;
  const go = async () => {
    if (off) return;
    setState('busy');
    try {
      await send();
      setState('sent');
      wait.start(60);
    } catch (e) {
      setState('error');
      setError(tooMany(e) ? t('Too many emails for now. Try again later.') : message(e));
      if (e instanceof ApiError && e.retryAfter) wait.start(e.retryAfter);
    }
  };
  return (
    <div className="inv-form">
      <AltButton onClick={go} aria-disabled={off || undefined} data-testid="send-again">
        {state === 'busy' ? <Spinner /> : <I name="send" size={14} />}
        <span>{wait.left > 0 ? t('{label} in {time}', { label, time: `${Math.floor(wait.left / 60)}:${pad(wait.left % 60)}` }) : label}</span>
      </AltButton>
      {state === 'error' ? <ErrorLine>{error}</ErrorLine> : <StatusLine>{state === 'sent' ? t('Sent again. Only the newest link works.') : null}</StatusLine>}
    </div>
  );
}
