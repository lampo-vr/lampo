// The front of a review link, the visitor's first look at the product: who shared what, one sentence on what to do,
// and the way in (a password), or what to do when the link is over. It is the product's one entrance (ui/Entrance.tsx):
// the brand film on the left — Lampo's own footage, never the review's: nothing of a video behind a password shows
// here — and on the right the invitation, with "Powered by Lampo" and the source offer at the foot.
import type { ReactNode } from 'react';
import type { GuestFoot } from '../../../lib/types.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { Entrance, EntranceFrom, EntranceHead } from '../ui/Entrance.tsx';
import type { IconName } from '../ui/icons.tsx';
import { Wordmark } from '../ui/icons.tsx';
import { PoweredBy } from './PoweredBy.tsx';

interface ShellProps {
  /** Who shared the link, when the page knows. */
  sharer?: string | null;
  avatar?: string | null;
  org?: string | null;
  /** What follows the sharer's name: "shared a review with you". */
  from?: ReactNode;
  /** The screen's sign above the title, where there is no sharer and no form (a link that isn't available). */
  icon?: IconName;
  title: ReactNode;
  lede: ReactNode;
  /** The foot from the link's answer (the source offer, the operator's legal pages); else asked of the server. */
  foot?: GuestFoot | null;
  /** Set once the password was right: the invitation steps back while the review comes. */
  opening?: boolean;
  children?: ReactNode;
}

/** The page: who shared what, what to do, the way in. */
export function InviteShell({ sharer, avatar, org, from, icon, title, lede, foot, opening, children }: ShellProps) {
  // a link that ended answers with no foot of its own: the server's, as the sign-in has it (AGPL-3.0 §13, A13 CLOUD-1)
  const info = useInfo(foot === undefined);
  return (
    <Entrance
      className="invite"
      opening={opening}
      caption={t('client::Video feedback your AI agent can act on.')}
      logo={<Wordmark />}
      foot={<PoweredBy foot={foot ?? (info && { source: info.source_url, imprint_url: info.imprint_url, privacy_url: info.privacy_url })} />}
    >
      {sharer && (
        <EntranceFrom name={sharer} avatar={avatar} org={org}>
          {from}
        </EntranceFrom>
      )}
      <EntranceHead icon={icon} title={title}>
        {lede}
      </EntranceHead>
      {children}
    </Entrance>
  );
}
