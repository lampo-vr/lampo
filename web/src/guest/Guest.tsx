// What a visitor sees behind /g/<token>: the link's gate (password, expired, gone), the review room of a folder link,
// or one video. No account, no library, no Claude, no internal notes. Which video is open lives in the hash
// (/g/<token>#<slug>), so the browser's back button returns to the room.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, enc } from '../api/client.ts';
import { keys, useGuestLink, useGuestReview } from '../api/queries.ts';
import type { GuestLink, GuestReview } from '../api/types.ts';
import { SkeletonRegion } from '../ui/Skeleton.tsx';
import { Gate, PasswordGate } from './Gate.tsx';
import { type CompareState, useCompareKept } from './GuestCompare.tsx';
import { GuestPlayer } from './GuestPlayer.tsx';
import { useGuestName } from './guest.ts';
import { Room } from './Room.tsx';
import { visitorId } from './watch.ts';
import '../styles/guest.css';
import { t } from '../i18n/index.ts';
import { notNow } from '../lib/busy.ts';
import { decoded } from '../lib/nav.ts';

const slugFromHash = () => {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? decoded(h) : null;
};

function useHashSlug(): [string | null, (s: string | null) => void] {
  const [slug, setSlug] = useState(slugFromHash);
  useEffect(() => {
    const f = () => setSlug(slugFromHash());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const go = (s: string | null) => {
    if (s) location.hash = encodeURIComponent(s);
    else history.pushState(null, '', location.pathname);
    setSlug(s);
  };
  return [slug, go];
}

// While the link or its video loads: an announced wait and nothing drawn. What comes (a room of videos or one video,
// with the actions this link allows) decides its own shape, and a stand-in would only be a guess that then jumps.
const Loading = () => (
  <div className="page">
    <SkeletonRegion label={t('Opening the review')}>{null}</SkeletonRegion>
  </div>
);

export default function Guest({ token }: { token: string }) {
  const link = useGuestLink(token);
  const [slug, setSlug] = useHashSlug();
  const [name, setName] = useGuestName();
  // One visit per page load once the link is open; the server counts a visitor once per half hour anyway.
  const visited = useRef(false);
  const open = !!link.data && !link.data.locked;
  useEffect(() => {
    if (!open || visited.current) return;
    visited.current = true;
    // The visitor id tells this browser apart for the owner, and the name says who came.
    const visitor = visitorId();
    const named = name ? { name } : {};
    api(`/api/g/${token}/visit`, { method: 'POST', body: { ...named, ...(visitor ? { visitor } : {}) } }).catch(() => {});
  }, [open, token, name]);

  if (link.error) {
    const err = link.error instanceof ApiError ? link.error : null;
    if (err?.status === 410) {
      const by = typeof err.details.by === 'string' ? err.details.by : null;
      const expired = typeof err.details.expired === 'string' ? err.details.expired : null;
      return <Gate kind="expired" sharer={{ name: by }} expired={expired} />;
    }
    // the server can't check the link this moment: come back, never "it is gone" (it asks again by itself)
    if (notNow(link.error)) return <Gate kind="later" />;
    return <Gate kind="invalid" />;
  }
  if (!link.data) return <Loading />;
  const d = link.data;
  const sharer = { name: d.reviewer, avatar: d.reviewer_avatar, org: d.org };
  if (d.locked) return <PasswordGate token={token} label={d.label} sharer={sharer} foot={d} />;
  if (d.kind === 'folder' && !slug) return <Room link={d} onOpen={setSlug} name={name} />;
  const target = d.kind === 'video' ? d.videos[0]?.slug : slug;
  if (!target) return <Gate kind="empty" label={d.label} sharer={sharer} foot={d} />;
  return (
    <Video
      key={target}
      token={token}
      slug={target}
      name={name}
      setName={setName}
      onBack={d.kind === 'folder' ? () => setSlug(null) : undefined}
      onOpen={d.kind === 'folder' ? setSlug : undefined}
      link={d}
    />
  );
}

function Video({
  token,
  slug,
  name,
  setName,
  onBack,
  onOpen,
  link,
}: {
  token: string;
  slug: string;
  name: string;
  setName: (n: string) => void;
  onBack?: () => void;
  /** Opens another video of the room (folder links: "Next video"). */
  onOpen?: (slug: string) => void;
  link: GuestLink;
}) {
  const roomLabel = link.label;
  const [v, setV] = useState<number | null>(null);
  const q = useGuestReview(token, slug, v);
  const qc = useQueryClient();
  // A compare outlives the player it is in: swapping its sides, or picking another A, opens another version (a player of
  // its own), which starts on the same frame with the compare as it was.
  const [compare, setCompare] = useCompareKept(`${token}/${slug}`);
  const startAt = useRef<number | null>(null);
  const switchTo = async (next: number | null, keep?: { frame: number; compare: CompareState | null }) => {
    // the other version's page first, so the page changes in one step and never through an empty one
    if (keep)
      await qc
        .fetchQuery({
          queryKey: keys.guestReview(token, slug, next),
          queryFn: () => api<GuestReview>(`/api/g/${token}/review/${enc(slug)}${next ? `?v=${next}` : ''}`),
        })
        .catch(() => {});
    startAt.current = keep ? keep.frame : null;
    if (keep) setCompare(keep.compare);
    setV(next);
  };
  const status = q.error instanceof ApiError ? q.error.status : 0;
  // A version the link no longer shows (or a video that left the folder): back to what is there.
  useEffect(() => {
    if (status === 403 && v !== null) setV(null);
  }, [status, v]);
  if (q.error && status !== 403)
    return (
      <div className="page">
        <div className="empty">
          <h2>{notNow(q.error) ? t('client::This video can’t open right now.') : t('client::This video is not available.')}</h2>
          <div className="muted">{notNow(q.error) ? t('client::This page tries again by itself in a moment.') : q.error.message}</div>
          {onBack && (
            <button type="button" className="btn" onClick={onBack} style={{ marginTop: 16 }}>
              {t('client::Back to {roomLabel}', { roomLabel })}
            </button>
          )}
        </div>
      </div>
    );
  if (!q.data) return <Loading />;
  return (
    <GuestPlayer
      key={q.data.v}
      d={q.data}
      token={token}
      name={name}
      setName={setName}
      onVersion={switchTo}
      compare={compare}
      onCompare={setCompare}
      startFrame={startAt.current}
      onBack={onBack}
      roomLabel={roomLabel}
      room={link.kind === 'folder' ? { videos: link.videos, onOpen } : undefined}
      foot={link}
    />
  );
}
