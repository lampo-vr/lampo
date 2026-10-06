// The inbox inside the bell's popover (desktop, tablet) or sheet (phone): the list of what waits for you, grouped like
// the inbox view (by video or by kind, Rows.tsx; long videos folded to their head), and the preview of the picked item
// — beside the list on wide screens, instead of it on narrow ones. The list and its keys are shared with the inbox view
// (InboxView.tsx), which shows them beside the preview for good.
// Keys: ↑/↓ or j/k move, Enter opens the preview (on the item already open: the full player), E/H/X clear (Rows.tsx),
// Esc closes (Radix).
import { useEffect, useMemo } from 'react';
import { t } from '../i18n/index.ts';
import { ScrollArea } from '../ui/plain.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { orderedBy } from './group.ts';
import { useVisibleForYou } from './hidden.ts';
import { InboxZero } from './InboxZero.tsx';
import { useInboxActions } from './items.tsx';
import { LazyPreview as Preview, previewCode } from './LazyPreview.tsx';
import { useInboxList } from './list.ts';
import { useInboxMode } from './mode.ts';
import { useInboxNav } from './nav.tsx';
import { InboxRows } from './Rows.tsx';
import { useSeenWhenRead } from './seen.ts';

export type InboxLayout = 'split' | 'stack';

interface InboxPanelProps {
  layout: InboxLayout;
  /** The item in the preview. The bell keeps it, so a layout switch (a tablet turned, a window resized) keeps it too. */
  picked: string | null;
  onPick: (key: string | null) => void;
  onClose: () => void;
}

export function InboxPanel({ layout, picked, onPick: setPicked, onClose }: InboxPanelProps) {
  const { data, error } = useVisibleForYou();
  const actions = useInboxActions();
  const [mode] = useInboxMode();
  const items = useMemo(() => orderedBy(data?.items ?? [], mode), [data, mode]);
  const list = useInboxList(items, mode, { compact: true, keep: picked });
  const nav = useInboxNav(list.rows, picked, setPicked);
  const shown = (picked && items.find((i) => i.key === picked)) || null;
  // an update read in the preview leaves when the preview moves on or closes (seen.ts)
  useSeenWhenRead(shown, actions.seen);
  // the preview's code comes with the popover, before an item is picked (LazyPreview.tsx)
  useEffect(() => void previewCode.load().catch(() => {}), []);

  // What stays picked after it left the list (answered elsewhere, dismissed on another device): nothing.
  useEffect(() => {
    if (picked && data && !shown) setPicked(null);
  }, [picked, data, shown, setPicked]);
  // Back from a preview on a narrow screen: the list gets focus again, on the item that was open.
  const { list: listEl } = nav;
  useEffect(() => {
    if (!shown) listEl.current?.focus();
  }, [shown, listEl]);

  const onDone = (key: string) => nav.done(key, layout === 'split');
  const total = data?.total ?? 0;
  const listPane = (
    <div className="inbox-list-pane">
      <header className="inbox-head">
        <div className="grow">
          <b>{t('Inbox')}</b>
          <span>{data ? (total ? t('{total} waiting', { total }) : t('all caught up')) : ' '}</span>
        </div>
        <a className="btn ghost sm" href="#/inbox" data-testid="inbox-full">
          {t('Open full inbox')}
        </a>
        <IconButton className="btn ghost sm icon-only" label={t('Close the inbox')} shortcut="Esc" icon="x" onClick={onClose} />
      </header>
      {error ? (
        <EmptyState art="error" size="sm" className="inbox-empty" title={t('This didn’t load')}>
          {error.message}
        </EmptyState>
      ) : !data ? (
        <SkeletonRegion label={t('Loading the inbox')} className="inbox-loading">
          <RowsSkeleton n={4} thumb={48} action={false} />
        </SkeletonRegion>
      ) : !items.length ? (
        <InboxZero later={data.later} wake={data.wake} actions={actions} size="sm" />
      ) : (
        <ScrollArea className="inbox-sa">
          <InboxRows list={list} later={data.later} nav={nav} shown={shown} actions={actions} />
        </ScrollArea>
      )}
    </div>
  );

  if (layout === 'split')
    return (
      <div className={`inbox-panel split ${shown ? 'with-preview' : ''}`}>
        {listPane}
        {shown && <Preview key={shown.key} item={shown} actions={actions} onDone={onDone} onBack={() => setPicked(null)} backLabel={t('Close the preview')} />}
      </div>
    );
  return (
    <div className="inbox-panel stack">
      {shown ? (
        <Preview key={shown.key} item={shown} actions={actions} onDone={onDone} onBack={() => setPicked(null)} backLabel={t('Back to the inbox')} />
      ) : (
        listPane
      )}
    </div>
  );
}
