// Notifications: this device's pings for everyone who has an inbox (PushSettings — the inbox itself only asks until
// they're decided), and for admins the webhooks: Slack, Discord or any URL hears about client feedback as it happens.
// Hooks from config.json or the environment are listed read-only; the ones made here can be changed, tested and removed.
import { type FormEvent, useState } from 'react';
import { can } from '../../../lib/permissions.ts';
import { useAuthStatus, useLikelyRole, useUpdateMe } from '../api/auth.ts';
import { useWebhookActions, type WebhookForm } from '../api/mutations.ts';
import { useInfo, useWebhooks } from '../api/queries.ts';
import type { WebhookFormat, WebhookInfo } from '../api/types.ts';
import { PushSettings } from '../foryou/NotifyCard.tsx';
import { perLang, t } from '../i18n/index.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Switch } from '../ui/plain.tsx';
import { IconButton, Segmented } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { EmptyState } from '../ui/system.tsx';
import { Card, Code, Confirm, when } from './parts.tsx';

const FORMATS = perLang((): { value: WebhookFormat; label: string }[] => [
  { value: 'slack', label: t('Slack') },
  { value: 'discord', label: t('Discord') },
  { value: 'json', label: t('JSON') },
]);
const EVENTS = perLang(() => [
  { value: 'client', label: t('Review link activity') },
  { value: 'post', label: t('Posts going out') },
  { value: 'all', label: t('Everything') },
]);
const SOURCE = perLang((): Record<WebhookInfo['source'], string> => ({ settings: '', config: t('from config.json'), env: t('from LAMPO_WEBHOOK_URL') }));

function Last({ h }: { h: WebhookInfo }) {
  if (!h.last) return <span>{t('no deliveries yet')}</span>;
  const l = h.last;
  return (
    <span className={l.ok ? '' : 'set-warn'}>
      {l.ok ? t('delivered {when}', { when: when(l.at) }) : t('failed {when}: {reason}', { when: when(l.at), reason: l.error || `HTTP ${l.status}` })}
      {l.attempts > 1 ? t(' ({attempts} tries)', { attempts: l.attempts }) : ''}
    </span>
  );
}

function Row({ h, onEdit, onRemove }: { h: WebhookInfo; onEdit: () => void; onRemove: () => void }) {
  const act = useWebhookActions();
  const test = async () => {
    try {
      const r = await act.test.mutateAsync(h.id);
      toast(r.ok ? t('Test delivered') : t('Test failed: {reason}', { reason: r.error || `HTTP ${r.status}` }), r.ok ? 'ok' : 'error');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="set-row">
      <I name="bell" size={15} className="faint" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          <b>{h.label}</b> <span className="badge">{h.format}</span> {h.secret && <span className="badge">{t('signed')}</span>}{' '}
          {h.events.includes('all') ? <span className="badge">{t('everything')}</span> : null}
          {h.events.includes('post') ? <span className="badge">{t('posts')}</span> : null}
        </div>
        <div className="set-sub ellipsis">
          <span className="mono">{h.url}</span> · <Last h={h} />
          {SOURCE()[h.source] ? ` · ${SOURCE()[h.source]}` : ''}
        </div>
      </div>
      <button type="button" className="btn sm" onClick={test} disabled={act.test.isPending}>
        {act.test.isPending ? <Spinner /> : <I name="play" size={12} />} {t('Send test')}
      </button>
      {h.source === 'settings' && (
        <>
          <IconButton className="btn sm icon-only ghost" label={t('Change webhook')} icon="edit" size={14} onClick={onEdit} />
          <button type="button" className="btn sm ghost danger" onClick={onRemove}>
            {t('Remove')}
          </button>
        </>
      )}
    </div>
  );
}

function HookForm({
  initial,
  submit,
  busy,
  onCancel,
}: {
  initial?: WebhookInfo;
  submit: (f: WebhookForm) => Promise<void>;
  busy: boolean;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState(initial?.label || '');
  const [format, setFormat] = useState<WebhookFormat>(initial?.format || 'slack');
  const [events, setEvents] = useState(initial?.events.includes('all') ? 'all' : initial?.events.includes('post') ? 'post' : 'client');
  const [secret, setSecret] = useState('');
  const go = async (e: FormEvent) => {
    e.preventDefault();
    const f: WebhookForm = { label: label.trim() || undefined, format, events: [events] };
    if (url.trim() || !initial) f.url = url.trim();
    if (secret) f.secret = secret;
    await submit(f);
    if (!initial) {
      setUrl('');
      setLabel('');
      setSecret('');
    }
  };
  return (
    <form className="set-form" onSubmit={go}>
      <label className="set-field">
        <span>{initial ? t('New URL (leave empty to keep the current one)') : t('Webhook URL')}</span>
        <input
          className="input mono"
          placeholder={
            format === 'slack'
              ? 'https://hooks.slack.com/services/…'
              : format === 'discord'
                ? 'https://discord.com/api/webhooks/…'
                : 'https://example.com/hooks/lampo'
          }
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required={!initial}
        />
      </label>
      <div className="set-pair">
        <label className="set-field">
          <span>{t('Name')}</span>
          <input className="input" placeholder={t('e.g. #review-feedback')} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </label>
        <label className="set-field">
          <span>{t('Signing secret (optional)')}</span>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder={initial?.secret ? t('set · type to replace') : t('for JSON receivers')}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      </div>
      <div className="set-pair">
        <div className="set-field">
          <span>{t('Format')}</span>
          <Segmented label={t('Format')} value={format} onChange={(v) => setFormat(v as WebhookFormat)} options={FORMATS()} />
        </div>
        <div className="set-field">
          <span>{t('Send')}</span>
          <Segmented label={t('Which events')} value={events} onChange={setEvents} options={EVENTS()} />
        </div>
      </div>
      <div className="set-actions">
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('Cancel')}
          </button>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? <Spinner /> : <I name={initial ? 'check' : 'plus'} size={15} />} {initial ? t('Save') : t('Add webhook')}
        </button>
      </div>
    </form>
  );
}

