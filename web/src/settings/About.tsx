// What this is and where it lives: version, where it runs, the store's folders (for the owner at the machine), the
// operator's legal pages (A13 CLOUD-1: imprint, privacy policy, terms, withdrawal), the licence and the source offer
// (AGPL-3.0 §13), the notices of what it is built with.

import { BRAND_NAME } from '../../../lib/brand.ts';
import { useInfo } from '../api/queries.ts';
import { consent } from '../billing/stripe.ts';
import { t } from '../i18n/index.ts';
import { Card, Facts } from './parts.tsx';

export function About() {
  const info = useInfo();
  const machine = info?.mode === 'local';
  const legal = [
    info?.imprint_url && (
      <a key="imprint" href={info.imprint_url} target="_blank" rel="noreferrer" data-testid="imprint-link">
        {t('Imprint')}
      </a>
    ),
    info?.privacy_url && (
      <a key="privacy" href={info.privacy_url} target="_blank" rel="noreferrer" data-testid="privacy-link">
        {t('Privacy policy')}
      </a>
    ),
    info?.terms_url && (
      <a key="terms" href={info.terms_url} target="_blank" rel="noreferrer" data-testid="terms-link">
        {t('Terms')}
      </a>
    ),
    info?.withdrawal_url && (
      <a key="withdrawal" href={info.withdrawal_url} target="_blank" rel="noreferrer" data-testid="withdrawal-link">
        {t('Right of withdrawal')}
      </a>
    ),
    // § 312k BGB, where a billing provider runs: the operator's own page, else Billing's own cancellation step
    (info?.cancel_url || info?.billing) && (
      <a
        key="cancel"
        href={info.cancel_url || '#/settings/billing/cancel'}
        {...(info.cancel_url ? { target: '_blank', rel: 'noreferrer' } : {})}
        data-testid="cancel-link"
      >
        {t('Cancel contracts here')}
      </a>
    ),
    // where the payment form's third parties may load (a billing provider runs): the choice, to change (A13 CLOUD-1)
    info?.billing && (
      <button key="cookies" type="button" className="set-link-btn" onClick={() => consent().then((c) => c.showSettings())} data-testid="cookie-settings">
        {t('Cookie settings')}
      </button>
    ),
  ].filter(Boolean);
  return (
    <>
      <header className="set-head">
        <h1>{t('About')}</h1>
        <p>{t('{name}: frame-exact video review for people and their agents.', { name: BRAND_NAME })}</p>
      </header>
      <Card title={t('This app')}>
        <Facts
          testid="about-facts"
          rows={[
            { label: t('Version'), value: info?.version || '…', mono: true },
            // the name on disk and on the command line stays the old one (lib/brand.ts)
            { label: t('Package and command'), value: 'video-review · vr', mono: true },
            { label: t('Runs'), value: machine ? t('On your own machine, with its extras') : t('On a hosted server') },
            !!info?.dataDir && { label: t('Notes and videos'), value: info.dataDir, mono: true },
            !!info?.root && { label: t('App'), value: info.root, mono: true },
          ]}
        />
      </Card>
      {legal.length > 0 && (
        <Card title={t('Legal')} lede={t('Who runs this server, and the terms it runs on.')} testid="about-legal">
          <div className="set-links">{legal}</div>
        </Card>
      )}
      <Card title={t('Licence')} lede={t('AGPL-3.0: use it, change it, share it. Whoever runs a changed version for others offers them its source.')}>
        <div className="set-links">
          {info?.source_url ? (
            <a href={info.source_url} target="_blank" rel="noreferrer" data-testid="source-link">
              {t('Source code')}
            </a>
          ) : (
            <span className="set-sub">{t('No source link configured (VR_SOURCE_URL).')}</span>
          )}
          <a href="/third-party-licenses.txt" target="_blank" rel="noreferrer" data-testid="notices-link">
            {t('Third-party notices')}
          </a>
        </div>
      </Card>
    </>
  );
}
