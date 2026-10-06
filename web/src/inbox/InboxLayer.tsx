// The inbox the bell opens (InboxBell.tsx): a popover on desktop and tablet (growing into list + preview side by side
// on wide screens), a sheet on phones. Its own chunk: the bell is on every first paint, the inbox only once opened.
import { Dialog, Popover } from 'radix-ui';
import { t } from '../i18n/index.ts';
import { useMedia } from '../lib/media.ts';
// The bell the top bar rendered is Radix's trigger (placement, focus return, clicks on it).
import { Anchor as Bell } from '../ui/layers.tsx';
import type { AnchorLink } from '../ui/primitives.tsx';
import { InboxPanel } from './InboxPanel.tsx';
import { INBOX_WIDE } from './nav.tsx';
import { setInbox, useInbox } from './state.ts';

const onOpenChange = (open: boolean) => setInbox({ open });
const onPick = (picked: string | null) => setInbox({ picked });
const close = () => setInbox({ open: false });

export function InboxLayer({ anchor, id, phone }: { anchor: AnchorLink; id: string; phone: boolean }) {
  const wide = useMedia(INBOX_WIDE);
  const { open, picked } = useInbox();
  // "Open in player" and "Open full inbox" navigate: the inbox steps aside (also when the link is the page it's on).
  // Closing waits for the click to finish: closed at once, the sheet unmounts the link before the browser follows it,
  // and a link that has left the page goes nowhere (the phone sheet then just closed on the library).
  const onLink = (e: React.MouseEvent) => {
    // Clicks inside must not reach cards and rows under the portal (they open the player).
    e.stopPropagation();
    if ((e.target as Element).closest('a[href]')) setTimeout(close);
  };

  if (phone)
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Trigger asChild>
          <Bell link={anchor} />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="backdrop inbox-backdrop" />
          <Dialog.Content id={`${id}c`} className="inbox-sheet" aria-describedby={undefined} data-testid="inbox" onClick={onLink}>
            {/* the sheet's name for screen readers; the list and the preview carry their own visible headers */}
            <Dialog.Title asChild>
              <span className="inbox-sr">{t('Inbox')}</span>
            </Dialog.Title>
            {open && <InboxPanel layout="stack" picked={picked} onPick={onPick} onClose={close} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal>
      <Popover.Trigger asChild>
        <Bell link={anchor} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          id={`${id}c`}
          className={`inbox-pop ${picked ? (wide ? 'two' : 'one') : ''}`}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={t('Inbox')}
          data-testid="inbox"
          onClick={onLink}
        >
          {open && <InboxPanel layout={wide ? 'split' : 'stack'} picked={picked} onPick={onPick} onClose={close} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
