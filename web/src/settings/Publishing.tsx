// Settings → Publishing: where this workspace posts final versions. YouTube directly, through your own Google Cloud
// OAuth client (its client id and secret, then a Google sign-in); Instagram and Facebook through Zernio with your own
// API key. Keys and secrets go in and never come back: the server keeps them sealed and shows the last four characters.
// Owners and admins only (`publish`); members draft posts and see the connections in the composer.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import type { PublishConnectionInfo, PublishPlatform } from '../../../lib/types.ts';
import { useSSE } from '../api/events.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { toast, toastError } from '../lib/toast.ts';
import { type NewConnection, useConnectionActions, useConnections } from '../publish/api.ts';
import { PLATFORM_LABEL } from '../publish/words.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Switch } from '../ui/plain.tsx';
import { PlatformMark } from '../ui/platformMarks.tsx';
import { useConfirm } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Card, Code, serverUrl, when } from './parts.tsx';
import '../styles/publish.css';

/** What Google sent the person back with (?connected= / ?publish_error= on #/settings/publishing), in a sentence. */
function returnWords(q: URLSearchParams, list: PublishConnectionInfo[] | undefined): { ok: boolean; text: string } | null {
  const connected = q.get('connected');
  if (connected) {
    const c = list?.find((x) => x.id === connected);
    return {
      ok: true,
      text: c ? t('Connected: {label}. Posts can go out through it now.', { label: c.label }) : t('Connected. Posts can go out through it now.'),
    };
  }
  const why = q.get('publish_error');
  if (!why) return null;
  const text =
    why === 'denied'
      ? t('Google wasn’t allowed to connect: nothing changed. Connect again and allow the upload permission.')
      : why === 'expired'
        ? t('That sign-in ran out or was started elsewhere: connect again from here.')
        : why === 'gone'
          ? t('That connection is gone: add it again.')
          : why === 'check'
            ? t('Google signed in, but the YouTube channel couldn’t be read: see the connection below.')
            : t('The Google sign-in didn’t finish: see the connection below and try again.');
  return { ok: false, text };
}

const queryOf = () => new URLSearchParams(/\?(.*)$/.exec(location.hash)?.[1] ?? '');

export function Publishing() {
  const info = useInfo();
  const { data } = useConnections();
  // a connection changed (added, signed in, checked, removed — in another tab too): the list follows
  const qc = useQueryClient();
  useSSE('connections', () => {
    qc.invalidateQueries({ queryKey: ['connections'] });
    qc.invalidateQueries({ queryKey: ['posts'] });
  });
  const [back, setBack] = useState(() => queryOf());
  const said = returnWords(back, data?.connections);
  const [adding, setAdding] = useState<'youtube' | 'zernio' | null>(null);
  // the address keeps nothing of the return once it is read
  useEffect(() => {
    if (back.toString()) history.replaceState(history.state, '', '#/settings/publishing');
  }, [back]);
  const redirect = `${serverUrl(info?.public_url)}/api/publish/oauth/callback`;
  const hosted = data?.hosted;
  return (
    <>
      <header className="set-head">
        <h1>{t('Publishing')}</h1>
        <p>{t('Post final versions to YouTube, Instagram and Facebook from Lampo. Agents may draft posts; only people publish them.')}</p>
      </header>
      {said && (
        <div className={`pubset-banner ${said.ok ? '' : 'bad'}`} role="status" data-testid="pubset-return">
          <I name={said.ok ? 'check' : 'info'} size={15} />
          <span>{said.text}</span>
          <button type="button" className="btn sm ghost" onClick={() => setBack(new URLSearchParams())}>
            {t('OK')}
          </button>
        </div>
      )}
      <Card title={t('Connections')} lede={t('Where this workspace’s posts go. Each one uses your own app or key: nothing goes through Lampo’s.')}>
        {!data ? (
          <SkeletonRegion label={t('Loading the connections')}>
            <RowsSkeleton n={2} thumb={false} />
          </SkeletonRegion>
        ) : !data.connections.length ? (
          <EmptyState size="sm" art="agents" title={t('Nothing connected yet')}>
            {t('Add YouTube or Instagram and Facebook below. Without a connection, every post still has its kit to post by hand.')}
          </EmptyState>
        ) : (
          <div className="set-rows" data-testid="pubset-list">
            {data.connections.map((c) => (
              <ConnectionRow key={c.id} c={c} />
            ))}
          </div>
        )}
      </Card>
      <Card title={t('Add a connection')}>
        <div className="pubset-kinds">
          <button
            type="button"
            aria-pressed={adding === 'youtube'}
            className={`pubset-kind ${adding === 'youtube' ? 'on' : ''}`}
            onClick={() => setAdding('youtube')}
            data-testid="pubset-add-youtube"
          >
            <Marks platforms={['youtube']} />
            <b>YouTube</b>
            <span>{t('Directly, with your own Google Cloud OAuth client')}</span>
          </button>
          <button
            type="button"
            aria-pressed={adding === 'zernio'}
            className={`pubset-kind ${adding === 'zernio' ? 'on' : ''}`}
            onClick={() => setAdding('zernio')}
            data-testid="pubset-add-zernio"
          >
            <Marks platforms={['instagram', 'facebook']} />
            <b>{t('Instagram and Facebook')}</b>
            <span>{t('Through Zernio, with your own API key')}</span>
          </button>
        </div>
        {adding === 'youtube' && <AddYouTube redirect={redirect} onDone={() => setAdding(null)} />}
        {adding === 'zernio' && <AddZernio onDone={() => setAdding(null)} />}
      </Card>
      <Card title={t('When scheduled posts go out')}>
        <ul className="pubset-how">
          <li>
            <PlatformMark platform="youtube" size={14} />
            <span>{t('YouTube holds a scheduled video itself: Lampo uploads it when you publish, and this machine may sleep after that.')}</span>
          </li>
          <li>
            <PlatformMark platform="instagram" size={14} />
            <span>
              {hosted
                ? t('Instagram and Facebook posts are sent by Lampo at their time: this server runs all the time.')
                : t('Instagram and Facebook posts are sent by Lampo at their time: this machine must be awake and Lampo running then, or they go once it is.')}
            </span>
          </li>
        </ul>
      </Card>
    </>
  );
}

