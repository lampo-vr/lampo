// The pages in front of a review: a password, an expired link, a link that isn't valid, a link with nothing behind it
// yet, a link the server can't open this moment. They read like an invitation from a person, not like an error: who
// shared what, one sentence, the way in.
import { type FormEvent, useState } from 'react';
import type { GuestFoot } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { useCooldown } from '../lib/hooks.ts';
import { ErrorLine, GoButton, PasswordField, useMisses } from '../ui/EntryForm.tsx';
import { useGuestActions } from './guest.ts';
import { InviteShell } from './Invite.tsx';

/** Who shared the link, as far as the page knows it. */
export interface Sharer {
  name?: string | null;
  avatar?: string | null;
  org?: string | null;
}

const longDate = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
};

export function Gate({
  kind,
  label,
  sharer = {},
  expired,
  foot,
}: {
  /** later: the server can't check the link this moment (503, 429): come back, the page asks again by itself. */
  kind: 'expired' | 'invalid' | 'empty' | 'later';
  label?: string;
  sharer?: Sharer;
  expired?: string | null;
  /** The page's foot (the source offer, the operator's legal pages), when the link's answer said it. */
  foot?: GuestFoot | null;
}) {
  const who = sharer.name || null;
  if (kind === 'expired') {
    const on = longDate(expired);
    return (
      <InviteShell
        sharer={who}
        avatar={sharer.avatar}
        org={sharer.org}
        from={t('client::shared this review with you')}
        icon={who ? undefined : 'clock'}
        title={t('client::This link has expired')}
        lede={
          <>
            {on ? t('client::It stopped working on {date}.', { date: on }) : t('client::It doesn’t open the review any more.')}{' '}
            {who ? t('client::Ask {name} for a new one.', { name: who }) : t('client::Ask whoever sent it for a new one.')}
          </>
        }
      />
    );
  }
  if (kind === 'empty')
    return (
      <InviteShell
        sharer={who}
        avatar={sharer.avatar}
        org={sharer.org}
        from={t('client::shared a review with you')}
        icon={who ? undefined : 'clock'}
        foot={foot}
        title={label || t('client::Nothing to review yet')}
        lede={t('client::The video isn’t here yet. Come back to this link a little later; it will open by itself.')}
      />
    );
  if (kind === 'later')
    return (
      <InviteShell
        icon="clock"
        title={t('client::One moment, please')}
        lede={t('client::The review can’t open right now. This page tries again by itself, or come back to this link a little later.')}
      />
    );
  return (
    <InviteShell
      icon="unlink"
      title={t('client::This link isn’t available')}
      lede={t('client::It may have been switched off, or the address got cut short when it was copied. Ask the person who sent it for a new one.')}
    />
  );
}

export function PasswordGate({ token, label, sharer = {}, foot }: { token: string; label: string; sharer?: Sharer; foot?: GuestFoot | null }) {
  const { unlock } = useGuestActions(token);
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const [opening, setOpening] = useState(false);
  const wait = useCooldown();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (wait.left || unlock.isPending || opening) return;
    if (!password) return tries.miss(t('client::Type the password first.'), 'password');
    tries.clear();
    // the review mounts while the unlock settles: it fades in (guest.css, :root[data-entering])
    const root = document.documentElement;
    root.dataset.entering = '';
    try {
      await unlock.mutateAsync(password);
      setOpening(true);
      setTimeout(() => root.removeAttribute('data-entering'), 600);
    } catch (err) {
      root.removeAttribute('data-entering');
      if (err instanceof ApiError && err.status === 429) wait.start(err.retryAfter || 60);
      else if (err instanceof ApiError && err.status === 403) tries.miss(t('client::That’s not the password. Check for typos and try again.'), 'password');
      else tries.miss(err instanceof Error ? err.message : String(err), 'password');
      document.querySelector<HTMLInputElement>('#gate-pw')?.select();
    }
  };
  const message = wait.left ? t('client::Too many tries. Try again in {label}.', { label: wait.label }) : tries.error;
  return (
    <InviteShell
      sharer={sharer.name}
      avatar={sharer.avatar}
      org={sharer.org}
      from={t('client::shared a review with you')}
      icon={sharer.name ? undefined : 'lock'}
      title={label || t('client::A review for you')}
      lede={t('client::It’s protected. Enter the password that came with the link.')}
      foot={foot}
      opening={opening}
    >
      <form className="inv-form" onSubmit={submit} aria-busy={unlock.isPending || opening} noValidate>
        <PasswordField
          id="gate-pw"
          name="password"
          label={t('client::Password')}
          showLabel={t('client::Show the password')}
          hideLabel={t('client::Hide the password')}
          autoComplete="current-password"
          // the password is the only thing this page asks for
          autoFocus
          value={password}
          disabled={opening}
          bad={!!message}
          shake={tries.shakeOf('password')}
          aria-describedby="gate-msg"
          onChange={(e) => {
            setPassword(e.target.value);
            tries.clear();
          }}
        />
        <ErrorLine id="gate-msg">{message}</ErrorLine>
        <GoButton busy={unlock.isPending || opening} disabled={unlock.isPending || opening || !!wait.left}>
          {opening ? t('client::Opening the review…') : t('client::Open the review')}
        </GoButton>
      </form>
    </InviteShell>
  );
}
