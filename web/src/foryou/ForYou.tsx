// What waits for you as cards that work one-handed on a phone: answer an agent's question right here, jump into
// verify mode at a fix, wave through what you've seen ("Got it"), or put anything aside for later. The inbox view
// shows them on phones and tablets (wide screens get the list beside the preview), grouped like the list: by video —
// a head with the video's poster, name, project and what it holds — or by kind. While the list loads it is the same
// shapes: the first group's head and cards in their own boxes.
import { Fragment } from 'react';
import { enc } from '../api/client.ts';
import type { ForYouItem } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { doneOf, groupsOf } from '../inbox/group.ts';
import { GROUPS, type InboxActions, ItemCard, tallyParts } from '../inbox/items.tsx';
import { LaterLine } from '../inbox/Later.tsx';
import { useInboxMode } from '../inbox/mode.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu } from '../ui/primitives.tsx';
import { ForYouPending } from './ForYouPending.tsx';
import '../styles/foryou.css';

/** The groups with their cards; `items` null: on its way. */
export function ForYou({ items, later, actions }: { items: ForYouItem[] | null; later: ForYouItem[]; actions: InboxActions }) {
  const [mode] = useInboxMode();
  if (!items) return <ForYouPending />;
  return (
    <>
      {groupsOf(items, mode).map((g) => {
        const id = `fy-${g.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (mode === 'kind')
          return (
            <section key={g.key} className={`fy-group g-${g.kind}`} aria-labelledby={id}>
              <h2 id={id} className="fy-h">
                {GROUPS().find((x) => x.kind === g.kind)?.title} <span className="mono">{g.items.length}</span>
              </h2>
              {g.items.map((i) => (
                <ItemCard key={i.key} item={i} actions={actions} />
              ))}
            </section>
          );
        const v = Math.max(0, ...g.items.map((i) => i.v ?? 0));
        const poster = g.slug ? (g.items.find((i) => i.poster)?.poster ?? `/api/poster/${enc(g.slug)}.jpg${v ? `?v=${v}` : ''}`) : null;
        const doable = g.items.filter((i) => doneOf(i));
        return (
          <section key={g.key} className="fy-group g-video" aria-labelledby={id} data-testid="fy-video">
            <div className="fy-vhead">
              <span className="fy-vthumb">{poster ? <img src={poster} alt="" loading="lazy" /> : <I name={g.slug ? 'film' : 'playbook'} size={18} />}</span>
              <div className="fy-vhead-body">
                <h2 id={id} className="fy-vhead-name ellipsis">
                  {g.name}
                </h2>
                <span className="fy-vhead-sum">
                  {g.folder?.split('/').join(' / ')}
                  {tallyParts(g.items).map((p, n) => (
                    <Fragment key={p}>
                      {(g.folder || n > 0) && ' · '}
                      <span>{p}</span>
                    </Fragment>
                  ))}
                </span>
              </div>
              {/* no age here: each card under it says its own (the newest one said it twice) */}
              <Menu
                trigger={<IconButton className="btn ghost sm icon-only" label={t('Actions for {video}', { video: g.name ?? '' })} icon="more" size={15} />}
                items={[
                  doable.length > 0 && { label: t('Done for this video'), icon: 'check', onClick: () => actions.doneMany(doable) },
                  { label: t('Later for this video'), icon: 'clock', onClick: () => actions.later(g.items) },
                ]}
              />
            </div>
            {g.items.map((i) => (
              <ItemCard key={i.key} item={i} actions={actions} inVideo />
            ))}
          </section>
        );
      })}
      <LaterLine later={later} actions={actions} />
    </>
  );
}
