// A folder link: who shared it and how far the review has come ("1 of 3 reviewed"), then every video as a card like
// the library's (hover scrubs through it) with where the visitor stands on it. Opening one plays it; the room stays
// one click away.
import { fmtDuration } from '../../../lib/time.ts';
import type { GuestLink, GuestVideo } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { onActivate } from '../lib/a11y.ts';
import { CARD_FRAME, Poster } from '../library/Poster.tsx';
import { Badge } from '../ui/Badge.tsx';
import { Avatar } from '../ui/controls.tsx';
import { I, Wordmark } from '../ui/icons.tsx';
import { EmptyState } from '../ui/system.tsx';
import { ThemeButton } from '../ui/ThemeSwitch.tsx';
import { DownloadAll } from './DownloadAll.tsx';
import { PoweredBy } from './PoweredBy.tsx';

const leaf = (folder: string | null) => (folder || '').split('/').pop() || t('client::Review');
/** The visitor's verdict on the version the link shows now, if any. */
const verdictOf = (v: GuestVideo) => (v.approval?.v === v.v ? v.approval.status : null);

const until = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
};

function Card({ v, onOpen }: { v: GuestVideo; onOpen: () => void }) {
  const verdict = verdictOf(v);
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card lays out a poster and text blocks, like the library's
    <div className="film" role="link" tabIndex={0} aria-label={t('client::Review {name}', { name: v.name })} onClick={onOpen} onKeyDown={onActivate(onOpen)}>
      <div className="film-poster">
        <Poster src={v.poster} sprite={v.sprite} slug={v.slug} width={v.width} height={v.height} frame={CARD_FRAME} />
        <div className="film-over top">
          <span className="vchip">V{v.v}</span>
          <span className="grow" />
          {v.open > 0 && (
            <span className="vchip" title={t('client::{n} open note|{n} open notes', { n: v.open })}>
              <I name="notes" size={11} /> {v.open}
            </span>
          )}
        </div>
        <div className="film-over bottom">
          <span className="grow" />
          <span className="vchip">{fmtDuration(v.duration)}</span>
        </div>
      </div>
      <div className="film-meta">
        <div className="film-row">
          <span className="film-title ellipsis" title={v.name}>
            {v.name}
          </span>
        </div>
        <div className="film-foot room-state">
          {verdict === 'approved' ? (
            <Badge tone="ok" size="sm">
              {t('client::You approved V{v}', { v: v.v })}
            </Badge>
          ) : verdict === 'changes' ? (
            <Badge tone="should" size="sm">
              {t('client::You asked for changes')}
            </Badge>
          ) : v.check > 0 ? (
            <Badge tone="ok" size="sm">
              {t('client::{n} fix to check|{n} fixes to check', { n: v.check })}
            </Badge>
          ) : (
            <span className="room-todo">{v.notes ? t('client::{n} note|{n} notes', { n: v.notes }) : t('client::Not reviewed yet')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Room({ link, onOpen, name }: { link: GuestLink; onOpen: (slug: string) => void; name: string }) {
  const total = link.videos.length;
  const done = link.videos.filter((v) => verdictOf(v)).length;
  const check = link.videos.reduce((n, v) => n + v.check, 0);
  const openUntil = until(link.expires);
  const title = link.label || leaf(link.folder);
  return (
    <div className="room">
      <div className="topbar room-top">
        {/* the room's name is the page's heading right below; the bar only says where the visitor is */}
        <span className="room-brand grow">
          <Wordmark />
        </span>
        {name && (
          <span className="g-who">
            <Avatar name={`guest:${name}`} size={22} kind="client" /> <span className="g-hide-sm">{name}</span>
          </span>
        )}
        <ThemeButton />
      </div>
      <main className="room-scroll">
        <header className="room-head">
          {link.reviewer && (
            <p className="inv-from">
              <Avatar name={link.reviewer} src={link.reviewer_avatar} size={32} kind="person" />
              <span>
                <b>{link.reviewer}</b>
                {link.org ? <span className="inv-org"> · {link.org}</span> : null}{' '}
                {t('client::shared {n} video with you|shared {n} videos with you', { n: total })}
              </span>
            </p>
          )}
          <h1>{title}</h1>
          <p className="room-lede">
            {link.perms.comment
              ? t('client::Open a video, pause where something should change and leave a note. When a video is right, approve it.')
              : t('client::Open a video to watch it. This link is for watching only.')}
          </p>
          {total > 0 && (
            <div className="room-progress">
              <div className="room-meter" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('client::Reviewed')}>
                <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
              </div>
              <span className="room-progress-text">
                <b>{t('client::{done} of {n} reviewed', { done, n: total })}</b>
                {check > 0 && <span> · {t('client::{n} fix to check|{n} fixes to check', { n: check })}</span>}
                {openUntil && <span> · {t('client::link open until {date}', { date: openUntil })}</span>}
              </span>
            </div>
          )}
          <DownloadAll link={link} name={name} />
        </header>
        {total ? (
          <div className="grid">
            {link.videos.map((v) => (
              <Card key={v.slug} v={v} onOpen={() => onOpen(v.slug)} />
            ))}
          </div>
        ) : (
          <EmptyState className="room-empty" testId="room-empty" titleAs="h2" art="folder" title={t('client::Nothing here yet')}>
            {link.reviewer
              ? t('client::{name} hasn’t added a video yet. They show up here as soon as they are.', { name: link.reviewer })
              : t('client::Videos show up here as soon as they are added.')}
          </EmptyState>
        )}
        <PoweredBy foot={link} />
      </main>
    </div>
  );
}
