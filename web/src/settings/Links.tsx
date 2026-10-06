// Every review link of the workspace, newest first, one line each as in the share dialog (share/LinkCard.tsx): what it
// opens, what visitors may do, what came of it; Copy, and a menu to change it (in its share dialog) or revoke it. Also a
// link whose video or folder was deleted outside the app: it opens nothing, and this is the one place it shows, so it
// can still be revoked. Where a billing provider runs, the workspace's owners and admins find the Lampo badge here: on
// every plan by default, a paid plan may hide it (A13 CLOUD-7).
import { useState } from 'react';
import { can } from '../../../lib/permissions.ts';
import { useLikelyRole } from '../api/auth.ts';
import { useBadge, useSetBadge } from '../api/badge.ts';
import { useRevokeLink } from '../api/mutations.ts';
import { useAllShares, useInfo } from '../api/queries.ts';
import type { ShareInfo } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useTouch } from '../lib/media.ts';
import { toast, toastError } from '../lib/toast.ts';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { LinkCard, type Reach } from '../share/LinkCard.tsx';
import { Switch } from '../ui/plain.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Card, Confirm } from './parts.tsx';

export function Links() {
  const { data } = useAllShares();
  const info = useInfo();
  const revoke = useRevokeLink();
  const [revoking, setRevoking] = useState<ShareInfo | null>(null);
  const [changing, setChanging] = useState<ShareInfo | null>(null);
  const canShare = useTouch() && typeof navigator.share === 'function';
  const role = useLikelyRole();
  // Where the links open, as the share dialog says: the server's public address, else the tunnel, the network, here.
  const hosted = info?.mode === 'server';
  const base = hosted ? (info.public_url || location.origin).replace(/\/+$/, '') : data?.tunnel || data?.lan?.[0] || location.origin;
  const reach: Reach = hosted || data?.tunnel ? 'public' : data?.lan?.length ? 'lan' : 'local';
  const confirm = async () => {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking.token);
      toast(t('Link revoked: it stops working right away'), 'ok');
    } catch (e) {
      toastError(e);
    }
    setRevoking(null);
  };
  return (
    <>
      <header className="set-head">
        <h1>{t('Review links')}</h1>
        <p>{t('Every review link that still opens, newest first. Make one from a video’s or a folder’s Share.')}</p>
      </header>

      <Card title={t('Active links')}>
        {!data ? (
          <SkeletonRegion label={t('Loading the links')}>
            <RowsSkeleton n={3} thumb={false} />
          </SkeletonRegion>
        ) : !data.shares.length ? (
          <EmptyState size="sm" art="client" title={t('No links yet')}>
            {t('Share a video or a folder: its links show here, and any of them can be revoked.')}
          </EmptyState>
        ) : (
          <div className="link-list" data-testid="links-list">
            {data.shares.map((s) => (
              <div key={s.token} data-testid="link-row" data-gone={s.gone ? '' : undefined} className="link-row-w">
                <LinkCard
                  s={s}
                  url={`${base}/g/${s.token}`}
                  reach={reach}
                  here="all"
                  canShare={canShare && !s.gone}
                  editing={false}
                  onEdit={() => setChanging(s)}
                  onRevoke={() => setRevoking(s)}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      {info?.billing && !!role && can(role, 'admin') && <Badge />}

      {changing && (
        <LazyShareModal
          slug={changing.kind === 'video' ? (changing.slug ?? undefined) : undefined}
          name={changing.name ?? undefined}
          folder={changing.kind === 'folder' ? (changing.folder ?? undefined) : undefined}
          edit={changing.token}
          onClose={() => setChanging(null)}
        />
      )}
      {revoking && (
        <Confirm
          title={t('Revoke “{label}”?', { label: revoking.label })}
          action={t('Revoke link')}
          danger
          busy={revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={confirm}
        >
          {t('It stops working at once, also where it is open; the notes that came in through it stay.')}
        </Confirm>
      )}
    </>
  );
}

/**
 * "Powered by Lampo" at the foot of the workspace's review links: on by default on every plan; a paid plan's owners and
 * admins may hide it. The source offer and the operator's legal pages stay either way.
 */
function Badge() {
  const { data } = useBadge();
  const set = useSetBadge();
  const may = !!data?.may;
  const change = (hidden: boolean) =>
    set
      .mutateAsync(hidden)
      .then(() => toast(hidden ? t('The Lampo badge is hidden on this workspace’s review links.') : t('The Lampo badge shows again.'), 'ok'), toastError);
  return (
    <Card title={t('Lampo badge')} lede={t('Review links show a small “Powered by Lampo” at their foot, on every plan.')} testid="set-badge">
      <div className="set-switch">
        <label htmlFor="badge-hidden">
          <b>{t('Hide the Lampo badge')}</b>
          <span className="set-sub">
            {may || !data ? (
              t('Visitors see your name and your workspace’s only. The source and the legal links stay.')
            ) : (
              <>
                {t('With a paid plan.')}{' '}
                <a className="btn-link" href="#/settings/billing" data-testid="badge-plans">
                  {t('See plans')}
                </a>
              </>
            )}
          </span>
        </label>
        <Switch id="badge-hidden" checked={!!data?.hidden && may} disabled={!may || set.isPending} onCheckedChange={change} />
      </div>
    </Card>
  );
}
