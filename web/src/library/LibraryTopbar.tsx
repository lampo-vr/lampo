// The library's top bar, the same while the library loads and once it's there: the drawer button (phones), the mark,
// Search, the inbox, Add video and the account. Nothing in it waits for data to decide its size — Add video has one
// icon, the account chip is the avatar, the drawer button keeps its place — so the bar never shifts under the pointer.
// Buttons that can't act yet (the library is loading) say so to assistive tech and look as they will (no greying out
// and back, which reads as a flicker).
import type { ReactNode } from 'react';
import { can } from '../../../lib/permissions.ts';
import { useLikelyRole } from '../api/auth.ts';
import { UserMenu } from '../auth/UserMenu.tsx';
import { t } from '../i18n/index.ts';
import { InboxBell } from '../inbox/InboxBell.tsx';
import { PaletteButton } from '../palette/PaletteButton.tsx';
import { I, Wordmark } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';

interface Props {
  /** Opens the sidebar in a drawer (phones). 'wait': not yet (the library is loading); null: nothing to open. */
  onNav: (() => void) | 'wait' | null;
  /** Adds a video (links it at the machine, uploads elsewhere); missing while the library loads. */
  onAdd?: () => void;
  /** The hidden file input the Add-video button and the U key open. */
  children?: ReactNode;
  /** Read-only (billing): Add video is a neutral button with a lock that explains, never the orange that fails later. */
  locked?: boolean;
  /** Something else is the page's one thing to do (a question an agent waits on): Add video steps back to neutral. */
  quiet?: boolean;
}

export function LibraryTopbar({ onNav, onAdd, children, locked, quiet }: Props) {
  // Before the server has answered: the role this browser saw last time (lib/chromeHint.ts).
  const add = can(useLikelyRole(), 'upload');
  return (
    // Nothing to open in a drawer (an empty library has no sidebar): the account stays in the bar on phones too.
    <div className={`topbar grain ${onNav === null ? 'bare' : ''}`}>
      <IconButton
        className={`btn ghost icon-only nav-toggle ${onNav === null ? 'idle' : ''}`}
        label={t('Folders and views')}
        icon="menu"
        size={18}
        onClick={typeof onNav === 'function' ? onNav : undefined}
        aria-disabled={typeof onNav !== 'function' || undefined}
        aria-hidden={onNav === null || undefined}
        tabIndex={onNav === null ? -1 : undefined}
      />
      <a className="brand" href="#/">
        <Wordmark />
      </a>
      <span className="grow" />
      <PaletteButton />
      <InboxBell />
      {add && (
        <button
          type="button"
          className={`btn add-video ${locked ? 'locked' : quiet ? 'quiet' : 'primary'}`}
          onClick={onAdd}
          aria-disabled={!onAdd || undefined}
          aria-label={t('Add video')}
          aria-haspopup={locked ? 'dialog' : undefined}
        >
          <I name={locked ? 'lock' : 'plus'} size={16} />{' '}
          <span className="add-label">
            {t('Add video')} <kbd>A</kbd>
          </span>
        </button>
      )}
      {children}
      <UserMenu />
    </div>
  );
}