export function Notifications() {
  const role = useLikelyRole();
  const admin = !!role && can(role, 'admin');
  return (
    <>
      <header className="set-head">
        <h1>{t('Notifications')}</h1>
        <p>
          {admin
            ? t('Pings on your devices when something needs you, and webhooks that tell Slack, Discord or any service about feedback from review links.')
            : t('Pings on your devices when something needs you: agents’ questions, fixes to check, feedback from review links.')}
        </p>
      </header>
      <Card title={t('This device')} lede={t('Each browser or installed app is turned on on its own; what pings you is chosen here.')} testid="set-push">
        <PushSettings />
      </Card>
      <EmailAlerts />
      {admin && <Webhooks />}
    </>
  );
}

/**
 * Email about your own account (a server that can email; never at the machine itself, which signs its owner in by
 * itself): an email whenever the account signs in from a browser or `lampo` it hasn't been used with before.
 */
function EmailAlerts() {
  const status = useAuthStatus().data;
  const mail = !!useInfo()?.mail;
  const update = useUpdateMe();
  const user = status?.user;
  if (!mail || !user || status?.via === 'local') return null;
  const on = !!user.prefs?.signin_alerts;
  const set = (signin_alerts: boolean) =>
    update
      .mutateAsync({ prefs: { signin_alerts } })
      .then(() => toast(signin_alerts ? t('Sign-in alerts on: they go to {email}.', { email: user.email }) : t('Sign-in alerts off'), 'ok'), toastError);
  return (
    <Card title={t('Email')} lede={t('Mail about your own account goes to {email}.', { email: user.email })} testid="set-email-alerts">
      <div className="set-switch">
        <label htmlFor="signin-alerts">
          <b>{t('New sign-ins')}</b>
          <span className="set-sub">{t('An email when your account signs in from a browser or lampo it hasn’t been used with before.')}</span>
        </label>
        <Switch id="signin-alerts" checked={on} disabled={update.isPending} onCheckedChange={set} />
      </div>
    </Card>
  );
}

/** The webhooks (admins): a form, the list, how to check a signature. */
function Webhooks() {
  const { data } = useWebhooks();
  const act = useWebhookActions();
  const [editing, setEditing] = useState<WebhookInfo | null>(null);
  const [removing, setRemoving] = useState<WebhookInfo | null>(null);
  const add = async (f: WebhookForm) => {
    try {
      await act.add.mutateAsync(f);
      toast(t('Webhook added. Send a test to see it arrive.'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const save = async (f: WebhookForm) => {
    if (!editing) return;
    try {
      await act.update.mutateAsync({ id: editing.id, ...f });
      setEditing(null);
      toast(t('Webhook saved'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await act.remove.mutateAsync(removing.id);
      toast(t('Removed “{label}”', { label: removing.label }), 'ok');
    } catch (e) {
      toastError(e);
    }
    setRemoving(null);
  };
  const hooks = data?.webhooks || [];
  return (
    <>
      <Card title={editing ? t('Change “{label}”', { label: editing.label }) : t('New webhook')}>
        {editing ? (
          <HookForm key={editing.id} initial={editing} submit={save} busy={act.update.isPending} onCancel={() => setEditing(null)} />
        ) : (
          <HookForm submit={add} busy={act.add.isPending} />
        )}
      </Card>

      <Card title={t('Webhooks')}>
        {!data ? (
          <SkeletonRegion label={t('Loading the webhooks')}>
            <RowsSkeleton n={2} thumb={false} />
          </SkeletonRegion>
        ) : !hooks.length ? (
          <EmptyState size="sm" art="webhook" title={t('No webhooks yet')}>
            {t('Add one above to tell another tool when something happens here.')}
          </EmptyState>
        ) : (
          !!hooks.length && (
            <div className="set-rows">
              {hooks.map((h) => (
                <Row key={h.id} h={h} onEdit={() => setEditing(h)} onRemove={() => setRemoving(h)} />
              ))}
            </div>
          )
        )}
      </Card>

      <Card title={t('Checking signatures')} lede={t('JSON deliveries with a secret carry a signature over the timestamp and the body:')}>
        <Code label={t('Header')}>{'X-VR-Signature: t=<unix seconds>,v1=<signature>\nsignature = hex(HMAC-SHA256(secret, "<t>.<body>"))'}</Code>
      </Card>

      {removing && (
        <Confirm
          title={t('Remove the webhook “{label}”?', { label: removing.label })}
          action={t('Remove')}
          danger
          busy={act.remove.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={remove}
        >
          {t('It stops getting deliveries at once.')}
        </Confirm>
      )}
    </>
  );
}
