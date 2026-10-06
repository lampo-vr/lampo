// The inbox view while its code loads (InboxView.tsx is a chunk of its own): exactly the view's own loading layout —
// list + preview on wide screens, the cards narrower — so nothing moves when it arrives.
import { ForYouPending } from '../foryou/ForYouPending.tsx';
import { useMedia } from '../lib/media.ts';
import { Panel } from '../ui/system.tsx';
import { INBOX_WIDE, InboxRowsPending } from './nav.tsx';
import { PreviewPending } from './PreviewPending.tsx';
import '../styles/inbox.css';

export function InboxViewPending() {
  const wide = useMedia(INBOX_WIDE);
  if (wide)
    return (
      <div className="inbox-view split" data-testid="inbox-view">
        <div className="inbox-view-list">
          <InboxRowsPending />
        </div>
        <Panel as="div" pad="none" className="inbox-view-preview" data-testid="inbox-view-preview">
          <PreviewPending />
        </Panel>
      </div>
    );
  return (
    <div className="inbox-view cards" data-testid="inbox-view">
      <ForYouPending />
    </div>
  );
}