function Marks({ platforms, faint }: { platforms: PublishPlatform[]; faint?: boolean }) {
  return (
    <span className={`pubset-marks ${faint ? 'faint' : ''}`}>
      {platforms.map((p) => (
        <PlatformMark key={p} platform={p} size={16} />
      ))}
    </span>
  );
}

function ConnectionRow({ c }: { c: PublishConnectionInfo }) {
  const act = useConnectionActions();
  const [ask, confirmation] = useConfirm();
  const yt = c.kind === 'youtube';
  const platforms: PublishPlatform[] = yt ? ['youtube'] : c.platforms.length ? c.platforms : ['instagram', 'facebook'];
  const connect = async () => {
    try {
      const { url } = await act.authorize.mutateAsync(c.id);
      location.assign(url);
    } catch (e) {
      toastError(e);
    }
  };
  const check = () =>
    act.check.mutate(c.id, {
      onSuccess: (x) =>
        toast(x.state === 'ready' ? t('{label} works', { label: x.label }) : x.error || t('It doesn’t work yet'), x.state === 'ready' ? 'ok' : 'error'),
      onError: toastError,
    });
  const remove = async () => {
    const yes = await ask({
      title: t('Remove “{label}”?', { label: c.label }),
      body: yt
        ? t('Lampo forgets its client and its Google sign-in, and asks Google to end that sign-in. Posts that went out through it stay where they are.')
        : t('Lampo forgets its key. Posts that went out through it stay where they are.'),
      action: t('Remove'),
      danger: true,
    });
    if (!yes) return;
    act.remove.mutate(c.id, { onSuccess: () => toast(t('Removed {label}', { label: c.label }), 'ok'), onError: toastError });
  };
  const accounts = c.accounts.map((a) => (a.detail ? `${a.name} (${a.detail})` : a.name)).join(' · ');
  return (
    <div className="pubset-row" data-testid="pubset-row" data-kind={c.kind} data-state={c.state}>
      <div className="pubset-row-head">
        <Marks platforms={platforms} faint={c.state !== 'ready'} />
        <div className="pubset-row-main">
          <div className="ellipsis">
            <b>{c.label}</b> <span className="mono muted set-prefix">{c.key_hint}</span>
          </div>
          <div className="set-sub ellipsis">
            {yt ? t('YouTube · your Google Cloud project') : t('Zernio · Instagram and Facebook')}
            {accounts ? ` · ${accounts}` : ''}
          </div>
        </div>
        <div className="pubset-acts">
          {yt && c.state !== 'ready' && (
            <button type="button" className="btn sm primary" onClick={connect} disabled={act.authorize.isPending} data-testid="pubset-connect">
              {act.authorize.isPending ? <Spinner /> : <I name="link" size={14} />} {t('Connect with Google')}
            </button>
          )}
          {!(yt && c.state === 'needs_auth') && (
            <button type="button" className="btn sm" onClick={check} disabled={act.check.isPending} data-testid="pubset-check">
              {act.check.isPending ? <Spinner /> : <I name="refresh" size={14} />} {t('Check again')}
            </button>
          )}
          <button type="button" className="btn sm ghost danger" onClick={remove} data-testid="pubset-remove">
            {t('Remove')}
          </button>
        </div>
      </div>
      <p className={`pubset-state ${c.state}`} data-testid="pubset-state">
        <KeyGlyph shape={c.state === 'ready' ? 'diamond' : 'outline'} size={8} />
        <span>
          {c.state === 'ready'
            ? c.checked
              ? t('Ready · checked {when}', { when: when(c.checked) })
              : t('Ready')
            : c.state === 'needs_auth'
              ? t('Waiting for the Google sign-in: add the redirect URI below to your OAuth client, then connect with Google.')
              : c.error || t('It doesn’t work yet.')}
        </span>
      </p>
      {yt && c.state === 'needs_auth' && c.redirect_uri && <Code label={t('Redirect URI for your Google OAuth client')}>{c.redirect_uri}</Code>}
      {yt && (
        <>
          {!c.audited && (
            <p className="pubset-state locked" data-testid="pubset-locked">
              <I name="lock" size={13} />
              <span>
                {t(
                  'Uploads stay private until your Google project passes YouTube’s audit: YouTube locks them private, scheduled ones too. Make them public in YouTube Studio, or apply for the audit (docs/publishing.md).',
                )}
              </span>
            </p>
          )}
          <span className="pubset-audit">
            <Switch
              id={`pubset-audit-${c.id}`}
              checked={!!c.audited}
              onCheckedChange={(on) => act.change.mutate({ id: c.id, audited: on }, { onError: toastError })}
            />
            <label htmlFor={`pubset-audit-${c.id}`}>{t('My Google project passed YouTube’s API audit')}</label>
          </span>
        </>
      )}
      {confirmation}
    </div>
  );
}

