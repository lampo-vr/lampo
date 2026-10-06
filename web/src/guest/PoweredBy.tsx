// The foot of the client's pages (the room, the video page): a quiet "Powered by Lampo", centred, the way hosted
// messengers sign their widgets, and the source offer next to it (AGPL-3.0 §13): clients use the instance over the
// network like anyone signed in, so they are told where its source is (config source_url, GuestLink.source). Under them,
// the operator's imprint and privacy policy (A13 CLOUD-1): visitors type a name and are remembered by this browser, so
// they are told who runs the server and what it keeps. A paid workspace may hide the badge (A13 CLOUD-7: the link's
// answer says `badge: false`); the source offer and the legal pages stay, on one line. Every link sends no referrer: a
// review link's token is in its path.
import { Fragment, type ReactElement } from 'react';
import { BRAND_NAME, SITE_URL } from '../../../lib/brand.ts';
import type { GuestFoot } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { BrandMark } from '../ui/icons.tsx';

const dot = (
  <span className="g-foot-dot" aria-hidden="true">
    ·
  </span>
);

export function PoweredBy({ foot }: { foot?: GuestFoot | null }) {
  const offer = t('client::Source code of {brand} (free software, AGPL-3.0)', { brand: BRAND_NAME });
  const badge = foot?.badge !== false;
  const source = foot?.source && (
    <a key="source" className="g-source" href={foot.source} target="_blank" rel="noreferrer" data-testid="source-link" aria-label={offer} title={offer}>
      {t('client::Source')}
    </a>
  );
  // without the badge the source offer leads the line of links (it is never hidden: AGPL-3.0 §13)
  const links = [
    !badge && source,
    foot?.imprint_url && (
      <a key="imprint" href={foot.imprint_url} target="_blank" rel="noreferrer" data-testid="imprint-link">
        {t('client::Imprint')}
      </a>
    ),
    foot?.privacy_url && (
      <a key="privacy" href={foot.privacy_url} target="_blank" rel="noreferrer" data-testid="privacy-link">
        {t('client::Privacy')}
      </a>
    ),
  ].filter((l): l is ReactElement => !!l);
  return (
    <footer className="g-foot" data-testid="g-foot" data-badge={badge ? undefined : 'hidden'}>
      {badge && (
        <a className="g-powered" href={SITE_URL} target="_blank" rel="noreferrer" data-testid="powered-by">
          <BrandMark size={14} />
          <span>
            <T k="client::Powered by <0>{brand}</0>" values={{ brand: BRAND_NAME }} tags={[(c) => <b>{c}</b>]} />
          </span>
        </a>
      )}
      {badge && source && (
        <>
          {dot}
          {source}
        </>
      )}
      {links.length > 0 && (
        <span className="g-legal" data-testid="g-legal">
          {links.map((l, i) => (
            <Fragment key={l.key}>
              {i > 0 && dot}
              {l}
            </Fragment>
          ))}
        </span>
      )}
    </footer>
  );
}
