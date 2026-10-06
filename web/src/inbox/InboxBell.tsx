// The inbox's way in, in every top bar: a bell with what's waiting. It opens a popover on desktop and tablet (growing
// into list + preview side by side on wide screens) and a sheet on phones — the page underneath stays as it was. The
// inbox itself (InboxLayer.tsx) is its own chunk, fetched once the first paint is done (or when the bell is pointed at).
import { useQueryClient } from '@tanstack/react-query';
import { type ButtonHTMLAttributes, type Ref, useEffect, useId, useState } from 'react';
import { useAuthStatus } from '../api/auth.ts';
import { keys } from '../api/queries.ts';
import { afterPaint, loader, useLoaded } from '../lib/lazy.ts';
import { usePhone } from '../lib/media.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, useAnchor } from '../ui/primitives.tsx';
import { useVisibleForYou } from './hidden.ts';
import { setInbox, useInbox } from './state.ts';
import '../styles/inbox.css';
import { t } from '../i18n/index.ts';

/** The inbox's chunk, asked for after every first paint. */
export const inboxCode = loader(() => import('./InboxLayer.tsx'));
const fetchInbox = () => void inboxCode.load().catch(() => {});

function Bell({ n, ref, ...rest }: { n: number; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <IconButton
      ref={ref}
      className="btn ghost sm icon-only inbox-bell"
      label={n ? t('Inbox, {n} waiting', { n }) : t('Inbox')}
      tip={t('Inbox: everything waiting for you')}
      side="bottom"
      data-testid="inbox-bell"
      {...rest}
    >
      <I name="bell" size={17} />
      {n > 0 && (
        <span className="inbox-count" aria-hidden="true">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </IconButton>
  );
}

export function InboxBell() {
  const phone = usePhone();
  // Asked once someone is signed in (the bell is drawn before that, in the screen's loading state).
  const forYou = useVisibleForYou(!!useAuthStatus().data?.user).data;
  const n = forYou?.total ?? 0;
  // What was put aside for later comes back on its own: the list is asked again when the first of it is due.
  const wake = forYou?.wake;
  const qc = useQueryClient();
  useEffect(() => {
    if (!wake) return;
    const ms = Date.parse(wake) - Date.now() + 1000;
    const id = setTimeout(() => qc.invalidateQueries({ queryKey: keys.forYou }), Math.min(Math.max(ms, 1000), 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [wake, qc]);
  const { open } = useInbox();
  const [used, setUsed] = useState(open);
  if (open && !used) setUsed(true);
  const anchor = useAnchor();
  const id = useId();
  const L = useLoaded(inboxCode, used);
  // The bell is on every screen: its inbox's code comes once the first paint is done, so the first tap opens it in the
  // same frame, sliding in like every later time.
  useEffect(() => afterPaint(fetchInbox), []);
  return (
    <>
      <Bell
        n={n}
        ref={anchor.el as Ref<HTMLButtonElement>}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}c` : undefined}
        data-state={open ? 'open' : 'closed'}
        onPointerEnter={fetchInbox}
        onFocus={fetchInbox}
        onClick={(e) => !e.defaultPrevented && setInbox({ open: !open })}
      />
      {used && L && <L.InboxLayer anchor={anchor} id={id} phone={phone} />}
    </>
  );
}