function AddYouTube({ redirect, onDone }: { redirect: string; onDone: () => void }) {
  const act = useConnectionActions();
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const busy = act.add.isPending || act.authorize.isPending;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body: NewConnection = { kind: 'youtube', label: label.trim() || undefined, client_id: id.trim(), client_secret: secret.trim() };
      const c = await act.add.mutateAsync(body);
      setSecret('');
      // straight on to Google's sign-in: that is where the connection gets its channel
      const { url } = await act.authorize.mutateAsync(c.id);
      location.assign(url);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form className="set-form" onSubmit={submit} data-testid="pubset-youtube-form">
      <ol className="pubset-steps">
        <li>
          <b>{t('1 · In Google Cloud')}</b>
          <p>{t('Turn on the YouTube Data API v3 in a project of yours, and make an OAuth client of the type “Web application” with this redirect URI:')}</p>
          <Code label={t('Redirect URI')} testid="pubset-redirect">
            {redirect}
          </Code>
        </li>
        <li>
          <b>{t('2 · Its client here')}</b>
          <label className="set-field">
            <span>{t('Name (optional)')}</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('e.g. Studio channel')} maxLength={80} />
          </label>
          <label className="set-field">
            <span>{t('Client ID')}</span>
            <input
              className="input mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              data-testid="pubset-client-id"
            />
          </label>
          <label className="set-field">
            <span>{t('Client secret')}</span>
            <input
              className="input mono"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              required
              data-testid="pubset-client-secret"
            />
          </label>
        </li>
        <li>
          <b>{t('3 · Sign in with Google')}</b>
          <p>{t('Google asks which channel may receive uploads. Lampo keeps the sign-in sealed; nobody sees the secret again.')}</p>
        </li>
      </ol>
      <div className="set-inline">
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={busy || id.trim().length < 8 || secret.trim().length < 8} data-testid="pubset-youtube-add">
          {busy ? <Spinner /> : <PlatformMark platform="youtube" size={14} />} {t('Add and connect with Google')}
        </button>
      </div>
    </form>
  );
}

function AddZernio({ onDone }: { onDone: () => void }) {
  const act = useConnectionActions();
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const c = await act.add.mutateAsync({ kind: 'zernio', label: label.trim() || undefined, api_key: key.trim() });
      setKey('');
      if (c.state === 'ready') {
        toast(t('Connected: {accounts}', { accounts: c.accounts.map((a) => `${PLATFORM_LABEL[a.platform]} ${a.name}`).join(', ') }), 'ok');
        onDone();
      } else toast(c.error || t('The key doesn’t work yet'), 'error');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form className="set-form" onSubmit={submit} data-testid="pubset-zernio-form">
      <p className="set-sub">
        {t(
          'Connect your Instagram professional account and your Facebook Page at Zernio first; then its API key brings them here. Zernio’s prices and terms are yours.',
        )}
      </p>
      <label className="set-field">
        <span>{t('Name (optional)')}</span>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('e.g. Studio social')} maxLength={80} />
      </label>
      <label className="set-field">
        <span>{t('API key')}</span>
        <input
          className="input mono"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          placeholder="sk_…"
          required
          data-testid="pubset-api-key"
        />
      </label>
      <div className="set-inline">
        <button type="button" className="btn ghost" onClick={onDone}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={act.add.isPending || key.trim().length < 8} data-testid="pubset-zernio-add">
          {act.add.isPending ? <Spinner /> : <I name="plus" size={14} />} {t('Add')}
        </button>
      </div>
    </form>
  );
}
