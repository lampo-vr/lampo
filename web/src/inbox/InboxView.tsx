// The inbox as a view of the library ("Inbox" in the sidebar, #/inbox): everything waiting for you, with the library
// around it, by video (the default) or by kind — the switch sits in the header, remembered per device. Wide screens
// read it like a mail client — the list on the left, the picked item's frame-exact preview with its actions on the
// right, the first item open from the start, ↑/↓ (j/k) moving both, every row clearing in place (Rows.tsx). Phones and
// tablets get the cards with their actions right on them; tapping one opens it. The loading state is this same layout
// with placeholders in it, and this device's notifications come after the list, once the list is there.
import { useMemo, useState } from 'react';
import type { ForYouItem } from '../api/types.ts';
import { ForYou } from '../foryou/ForYou.tsx';
import { NotifyCard } from '../foryou/NotifyCard.tsx';
import { t } from '../i18n/index.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { useMedia } from '../lib/media.ts';
import { EmptyState, Panel } from '../ui/system.tsx';
import { orderedBy } from './group.ts';
import { useVisibleForYou } from './hidden.ts';
import { InboxZero } from './InboxZero.tsx';
import { type InboxActions, useInboxActions } from './items.tsx';
import { LazyPreview as Preview } from './LazyPreview.tsx';
import { useInboxList } from './list.ts';
import { useInboxMode } from './mode.ts';
import { INBOX_WIDE, InboxRowsPending, useInboxNav } from './nav.tsx';
import { PreviewPending } from './PreviewPending.tsx';
import { useSeenWhenRead } from './seen.ts';
import '../styles/inbox.css';

// The rows (their actions, the selection, the keys) are a chunk of their own, shared with the bell's popover, which
// fetches it after every first paint; opening on the inbox asks for it at once.
const rowsCode = loader(() => import('./Rows.tsx'));
if (/^#\/(inbox|for-you|verify)\b/.test(location.hash)) void rowsCode.load().catch(() => {});

/** `pending`: drawn before the server has said who you are (App's loading state): the loading layout, nothing asked. */
export default function InboxView({ pending = false }: { pending?: boolean }) {
  const wide = useMedia(INBOX_WIDE);
  const { data, error } = useVisibleForYou(!pending);
  const actions = useInboxActions();
  const [mode] = useInboxMode();
  const items = useMemo(() => (data ? orderedBy(data.items, mode) : null), [data, mode]);

  if (error)
    return (
      <div className="inbox-view" data-testid="inbox-view">
        <EmptyState art="error" titleAs="h2" title={t('This didn’t load')}>
          {error.message}
        </EmptyState>
      </div>
    );
  if (data && items && !items.length)
    return (
      <div className="inbox-view caught-up" data-testid="inbox-view">
        <InboxZero
          later={data.later}
          wake={data.wake}
          actions={actions}
          action={
            <a className="btn primary" href="#/">
              {t('Open the library')}
            </a>
          }
          body={t('New videos, questions from agents, fixes to check and feedback from review links land here — and on your phone, with notifications on.')}
        />
        <NotifyCard />
      </div>
    );
  if (wide) return <Split items={items} later={data?.later ?? NONE} actions={actions} />;
  return (
    <div className="inbox-view cards" data-testid="inbox-view">
      <ForYou items={items} later={data?.later ?? NONE} actions={actions} />
      {items && <NotifyCard />}
    </div>
  );
}

const NONE: ForYouItem[] = [];

/** List + preview. Something is always open: the item picked, else the one the keys are on, else the first. */
function Split({ items, later, actions }: { items: ForYouItem[] | null; later: ForYouItem[]; actions: InboxActions }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [mode] = useInboxMode();
  // the list scrolls in its own column (library.css keeps the page still): a soft edge where it goes on
  const [listRef, edges] = useScrollEdges<HTMLDivElement>('y');
  const list = useInboxList(items ?? NONE, mode);
  const { rows } = list;
  const nav = useInboxNav(rows, picked, setPicked, { follow: true });
  // An item that left the list (done here, answered on the phone) hands over to the one now in its place.
  const shown = (picked && rows.find((i) => i.key === picked)) || rows[nav.active] || rows[0] || null;
  // an update read in the preview leaves when the preview moves on or the view closes (seen.ts) — only one opened by a
  // click or the keys: the first item the view shows by itself on arrival hasn't been looked at yet
  useSeenWhenRead(picked ? shown : null, actions.seen);
  const R = useLoaded(rowsCode);
  return (
    <div className="inbox-view split" data-testid="inbox-view">
      <div className={`inbox-view-list ${edges}`} ref={listRef}>
        {items && R ? (
          <R.InboxRows list={list} later={later} nav={nav} shown={shown} actions={actions}>
            <NotifyCard />
          </R.InboxRows>
        ) : (
          <InboxRowsPending />
        )}
      </div>
      <Panel as="div" pad="none" className="inbox-view-preview" data-testid="inbox-view-preview">
        {shown ? <Preview key={shown.key} item={shown} actions={actions} onDone={(key) => nav.done(key, true)} /> : <PreviewPending />}
      </Panel>
    </div>
  );
}
