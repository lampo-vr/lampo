// A video in the library's grid: the poster (hover scrubs through the render), what waits on it, where it stands.
// `compact` keeps the poster, the name and the stage for a denser wall of cards.
import { useQueryClient } from '@tanstack/react-query';
import { memo, useState } from 'react';
import { fmtDuration } from '../../../lib/time.ts';
import { cancelPrefetch, prefetchVideo } from '../api/prefetch.ts';
import { spriteUrl } from '../api/sprite.ts';
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { cardClick, onActivate } from '../lib/a11y.ts';
import { ago } from '../lib/format.ts';
import { go } from '../lib/nav.ts';
import { cardRun, RunEdge, RunLine } from '../sessions/RunLine.tsx';
import { SessionChip } from '../sessions/Sessions.tsx';
import { StatusPill } from '../status/StatusPill.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { ContextMenu, IconButton, Menu } from '../ui/primitives.tsx';
import { Skeleton, SkLine } from '../ui/Skeleton.tsx';
import { DRAG_VIDEO, dragChip } from './drag.ts';
import { PosterChips, ShareState } from './marks.tsx';
import { CARD_FRAME, Poster, posterUrl } from './Poster.tsx';
import { UnsentMark } from './unsent.tsx';
import { openVideo, useVideoMenu } from './useVideoMenu.tsx';

interface FilmProps {
  v: VideoSummary;
  home?: string | null;
  folders: string[];
  /** What the meta line says before the date: the sub-folder or the whole path, depending on the grouping. */
  where?: string | null;
  compact?: boolean;
  /** Among the first cards on screen: its poster comes first. */
  priority?: boolean;
}

export const Film = memo(function Film({ v, home, folders, where, compact, priority }: FilmProps) {
  useLang(); // memo'd: renders again on a language switch by itself
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const qc = useQueryClient();
  const { items, dialogs, assign, organize } = useVideoMenu(v, { home, folders });
  const run = cardRun(v);
  return (
    <ContextMenu items={items} onOpenChange={setMenuOpen}>
      {/* biome-ignore lint/a11y/useSemanticElements: the card holds its own buttons, which an <a> or <button> cannot contain */}
      <div
        className={`film ${compact ? 'compact' : ''} ${v.archived ? 'archived' : ''} ${menuOpen ? 'menu-open' : ''} ${dragging ? 'dragging' : ''}`}
        role="link"
        tabIndex={0}
        aria-label={t('Review {name}', { name: v.name })}
        data-slug={v.slug}
        data-nav
        onClick={cardClick((e) => openVideo(v.slug, e), '.film-foot, .film-menu')}
        onKeyDown={onActivate(() => go(v.slug))}
        onPointerEnter={() => prefetchVideo(qc, v.slug)}
        onPointerLeave={cancelPrefetch}
        onFocus={() => prefetchVideo(qc, v.slug, { now: true })}
        draggable={organize}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_VIDEO, v.slug);
          e.dataTransfer.effectAllowed = 'move';
          // the same small chip the list drags, not the whole card
          dragChip(e, v.name, e.currentTarget);
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
      >
        <div className="film-poster">
          <Poster
            src={v.hash ? posterUrl(v) : null}
            sprite={v.hash ? spriteUrl(v.slug, v.hash) : null}
            slug={v.slug}
            width={v.width}
            height={v.height}
            frame={CARD_FRAME}
            priority={priority}
          >
            <RunEdge run={run} />
          </Poster>
          <div className="film-over top">
            <span className="vchip">V{v.v}</span>
            {v.sample && <span className="vchip sample-chip">{t('Sample')}</span>}
            {v.missing && <span className="vchip must">{t('missing')}</span>}
            <UnsentMark slug={v.slug} chip />
            <span className="grow" />
            <PosterChips counts={v.counts} />
          </div>
          {!compact && (
            <div className="film-over bottom">
              {/* the agent's work on it; an older server's free-text status (no runs there) in the same keyframe language */}
              {run ? (
                <RunLine run={run} chip />
              ) : (
                v.run === undefined &&
                v.agent_status && (
                  <span className="vchip agent ellipsis" title={`${v.agent_status.by} · ${v.agent_status.text}`}>
                    <KeyGlyph shape="ease" className="nav-kg live" /> {v.agent_status.text}
                  </span>
                )
              )}
              <span className="grow" />
              <span className="vchip">{fmtDuration(v.duration)}</span>
            </div>
          )}
        </div>
        <div className="film-meta">
          <div className="film-row">
            <span className="film-title ellipsis" title={v.name}>
              {v.name}
            </span>
            <div className="film-menu">
              <Menu
                onOpenChange={setMenuOpen}
                trigger={<IconButton className="btn ghost sm icon-only" label={t('Actions for {name}', { name: v.name })} icon="more" />}
                items={items}
              />
            </div>
          </div>
          {!compact && (
            <div className="film-sub ellipsis">
              {where ? `${where} · ` : ''}
              {ago(v.mtime)}
            </div>
          )}
          <div className="film-foot">
            <StatusPill info={v.stage} size="sm" />
            {!compact && <ShareState stage={v.stage} />}
            {!compact && (v.session || assign) && (
              <SessionChip session={v.session} active={v.sessionActive} listening={v.sessionListening} onClick={assign ?? undefined} disabled={!assign} />
            )}
          </div>
        </div>
        {dialogs}
      </div>
    </ContextMenu>
  );
});

/** A card while the library loads: the same poster frame and the same three lines, their words on the way. */
export function FilmPending({ compact }: { compact?: boolean }) {
  return (
    <div className={`film pending ${compact ? 'compact' : ''}`} aria-hidden="true">
      <div className="sk film-sk-poster" style={{ aspectRatio: CARD_FRAME }} />
      <div className="film-meta">
        <div className="film-row">
          <span className="film-title">
            <SkLine w="70%" />
          </span>
        </div>
        {!compact && (
          <div className="film-sub">
            <SkLine w="46%" />
          </div>
        )}
        <div className="film-foot">
          <Skeleton w={compact ? 64 : 88} h={22} r={999} />
        </div>
      </div>
    </div>
  );
}
